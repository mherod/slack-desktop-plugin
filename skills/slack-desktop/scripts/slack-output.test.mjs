import { describe, expect, test } from 'bun:test';
import {
  compactOutput,
  structuredOutput,
  withDMNavigation,
  mediaObservationOutput,
} from './slack-output.mjs';

// Synthetic AX shapes only. No real workspace IDs, names, queries, or transcripts.
function fixture(kind = 'channel') {
  const nodes = [];
  const add = (parent, role = 'AXGroup', classes = [], label = '', extra = {}) => {
    const index = nodes.length;
    nodes.push({ index, parent, role, classes, label, id: '', ...extra });
    return index;
  };
  const name = kind === 'dm' ? 'Alex Example' : 'project-help';
  const id = kind === 'dm' ? 'DDEMO1' : 'CDEMO1';
  const title = `${name} (${kind === 'dm' ? 'DM' : 'Channel'}) - Test Workspace - 2 new items - Slack`;
  const url = `https://app.slack.com/client/TDEMO/${id}`;
  const root = add(null, 'AXWebArea', [], title, { url });
  const primary = add(root, 'AXGroup', ['p-workspace__primary_view_body']);
  const pane = add(primary, 'AXGroup', ['p-message_pane']);
  const scroller = add(pane, 'AXGroup', ['c-scrollbar__hider']);
  const list = add(
    scroller,
    'AXList',
    ['sr-only'],
    `${name} (${kind === 'dm' ? 'direct message, active' : 'channel, 1 unread message'})`
  );
  const receipt = {
    content: { nodes, observedAt: '2026-01-01T12:00:00Z' },
    target: {
      kind,
      name,
      url,
      requested: kind === 'dm' ? '@alex.example' : name,
      handle: kind === 'dm' ? '@alex.example' : null,
    },
    before: {
      title: 'Previous view',
      url: 'https://app.slack.com/client/TDEMO/search',
      extraPrivateData: 'omit this',
    },
    after: { title, url },
    desktop: { samples: [{ foregroundPid: 42, cursor: [100, 200] }] },
  };
  const message = (timestamp, options = {}) => {
    const item = add(
      options.list ?? list,
      'AXGroup',
      ['c-virtual_list__item'],
      options.aggregate ?? '',
      { id: `message-list_${timestamp}` }
    );
    const hover = add(item, 'AXGroup', ['c-message_kit__hover']);
    const body = add(hover, 'AXGroup', ['c-message_kit__actions']);
    if (!options.compact) {
      add(body, 'AXButton', ['c-message__sender_button'], 'Sam Example');
      add(body, 'AXStaticText', [], 'App badge');
    }
    const timeParent = options.compact
      ? add(body, 'AXGroup', ['p-message_pane_message__compact_timestamp'])
      : body;
    const time = add(timeParent, 'AXLink', ['c-timestamp'], 'Yesterday at 10:00 AM', {
      url: `https://demo.slack.com/archives/${options.conversationId ?? id}/p${timestamp.replace('.', '')}`,
    });
    add(time, 'AXStaticText', [], '10:00 AM');
    return { item, body, time };
  };
  return { nodes, add, receipt, root, primary, pane, list, name, id, message };
}

function emptySearchFixture(guidance) {
  const f = fixture();
  f.nodes[f.root].label = 'Search - Test Workspace - Slack';
  f.nodes[f.root].url = 'https://app.slack.com/client/TDEMO/search';
  f.nodes[f.list].role = 'AXGroup';
  f.nodes[f.list].label = '';
  const search = f.add(f.root, 'AXButton', [], 'Search: no-match');
  f.receipt.after = {
    nodes: [{ role: 'AXWebArea', label: f.nodes[f.root].label, url: f.nodes[f.root].url }],
  };
  const empty = f.add(f.root, 'AXGroup', ['c-empty_state']);
  const heading = f.add(empty, 'AXStaticText', [], 'Nothing turned up');
  const guide = f.add(empty, 'AXStaticText', [], guidance);
  return { ...f, search, empty, heading, guide };
}

function markGrouped(f, message) {
  f.nodes[message.body].classes.push('c-message_kit__actions--above');
  f.nodes[f.nodes[message.time].parent].classes.push(
    'p-message_pane_message__compact_timestamp--adjacent'
  );
  return message;
}

// Thread panes mark grouped replies with the thread gutter class instead.
function markThreadGrouped(f, message) {
  markGrouped(f, message);
  const gutter = f.nodes[f.nodes[message.time].parent];
  gutter.classes = gutter.classes
    .filter((name) => !name.startsWith('p-message_pane_message__compact_timestamp'))
    .concat(['p-thread_compact_gutter_generic', 'p-thread_compact_gutter_generic--adjacent']);
  return message;
}

function groupDMFixture(id = 'CGROUP1') {
  const f = fixture('dm');
  const name = 'Alex Example, Sam Example';
  const title = `${name} (DM) - Test Workspace - Slack`;
  const url = `https://app.slack.com/client/TDEMO/${id}`;
  Object.assign(f.nodes[f.root], { label: title, url });
  f.nodes[f.list].label = `${name} (group direct message)`;
  f.receipt.after = { title, url };
  f.receipt.target = {
    kind: 'dm',
    dmKind: 'group',
    conversationId: id,
    requested: `group:${id}`,
    name,
    url,
    handle: null,
  };
  return {
    ...f,
    id,
    name,
    message: (timestamp, options = {}) => f.message(timestamp, { conversationId: id, ...options }),
    read: () => compactOutput(f.receipt, 'read-dm', `group:${id}`),
  };
}

function threadFixture({ count = 2, replyCount = 2, kind = 'channel' } = {}) {
  const f = fixture(kind);
  const rootTS = '1700000000.000001';
  const permalink = (timestamp) =>
    `https://demo.slack.com/archives/${f.id}/p${timestamp.replace('.', '')}`;
  f.add(f.message(rootTS).body, 'AXStaticText', [], 'Main timeline copy must be excluded');
  const view = f.add(f.root, 'AXGroup', ['p-view_contents'], 'Thread in channel project-help');
  const toolbar = f.add(view, 'AXToolbar', ['p-flexpane_header']);
  const header = f.add(toolbar, 'AXLink', ['p-threads_flexpane__header_permalink'], f.name, {
    url: permalink(rootTS),
  });
  const body = f.add(view, 'AXGroup', ['p-threads_flexpane_container']);
  const pane = f.add(body, 'AXGroup', ['p-threads_flexpane']);
  const list = f.add(
    pane,
    'AXList',
    ['c-virtual_list__scroll_container'],
    kind === 'dm'
      ? `Thread with alex.example (direct message, away${count === null ? '' : `, ${count} replies`}, has draft)`
      : `Thread in ${f.name} (private channel${count === null ? '' : `, ${count} replies`})`
  );
  const message = (timestamp, options = {}) => {
    const result = f.message(timestamp, { ...options, list });
    f.nodes[result.item].id = `${f.id}-${rootTS}-thread-list-Thread_${timestamp}`;
    f.nodes[result.time].url =
      `${permalink(timestamp)}${timestamp === rootTS ? '' : `?thread_ts=${rootTS}&cid=${f.id}`}`;
    const section = f.add(result.body, 'AXGroup', ['p-rich_text_section']);
    f.add(
      section,
      'AXStaticText',
      [],
      options.text ?? (timestamp === rootTS ? 'Root message' : `Reply ${timestamp}`)
    );
    return { ...result, section };
  };
  const rootMessage = message(rootTS);
  const separator = f.add(list, 'AXGroup', ['c-virtual_list__item'], '', {
    id: `${f.id}-${rootTS}-thread-list-Thread_separator`,
  });
  const separatorBody = f.add(separator, 'AXGroup', ['p-threads_flexpane__separator']);
  const countNode = f.add(
    separatorBody,
    'AXStaticText',
    [],
    count === null ? '' : `${count} replies`
  );
  const replies = [];
  for (let index = 0; index < replyCount; index++)
    replies.push(message(`170000000${index + 1}.000001`, { compact: index === 1 }));
  const composer = f.add(pane, 'AXGroup', ['p-threads_footer__input']);
  f.add(composer, 'AXTextArea', [], 'Private thread draft');
  f.receipt.target = {
    kind: 'thread',
    conversationId: f.id,
    requestedMessageTS: rootTS,
    rootTS,
    requestedURL: permalink(rootTS),
    url: f.receipt.after.url,
  };
  const read = () => structuredOutput(f.receipt, 'read-thread', f.receipt.target.requestedURL);
  return {
    ...f,
    view,
    threadPane: pane,
    threadList: list,
    header,
    rootTS,
    rootMessage,
    separator,
    countNode,
    replies,
    threadMessage: message,
    permalink,
    read,
  };
}

function removeCapturedSubtree(fixture, index) {
  const removed = new Set([index]);
  for (const node of fixture.receipt.content.nodes)
    if (removed.has(node.parent)) removed.add(node.index);
  fixture.receipt.content.nodes = fixture.receipt.content.nodes.filter(
    (node) => !removed.has(node.index)
  );
}

describe('read-media source observations', () => {
  const observation = (f, thread = false) => ({
    before: { ...f.receipt.after },
    after: { ...f.receipt.after },
    content: { ...f.receipt.content, truncated: false },
    ...(thread ? { threadTarget: f.receipt.target } : {}),
  });
  test('retains all exposed DM messages, including attachments beyond the text page', () => {
    const f = fixture('dm');
    for (let i = 0; i < 15; i++) f.message(`17000000${String(i).padStart(2, '0')}.000001`);
    const result = mediaObservationOutput(observation(f));
    expect(result.messages).toHaveLength(15);
    expect(result.workspace.id).toBe('TDEMO');
    expect(result.view).toEqual(f.receipt.after);
  });
  test('reads shared-channel media only from its exact primary conversation scope', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const media = f.add(body, 'AXGroup', ['c-pillow_file_container']);
    f.add(media, 'AXLink', [], 'notes.pdf', {
      url: 'https://demo.slack.com/files/UDEMO/FSHARED1/notes.pdf',
    });
    f.nodes[f.list].label = `${f.name} (shared channel, 5 unread highlights)`;
    const result = mediaObservationOutput(observation(f));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].attachments[0]).toMatchObject({
      ref: 'FSHARED1',
      fileId: 'FSHARED1',
      contentRead: false,
    });
    expect(result.view).toEqual(f.receipt.after);

    const changedCID = { receipt: structuredClone(f.receipt) };
    changedCID.receipt.content.nodes.find((node) => node.index === f.root).url =
      'https://app.slack.com/client/TDEMO/COTHER';
    changedCID.receipt.after.url = 'https://app.slack.com/client/TDEMO/COTHER';
    expect(() => mediaObservationOutput(observation(changedCID))).toThrow('different conversation');

    for (const label of [
      `${f.name} (shared channel extra)`,
      `${f.name} (shared channels)`,
      'other (shared channel)',
      `${f.name} (direct message)`,
      `${f.name} (group direct message)`,
    ]) {
      f.nodes[f.list].label = label;
      expect(() => mediaObservationOutput(observation(f))).toThrow('message list');
    }
    f.nodes[f.list].label = `${f.name} (shared channel)`;
    f.nodes[f.pane].parent = f.root;
    expect(() => mediaObservationOutput(observation(f))).toThrow('main conversation');
  });
  test('shared-channel list labels cannot corroborate a direct message view', () => {
    const f = fixture('dm');
    f.message('1700000000.000001');
    f.nodes[f.list].label = `${f.name} (shared channel, 1 unread message)`;
    expect(() => mediaObservationOutput(observation(f))).toThrow('message list');
  });
  test('includes the verified thread root and replies alongside main history without drafts', () => {
    const f = threadFixture();
    const result = mediaObservationOutput(observation(f, true));
    expect(result.messages).toHaveLength(4);
    expect(result.messages.map((message) => message.text)).toContain('Root message');
    expect(JSON.stringify(result)).not.toContain('Private thread draft');
  });
  test('withholds an exposed thread without its native identity', () => {
    expect(() => mediaObservationOutput(observation(threadFixture()))).toThrow('verified source');
  });
  test('rejects changed views, incomplete captures and unexpected pickers', () => {
    const f = fixture();
    f.message('1700000000.000001');
    const changed = observation(f);
    changed.before.url += '/different';
    expect(() => mediaObservationOutput(changed)).toThrow('changed');
    const truncated = observation(f);
    truncated.content.truncated = true;
    expect(() => mediaObservationOutput(truncated)).toThrow('incompletely');
    f.add(f.root, 'AXComboBox', [], 'Query');
    expect(() => mediaObservationOutput(observation(f))).toThrow('Search picker');
  });
});

