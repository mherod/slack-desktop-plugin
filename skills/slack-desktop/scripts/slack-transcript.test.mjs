import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractMedia } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import { rememberMediaReferences, resolveMedia } from './slack-read-media.mjs';
import { selectTranscriptCandidate, transcriptOutput } from './slack-transcript.mjs';

// Structural examples only; no private Slack captures or transcript bodies.
function fixture({ kind = 'video', fileId = false } = {}) {
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
  const list = add(root, 'AXList', [], 'Example (channel)');
  const container = add(list, 'AXGroup', ['c-message_kit__actions']);
  const permalink = 'https://example.slack.com/archives/CDEMO/p1700000000000001';
  const timestamp = add(container, 'AXLink', ['c-timestamp'], 'Yesterday', { url: permalink });
  const media = add(
    container,
    'AXGroup',
    kind === 'video'
      ? ['p-video_message_file']
      : ['c-pillow_file_container', 'p-search_file--audio-player']
  );
  const overlay = add(
    media,
    'AXGroup',
    ['p-video_controls_overlay'],
    kind === 'video' ? 'example.mp4' : 'example.m4a'
  );
  const play = add(
    overlay,
    'AXCheckBox',
    kind === 'audio' ? ['c-audio_player_play_button'] : [],
    'Play, 10 seconds',
    { stateValue: '0' }
  );
  if (fileId)
    add(media, 'AXLink', [], 'Download example.m4a', {
      url: 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.m4a',
    });
  const control = add(
    overlay,
    'AXButton',
    [],
    kind === 'audio' ? 'View transcript for this audio' : 'View transcript'
  );
  const candidate = {
    token: 'candidate-1',
    containerIndex: container.index,
    mediaIndex: media.index,
    controlIndex: control.index,
  };
  const messageRef = 'CDEMO:1700000000.000001';
  const reference = fileId ? 'FDEMO' : messageRef + '/m1';
  const observation = () => ({
    content: { nodes, truncated: false, observedAt: '2026-01-01T00:00:00Z' },
  });
  const preflight = {
    operation: 'read-transcript',
    requested: reference,
    observations: [observation(), observation()],
    candidates: [candidate],
  };
  const source = { messageRef, permalink, author: 'Example author', provenance: [null] };
  const resolved = {
    schemaVersion: 1,
    operation: 'read-media',
    status: 'ok',
    requested: reference,
    workspace: { contextId: 'TDEMO', id: 'TDEMO' },
    view: { url: root.url, title: root.label },
    media: extractMedia(container, indexTree(nodes), { messageRef }).attachments[0],
    sources: [source],
    navigation: [],
  };
  const panelNodes = [];
  const panelAdd = (parent, role, classes, label = '') => {
    const node = {
      index: Math.max(-1, ...panelNodes.map((node) => node.index)) + 1,
      parent: parent?.index ?? null,
      role,
      classes,
      label,
      id: '',
    };
    panelNodes.push(node);
    return node;
  };
  const panel = panelAdd(null, 'AXGroup', ['p-flexpane_body', 'p-media_transcript']);
  const segment = (timestamp, text) => {
    const time = panelAdd(panel, 'AXButton', ['p-media_transcript__timestamp'], timestamp);
    const words = panelAdd(panel, 'AXButton', ['p-media_transcript__text'], text);
    return { time, words };
  };
  const first = segment('2 seconds', 'First example segment.');
  const second = segment('1 minute, 3 seconds', 'Another example segment.');
  const scroll = panelAdd(panel, 'AXGroup', ['c-scrollbar__bar']);
  const footer = panelAdd(panel, 'AXGroup', ['p-media_transcript__footer']);
  panelAdd(footer, 'AXStaticText', [], 'Generated transcripts may contain errors.');
  const receipt = {
    operation: 'read-transcript',
    requested: reference,
    status: 'ok',
    preflight,
    selection: { ...candidate },
    verification: {
      sourceMatched: true,
      panelOpened: true,
      playbackUnchanged: true,
      bindingMode: kind === 'audio' ? 'audio-popover' : 'video-active-control',
    },
    activeControl: {
      mode: kind === 'audio' ? 'audio-popover' : 'video-active-control',
      verified: true,
      enabled: kind === 'audio',
      classes: kind === 'audio' ? [] : ['c-button--disabled'],
    },
    transcript: { content: { nodes: panelNodes, truncated: false }, stable: true },
  };
  const result = {
    nodes,
    add,
    root,
    list,
    container,
    timestamp,
    media,
    overlay,
    play,
    control,
    candidate,
    reference,
    messageRef,
    source,
    resolved,
    preflight,
    panelNodes,
    panelAdd,
    panel,
    segment,
    first,
    second,
    scroll,
    footer,
    receipt,
    select: () => selectTranscriptCandidate(preflight, resolved),
    read: () => transcriptOutput(receipt, resolved),
  };
  if (kind === 'audio') makeAudioPopover(result);
  return result;
}

