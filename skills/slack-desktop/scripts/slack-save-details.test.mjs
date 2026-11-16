import { describe, expect, test } from 'bun:test';
import { parseFilePageURL } from './slack-file-page.mjs';
import { extractMedia } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import { selectSaveMediaAction, selectViewerDownloadCandidate } from './slack-save-viewer.mjs';
import { runSaveMedia } from './slack-save-protocol.mjs';
import { failedSaveMediaOutput, viewerSaveState } from './slack-save-runner.mjs';
import { foregroundEvidence } from './slack-interaction.mjs';
import { formatOutput } from './slack-format.mjs';
import {
  savedMediaOutput,
  saveMediaSelectionOutput,
  verifySavePhase,
} from './slack-save-media.mjs';

function builder() {
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
  return { nodes, add };
}
function fixture(kind = 'file', page = true) {
  const f = builder();
  f.filePageURL = 'https://example.slack.com/files/UDEMO/FDEMO/example.pdf?origin_team=EDEMO';
  f.downloadURL = page
    ? 'https://files.slack.com/files-pri/TOWNER-FDEMO/download/example.pdf?origin_team=EDEMO'
    : 'https://files.slack.com/files-tmb/TOWNER-FDEMO-variant/example.mp4';
  f.root = f.add(null, 'AXWebArea', [], 'Example', {
    url: 'https://app.slack.com/client/EDEMO/CDEMO',
  });
  f.container = f.add(f.root, 'AXGroup', ['c-message_kit__actions']);
  const permalink = 'https://example.slack.com/archives/CDEMO/p1700000000000001';
  f.add(f.container, 'AXLink', ['c-timestamp'], 'Yesterday', { url: permalink });
  const classes =
    kind === 'audio'
      ? ['c-pillow_file_container', 'p-search_file--audio-player']
      : kind === 'video'
        ? ['p-video_message_file']
        : ['c-pillow_file_container', 'p-message_file'];
  f.media = f.add(f.container, 'AXGroup', classes, 'Example');
  f.page = page
    ? f.add(f.media, 'AXLink', ['p-file_link_button--link'], 'example.pdf', { url: f.filePageURL })
    : null;
  if (kind === 'file') f.add(f.media, 'AXStaticText', [], 'PDF');
  if (kind === 'audio' || kind === 'video') {
    f.play = f.add(
      f.media,
      'AXCheckBox',
      kind === 'audio'
        ? ['c-audio_player_play_button']
        : ['p-video_controls_overlay__controls__pill'],
      kind === 'audio' ? 'Play' : 'Play, 5 seconds',
      { stateValue: '0' }
    );
    f.identity = f.add(f.media, 'AXGroup', ['sr-only'], '', {
      id: `${kind === 'audio' ? 'transcript' : 'caption'}-description-FDEMO`,
    });
  }
  f.actions = f.add(f.media, 'AXGroup', ['c-file__actions']);
  f.control = f.add(f.actions, 'AXButton', ['c-message_actions__button'], 'View file details');
  f.opener = {
    token: 'details-opener',
    scope: 'file-details-opener',
    containerIndex: f.container.index,
    mediaIndex: f.media.index,
    controlIndex: f.control.index,
    filePageIndex: f.page?.index ?? null,
    filePageURL: page ? f.filePageURL : null,
    fileId: 'FDEMO',
    mediaKind: kind,
    openerKind: 'details-button',
  };
  f.resolved = {
    status: 'ok',
    operation: 'read-media',
    requested: 'FDEMO',
    workspace: { contextId: 'EDEMO', id: 'EDEMO' },
    view: { title: f.root.label, url: f.root.url },
    sources: [{ messageRef: 'CDEMO:1700000000.000001', permalink }],
    navigation: [],
  };
  f.refresh = () => {
    f.resolved.media = extractMedia(f.container, indexTree(f.nodes), {
      messageRef: f.resolved.sources[0].messageRef,
    }).attachments[0];
    f.preflight = {
      operation: 'save-media',
      phase: 'select',
      requested: 'FDEMO',
      pid: 123,
      observations: [0, 1].map(() => ({
        content: { nodes: structuredClone(f.nodes), truncated: false },
      })),
      candidates: [],
      viewerCandidates: [structuredClone(f.opener)],
    };
  };
  f.refresh();
  const v = builder();
  v.pane = v.add(null, 'AXGroup', ['p-view_contents', 'p-view_contents--secondary']);
  v.header = v.add(v.pane, 'AXToolbar', ['p-flexpane_header']);
  v.close = v.add(v.header, 'AXButton', ['p-flexpane_header__control'], 'Close');
  v.body = v.add(v.pane, 'AXGroup', ['p-flexpane__body']);
  v.card = v.add(v.body, 'AXGroup', [
    'c-pillow_file_container',
    'p-message_file',
    ...(kind === 'audio' ? ['p-message_file--audio_message'] : []),
  ]);
  v.page = page
    ? v.add(v.card, 'AXLink', ['p-file_link_button--link'], 'example.pdf', { url: f.filePageURL })
    : null;
  if (kind === 'audio') {
    v.play = v.add(v.card, 'AXCheckBox', ['c-audio_player_play_button'], 'Play', {
      stateValue: '0',
    });
    v.identity = v.add(v.card, 'AXGroup', ['sr-only'], '', { id: 'transcript-description-FDEMO' });
  } else if (!page)
    v.identity = v.add(v.card, 'AXGroup', ['sr-only'], '', { id: 'caption-description-FDEMO' });
  v.footer = v.add(v.pane, 'AXGroup', ['c-file__actions', 'p-file_details__references_footer']);
  v.download = v.add(
    v.footer,
    'AXLink',
    ['p-file_details__references_actions', 'c-message_actions__button'],
    'Download example.pdf',
    { url: f.downloadURL }
  );
  f.viewer = v;
  f.candidate = {
    token: 'details-download',
    scope: 'file-details',
    openerToken: f.opener.token,
    paneIndex: 0,
    cardIndex: v.card.index,
    fileLinkIndex: v.page?.index ?? null,
    identityIndex: (v.page ?? v.identity).index,
    footerIndex: v.footer.index,
    controlIndex: v.download.index,
    filePageURL: page ? f.filePageURL : null,
    fileId: 'FDEMO',
    mediaKind: kind,
    openerKind: 'details-button',
    url: f.downloadURL,
    routeKind: page ? 'file-download' : 'rendition',
  };
  f.playback = {
    source: f.play ? [{ label: f.play.label, value: f.play.stateValue }] : [],
    viewer: v.play ? [{ label: v.play.label, value: v.play.stateValue }] : [],
  };
  f.refreshViewer = () => {
    const nodes = [f.container, ...indexTree(f.nodes).descendants(f.container)];
    const positions = new Map(nodes.map((node, i) => [node.index, i]));
    const source = nodes.map((node, i) => ({
      ...structuredClone(node),
      index: i,
      parent: i ? positions.get(node.parent) : null,
    }));
    f.viewerPreflight = {
      operation: 'save-media',
      phase: 'viewer-select',
      requested: 'FDEMO',
      pid: 123,
      opener: structuredClone(f.opener),
      detailsMenuAction: {
        attempted: false,
        accepted: false,
        detailsAttempted: false,
        detailsAccepted: false,
        closed: false,
      },
      candidates: [structuredClone(f.candidate)],
      observations: [0, 1].map(() => ({
        before: { ...f.resolved.view },
        after: { ...f.resolved.view },
        source: {
          content: { nodes: structuredClone(source), truncated: false },
          mediaIndex: positions.get(f.media.index),
          controlIndex: positions.get(f.control.index),
          filePageIndex: f.page ? positions.get(f.page.index) : null,
        },
        content: { nodes: structuredClone(v.nodes), truncated: false },
        detailsPlayback: structuredClone(f.playback),
      })),
    };
  };
  f.refreshViewer();
  f.select = (options) =>
    selectViewerDownloadCandidate(
      f.viewerPreflight,
      f.preflight,
      f.resolved,
      selectSaveMediaAction(f.preflight, f.resolved),
      options
    );
  return f;
}

