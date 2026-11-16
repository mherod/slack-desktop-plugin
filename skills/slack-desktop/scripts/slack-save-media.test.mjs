import { describe, expect, test } from 'bun:test';
import { extractMedia } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import {
  savedMediaOutput,
  saveMediaSelectionOutput,
  selectSaveMediaCandidate,
  verifySavePhase,
} from './slack-save-media.mjs';

// Synthetic AX structure only. These tests do not inspect Slack or download files.
function fixture({ kind = 'audio', representation = 'tmb' } = {}) {
  const nodes = [];
  const add = (parent, role, classes = [], label = '', extra = {}) => {
    const node = {
      index: nodes.length,
      parent: parent?.index ?? null,
      role,
      classes,
      label,
      id: '',
      ...extra,
    };
    nodes.push(node);
    return node;
  };
  const root = add(null, 'AXWebArea', [], 'Example (Channel)', {
    url: 'https://app.slack.com/client/TDEMO/CDEMO',
  });
  const list = add(root, 'AXList');
  const container = add(list, 'AXGroup', ['c-message_kit__actions']);
  const permalink = 'https://example.slack.com/archives/CDEMO/p1700000000000001';
  const timestamp = add(container, 'AXLink', ['c-timestamp'], 'Yesterday', { url: permalink });
  const media = add(
    container,
    'AXGroup',
    kind === 'audio'
      ? ['c-pillow_file_container', 'p-search_file--audio-player']
      : kind === 'video'
        ? ['p-video_message_file']
        : ['p-message_file']
  );
  if (kind === 'audio' || kind === 'video') {
    add(
      media,
      'AXCheckBox',
      kind === 'audio' ? ['c-audio_player_play_button'] : [],
      'Play, 10 seconds',
      { stateValue: '0' }
    );
  }
  const url = `https://files.slack.com/files-${representation}/TDEMO-FDEMO/example.m4a`;
  const control = add(media, 'AXLink', [], 'Download example.m4a', { url });
  const candidate = {
    token: 'download-candidate-1',
    mediaIndex: media.index,
    containerIndex: container.index,
    controlIndex: control.index,
    url,
    routeKind: representation === 'tmb' ? 'rendition' : 'unknown',
  };
  const observation = () => ({ content: { nodes, truncated: false } });
  const preflight = {
    operation: 'save-media',
    phase: 'select',
    requested: 'FDEMO',
    pid: 123,
    observations: [observation(), observation()],
    candidates: [candidate],
  };
  const messageRef = 'CDEMO:1700000000.000001';
  const resolved = {
    operation: 'read-media',
    schemaVersion: 1,
    status: 'ok',
    requested: 'FDEMO',
    workspace: { contextId: 'TDEMO', id: 'TDEMO' },
    view: { url: root.url, title: root.label },
    media: extractMedia(container, indexTree(nodes), { messageRef }).attachments[0],
    sources: [{ messageRef, permalink, author: 'Example author', provenance: [null] }],
    navigation: [],
  };
  const phase = (name) => ({
    operation: 'save-media',
    phase: name,
    requested: 'FDEMO',
    pid: 123,
    ...(name === 'result' ? { status: 'ok' } : {}),
    selection: { ...candidate },
    action: { attempted: true, accepted: true, startedAt: 1700000000123 },
    verification: { sourceMatched: true, downloadRequested: true, playbackUnchanged: true },
  });
  return {
    nodes,
    add,
    root,
    list,
    container,
    timestamp,
    media,
    control,
    candidate,
    preflight,
    resolved,
    phase,
  };
}

function refreshMedia(f) {
  f.resolved.media = extractMedia(f.container, indexTree(f.nodes), {
    messageRef: f.resolved.sources[0].messageRef,
  }).attachments[0];
  f.resolved.requested = f.preflight.requested = f.resolved.media.ref;
}