function makeAudioPopover(f) {
  f.panel.classes = ['p-media_transcript', 'p-media_transcript--popover'];
  const hider = f.panelAdd(f.panel, 'AXGroup', ['c-scrollbar__hider']);
  const scrollable = f.panelAdd(hider, 'AXGroup', [
    'p-media_transcript__scrollable',
    'position_relative',
    'no_bottom_padding',
  ]);
  const actions = f.panelAdd(scrollable, 'AXGroup', ['p-media_transcript__action_buttons']);
  const copy = f.panelAdd(actions, 'AXButton', ['p-media_transcript__copy_button'], 'Copy');
  const close = f.panelAdd(
    actions,
    'AXButton',
    ['p-media_transcript__close_button'],
    'Close transcript'
  );
  const heading = f.panelAdd(scrollable, 'AXHeading', [], 'Transcript (auto-generated)');
  const headingText = f.panelAdd(heading, 'AXStaticText', [], 'Transcript (auto-generated)');
  const caption = f.panelAdd(scrollable, 'AXGroup', ['caption', 'sk_foreground_max_solid']);
  const metadata = ['Example author', ' · ', 'Example date', 'Example time'].map((label) =>
    f.panelAdd(caption, 'AXStaticText', [], label)
  );
  const segments = [f.first.time, f.first.words, f.second.time, f.second.words];
  for (const segment of segments) segment.parent = scrollable.index;
  const footerChildren = f.panelNodes.filter((node) => node.parent === f.footer.index);
  f.panelNodes.splice(
    0,
    f.panelNodes.length,
    f.panel,
    hider,
    scrollable,
    actions,
    copy,
    close,
    heading,
    headingText,
    caption,
    ...metadata,
    ...segments,
    f.footer,
    ...footerChildren
  );
  Object.assign(f, {
    hider,
    scrollable,
    actions,
    copy,
    close,
    heading,
    headingText,
    caption,
    metadata,
  });
}