describe('structured Slack threads', () => {
  test('reads the observed individual-DM Thread with caption through its verified header', () => {
    const f = threadFixture({ kind: 'dm' });
    const result = f.read();
    expect(result.conversation).toMatchObject({ id: 'DDEMO1', kind: 'dm', name: 'Alex Example' });
    expect(result.thread.root.text).toBe('Root message');
    expect(result.thread.replies.map((message) => message.text)).toEqual([
      'Reply 1700000001.000001',
      'Reply 1700000002.000001',
    ]);
    expect(result.thread.displayedReplyCount).toBe(2);
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Private thread draft');
    f.receipt.target.requestedMessageTS = '1700000002.000001';
    f.receipt.target.requestedURL = f.nodes[f.replies[1].time].url;
    expect(f.read().thread.requestedMessageTS).toBe('1700000002.000001');
  });

  test('Thread with never substitutes for missing headers or channel/group identity', () => {
    const withoutHeader = threadFixture({ kind: 'dm' });
    removeCapturedSubtree(withoutHeader, withoutHeader.header);
    expect(() => withoutHeader.read()).toThrow('Individual DM thread caption');
    const channel = threadFixture();
    channel.nodes[channel.threadList].label =
      'Thread with alex.example (direct message, 2 replies)';
    expect(() => channel.read()).toThrow('Individual DM thread caption');
    for (const caption of [
      'Thread with alex.example (channel, 2 replies)',
      'Thread with alex.example (private channel, 2 replies)',
      'Thread with alex.example (group direct message, 2 replies)',
      'Thread with alex.example (private direct message, 2 replies)',
      'Thread with alex.example',
    ]) {
      const f = threadFixture({ kind: 'dm' });
      f.nodes[f.threadList].label = caption;
      expect(() => f.read()).toThrow('Individual DM thread caption');
    }
  });

  test('Thread with retains exact root, reply, workspace and list ownership guards', () => {
    const mutations = [
      (f) => {
        f.nodes[f.header].url = f.nodes[f.header].url.replace('DDEMO1', 'DOTHER');
      },
      (f) => {
        f.nodes[f.header].url = f.nodes[f.header].url.replace('demo.slack.com', 'other.slack.com');
      },
      (f) => {
        f.nodes[f.header].url = f.nodes[f.replies[0].time].url;
      },
      (f) => {
        f.nodes[f.replies[0].time].url = f.nodes[f.replies[0].time].url.replace('DDEMO1', 'DOTHER');
      },
      (f) => {
        f.nodes[f.replies[0].time].url = f.nodes[f.replies[0].time].url.replace(
          f.rootTS,
          '1700000099.000001'
        );
      },
      (f) => {
        f.add(
          f.threadPane,
          'AXList',
          ['c-virtual_list__scroll_container'],
          'Thread in another (direct message)'
        );
      },
      (f) => {
        f.nodes[f.threadList].parent = f.root;
      },
    ];
    for (const mutate of mutations) {
      const f = threadFixture({ kind: 'dm' });
      mutate(f);
      expect(() => f.read()).toThrow();
    }
  });

  test('separates the root from ordered replies and excludes main history, drafts and reactions', () => {
    const f = threadFixture();
    const reaction = f.add(f.replies[0].body, 'AXGroup', ['c-reaction_bar']);
    f.add(reaction, 'AXStaticText', [], 'Reaction count must be excluded');
    const result = f.read();
    expect(result.thread.root.text).toBe('Root message');
    expect(result.thread.root.id).toEndWith(`Thread_${f.rootTS}`);
    expect(result.thread.root.thread).toMatchObject({ replyCount: 2, repliesRead: true });
    expect(result.thread.replies.map((message) => message.text)).toEqual([
      'Reply 1700000001.000001',
      'Reply 1700000002.000001',
    ]);
    expect(result.thread).toMatchObject({
      rootTS: f.rootTS,
      requestedMessageTS: f.rootTS,
      observedReplyCount: 2,
      displayedReplyCount: 2,
    });
    expect(result.conversation).toMatchObject({
      id: 'CDEMO1',
      name: 'project-help',
      kind: 'channel',
    });
    expect(result.coverage).toMatchObject({
      complete: false,
      observedCount: 3,
      threadRepliesIncluded: true,
    });
    expect(result.pagination.hasMore).toBeNull();
    expect(result.thread.replies[1].author).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(
      /Main timeline copy|Private thread draft|Reaction count/
    );
  });

  test('identifies a requested reply independently from its root and preserves string timestamps', () => {
    const f = threadFixture();
    f.receipt.target.requestedMessageTS = '1700000002.000001';
    f.receipt.target.requestedURL = f.nodes[f.replies[1].time].url;
    expect(f.read().thread).toMatchObject({
      requestedMessageTS: '1700000002.000001',
      rootTS: '1700000000.000001',
    });
    f.receipt.target.requestedURL = f.permalink('1700000002.000001');
    expect(f.read().thread.requestedMessageTS).toBe('1700000002.000001');
    f.receipt.target.requestedURL += '?thread_ts=1700000099.000001';
    expect(f.read).toThrow('conflicts with verified metadata');
  });

  test('accepts compact thread references only with verified workspace and message identity', () => {
    const f = threadFixture();
    f.receipt.target.requestedURL = `CDEMO1:${f.rootTS}`;
    f.receipt.target.requestedHost = 'demo.slack.com';
    const result = f.read();
    expect(result.requested).toBe(`CDEMO1:${f.rootTS}`);
    expect(result.thread.ref).toBe(`CDEMO1:${f.rootTS}`);
    expect(result.thread.root.thread.ref).toBe(`CDEMO1:${f.rootTS}`);
    expect(result.thread.replies[0].thread.ref).toBeNull();
    expect(result.thread.root.thread.navigation).toEqual({
      command: 'read-thread',
      args: [`CDEMO1:${f.rootTS}`],
    });
    expect(result.navigation).toEqual([
      { command: 'read-thread', args: [`CDEMO1:${f.rootTS}`] },
      { command: 'read-channel', args: ['project-help'] },
    ]);
    f.receipt.target.requestedMessageTS = '1700000002.000001';
    f.receipt.target.requestedURL = 'CDEMO1:1700000002.000001';
    expect(f.read().thread.ref).toBe(`CDEMO1:${f.rootTS}`);
    f.receipt.target.requestedHost = 'other.slack.com';
    expect(f.read).toThrow('different root or workspace');
    delete f.receipt.target.requestedHost;
    expect(f.read).toThrow('workspace host');
    f.receipt.target.requestedHost = 'demo.slack.com/path';
    expect(f.read).toThrow('workspace host');
  });

  test('rejects malformed or conflicting compact references while retaining URL host validation', () => {
    for (const reference of [
      'COTHER:1700000000.000001',
      'CDEMO1:1700000009.000001',
      'CDEMO1:1700000000.1',
      'CDEMO1:1700000000.000001?extra=1',
    ]) {
      const f = threadFixture();
      f.receipt.target.requestedURL = reference;
      f.receipt.target.requestedHost = 'demo.slack.com';
      expect(f.read).toThrow();
    }
    const f = threadFixture();
    f.receipt.target.requestedURL = f.receipt.target.requestedURL.replace(
      'demo.slack.com',
      'other.slack.com'
    );
    f.receipt.target.requestedHost = 'demo.slack.com';
    expect(f.read).toThrow('different root or workspace');
  });

  test('rejects another root in the same channel and an absent requested reply', () => {
    const wrongHeader = threadFixture();
    wrongHeader.nodes[wrongHeader.header].url = wrongHeader.permalink('1700000099.000001');
    expect(wrongHeader.read).toThrow('different root');
    const noRequested = threadFixture();
    noRequested.receipt.target.requestedMessageTS = '1700000099.000001';
    noRequested.receipt.target.requestedURL = `${noRequested.permalink('1700000099.000001')}?thread_ts=${noRequested.rootTS}`;
    expect(noRequested.read).toThrow('requested message is not exposed');
  });

  test('reads a channel thread without a header link using its observed root timestamp', () => {
    const f = threadFixture({ count: 6 });
    removeCapturedSubtree(f, f.header);
    f.nodes[f.view].classes.push('p-view_contents--secondary');
    const result = f.read();
    expect(result.thread).toMatchObject({
      rootPermalink: f.nodes[f.rootMessage.time].url,
      displayedReplyCount: 6,
      observedReplyCount: 2,
    });
    expect(result.thread.root.text).toBe('Root message');
    expect(result.conversation).toMatchObject({ name: f.name, kind: 'channel' });
    expect(result.navigation).toContainEqual({ command: 'read-channel', args: [f.name] });
    expect(result.coverage.complete).toBe(false);
  });

  test('uses an observed main-pane root link without copying its text when the thread root is virtualized', () => {
    const f = threadFixture();
    removeCapturedSubtree(f, f.header);
    removeCapturedSubtree(f, f.rootMessage.item);
    const result = f.read();
    expect(result.thread).toMatchObject({
      root: null,
      rootPermalink: f.permalink(f.rootTS),
      observedReplyCount: 2,
    });
    expect(result.coverage.warnings).toContain('Root message is outside this view.');
    expect(JSON.stringify(result)).not.toContain('Main timeline copy');
  });

  test('group DM threads can use only the matching group main-history list as an external root anchor', () => {
    for (const mainKind of ['group direct message', 'direct message', 'channel']) {
      const f = threadFixture();
      removeCapturedSubtree(f, f.header);
      removeCapturedSubtree(f, f.rootMessage.item);
      f.nodes[f.root].label = `${f.name} (DM) - Test Workspace - Slack`;
      f.receipt.after.title = f.nodes[f.root].label;
      f.nodes[f.list].label = `${f.name} (${mainKind})`;
      f.nodes[f.threadList].label = `Thread in ${f.name}`;
      if (mainKind !== 'group direct message') {
        expect(f.read).toThrow('root permalink is unavailable');
        continue;
      }
      const result = f.read();
      expect(result.conversation).toMatchObject({ id: f.id, kind: 'dm', dmKind: 'group' });
      expect(result.thread.root).toBeNull();
      expect(result.thread.replies).toHaveLength(2);
      expect(result.navigation.some((action) => action.command === 'read-channel')).toBe(false);
    }
  });

  test('explicit group thread list labels retain DM kind instead of offering channel navigation', () => {
    const f = threadFixture();
    f.nodes[f.threadList].label = `Thread in ${f.name} (group direct message, 2 replies)`;
    const result = f.read();
    expect(result.conversation).toMatchObject({ kind: 'dm', dmKind: 'group' });
    expect(result.navigation).toEqual([{ command: 'read-thread', args: [`${f.id}:${f.rootTS}`] }]);
  });

  test('decorated thread titles retain a corroborated main-history root and real conversation name', () => {
    for (const group of [false, true]) {
      for (const literalStar of [false, true]) {
        const f = threadFixture();
        const name = `${literalStar ? '* ' : ''}${f.name}`;
        removeCapturedSubtree(f, f.header);
        removeCapturedSubtree(f, f.rootMessage.item);
        f.nodes[f.root].label = `* ${name} (${group ? 'DM' : 'Channel'}) - Test Workspace - Slack`;
        f.receipt.after.title = f.nodes[f.root].label;
        f.nodes[f.list].label = `${name} (${group ? 'group direct message' : 'channel'})`;
        f.nodes[f.threadList].label = `Thread in ${name}`;
        const result = f.read();
        expect(result.conversation.name).toBe(name);
        expect(result.conversation.kind).toBe(group ? 'dm' : 'channel');
        expect(result.thread.root).toBeNull();
        expect(result.thread.rootPermalink).toBe(f.permalink(f.rootTS));
        expect(result.thread.replies).toHaveLength(2);
      }
    }
  });

  test('headerless thread fallback corroborates decorated names even when its root is exposed', () => {
    const f = threadFixture();
    removeCapturedSubtree(f, f.header);
    f.nodes[f.root].label = `* ${f.nodes[f.root].label}`;
    f.receipt.after.title = f.nodes[f.root].label;
    f.nodes[f.threadList].label = `Thread in ${f.name}`;
    expect(f.read().conversation).toMatchObject({ name: f.name, kind: 'channel' });
    f.nodes[f.list].label = 'Unrelated (channel)';
    expect(f.read().conversation.name).toBe(f.name);
    f.nodes[f.threadList].label = 'Thread in Unrelated';
    expect(f.read().conversation.name).toBeNull();
  });

  test('exclamation-mark thread titles retain corroborated names and root references', () => {
    for (const literalPrefix of ['', '! ', '* ']) {
      const f = threadFixture();
      const name = `${literalPrefix}${f.name}`;
      removeCapturedSubtree(f, f.header);
      f.nodes[f.root].label = `! ${name} (Channel) - Test Workspace - Slack`;
      f.receipt.after.title = f.nodes[f.root].label;
      f.nodes[f.list].label = `${name} (channel)`;
      f.nodes[f.threadList].label = `Thread in ${name}`;
      const result = f.read();
      expect(result.conversation.name).toBe(name);
      expect(result.thread.rootPermalink).toBe(f.permalink(f.rootTS));
      expect(result.thread.replies).toHaveLength(2);
      f.nodes[f.list].label = 'Other (channel)';
      f.nodes[f.threadList].label = 'Thread in Other';
      expect(f.read().conversation.name).toBeNull();
    }
  });

  test('decorated thread recovery rejects ambiguous names, wrong list kinds and invalid root proof', () => {
    const changes = [
      (f) => {
        f.nodes[f.list].label = `${f.name} (direct message)`;
      },
      (f) => {
        f.nodes[f.list].label = `Other (channel)`;
      },
      (f) => {
        f.nodes[f.threadList].label = `Thread in * ${f.name}`;
      },
      (f) => {
        const index = f.add(f.pane, 'AXList', ['sr-only'], `* ${f.name} (channel)`);
        f.receipt.content.nodes.push(f.nodes[index]);
      },
      (f) => {
        f.nodes[f.replies[0].time].url = f.permalink('1700000001.000001');
      },
      (f) => {
        f.nodes[f.root].label = `* ${f.nodes[f.root].label}`;
        f.receipt.after.title = f.nodes[f.root].label;
      },
    ];
    for (const change of changes) {
      const f = threadFixture();
      removeCapturedSubtree(f, f.header);
      removeCapturedSubtree(f, f.rootMessage.item);
      f.nodes[f.root].label = `* ${f.nodes[f.root].label}`;
      f.receipt.after.title = f.nodes[f.root].label;
      f.nodes[f.threadList].label = `Thread in ${f.name}`;
      change(f);
      expect(f.read).toThrow();
    }
  });

  test('requires every reply to prove its root relationship when only the main-pane root link is exposed', () => {
    for (const invalidLink of [
      undefined,
      'https://demo.slack.com/archives/CDEMO1/p1700000001000001',
      'https://demo.slack.com/archives/CDEMO1/p1700000001000001?thread_ts=1700000099.000001',
    ]) {
      const f = threadFixture();
      removeCapturedSubtree(f, f.header);
      removeCapturedSubtree(f, f.rootMessage.item);
      f.nodes[f.replies[0].time].url = invalidLink;
      expect(f.read).toThrow();
    }
    const noMessages = threadFixture({ count: 0, replyCount: 0 });
    removeCapturedSubtree(noMessages, noMessages.header);
    removeCapturedSubtree(noMessages, noMessages.rootMessage.item);
    expect(noMessages.read).toThrow('root relationship is not exposed');
  });

  test('rejects absent or mismatched root anchors instead of fabricating a permalink', () => {
    const absent = threadFixture();
    removeCapturedSubtree(absent, absent.header);
    for (const node of absent.nodes)
      if (node.url === absent.permalink(absent.rootTS)) delete node.url;
    expect(absent.read).toThrow('root permalink is unavailable');

    const wrongRoot = threadFixture();
    removeCapturedSubtree(wrongRoot, wrongRoot.header);
    wrongRoot.nodes[wrongRoot.rootMessage.time].url = wrongRoot.permalink('1700000099.000001');
    expect(wrongRoot.read).toThrow('different root or workspace');

    const wrongMainRoot = threadFixture();
    removeCapturedSubtree(wrongMainRoot, wrongMainRoot.header);
    removeCapturedSubtree(wrongMainRoot, wrongMainRoot.rootMessage.item);
    const mainTimestamp = wrongMainRoot.receipt.content.nodes.find(
      (node) => node.url === wrongMainRoot.permalink(wrongMainRoot.rootTS)
    );
    mainTimestamp.url = wrongMainRoot.permalink('1700000099.000001');
    expect(wrongMainRoot.read).toThrow('different root or workspace');
  });

  test('does not use a root anchor from an unverified main conversation', () => {
    const f = threadFixture();
    removeCapturedSubtree(f, f.header);
    removeCapturedSubtree(f, f.rootMessage.item);
    f.nodes[f.root].url = 'https://app.slack.com/client/TDEMO/COTHER';
    f.receipt.after.url = f.nodes[f.root].url;
    f.receipt.target.url = f.nodes[f.root].url;
    expect(f.read).toThrow('root permalink is unavailable');
  });

  test('uses the verified current channel title when a headerless thread label has no conversation kind', () => {
    const f = threadFixture();
    removeCapturedSubtree(f, f.header);
    f.nodes[f.threadList].label = 'Thread in project-help';
    expect(f.read().conversation).toMatchObject({ name: f.name, kind: 'channel' });
    f.nodes[f.root].url = 'https://app.slack.com/client/TDEMO/search';
    f.receipt.after.url = f.nodes[f.root].url;
    f.receipt.target.url = f.nodes[f.root].url;
    expect(f.read().conversation).toMatchObject({ name: null, kind: null, url: null });
  });

  test('rejects mismatched permalink message, workspace, channel and thread relationship', () => {
    const mutations = [
      (f) => {
        f.nodes[f.replies[0].time].url = f.permalink('1700000099.000001');
      },
      (f) => {
        f.nodes[f.replies[0].time].url = f.nodes[f.replies[0].time].url.replace(
          'demo.slack.com',
          'other.slack.com'
        );
      },
      (f) => {
        f.nodes[f.replies[0].time].url = f.nodes[f.replies[0].time].url.replaceAll(
          'CDEMO1',
          'COTHER'
        );
      },
      (f) => {
        f.nodes[f.replies[0].time].url =
          `${f.permalink('1700000001.000001')}?thread_ts=1700000099.000001`;
      },
    ];
    for (const mutate of mutations) {
      const f = threadFixture();
      mutate(f);
      expect(f.read).toThrow();
    }
  });

  test('retains verified replies when the root is virtualized outside the captured list', () => {
    const f = threadFixture();
    removeCapturedSubtree(f, f.rootMessage.item);
    const result = f.read();
    expect(result.thread.root).toBeNull();
    expect(result.thread.rootPermalink).toBe(f.nodes[f.header].url);
    expect(result.thread.replies.map((message) => message.text)).toEqual([
      'Reply 1700000001.000001',
      'Reply 1700000002.000001',
    ]);
    expect(result.coverage).toMatchObject({
      complete: false,
      observedCount: 2,
      threadRepliesIncluded: true,
    });
    expect(result.coverage.warnings).toContain('Root message is outside this view.');
    expect(JSON.stringify(result)).not.toContain('Main timeline copy');
    f.receipt.target.requestedMessageTS = '1700000002.000001';
    f.receipt.target.requestedURL = f.nodes[f.replies[1].time].url;
    expect(f.read().thread.requestedMessageTS).toBe('1700000002.000001');
  });

  test('reads the observed scrollbar-wrapped thread list without including nested rich-text lists', () => {
    const f = threadFixture();
    const scrollbar = f.add(f.threadPane, 'AXGroup', ['c-scrollbar__hider']);
    f.nodes[f.threadList].parent = scrollbar;
    const richList = f.add(f.replies[0].body, 'AXList', ['p-rich_text_list']);
    f.add(richList, 'AXStaticText', [], 'A bullet');
    expect(f.read().thread.replies).toHaveLength(2);
    expect(f.read().thread.replies[0].text).toContain('A bullet');
  });

  test('recovers stale row namespaces only from exact message permalink and root evidence', () => {
    const f = threadFixture();
    for (const message of [f.rootMessage, ...f.replies]) {
      f.nodes[message.item].id = f.nodes[message.item].id.replace(
        `CDEMO1-${f.rootTS}-`,
        'COLD-1699999999.000009-'
      );
    }
    const result = f.read();
    expect(result.thread.root.text).toBe('Root message');
    expect(result.thread.replies).toHaveLength(2);
    expect(result.thread.replies[0].permalink).toBe(f.nodes[f.replies[0].time].url);
    removeCapturedSubtree(f, f.rootMessage.item);
    const partial = f.read();
    expect(partial.thread.root).toBeNull();
    expect(partial.thread.observedReplyCount).toBe(2);
    expect(partial.coverage.warnings.some((warning) => warning.includes('namespace'))).toBe(false);
  });

  test('refuses stale reply namespaces with missing or conflicting permalink root proof', () => {
    const mutations = [
      (f) => {
        delete f.nodes[f.replies[0].time].url;
      },
      (f) => {
        f.nodes[f.replies[0].time].url = f.permalink('1700000001.000001');
      },
      (f) => {
        f.nodes[f.replies[0].time].url =
          `${f.permalink('1700000001.000001')}?thread_ts=1699999999.000009`;
      },
    ];
    for (const mutate of mutations) {
      const f = threadFixture();
      f.nodes[f.replies[0].item].id = 'COLD-1699999999.000009-thread-list-Thread_1700000001.000001';
      mutate(f);
      expect(f.read).toThrow();
    }
  });

  test('requires a stale root row permalink to match the observed thread header identity', () => {
    for (const replacement of [
      null,
      'https://demo.slack.com/archives/CDEMO1/p1700000099000001',
      'https://other.slack.com/archives/CDEMO1/p1700000000000001',
    ]) {
      const f = threadFixture();
      f.nodes[f.rootMessage.item].id = `COLD-1699999999.000009-thread-list-Thread_${f.rootTS}`;
      f.nodes[f.rootMessage.time].url = replacement;
      expect(f.read).toThrow();
    }
  });

  test('rejects duplicated canonical message timestamps across different row namespaces', () => {
    const f = threadFixture();
    const duplicate = f.threadMessage('1700000001.000001');
    f.nodes[duplicate.item].id = 'COLD-1699999999.000009-thread-list-Thread_1700000001.000001';
    expect(f.read).toThrow('Duplicate message identity');
  });

  test('rejects duplicate message rows, ambiguous panes and unsupported message identities', () => {
    const duplicate = threadFixture();
    duplicate.threadMessage('1700000001.000001');
    expect(duplicate.read).toThrow('Duplicate message identity');
    const ambiguous = threadFixture();
    ambiguous.add(ambiguous.root, 'AXGroup', ['p-threads_flexpane']);
    expect(ambiguous.read).toThrow('one exposed thread pane');
    const unsupported = threadFixture();
    unsupported.nodes[unsupported.replies[0].item].id = 'unknown-message-row';
    expect(unsupported.read).toThrow('unsupported identity');
  });

  test('keeps missing metadata null and preserves body links without using them as message identity', () => {
    const f = threadFixture();
    delete f.nodes[f.replies[1].time].url;
    const bodyLink = f.add(f.replies[1].section, 'AXLink', ['c-link'], 'Other thread', {
      url: 'https://other.slack.com/archives/COTHER/p1700000099000001',
    });
    f.add(bodyLink, 'AXStaticText', [], 'Other thread');
    const result = f.read();
    expect(result.thread.replies[1].author).toBeNull();
    expect(result.thread.replies[1].permalink).toBeNull();
    expect(result.thread.replies[1].links).toEqual([
      { label: 'Other thread', url: 'https://other.slack.com/archives/COTHER/p1700000099000001' },
    ]);
    expect(result.thread.rootPermalink).toBe(f.nodes[f.header].url);
  });

  test('keeps partial coverage explicit without inferring completeness from reply counts', () => {
    const partial = threadFixture({ count: 8 });
    const result = partial.read();
    expect(result.thread).toMatchObject({ displayedReplyCount: 8, observedReplyCount: 2 });
    expect(result.coverage.warnings).toContain('2 of 8 displayed thread replies are exposed');
    expect(result.coverage.complete).toBe(false);
    const unknown = threadFixture({ count: null });
    expect(unknown.read().thread.displayedReplyCount).toBeNull();
    expect(unknown.read().coverage.complete).toBe(false);
  });

  test('requires explicit zero replies and rejects contradictory or stale counts', () => {
    expect(threadFixture({ count: 0, replyCount: 0 }).read().thread.observedReplyCount).toBe(0);
    const absentRoot = threadFixture({ count: 0, replyCount: 0 });
    removeCapturedSubtree(absentRoot, absentRoot.rootMessage.item);
    expect(absentRoot.read().thread).toMatchObject({
      root: null,
      observedReplyCount: 0,
      displayedReplyCount: 0,
    });
    expect(threadFixture({ count: null, replyCount: 0 }).read).toThrow('loading or coverage');
    expect(threadFixture({ count: 2, replyCount: 0 }).read).toThrow('loading or coverage');
    expect(threadFixture({ count: 1, replyCount: 2 }).read).toThrow('More thread replies');
    const changed = threadFixture();
    changed.nodes[changed.countNode].label = '3 replies';
    expect(changed.read).toThrow('reply count changed');
  });

  test('rejects malformed or conflicting permalink identity parameters', () => {
    const queries = [
      'https://demo.slack.com/archives/CDEMO1/p1700000000000001?thread_ts=1700000000.000001&thread_ts=1700000000.000001',
      'https://demo.slack.com/archives/CDEMO1/p1700000000000001?cid=COTHER',
      'https://demo.slack.com/archives/CDEMO1/p1700000000000001?cid=CDEMO1&cid=CDEMO1',
      'https://demo.slack.com/archives/CDEMO1/p1700000000000001?thread_ts=1700000000.1',
      'https://user@demo.slack.com/archives/CDEMO1/p1700000000000001',
      'https://demo.slack.com:444/archives/CDEMO1/p1700000000000001',
      'https://demo.slack.com.evil.test/archives/CDEMO1/p1700000000000001',
    ];
    for (const query of queries) {
      const f = threadFixture();
      f.receipt.target.requestedURL = query;
      expect(f.read).toThrow();
    }
  });

  test('rejects changed view or reopened picker and strips diagnostics from compact output', () => {
    const f = threadFixture();
    const compact = compactOutput(f.receipt, 'read-thread', f.receipt.target.requestedURL);
    expect(compact.thread.replies).toHaveLength(2);
    expect(compact.before).toBeUndefined();
    expect(compact.desktop).toBeUndefined();
    expect(compact.view).toEqual(f.receipt.after);
    expect(compact.navigation).toEqual([
      { command: 'read-thread', args: [`CDEMO1:${f.rootTS}`] },
      { command: 'read-channel', args: ['project-help'] },
    ]);
    f.receipt.after.url = 'https://app.slack.com/client/TOTHER/search';
    expect(f.read).toThrow('Conversation changed');
    f.receipt.after.url = f.nodes[f.root].url;
    f.add(f.root, 'AXComboBox', [], 'Query');
    expect(f.read).toThrow('Search overlay');
  });

  test('does not invent channel or DM navigation from unsupported thread labels', () => {
    const f = threadFixture();
    f.nodes[f.threadList].label = 'Thread in Alex Example (direct message, 2 replies)';
    f.nodes[f.header].label = 'Alex Example';
    expect(f.read().navigation).toEqual([{ command: 'read-thread', args: [`CDEMO1:${f.rootTS}`] }]);
    f.nodes[f.threadList].label = 'Thread in custom name (2 replies)';
    expect(f.read().navigation).toHaveLength(1);
    f.nodes[f.threadList].label = 'Thread in invalid name (channel, 2 replies)';
    f.nodes[f.header].label = 'invalid name';
    expect(f.read().navigation).toHaveLength(1);
  });
});