function nativeAudioFixture(page = false) {
  const f = fixture('audio', page);
  f.media.classes = ['c-pillow_file_container', 'p-message_file', 'p-message_file--audio_message'];
  f.refresh();
  f.refreshViewer();
  return f;
}

function menuFixture() {
  const f = fixture('video', false);
  f.media.classes.push('p-video_message_file--gallery_v3');
  f.actions.classes = ['p-video_controls_overlay'];
  f.control.role = 'AXGroup';
  f.control.label = '';
  f.control.classes = [
    'p-video_controls_overlay__corner',
    'p-video_controls_overlay__corner--gallery_v3',
  ];
  f.corner = f.control;
  for (const label of ['View transcript', 'Expand', 'Dock to corner'])
    f.add(f.corner, 'AXButton', ['c-icon_button'], label);
  f.control = f.add(
    f.corner,
    'AXPopUpButton',
    [
      'p-video_message_file--gallery_v3__controls_overlay_ellipsis',
      'p-video_controls_overlay__corner_button',
    ],
    'More actions'
  );
  f.volume = f.add(f.actions, 'AXGroup', [
    'p-media_volume_slider',
    'p-media_volume_slider--popover',
  ]);
  Object.assign(f.opener, { controlIndex: f.control.index, openerKind: 'video-menu' });
  f.candidate.openerKind = 'video-menu';
  f.viewer.card.classes = ['p-video_message_file', 'p-video_message_file--gallery_v3'];
  f.viewer.play = f.viewer.add(
    f.viewer.card,
    'AXCheckBox',
    ['p-video_controls_overlay__controls__pill'],
    'Play, 5 seconds',
    { stateValue: '0' }
  );
  f.playback.viewer = [{ label: f.viewer.play.label, value: '0' }];
  f.refresh();
  f.refreshViewer();
  f.viewerPreflight.detailsMenuAction = {
    attempted: true,
    accepted: true,
    detailsAttempted: true,
    detailsAccepted: true,
    closed: true,
  };
  const base = f.viewerPreflight.observations[0].source;
  const nodes = structuredClone(base.content.nodes);
  const popup = nodes.find((node) => node.index === base.controlIndex),
    corner = nodes.find((node) => node.index === popup.parent);
  const overlay = nodes.find((node) => node.index === corner.parent);
  overlay.classes.push('p-video_controls_overlay--active');
  const add = (parent, role, classes, label = '') => {
    const node = { index: nodes.length, parent: parent.index, role, classes, label, id: '' };
    nodes.push(node);
    return node;
  };
  const popover = add(corner, 'AXGroup', [
    'ReactModal__Content',
    'ReactModal__Content--after-open',
    'popover',
    'c-popover__content',
  ]);
  const menu = add(popover, 'AXMenu', ['c-menu__items']);
  let details;
  for (const label of [
    'Download',
    'Share file…',
    'Copy link',
    null,
    'Open in',
    'View details',
    null,
    'Add to section',
  ]) {
    const item = add(
      menu,
      label ? 'AXMenuItem' : 'AXSplitter',
      label ? ['c-menu_item__button'] : [],
      label ?? ''
    );
    if (label) add(add(item, 'AXGroup', ['c-menu_item__label']), 'AXStaticText', [], label);
    if (label === 'View details') details = item;
  }
  const cornerNodes = [corner, ...indexTree(nodes).descendants(corner)];
  const local = new Map(cornerNodes.map((node, i) => [node.index, i]));
  const content = {
    truncated: false,
    nodes: cornerNodes.map((node, i) => ({
      ...structuredClone(node),
      index: i,
      parent: i ? local.get(node.parent) : null,
    })),
  };
  f.viewerPreflight.detailsMenu = {
    observations: [0, 1].map(() => ({
      source: {
        ...structuredClone(base),
        content: { truncated: false, nodes: structuredClone(nodes) },
        playback: structuredClone(f.playback.source),
      },
      content: structuredClone(content),
      menuIndex: local.get(menu.index),
      controlIndex: local.get(details.index),
      openerIndex: local.get(popup.index),
    })),
  };
  return f;
}

function searchVideoFixture(position = 3) {
  const f = fixture('video', true);
  const metadata = { AXTitle: '', AXDescription: '', AXValue: '', AXHelp: '' };
  const videoClasses = [
    'p-video_message_file',
    'p-video_message_file--gallery_v3',
    'c-search_message__media_item',
  ];
  Object.assign(f.container, metadata, {
    classes: [
      'c-message_kit__actions',
      'c-message_kit__actions--above',
      'c-search_message__actions_container--ia4',
    ],
  });
  f.media.classes = [...videoClasses];
  const original = [...f.nodes];
  const header = f.add(
    f.container,
    'AXGroup',
    ['c-search_message__content_header', 'c-search_message__content_header--compact'],
    '',
    metadata
  );
  const timestamp = original.find((node) => node.classes.includes('c-timestamp'));
  timestamp.parent = header.index;
  const rich = f.add(f.container, 'AXGroup', ['p-rich_text_section'], '', metadata);
  const text = f.add(rich, 'AXStaticText', [], 'Preserved message body');
  const nested = f.add(
    rich,
    'AXButton',
    ['c-button-unstyled', 'c-search__expand'],
    'Nested expand'
  );
  const link = f.add(rich, 'AXLink', [], 'Body link', { url: 'https://example.test/body' });
  const siblings = [];
  for (let i = 0; i < 2; i++) {
    const media = f.add(f.container, 'AXGroup', [...videoClasses], `Other video ${i}`);
    const identity = f.add(media, 'AXGroup', ['sr-only'], '', {
      id: `caption-description-FOTHER${i}`,
    });
    const play = f.add(
      media,
      'AXCheckBox',
      ['p-video_controls_overlay__controls__pill'],
      'Play, 5 seconds',
      { stateValue: '0' }
    );
    siblings.push([media, identity, play]);
  }
  const selectedRows = original.filter((node) => ![f.root, f.container, timestamp].includes(node));
  siblings.splice(position - 1, 0, selectedRows);
  f.nodes.splice(
    0,
    f.nodes.length,
    f.root,
    f.container,
    header,
    timestamp,
    rich,
    text,
    nested,
    link,
    ...siblings.flat()
  );
  f.refresh();
  f.resolved.media = extractMedia(f.container, indexTree(f.nodes), {
    messageRef: f.resolved.sources[0].messageRef,
  }).attachments.find((media) => media.fileId === 'FDEMO');
  f.refreshViewer();
  for (const capture of f.viewerPreflight.observations) {
    const rows = capture.source.content.nodes;
    const root = rows[0];
    const rich = rows.find((node) => node.classes.includes('p-rich_text_section'));
    const videos = rows.filter(
      (node) => node.parent === 0 && node.classes.includes('p-video_message_file')
    );
    const wrapper = {
      index: rows.length,
      parent: 0,
      role: 'AXGroup',
      id: '',
      label: '',
      classes: ['c-search_message__body--card_clamp', 'c-search_message__body--card_clipped'],
      ...metadata,
    };
    const button = {
      index: rows.length + 1,
      parent: 0,
      role: 'AXButton',
      id: '',
      label: '... Show more',
      classes: ['c-button-unstyled', 'c-search__expand'],
      ...metadata,
      AXTitle: '... Show more',
      selected: false,
      stateValue: '',
    };
    rich.parent = wrapper.index;
    rows.splice(rows.indexOf(rich), 0, wrapper);
    rows.splice(rows.indexOf(videos[0]), 0, button);
    const positions = new Map(rows.map((node, i) => [node.index, i]));
    for (const key of ['mediaIndex', 'controlIndex', 'filePageIndex'])
      capture.source[key] =
        capture.source[key] === null ? null : positions.get(capture.source[key]);
    capture.source.content.nodes = rows.map((node, i) => ({
      ...node,
      index: i,
      parent: node === root ? null : positions.get(node.parent),
    }));
  }
  return f;
}