describe('existing transcript selection', () => {
  for (const kind of ['audio', 'video'])
    test(`binds the existing ${kind} transcript to its verified media`, () => {
      const f = fixture({ kind, fileId: kind === 'audio' });
      expect(f.select()).toEqual(f.candidate);
      expect(f.read()).toMatchObject({
        operation: 'read-transcript',
        requested: f.reference,
        media: { kind, contentRead: false },
        transcript: { contentRead: true },
        coverage: { complete: false, transcriptRead: true, mediaBytesRead: false },
      });
    });
  test('selects by observed tree order for equivalent verified source copies', () => {
    const f = fixture();
    const earlier = { ...f.candidate };
    const body = f.add(f.list, 'AXGroup', ['c-message_kit__actions']);
    f.add(body, 'AXLink', ['c-timestamp'], 'Yesterday', { url: f.source.permalink });
    const media = f.add(body, 'AXGroup', ['p-video_message_file']);
    const overlay = f.add(media, 'AXGroup', ['p-video_controls_overlay'], 'example.mp4');
    f.add(overlay, 'AXCheckBox', [], 'Play, 10 seconds', { stateValue: '0' });
    const control = f.add(overlay, 'AXButton', [], 'View transcript');
    f.preflight.candidates.unshift({
      token: 'candidate-2',
      containerIndex: body.index,
      mediaIndex: media.index,
      controlIndex: control.index,
    });
    expect(f.select()).toEqual(earlier);
  });
  for (const state of ['generatable', 'unknown'])
    test(`refuses ${state} transcript state`, () => {
      const f = fixture();
      f.resolved.media.transcript.state = state;
      expect(f.select).toThrow('No existing transcript');
    });
  test('rejects image and document media even if a transcript label exists', () => {
    for (const kind of ['image', 'document']) {
      const f = fixture();
      f.resolved.media.kind = kind;
      expect(f.select).toThrow('Only audio and video');
    }
  });
  test('rejects changed reference, media identity and unverified source', () => {
    const ref = fixture();
    ref.preflight.requested = 'FOTHER';
    expect(ref.select).toThrow('verified requested');
    const filename = fixture();
    filename.resolved.media.filename = 'different.mp4';
    expect(filename.select).toThrow('differs');
    const source = fixture();
    source.resolved.sources[0].permalink =
      'https://example.slack.com/archives/CDEMO/p1700000000000002';
    expect(source.select).toThrow('No existing transcript control');
  });
  test('rejects a different captured workspace or view despite matching media', () => {
    const workspace = fixture();
    workspace.resolved.workspace.contextId = 'TOTHER';
    expect(workspace.select).toThrow('verified workspace/view');
    const view = fixture();
    view.root.label = 'Different source';
    expect(view.select).toThrow('verified workspace/view');
    const origin = fixture();
    origin.root.url = origin.resolved.view.url = 'https://example.org/client/TDEMO/CDEMO';
    expect(origin.select).toThrow('verified workspace/view');
  });
  test('does not substitute a quoted timestamp for the enclosing source', () => {
    const f = fixture();
    const quote = f.add(f.container, 'AXGroup', ['c-message_attachment']);
    f.timestamp.parent = quote.index;
    expect(f.select).toThrow('No existing transcript control');
  });
  test('refuses ambiguous existing controls and any simultaneous generation control', () => {
    for (const label of ['View transcript', 'Generate transcript']) {
      const f = fixture();
      f.add(f.overlay, 'AXButton', [], label);
      expect(f.select).toThrow();
    }
  });
  test('does not use a nested media or composer control as the selected action', () => {
    const nested = fixture();
    const root = nested.add(nested.media, 'AXGroup', ['p-video_message_file']);
    nested.control.parent = root.index;
    expect(nested.select).toThrow();
    const composer = fixture();
    const box = composer.add(composer.container, 'AXTextArea', [], 'Draft');
    composer.media.parent = box.index;
    expect(composer.select).toThrow('No existing transcript control');
  });
  test('rejects a control outside its declared media ancestry', () => {
    const f = fixture();
    f.control.parent = f.container.index;
    expect(f.select).toThrow('ancestry');
  });
  for (const field of ['mediaIndex', 'containerIndex', 'controlIndex'])
    test(`rejects malformed ${field}`, () => {
      const f = fixture();
      f.candidate[field] = -1;
      expect(f.select).toThrow('malformed');
    });
  test('rejects duplicate tokens or control identities before choosing', () => {
    const token = fixture();
    token.preflight.candidates.push({ ...token.candidate, controlIndex: token.play.index });
    expect(token.select).toThrow('duplicated');
    const control = fixture();
    control.preflight.candidates.push({ ...control.candidate, token: 'candidate-2' });
    expect(control.select).toThrow('duplicated');
  });
  test('rejects truncated or missing second observations', () => {
    const partial = fixture();
    partial.preflight.observations[1].content.truncated = true;
    expect(partial.select).toThrow('incomplete');
    const missing = fixture();
    missing.preflight.observations.pop();
    expect(missing.select).toThrow('two verified');
  });
});