describe('structured Slack messages', () => {
  test('infers consecutive compact senders from one observed header and retains its source', () => {
    const f = fixture('dm');
    const observed = f.message('1700000000.000001');
    markGrouped(f, f.message('1700000000.000002', { compact: true }));
    markGrouped(f, f.message('1700000000.000003', { compact: true }));
    const next = f.message('1700000000.000004');
    f.nodes.find(
      (node) => node.parent === next.body && node.classes.includes('c-message__sender_button')
    ).label = 'Taylor Example';
    markGrouped(f, f.message('1700000000.000005', { compact: true }));
    const result = structuredOutput(f.receipt, 'read-dm', '@alex.example');
    expect(result.messages.map((message) => message.author)).toEqual([
      'Sam Example',
      'Sam Example',
      'Sam Example',
      'Taylor Example',
      'Taylor Example',
    ]);
    expect(result.messages[0]).not.toHaveProperty('authorInferred');
    expect(result.messages[0]).not.toHaveProperty('authorSourceMessageId');
    expect(result.messages[1]).toMatchObject({
      authorInferred: true,
      authorSourceMessageId: f.nodes[observed.item].id,
    });
    expect(result.messages[2]).toMatchObject({
      authorInferred: true,
      authorSourceMessageId: f.nodes[observed.item].id,
    });
    expect(result.messages[4]).toMatchObject({
      authorInferred: true,
      authorSourceMessageId: f.nodes[next.item].id,
    });
  });

  test('does not infer a first viewport row or carry a sender across separate captures', () => {
    const seeded = fixture('dm');
    seeded.message('1700000000.000001');
    structuredOutput(seeded.receipt, 'read-dm', '@alex.example');
    const f = fixture('dm');
    markGrouped(f, f.message('1700000000.000002', { compact: true, aggregate: 'Sam Example' }));
    const result = structuredOutput(f.receipt, 'read-dm', '@alex.example');
    expect(result.messages[0].author).toBeNull();
    expect(result.messages[0]).not.toHaveProperty('authorInferred');
  });

  test('requires both compact grouping markers and clears continuity on an unproven sender row', () => {
    for (const missing of ['above', 'adjacent', 'both']) {
      const f = fixture();
      f.message('1700000000.000001');
      const gap = markGrouped(f, f.message('1700000000.000002', { compact: true }));
      if (missing !== 'adjacent')
        f.nodes[gap.body].classes = f.nodes[gap.body].classes.filter(
          (name) => name !== 'c-message_kit__actions--above'
        );
      if (missing !== 'above') {
        const node = f.nodes[f.nodes[gap.time].parent];
        node.classes = node.classes.filter(
          (name) => name !== 'p-message_pane_message__compact_timestamp--adjacent'
        );
      }
      markGrouped(f, f.message('1700000000.000003', { compact: true }));
      const result = structuredOutput(f.receipt, 'read-channel', f.name);
      expect(result.messages.slice(1).map((message) => message.author)).toEqual([null, null]);
    }
  });

  test('day dividers and unknown list rows reset compact sender continuity', () => {
    for (const boundary of ['day', 'unknown', 'unrecognized-message']) {
      const f = fixture();
      f.message('1700000000.000001');
      const item = f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
        id: 'message-list_boundary',
      });
      if (boundary === 'day') f.add(item, 'AXGroup', ['c-message_list__day_divider__label']);
      if (boundary === 'unrecognized-message') f.add(item, 'AXGroup', ['c-message_kit__hover']);
      markGrouped(f, f.message('1700000000.000002', { compact: true }));
      expect(structuredOutput(f.receipt, 'read-channel', f.name).messages[1].author).toBeNull();
    }
  });

  test('nonincreasing message timestamps cannot supply sender continuity', () => {
    const f = fixture();
    f.message('1700000000.000003');
    markGrouped(f, f.message('1700000000.000002', { compact: true }));
    markGrouped(f, f.message('1700000000.000004', { compact: true }));
    expect(
      structuredOutput(f.receipt, 'read-channel', f.name).messages.map((message) => message.author)
    ).toEqual(['Sam Example', null, null]);
  });

  test('infers grouped thread reply senders from the preceding reply in the same capture', () => {
    for (const mark of [markGrouped, markThreadGrouped]) {
      const f = threadFixture();
      mark(f, f.replies[1]);
      const result = f.read();
      const source = result.thread.replies[0];
      expect(source.author).not.toBeNull();
      expect(result.thread.replies[1]).toMatchObject({
        author: source.author,
        authorInferred: true,
        authorSourceMessageId: source.id,
      });
    }
  });

  test('a thread gutter without its adjacent modifier does not supply continuity', () => {
    const f = threadFixture();
    markThreadGrouped(f, f.replies[1]);
    const gutter = f.nodes[f.nodes[f.replies[1].time].parent];
    gutter.classes = gutter.classes.filter((name) => !name.endsWith('--adjacent'));
    expect(f.read().thread.replies[1].author).toBeNull();
  });

  test('a grouped first thread reply stays unknown after the reply separator', () => {
    const f = threadFixture();
    for (const node of f.nodes)
      if (node.parent === f.replies[0].body)
        node.classes = node.classes.filter((name) => name !== 'c-message__sender_button');
    markGrouped(f, f.replies[0]);
    const result = f.read();
    expect(result.thread.replies[0].author).toBeNull();
    expect(result.thread.replies[0]).not.toHaveProperty('authorInferred');
  });

  test('spaces adjacent emoji images while preserving their observed labels', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    for (const label of ['eye emoji', 'nose emoji', 'eye emoji'])
      f.add(section, 'AXImage', ['c-emoji', 'c-emoji__large'], label);
    expect(structuredOutput(f.receipt, 'read-channel', f.name).messages[0].text).toBe(
      'eye emoji nose emoji eye emoji'
    );
  });

  test('emoji boundaries survive nested links and styles without flattening paragraphs or changing URLs', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Say');
    const link = f.add(section, 'AXLink', [], 'party parrot emoji', {
      url: 'https://example.com/emoji?q=eye%20emoji',
    });
    const styled = f.add(link, 'AXGroup', ['c-mrkdwn__bold']);
    f.add(styled, 'AXImage', ['c-emoji'], 'party parrot emoji');
    f.add(section, 'AXStaticText', [], '!');
    const paragraph = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(paragraph, 'AXStaticText', [], 'Ordinary prose ending in emoji');
    const result = structuredOutput(f.receipt, 'read-channel', f.name).messages[0];
    expect(result.text).toBe('Say party parrot emoji!\nOrdinary prose ending in emoji');
    expect(result.links).toEqual([
      { label: 'party parrot emoji', url: 'https://example.com/emoji?q=eye%20emoji' },
    ]);
  });

  test('emoji spacing preserves existing whitespace and code/pre contents', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Hello  ');
    f.add(section, 'AXImage', ['c-emoji'], 'custom label emoji');
    f.add(section, 'AXStaticText', [], '  again');
    const code = f.add(body, 'AXGroup', ['c-mrkdwn__pre']);
    f.add(code, 'AXStaticText', [], '  left');
    f.add(code, 'AXImage', ['c-emoji'], 'wave emoji');
    f.add(code, 'AXStaticText', [], 'right  ');
    f.add(body, 'AXStaticText', [], 'done');
    expect(structuredOutput(f.receipt, 'read-channel', f.name).messages[0].text).toBe(
      'Hello  custom label emoji  again\n  leftwave emojiright  \ndone'
    );
  });

  test('ordinary text, unrelated images and reaction emoji never enter emoji normalization', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Leave this eye emoji');
    f.add(section, 'AXImage', [], 'unrelated emoji');
    const reactions = f.add(body, 'AXGroup', ['c-message_kit__reaction_bar']);
    const reaction = f.add(reactions, 'AXCheckBox', ['c-reaction']);
    f.add(reaction, 'AXImage', ['c-emoji'], 'scream emoji');
    expect(structuredOutput(f.receipt, 'read-channel', f.name).messages[0].text).toBe(
      'Leave this eye emoji'
    );
  });

  test('keeps child-order rich text and excludes duplicated labels, composer, replies and reactions', () => {
    const f = fixture();
    const { body } = f.message('100.000001', {
      aggregate: 'Aggregate label must not repeat the body',
    });
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Read ');
    const link = f.add(section, 'AXLink', ['c-link'], 'docs', { url: 'https://example.com/docs' });
    const nested = f.add(link);
    f.add(nested, 'AXStaticText', [], 'docs');
    f.add(section, 'AXStaticText', [], ' now.');
    f.add(body, 'AXButton', ['c-message__reply_count'], '3 replies');
    const reply = f.add(body, 'AXGroup', ['c-message__reply_bar_description']);
    f.add(reply, 'AXStaticText', [], 'Last reply 2 hours ago');
    const reactions = f.add(body, 'AXGroup', ['c-message_kit__reaction_bar']);
    f.add(reactions, 'AXCheckBox', [], 'thumbsup reaction');
    const composer = f.add(f.root, 'AXGroup', ['p-message_input_unstyled']);
    f.add(composer, 'AXTextArea', [], 'Private unsent draft');
    const result = structuredOutput(f.receipt, 'read-channel', f.name);
    expect(result.messages[0].text).toBe('Read docs now.');
    expect(result.messages[0].links).toEqual([{ label: 'docs', url: 'https://example.com/docs' }]);
    expect(result.messages[0].thread).toEqual({
      displayedSummary: '3 replies',
      replyCount: 3,
      repliesRead: false,
      ref: null,
      navigation: null,
    });
    expect(JSON.stringify(result)).not.toContain('Private unsent draft');
    expect(JSON.stringify(result)).not.toContain('Aggregate label');
    expect(result.before).toEqual({
      title: 'Previous view',
      url: 'https://app.slack.com/client/TDEMO/search',
    });
    expect(result.coverage.complete).toBe(false);
    expect(result.messages[0].textComplete).toBe(false);
  });

  test('retains direct body text, code blocks, displayed dates, and repeated messages with different IDs', () => {
    const f = fixture();
    const divider = f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
      id: 'message-list_day',
    });
    const date = f.add(divider, 'AXGroup', ['c-message_list__day_divider__label']);
    f.add(date, 'AXPopUpButton', ['c-message_list__day_divider__label__pill'], 'Yesterday');
    for (const timestamp of ['100.000001', '100.000002']) {
      const { body } = f.message(timestamp);
      f.add(body, 'AXStaticText', [], 'Run this:\n');
      const code = f.add(body, 'AXGroup', ['c-mrkdwn__pre']);
      f.add(code, 'AXStaticText', [], 'example --flag');
      f.add(code, 'AXButton', [], 'Copy');
    }
    const result = structuredOutput(f.receipt, 'read-channel', f.name);
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message) => message.text)).toEqual([
      'Run this:\nexample --flag',
      'Run this:\nexample --flag',
    ]);
    expect(result.messages[0].displayedDay).toBe('Yesterday');
    expect(result.messages[0].displayedTime).toBe('Yesterday at 10:00 AM');
    expect(result.messages[0].permalink).toBe('https://demo.slack.com/archives/CDEMO1/p100000001');
  });

  test('offers stable compact thread refs only when observed links and thread evidence support them', () => {
    const f = fixture();
    const known = f.message('1700000000.000001');
    f.add(known.body, 'AXButton', ['c-message__reply_count'], '3 replies');
    const zero = f.message('1700000001.000001');
    f.add(zero.body, 'AXButton', ['c-message__reply_count'], '0 replies');
    f.message('1700000002.000001');
    const noLink = f.message('1700000003.000001');
    f.add(noLink.body, 'AXButton', ['c-message__reply_count'], '2 replies');
    delete f.nodes[noLink.time].url;
    const reply = f.message('1700000004.000001');
    f.nodes[reply.time].url += '?thread_ts=1700000000.000001&cid=CDEMO1';
    const sameRootWithoutCount = f.message('1700000005.000001');
    f.nodes[sameRootWithoutCount.time].url += '?thread_ts=1700000005.000001';
    const result = structuredOutput(f.receipt, 'read-channel', f.name);
    expect(result.messages.map((message) => message.thread.ref)).toEqual([
      'CDEMO1:1700000000.000001',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(result.messages.map((message) => message.thread.navigation)).toEqual([
      { command: 'read-thread', args: ['CDEMO1:1700000000.000001'] },
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test('does not merge a thread pane into the main history', () => {
    const f = fixture();
    f.add(f.message('100.000001').body, 'AXStaticText', [], 'Main message');
    const thread = f.add(f.primary, 'AXGroup', ['p-threads_flexpane']);
    const threadPane = f.add(thread, 'AXGroup', ['p-message_pane']);
    const threadList = f.add(
      threadPane,
      'AXList',
      ['sr-only'],
      `${f.name} (channel, 1 unread message)`
    );
    f.add(
      f.message('100.000002', { list: threadList }).body,
      'AXStaticText',
      [],
      'Thread reply must remain separate'
    );
    const result = structuredOutput(f.receipt, 'read-channel', f.name);
    expect(result.messages.map((message) => message.text)).toEqual(['Main message']);
    expect(result.coverage.threadRepliesIncluded).toBe(false);
  });

  test('reads only a verified individual DM and preserves absent compact author metadata', () => {
    const f = fixture('dm');
    const { body } = f.message('100.000001', { compact: true });
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'A compact message');
    const result = structuredOutput(f.receipt, 'read-dm', '@alex.example');
    expect(result.conversation).toMatchObject({
      kind: 'dm',
      name: 'Alex Example',
      handle: '@alex.example',
    });
    expect(result.messages[0].author).toBeNull();
    expect(result.messages[0].text).toBe('A compact message');
    expect(result.messages[0].thread.replyCount).toBeNull();
    expect(result.requested).toBe('@alex.example');
    f.receipt.target.kind = 'channel';
    expect(() => structuredOutput(f.receipt, 'read-dm', '@alex.example')).toThrow(
      'Verified native conversation metadata'
    );
  });

  test('retains observed attachment links without reading their contents', () => {
    const f = fixture('dm');
    const { body } = f.message('100.000001');
    const attachment = f.add(body, 'AXGroup', ['p-message_gallery_image_file']);
    const link = f.add(attachment, 'AXLink', [], 'diagram.png', {
      url: 'https://files.slack.com/files-pri/TDEMO-FDEMO/diagram.png',
    });
    f.add(link, 'AXImage', [], 'Attachment thumbnail', {
      url: 'https://files.slack.com/files-tmb/TDEMO-FDEMO/thumb.png',
    });
    const result = structuredOutput(f.receipt, 'read-dm', '@alex.example');
    expect(result.messages[0].text).toBeNull();
    expect(result.messages[0].attachments).toMatchObject([
      {
        label: 'diagram.png',
        url: 'https://files.slack.com/files-pri/TDEMO-FDEMO/diagram.png',
        contentRead: false,
      },
    ]);
  });

  test('fails on mismatched destination evidence or absent list instead of reporting an empty conversation', () => {
    const f = fixture();
    f.receipt.after.url = 'https://app.slack.com/client/TDEMO/COTHER';
    expect(() => structuredOutput(f.receipt, 'read-channel', f.name)).toThrow(
      'Conversation changed'
    );
    f.receipt.after.url = f.nodes[f.root].url;
    f.nodes[f.list].label = 'Another channel (channel)';
    expect(() => structuredOutput(f.receipt, 'read-channel', f.name)).toThrow(
      'message list matching'
    );
  });

  test('rejects cross-conversation message permalinks and duplicate message identities', () => {
    const f = fixture();
    f.message('100.000001', { conversationId: 'COTHER' });
    expect(() => structuredOutput(f.receipt, 'read-channel', f.name)).toThrow(
      'different conversation'
    );
    const duplicate = fixture();
    duplicate.message('100.000001');
    duplicate.message('100.000001');
    expect(() => structuredOutput(duplicate.receipt, 'read-channel', duplicate.name)).toThrow(
      'Duplicate message identity'
    );
  });
});

describe('rich media integration in verified message scopes', () => {
  function image(f, body, id = 'FIMAGE1') {
    const media = f.add(body, 'AXGroup', ['p-message_gallery_image_file']);
    const link = f.add(media, 'AXLink', ['p-file_image_thumbnail__wrapper'], 'diagram.png', {
      url: `https://files.slack.com/files-pri/TDEMO-${id}/diagram.png`,
    });
    f.add(
      link,
      'AXImage',
      ['p-file_image_thumbnail__image'],
      'A diagram of three connected boxes',
      {
        url: `https://files.slack.com/files-tmb/TDEMO-${id}/diagram_400.png`,
      }
    );
    return media;
  }

  test.each(['private channel', 'shared channel'])(
    '%s labels corroborate marked titles for semantic inspect and channel reads',
    (listKind) => {
      const f = fixture();
      const row = f.message('1700000000.000001');
      image(f, row.body);
      f.nodes[f.list].label = `${f.name} (${listKind}, 1 unread message)`;
      f.nodes[f.root].label = `* ${f.nodes[f.root].label}`;
      f.receipt.after.title = f.nodes[f.root].label;
      const result = compactOutput(f.receipt, 'read-channel', f.name);
      expect(result.messages[0].attachments[0]).toMatchObject({
        kind: 'image',
        ref: 'FIMAGE1',
        fileId: 'FIMAGE1',
        contentRead: false,
        thumbnailUrl: 'https://files.slack.com/files-tmb/TDEMO-FIMAGE1/diagram_400.png',
      });
      const inspected = structuredClone(f.receipt);
      delete inspected.target;
      inspected.after = {
        nodes: [{ role: 'AXWebArea', label: f.nodes[f.root].label, url: f.nodes[f.root].url }],
      };
      expect(compactOutput(inspected, 'inspect').messages[0].attachments).toEqual(
        result.messages[0].attachments
      );
      for (const label of [
        `${f.name} (${listKind} extra)`,
        `other (${listKind})`,
        `${f.name} (direct message)`,
      ]) {
        f.nodes[f.list].label = label;
        expect(() => compactOutput(f.receipt, 'read-channel', f.name)).toThrow();
      }
    }
  );

  test('quoted content and its media preserve source attribution instead of adopting the outer sender', () => {
    const f = fixture('dm');
    const { body } = f.message('1700000000.000001');
    f.add(body, 'AXStaticText', [], 'Sharing this reference.');
    const card = f.add(body, 'AXGroup', [
      'c-message_attachment',
      'c-message_attachment--full_card',
    ]);
    f.add(card, 'AXButton', ['c-message_attachment__author_name'], 'Casey Example');
    const section = f.add(card, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Here is the architecture.');
    const quotedLink = f.add(section, 'AXLink', [], 'Design notes', {
      url: 'https://example.com/design',
    });
    f.add(quotedLink, 'AXStaticText', [], 'Design notes');
    image(f, card);
    const message = compactOutput(f.receipt, 'read-dm', '@alex.example').messages[0];
    expect(message.author).toBe('Sam Example');
    expect(message.text).toBe('Sharing this reference.');
    expect(message.links).toEqual([]);
    expect(message.quotedMessages).toMatchObject([
      {
        author: 'Casey Example',
        permalink: null,
        text: 'Here is the architecture.Design notes',
        links: [{ label: 'Design notes', url: 'https://example.com/design' }],
        textComplete: false,
      },
    ]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].provenance).toMatchObject({
      kind: 'quoted',
      author: 'Casey Example',
      permalink: null,
    });
  });

  test('media on thread root and replies remain separate from surrounding channel history', () => {
    const f = threadFixture();
    image(f, f.rootMessage.body, 'FROOT1');
    image(f, f.replies[0].body, 'FREPLY1');
    const outside = f.message('1700000099.000001');
    image(f, outside.body, 'FOUTSIDE1');
    const result = f.read();
    expect(result.thread.root.attachments[0].ref).toBe('FROOT1');
    expect(result.thread.replies[0].attachments[0].ref).toBe('FREPLY1');
    expect(JSON.stringify(result.thread)).not.toContain('FOUTSIDE1');
  });

  test('quoted message wrappers retain source links without borrowing links from the quoted body', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    f.add(body, 'AXStaticText', [], 'Outer message');
    const card = f.add(body, 'AXGroup', ['c-message_attachment']);
    f.add(card, 'AXButton', ['c-message_attachment__author_name'], 'Casey Example');
    const sourceURL = 'https://demo.slack.com/archives/CSOURCE/p1700000020000001';
    f.add(card, 'AXLink', ['c-timestamp'], 'Source timestamp', { url: sourceURL });
    const nested = f.add(card, 'AXGroup', ['c-message_kit__actions']);
    f.add(nested, 'AXButton', ['c-message__sender_button'], 'Casey Example');
    f.add(nested, 'AXLink', ['c-timestamp'], 'Nested timestamp', { url: sourceURL });
    const section = f.add(nested, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Quoted body');
    const citation = 'https://demo.slack.com/archives/COTHER/p1700000030000001';
    f.add(section, 'AXLink', [], 'Related message', { url: citation });
    image(f, nested, 'FQUOTED1');
    const read = () => compactOutput(f.receipt, 'read-channel', f.name).messages[0];
    const message = read();
    expect(message.text).toBe('Outer message');
    expect(message.author).toBe('Sam Example');
    expect(message.quotedMessages).toMatchObject([
      {
        author: 'Casey Example',
        permalink: sourceURL,
        text: 'Quoted bodyRelated message',
        links: [{ label: 'Related message', url: citation }],
      },
    ]);
    expect(message.attachments[0]).toMatchObject({
      ref: 'FQUOTED1',
      provenance: { author: 'Casey Example', permalink: sourceURL },
    });
    f.nodes.find((node) => node.label === 'Source timestamp').url = '';
    expect(read().quotedMessages[0].permalink).toBeNull();
  });

  test('unattributed nested message wrappers cannot leak into a conversation read', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const unrelated = f.add(body, 'AXGroup', ['c-message_kit__actions']);
    f.add(unrelated, 'AXStaticText', [], 'Unrelated nested message');
    image(f, unrelated, 'FUNRELATED1');
    expect(() => compactOutput(f.receipt, 'read-channel', f.name)).toThrow(
      'Nested message content lacks verified quoted attribution'
    );
  });

  test('inline emoji wrappers remain readable alongside media while reactions stay excluded', () => {
    const f = fixture();
    const { body } = f.message('1700000000.000001');
    const section = f.add(body, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Look');
    const emoji = f.add(section, 'AXGroup', ['c-emoji']);
    f.add(emoji, 'AXImage', [], 'eyes emoji');
    f.add(section, 'AXStaticText', [], 'here');
    image(f, body);
    const reaction = f.add(body, 'AXGroup', ['c-message_kit__reaction_bar']);
    f.add(reaction, 'AXImage', ['c-emoji'], 'reaction emoji');
    const message = compactOutput(f.receipt, 'read-channel', f.name).messages[0];
    expect(message.text).toBe('Look eyes emoji here');
    expect(message.attachments).toHaveLength(1);
  });
});

describe('compact output for every command', () => {
  test('keeps structured data without raw trees, before snapshots or desktop diagnostics', () => {
    const f = fixture('dm');
    f.add(f.message('100.000001').body, 'AXStaticText', [], 'A useful message');
    const result = compactOutput(f.receipt, 'read-dm', '@alex.example');
    expect(result.messages[0].text).toBe('A useful message');
    expect(result.view.url).toBe(f.receipt.after.url);
    expect(result).not.toHaveProperty('desktop');
    expect(result).not.toHaveProperty('before');
    expect(result).not.toHaveProperty('content');
  });

  test('summarizes inspection of a Query overlay without leaking its underlying composer', () => {
    const f = fixture();
    f.add(f.root, 'AXComboBox', [], 'Query', { AXValue: 'Alex' });
    const option = f.add(f.root, 'AXStaticText', [], 'Alex Example, Direct Message', {
      id: 'c-search_autocomplete__suggestion_0',
    });
    f.add(option, 'AXStaticText', [], '@alex.example');
    f.add(f.root, 'AXTextArea', [], 'Secret unsent draft');
    f.receipt.after = {
      nodes: [{ role: 'AXWebArea', label: f.nodes[0].label, url: f.nodes[0].url }],
    };
    const result = compactOutput(f.receipt, 'inspect');
    expect(result.query).toEqual({
      value: 'Alex',
      suggestions: [{ label: 'Alex Example, Direct Message', handle: '@alex.example' }],
    });
    expect(JSON.stringify(result)).not.toContain('Secret unsent');
    expect(result).not.toHaveProperty('messages');
    expect(() => compactOutput(f.receipt, 'search', 'expected')).toThrow('Search overlay reopened');
    expect(() => compactOutput(f.receipt, 'channel', 'project-help')).toThrow(
      'Search overlay reopened'
    );
  });

  test('extracts search snippets, source metadata and observed pagination without copying controls', () => {
    const f = fixture();
    f.nodes[0].label = 'Search - Test Workspace - Slack';
    f.nodes[0].url = 'https://app.slack.com/client/TDEMO/search';
    f.nodes[f.list].label = 'Message results, page 1 of 2';
    f.add(f.root, 'AXButton', [], 'Search: example');
    f.add(f.root, 'AXStaticText', [], '24 results');
    const item = f.add(f.list, 'AXGroup', [], '', { id: 'search-result-1' });
    const actions = f.add(item, 'AXGroup', ['c-message_kit__actions']);
    const header = f.add(actions, 'AXGroup', ['c-search_message__content_header']);
    f.add(header, 'AXButton', ['c-message__sender_button'], 'Sam Example');
    f.add(header, 'AXStaticText', [], 'project-help');
    f.add(header, 'AXLink', ['c-timestamp'], 'Yesterday', {
      url: 'https://demo.slack.com/archives/COTHER/p1700000001000001?thread_ts=1700000000.000001',
    });
    const section = f.add(actions, 'AXGroup', ['p-rich_text_section']);
    f.add(section, 'AXStaticText', [], 'Start');
    f.add(section, 'AXButton', ['c-search__expand'], '...');
    f.add(section, 'AXStaticText', [], 'end');
    f.receipt.after = {
      nodes: [{ role: 'AXWebArea', label: f.nodes[0].label, url: f.nodes[0].url }],
    };
    const result = compactOutput(f.receipt, 'search', 'example');
    expect(result.search).toEqual({ query: 'example', totalResults: 24, page: 1, pageCount: 2 });
    expect(result.messages[0]).toMatchObject({
      author: 'Sam Example',
      channel: 'project-help',
      text: 'Start … end',
      snippet: true,
      textComplete: false,
    });
    // A reply permalink alone does not expose a usable thread-opening control.
    expect(result.messages[0].thread).toMatchObject({ ref: null, navigation: null });
    const replyControl = f.add(actions, 'AXStaticText', ['c-message__reply_count'], '3 replies');
    expect(compactOutput(f.receipt, 'search', 'example').messages[0].thread.navigation).toBeNull();
    f.nodes[replyControl].role = 'AXButton';
    expect(compactOutput(f.receipt, 'search', 'example').messages[0].thread.navigation).toEqual({
      command: 'read-thread',
      args: ['COTHER:1700000001.000001'],
    });
    expect(result.pagination).toEqual({ supported: false, hasMore: true, nextCursor: null });
    expect(() => compactOutput(f.receipt, 'search', 'changed')).toThrow('Search query changed');
    f.receipt.after.nodes[0].url += '/changed';
    expect(() => compactOutput(f.receipt, 'inspect')).toThrow('View changed');
  });

  test('keeps permission instructions and errors available in compact form', () => {
    const denied = compactOutput(
      {
        status: 'permission-required',
        accessibilityTrusted: false,
        executable: '/helper',
        next: 'Enable access.',
      },
      'channels'
    );
    expect(denied).toMatchObject({
      status: 'permission-required',
      executable: '/helper',
      next: 'Enable access.',
    });
    expect(
      compactOutput(
        { status: 'stopped', error: 'Ambiguous DM', desktopSamples: [1], next: 'Inspect.' },
        'read-dm'
      )
    ).toEqual({ status: 'stopped', operation: 'read-dm', error: 'Ambiguous DM', next: 'Inspect.' });
    expect(
      compactOutput(
        {
          status: 'ready',
          accessibilityTrusted: true,
          postEventAccess: false,
          next: 'Run the requested Slack command.',
        },
        'permissions'
      )
    ).toMatchObject({
      status: 'inspection-only',
      next: expect.stringContaining('keyboard navigation is not'),
    });
  });

  test('permission scope survives missing trust and ready receipts without inferring an execution mode', () => {
    for (const trusted of [false, true]) {
      const receipt = {
        operation: 'permissions',
        status: trusted ? 'ready' : 'permission-required',
        permissionScope: 'current-execution-context',
        accessibilityTrusted: trusted,
        postEventAccess: trusted,
        accessibilityProbe: {
          status: trusted ? 'accessible' : 'not-checked',
          checkedAttributes: trusted ? ['AXRole', 'AXChildren'] : [],
        },
        promptRequested: false,
        settingsOpenRequested: false,
      };
      const result = compactOutput(receipt, 'permissions');
      expect(result).toMatchObject(receipt);
      expect(result).not.toHaveProperty('sandboxed');
      expect(result).not.toHaveProperty('executionContext');
      const { permissionScope, ...legacy } = receipt;
      expect(compactOutput(legacy, 'permissions')).not.toHaveProperty('permissionScope');
    }
  });

  test('keyboard-only fallback checks approved execution before suggesting settings', () => {
    const result = compactOutput(
      {
        status: 'ready',
        accessibilityTrusted: true,
        postEventAccess: false,
        accessibilityProbe: { status: 'accessible', checkedAttributes: ['AXRole', 'AXChildren'] },
      },
      'permissions'
    );
    expect(result.status).toBe('inspection-only');
    expect(result.next).toContain('approved execution context');
    expect(result.next.indexOf('approved execution context')).toBeLessThan(
      result.next.indexOf('System Settings')
    );
    expect(result.next).toContain('only if');
    expect(result.next).toContain('denied');
    expect(result.next).toContain('Do not replay');
  });

  test('failed AX probes outrank trusted permission flags and keyboard-only advice', () => {
    for (const postEventAccess of [true, false]) {
      for (const status of ['permission-required', 'ready', 'inspection-only']) {
        const accessibilityProbe = {
          status: 'api-disabled',
          checkedAttributes: ['AXRole'],
          pid: 123,
          error: { code: -25211, name: 'apiDisabled', operation: 'AXRole' },
        };
        const result = compactOutput(
          {
            status,
            accessibilityTrusted: true,
            postEventAccess,
            accessibilityProbe,
            error: 'Slack AX API is disabled.',
            next: 'Check Accessibility access for this host.',
          },
          'permissions'
        );
        expect(result).toMatchObject({
          status: 'permission-required',
          accessibilityProbe,
          error: 'Slack AX API is disabled.',
          next: 'Check Accessibility access for this host.',
        });
        expect(result.next).not.toContain('Inspection is available');
      }
    }
  });

  test('unavailable Slack access is not relabeled as a permission grant or keyboard-only issue', () => {
    for (const probeStatus of ['unavailable', 'not-running', 'ambiguous', 'not-checked']) {
      const accessibilityProbe = { status: probeStatus, checkedAttributes: [] };
      const result = compactOutput(
        {
          status: 'unavailable',
          accessibilityTrusted: true,
          postEventAccess: false,
          accessibilityProbe,
          error: 'Slack access could not be checked.',
          next: 'Inspect the current Slack process before retrying.',
        },
        'permissions'
      );
      expect(result).toMatchObject({
        status: 'unavailable',
        accessibilityProbe,
        error: 'Slack access could not be checked.',
        next: 'Inspect the current Slack process before retrying.',
      });
    }
    expect(
      compactOutput(
        {
          status: 'ready',
          accessibilityTrusted: true,
          postEventAccess: true,
          accessibilityProbe: { status: 'not-running', checkedAttributes: [] },
        },
        'permissions'
      ).status
    ).toBe('unavailable');
  });

  test('accessible AX evidence supports ready and inspection-only permission output', () => {
    const accessibilityProbe = {
      status: 'accessible',
      checkedAttributes: ['AXRole', 'AXChildren'],
      childCount: 0,
    };
    const receipt = {
      status: 'ready',
      accessibilityTrusted: true,
      postEventAccess: true,
      accessibilityProbe,
      next: 'Run the requested command.',
    };
    expect(compactOutput(receipt, 'permissions')).toMatchObject({
      status: 'ready',
      accessibilityProbe,
    });
    expect(compactOutput({ ...receipt, postEventAccess: false }, 'permissions')).toMatchObject({
      status: 'inspection-only',
      accessibilityProbe,
      next: expect.stringContaining('keyboard navigation is not'),
    });
    expect(
      compactOutput(
        {
          ...receipt,
          status: 'inspection-only',
          postEventAccess: false,
          next: 'Native inspection-only remedy.',
        },
        'permissions'
      )
    ).toMatchObject({
      status: 'inspection-only',
      next: 'Native inspection-only remedy.',
      accessibilityProbe,
    });
  });

  test('ordinary command errors retain the AX probe and access classification', () => {
    const accessibilityProbe = {
      status: 'api-disabled',
      checkedAttributes: ['AXRole'],
      error: { code: -25211, name: 'apiDisabled', operation: 'AXRole' },
    };
    const result = compactOutput(
      {
        status: 'stopped',
        accessStatus: 'permission-required',
        accessibilityProbe,
        error: 'AX access is disabled.',
        next: 'Run permissions --request.',
        desktopSamples: [1],
      },
      'channels'
    );
    expect(result).toEqual({
      operation: 'channels',
      status: 'stopped',
      accessStatus: 'permission-required',
      accessibilityProbe,
      error: 'AX access is disabled.',
      next: 'Run permissions --request.',
    });
  });

  test('retains actionable ambiguity and not-found candidates without raw diagnostics', () => {
    for (const status of ['ambiguous', 'not-found', 'stopped']) {
      const candidates = [
        {
          name: 'Alex Example',
          handle: '@alex.example',
          navigation: { command: 'read-dm', args: ['@alex.example'] },
        },
        { name: 'Alex Other', handle: null, navigation: null },
      ];
      expect(
        compactOutput(
          {
            status,
            query: 'Alex',
            candidates,
            candidateCount: 23,
            candidatesTruncated: true,
            error: 'Choose an exact handle',
            next: 'Run a listed read-dm command',
            desktopSamples: [1],
            nodes: ['private'],
          },
          'read-dm',
          'Alex'
        )
      ).toEqual({
        status,
        operation: 'read-dm',
        query: 'Alex',
        candidates,
        candidateCount: 23,
        candidatesTruncated: true,
        error: 'Choose an exact handle',
        next: 'Run a listed read-dm command',
      });
    }
  });

  test('rejects a search receipt whose final view has become a conversation', () => {
    const f = fixture();
    f.receipt.after = {
      nodes: [{ role: 'AXWebArea', label: f.nodes[0].label, url: f.nodes[0].url }],
    };
    expect(() => compactOutput(f.receipt, 'search', 'expected')).toThrow('Search view changed');
  });

  test('reports empty search only when the dedicated empty-state structure is present', () => {
    const f = fixture();
    f.nodes[0].label = 'Search - Test Workspace - Slack';
    f.nodes[0].url = 'https://app.slack.com/client/TDEMO/search';
    f.nodes[f.list].role = 'AXGroup';
    f.nodes[f.list].label = '';
    f.add(f.root, 'AXButton', [], 'Search: no-match');
    f.receipt.after = {
      nodes: [{ role: 'AXWebArea', label: f.nodes[0].label, url: f.nodes[0].url }],
    };
    expect(() => compactOutput(f.receipt, 'search', 'no-match')).toThrow(
      'Search results are not exposed'
    );
    const empty = f.add(f.root, 'AXGroup', ['c-empty_state']);
    f.add(empty, 'AXStaticText', [], 'Nothing turned up');
    f.add(
      empty,
      'AXStaticText',
      [],
      'You may want to try using different keywords, checking for typos, or adjusting filters.'
    );
    const result = compactOutput(f.receipt, 'search', 'no-match');
    expect(result.search.totalResults).toBe(0);
    expect(result.messages).toEqual([]);
  });

  test('recognizes the observed empty-search guidance without an Oxford comma', () => {
    const f = emptySearchFixture(
      'You may want to try using different keywords, checking for typos or adjusting filters.'
    );
    const result = compactOutput(f.receipt, 'search', 'no-match');
    expect(result.search.totalResults).toBe(0);
    expect(result.messages).toEqual([]);
  });

  test('empty-search guidance accepts only the two exact observed strings', () => {
    const known = [
      'You may want to try using different keywords, checking for typos, or adjusting filters.',
      'You may want to try using different keywords, checking for typos or adjusting filters.',
    ];
    for (const guidance of known) {
      const f = emptySearchFixture(guidance);
      expect(compactOutput(f.receipt, 'search', 'no-match').search.totalResults).toBe(0);
    }
    for (const guidance of [
      'You may want to try using different keywords checking for typos or adjusting filters.',
      'You may want to try using different keywords; checking for typos or adjusting filters.',
      'You may want to try using different keywords, checking for typos or adjusting filters',
      'You may want to try using different keywords, checking for typos or adjusting filters!',
      'You may want to try using different keywords, checking for typos or changing filters.',
      'You may want to try using different keywords, checking for errors or adjusting filters.',
      ` ${known[1]}`,
      `${known[1]} `,
      known[1].replace('typos or', 'typos  or'),
      known[1].toLowerCase(),
    ]) {
      const f = emptySearchFixture(guidance);
      expect(() => compactOutput(f.receipt, 'search', 'no-match')).toThrow('not exposed');
    }
  });

  test('both empty-search copy variants retain exact container, heading and query evidence', () => {
    for (const guidance of [
      'You may want to try using different keywords, checking for typos, or adjusting filters.',
      'You may want to try using different keywords, checking for typos or adjusting filters.',
    ]) {
      for (const change of [
        (f) => {
          f.nodes[f.guide].parent = f.root;
        },
        (f) => {
          f.nodes[f.guide].role = 'AXButton';
        },
        (f) => {
          f.nodes[f.heading].label = 'Nothing found';
        },
        (f) => {
          f.nodes[f.empty].classes = [];
        },
        (f) => {
          f.add(f.root, 'AXGroup', ['c-empty_state']);
        },
      ]) {
        const f = emptySearchFixture(guidance);
        change(f);
        expect(() => compactOutput(f.receipt, 'search', 'no-match')).toThrow('not exposed');
      }
      const changedQuery = emptySearchFixture(guidance);
      changedQuery.nodes[changedQuery.search].label = 'Search: other-query';
      expect(() => compactOutput(changedQuery.receipt, 'search', 'no-match')).toThrow(
        'Search query changed'
      );
    }
  });
});

describe('exposed channel listing', () => {
  test('excludes DMs including C-prefixed group DMs and combines duplicate channel sections', () => {
    const f = fixture();
    const sidebar = f.add(f.root, 'AXGroup', ['p-channel_sidebar']);
    const outline = f.add(sidebar, 'AXOutline');
    const addRow = (id, name, sectionName, modifiers = [], avatar = false) => {
      const section = f.add(outline, 'AXRow', [], sectionName, {
        id: `sectionHeading-${sectionName}`,
      });
      const row = f.add(section, 'AXRow', [], '', { id });
      const group = f.add(row, 'AXGroup', ['p-channel_sidebar__channel', ...modifiers]);
      if (avatar) f.add(group, 'AXGroup', ['p-channel_sidebar__user_avatar']);
      f.add(group, 'AXStaticText', [], name);
    };
    addRow('CDEMO1', 'project-help', 'Favorites');
    addRow('CDEMO1', 'project-help', 'Channels', ['p-channel_sidebar__channel--selected']);
    addRow('GDEMO2', 'project-notes', 'Channels', ['p-channel_sidebar__channel--unread']);
    addRow('DDEMO3', 'Alex Example', 'Favorites');
    addRow('CDEMO4', 'Alex, Sam', 'Favorites', ['p-channel_sidebar__channel--mpim']);
    addRow('CDEMO5', 'Taylor Example', 'Favorites', [], true);
    const result = structuredOutput(f.receipt, 'channels');
    expect(result.channels.map((channel) => channel.id)).toEqual(['CDEMO1', 'GDEMO2']);
    expect(result.channels[0].sections).toEqual(['Favorites', 'Channels']);
    expect(result.channels[0].selected).toBe(true);
    expect(result.channels[1].unread).toBe(true);
    expect(result.channels.map((channel) => channel.navigation)).toEqual([
      { command: 'read-channel', args: ['project-help'] },
      { command: 'read-channel', args: ['project-notes'] },
    ]);
    expect(
      result.channels.every((channel) => channel.isPrivate === null && channel.url === null)
    ).toBe(true);
    expect(result.coverage.scope).toBe('currently exposed sidebar channels');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.observedCount).toBe(2);
    expect(result.pagination).toEqual({ supported: false, hasMore: null, nextCursor: null });
    expect(result.workspace).toEqual({ name: 'Test Workspace', contextId: 'TDEMO', id: 'TDEMO' });
  });

  test('does not emit channel actions for unsupported names', () => {
    const f = fixture();
    const sidebar = f.add(f.root, 'AXGroup', ['p-channel_sidebar']);
    for (const [offset, name] of [
      'with spaces',
      '',
      'x'.repeat(81),
      '--bad;command',
      'valid-channel',
    ].entries()) {
      const row = f.add(sidebar, 'AXRow', [], '', { id: `CDEMO${offset}` });
      const group = f.add(row, 'AXGroup', ['p-channel_sidebar__channel']);
      f.add(group, 'AXStaticText', [], name);
    }
    const channels = structuredOutput(f.receipt, 'channels').channels;
    expect(channels.map((channel) => channel.navigation)).toEqual([
      null,
      null,
      null,
      { command: 'read-channel', args: ['valid-channel'] },
    ]);
  });

  test('does not treat an enterprise client context as a workspace ID', () => {
    const f = fixture();
    const url = 'https://app.slack.com/client/EDEMO/CDEMO1';
    f.nodes[f.root].url = url;
    f.receipt.after.url = url;
    f.receipt.target.url = url;
    f.add(f.root, 'AXGroup', ['p-channel_sidebar']);
    expect(structuredOutput(f.receipt, 'channels').workspace).toEqual({
      name: 'Test Workspace',
      contextId: 'EDEMO',
      id: null,
    });
  });

  test('reads the unique workspace wrapper label when channel listing has no navigation target', () => {
    const f = fixture();
    delete f.receipt.target;
    f.add(f.root, 'AXGroup', ['p-client_workspace_wrapper'], 'Example Workspace');
    f.add(f.root, 'AXGroup', ['p-channel_sidebar']);
    expect(structuredOutput(f.receipt, 'channels').workspace.name).toBe('Example Workspace');
  });

  test('rejects malformed or disconnected captures', () => {
    const f = fixture();
    f.nodes.push({ index: 99, parent: 999, role: 'AXGroup', classes: [] });
    expect(() => structuredOutput(f.receipt, 'channels')).toThrow('parent is missing');
  });
});

describe('exposed DM listing', () => {
  function dmFixture({ utility = true } = {}) {
    const f = fixture();
    delete f.receipt.target;
    const wrapper = f.add(f.root, 'AXGroup', ['p-client_workspace_wrapper'], 'Test Workspace');
    const sidebar = f.add(wrapper, 'AXGroup', ['p-channel_sidebar']);
    const outline = f.add(sidebar, 'AXOutline', [], 'Channels and direct messages');
    if (utility) f.add(outline, 'AXRow', [], 'Threads', { id: 'Vall_threads' });
    const sections = new Map();
    const addDM = (id, name, options = {}) => {
      const sectionName = options.section ?? 'Direct messages';
      if (!sections.has(sectionName))
        sections.set(
          sectionName,
          f.add(outline, 'AXRow', [], sectionName, { id: `sectionHeading-${sectionName}` })
        );
      const row = f.add(options.parent ?? sections.get(sectionName), 'AXRow', [], '', { id });
      const modifiers = [...(options.modifiers ?? [])];
      if (options.kind === 'group') modifiers.push('p-channel_sidebar__channel--mpim');
      if (options.kind === 'self') modifiers.push('p-channel_sidebar__channel--im-you');
      const group = f.add(row, 'AXGroup', ['p-channel_sidebar__channel', ...modifiers]);
      if (options.avatar ?? id.startsWith('D'))
        f.add(group, 'AXGroup', ['p-channel_sidebar__user_avatar']);
      const tokens = options.tokens ?? [name];
      const texts = tokens.map((token) => f.add(group, 'AXStaticText', [], token));
      if (options.url) f.add(group, 'AXLink', [], 'Observed link', { url: options.url });
      return { row, group, texts };
    };
    return { ...f, wrapper, sidebar, outline, addDM };
  }

  test('reads observed individual, group and self names without badges, guessed handles or membership', () => {
    const f = dmFixture();
    f.addDM('DDEMO1', 'Alex Example', { tokens: ['Alex Example', 'guest'] });
    f.addDM('CDEMO2', null, { kind: 'group', tokens: ['Sam Example', ', ', 'Alex Example'] });
    f.addDM('DDEMO3', 'Me Example', { kind: 'self', tokens: ['Me Example', 'you', 'guest'] });
    f.addDM('CCHANNEL', 'project-help', { avatar: false });
    const original = structuredClone(f.receipt);
    const result = compactOutput(f.receipt, 'dms');
    expect(result.dms.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      { id: 'DDEMO1', name: 'Alex Example', kind: 'one-to-one' },
      { id: 'CDEMO2', name: 'Sam Example, Alex Example', kind: 'group' },
      { id: 'DDEMO3', name: 'Me Example', kind: 'self' },
    ]);
    expect(result.dms.map((dm) => dm.navigation)).toEqual([
      { command: 'read-dm', args: ['Alex Example'] },
      { command: 'read-dm', args: ['group:CDEMO2'] },
      { command: 'read-dm', args: ['Me Example'] },
    ]);
    expect(
      result.dms.every((dm) => dm.handle === null && dm.url === null && !('members' in dm))
    ).toBe(true);
    expect(result.coverage).toMatchObject({
      complete: false,
      observedCount: 3,
      scope: 'currently exposed sidebar DMs',
    });
    expect(result.messages).toBeUndefined();
    expect(result.content).toBeUndefined();
    expect(result.pagination).toEqual({ supported: false, hasMore: null, nextCursor: null });
    expect(f.receipt).toEqual(original);
  });

  test('merges repeated IDs across sections while preserving first URL and observed flags', () => {
    const f = dmFixture();
    f.addDM('DDEMO1', 'Alex Example', {
      section: 'Favorites',
      url: 'https://demo.slack.com/observed',
    });
    f.addDM('DDEMO1', 'Alex Example', {
      section: 'DMs',
      modifiers: ['p-channel_sidebar__channel--unread', 'p-channel_sidebar__channel--selected'],
    });
    const [dm] = compactOutput(f.receipt, 'dms').dms;
    expect(dm).toMatchObject({
      id: 'DDEMO1',
      unread: true,
      selected: true,
      sections: ['Favorites', 'DMs'],
      url: 'https://demo.slack.com/observed',
      navigation: { command: 'read-dm', args: ['Alex Example'] },
    });
    expect(compactOutput(f.receipt, 'dms').dms).toHaveLength(1);
  });

  test('suppresses duplicate-name individual commands while group commands retain exact IDs', () => {
    const f = dmFixture();
    f.addDM('DDEMO1', 'Alex Example');
    f.addDM('DDEMO2', 'Alex Example');
    f.addDM('DDEMO3', 'Sam, Alex');
    f.addDM('GDEMO4', null, { kind: 'group', tokens: ['Sam', ', ', 'Alex'] });
    f.addDM('DDEMO5', 'Unique Example');
    expect(compactOutput(f.receipt, 'dms').dms.map((dm) => dm.navigation)).toEqual([
      null,
      null,
      null,
      { command: 'read-dm', args: ['group:GDEMO4'] },
      { command: 'read-dm', args: ['Unique Example'] },
    ]);
  });

  test('retains unsupported exact names as data while withholding unsafe or handle-like hints', () => {
    const f = dmFixture();
    const unsupported = [
      '@alex',
      'group:CDEMO',
      'group-name:Not a group',
      ' Leading',
      'Trailing ',
      'Line\nBreak',
      'Tab\tName',
      'Hidden\u202eName',
      'x'.repeat(501),
      '😀'.repeat(251),
    ];
    unsupported.forEach((name, index) => f.addDM(`DDEMO${index}`, name));
    f.addDM('DSAFE1', "O'Example");
    f.addDM('DSAFE2', 'x'.repeat(500));
    const dms = compactOutput(f.receipt, 'dms').dms;
    expect(dms.slice(0, unsupported.length).map((dm) => dm.name)).toEqual(unsupported);
    expect(dms.slice(0, unsupported.length).every((dm) => dm.navigation === null)).toBe(true);
    expect(dms.at(-2).navigation).toEqual({ command: 'read-dm', args: ["O'Example"] });
    expect(dms.at(-1).navigation.args[0]).toHaveLength(500);
  });

  test('same-name group DMs remain separately addressable without guessed membership', () => {
    const f = dmFixture();
    f.addDM('CDEMO1', null, { kind: 'group', tokens: ['Sam', ', ', 'Alex'] });
    f.addDM('GDEMO2', null, { kind: 'group', tokens: ['Sam', ', ', 'Alex'] });
    const result = compactOutput(f.receipt, 'dms');
    expect(result.dms.map((dm) => dm.navigation)).toEqual([
      { command: 'read-dm', args: ['group:CDEMO1'] },
      { command: 'read-dm', args: ['group:GDEMO2'] },
    ]);
    expect(result.dms.every((dm) => dm.handle === null && !('members' in dm))).toBe(true);
  });

  test('group actions require complete canonical group IDs without trailing whitespace', () => {
    const invalid = ['C', 'DDEMO', 'CDEMO\n', 'GDEMO ', 'Cdemo', 'group:CDEMO'];
    expect(
      withDMNavigation(invalid.map((id) => ({ id, name: 'Sam, Alex', kind: 'group' }))).every(
        (dm) => dm.navigation === null
      )
    ).toBe(true);
    expect(
      withDMNavigation([{ id: 'GDEMO', name: 'Sam, Alex', kind: 'group' }])[0].navigation
    ).toEqual({ command: 'read-dm', args: ['group:GDEMO'] });
  });

  test('omits uncertain DM identity or text shapes rather than guessing names or kinds', () => {
    const f = dmFixture();
    f.addDM('DNOAVATAR', 'Unknown', { avatar: false });
    f.addDM('CAVATAR', 'Unknown', { avatar: true });
    f.addDM('CCONFLICT', null, {
      kind: 'group',
      modifiers: ['p-channel_sidebar__channel--im'],
      tokens: ['A', ', ', 'B'],
    });
    f.addDM('DMPIM', null, { kind: 'group', tokens: ['A', ', ', 'B'] });
    f.addDM('CSINGLE', 'Custom group label', { kind: 'group' });
    f.addDM('CBADJOIN', null, { kind: 'group', tokens: ['A', '/', 'B'] });
    f.addDM('DEXTRA', null, { tokens: ['Name', 'unknown badge'] });
    f.addDM('DNOTSELF', null, { tokens: ['Name', 'you'] });
    f.addDM('DIM', 'Known', { avatar: false, modifiers: ['p-channel_sidebar__channel--im'] });
    const result = compactOutput(f.receipt, 'dms');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DIM']);
    expect(result.coverage.warnings).toContain(
      '8 sidebar rows lacked an unambiguous DM structure and were omitted'
    );
  });

  test('conflicting same-ID names or kinds stop extraction', () => {
    for (const conflict of ['name', 'kind']) {
      const f = dmFixture();
      f.addDM('DDEMO1', 'Alex Example', { section: 'Favorites' });
      f.addDM('DDEMO1', conflict === 'name' ? 'Different' : 'Alex Example', {
        section: 'DMs',
        kind: conflict === 'kind' ? 'self' : undefined,
      });
      expect(() => compactOutput(f.receipt, 'dms')).toThrow('conflicting names or kinds');
    }
  });

  test('requires one scoped outline and rejects off-outline rows or a reopened picker', () => {
    for (const mutation of ['missing', 'duplicate', 'outside', 'taint', 'query']) {
      const f = dmFixture();
      f.addDM('DDEMO1', 'Alex Example');
      if (mutation === 'missing') f.nodes[f.outline].role = 'AXGroup';
      if (mutation === 'duplicate')
        f.add(f.sidebar, 'AXOutline', [], 'Channels and direct messages');
      if (mutation === 'outside') f.nodes[f.outline].parent = f.root;
      if (mutation === 'taint')
        f.addDM('DDEMO1', 'Alex Example', {
          parent: f.sidebar,
          modifiers: ['p-channel_sidebar__channel--unread'],
        });
      if (mutation === 'query') f.add(f.root, 'AXComboBox', [], 'Query');
      expect(() => compactOutput(f.receipt, 'dms')).toThrow();
    }
  });

  test('an exposed sidebar with utility rows can have no DMs without claiming a complete directory', () => {
    const f = dmFixture();
    const result = compactOutput(f.receipt, 'dms');
    expect(result.dms).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.pagination.hasMore).toBeNull();
    expect(() => compactOutput(dmFixture({ utility: false }).receipt, 'dms')).toThrow(
      'rows are not exposed'
    );
  });
});