function addDownload(f, url, routeKind) {
  const control = f.add(f.media, 'AXLink', [], 'Download file', { url });
  const candidate = {
    ...f.candidate,
    token: `download-candidate-${control.index}`,
    controlIndex: control.index,
    url,
    routeKind,
  };
  f.preflight.candidates.push(candidate);
  refreshMedia(f);
  return candidate;
}

function originalFixture({ mixed = false, contextId = 'TDEMO' } = {}) {
  const f = fixture();
  f.root.url = `https://app.slack.com/client/${contextId}/CDEMO`;
  f.resolved.view.url = f.root.url;
  f.resolved.workspace.contextId = contextId;
  const url = 'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a';
  f.page = f.add(f.media, 'AXLink', [], 'Friendly display name.m4a', {
    url: 'https://example.slack.com/files/UDEMO/FDEMO/example.m4a',
  });
  if (mixed) f.original = addDownload(f, url, 'file-download');
  else {
    f.control.url = f.candidate.url = url;
    f.candidate.routeKind = 'file-download';
    f.original = f.candidate;
  }
  refreshMedia(f);
  return f;
}

describe('source-bound file Download preference', () => {
  test.each([false, true])(
    'prefers the original route over a rendition (strict=%s)',
    (originalRequired) => {
      const f = originalFixture({ mixed: true });
      f.preflight.candidates.reverse();
      const selected = selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired });
      expect(selected.token).toBe(f.original.token);
      expect(selected.url).toBe(f.original.url);
      expect(selected.fileDownloadEvidence).toEqual({
        filePageUrl: f.page.url,
        fileId: 'FDEMO',
        contextId: 'TDEMO',
      });
      expect(f.resolved.media.filename).not.toBe('example.m4a');
      expect(f.resolved.media.downloadUrl).toBeNull();
      expect(saveMediaSelectionOutput(selected)).toEqual({
        representation: 'slack-file-download',
        originalSelection: { status: 'selected', basis: 'source-bound-private-file-download' },
        originalFile: null,
      });
    }
  );

  test('duplicate controls for the same file route select deterministically', () => {
    const f = originalFixture();
    addDownload(f, f.original.url, 'file-download');
    f.preflight.candidates.reverse();
    expect(selectSaveMediaCandidate(f.preflight, f.resolved).controlIndex).toBe(f.control.index);
  });

  test('distinct preferred routes stop rather than fall back to a rendition', () => {
    const f = originalFixture({ mixed: true });
    addDownload(f, `${f.original.url}?origin_team=TDEMO`, 'file-download');
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'Conflicting source-bound'
    );
  });

  test('an omitted original candidate cannot downgrade to the listed rendition', () => {
    const f = originalFixture({ mixed: true });
    f.preflight.candidates.pop();
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'inventory is incomplete'
    );
  });

  test('route changes are detected even when both captures have no singular downloadUrl', () => {
    const f = originalFixture({ mixed: true });
    const before = structuredClone(f.preflight.observations[0]);
    before.content.nodes[f.original.controlIndex].url += '?origin_team=TDEMO';
    f.preflight.observations[0] = before;
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow('targets changed');
  });

  test.each(['TDEMO', 'EDEMO'])(
    'accepts one origin_team matching pinned %s context',
    (contextId) => {
      const f = originalFixture({ contextId });
      f.control.url = f.candidate.url += `?origin_team=${contextId}`;
      refreshMedia(f);
      expect(
        selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true })
          .fileDownloadEvidence.contextId
      ).toBe(contextId);
    }
  );

  test('accepts source-owned enterprise file-page origin_team matching the pinned context', () => {
    const f = originalFixture({ contextId: 'EDEMO' });
    f.control.url = f.candidate.url += '?origin_team=EDEMO';
    f.page.url =
      'https://example.enterprise.slack.com/files/UDEMO/FDEMO/example.m4a?origin_team=EDEMO';
    refreshMedia(f);
    const selected = selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true });
    expect(selected.fileDownloadEvidence).toEqual({
      filePageUrl: f.page.url,
      fileId: 'FDEMO',
      contextId: 'EDEMO',
    });
    expect(saveMediaSelectionOutput(selected).originalSelection.status).toBe('selected');
  });

  test.each([
    '',
    'origin_team=TDEMO',
    'origin_team=EOTHER',
    'origin_team=EDEMO&origin_team=EDEMO',
    'origin_team=EDEMO&x=1',
    '%6frigin_team=EDEMO',
    'origin_team=%45DEMO',
  ])('does not prefer a file-page with unverified query %s', (query) => {
    const f = originalFixture({ contextId: 'EDEMO' });
    f.page.url = `https://example.enterprise.slack.com/files/UDEMO/FDEMO/example.m4a?${query}`;
    refreshMedia(f);
    expect(selectSaveMediaCandidate(f.preflight, f.resolved).fileDownloadEvidence).toBeNull();
    expect(() =>
      selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true })
    ).toThrow('No source-bound original');
  });

  test.each(['pri', 'tmb'])(
    'retains unique %s fallback and offers actionable strict failure',
    (representation) => {
      const f = fixture({ representation });
      expect(
        saveMediaSelectionOutput(selectSaveMediaCandidate(f.preflight, f.resolved))
          .originalSelection.status
      ).toBe('unavailable');
      expect(() =>
        selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true })
      ).toThrow('Rerun without --original');
    }
  );

  test('canonical shape alone does not imply a source-bound original', () => {
    const f = originalFixture();
    f.page.url = 'https://example.invalid/example.m4a';
    refreshMedia(f);
    const selected = selectSaveMediaCandidate(f.preflight, f.resolved);
    expect(selected.routeKind).toBe('file-download');
    expect(selected.fileDownloadEvidence).toBeNull();
    expect(() =>
      selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true })
    ).toThrow('No source-bound original');
  });

  test('different observed targets remain ambiguous when neither proves an original route', () => {
    const f = fixture();
    addDownload(f, 'https://files.slack.com/files-tmb/TDEMO-FDEMO/other.m4a', 'rendition');
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'targets are ambiguous'
    );
  });

  test('duplicate observed fallback controls select the first captured control', () => {
    const f = fixture();
    addDownload(f, f.control.url, 'rendition');
    f.preflight.candidates.reverse();
    expect(selectSaveMediaCandidate(f.preflight, f.resolved).controlIndex).toBe(f.control.index);
  });

  test('a message-bound reference with unknown file ID retains its unique observed fallback', () => {
    const f = fixture();
    f.add(f.media, 'AXLink', [], 'Details', {
      url: 'https://example.slack.com/files/UDEMO/FOTHER/other.m4a',
    });
    refreshMedia(f);
    expect(f.resolved.media.fileId).toBeNull();
    expect(f.resolved.requested).toBe('CDEMO:1700000000.000001/m1');
    const selected = selectSaveMediaCandidate(f.preflight, f.resolved);
    expect(selected.url).toBe(f.control.url);
    expect(selected.fileDownloadEvidence).toBeNull();
  });

  test.each([
    'https://example.slack.com/files/UDEMO/FOTHER/example.m4a',
    'https://example.slack.com/files/UDEMO/FDEMO/other.m4a',
    'https://example.slack.com/files/UDEMO/FDEMO/extra/../example.m4a',
    'https://example.slack.com/files/UDEMO/FDEMO/extra/%2e%2e/example.m4a',
    'https://example.slack.com:443/files/UDEMO/FDEMO/example.m4a',
    'https://EXAMPLE.slack.com/files/UDEMO/FDEMO/example.m4a',
    'HTTPS://example.slack.com/files/UDEMO/FDEMO/example.m4a',
    'https://example.slack.com/files/UDEMO/FDEMO/example.m4a?x=1',
    'https://example.slack.com/files/UDEMO/FDEMO/example.m4a#x',
  ])('rejects unproven or noncanonical file-page evidence %s', (filePageUrl) => {
    const f = originalFixture();
    const selected = selectSaveMediaCandidate(f.preflight, f.resolved);
    selected.fileDownloadEvidence.filePageUrl = filePageUrl;
    expect(() => saveMediaSelectionOutput(selected)).toThrow('evidence is invalid');
  });

  test.each([
    ['HTTPS://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a', 'unknown'],
    ['https://FILES.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a', 'unknown'],
    ['https://files.slack.com:443/files-pri/TDEMO-FDEMO/download/example.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a?', 'unknown'],
    [
      'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a?origin_team=TOTHER',
      'unknown',
    ],
    [
      'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a?origin_team=TDEMO&origin_team=TDEMO',
      'unknown',
    ],
    [
      'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a?origin_team=TDEMO&x=1',
      'unknown',
    ],
    [
      'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.m4a?%6frigin_team=TDEMO',
      'unknown',
    ],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/café.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/a%7Fb.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/a%C2%80b.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/a"b.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/a<b.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/a`b.m4a', 'unknown'],
    ['https://files.slack.com/files-pri/TDEMO-FDEMO/download/a{b.m4a', 'unknown'],
  ])('does not prefer noncanonical Download URL %s', (url, routeKind) => {
    const f = originalFixture();
    f.control.url = f.candidate.url = url;
    f.candidate.routeKind = routeKind;
    refreshMedia(f);
    expect(selectSaveMediaCandidate(f.preflight, f.resolved).fileDownloadEvidence).toBeNull();
    expect(() =>
      selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true })
    ).toThrow('No source-bound original');
    f.candidate.routeKind = 'file-download';
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'classification differs'
    );
  });

  test.each(['caf%C3%A9.m4a', 'a%22b.m4a', 'a%3Cb.m4a', 'a%60b.m4a', 'a%7Bb.m4a'])(
    'accepts an encoded basename without normalizing %s',
    (basename) => {
      const f = originalFixture();
      f.control.url =
        f.candidate.url = `https://files.slack.com/files-pri/TDEMO-FDEMO/download/${basename}`;
      f.page.url = `https://example.slack.com/files/UDEMO/FDEMO/${basename}`;
      refreshMedia(f);
      expect(
        selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true }).url
      ).toBe(f.control.url);
    }
  );

  test.each(['café.m4a', 'a"b.m4a', 'a<b.m4a', 'a`b.m4a', 'a{b.m4a'])(
    'does not normalize a source file-page basename %s into evidence',
    (basename) => {
      const f = originalFixture();
      f.control.url =
        f.candidate.url = `https://files.slack.com/files-pri/TDEMO-FDEMO/download/${encodeURIComponent(basename)}`;
      f.page.url = `https://example.slack.com/files/UDEMO/FDEMO/${basename}`;
      refreshMedia(f);
      expect(selectSaveMediaCandidate(f.preflight, f.resolved).fileDownloadEvidence).toBeNull();
      expect(() =>
        selectSaveMediaCandidate(f.preflight, f.resolved, { originalRequired: true })
      ).toThrow('No source-bound original');
    }
  );
});

