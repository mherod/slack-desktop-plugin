import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyMediaExposure,
  loadMediaReferences,
  parseMediaReference,
  rememberMediaReferences,
  resolveMedia,
} from './slack-read-media.mjs';

const folders = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
  );
});
async function cachePath() {
  const folder = await mkdtemp(path.join(tmpdir(), 'slack-media-bindings-'));
  folders.push(folder);
  return path.join(folder, 'references.json');
}
const messageRef = 'CDEMO:1700000000.000001';
const ordinal = `${messageRef}/m1`;
const workspace = { id: 'TDEMO', contextId: 'TDEMO', name: 'Example workspace' };
const view = { url: 'https://app.slack.com/client/TDEMO/CDEMO', title: 'Example (Channel)' };
const media = (extra = {}) => ({
  kind: 'video',
  label: 'Example clip',
  filename: null,
  fileId: null,
  ref: ordinal,
  referenceScope: 'message-media',
  contentRead: false,
  url: null,
  thumbnailUrl: null,
  downloadUrl: null,
  filePageUrl: null,
  description: null,
  displayedDuration: '4:36',
  displayedPlaybackTime: '0:00',
  transcript: { state: 'available' },
  provenance: null,
  ...extra,
});
const file = (extra = {}) =>
  media({ fileId: 'FDEMO', ref: 'FDEMO', referenceScope: 'workspace-file', ...extra });
const message = (attachments = [media()], extra = {}) => ({
  permalink: 'https://example.slack.com/archives/CDEMO/p1700000000000001',
  author: 'Example author',
  text: 'PRIVATE BODY MUST NEVER REACH CACHE',
  attachments,
  thread: {
    ref: messageRef,
    replyCount: 2,
    navigation: { command: 'read-thread', args: [messageRef] },
  },
  ...extra,
});
const observation = (messages = [message()], extra = {}) => ({
  workspace,
  view,
  messages,
  ...extra,
});
const receipt = (before = observation(), after = structuredClone(before)) => ({
  operation: 'read-media',
  observations: [before, after],
  desktop: { foregroundBefore: 1, foregroundAfter: 1 },
});
async function remembered(messages = [message()], extra = {}) {
  const location = await cachePath();
  const compact = observation(messages, extra);
  const bindings = await rememberMediaReferences(location, [compact]);
  return { location, compact, bindings };
}

describe('media reference grammar', () => {
  test('accepts emitted IDs and canonical message ordinals', () => {
    expect(parseMediaReference('FDEMO')).toEqual({ kind: 'file', ref: 'FDEMO', fileId: 'FDEMO' });
    expect(parseMediaReference(ordinal)).toEqual({
      kind: 'message',
      ref: ordinal,
      messageRef,
      ordinal: 1,
    });
    expect(parseMediaReference(`${messageRef}/m9999`).ordinal).toBe(9999);
  });
  for (const input of [
    '',
    null,
    123,
    ' FDEMO',
    'FDEMO ',
    'Fdemo',
    'F',
    'FDEMO\n',
    'FDEMO\0',
    'https://example.slack.com/files/UDEMO/FDEMO/a.png',
    `${messageRef}/p1`,
    `${messageRef}/m0`,
    `${messageRef}/m01`,
    `${messageRef}/m-1`,
    `${messageRef}/m1.5`,
    `${messageRef}/m10000`,
    `${messageRef}/m9007199254740992`,
    `${messageRef}/m1\n`,
    'CDEMO:1700000000.1/m1',
    'CDEMO:170000000.000001/m1',
    'XDEMO:1700000000.000001/m1',
    `F${'A'.repeat(256)}`,
  ]) {
    test(`rejects unsupported reference ${JSON.stringify(input)}`, () => {
      expect(() => parseMediaReference(input)).toThrow();
    });
  }
});