describe('corroborated conversation title markers', () => {
  const variants = () => [fixture(), fixture('dm'), groupDMFixture()];
  const read = (f) =>
    compactOutput(
      f.receipt,
      f.receipt.target.kind === 'dm' ? 'read-dm' : 'read-channel',
      f.receipt.target.requested
    );
  const title = (f, name, prefix = '') => {
    const value = `${prefix}${name} (${f.receipt.target.kind === 'dm' ? 'DM' : 'Channel'}) - Test Workspace - Slack`;
    f.nodes[f.root].label = value;
    f.receipt.after.title = value;
  };
  const inspect = (f) => {
    delete f.receipt.target;
    f.receipt.after.nodes = [structuredClone(f.nodes[f.root])];
    return compactOutput(f.receipt, 'inspect');
  };

  test('reads exact verified targets with a single observed leading title marker', () => {
    for (const f of variants()) {
      title(f, f.name, '* ');
      f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Synthetic message');
      const original = structuredClone(f.receipt);
      const result = read(f);
      expect(result.conversation.name).toBe(f.name);
      expect(result.conversation.id).toBe(f.id);
      expect(result.messages[0].text).toBe('Synthetic message');
      expect(result.workspace.name).toBe('Test Workspace');
      expect(f.receipt).toEqual(original);
    }
  });

  test('inspection recovers only a name corroborated by the primary list and kind', () => {
    for (const f of variants()) {
      title(f, f.name, '* ');
      f.message('1700000000.000001');
      const result = inspect(f);
      expect(result.conversation.name).toBe(f.name);
      expect(result.messages).toHaveLength(1);
      expect(result.workspace.name).toBe('Test Workspace');
    }
  });

  test('exclamation-mark decoration preserves exact channel, DM and group identities', () => {
    for (const f of variants()) {
      title(f, f.name, '! ');
      f.message('1700000000.000001');
      expect(read(f).conversation.name).toBe(f.name);
      expect(inspect(f).conversation.name).toBe(f.name);
    }
  });

  test('literal exclamation-mark names are preserved with either observed decoration', () => {
    for (const decoration of ['', '* ', '! ']) {
      for (const f of variants()) {
        const actual = `! ${f.name}`;
        f.nodes[f.list].label = f.nodes[f.list].label.replace(f.name, actual);
        f.receipt.target.name = actual;
        title(f, actual, decoration);
        f.message('1700000000.000001');
        expect(read(f).conversation.name).toBe(actual);
        expect(inspect(f).conversation.name).toBe(actual);
      }
    }
  });

  test('literal leading-star names remain exact with or without a decoration', () => {
    for (const decoration of ['', '* ']) {
      for (const f of variants()) {
        const actual = `* ${f.name}`;
        f.nodes[f.list].label = f.nodes[f.list].label.replace(f.name, actual);
        f.receipt.target.name = actual;
        title(f, actual, decoration);
        f.message('1700000000.000001');
        expect(read(f).conversation.name).toBe(actual);
        expect(inspect(f).conversation.name).toBe(actual);
      }
    }
  });

  test('channel navigation retains its exact target check with the same marker alternative', () => {
    const f = fixture();
    title(f, f.name, '* ');
    f.receipt.after.nodes = [structuredClone(f.nodes[f.root])];
    f.message('1700000000.000001');
    expect(compactOutput(f.receipt, 'channel', f.name).conversation.name).toBe(f.name);
    f.receipt.target.name = 'other-channel';
    expect(() => compactOutput(f.receipt, 'channel', f.name)).toThrow('Channel view changed');
  });

  test('unknown or repeated markers cannot be stripped to make a known target match', () => {
    for (const marker of ['** ', '* * ', ' * ', '• ', '*', '!! ', '! ! ', '* ! ', '! * ', '!']) {
      for (const f of variants()) {
        title(f, f.name, marker);
        f.message('1700000000.000001');
        expect(() => read(f)).toThrow('title');
        expect(() => inspect(f)).toThrow('message list');
      }
    }
  });

  test('inspection rejects absent, foreign, side-pane or conflicting corroboration', () => {
    const changes = [
      (f) => {
        f.nodes[f.list].label = `${f.name} (channel)`;
      },
      (f) => {
        f.nodes[f.list].label = `Different group (group direct message)`;
      },
      (f) => {
        f.nodes[f.list].parent = f.root;
      },
      (f) => {
        f.nodes[f.pane].parent = f.add(f.primary, 'AXGroup', ['p-thread_view']);
      },
      (f) => {
        f.add(f.pane, 'AXList', ['sr-only'], `* ${f.name} (group direct message)`);
      },
      (f) => {
        f.nodes[f.primary].classes = [];
      },
    ];
    for (const change of changes) {
      const f = groupDMFixture();
      title(f, f.name, '* ');
      f.message('1700000000.000001');
      change(f);
      expect(() => inspect(f)).toThrow();
    }
  });

  test('the marker alternative cannot weaken group URL, reference or list-kind checks', () => {
    const changes = [
      (f) => {
        f.receipt.target.conversationId = 'COTHER';
      },
      (f) => {
        f.receipt.target.requested = 'group:COTHER';
      },
      (f) => {
        f.receipt.target.url += '/changed';
      },
      (f) => {
        f.nodes[f.list].label = `${f.name} (direct message)`;
      },
      (f) => {
        f.nodes[f.list].label = `${f.name} (channel)`;
      },
    ];
    for (const change of changes) {
      const f = groupDMFixture();
      title(f, f.name, '* ');
      f.message('1700000000.000001');
      change(f);
      expect(() => read(f)).toThrow();
    }
  });
});