describe('transcript content verification', () => {
  const wrapSegments = (f) => {
    const hider = f.panelAdd(f.panel, 'AXGroup', ['c-scrollbar__hider']);
    for (const node of [f.first.time, f.first.words, f.second.time, f.second.words])
      node.parent = hider.index;
    // AX order follows the nodes array; place the hider before the footer.
    f.panelNodes.splice(f.panelNodes.indexOf(hider), 1);
    f.panelNodes.splice(1, 0, hider);
    return hider;
  };
  test('reads one direct scrollbar hider without changing segment text or order', () => {
    const f = fixture(),
      before = f.read().transcript;
    wrapSegments(f);
    expect(f.read().transcript).toEqual(before);
    expect(f.read().coverage.complete).toBe(false);
  });
  test('refuses multiple, nested or non-group transcript hiders', () => {
    const multiple = fixture();
    wrapSegments(multiple);
    multiple.panelAdd(multiple.panel, 'AXGroup', ['c-scrollbar__hider']);
    expect(multiple.read).toThrow('ambiguous');
    const nested = fixture(),
      hider = wrapSegments(nested);
    const wrapper = nested.panelAdd(nested.panel, 'AXGroup', ['unknown-wrapper']);
    hider.parent = wrapper.index;
    expect(nested.read).toThrow('nested ancestry');
    const role = fixture();
    wrapSegments(role).role = 'AXScrollArea';
    expect(role.read).toThrow('nested ancestry');
  });
  test('refuses mixed direct and wrapped transcript segments', () => {
    const f = fixture();
    wrapSegments(f);
    f.first.time.parent = f.panel.index;
    expect(f.read).toThrow('mix direct');
  });
  test('refuses unknown children or another wrapper inside the hider', () => {
    const unknown = fixture(),
      hider = wrapSegments(unknown);
    unknown.panelAdd(hider, 'AXGroup', ['unknown-wrapper']);
    expect(unknown.read).toThrow('unsupported structure');
    const nested = fixture(),
      parent = wrapSegments(nested);
    const wrapper = nested.panelAdd(parent, 'AXGroup', ['unknown-wrapper']);
    nested.first.time.parent = wrapper.index;
    nested.first.words.parent = wrapper.index;
    expect(nested.read).toThrow('unsupported structure');
  });
  test('keeps pair and timestamp guards inside the supported hider', () => {
    const unpaired = fixture();
    wrapSegments(unpaired);
    unpaired.first.words.classes = ['p-media_transcript__timestamp'];
    expect(unpaired.read).toThrow('Unpaired');
    const order = fixture();
    wrapSegments(order);
    order.second.time.label = '1 second';
    expect(order.read).toThrow('out of order');
  });
  test('preserves observed timestamp labels and segment order without footer text', () => {
    const f = fixture();
    expect(f.read().transcript).toEqual({
      contentRead: true,
      segments: [
        { timestamp: '2 seconds', text: 'First example segment.' },
        { timestamp: '1 minute, 3 seconds', text: 'Another example segment.' },
      ],
      text: 'First example segment.\nAnother example segment.',
    });
    expect(f.read().coverage).toMatchObject({
      complete: false,
      segmentCount: 2,
      firstTimestamp: '2 seconds',
      lastTimestamp: '1 minute, 3 seconds',
    });
    expect(JSON.stringify(f.read())).not.toContain('Generated transcripts may contain errors');
  });
  for (const field of ['sourceMatched', 'panelOpened', 'playbackUnchanged'])
    test(`requires explicit ${field} evidence`, () => {
      const f = fixture();
      f.receipt.verification[field] = false;
      expect(f.read).toThrow('not verified');
    });
  test('requires a stable panel and exact selected native identity', () => {
    const stable = fixture();
    stable.receipt.transcript.stable = false;
    expect(stable.read).toThrow('not verified');
    for (const field of ['token', 'mediaIndex', 'containerIndex', 'controlIndex']) {
      const f = fixture();
      f.receipt.selection[field] = field === 'token' ? 'wrong-token' : 999;
      expect(f.read).toThrow('selected control');
    }
  });
  test('rejects an unrelated or truncated panel', () => {
    const root = fixture();
    root.panel.classes = [];
    expect(root.read).toThrow('transcript panel');
    const truncated = fixture();
    truncated.receipt.transcript.content.truncated = true;
    expect(truncated.read).toThrow('incomplete');
  });
  test('rejects generation, nested panel and draft structures', () => {
    const generation = fixture();
    generation.panelAdd(generation.panel, 'AXButton', [], 'Generate transcript');
    expect(generation.read).toThrow('unsupported structure');
    const nested = fixture();
    nested.panelAdd(nested.footer, 'AXGroup', ['p-media_transcript']);
    expect(nested.read).toThrow('one verified');
    const composer = fixture();
    composer.panelAdd(composer.footer, 'AXTextArea', [], 'Private draft');
    expect(composer.read).toThrow('text-entry');
  });
  test('rejects unpaired and empty transcript text', () => {
    const time = fixture();
    time.first.words.classes = [];
    expect(time.read).toThrow();
    const text = fixture();
    text.first.time.classes = ['p-media_transcript__text'];
    expect(text.read).toThrow('lacks its timestamp');
    const empty = fixture();
    empty.first.words.label = ' ';
    expect(empty.read).toThrow('unavailable');
  });
  test('rejects nested transcript segments and segments after the footer', () => {
    const nested = fixture();
    nested.second.words.parent = nested.footer.index;
    expect(nested.read).toThrow();
    const footer = fixture();
    footer.segment('2 minutes', 'Too late');
    expect(footer.read).toThrow('misplaced');
  });
  test('retains equal timestamp boundaries but rejects decreasing or unsupported labels', () => {
    const equal = fixture();
    equal.second.time.label = '2 seconds';
    expect(equal.read().transcript.segments).toHaveLength(2);
    for (const label of [
      '1 second',
      'yesterday',
      '2 seconds 1 minute',
      '1 second, 2 seconds',
      '1:60',
    ]) {
      const f = fixture();
      f.second.time.label = label;
      expect(f.read).toThrow('out of order');
    }
  });
  test('accepts supported observed clock labels without converting output', () => {
    const f = fixture();
    f.first.time.label = '0:02';
    f.second.time.label = '01:03';
    expect(f.read().transcript.segments[1].timestamp).toBe('01:03');
  });
  test('fails closed on a stopped or wrong-reference receipt', () => {
    const stopped = fixture();
    stopped.receipt.status = 'stopped';
    expect(stopped.read).toThrow('does not match');
    const wrong = fixture();
    wrong.receipt.requested = 'FOTHER';
    expect(wrong.read).toThrow('does not match');
  });
});