describe('observed Download selection', () => {
  test.each(['pri', 'tmb'])(
    'accepts the actual %s Download target without rewriting it',
    (representation) => {
      const f = fixture({ representation });
      const selected = selectSaveMediaCandidate(f.preflight, f.resolved);
      expect(selected).toEqual({
        ...f.candidate,
        route: { teamId: 'TDEMO', fileId: 'FDEMO', url: f.control.url },
        fileDownloadEvidence: null,
      });
      expect(selected.url).toBe(f.resolved.media.downloadUrl);
    }
  );

  test.each(['audio', 'video', 'file'])(
    'binds a %s attachment through its exact message source',
    (kind) => {
      const f = fixture({ kind });
      expect(selectSaveMediaCandidate(f.preflight, f.resolved).mediaIndex).toBe(f.media.index);
    }
  );

  const sourceChanges = [
    [
      'wrong operation',
      (f) => {
        f.preflight.operation = 'read-media';
      },
    ],
    [
      'wrong phase',
      (f) => {
        f.preflight.phase = 'result';
      },
    ],
    [
      'unresolved reference',
      (f) => {
        f.resolved.status = 'ambiguous';
      },
    ],
    [
      'different requested ref',
      (f) => {
        f.resolved.requested = 'FOTHER';
      },
    ],
    [
      'different selected ref',
      (f) => {
        f.resolved.media.ref = 'FOTHER';
      },
    ],
    [
      'missing second capture',
      (f) => {
        f.preflight.observations.pop();
      },
    ],
    [
      'truncated second capture',
      (f) => {
        f.preflight.observations[1].content.truncated = true;
      },
    ],
    [
      'wrong workspace',
      (f) => {
        f.resolved.workspace.contextId = 'TOTHER';
      },
    ],
    [
      'changed view URL',
      (f) => {
        f.resolved.view.url = 'https://app.slack.com/client/TDEMO/COTHER';
      },
    ],
    [
      'changed view title',
      (f) => {
        f.resolved.view.title = 'Other channel';
      },
    ],
    [
      'wrong web origin',
      (f) => {
        f.root.url = 'https://example.invalid/client/TDEMO/CDEMO';
        f.resolved.view.url = f.root.url;
      },
    ],
    [
      'wrong root role',
      (f) => {
        f.root.role = 'AXGroup';
      },
    ],
    [
      'different source message',
      (f) => {
        f.resolved.sources[0].messageRef = 'CDEMO:1700000000.000002';
      },
    ],
    [
      'different source permalink',
      (f) => {
        f.resolved.sources[0].permalink =
          'https://example.slack.com/archives/COTHER/p1700000000000001';
      },
    ],
    [
      'changed timestamp URL',
      (f) => {
        f.timestamp.url = 'https://example.slack.com/archives/CDEMO/p1700000000000002';
      },
    ],
    [
      'foreign timestamp URL',
      (f) => {
        f.timestamp.url = 'https://example.invalid/archives/CDEMO/p1700000000000001';
        f.resolved.sources[0].permalink = f.timestamp.url;
      },
    ],
    [
      'changed filename',
      (f) => {
        f.resolved.media.filename = 'other.m4a';
      },
    ],
    [
      'changed duration',
      (f) => {
        f.resolved.media.displayedDuration = '20 seconds';
      },
    ],
    [
      'file ID contradicts Download URL',
      (f) => {
        f.resolved.media.fileId = 'FOTHER';
      },
    ],
  ];
  test.each(sourceChanges)('rejects %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow();
  });

  test('a quoted timestamp cannot supply the selected message identity', () => {
    const f = fixture();
    const quote = f.add(f.container, 'AXGroup', ['c-message_attachment']);
    f.timestamp.parent = quote.index;
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'No supported Download'
    );
  });

  test('two nonquoted timestamps leave the source ambiguous', () => {
    const f = fixture();
    f.add(f.container, 'AXLink', ['c-timestamp'], 'Another', { url: f.timestamp.url });
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'No supported Download'
    );
  });

  test('a nested attachment cannot donate its Download control to an outer media root', () => {
    const f = fixture();
    const inner = f.add(f.media, 'AXGroup', ['p-message_file']);
    f.control.parent = inner.index;
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow('nested attachment');
  });

  test('a sibling message cannot donate an identically named Download control', () => {
    const f = fixture();
    const sibling = f.add(f.list, 'AXGroup', ['c-message_kit__actions']);
    const siblingMedia = f.add(sibling, 'AXGroup', ['p-message_file']);
    f.control.parent = siblingMedia.index;
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'outside its captured attachment'
    );
  });

  test('an unlisted supported Download control cannot silently downgrade selection', () => {
    const f = fixture();
    f.add(f.media, 'AXLink', [], f.control.label, { url: f.control.url });
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow(
      'inventory is incomplete'
    );
  });

  test.each([
    [
      'changed URL',
      (f) => {
        f.control.url += '?changed=1';
      },
    ],
    [
      'non-Download link',
      (f) => {
        f.control.label = 'Open example.m4a';
      },
    ],
    [
      'generic button',
      (f) => {
        f.control.role = 'AXButton';
      },
    ],
    [
      'missing media',
      (f) => {
        f.candidate.mediaIndex = 999;
      },
    ],
    [
      'negative control index',
      (f) => {
        f.candidate.controlIndex = -1;
      },
    ],
    [
      'fractional index',
      (f) => {
        f.candidate.containerIndex = 2.5;
      },
    ],
    [
      'unrecognized container',
      (f) => {
        f.container.classes = [];
      },
    ],
    [
      'malformed token',
      (f) => {
        f.candidate.token = 'token\n';
      },
    ],
    [
      'duplicate token',
      (f) => {
        f.preflight.candidates.push({ ...f.candidate, controlIndex: 999 });
      },
    ],
    [
      'duplicate control',
      (f) => {
        f.preflight.candidates.push({ ...f.candidate, token: 'other' });
      },
    ],
  ])('rejects candidate %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => selectSaveMediaCandidate(f.preflight, f.resolved)).toThrow();
  });
});