describe('verified group DM reads', () => {
  function addForeword(f, { directAvatars = false, memberCount = 2 } = {}) {
    const row = f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
      id: 'message-list_0000000000.000001',
    });
    const avatars = directAvatars
      ? row
      : f.add(row, 'AXGroup', ['p-message_pane__foreword__avatars']);
    const avatarNodes = [];
    for (let i = 0; i < memberCount; i++)
      avatarNodes.push(
        f.add(
          avatars,
          'AXButton',
          directAvatars
            ? [
                'c-button-unstyled',
                'p-message_pane__foreword__avatar',
                'c-avatar',
                'c-avatar--interactive',
              ]
            : ['p-message_pane__foreword__avatar'],
          'View profile'
        )
      );
    const intro = f.add(
      row,
      'AXStaticText',
      [],
      'This is the very beginning of your direct message history with '
    );
    const profile = () =>
      f.add(row, 'AXLink', ['c-member_slug', 'c-member_slug--link'], 'Person', {
        url: 'https://demo.slack.com/team/UDEMO',
      });
    const profiles = [],
      delimiters = [];
    for (let i = 0; i < memberCount; i++) {
      if (i)
        delimiters.push(f.add(row, 'AXStaticText', [], i === memberCount - 1 ? ' and ' : ', '));
      profiles.push(profile());
    }
    const notification = f.add(row, 'AXGroup', ['p-message_pane__foreword__notification_setting']);
    f.add(notification, 'AXStaticText', [], 'Notification settings');
    return {
      row,
      avatars,
      avatarNodes,
      intro,
      first: profiles[0],
      second: profiles[1],
      delimiter: delimiters[0],
      notification,
    };
  }

  test('omits only the observed group welcome card without copying profile or notification text', () => {
    const f = groupDMFixture();
    addForeword(f);
    f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Real group message');
    const result = f.read();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Real group message');
    expect(JSON.stringify(result)).not.toContain('Notification settings');
    expect(result.coverage.complete).toBe(false);
  });

  test('supports the direct avatar prefix while preserving the wrapped welcome layout', () => {
    for (const directAvatars of [false, true]) {
      for (const memberCount of [2, 3]) {
        const f = groupDMFixture();
        addForeword(f, { directAvatars, memberCount });
        f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Verified group message');
        const result = f.read();
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].text).toBe('Verified group message');
        expect(JSON.stringify(result)).not.toContain('Notification settings');
        expect(JSON.stringify(result)).not.toContain('View profile');
        expect(result.coverage.complete).toBe(false);
      }
    }
  });

  test('direct welcome avatars require exact leaf controls and contiguous ownership', () => {
    const changes = [
      (f, w) => {
        f.nodes[w.avatarNodes[0]].role = 'AXGroup';
      },
      (f, w) => {
        f.nodes[w.avatarNodes[0]].classes.push('unverified');
      },
      (f, w) => {
        f.nodes[w.avatarNodes[0]].classes.pop();
      },
      (f, w) => {
        f.add(w.avatarNodes[0], 'AXStaticText', [], 'Nested avatar content');
      },
      (f, w) => {
        f.nodes[w.avatarNodes[0]].parent = w.notification;
      },
      (f, w) => {
        f.nodes[w.avatarNodes[1]].parent = w.avatarNodes[0];
      },
      (f, w) => {
        f.add(
          w.row,
          'AXButton',
          [
            'c-button-unstyled',
            'p-message_pane__foreword__avatar',
            'c-avatar',
            'c-avatar--interactive',
          ],
          'Unexpected suffix avatar'
        );
      },
      (f, w) => {
        f.add(w.row, 'AXGroup', ['p-message_pane__foreword__avatars']);
      },
      (f, w) => {
        f.nodes[w.intro].label += ' changed';
      },
      (f, w) => {
        f.nodes[w.row].id = 'message-list_0000000000.000002';
      },
      (f, w) => {
        f.nodes[w.notification].classes = [];
      },
      (f, w) => {
        f.add(w.notification, 'AXStaticText', ['c-timestamp'], 'Unexpected timestamp');
      },
      (f, w) => {
        f.add(w.notification, 'AXLink', [], 'Unexpected archive', {
          url: 'https://demo.slack.com/archives/CGROUP1/p1700000000000001',
        });
      },
    ];
    for (const change of changes) {
      const f = groupDMFixture();
      const welcome = addForeword(f, { directAvatars: true, memberCount: 3 });
      change(f, welcome);
      f.message('1700000000.000001');
      expect(() => f.read()).toThrow('content container');
    }
    const f = fixture('dm');
    addForeword(f, { directAvatars: true, memberCount: 3 });
    f.message('1700000000.000001');
    expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow('content container');
  });

  test('direct welcome avatars accept only the observed deleted member modifier', () => {
    const f = groupDMFixture();
    const welcome = addForeword(f, { directAvatars: true, memberCount: 3 });
    f.nodes[welcome.avatarNodes[0]].classes.push('c-avatar--deleted_member');
    f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Real group message');
    expect(f.read().messages.map((message) => message.text)).toEqual(['Real group message']);
    for (const extra of ['c-avatar--deleted_member', 'c-avatar--unknown']) {
      f.nodes[welcome.avatarNodes[0]].classes.push(extra);
      expect(() => f.read()).toThrow('content container');
      f.nodes[welcome.avatarNodes[0]].classes.pop();
    }
    f.add(welcome.avatarNodes[0], 'AXStaticText', [], 'Nested avatar content');
    expect(() => f.read()).toThrow('content container');
  });

  test('direct welcome avatars accept only the observed focus-visible modifier', () => {
    const f = groupDMFixture();
    const welcome = addForeword(f, { directAvatars: true, memberCount: 2 });
    for (const avatar of welcome.avatarNodes)
      f.nodes[avatar].classes.unshift('c-button--focus-visible');
    f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Real group message');
    expect(f.read().messages.map((message) => message.text)).toEqual(['Real group message']);
    for (const extra of ['c-button--focus-visible', 'unverified']) {
      f.nodes[welcome.avatarNodes[0]].classes.push(extra);
      expect(() => f.read()).toThrow('content container');
      f.nodes[welcome.avatarNodes[0]].classes.pop();
    }
    f.add(welcome.avatarNodes[0], 'AXStaticText', [], 'Nested avatar content');
    expect(() => f.read()).toThrow('content container');
  });

  test('direct welcome avatars accept the observed focused deleted member combination', () => {
    const f = groupDMFixture();
    const welcome = addForeword(f, { directAvatars: true, memberCount: 2 });
    for (const avatar of welcome.avatarNodes)
      f.nodes[avatar].classes.unshift('c-button--focus-visible');
    const deleted = welcome.avatarNodes[1];
    f.nodes[deleted].classes.push('c-avatar--deleted_member');
    f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Real group message');
    expect(f.read().messages.map((message) => message.text)).toEqual(['Real group message']);
    for (const extra of ['c-button--focus-visible', 'c-avatar--deleted_member', 'unverified']) {
      f.nodes[deleted].classes.push(extra);
      expect(() => f.read()).toThrow('content container');
      f.nodes[deleted].classes.pop();
    }
    f.add(deleted, 'AXStaticText', [], 'Nested avatar content');
    expect(() => f.read()).toThrow('content container');
  });

  test('direct welcome profiles retain canonical Slack user routes and exact member separators', () => {
    for (const url of [
      'https://example.com/team/UDEMO',
      'https://user@demo.slack.com/team/UDEMO',
      'https://demo.slack.com:443/team/UDEMO',
      'https://demo.slack.com/team/UDEMO?extra=1',
      'https://demo.slack.com/team/UDEMO#part',
      'https://demo.slack.com/team/%55DEMO',
      'https://demo.slack.com/archives/CGROUP1/p1700000000000001',
    ]) {
      const f = groupDMFixture();
      const welcome = addForeword(f, { directAvatars: true, memberCount: 3 });
      f.nodes[welcome.first].url = url;
      f.message('1700000000.000001');
      expect(() => f.read()).toThrow('content container');
    }
    const f = groupDMFixture();
    const welcome = addForeword(f, { directAvatars: true, memberCount: 3 });
    f.nodes[welcome.delimiter].label = ' / ';
    f.message('1700000000.000001');
    expect(() => f.read()).toThrow('content container');
  });

  test('message content inside a direct-avatar sentinel still requires ordinary source checks', () => {
    const f = groupDMFixture();
    const welcome = addForeword(f, { directAvatars: true, memberCount: 3 });
    const body = f.add(welcome.notification, 'AXGroup', ['c-message_kit__actions']);
    const timestamp = f.add(body, 'AXLink', ['c-timestamp'], 'Real timestamp', {
      url: 'https://demo.slack.com/archives/COTHER/p0000000000000001',
    });
    f.add(body, 'AXStaticText', [], 'Actual epoch-like message');
    expect(() => f.read()).toThrow('different conversation');
    f.nodes[timestamp].url = 'https://demo.slack.com/archives/CGROUP1/p0000000000000001';
    const result = f.read();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Actual epoch-like message');
    expect(result.messages[0].permalink).toBe(f.nodes[timestamp].url);
  });

  test('rejects unproven group welcome-card shapes and message-like or foreign links', () => {
    const changes = [
      (f, w) => {
        f.nodes[w.intro].label += 'changed';
      },
      (f, w) => {
        f.nodes[w.delimiter].label = ' / ';
      },
      (f, w) => {
        f.nodes[w.first].classes = [];
      },
      (f, w) => {
        f.nodes[w.first].url = 'https://example.com/team/UDEMO';
      },
      (f, w) => {
        f.nodes[w.first].url = 'https://demo.slack.com:443/team/UDEMO';
      },
      (f, w) => {
        f.nodes[w.first].url += '?unverified=1';
      },
      (f, w) => {
        f.nodes[w.first].url = 'https://demo.slack.com/archives/CGROUP1/p1700000000000001';
      },
      (f, w) => {
        f.nodes[w.notification].classes = [];
      },
      (f, w) => {
        f.add(w.avatars, 'AXButton', ['p-message_pane__foreword__avatar']);
      },
      (f, w) => {
        f.add(w.notification, 'AXLink', [], 'Unexpected', {
          url: 'https://demo.slack.com/team/UDEMO',
        });
      },
      (f, w) => {
        f.add(w.notification, 'AXStaticText', ['c-timestamp'], 'Timestamp');
      },
    ];
    for (const change of changes) {
      const f = groupDMFixture();
      const welcome = addForeword(f);
      change(f, welcome);
      f.message('1700000000.000001');
      expect(() => f.read()).toThrow('content container');
    }
  });

  test('a real message container in the sentinel row remains a message', () => {
    const f = groupDMFixture();
    const welcome = addForeword(f);
    const body = f.add(welcome.notification, 'AXGroup', ['c-message_kit__actions']);
    f.add(body, 'AXLink', ['c-timestamp'], 'Real timestamp', {
      url: 'https://demo.slack.com/archives/CGROUP1/p0000000000000001',
    });
    f.add(body, 'AXStaticText', [], 'Actual epoch-like message');
    const result = f.read();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Actual epoch-like message');
  });

  test('group welcome cards cannot be silently skipped in an individual DM', () => {
    const f = fixture('dm');
    addForeword(f);
    f.message('1700000000.000001');
    expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow('content container');
  });

  test('reads observed group message lists with stable identity and existing thread references', () => {
    for (const id of ['CGROUP1', 'GGROUP1']) {
      const f = groupDMFixture(id);
      const message = f.message('1700000000.000001');
      f.add(message.body, 'AXStaticText', [], 'Group discussion');
      f.add(message.body, 'AXButton', ['c-message__reply_count'], '2 replies');
      const original = structuredClone(f.receipt);
      const result = f.read();
      expect(result.conversation).toEqual({
        id,
        name: f.name,
        kind: 'dm',
        dmKind: 'group',
        url: f.receipt.after.url,
        handle: null,
      });
      expect(result.requested).toBe(`group:${id}`);
      expect(result.messages[0].text).toBe('Group discussion');
      expect(result.messages[0].thread.ref).toBe(`${id}:1700000000.000001`);
      expect(result.messages[0].thread.navigation).toEqual({
        command: 'read-thread',
        args: [`${id}:1700000000.000001`],
      });
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.listLabel).toBe(`${f.name} (group direct message)`);
      expect(f.receipt).toEqual(original);
    }
  });

  test('rejects missing or conflicting group reference and destination metadata', () => {
    const changes = [
      (f) => delete f.receipt.target.dmKind,
      (f) => {
        f.receipt.target.kind = 'channel';
      },
      (f) => delete f.receipt.target.conversationId,
      (f) => {
        f.receipt.target.conversationId = 'COTHER';
      },
      (f) => {
        f.receipt.target.requested = 'group:COTHER';
      },
      (f) => {
        f.receipt.target.requested += '\n';
      },
      (f) => {
        f.receipt.target.handle = '@made.up';
      },
      (f) => {
        f.receipt.target.url += '/changed';
      },
      (f) => {
        f.receipt.target.name = 'Different group';
      },
    ];
    for (const change of changes) {
      const f = groupDMFixture();
      f.message('1700000000.000001');
      change(f);
      expect(() => f.read()).toThrow();
    }
    const f = groupDMFixture();
    f.message('1700000000.000001');
    for (const request of [f.name, 'group:COTHER', 'group:CGROUP1\n', null])
      expect(() => compactOutput(f.receipt, 'read-dm', request)).toThrow('Group DM reference');
  });

  test('requires explicit group list kind rather than assuming C/G IDs or DM titles prove a group', () => {
    for (const label of [
      'channel',
      'direct message',
      'private channel',
      'shared channel',
      'group direct messages',
      'group direct message spoof',
    ]) {
      const f = groupDMFixture();
      f.message('1700000000.000001');
      f.nodes[f.list].label = `${f.name} (${label})`;
      expect(() => f.read()).toThrow('message list');
    }
    const f = groupDMFixture('DINDIVIDUAL');
    f.message('1700000000.000001');
    expect(() => f.read()).toThrow('Conversation URL');
  });

  test('named group lookup retains canonical ID binding and requires the exact verified lookup name', () => {
    const f = groupDMFixture();
    f.message('1700000000.000001');
    f.receipt.target.requestedLookup = `group-name:${f.name}`;
    const result = compactOutput(f.receipt, 'read-dm', `group-name:${f.name}`);
    expect(result.conversation).toMatchObject({ id: f.id, dmKind: 'group', name: f.name });
    expect(result.messages).toHaveLength(1);
    for (const change of [
      (g) => {
        delete g.receipt.target.requestedLookup;
      },
      (g) => {
        g.receipt.target.requestedLookup = 'group-name:Different';
      },
      (g) => {
        g.receipt.target.requested = `group-name:${g.name}`;
      },
      (g) => {
        g.receipt.target.conversationId = 'COTHER';
      },
      (g) => {
        g.nodes[g.list].label = `${g.name} (direct message)`;
      },
    ]) {
      const g = groupDMFixture();
      g.message('1700000000.000001');
      g.receipt.target.requestedLookup = `group-name:${g.name}`;
      change(g);
      expect(() => compactOutput(g.receipt, 'read-dm', `group-name:${g.name}`)).toThrow();
    }
  });

  test('a channel with the same ID or name cannot masquerade as a requested group DM', () => {
    const f = fixture();
    f.message('1700000000.000001');
    Object.assign(f.receipt.target, {
      kind: 'dm',
      dmKind: 'group',
      conversationId: f.id,
      requested: `group:${f.id}`,
    });
    expect(() => compactOutput(f.receipt, 'read-dm', `group:${f.id}`)).toThrow('title');
    const group = groupDMFixture();
    group.message('1700000000.000001', { conversationId: 'COTHER' });
    expect(() => group.read()).toThrow('different conversation');
  });

  test('inspection recognizes a group only when its current title, ID and group list agree', () => {
    const f = groupDMFixture();
    f.message('1700000000.000001');
    delete f.receipt.target;
    f.receipt.after.nodes = [structuredClone(f.nodes[f.root])];
    const result = compactOutput(f.receipt, 'inspect');
    expect(result.operation).toBe('inspect');
    expect(result.requested).toBeNull();
    expect(result.conversation).toMatchObject({ id: f.id, kind: 'dm', dmKind: 'group' });
    f.nodes[f.list].label = `${f.name} (channel)`;
    expect(() => compactOutput(f.receipt, 'inspect')).toThrow('message list');
  });
});