describe('fresh metadata resolution', () => {
  test('resolves a remembered ordinal with source and supported thread hint', async () => {
    const { bindings } = await remembered();
    const result = resolveMedia(receipt(), ordinal, bindings);
    expect(result).toMatchObject({
      schemaVersion: 1,
      operation: 'read-media',
      status: 'ok',
      requested: ordinal,
      media: {
        label: 'Example clip',
        contentRead: false,
        navigation: { command: 'read-media', args: [ordinal] },
      },
      coverage: {
        complete: false,
        contentRead: false,
        referenceBinding: 'remembered-message-order',
      },
    });
    expect(result.sources[0]).toMatchObject({ messageRef, author: 'Example author' });
    expect(result.navigation).toEqual([{ command: 'read-thread', args: [messageRef] }]);
    expect(result).not.toHaveProperty('desktop');
    expect(result).not.toHaveProperty('messages');
    expect(JSON.stringify(result)).not.toContain('PRIVATE BODY');
  });

  test('resolves current-workspace file identity without remembered state', () => {
    const result = resolveMedia(receipt(observation([message([file()])])), 'FDEMO');
    expect(result.media.fileId).toBe('FDEMO');
    expect(result.coverage.referenceBinding).toBe('current-workspace-file');
  });

  test('offers a save hint only for the same file with a supported observed Download URL', () => {
    for (const downloadUrl of [
      'https://files.slack.com/files-pri/TDEMO-FDEMO/example.pdf',
      'https://files.slack.com/files-tmb/TDEMO-FDEMO-abcd/example.mp4',
    ]) {
      const result = resolveMedia(
        receipt(observation([message([file({ downloadUrl })])])),
        'FDEMO'
      );
      expect(result.media.saveNavigation).toEqual({
        command: 'save-media',
        args: ['FDEMO'],
        requiredOption: '--output=PATH',
      });
    }
    for (const downloadUrl of [
      null,
      'https://example.test/file.pdf',
      'https://files.slack.com/files-pri/TDEMO-FOTHER/example.pdf',
    ]) {
      const result = resolveMedia(
        receipt(observation([message([file({ downloadUrl })])])),
        'FDEMO'
      );
      expect(result.media).not.toHaveProperty('saveNavigation');
    }
  });

  test('retains multiple source/provenance observations of the same file', () => {
    const quoted = { kind: 'quoted', author: 'Quoted author', permalink: null };
    const messages = [
      message([file()]),
      message([file({ provenance: quoted })], {
        permalink: 'https://example.slack.com/archives/CDEMO/p1700000000000002',
        author: 'Second author',
        thread: null,
      }),
    ];
    const result = resolveMedia(receipt(observation(messages)), 'FDEMO');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[1].provenance).toEqual([quoted]);
    expect(result.media.provenance).toBeNull();
    expect(result.coverage.sourceCount).toBe(2);
  });

  test('rejects conflicting file metadata without choosing a source', () => {
    const messages = [message([file()]), message([file({ filename: 'different.mp4' })])];
    expect(() => resolveMedia(receipt(observation(messages)), 'FDEMO')).toThrow(
      'conflicting metadata'
    );
  });

  test('retains fresh mutable playback and transcript metadata without rebinding identity', async () => {
    const { bindings } = await remembered();
    const changed = observation([
      message([media({ displayedPlaybackTime: '0:02', transcript: { state: 'unknown' } })]),
    ]);
    const result = resolveMedia(receipt(observation(), changed), ordinal, bindings);
    expect(result.media.displayedPlaybackTime).toBe('0:02');
    expect(result.media.transcript.state).toBe('unknown');
  });

  test('requires an unexpired remembered binding for ordinals', () => {
    expect(() => resolveMedia(receipt(), ordinal)).toThrow('no current remembered binding');
  });

  test('rejects an ordinal after attachment reorder, even if the old label still exists', async () => {
    const second = media({ ref: `${messageRef}/m2`, label: 'Second clip' });
    const { bindings } = await remembered([message([media(), second])]);
    const reordered = observation([
      message([media({ label: 'Second clip' }), media({ ref: `${messageRef}/m2` })]),
    ]);
    expect(() => resolveMedia(receipt(reordered), ordinal, bindings)).toThrow(
      'order or identity changed'
    );
  });

  test('rejects selected attachment replacement under the same ordinal', async () => {
    const { bindings } = await remembered();
    const changed = observation([message([media({ label: 'Replacement clip' })])]);
    expect(() => resolveMedia(receipt(changed), ordinal, bindings)).toThrow(
      'order or identity changed'
    );
  });

  test('rejects a changed unselected attachment in the same ordered inventory', async () => {
    const initial = [media(), media({ ref: `${messageRef}/m2`, label: 'Second' })];
    const { bindings } = await remembered([message(initial)]);
    const changed = observation([message([initial[0], { ...initial[1], label: 'Replacement' }])]);
    expect(() => resolveMedia(receipt(changed), ordinal, bindings)).toThrow(
      'order or identity changed'
    );
  });

  test('rejects indistinguishable ordinal attachments', async () => {
    const messages = [message([media(), media({ ref: `${messageRef}/m2` })])];
    const { bindings } = await remembered(messages);
    expect(() => resolveMedia(receipt(observation(messages)), ordinal, bindings)).toThrow(
      'indistinguishable'
    );
  });

  test('fails when the selected attachment disappears between captures', () => {
    expect(() =>
      resolveMedia(receipt(observation([message([file()])]), observation([])), 'FDEMO')
    ).toThrow('not exposed');
  });

  test('fails when identity changes between fresh captures', () => {
    const before = observation([message([file()])]);
    const after = observation([message([file({ label: 'Changed' })])]);
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow(
      'changed during inspection'
    );
  });

  test('fails when sources change between fresh captures', () => {
    const before = observation([message([file()])]);
    const after = observation([
      message([file()], {
        permalink: 'https://example.slack.com/archives/CDEMO/p1700000000000002',
      }),
    ]);
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow(
      'changed during inspection'
    );
  });

  test('rejects changed workspace and contradictory workspace fields', () => {
    const before = observation([message([file()])]);
    const after = observation(before.messages, {
      workspace: { id: 'TOTHER', contextId: 'TOTHER' },
    });
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow('Workspace changed');
    after.workspace = { id: 'TDEMO', contextId: 'TOTHER' };
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow('Conflicting workspace');
    after.workspace = { contextId: `T${'A'.repeat(64)}` };
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow('verified workspace');
  });

  test('rejects ordinal bindings from a different workspace', async () => {
    const { bindings } = await remembered();
    const other = observation(undefined, { workspace: { id: 'TOTHER', contextId: 'TOTHER' } });
    expect(() => resolveMedia(receipt(other), ordinal, bindings)).toThrow(
      'no current remembered binding'
    );
  });

  test('rejects view change and missing second observation', () => {
    const before = observation([message([file()])]);
    const after = observation(before.messages, { view: { ...view, title: 'Changed view' } });
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow('View changed');
    expect(() =>
      resolveMedia({ operation: 'read-media', observations: [before] }, 'FDEMO')
    ).toThrow('two fresh');
  });

  test('does not trust matching labels, previews, unverified message URLs, or content claims', () => {
    const misleading = observation([
      message([], {
        previews: [file()],
        permalink: 'https://example.org/archives/CDEMO/p1700000000000001',
      }),
    ]);
    expect(() => resolveMedia(receipt(misleading), 'FDEMO')).toThrow('not exposed');
    const noID = observation([message([media({ label: 'FDEMO' })])]);
    expect(() => resolveMedia(receipt(noID), 'FDEMO')).toThrow('not exposed');
    const content = observation([message([file({ contentRead: true })])]);
    expect(() => resolveMedia(receipt(content), 'FDEMO')).toThrow('metadata-only');
  });

  test('drops malformed or unimplemented thread navigation', () => {
    const invalid = message([file()], {
      thread: { ref: messageRef, navigation: { command: 'send', args: [messageRef] } },
    });
    const result = resolveMedia(receipt(observation([invalid])), 'FDEMO');
    expect(result.sources[0].thread).toBeNull();
    expect(result.navigation).toEqual([]);
  });

  test('preserves inferred sender attribution in source metadata', () => {
    const inferred = message([file()], {
      authorInferred: true,
      authorSourceMessageId: 'message-list_1700000000.000000',
    });
    expect(resolveMedia(receipt(observation([inferred])), 'FDEMO').sources[0]).toMatchObject({
      author: 'Example author',
      authorInferred: true,
      authorSourceMessageId: 'message-list_1700000000.000000',
    });
  });
});