describe('native request receipts', () => {
  test.each(['started', 'result'])('accepts a fully verified %s receipt', (phase) => {
    const f = fixture();
    expect(() => verifySavePhase(f.phase(phase), f.preflight, f.candidate, phase)).not.toThrow();
  });

  test.each([
    [
      'pid',
      (r) => {
        r.pid = 456;
      },
    ],
    [
      'requested reference',
      (r) => {
        r.requested = 'FOTHER';
      },
    ],
    [
      'phase',
      (r) => {
        r.phase = 'select';
      },
    ],
    [
      'token',
      (r) => {
        r.selection.token = 'other';
      },
    ],
    [
      'media identity',
      (r) => {
        r.selection.mediaIndex++;
      },
    ],
    [
      'source identity',
      (r) => {
        r.selection.containerIndex++;
      },
    ],
    [
      'control identity',
      (r) => {
        r.selection.controlIndex++;
      },
    ],
    [
      'Download URL',
      (r) => {
        r.selection.url += '?other=1';
      },
    ],
    [
      'route classification',
      (r) => {
        r.selection.routeKind = 'file-download';
      },
    ],
    [
      'missing route classification',
      (r) => {
        delete r.selection.routeKind;
      },
    ],
    [
      'source proof',
      (r) => {
        r.verification.sourceMatched = false;
      },
    ],
    [
      'action proof',
      (r) => {
        r.verification.downloadRequested = false;
      },
    ],
    [
      'playback proof',
      (r) => {
        r.verification.playbackUnchanged = false;
      },
    ],
    [
      'attempted action',
      (r) => {
        r.action.attempted = false;
      },
    ],
    [
      'accepted action',
      (r) => {
        r.action.accepted = false;
      },
    ],
    [
      'missing timestamp',
      (r) => {
        delete r.action.startedAt;
      },
    ],
    [
      'fractional timestamp',
      (r) => {
        r.action.startedAt = 1.5;
      },
    ],
  ])('rejects mismatched or missing %s', (_name, mutate) => {
    const f = fixture();
    const receipt = f.phase('started');
    mutate(receipt);
    expect(() => verifySavePhase(receipt, f.preflight, f.candidate, 'started')).toThrow();
  });
});