describe('audio transcript popovers', () => {
  const withScrollbar = () => {
    const f = fixture({ kind: 'audio' });
    f.panelNodes.splice(f.panelNodes.indexOf(f.footer), 0, f.scroll);
    return f;
  };
  test('reads only segment pairs from the observed scrollable layout', () => {
    const f = fixture({ kind: 'audio', fileId: true });
    const result = f.read();
    expect(result.transcript.segments).toEqual([
      { timestamp: '2 seconds', text: 'First example segment.' },
      { timestamp: '1 minute, 3 seconds', text: 'Another example segment.' },
    ]);
    expect(JSON.stringify(result.transcript)).not.toMatch(
      /Copy|Close transcript|auto-generated|Example author|Example date|Example time/
    );
    expect(result.coverage).toMatchObject({
      complete: false,
      transcriptRead: true,
      mediaBytesRead: false,
    });
  });
  test('accepts one empty scrollbar between the hider and footer', () => {
    const f = withScrollbar();
    expect(f.read().transcript).toEqual(fixture({ kind: 'audio' }).read().transcript);
  });
  test('rejects malformed, extra or reordered audio scrollbar containers', () => {
    for (const change of [
      (f) => {
        f.scroll.role = 'AXButton';
      },
      (f) => {
        f.scroll.classes = ['unknown-scrollbar'];
      },
      (f) => {
        f.panelAdd(f.panel, 'AXGroup', ['c-scrollbar__bar']);
      },
      (f) => {
        f.panelNodes.splice(f.panelNodes.indexOf(f.scroll), 1);
        f.panelNodes.splice(f.panelNodes.indexOf(f.hider), 0, f.scroll);
      },
      (f) => {
        f.panelNodes.splice(f.panelNodes.indexOf(f.scroll), 1);
        f.panelNodes.push(f.scroll);
      },
      (f) => {
        f.panelAdd(f.scroll, 'AXGroup', ['unknown-wrapper']);
      },
      (f) => {
        f.panelAdd(f.scroll, 'AXButton', ['p-media_transcript__timestamp'], '2 seconds');
      },
    ]) {
      const f = withScrollbar();
      change(f);
      expect(f.read).toThrow('outer structure');
    }
  });
  test('requires the explicit native source binding appropriate to each media kind', () => {
    for (const kind of ['audio', 'video']) {
      for (const change of [
        (f) => {
          delete f.receipt.verification.bindingMode;
        },
        (f) => {
          f.receipt.activeControl.mode = 'other';
        },
        (f) => {
          f.receipt.activeControl.verified = false;
        },
        (f) => {
          f.receipt.activeControl.enabled = !f.receipt.activeControl.enabled;
        },
        (f) => {
          f.receipt.activeControl.classes = kind === 'audio' ? ['c-button--disabled'] : [];
        },
        (f) => {
          f.panel.classes =
            kind === 'audio'
              ? ['p-media_transcript']
              : ['p-media_transcript', 'p-media_transcript--popover'];
        },
      ]) {
        const f = fixture({ kind });
        change(f);
        expect(f.read).toThrow('media-specific source binding');
      }
    }
  });
  test('rejects missing, multiple or nested scrollable containers', () => {
    const missing = fixture({ kind: 'audio' });
    missing.scrollable.classes = ['unknown'];
    expect(missing.read).toThrow('one direct scrollable');
    const multiple = fixture({ kind: 'audio' });
    multiple.panelAdd(multiple.hider, 'AXGroup', ['p-media_transcript__scrollable']);
    expect(multiple.read).toThrow('one direct scrollable');
    const nested = fixture({ kind: 'audio' });
    const wrapper = nested.panelAdd(nested.hider, 'AXGroup', ['unknown-wrapper']);
    nested.scrollable.parent = wrapper.index;
    expect(nested.read).toThrow('one direct scrollable');
  });
  test('rejects mixed direct content and unexpected outer children', () => {
    const mixed = fixture({ kind: 'audio' });
    mixed.first.time.parent = mixed.panel.index;
    expect(mixed.read).toThrow('mix direct');
    const outer = fixture({ kind: 'audio' });
    outer.panelAdd(outer.panel, 'AXGroup', ['unknown-wrapper']);
    expect(outer.read).toThrow('outer structure');
  });
  test('requires exactly the two known header actions without activating either', () => {
    const extra = fixture({ kind: 'audio' });
    extra.panelAdd(extra.actions, 'AXButton', [], 'Play');
    expect(extra.read).toThrow('action controls');
    const changed = fixture({ kind: 'audio' });
    changed.copy.label = 'Generate transcript';
    expect(changed.read).toThrow('action controls');
    const nested = fixture({ kind: 'audio' });
    const wrapper = nested.panelAdd(nested.actions, 'AXGroup', ['unknown-wrapper']);
    nested.close.parent = wrapper.index;
    expect(nested.read).toThrow('action controls');
    const hidden = fixture({ kind: 'audio' });
    hidden.panelAdd(hidden.copy, 'AXButton', [], 'Another action');
    expect(hidden.read).toThrow('action controls');
  });
  test('requires the observed heading and plain caption metadata', () => {
    const title = fixture({ kind: 'audio' });
    title.heading.label = 'Other transcript';
    expect(title.read).toThrow('title');
    const metadata = fixture({ kind: 'audio' });
    metadata.metadata[0].role = 'AXButton';
    expect(metadata.read).toThrow('metadata header');
    const hidden = fixture({ kind: 'audio' });
    hidden.first.time.parent = hidden.caption.index;
    expect(hidden.read).toThrow('metadata header');
  });
  test('rejects segment wrappers and retained pair/order failures', () => {
    const wrapped = fixture({ kind: 'audio' });
    const wrapper = wrapped.panelAdd(wrapped.scrollable, 'AXGroup', ['unknown-wrapper']);
    wrapped.first.time.parent = wrapper.index;
    wrapped.first.words.parent = wrapper.index;
    expect(wrapped.read).toThrow('segment wrappers');
    const pair = fixture({ kind: 'audio' });
    pair.first.words.classes = ['p-media_transcript__timestamp'];
    expect(pair.read).toThrow('Unpaired');
    const order = fixture({ kind: 'audio' });
    order.second.time.label = '1 second';
    expect(order.read).toThrow('out of order');
  });
  test('does not admit transcript segments hidden in the footer', () => {
    const f = fixture({ kind: 'audio' });
    f.second.words.parent = f.footer.index;
    expect(f.read).toThrow();
  });
});