describe('file-details search video source', () => {
  test('accepts the exact observed focus-visible direct Show more variant', () => {
    const f = searchVideoFixture();
    for (const capture of f.viewerPreflight.observations)
      capture.source.content.nodes.find((node) => node.label === '... Show more').classes = [
        'c-button--focus-visible',
        'c-button-unstyled',
        'c-search__expand',
      ];
    expect(f.select().fileId).toBe('FDEMO');
  });
  test.each([1, 2, 3])(
    'retains all three videos when the selected video is sibling %s',
    (position) => {
      const f = searchVideoFixture(position);
      const before = structuredClone(f.viewerPreflight);
      expect(f.select().fileId).toBe('FDEMO');
      expect(f.viewerPreflight).toEqual(before);
    }
  );
  const find = (rows, name) => rows.find((node) => node.classes.includes(name));
  test.each([
    ['unknown', 'c-button-unstyled', 'c-search__expand'],
    ['c-button-unstyled', 'c-button--focus-visible', 'c-search__expand'],
    ['c-button--focus-visible', 'c-search__expand', 'c-button-unstyled'],
    ['c-button--focus-visible', 'c-button--focus-visible', 'c-button-unstyled', 'c-search__expand'],
    ['c-button--focus-visible', 'c-search__expand'],
    ['c-button--focus-visible', 'c-button-unstyled', 'c-search__expand', 'unknown'],
  ])('rejects an unsupported direct Show more class sequence %j', (...classes) => {
    const f = searchVideoFixture();
    f.viewerPreflight.observations[1].source.content.nodes.find(
      (node) => node.label === '... Show more'
    ).classes = classes;
    expect(() => f.select()).toThrow('source changed');
  });
  test.each([
    [
      'wrapper role',
      (rows) => {
        find(rows, 'c-search_message__body--card_clamp').role = 'AXButton';
      },
    ],
    [
      'wrapper classes',
      (rows) => {
        find(rows, 'c-search_message__body--card_clamp').classes.reverse();
      },
    ],
    [
      'wrapper unknown metadata',
      (rows) => {
        find(rows, 'c-search_message__body--card_clamp').enabled = true;
      },
    ],
    [
      'wrapper nonempty help',
      (rows) => {
        find(rows, 'c-search_message__body--card_clamp').AXHelp = 'other';
      },
    ],
    [
      'wrapper missing metadata',
      (rows) => {
        delete find(rows, 'c-search_message__body--card_clamp').AXValue;
      },
    ],
    [
      'wrapper URL',
      (rows) => {
        find(rows, 'c-search_message__body--card_clamp').url = '';
      },
    ],
    [
      'rich wrapper role',
      (rows) => {
        find(rows, 'p-rich_text_section').role = 'AXButton';
      },
    ],
    [
      'direct expander title',
      (rows) => {
        rows.find((node) => node.label === '... Show more').AXTitle = 'Show more';
      },
    ],
    [
      'direct expander selected',
      (rows) => {
        rows.find((node) => node.label === '... Show more').selected = true;
      },
    ],
    [
      'direct expander unknown selected',
      (rows) => {
        delete rows.find((node) => node.label === '... Show more').selected;
      },
    ],
    [
      'direct expander state',
      (rows) => {
        rows.find((node) => node.label === '... Show more').stateValue = '1';
      },
    ],
    [
      'direct expander URL',
      (rows) => {
        rows.find((node) => node.label === '... Show more').url = 'https://example.test/other';
      },
    ],
    [
      'direct expander foreign parent',
      (rows) => {
        rows.find((node) => node.label === '... Show more').parent = find(
          rows,
          'p-rich_text_section'
        ).index;
      },
    ],
    [
      'duplicate wrapper',
      (rows) => {
        rows.push({ ...find(rows, 'c-search_message__body--card_clamp'), index: rows.length });
      },
    ],
    [
      'duplicate direct expander',
      (rows) => {
        rows.push({ ...rows.find((node) => node.label === '... Show more'), index: rows.length });
      },
    ],
    [
      'extra wrapper child',
      (rows) => {
        rows.push({
          index: rows.length,
          parent: find(rows, 'c-search_message__body--card_clamp').index,
          role: 'AXStaticText',
          classes: [],
          label: 'extra',
        });
      },
    ],
    [
      'nonleaf direct expander',
      (rows) => {
        rows.push({
          index: rows.length,
          parent: rows.find((node) => node.label === '... Show more').index,
          role: 'AXStaticText',
          classes: [],
          label: 'extra',
        });
      },
    ],
    [
      'changed rich text',
      (rows) => {
        rows.find((node) => node.label === 'Preserved message body').label = 'changed';
      },
    ],
    [
      'changed body link',
      (rows) => {
        rows.find((node) => node.label === 'Body link').url = 'https://example.test/changed';
      },
    ],
    [
      'changed nested expander',
      (rows) => {
        rows.find((node) => node.label === 'Nested expand').label = 'changed';
      },
    ],
    [
      'changed unselected file identity',
      (rows) => {
        rows.find((node) => node.id === 'caption-description-FOTHER0').id =
          'caption-description-FCHANGED';
      },
    ],
    [
      'changed unselected playback',
      (rows) => {
        rows.find((node) => node.role === 'AXCheckBox').stateValue = '1';
      },
    ],
    [
      'removed unselected file identity',
      (rows) => {
        rows.splice(
          rows.findIndex((node) => node.id === 'caption-description-FOTHER0'),
          1
        );
      },
    ],
    [
      'reordered video siblings',
      (rows) => {
        const videos = rows.filter(
          (node) => node.parent === 0 && node.classes.includes('p-video_message_file')
        );
        const first = rows.indexOf(videos[0]),
          second = rows.indexOf(videos[1]);
        [rows[first], rows[second]] = [rows[second], rows[first]];
      },
    ],
  ])('rejects %s instead of dropping source evidence', (_name, mutate) => {
    const f = searchVideoFixture();
    mutate(f.viewerPreflight.observations[1].source.content.nodes);
    expect(() => f.select()).toThrow();
  });
  test.each([
    [
      'source root metadata',
      (rows) => {
        find(rows, 'c-message_kit__actions').unknown = true;
      },
    ],
    [
      'rich wrapper metadata',
      (rows) => {
        find(rows, 'p-rich_text_section').unknown = true;
      },
    ],
    [
      'header classes',
      (rows) => {
        find(rows, 'c-search_message__content_header').classes.push('unknown');
      },
    ],
    [
      'unknown intervening video classes',
      (rows) => {
        find(rows, 'p-video_message_file').classes.push('unknown');
      },
    ],
    [
      'unknown intervening role',
      (rows) => {
        find(rows, 'p-video_message_file').role = 'AXButton';
      },
    ],
  ])('rejects matching unsupported %s in both source frames', (_name, mutate) => {
    const f = searchVideoFixture();
    for (const observation of f.preflight.observations) mutate(observation.content.nodes);
    for (const observation of f.viewerPreflight.observations)
      mutate(observation.source.content.nodes);
    expect(() => f.select()).toThrow();
  });
  test.each(['mediaIndex', 'controlIndex', 'filePageIndex'])(
    'requires the same normalized source position for %s',
    (key) => {
      const f = searchVideoFixture();
      const source = f.viewerPreflight.observations[1].source;
      source[key] =
        key === 'mediaIndex'
          ? find(source.content.nodes, 'p-video_message_file').index
          : source.content.nodes.find((node) => node.label === 'Body link').index;
      expect(() => f.select()).toThrow('source control identity changed');
    }
  );
});