describe('verified DM foreword rows', () => {
  function linkedForeword(f) {
    const item = f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
      id: 'message-list_0000000000.000001',
    });
    const avatar = f.add(item, 'AXButton', ['p-new_im_foreword-entity__avatar-button']);
    const name = f.add(item, 'AXButton', ['p-new_im_foreword-entity__name_button'], 'Alex Example');
    const description = f.add(item, 'AXGroup', ['p-message_pane__foreword__description']);
    const intro = f.add(
      description,
      'AXStaticText',
      [],
      'This conversation is just between you and '
    );
    const profile = f.add(
      description,
      'AXLink',
      ['c-link', 'c-member_slug', 'c-member_slug--light', 'c-member_slug--link'],
      '@Alex Example',
      { url: 'https://demo.slack.com/team/UDEMO' }
    );
    f.add(profile, 'AXStaticText', [], '@Alex Example');
    const outro = f.add(
      description,
      'AXStaticText',
      [],
      '. Take a look at their profile to learn more about them.'
    );
    return { item, avatar, name, description, intro, profile, outro };
  }

  test('omits the observed entity welcome with its owned canonical profile link', () => {
    for (const operation of ['read-dm', 'inspect']) {
      const f = fixture('dm');
      linkedForeword(f);
      f.add(f.message('1700000000.000001').body, 'AXStaticText', [], 'Actual conversation message');
      if (operation === 'inspect') f.receipt.after.nodes = [f.nodes[f.root]];
      const result = compactOutput(f.receipt, operation, 'Alex Example');
      expect(result.messages.map((message) => message.text)).toEqual([
        'Actual conversation message',
      ]);
      expect(JSON.stringify(result)).not.toContain('This conversation is just');
      expect(JSON.stringify(result)).not.toContain('/team/UDEMO');
      expect(result.coverage.complete).toBe(false);
    }
  });

  test('linked welcome descriptions require exact ownership, grammar and unique profile evidence', () => {
    const changes = [
      (f, w) => {
        f.nodes[w.profile].parent = w.item;
      },
      (f, w) => {
        f.nodes[w.description].role = 'AXButton';
        f.add(w.item, 'AXGroup', ['p-message_pane__foreword__description']);
      },
      (f, w) => {
        f.nodes[w.intro].label += 'changed';
      },
      (f, w) => {
        f.nodes[w.outro].label += 'changed';
      },
      (f, w) => {
        f.nodes[w.profile].classes.push('unverified');
      },
      (f, w) => {
        f.nodes[w.profile].classes.pop();
      },
      (f, w) => {
        f.nodes[w.profile].label = '';
      },
      (f, w) => {
        f.nodes[w.avatar].classes = [];
      },
      (f, w) => {
        f.nodes[w.name].role = 'AXGroup';
      },
      (f, w) => {
        f.nodes[w.item].id = 'message-list_1700000000.000001';
      },
      (f, w) => {
        f.add(w.description, 'AXStaticText', [], 'Extra description');
      },
      (f, w) => {
        f.add(w.item, 'AXLink', [], 'Extra profile', { url: f.nodes[w.profile].url });
      },
      (f, w) => {
        f.add(w.item, 'AXGroup', ['p-message_pane__foreword__description']);
      },
      (f, w) => {
        f.add(w.item, 'AXStaticText', ['c-timestamp'], 'Timestamp');
      },
    ];
    for (const change of changes) {
      const f = fixture('dm');
      const welcome = linkedForeword(f);
      change(f, welcome);
      expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow(
        'content container'
      );
    }
    for (const url of [
      'https://example.com/team/UDEMO',
      'http://demo.slack.com/team/UDEMO',
      'https://user@demo.slack.com/team/UDEMO',
      'https://demo.slack.com:443/team/UDEMO',
      'https://demo.slack.com/team/UDEMO?extra=1',
      'https://demo.slack.com/team/UDEMO#part',
      'https://demo.slack.com/team/%55DEMO',
      'https://demo.slack.com/team/UDEMO/extra',
      'https://demo.slack.com/archives/DDEMO1/p0000000000000001',
    ]) {
      const f = fixture('dm');
      const welcome = linkedForeword(f);
      f.nodes[welcome.profile].url = url;
      expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow(
        'content container'
      );
    }
  });

  test('linked welcome evidence never hides real messages or crosses conversation kinds', () => {
    const f = fixture('dm');
    const welcome = linkedForeword(f);
    const body = f.add(welcome.item, 'AXGroup', ['c-message_kit__actions']);
    const time = f.add(body, 'AXLink', ['c-timestamp'], 'Message time', {
      url: 'https://demo.slack.com/archives/DOTHER/p0000000000000001',
    });
    f.add(body, 'AXStaticText', [], 'Real sentinel message');
    expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow(
      'different conversation'
    );
    f.nodes[time].url = 'https://demo.slack.com/archives/DDEMO1/p0000000000000001';
    expect(compactOutput(f.receipt, 'read-dm', 'Alex Example').messages[0].text).toBe(
      'Real sentinel message'
    );
    const channel = fixture('channel');
    linkedForeword(channel);
    expect(() => compactOutput(channel.receipt, 'read-channel', channel.name)).toThrow(
      'content container'
    );
    const group = groupDMFixture();
    linkedForeword(group);
    expect(() => group.read()).toThrow('content container');
  });

  function foreword(f, existing = null) {
    const item =
      existing ??
      f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
        id: 'message-list_0000000000.000001',
      });
    const avatars = f.add(item, 'AXGroup', ['p-message_pane__foreword__avatars']);
    f.add(avatars, 'AXButton', ['p-new_im_foreword-entity__name_button'], 'My profile (you)');
    f.add(avatars, 'AXStaticText', [], 'Profile text is not a message');
    const description = f.add(item, 'AXGroup', ['p-message_pane__foreword__description']);
    f.add(description, 'AXStaticText', [], 'This is your space.');
    const profile = f.add(
      item,
      'AXButton',
      ['p-message_pane__foreword__profile-button'],
      'Edit Profile'
    );
    return { item, avatars, description, profile };
  }

  test('excludes the exact observed introduction without copying profile text or claiming completeness', () => {
    const f = fixture('dm');
    foreword(f);
    const message = f.message('1700000000.000003');
    f.add(message.body, 'AXStaticText', [], 'Saved note');
    const result = compactOutput(f.receipt, 'read-dm', 'Alex Example');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'message-list_1700000000.000003',
      text: 'Saved note',
    });
    expect(JSON.stringify(result)).not.toContain('Profile text');
    expect(JSON.stringify(result)).not.toContain('This is your space');
    expect(result.coverage.complete).toBe(false);
  });

  test('excludes the newer entity-button introduction layout', () => {
    const f = fixture('dm');
    const item = f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
      id: 'message-list_0000000000.000001',
    });
    f.add(item, 'AXButton', ['p-new_im_foreword-entity__avatar-button']);
    const name = f.add(item, 'AXButton', ['p-new_im_foreword-entity__name_button'], 'Me(you)');
    f.add(name, 'AXStaticText', [], 'Profile text is not a message');
    f.add(item, 'AXImage', ['is-inline'], 'Away');
    const description = f.add(item, 'AXGroup', ['p-message_pane__foreword__description']);
    f.add(description, 'AXStaticText', [], 'This is your space.');
    f.add(item, 'AXButton', ['c-button'], 'Edit profile');
    const message = f.message('1700000000.000003');
    f.add(message.body, 'AXStaticText', [], 'Saved note');
    const result = compactOutput(f.receipt, 'read-dm', 'Alex Example');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Saved note');
    expect(JSON.stringify(result)).not.toContain('Profile text');
  });

  test('excludes the channel welcome row with its title, description and action cards', () => {
    const f = fixture('channel');
    const item = f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
      id: 'message-list_0000000000.000001',
    });
    f.add(item, 'AXHeading', ['p-message_pane__foreword__title'], 'Welcome text is not a message');
    const description = f.add(item, 'AXGroup', ['p-message_pane__foreword__description']);
    f.add(description, 'AXStaticText', [], 'Channel description');
    for (const label of ['Add coworkers', 'Add a canvas'])
      f.add(item, 'AXButton', ['c-button-unstyled', 'actionCard__demo'], label);
    const message = f.message('1700000000.000003');
    f.add(message.body, 'AXStaticText', [], 'First post');
    const result = compactOutput(f.receipt, 'read-channel', 'example');
    expect(result.messages.map((record) => record.text)).toEqual(['First post']);
    expect(JSON.stringify(result)).not.toContain('Welcome text');
  });

  test('resets sender continuity at the verified foreword', () => {
    const f = fixture('dm');
    f.message('1700000000.000001');
    foreword(f);
    markGrouped(f, f.message('1700000000.000002', { compact: true }));
    const result = compactOutput(f.receipt, 'read-dm', 'Alex Example');
    expect(result.messages[0].author).toBe('Sam Example');
    expect(result.messages[1].author).toBeNull();
    expect(result.messages[1].authorInferred).toBeUndefined();
  });

  test('unknown sentinel structures and other malformed real rows still fail extraction', () => {
    for (const mutation of [
      'missing',
      'duplicate',
      'role',
      'class',
      'timestamp',
      'link',
      'permalink',
      'non-sentinel',
    ]) {
      const f = fixture('dm');
      const row = foreword(f);
      if (mutation === 'missing') f.nodes[row.description].classes = [];
      if (mutation === 'duplicate')
        f.add(row.item, 'AXGroup', ['p-message_pane__foreword__description']);
      if (mutation === 'role') f.nodes[row.item].role = 'AXRow';
      if (mutation === 'class') f.nodes[row.item].classes = [];
      if (mutation === 'timestamp') f.add(row.item, 'AXGroup', ['c-timestamp']);
      if (mutation === 'link')
        f.add(row.item, 'AXLink', [], 'Link', { url: 'https://example.com/profile' });
      if (mutation === 'permalink')
        f.nodes[row.avatars].url = 'https://demo.slack.com/archives/DDEMO1/p0000000000000001';
      if (mutation === 'non-sentinel') f.nodes[row.item].id = 'message-list_1700000000.000001';
      expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow(
        'content container'
      );
    }
    const f = fixture('dm');
    f.add(f.list, 'AXGroup', ['c-virtual_list__item'], '', {
      id: 'message-list_0000000000.000001',
    });
    expect(() => compactOutput(f.receipt, 'read-dm', 'Alex Example')).toThrow('content container');
  });

  test('retains a real message with the epoch-like identity even when foreword markers are present', () => {
    const f = fixture('dm');
    const message = f.message('0000000000.000001');
    foreword(f, message.item);
    f.add(message.body, 'AXStaticText', [], 'Actual message');
    const result = compactOutput(f.receipt, 'read-dm', 'Alex Example');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'message-list_0000000000.000001',
      text: 'Actual message',
      permalink: 'https://demo.slack.com/archives/DDEMO1/p0000000000000001',
    });
  });

  test('does not extend the DM-only exception to channel captures', () => {
    const f = fixture();
    foreword(f);
    expect(() => compactOutput(f.receipt, 'read-channel', 'project-help')).toThrow(
      'content container'
    );
  });
});