describe('private bounded reference memory', () => {
  test('writes only digests, identifiers and times with private permissions', async () => {
    const { location, bindings } = await remembered();
    const raw = await readFile(location, 'utf8');
    expect(raw).not.toContain('PRIVATE BODY');
    expect(raw).not.toContain('Example clip');
    expect(raw).not.toContain('slack.com');
    expect(Object.keys(bindings.entries[0]).sort()).toEqual([
      'digest',
      'media',
      'messageRef',
      'rememberedAt',
      'workspace',
    ]);
    expect(bindings.schemaVersion).toBe(2);
    expect(bindings.entries[0].media).toEqual([
      { ref: ordinal, digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect((await lstat(location)).mode & 0o777).toBe(0o600);
    expect((await loadMediaReferences(location)).entries).toEqual(bindings.entries);
    expect(await readdir(path.dirname(location))).toEqual(['references.json']);
  });

  test('remembers thread roots and replies as well as conversation/search messages', async () => {
    const location = await cachePath();
    const secondRef = 'CDEMO:1700000000.000002';
    const bindings = await rememberMediaReferences(location, [
      {
        workspace,
        thread: {
          root: message(),
          replies: [
            message([media({ ref: `${secondRef}/m1` })], {
              permalink: 'https://example.slack.com/archives/CDEMO/p1700000000000002',
            }),
          ],
        },
      },
    ]);
    expect(bindings.entries.map((entry) => entry.messageRef)).toEqual([messageRef, secondRef]);
  });

  test('does not retain conflicting observations from a collection', async () => {
    const location = await cachePath();
    const bindings = await rememberMediaReferences(location, [
      observation(),
      observation([message([media({ label: 'Changed' })])]),
    ]);
    expect(bindings.entries).toEqual([]);
  });

  test('missing, corrupt, oversized and public cache files cannot authorize an ordinal', async () => {
    const location = await cachePath();
    expect((await loadMediaReferences(location)).status).toBe('missing');
    await writeFile(location, '{invalid', { mode: 0o600 });
    expect((await loadMediaReferences(location)).entries).toEqual([]);
    await writeFile(location, ' '.repeat(512 * 1024 + 1));
    expect((await loadMediaReferences(location)).status).toBe('invalid');
    const bindings = await rememberMediaReferences(location, [observation()]);
    expect(bindings.entries).toHaveLength(1);
    await chmod(location, 0o644);
    expect((await loadMediaReferences(location)).status).toBe('invalid');
  });

  test('expires bindings after 24 hours and rejects future dates', async () => {
    const { location, bindings } = await remembered();
    for (const rememberedAt of [Date.now() - 24 * 60 * 60 * 1000 - 10, Date.now() + 60 * 1000]) {
      await writeFile(
        location,
        JSON.stringify({ ...bindings, entries: [{ ...bindings.entries[0], rememberedAt }] })
      );
      expect((await loadMediaReferences(location)).entries).toEqual([]);
    }
  });

  test('invalid digest or duplicate binding cannot authorize a read', async () => {
    const { bindings } = await remembered();
    const badDigest = { ...bindings, entries: [{ ...bindings.entries[0], digest: 'not-a-hash' }] };
    expect(() => resolveMedia(receipt(), ordinal, badDigest)).toThrow(
      'no current remembered binding'
    );
    const duplicate = { ...bindings, entries: [bindings.entries[0], bindings.entries[0]] };
    expect(() => resolveMedia(receipt(), ordinal, duplicate)).toThrow(
      'no current remembered binding'
    );
  });

  test('caps retained bindings at 1000 and removes expired entries on write', async () => {
    const location = await cachePath();
    const many = Array.from({ length: 1001 }, (_, index) => {
      const suffix = String(index).padStart(6, '0');
      return message([media({ ref: `CDEMO:1700000000.${suffix}/m1` })], {
        permalink: `https://example.slack.com/archives/CDEMO/p1700000000${suffix}`,
      });
    });
    const bindings = await rememberMediaReferences(location, [observation(many)]);
    expect(bindings.entries).toHaveLength(1000);
    expect((await lstat(location)).size).toBeLessThan(512 * 1024);
    const oversized = { ...bindings, entries: [...bindings.entries, bindings.entries[0]] };
    await writeFile(location, JSON.stringify(oversized));
    expect((await loadMediaReferences(location)).entries).toEqual([]);
  });

  test('refuses symlink cache and nonprivate directories without touching the target', async () => {
    const location = await cachePath();
    const target = path.join(path.dirname(location), 'target.json');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await symlink(target, location);
    expect((await loadMediaReferences(location)).status).toBe('invalid');
    await expect(rememberMediaReferences(location, [observation()])).rejects.toThrow(
      'not a symbolic link'
    );
    expect(await readFile(target, 'utf8')).toBe('untouched');
    const other = await cachePath();
    await chmod(path.dirname(other), 0o755);
    await expect(rememberMediaReferences(other, [observation()])).rejects.toThrow(
      'directory must be private'
    );
  });
});

test('image sources offer guarded viewer-save hints without inventing a Download URL', () => {
  const source = 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png';
  const result = resolveMedia(
    receipt(observation([message([file({ kind: 'image', url: source, downloadUrl: null })])])),
    'FDEMO'
  );
  expect(result.media.saveNavigation).toEqual({
    command: 'save-media',
    args: ['FDEMO'],
    requiredOption: '--output=PATH',
  });
  expect(result.media.downloadUrl).toBeNull();
  for (const changes of [
    { url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/example.png' },
    { url: 'https://files.slack.com/files-tmb/TDEMO-FDEMO-abcd/example.png' },
    { url: source + '?size=small' },
    { kind: 'video' },
  ]) {
    const attachment = file({ kind: 'image', url: source, downloadUrl: null, ...changes });
    const unsupported = resolveMedia(receipt(observation([message([attachment])])), 'FDEMO');
    expect(unsupported.media).not.toHaveProperty('saveNavigation');
  }
});

describe('file-details save hints', () => {
  for (const kind of ['file', 'document', 'audio', 'video']) {
    test(`offers a source-bound hint for ${kind} without an exposed Download`, () => {
      const result = resolveMedia(
        receipt(
          observation([
            message([
              file({ kind, fileDetailsAvailable: true, filePageUrl: null, downloadUrl: null }),
            ]),
          ])
        ),
        'FDEMO'
      );
      expect(result.media.saveNavigation).toEqual({
        command: 'save-media',
        args: ['FDEMO'],
        requiredOption: '--output=PATH',
      });
      expect(result.media.downloadUrl).toBeNull();
      expect(result.media.filePageUrl).toBeNull();
      expect(result.media.contentRead).toBe(false);
    });
  }

  for (const changes of [
    { fileDetailsAvailable: undefined },
    { fileDetailsAvailable: false },
    { fileDetailsAvailable: 'true' },
    { kind: 'unknown' },
    { kind: 'image' },
    { downloadUrl: 'https://example.test/file.mp4' },
    { downloadUrl: 'https://files.slack.com/files-pri/TDEMO-FOTHER/example.mp4' },
  ]) {
    test(`withholds a details-save hint for ${JSON.stringify(changes)}`, () => {
      const attachment = file({ fileDetailsAvailable: true, ...changes });
      const result = resolveMedia(receipt(observation([message([attachment])])), 'FDEMO');
      expect(result.media).not.toHaveProperty('saveNavigation');
    });
  }

  test('observed details capability does not turn an unknown ordinal into a file identity', async () => {
    const attachment = media({ fileDetailsAvailable: true });
    const { bindings, compact } = await remembered([message([attachment])]);
    const result = resolveMedia(receipt(compact), ordinal, bindings);
    expect(result.media.fileId).toBeNull();
    expect(result.media).not.toHaveProperty('saveNavigation');
  });

  test('details capability is fresh metadata and does not change remembered order bindings', async () => {
    const { bindings, compact } = await remembered();
    const after = observation([message([media({ fileDetailsAvailable: true })])]);
    const result = resolveMedia(receipt(compact, after), ordinal, bindings);
    expect(result.media.fileDetailsAvailable).toBe(true);
    expect(result.media).not.toHaveProperty('saveNavigation');
    const beforeFile = observation([message([file()])]);
    const afterFile = observation([message([file({ fileDetailsAvailable: true })])]);
    expect(resolveMedia(receipt(beforeFile, afterFile), 'FDEMO').media).toHaveProperty(
      'saveNavigation'
    );
    expect(resolveMedia(receipt(afterFile, beforeFile), 'FDEMO').media).not.toHaveProperty(
      'saveNavigation'
    );
  });

  test('details capability cannot make a changed source identity resolve', () => {
    const before = observation([message([file({ fileDetailsAvailable: true })])]);
    const after = observation([
      message([file({ fileDetailsAvailable: true, filename: 'replacement.mp4' })]),
    ]);
    expect(() => resolveMedia(receipt(before, after), 'FDEMO')).toThrow(
      'changed during inspection'
    );
  });
});

describe('source reopening eligibility', () => {
  const hidden = () => receipt(observation([]));
  const secondRef = 'CDEMO:1700000000.000002';
  const secondMessage = (attachments = [file()], extra = {}) =>
    message(attachments, {
      permalink: 'https://example.slack.com/archives/CDEMO/p1700000000000002',
      ...extra,
    });
  const source = (messageRef = 'CDEMO:1700000000.000001') => ({
    status: 'absent',
    source: { workspace: 'TDEMO', messageRef },
  });

  test('an exposed file retains ordinary fresh resolution without cache state', () => {
    const current = receipt(observation([message([file()])]));
    expect(classifyMediaExposure(current, 'FDEMO')).toEqual({
      status: 'exposed',
      resolved: resolveMedia(current, 'FDEMO'),
    });
  });

  test('remembers file-only sources without bodies, URLs or labels', async () => {
    const { location, bindings } = await remembered([message([file()])]);
    expect(bindings.entries).toHaveLength(1);
    expect(bindings.entries[0].media).toEqual([
      { ref: 'FDEMO', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    const raw = await readFile(location, 'utf8');
    for (const privateValue of ['PRIVATE BODY', 'Example clip', 'Example author', 'https://'])
      expect(raw).not.toContain(privateValue);
    expect(classifyMediaExposure(hidden(), 'FDEMO', bindings)).toEqual(source());
  });

  test('reopens a remembered ordinal only while the original binding still verifies afterward', async () => {
    const { bindings } = await remembered();
    expect(classifyMediaExposure(hidden(), ordinal, bindings)).toEqual(source());
    expect(classifyMediaExposure(receipt(), ordinal, bindings).status).toBe('exposed');
    expect(() =>
      classifyMediaExposure(
        receipt(observation([message([media({ label: 'Changed' })])])),
        ordinal,
        bindings
      )
    ).toThrow('changed since the reference was offered');
  });

  test('legacy positional bindings can reopen and migrate without inventing file associations', async () => {
    const { location, bindings } = await remembered();
    const { media: _media, ...entry } = bindings.entries[0];
    const legacy = { schemaVersion: 1, entries: [entry] };
    await writeFile(location, JSON.stringify(legacy));
    const loaded = await loadMediaReferences(location);
    expect(classifyMediaExposure(hidden(), ordinal, loaded)).toEqual(source());
    expect(resolveMedia(receipt(), ordinal, loaded).status).toBe('ok');
    expect(() => classifyMediaExposure(hidden(), 'FDEMO', loaded)).toThrow(
      'no current remembered source'
    );
    const migrated = await rememberMediaReferences(location, [observation([secondMessage()])]);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.entries.find((item) => item.messageRef === messageRef)).toEqual(entry);
    expect(classifyMediaExposure(hidden(), 'FDEMO', migrated)).toEqual(source(secondRef));
    expect(classifyMediaExposure(hidden(), ordinal, migrated)).toEqual(source());
  });

  test('file source choice is deterministic only when metadata identities agree', async () => {
    const { bindings } = await remembered([
      message([file({ provenance: { kind: 'quoted', author: 'First' } })]),
      secondMessage([file({ provenance: { kind: 'quoted', author: 'Second' } })]),
    ]);
    const first = bindings.entries.find((entry) => entry.messageRef === messageRef);
    const second = bindings.entries.find((entry) => entry.messageRef === secondRef);
    first.rememberedAt -= 10;
    expect(classifyMediaExposure(hidden(), 'FDEMO', bindings)).toEqual(source(secondRef));
    second.rememberedAt = first.rememberedAt;
    expect(classifyMediaExposure(hidden(), 'FDEMO', bindings)).toEqual(source());
    expect(
      classifyMediaExposure(hidden(), 'FDEMO', {
        ...bindings,
        entries: [...bindings.entries].reverse(),
      })
    ).toEqual(source());
  });

  test('different cached file metadata cannot authorize an automatic source choice', async () => {
    const { bindings } = await remembered([
      message([file()]),
      secondMessage([file({ label: 'Different file description' })]),
    ]);
    expect(() => classifyMediaExposure(hidden(), 'FDEMO', bindings)).toThrow(
      'conflicting remembered source metadata'
    );
  });

  for (const mode of ['missing', 'expired', 'future', 'workspace', 'duplicate', 'bad-digest']) {
    test(`${mode} cache evidence does not authorize reopening`, async () => {
      const { bindings } = await remembered([message([file()])]);
      let changed = structuredClone(bindings);
      if (mode === 'missing') changed = undefined;
      else if (mode === 'expired') changed.entries[0].rememberedAt = Date.now() - 86400001;
      else if (mode === 'future') changed.entries[0].rememberedAt = Date.now() + 60000;
      else if (mode === 'workspace') changed.entries[0].workspace = 'TOTHER';
      else if (mode === 'duplicate') changed.entries.push(changed.entries[0]);
      else changed.entries[0].media[0].digest = 'not-a-hash';
      expect(() => classifyMediaExposure(hidden(), 'FDEMO', changed)).toThrow(
        'no current remembered source'
      );
    });
  }

  test('a known source exposed without its file is a mismatch, not absence', async () => {
    const { bindings } = await remembered([message([file()]), secondMessage()]);
    expect(() =>
      classifyMediaExposure(receipt(observation([message([])])), 'FDEMO', bindings)
    ).toThrow('already exposed but its attachment is missing or changed');
    expect(() =>
      classifyMediaExposure(
        receipt(observation([message([file({ fileId: 'FOTHER', ref: 'FOTHER' })])])),
        'FDEMO',
        bindings
      )
    ).toThrow('already exposed but its attachment is missing or changed');
  });

  test('an ordinal source exposed with a missing or replaced position never triggers navigation', async () => {
    const { bindings } = await remembered();
    for (const attachments of [[], [file()], [media({ ref: `${messageRef}/m2` })]])
      expect(() =>
        classifyMediaExposure(receipt(observation([message(attachments)])), ordinal, bindings)
      ).toThrow();
    expect(() => classifyMediaExposure(hidden(), `${messageRef}/m2`, bindings)).toThrow(
      'no current remembered source'
    );
  });

  test('one-capture disappearance or appearance remains a resolution failure', async () => {
    const { bindings } = await remembered([message([file()])]);
    for (const [before, after] of [
      [observation(), observation([])],
      [observation([]), observation()],
    ])
      expect(() => classifyMediaExposure(receipt(before, after), ordinal, bindings)).toThrow();
    const present = observation([message([file()])]),
      absent = observation([]);
    expect(() => classifyMediaExposure(receipt(present, absent), 'FDEMO', bindings)).toThrow(
      'not exposed'
    );
    expect(() => classifyMediaExposure(receipt(absent, present), 'FDEMO', bindings)).toThrow(
      'not exposed'
    );
  });

  test('unverifiable matching media does not turn into absence', async () => {
    const { bindings } = await remembered([message([file()])]);
    for (const candidate of [
      message([file()], { permalink: null }),
      message([file({ ref: 'FOTHER' })]),
      message([file({ fileId: null })]),
      message([file({ contentRead: true })]),
    ])
      expect(() =>
        classifyMediaExposure(receipt(observation([candidate])), 'FDEMO', bindings)
      ).toThrow();
  });

  test('reopening requires stable workspace, view and complete canonical inventories', async () => {
    const { bindings } = await remembered([message([file()])]);
    for (const changed of [
      receipt(observation([]), observation([], { workspace: { id: 'TOTHER' } })),
      receipt(observation([]), observation([], { view: { ...view, title: 'Changed' } })),
      receipt(observation([]), observation([secondMessage([])])),
      receipt(
        observation([secondMessage([])]),
        observation([secondMessage([file({ ref: 'FOTHER', fileId: 'FOTHER' })])])
      ),
      receipt(observation([secondMessage([], { permalink: null })])),
      receipt(observation([secondMessage(undefined, { attachments: undefined })])),
      receipt(
        observation([secondMessage([]), secondMessage([file({ ref: 'FOTHER', fileId: 'FOTHER' })])])
      ),
    ])
      expect(() => classifyMediaExposure(changed, 'FDEMO', bindings)).toThrow();
  });

  test('fresh observed removal invalidates an older source mapping', async () => {
    const { location } = await remembered([message([file()])]);
    const updated = await rememberMediaReferences(location, [observation([message([])])]);
    expect(updated.entries).toEqual([]);
    expect(() => classifyMediaExposure(hidden(), 'FDEMO', updated)).toThrow(
      'no current remembered source'
    );
  });

  test('conflicting collection observations remove the whole source binding', async () => {
    const location = await cachePath();
    const bindings = await rememberMediaReferences(location, [
      observation([message([file()])]),
      observation([message([])]),
    ]);
    expect(bindings.entries).toEqual([]);
  });

  for (const change of [
    (entry) => entry.media.push(entry.media[0]),
    (entry) => {
      entry.media[0].ref = 'F';
    },
    (entry) => {
      entry.media[0].ref = `${secondRef}/m1`;
    },
    (entry) => {
      entry.media[0].body = 'not allowed';
    },
    (entry) => {
      entry.media[0].digest = 'A'.repeat(64);
    },
    (entry) => {
      entry.media = null;
    },
    (entry) => {
      entry.extra = true;
    },
  ]) {
    test('malformed v2 associations cannot authorize a source', async () => {
      const { location, bindings } = await remembered([message([file()])]);
      change(bindings.entries[0]);
      await writeFile(location, JSON.stringify(bindings));
      expect((await loadMediaReferences(location)).entries).toEqual([]);
    });
  }

  test('byte bounds evict oldest source records without breaking the atomic cache', async () => {
    const location = await cachePath();
    const many = Array.from({ length: 6 }, (_, sourceIndex) => {
      const suffix = String(sourceIndex).padStart(6, '0');
      return message(
        Array.from({ length: 1000 }, (_, i) => {
          const fileId = `F${'X'.repeat(48)}${sourceIndex}${String(i).padStart(5, '0')}`;
          return file({ fileId, ref: fileId });
        }),
        { permalink: `https://example.slack.com/archives/CDEMO/p1700000000${suffix}` }
      );
    });
    const bindings = await rememberMediaReferences(location, [observation(many)]);
    expect(bindings.entries.length).toBeGreaterThan(0);
    expect(bindings.entries.length).toBeLessThan(6);
    expect((await lstat(location)).size).toBeLessThanOrEqual(512 * 1024);
    expect((await loadMediaReferences(location)).entries).toEqual(bindings.entries);
    expect(await readdir(path.dirname(location))).toEqual(['references.json']);
  });
});