describe('source-owned video menu', () => {
  test('accepts the verified closed menu and same-file idle video pane without a page', () => {
    const f = menuFixture(),
      selected = f.select();
    expect(selected.openerKind).toBe('video-menu');
    expect(selected.filePageURL).toBeNull();
    expect(selected.detailsPlayback.viewer).toEqual(f.playback.viewer);
    expect(saveMediaSelectionOutput(selected).originalSelection.status).toBe('unavailable');
  });
  test.each(['attempted', 'accepted', 'detailsAttempted', 'detailsAccepted', 'closed'])(
    'rejects incomplete menu action %s',
    (key) => {
      const f = menuFixture();
      f.viewerPreflight.detailsMenuAction[key] = false;
      expect(() => f.select()).toThrow('menu');
    }
  );
  test.each([
    [
      'missing menu capture',
      (f) => {
        f.viewerPreflight.detailsMenu.observations.pop();
      },
    ],
    [
      'foreign menu source',
      (f) => {
        f.viewerPreflight.detailsMenu.observations[1].source.content.nodes[0].label = 'Other';
      },
    ],
    [
      'different active file',
      (f) => {
        f.viewerPreflight.observations[1].content.nodes.find((n) =>
          n.id.startsWith('caption-description')
        ).id = 'caption-description-FOTHER';
      },
    ],
    [
      'playing active video',
      (f) => {
        f.viewerPreflight.observations[1].content.nodes.find(
          (n) => n.role === 'AXCheckBox'
        ).stateValue = '1';
      },
    ],
    [
      'wrong menu label',
      (f) => {
        f.viewerPreflight.detailsMenu.observations[1].content.nodes.find(
          (n) => n.label === 'View details'
        ).label = 'Download';
      },
    ],
    [
      'missing menu ownership',
      (f) => {
        f.viewerPreflight.detailsMenu.observations[1].content.nodes[0].classes = [];
      },
    ],
    [
      'unmatched source popup',
      (f) => {
        f.viewerPreflight.detailsMenu.observations[1].source.controlIndex += 1;
      },
    ],
    [
      'changed menu item',
      (f) => {
        f.viewerPreflight.detailsMenu.observations[1].content.nodes.find(
          (n) => n.label === 'Copy link'
        ).label = 'Delete';
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const f = menuFixture();
    mutate(f);
    expect(() => f.select()).toThrow();
  });
  test('normalizes only search highlights and the observed video volume orientation', () => {
    const f = menuFixture();
    for (const capture of f.viewerPreflight.observations) {
      capture.source.content.nodes[0].label = '\uE000\uE001';
      const volume = capture.source.content.nodes.find((n) =>
        n.classes.includes('p-media_volume_slider')
      );
      volume.classes = volume.classes.map((name) => name.replace('--popover', '--vertical'));
    }
    expect(() => f.select()).not.toThrow();
    f.viewerPreflight.observations[1].source.content.nodes.find((n) =>
      n.classes.includes('p-media_volume_slider')
    ).stateValue = 'changed';
    expect(() => f.select()).toThrow('source changed');
  });
  test('rejects a player card with forged empty playback evidence', () => {
    const f = menuFixture();
    for (const capture of f.viewerPreflight.observations) {
      capture.content.nodes = capture.content.nodes.filter((node) => node.role !== 'AXCheckBox');
      capture.detailsPlayback.viewer = [];
    }
    expect(() => f.select()).toThrow('playback');
  });
  test.each(['details-button', 'video-menu'])(
    'rejects competing source openers when choosing %s',
    (kind) => {
      const f = menuFixture();
      const actions = f.add(f.media, 'AXGroup', ['c-file__actions']);
      const details = f.add(
        actions,
        'AXButton',
        ['c-message_actions__button'],
        'View file details'
      );
      if (kind === 'details-button')
        Object.assign(f.opener, { openerKind: kind, controlIndex: details.index });
      f.refresh();
      expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow('Details control');
    }
  );
});

describe('canonical observed file page', () => {
  test('binds F and observed page without inventing an owner team', () => {
    expect(
      parseFilePageURL('https://example.slack.com/files/U1/F1/example.pdf?origin_team=E1', 'E1')
    ).toEqual({
      fileId: 'F1',
      filePageURL: 'https://example.slack.com/files/U1/F1/example.pdf?origin_team=E1',
      basename: 'example.pdf',
    });
  });
  test.each([
    'http://example.slack.com/files/U1/F1/a.pdf',
    'https://example.test/files/U1/F1/a.pdf',
    'https://slack.com.evil.test/files/U1/F1/a.pdf',
    'https://user@example.slack.com/files/U1/F1/a.pdf',
    'https://example.slack.com:443/files/U1/F1/a.pdf',
    'https://example.slack.com/files/U1/F1/a.pdf#x',
    'https://example.slack.com/files/U1/F1/a.pdf?origin_team=T1',
    'https://example.slack.com/files/U1/F1/a.pdf?origin_team=E1&x=y',
    'https://example.slack.com/files/U1/F1/a.pdf?origin_team=%451',
    'https://example.slack.com/files/U1/F1/..',
    'https://example.slack.com/files/U1/F1/%2F',
    'https://example.slack.com/files/U1/F1/%5c',
    'https://example.slack.com/files/U1/F1/%00',
    'https://example.slack.com/files/U1/F1/%FF',
    'https://example.slack.com/files/U1/F1',
  ])('rejects unsupported page %s', (value) =>
    expect(() => parseFilePageURL(value, 'E1')).toThrow()
  );
});

describe('source-bound file-details selection', () => {
  test.each([false, true])(
    'native audio message source keeps audio identity with page=%s',
    (page) => {
      const f = nativeAudioFixture(page);
      expect(f.resolved.media).toMatchObject({ kind: 'audio', fileId: 'FDEMO' });
      expect(f.select().mediaKind).toBe('audio');
    }
  );
  test.each([
    [
      'active Play state',
      (f) => {
        f.play.stateValue = '1';
      },
    ],
    [
      'unknown Play state',
      (f) => {
        delete f.play.stateValue;
      },
    ],
    [
      'Pause label',
      (f) => {
        f.play.label = 'Pause';
      },
    ],
    [
      'wrong Play role',
      (f) => {
        f.play.role = 'AXButton';
      },
    ],
    [
      'foreign transcript ID',
      (f) => {
        f.identity.id = 'transcript-description-FOTHER';
      },
    ],
    [
      'conflicting file identity',
      (f) => {
        f.add(f.media, 'AXGroup', ['sr-only'], '', { id: 'transcript-description-FOTHER' });
      },
    ],
  ])('native audio still rejects %s before opening', (_name, mutate) => {
    const f = nativeAudioFixture();
    mutate(f);
    f.refresh();
    f.refreshViewer();
    expect(() => f.select()).toThrow();
  });
  test.each([false, true])(
    'native audio without a details opener reports unavailable capability with page=%s',
    (page) => {
      const f = nativeAudioFixture(page);
      f.nodes.splice(f.nodes.indexOf(f.actions));
      f.refresh();
      f.preflight.viewerCandidates = [];
      expect(f.resolved.media).toMatchObject({ kind: 'audio', fileId: 'FDEMO' });
      expect(f.resolved.media).not.toHaveProperty('fileDetailsAvailable');
      expect(f.play.stateValue).toBe('0');
      expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow(
        'No supported source-owned View file details opener is available for this attachment. File-page links and playback controls alone cannot authorize saving. Locate the same attachment with search, then inspect its reference with read-media.'
      );
    }
  );
  test('quoted document file link without Download or Details reports unavailable capability', () => {
    const f = fixture();
    f.nodes.splice(f.media.index);
    const quote = f.add(f.container, 'AXGroup', [
      'c-message_attachment',
      'c-message_attachment--full_card',
    ]);
    f.add(quote, 'AXStaticText', ['c-message_attachment__author_name'], 'Example author');
    f.media = f.add(quote, 'AXGroup', [
      'c-pillow_file_container',
      'c-file_gallery__message_file',
      'p-message_file',
      'p-message_file--show_preview',
    ]);
    f.page = f.add(
      f.media,
      'AXLink',
      [
        'c-link',
        'c-link--focus-visible',
        'c-button-unstyled',
        'p-file_link_button--link',
        'c-pillow_file',
        'c-pillow_file--clickable',
        'c-pillow_file--view',
      ],
      'example.pdf PDF',
      { url: f.filePageURL }
    );
    f.add(f.page, 'AXGroup', [
      'p-file_thumbnail__container',
      'p-file_thumbnail__container--other',
      'c-file_entity_thumbnail_icon',
      'c-base_entity__avatar',
    ]);
    f.add(f.page, 'AXStaticText', [], 'example.pdf');
    f.add(f.page, 'AXStaticText', [], 'PDF');
    f.refresh();
    f.preflight.viewerCandidates = [];
    expect(f.resolved.media).toMatchObject({
      kind: 'document',
      fileId: 'FDEMO',
      downloadUrl: null,
      provenance: { kind: 'quoted' },
    });
    expect(f.resolved.media).not.toHaveProperty('fileDetailsAvailable');
    expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow(
      'No supported source-owned View file details opener is available for this attachment. File-page links and playback controls alone cannot authorize saving. Locate the same attachment with search, then inspect its reference with read-media.'
    );
  });
  test('partial Details coverage keeps the incomplete inventory diagnostic', () => {
    const f = fixture();
    const tree = indexTree(f.nodes);
    const copies = new Map();
    for (const node of [f.container, ...tree.descendants(f.container)]) {
      const { index, parent, role, classes, label, ...rest } = structuredClone(node);
      copies.set(
        index,
        f.add(parent === f.root.index ? f.root : copies.get(parent), role, classes, label, rest)
      );
    }
    const permalink = 'https://example.slack.com/archives/CDEMO/p1700000000000002';
    const timestamp = tree
      .descendants(f.container)
      .find((node) => node.classes.includes('c-timestamp'));
    copies.get(timestamp.index).url = permalink;
    f.resolved.sources.push({ messageRef: 'CDEMO:1700000000.000002', permalink });
    f.refresh();
    expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow(
      'Supported file-details opener inventory is incomplete'
    );
    f.preflight.viewerCandidates.push({
      ...f.opener,
      token: 'second-details-opener',
      containerIndex: copies.get(f.container.index).index,
      mediaIndex: copies.get(f.media.index).index,
      controlIndex: copies.get(f.control.index).index,
      filePageIndex: copies.get(f.page.index).index,
    });
    expect(selectSaveMediaAction(f.preflight, f.resolved).action).toBe('open-viewer');
  });
  test.each([
    [
      'unavailable inventory',
      (f) => {
        delete f.preflight.viewerCandidates;
      },
      'Viewer opener inventory is unavailable',
    ],
    [
      'invalid token',
      (f) => {
        f.preflight.viewerCandidates[0].token = '';
      },
      'Viewer opener identity is malformed',
    ],
    [
      'duplicated candidate',
      (f) => {
        f.preflight.viewerCandidates.push(structuredClone(f.opener));
      },
      'Viewer opener identity is malformed or duplicated',
    ],
    [
      'file link substituted for Details',
      (f) => {
        f.preflight.viewerCandidates[0].controlIndex = f.page.index;
      },
      'File-details opener is absent, ambiguous or not the exact owned Details control',
    ],
  ])('malformed %s retains its validation diagnostic', (_name, mutate, error) => {
    const f = fixture();
    mutate(f);
    expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow(error);
  });
  test.each([
    ['file', true],
    ['audio', false],
    ['audio', true],
    ['video', true],
  ])('selects %s details with source page=%s and explicit idle evidence', (kind, page) => {
    const f = fixture(kind, page);
    const selected = f.select();
    expect(selected.scope).toBe('file-details');
    expect(selected.route.url).toBe(f.downloadURL);
    expect(selected.route.teamId).toBe('TOWNER');
    expect(selected.contextId).toBe('EDEMO');
    expect(selected.fileDownloadEvidence !== null).toBe(page);
    expect(selected.detailsPlayback).toEqual(f.playback);
  });
  test('audio without a page keeps original unavailable before Download', () => {
    const f = fixture('audio', false);
    expect(saveMediaSelectionOutput(f.select()).originalSelection.status).toBe('unavailable');
    expect(() => f.select({ originalRequired: true })).toThrow('original file');
  });
  test('a canonical pane page can supply original-route evidence when source has only F', () => {
    const f = fixture('audio', false),
      v = f.viewer;
    v.page = v.add(v.card, 'AXLink', ['p-file_link_button--link'], 'example.pdf', {
      url: f.filePageURL,
    });
    v.download.url =
      'https://files.slack.com/files-pri/TOWNER-FDEMO/download/example.pdf?origin_team=EDEMO';
    Object.assign(f.candidate, {
      filePageURL: f.filePageURL,
      fileLinkIndex: v.page.index,
      identityIndex: v.page.index,
      url: v.download.url,
      routeKind: 'file-download',
    });
    f.refreshViewer();
    expect(
      saveMediaSelectionOutput(f.select({ originalRequired: true })).originalSelection.status
    ).toBe('selected');
  });
  test.each(['AXLink', 'AXButton', 'AXMenuItem', 'AXPopUpButton'])(
    'raw %s Download prevents fallback',
    (role) => {
      const f = fixture();
      f.add(f.actions, role, [], 'Download', { enabled: false, url: 'https://example.test/no' });
      f.refresh();
      expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow();
    }
  );
  test.each([
    [
      'different source F',
      (f) => {
        f.opener.fileId = 'FOTHER';
      },
    ],
    [
      'different source family',
      (f) => {
        f.opener.mediaKind = 'audio';
      },
    ],
    [
      'wrong page index',
      (f) => {
        f.opener.filePageIndex = f.control.index;
      },
    ],
    [
      'invented source page absence',
      (f) => {
        f.opener.filePageIndex = null;
        f.opener.filePageURL = null;
      },
    ],
    [
      'changed source page',
      (f) => {
        f.opener.filePageURL += '&x=y';
      },
    ],
    [
      'disabled opener',
      (f) => {
        f.control.enabled = false;
      },
    ],
    [
      'wrong opener label',
      (f) => {
        f.control.label = 'Open';
      },
    ],
    [
      'link instead of details button',
      (f) => {
        f.control.role = 'AXLink';
      },
    ],
    [
      'invented opener URL',
      (f) => {
        f.control.url = f.filePageURL;
      },
    ],
    [
      'opener outside actions',
      (f) => {
        f.control.parent = f.media.index;
      },
    ],
    [
      'missing actions ownership',
      (f) => {
        f.actions.classes = [];
      },
    ],
    [
      'duplicate details button',
      (f) => {
        f.add(f.actions, 'AXButton', ['c-message_actions__button'], 'View file details');
      },
    ],
    [
      'unknown source root',
      (f) => {
        f.media.classes = ['unknown'];
      },
    ],
    [
      'existing file details',
      (f) => {
        f.add(f.root, 'AXGroup', ['p-file_details__references_footer']);
      },
    ],
  ])('rejects %s before opener', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    f.refresh();
    expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow();
  });
  test.each([
    [
      'foreign pane',
      (f) => {
        f.viewer.pane.classes = ['unknown'];
      },
    ],
    [
      'two panes',
      (f) => {
        f.viewer.add(f.viewer.pane, 'AXGroup', ['p-view_contents--secondary']);
      },
    ],
    [
      'missing header',
      (f) => {
        f.viewer.header.classes = [];
      },
    ],
    [
      'missing close',
      (f) => {
        f.viewer.close.label = 'Dismiss';
      },
    ],
    [
      'disabled close',
      (f) => {
        f.viewer.close.enabled = false;
      },
    ],
    [
      'missing footer',
      (f) => {
        f.viewer.footer.classes = [];
      },
    ],
    [
      'card outside body',
      (f) => {
        f.viewer.card.parent = f.viewer.pane.index;
      },
    ],
    [
      'duplicate card',
      (f) => {
        f.viewer.add(f.viewer.body, 'AXGroup', ['c-pillow_file_container', 'p-message_file']);
      },
    ],
    [
      'different pane file',
      (f) => {
        f.viewer.page.url = f.filePageURL.replace('FDEMO', 'FOTHER');
      },
    ],
    [
      'changed pane page basename',
      (f) => {
        f.viewer.page.url = f.filePageURL.replace('example.pdf', 'other.pdf');
      },
    ],
    [
      'foreign download host',
      (f) => {
        f.viewer.download.url = 'https://example.test/file';
        f.candidate.url = f.viewer.download.url;
      },
    ],
    [
      'different Download file',
      (f) => {
        f.viewer.download.url = f.downloadURL.replace('FDEMO', 'FOTHER');
        f.candidate.url = f.viewer.download.url;
      },
    ],
    [
      'nested Download',
      (f) => {
        f.viewer.download.parent = f.viewer.card.index;
      },
    ],
    [
      'disabled Download',
      (f) => {
        f.viewer.download.enabled = false;
      },
    ],
    [
      'bulk Download',
      (f) => {
        f.viewer.download.label = 'Download all files';
      },
    ],
    [
      'duplicate Download',
      (f) => {
        f.viewer.add(
          f.viewer.footer,
          'AXLink',
          ['p-file_details__references_actions', 'c-message_actions__button'],
          'Download',
          { url: f.downloadURL }
        );
      },
    ],
    [
      'composer inside pane',
      (f) => {
        f.viewer.add(f.viewer.body, 'AXTextArea', ['p-message_input'], 'Draft');
      },
    ],
    [
      'unknown dialog',
      (f) => {
        f.viewer.add(f.viewer.pane, 'AXDialog', [], 'Other');
      },
    ],
    [
      'URL-less button',
      (f) => {
        f.viewer.download.role = 'AXButton';
        delete f.viewer.download.url;
      },
    ],
  ])('rejects %s before Download', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    f.refreshViewer();
    expect(() => f.select()).toThrow();
  });
  test.each(['source', 'viewer'])('rejects changed or unknown %s audio playback', (side) => {
    const f = fixture('audio', false);
    f.viewerPreflight.observations[1].detailsPlayback[side][0].value = '1';
    expect(() => f.select()).toThrow('playback');
  });
  test('rejects a different audio pane marker even when Download F is unchanged', () => {
    const f = fixture('audio', false);
    f.viewer.identity.id = 'transcript-description-FOTHER';
    f.refreshViewer();
    expect(() => f.select()).toThrow('identity');
  });
  test('rejects changed raw audio Play while forged playback receipt remains idle', () => {
    const f = fixture('audio', false);
    f.viewer.play.stateValue = '1';
    f.refreshViewer();
    expect(() => f.select()).toThrow('playback');
  });
  test('rejects changed source text despite matching file identity', () => {
    const f = fixture();
    f.viewerPreflight.observations[1].source.content.nodes[0].label = 'Different source';
    expect(() => f.select()).toThrow('source changed');
  });
  test.each([
    'fileId',
    'mediaKind',
    'filePageURL',
    'url',
    'routeKind',
    'openerToken',
    'identityIndex',
    'fileLinkIndex',
    'controlIndex',
    'footerIndex',
  ])('rejects changed candidate %s', (key) => {
    const f = fixture();
    f.viewerPreflight.candidates[0][key] = typeof f.candidate[key] === 'number' ? 999 : 'different';
    expect(() => f.select()).toThrow();
  });
});