describe('responsive video reference boundaries', () => {
  const compact = (f) => {
    const tree = indexTree(f.nodes);
    const container = tree.nodes.find((node) => node.index === f.container.index);
    return {
      workspace: f.resolved.workspace,
      view: f.resolved.view,
      messages: [
        {
          permalink: f.source.permalink,
          attachments: extractMedia(container, tree, { messageRef: f.messageRef }).attachments,
        },
      ],
    };
  };
  const inspected = (observation) => ({
    operation: 'read-media',
    observations: [observation, structuredClone(observation)],
  });
  const expanded = ({ fileId = false } = {}) => {
    const f = fixture();
    f.overlay.classes.push('p-video_controls_overlay--design_polish');
    const speed = f.add(f.overlay, 'AXComboBox', ['c-select_button'], 'Speed', {
      stateValue: '1x',
      AXValue: '1x',
    });
    f.add(speed, 'AXStaticText', [], '1x');
    if (fileId) {
      const caption = f.add(f.overlay, 'AXGroup', ['sr-only'], '', {
        id: 'caption-description-FEXPANDED',
      });
      f.add(caption, 'AXStaticText', [], 'Captions are now available for this video.');
    }
    f.add(
      f.overlay,
      'AXCheckBox',
      ['p-video_controls_overlay__controls__caption'],
      'Turn on captions',
      { stateValue: '0' }
    );
    return f;
  };

  test('neutral responsive controls do not change the preflight attachment identity', () => {
    const before = fixture();
    before.overlay.classes.push('p-video_controls_overlay--design_polish_compact');
    before.add(
      before.overlay,
      'AXPopUpButton',
      ['p-video_controls_overlay__controls__button--overflow'],
      'Settings'
    );
    const after = expanded();
    expect(compact(after).messages[0].attachments).toEqual(compact(before).messages[0].attachments);
    expect(selectTranscriptCandidate(after.preflight, before.resolved)).toEqual(after.candidate);
  });

  test('newly exposed caption identity does not rewrite the verified in-flight reference', () => {
    const before = fixture();
    const beforeBinding = JSON.stringify(before.resolved);
    const after = expanded({ fileId: true });
    const observed = compact(after).messages[0].attachments[0];
    expect(observed).toMatchObject({
      fileId: 'FEXPANDED',
      ref: 'FEXPANDED',
      referenceScope: 'workspace-file',
    });
    expect(observed.displayedDuration).toBe(before.resolved.media.displayedDuration);
    expect(observed.filename).toBe(before.resolved.media.filename);
    const result = before.read();
    expect(result.requested).toBe(before.reference);
    expect(result.media).toMatchObject({
      fileId: null,
      ref: before.reference,
      referenceScope: 'message-media',
    });
    expect(JSON.stringify(before.resolved)).toBe(beforeBinding);
    expect(() => selectTranscriptCandidate(after.preflight, before.resolved)).toThrow(
      'No existing transcript control'
    );
    before.receipt.verification.sourceMatched = false;
    expect(before.read).toThrow('was not verified');
  });

  test('positional transcript JSON adds a refresh route without changing source routes or file references', () => {
    const positional = fixture();
    const sourceRoute = { command: 'read-thread', args: [positional.messageRef] };
    positional.resolved.navigation = [sourceRoute];
    expect(positional.read().navigation).toEqual([sourceRoute, { command: 'inspect', args: [] }]);
    expect(positional.resolved.navigation).toEqual([sourceRoute]);
    positional.resolved.navigation.push({ command: 'inspect', args: [] });
    expect(positional.read().navigation).toEqual(positional.resolved.navigation);
    const file = fixture({ fileId: true });
    file.resolved.navigation = [sourceRoute];
    expect(file.read().navigation).toEqual([sourceRoute]);
    expect(file.read().media.ref).toBe('FDEMO');
  });

  test('future reads refresh newly exposed IDs and never accept changed cached durations', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'slack-transcript-reference-boundary-'));
    try {
      const before = fixture();
      const observation = compact(before);
      const bindings = await rememberMediaReferences(path.join(folder, 'references.json'), [
        observation,
      ]);
      const resolved = resolveMedia(inspected(observation), before.reference, bindings);
      expect(selectTranscriptCandidate(before.preflight, resolved)).toEqual(before.candidate);
      const after = compact(expanded({ fileId: true }));
      expect(() => resolveMedia(inspected(after), before.reference, bindings)).toThrow(
        'not exposed'
      );
      expect(resolveMedia(inspected(after), 'FEXPANDED', bindings).media.fileId).toBe('FEXPANDED');
      const changed = structuredClone(observation);
      changed.messages[0].attachments[0].displayedDuration = '20 seconds';
      expect(() => resolveMedia(inspected(changed), before.reference, bindings)).toThrow(
        'order or identity changed'
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