function publicationFixture(f = fixture()) {
  const { resolved } = f;
  const selected = selectSaveMediaCandidate(f.preflight, resolved);
  const source = {
    path: '/tmp/slack-native/example.m4a',
    identity: { device: '1', inode: '2', size: '12', mtimeNs: '3' },
  };
  const destination = '/tmp/requested/example.m4a';
  const publication = {
    operation: 'save-media-publish',
    status: 'ok',
    source,
    artifact: {
      path: destination,
      bytes: 12,
      sha256: 'a'.repeat(64),
      published: true,
      verified: true,
    },
  };
  const download = {
    sourcePath: source.path,
    expectedSource: { device: '1', inode: '2', size: '12', mtimeNs: '3' },
    download: {
      downloadState: 'completed',
      downloadPath: source.path,
      url: selected.url,
      id: 'FDEMO',
      teamId: resolved.workspace.contextId,
    },
  };
  return { resolved, publication, download, destination, selected };
}

describe('saved attachment output', () => {
  test('reports the selected file route without claiming historical upload-byte equality', () => {
    const f = publicationFixture(originalFixture({ mixed: true, contextId: 'EDEMO' }));
    const output = savedMediaOutput(
      f.resolved,
      f.publication,
      f.download,
      f.destination,
      f.selected
    );
    expect(output.saved.representation).toBe('slack-file-download');
    expect(output.saved.originalSelection).toEqual({
      status: 'selected',
      basis: 'source-bound-private-file-download',
    });
    expect(output.saved.originalFile).toBeNull();
    expect(output.coverage.originalFileVerified).toBeNull();
    expect(output.coverage.reason).toContain(
      'Equality to the originally uploaded bytes remains unknown'
    );
  });

  test('requires completed .download and carries the exact published artifact without claiming originals', () => {
    const f = publicationFixture();
    const output = savedMediaOutput(
      f.resolved,
      f.publication,
      f.download,
      f.destination,
      f.selected
    );
    expect(output.status).toBe('ok');
    expect(output.saved.path).toBe(f.destination);
    expect(output.saved.sha256).toBe(f.publication.artifact.sha256);
    expect(output.saved.nativePath).toBe(f.download.download.downloadPath);
    expect(output.saved.originalFile).toBeNull();
    expect(output.saved.representation).toBe('observed-download-target');
    expect(output.saved.originalSelection).toEqual({
      status: 'unavailable',
      basis: 'observed-download-target',
    });
    expect(output.coverage.contentInterpreted).toBe(false);
  });

  test.each([
    [
      'different ledger URL',
      (f) => {
        f.download.download.url += '?other=1';
      },
    ],
    [
      'different ledger file ID',
      (f) => {
        f.download.download.id = 'FOTHER';
      },
    ],
    [
      'different ledger context',
      (f) => {
        f.download.download.teamId = 'TOTHER';
      },
    ],
    [
      'missing selected evidence',
      (f) => {
        delete f.selected;
      },
    ],
    [
      'legacy .record completion',
      (f) => {
        f.download.record = f.download.download;
        delete f.download.download;
      },
    ],
    [
      'incomplete download',
      (f) => {
        f.download.download.downloadState = 'progressing';
      },
    ],
    [
      'different source path',
      (f) => {
        f.publication.source.path += '.other';
      },
    ],
    [
      'different device',
      (f) => {
        f.publication.source.identity.device = '9';
      },
    ],
    [
      'different inode',
      (f) => {
        f.publication.source.identity.inode = '9';
      },
    ],
    [
      'different size',
      (f) => {
        f.publication.source.identity.size = '13';
      },
    ],
    [
      'different mtime',
      (f) => {
        f.publication.source.identity.mtimeNs = '9';
      },
    ],
    [
      'different destination',
      (f) => {
        f.publication.artifact.path += '.other';
      },
    ],
    [
      'unpublished artifact',
      (f) => {
        f.publication.artifact.published = false;
      },
    ],
    [
      'unverified artifact',
      (f) => {
        f.publication.artifact.verified = false;
      },
    ],
    [
      'wrong byte count',
      (f) => {
        f.publication.artifact.bytes = 13;
      },
    ],
    [
      'missing digest',
      (f) => {
        delete f.publication.artifact.sha256;
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const f = publicationFixture();
    mutate(f);
    expect(() =>
      savedMediaOutput(f.resolved, f.publication, f.download, f.destination, f.selected)
    ).toThrow();
  });
});