describe('file-details receipts', () => {
  function phase(f, selected, phase = 'result') {
    return {
      operation: 'save-media',
      phase,
      requested: 'FDEMO',
      pid: 123,
      selection: { ...f.candidate },
      action: { attempted: true, accepted: true, startedAt: 1234 },
      verification: {
        sourceMatched: true,
        viewerMatched: true,
        downloadRequested: true,
        playbackUnchanged: true,
      },
      viewerAction: { attempted: true, accepted: true, opened: true, closed: true },
      detailsPlayback: {
        before: structuredClone(selected.detailsPlayback),
        after: structuredClone(selected.detailsPlayback),
      },
      detailsMenuAction: structuredClone(selected.detailsMenuAction),
    };
  }
  test('requires viewer continuity and exact source/pane playback through close', () => {
    const f = fixture('audio', false),
      selected = f.select(),
      receipt = phase(f, selected);
    expect(() => verifySavePhase(receipt, f.preflight, selected, 'result')).not.toThrow();
    receipt.detailsPlayback.after.viewer[0].value = '1';
    expect(() => verifySavePhase(receipt, f.preflight, selected, 'result')).toThrow('playback');
  });
  test.each(['sourceMatched', 'viewerMatched', 'downloadRequested', 'playbackUnchanged'])(
    'rejects missing %s',
    (key) => {
      const f = fixture(),
        selected = f.select(),
        receipt = phase(f, selected);
      receipt.verification[key] = false;
      expect(() => verifySavePhase(receipt, f.preflight, selected, 'result')).toThrow();
    }
  );
  test('does not turn published bytes into success with an unclosed pane', () => {
    const f = fixture(),
      selected = f.select(),
      receipt = phase(f, selected);
    receipt.viewerAction.closed = false;
    expect(() => verifySavePhase(receipt, f.preflight, selected, 'result')).toThrow();
  });
  test('known direct route uses existing exact-URL completion and preserves unknown upload identity', () => {
    const f = fixture(),
      selected = f.select(),
      sourceIdentity = { device: '1', inode: '2', size: '3', mtimeNs: '4' };
    const publication = {
      operation: 'save-media-publish',
      status: 'ok',
      source: { path: '/native/file', identity: sourceIdentity },
      artifact: {
        path: '/output/file',
        published: true,
        verified: true,
        bytes: 3,
        sha256: 'a'.repeat(64),
      },
    };
    const download = {
      sourcePath: '/native/file',
      expectedSource: sourceIdentity,
      download: {
        id: 'FDEMO',
        teamId: 'EDEMO',
        downloadState: 'completed',
        url: selected.url,
        downloadPath: '/native/file',
      },
    };
    const result = savedMediaOutput(f.resolved, publication, download, '/output/file', selected);
    expect(result.saved.representation).toBe('slack-file-download');
    expect(result.saved.originalFile).toBeNull();
    expect(result.saved.originalSelection.status).toBe('selected');
    download.download.url += '&different=1';
    expect(() =>
      savedMediaOutput(f.resolved, publication, download, '/output/file', selected)
    ).toThrow();
  });
});