describe('direct individual DM fallback receipts', () => {
  function fallback() {
    const f = fixture('dm');
    f.message('1700000000.000000');
    f.receipt.target.lookup = {
      source: 'dms-search-autocomplete',
      query: '@alex.example',
      conversationId: f.id,
      exactMatchCount: 1,
    };
    return f;
  }
  test('retains query-bound canonical lookup evidence with ordinary messages', () => {
    const f = fallback();
    const result = compactOutput(f.receipt, 'read-dm', '@alex.example');
    expect(result.lookup).toEqual(f.receipt.target.lookup);
    expect(result.conversation.id).toBe(f.id);
    expect(result.messages).toHaveLength(1);
    f.receipt.target.requested = f.name;
    f.receipt.target.lookup.query = f.name;
    expect(compactOutput(f.receipt, 'read-dm', f.name).lookup.query).toBe(f.name);
  });
  test('rejects wrong-person, wrong-query, wrong-ID and unproven uniqueness evidence', () => {
    for (const mutate of [
      (f) => {
        f.receipt.target.lookup.query = 'Other';
      },
      (f) => {
        f.receipt.target.lookup.conversationId = 'DOTHER';
      },
      (f) => {
        f.receipt.target.lookup.exactMatchCount = 2;
      },
      (f) => {
        f.receipt.target.lookup.exactMatchCount = true;
      },
      (f) => {
        f.receipt.target.lookup.source = 'sidebar';
      },
      (f) => {
        f.receipt.target.requested = '@other';
      },
      (f) => {
        f.receipt.target.handle = '@other';
      },
    ]) {
      const f = fallback();
      mutate(f);
      expect(() => compactOutput(f.receipt, 'read-dm', '@alex.example')).toThrow(
        'Direct DM fallback'
      );
    }
  });
});