describe('foreground file-details protocol', () => {
  // Only a synthetic native peer runs. No Slack process, AX input, network,
  // download ledger or publisher is accessed, and no saved artifact is created.
  async function runDetails(
    f,
    { originalRequired = false, changeViewer, changeStarted, changeResult } = {}
  ) {
    const interaction = {
      mode: 'foreground',
      state: 'activated',
      activationRequested: true,
      activated: true,
      ownershipLost: false,
      focusRestoration: 'none',
      pid: f.preflight.pid,
    };
    const initial = { ...f.preflight, interaction };
    const opened = {
      ...structuredClone(f.viewerPreflight),
      interaction,
      viewerAction: { attempted: true, accepted: true, opened: true, closed: false },
    };
    const started = {
      operation: 'save-media',
      phase: 'started',
      requested: initial.requested,
      pid: initial.pid,
      interaction,
      selection: structuredClone(f.candidate),
      action: { attempted: true, accepted: true, startedAt: 1700000000123 },
      verification: {
        sourceMatched: true,
        viewerMatched: true,
        downloadRequested: true,
        playbackUnchanged: true,
      },
      viewerAction: { ...opened.viewerAction },
      detailsPlayback: {
        before: structuredClone(f.playback),
        after: structuredClone(f.playback),
      },
      detailsMenuAction: structuredClone(opened.detailsMenuAction),
    };
    const final = {
      ...structuredClone(started),
      phase: 'result',
      status: 'ok',
      viewerAction: { ...opened.viewerAction, closed: true },
    };
    changeViewer?.(opened);
    changeStarted?.(started);
    changeResult?.(final);
    const emit = (receipt) => `console.log(JSON.stringify(${JSON.stringify(receipt)}));`;
    const native = [
      process.execPath,
      '--eval',
      `
      import { createInterface } from 'node:readline';
      ${emit(initial)}
      const inputs = [];
      for await (const line of createInterface({input:process.stdin})) {
        const input = JSON.parse(line); inputs.push(input);
        if(input.openViewer) { ${emit(opened)} }
        else if(input.token) { ${emit(started)} }
        else if(input.finish) {
          console.log(JSON.stringify({...${JSON.stringify(final)}, inputs}));
          process.exitCode = ${final.status === 'ok' ? 0 : 1}; break;
        } else if(input.cancel) {
          console.log(JSON.stringify({phase:'result', status:'stopped', error:'Cancelled by wrapper',
            interaction:${JSON.stringify(interaction)},
            viewerAction:{attempted:true,accepted:true,opened:true,closed:true}, inputs}));
          process.exitCode = 1; break;
        } else process.exit(2);
      }
    `,
    ];
    const stages = [];
    const result = await runSaveMedia(native, {
      select(value) {
        const opener = selectSaveMediaAction(value, f.resolved, { originalRequired });
        stages.push('opener');
        return {
          openViewer: opener.token,
          context: { preflight: value, resolved: f.resolved, opener },
        };
      },
      selectViewer(value, context) {
        context.selected = selectViewerDownloadCandidate(
          value,
          context.preflight,
          context.resolved,
          context.opener,
          { originalRequired }
        );
        stages.push('download');
        return { token: context.selected.token, context };
      },
      complete(value, context) {
        verifySavePhase(value, context.preflight, context.selected, 'started');
        const identity = { device: '1', inode: '2', size: '10', mtimeNs: '4' };
        context.download = {
          sourcePath: '/tmp/synthetic-native-file',
          expectedSource: identity,
          download: {
            id: context.selected.fileId,
            teamId: context.selected.contextId,
            url: context.selected.url,
            downloadState: 'completed',
            downloadPath: '/tmp/synthetic-native-file',
          },
        };
        context.publication = {
          operation: 'save-media-publish',
          status: 'ok',
          source: { path: context.download.sourcePath, identity },
          artifact: {
            path: '/tmp/synthetic-details-file',
            published: true,
            verified: true,
            bytes: 10,
            sha256: 'a'.repeat(64),
          },
        };
        context.compact = savedMediaOutput(
          context.resolved,
          context.publication,
          context.download,
          context.publication.artifact.path,
          context.selected
        );
        stages.push('published');
        return { download: context.download, publication: context.publication };
      },
    });
    let receipt = { ...result.receipt, interaction: foregroundEvidence(result.receipt) };
    let compact;
    try {
      if (result.code !== 0 || receipt.status !== 'ok') throw new Error(receipt.error);
      verifySavePhase(receipt, result.context.preflight, result.context.selected, 'result');
      compact = { ...result.context.compact, ...viewerSaveState(receipt) };
    } catch (error) {
      result.code ||= 1;
      compact = failedSaveMediaOutput({
        requested: initial.requested,
        error,
        receipt,
        context: result.context,
      });
    }
    receipt = {
      ...receipt,
      ...(result.context?.download ? { download: result.context.download } : {}),
      ...(result.context?.publication ? { publication: result.context.publication } : {}),
      resolution: compact,
      status: compact.status,
    };
    const text = formatOutput(compact, 'text', receipt);
    const json = JSON.parse(formatOutput(compact, 'json', receipt));
    expect(text.match(/Foreground interaction requested/g)).toHaveLength(1);
    expect(json.interaction).toEqual({ ...receipt.interaction, pid: undefined });
    expect(json.interaction).not.toHaveProperty('pid');
    expect(json).not.toHaveProperty('pid');
    expect(json.status).toBe(receipt.status);
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
    return { result, receipt, compact, text, json, stages };
  }

  test.each([
    ['document original', () => fixture('file', true), true],
    ['audio original', () => fixture('audio', true), true],
    ['audio fallback', () => fixture('audio', false), false],
    ['native audio original', () => nativeAudioFixture(true), true],
    ['native audio fallback', () => nativeAudioFixture(false), false],
    ['video menu fallback', () => menuFixture(), false],
  ])(
    'completes %s through real selection, publication verification and formatting',
    async (_name, make, originalRequired) => {
      const f = make();
      const { result, receipt, compact, text, json, stages } = await runDetails(f, {
        originalRequired,
      });
      expect(result.code).toBe(0);
      expect(compact.status).toBe('ok');
      expect(stages).toEqual(['opener', 'download', 'published']);
      expect(receipt.inputs).toEqual([
        { openViewer: f.opener.token },
        { token: f.candidate.token },
        { finish: true },
      ]);
      expect(compact.saved).toMatchObject({ published: true, verified: true, originalFile: null });
      expect(compact.saved.originalSelection.status).toBe(
        originalRequired ? 'selected' : 'unavailable'
      );
      expect(compact.coverage.originalFileVerified).toBeNull();
      expect(json.viewer).toEqual({ opened: true, closed: true });
      expect(json.saved).toEqual(compact.saved);
      expect(text).toContain('Saved: /tmp/synthetic-details-file');
      expect(text).toContain(
        originalRequired
          ? 'Original download route selected; uploaded-byte identity remains unknown.'
          : 'Original download route unavailable; observed Download target selected.'
      );
      expect(text).not.toContain('Stopped:');
    }
  );

  test.each([
    ['missing original route', { originalRequired: true }, 'No source-bound original'],
    [
      'changed retained source',
      {
        changeViewer: (value) => {
          value.observations[1].source.content.nodes[0].label = 'changed';
        },
      },
      'Retained attachment source changed',
    ],
    [
      'changed source playback',
      {
        changeViewer: (value) => {
          value.observations[1].detailsPlayback.source[0].value = '1';
        },
      },
      'playback',
    ],
    [
      'changed viewer playback',
      {
        changeViewer: (value) => {
          value.observations[1].content.nodes.find(
            (node) => node.role === 'AXCheckBox'
          ).stateValue = '1';
        },
      },
      'playback',
    ],
  ])('refuses %s before any Download token', async (_name, options, error) => {
    const f = fixture('audio', false);
    const { result, receipt, compact, text, json, stages } = await runDetails(f, options);
    expect(result.code).toBe(1);
    expect(stages).toEqual(['opener']);
    expect(receipt.inputs).toEqual([{ openViewer: f.opener.token }, { cancel: true }]);
    expect(compact.error).toContain(error);
    expect(compact.downloadMayHaveStarted).toBe(false);
    expect(json.viewer).toEqual({ opened: true, closed: true });
    expect(compact).not.toHaveProperty('saved');
    expect(result.transfer).toBeNull();
    expect(text).toContain('no Download token was sent');
    expect(text).not.toContain('Saved:');
    expect(text).not.toContain('may have started a download');
  });

  test('changed playback at the started receipt stops publication without replaying Download', async () => {
    const f = fixture('audio', true);
    const { receipt, compact, text, stages } = await runDetails(f, {
      changeStarted: (value) => {
        value.detailsPlayback.after.viewer[0].value = '1';
      },
    });
    expect(stages).toEqual(['opener', 'download']);
    expect(receipt.inputs).toEqual([
      { openViewer: f.opener.token },
      { token: f.candidate.token },
      { cancel: true },
    ]);
    expect(compact.error).toContain('playback changed');
    expect(compact.downloadMayHaveStarted).toBe(true);
    expect(compact.saved.originalSelection.status).toBe('selected');
    expect(compact.saved).not.toHaveProperty('published');
    expect(compact.saved).not.toHaveProperty('path');
    expect(text).toContain('Do not replay it automatically.');
    expect(text).not.toContain('Saved:');
  });

  test.each([
    [
      'source verification',
      (value) => {
        value.verification.sourceMatched = false;
      },
      'source verification',
    ],
    [
      'playback verification',
      (value) => {
        value.detailsPlayback.after.source[0].value = '1';
      },
      'playback changed',
    ],
    [
      'pane closure',
      (value) => {
        value.viewerAction.closed = false;
      },
      'viewer continuity',
    ],
    [
      'foreground ownership',
      (value) => {
        value.status = 'stopped';
        value.error = 'Synthetic foreground ownership loss after publication';
        value.interaction.ownershipLost = true;
      },
      'foreground ownership loss',
    ],
  ])('retains the published artifact after final %s failure', async (name, changeResult, error) => {
    const f = fixture('audio', true);
    const { result, receipt, compact, text, json, stages } = await runDetails(f, {
      originalRequired: true,
      changeResult,
    });
    expect(result.code).toBe(1);
    expect(stages).toEqual(['opener', 'download', 'published']);
    expect(receipt.inputs).toEqual([
      { openViewer: f.opener.token },
      { token: f.candidate.token },
      { finish: true },
    ]);
    expect(compact.status).toBe('stopped');
    expect(compact.error).toContain(error);
    expect(compact.downloadMayHaveStarted).toBe(true);
    expect(compact.saved).toMatchObject({
      path: '/tmp/synthetic-details-file',
      published: true,
      verified: true,
      originalFile: null,
    });
    expect(compact.saved.originalSelection.status).toBe('selected');
    expect(json.saved).toEqual(compact.saved);
    expect(json.viewer).toEqual({ opened: true, closed: name !== 'pane closure' });
    expect(json.interaction.ownershipLost).toBe(name === 'foreground ownership');
    expect(text).toContain('Saved: /tmp/synthetic-details-file');
    expect(text).toContain('Stopped:');
    expect(text).toContain('Do not replay it automatically.');
    expect(text.includes('file viewer may be open')).toBe(name === 'pane closure');
  });
});
