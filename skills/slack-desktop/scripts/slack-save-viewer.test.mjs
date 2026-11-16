import { describe, expect, test } from 'bun:test';
import { extractMedia } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import {
  savedMediaOutput,
  saveMediaSelectionOutput,
  verifySavePhase,
} from './slack-save-media.mjs';
import { selectSaveMediaAction, selectViewerDownloadCandidate } from './slack-save-viewer.mjs';

// Synthetic accessibility snapshots only; no Slack input, network, or files.
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

function fixture() {
  const f = builder();
  f.root = f.add(null, 'AXWebArea', [], 'Example', {
    url: 'https://app.slack.com/client/EDEMO/CDEMO',
  });
  f.container = f.add(f.root, 'AXGroup', ['c-message_kit__actions']);
  const permalink = 'https://example.slack.com/archives/CDEMO/p1700000000000001';
  f.add(f.container, 'AXLink', ['c-timestamp'], 'Yesterday', { url: permalink });
  f.media = f.add(f.container, 'AXGroup', [
    'p-message_gallery_image_file',
    'c-file_gallery_image_file',
  ]);
  f.sourceURL = 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png';
  f.control = f.add(f.media, 'AXLink', ['p-file_image_thumbnail__wrapper'], 'Open image', {
    url: f.sourceURL,
  });
  f.add(f.control, 'AXImage', ['p-file_image_thumbnail__image'], 'example.png', {
    url: 'https://files.slack.com/files-tmb/TDEMO-FDEMO/example_360.png',
  });
  f.opener = {
    token: 'viewer-opener-1',
    scope: 'viewer-opener',
    containerIndex: f.container.index,
    mediaIndex: f.media.index,
    controlIndex: f.control.index,
    sourceURL: f.sourceURL,
    fileId: 'FDEMO',
    ownerTeamId: 'TDEMO',
  };
  f.resolved = {
    operation: 'read-media',
    schemaVersion: 1,
    status: 'ok',
    requested: 'FDEMO',
    workspace: { contextId: 'EDEMO', id: 'EDEMO' },
    view: { url: f.root.url, title: f.root.label },
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
  v.modal = v.add(null, 'AXGroup', ['p-media_viewer_modal'], 'Media viewer', { id: 'modal-demo' });
  v.multimedia = v.add(v.modal, 'AXGroup', ['p-media_viewer_modal__multimedia']);
  v.branch = v.add(v.multimedia, 'AXGroup', ['p-media_viewer_modal__multimedia_video']);
  v.media = v.add(v.branch, 'AXGroup', ['p-file_viewer']);
  v.content = v.add(v.media, 'AXGroup', ['p-file_viewer__content']);
  v.imageGroup = v.add(v.content, 'AXGroup', ['p-image_viewer']);
  v.image = v.add(v.imageGroup, 'AXImage', ['p-image_viewer__image'], '', { url: f.sourceURL });
  v.footer = v.add(v.branch, 'AXToolbar', ['p-media_viewer_modal__footer'], 'Media controls');
  v.download = v.add(
    v.footer,
    'AXButton',
    ['p-file_viewer__header__button', 'p-media_viewer_modal__icon_button'],
    'Download'
  );
  // A viewer may clone a thread and expose other attachments/composers. Those
  // controls are outside the active branch and must never become candidates.
  v.thread = v.add(v.multimedia, 'AXGroup', ['c-message_kit__actions']);
  v.decoy = v.add(v.thread, 'AXLink', [], 'Download', {
    url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/other.png',
  });
  v.add(v.thread, 'AXTextArea', ['p-message_input'], 'Reply');
  v.close = v.add(v.multimedia, 'AXButton', ['p-media_viewer_modal__tabs_close'], 'Close');
  f.viewer = v;
  f.viewerCandidate = {
    token: 'viewer-download-1',
    scope: 'viewer',
    openerToken: f.opener.token,
    viewerIndex: 0,
    branchIndex: v.branch.index,
    mediaIndex: v.media.index,
    imageIndex: v.image.index,
    footerIndex: v.footer.index,
    controlIndex: v.download.index,
    url: null,
    sourceURL: f.sourceURL,
    fileId: 'FDEMO',
    ownerTeamId: 'TDEMO',
    routeKind: 'unknown',
  };
  f.refreshViewer = () => {
    const sourceNodes = f.nodes.slice(f.container.index).map((node, index) => ({
      ...structuredClone(node),
      index,
      parent: index === 0 ? null : node.parent - f.container.index,
    }));
    f.viewerPreflight = {
      operation: 'save-media',
      phase: 'viewer-select',
      requested: 'FDEMO',
      pid: 123,
      opener: structuredClone(f.opener),
      candidates: [structuredClone(f.viewerCandidate)],
      observations: [0, 1].map(() => ({
        before: { ...f.resolved.view },
        after: { ...f.resolved.view },
        source: {
          content: { nodes: structuredClone(sourceNodes), truncated: false },
          mediaIndex: f.media.index - f.container.index,
          controlIndex: f.control.index - f.container.index,
        },
        content: { nodes: structuredClone(v.nodes), truncated: false },
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

function sourceToolbarFixture() {
  const f = fixture();
  const add = (parent, role, classes, label = '', state = undefined) =>
    f.add(parent, role, classes, label, {
      AXTitle: label,
      AXDescription: label,
      AXValue: '',
      AXHelp: '',
      ...(state === undefined ? {} : { stateValue: state, selected: false }),
    });
  const button = [
    'c-button--focus-visible',
    'c-button-unstyled',
    'c-icon_button',
    'c-icon_button--size_smedium',
    'c-message_actions__button',
    'c-icon_button--default',
  ];
  f.toolbar = add(f.container, 'AXGroup', ['c-message_actions__container', 'c-message__actions']);
  const group = add(
    f.toolbar,
    'AXGroup',
    ['c-message_actions__group', 'c-message-actions--hover-actions'],
    'Message actions'
  );
  const wrapper = add(group, 'AXGroup', ['container___lGTS']);
  add(wrapper, 'AXButton', button, 'Add reaction…', '');
  add(group, 'AXButton', button, 'Reply in thread', '');
  add(group, 'AXButton', button, 'Forward file…', '');
  add(group, 'AXButton', button, 'Add to-do', '');
  add(group, 'AXPopUpButton', button, 'Ask Slackbot', '');
  add(group, 'AXPopUpButton', [...button, 'c-message_actions__button--more'], 'More actions', '');
  f.toolbarIndex = f.toolbar.index - f.container.index;
  f.refreshOffscreenViewer = () => {
    f.refresh();
    f.refreshViewer();
    for (const observation of f.viewerPreflight.observations) {
      observation.source.content.nodes[f.toolbarIndex].classes.push(
        'c-message__actions--offscreen'
      );
    }
  };
  f.refreshOffscreenViewer();
  return f;
}

describe('source-bound viewer opener', () => {
  test('only missing raw Download inventory offers an exact observed image opener', () => {
    const f = fixture();
    expect(f.resolved.media.kind).toBe('image');
    expect(selectSaveMediaAction(f.preflight, f.resolved)).toEqual({
      ...f.opener,
      action: 'open-viewer',
    });
  });
  test.each(['AXLink', 'AXButton', 'AXMenuItem', 'AXPopUpButton'])(
    'a raw %s Download blocks viewer fallback even when disabled or unsupported',
    (role) => {
      const f = fixture();
      f.add(f.media, role, [], 'Download', {
        url: 'https://example.test/unsupported',
        enabled: false,
      });
      f.refresh();
      expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow('No supported Download');
    }
  );
  test('an omitted supported direct Download never downgrades to viewer fallback', () => {
    const f = fixture();
    f.add(f.media, 'AXLink', [], 'Download', { url: f.sourceURL });
    f.refresh();
    expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow('inventory is incomplete');
  });
  test('a complete direct Download keeps its existing representation and action', () => {
    const f = fixture();
    const node = f.add(f.media, 'AXLink', [], 'Download', { url: f.sourceURL });
    f.refresh();
    f.preflight.candidates = [
      {
        token: 'direct',
        containerIndex: f.container.index,
        mediaIndex: f.media.index,
        controlIndex: node.index,
        url: node.url,
        routeKind: 'unknown',
      },
    ];
    expect(selectSaveMediaAction(f.preflight, f.resolved).action).toBe('download');
    expect(() =>
      selectSaveMediaAction(f.preflight, f.resolved, { originalRequired: true })
    ).toThrow('original file');
  });
  test('nested unrelated attachment Download does not block the source-owned opener', () => {
    const f = fixture();
    const nested = f.add(f.media, 'AXGroup', ['p-message_file']);
    f.add(nested, 'AXLink', [], 'Download', {
      url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/other.png',
    });
    f.refresh();
    expect(selectSaveMediaAction(f.preflight, f.resolved).action).toBe('open-viewer');
  });
  test.each([false, true])(
    'ignores a valid unrelated gallery in the same message=%s',
    (sameMessage) => {
      const f = fixture();
      const container = sameMessage
        ? f.container
        : f.add(f.root, 'AXGroup', ['c-message_kit__actions']);
      if (!sameMessage)
        f.add(container, 'AXLink', ['c-timestamp'], 'Yesterday', {
          url: 'https://example.slack.com/archives/CDEMO/p1700000000000002',
        });
      const media = f.add(container, 'AXGroup', [
        'p-message_gallery_image_file',
        'c-file_gallery_image_file',
      ]);
      const control = f.add(media, 'AXLink', ['p-file_image_thumbnail__wrapper'], 'Open image', {
        url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/other.png',
      });
      f.add(control, 'AXImage', ['p-file_image_thumbnail__image'], 'other.png', {
        url: 'https://files.slack.com/files-tmb/TDEMO-FOTHER/other_360.png',
      });
      f.refresh();
      f.preflight.viewerCandidates.push({
        ...f.opener,
        token: 'other-opener',
        containerIndex: container.index,
        mediaIndex: media.index,
        controlIndex: control.index,
        sourceURL: control.url,
        fileId: 'FOTHER',
      });
      expect(selectSaveMediaAction(f.preflight, f.resolved)).toEqual({
        ...f.opener,
        action: 'open-viewer',
      });
    }
  );
  test.each([
    [
      'missing opener inventory',
      (f) => {
        delete f.preflight.viewerCandidates;
      },
    ],
    [
      'empty opener inventory',
      (f) => {
        f.preflight.viewerCandidates = [];
      },
    ],
    [
      'duplicate opener',
      (f) => {
        f.preflight.viewerCandidates.push(f.preflight.viewerCandidates[0]);
      },
    ],
    [
      'unknown file ID',
      (f) => {
        f.resolved.media.fileId = null;
      },
    ],
    [
      'different owner',
      (f) => {
        f.preflight.viewerCandidates[0].ownerTeamId = 'TOTHER';
      },
    ],
    [
      'different source URL',
      (f) => {
        f.preflight.viewerCandidates[0].sourceURL += '?x=1';
      },
    ],
    [
      'different file',
      (f) => {
        f.preflight.viewerCandidates[0].fileId = 'FOTHER';
      },
    ],
    [
      'different control',
      (f) => {
        f.preflight.viewerCandidates[0].controlIndex = f.media.index;
      },
    ],
    [
      'different media',
      (f) => {
        f.preflight.viewerCandidates[0].mediaIndex = f.container.index;
      },
    ],
    [
      'changed source text',
      (f) => {
        f.preflight.observations[0].content.nodes[f.container.index].label = 'changed';
      },
    ],
    [
      'missing source',
      (f) => {
        f.resolved.sources.push({ messageRef: 'COTHER:1700000000.000002' });
      },
    ],
    [
      'existing viewer',
      (f) => {
        f.preflight.observations.forEach((c) => {
          c.content.nodes[f.root.index].classes.push('p-media_viewer_modal');
        });
      },
    ],
    [
      'truncated source',
      (f) => {
        f.preflight.observations[0].content.truncated = true;
      },
    ],
    [
      'nonboolean strict flag',
      (f) => {
        f.options = { originalRequired: 'yes' };
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => selectSaveMediaAction(f.preflight, f.resolved, f.options)).toThrow();
  });
  test.each([
    'https://files.slack.com/files-tmb/TDEMO-FDEMO/example.png',
    'https://files.slack.com/files-pri/TDEMO-FDEMO-variant/example.png',
    'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.png',
    'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png?unknown=1',
    'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png?origin_team=TOTHER',
  ])('rejects unsupported source URL %s', (url) => {
    const f = fixture();
    f.control.url = f.opener.sourceURL = url;
    f.refresh();
    expect(() => selectSaveMediaAction(f.preflight, f.resolved)).toThrow();
  });
});

describe('scoped viewer Download selection', () => {
  test('accepts only the complete existing source toolbar gaining its offscreen class', () => {
    const f = sourceToolbarFixture();
    const before = structuredClone(f.viewerPreflight);
    expect(f.select().controlIndex).toBe(f.viewer.download.index);
    expect(f.viewerPreflight).toEqual(before);
  });

  test.each([
    [
      'root role',
      (f) => {
        f.toolbar.role = 'AXToolbar';
      },
    ],
    [
      'root ID',
      (f) => {
        f.toolbar.id = 'other';
      },
    ],
    [
      'root extra class',
      (f) => {
        f.toolbar.classes.push('unknown-toolbar');
      },
    ],
    [
      'duplicate root class',
      (f) => {
        f.toolbar.classes.push('c-message__actions');
      },
    ],
    [
      'wrapper class',
      (f) => {
        f.nodes[f.toolbar.index + 2].classes = ['container__unknown'];
      },
    ],
    [
      'legacy forward label',
      (f) => {
        const node = f.nodes[f.toolbar.index + 5];
        node.label = node.AXTitle = node.AXDescription = 'Forward message…';
      },
    ],
    [
      'control role',
      (f) => {
        f.nodes[f.toolbar.index + 4].role = 'AXPopUpButton';
      },
    ],
    [
      'selected control',
      (f) => {
        f.nodes[f.toolbar.index + 4].selected = true;
      },
    ],
    [
      'nonempty state',
      (f) => {
        f.nodes[f.toolbar.index + 4].stateValue = '1';
      },
    ],
    [
      'nonempty AXValue',
      (f) => {
        f.nodes[f.toolbar.index + 4].AXValue = '1';
      },
    ],
    [
      'changed title',
      (f) => {
        f.nodes[f.toolbar.index + 4].AXTitle = 'Other';
      },
    ],
    [
      'changed description',
      (f) => {
        f.nodes[f.toolbar.index + 4].AXDescription = 'Other';
      },
    ],
    [
      'changed help',
      (f) => {
        f.nodes[f.toolbar.index + 4].AXHelp = 'Other';
      },
    ],
    [
      'missing metadata',
      (f) => {
        delete f.nodes[f.toolbar.index + 4].AXHelp;
      },
    ],
    [
      'extra matching metadata',
      (f) => {
        f.nodes[f.toolbar.index + 4].enabled = true;
      },
    ],
    [
      'extra matching empty URL',
      (f) => {
        f.nodes[f.toolbar.index + 4].url = '';
      },
    ],
    [
      'control extra class',
      (f) => {
        f.nodes[f.toolbar.index + 4].classes = [
          ...f.nodes[f.toolbar.index + 4].classes,
          'unknown-control',
        ];
      },
    ],
    [
      'control parent',
      (f) => {
        f.nodes[f.toolbar.index + 4].parent = f.toolbar.index;
      },
    ],
    [
      'toolbar inside media',
      (f) => {
        f.toolbar.parent = f.media.index;
      },
    ],
    [
      'toolbar child added',
      (f) => {
        f.add(f.toolbar, 'AXGroup');
      },
    ],
    [
      'toolbar marker outside owner',
      (f) => {
        f.add(f.container, 'AXButton', ['c-message_actions__unknown'], 'Unknown');
      },
    ],
    [
      'second toolbar root',
      (f) => {
        f.add(f.container, 'AXGroup', ['c-message_actions__container']);
      },
    ],
  ])(
    'rejects offscreen transition with matching unsupported %s in both source captures',
    (_name, mutate) => {
      const f = sourceToolbarFixture();
      mutate(f);
      f.refreshOffscreenViewer();
      expect(() => f.select()).toThrow();
    }
  );

  test('offscreen transition preserves all other source fields and root class ordering', () => {
    for (const mutate of [
      (rows, f) => {
        rows[0].label = 'Changed source';
      },
      (rows, f) => {
        rows[1].label = 'Changed timestamp';
      },
      (rows, f) => {
        rows[f.control.index - f.container.index].url += '?changed=1';
      },
      (rows, f) => {
        rows[f.toolbarIndex + 4].selected = true;
      },
      (rows, f) => {
        rows[f.toolbarIndex].classes.reverse();
      },
      (rows, f) => {
        rows[f.toolbarIndex].classes.push('c-message__actions--offscreen');
      },
    ]) {
      const f = sourceToolbarFixture();
      for (const observation of f.viewerPreflight.observations) {
        mutate(observation.source.content.nodes, f);
      }
      expect(() => f.select()).toThrow('Retained attachment source changed');
    }
  });

  test('offscreen comparison does not allow a new, removed or formerly offscreen toolbar', () => {
    const added = sourceToolbarFixture();
    for (const observation of added.preflight.observations) {
      observation.content.nodes = observation.content.nodes.filter(
        (node) => node.index < added.toolbar.index
      );
    }
    expect(() => added.select()).toThrow('Retained attachment source changed');
    const removed = sourceToolbarFixture();
    for (const observation of removed.viewerPreflight.observations) {
      observation.source.content.nodes = observation.source.content.nodes.filter(
        (node) => node.index < removed.toolbarIndex
      );
    }
    expect(() => removed.select()).toThrow('Retained attachment source changed');
    const reversed = sourceToolbarFixture();
    reversed.toolbar.classes.push('c-message__actions--offscreen');
    reversed.refresh();
    reversed.toolbar.classes = reversed.toolbar.classes.filter(
      (name) => name !== 'c-message__actions--offscreen'
    );
    reversed.refreshViewer();
    expect(() => reversed.select()).toThrow('Retained attachment source changed');
  });

  test('offscreen source state cannot drift in either direction between viewer captures', () => {
    for (const index of [0, 1]) {
      const f = sourceToolbarFixture();
      const root = f.viewerPreflight.observations[index].source.content.nodes[f.toolbarIndex];
      root.classes = root.classes.filter((name) => name !== 'c-message__actions--offscreen');
      expect(() => f.select()).toThrow('Active viewer changed between captures');
    }
  });

  test('offscreen source allowance requires a verified image viewer and does not apply to opener selection', () => {
    const viewer = sourceToolbarFixture();
    viewer.viewerPreflight.observations[0].content.nodes[0].classes = [];
    expect(() => viewer.select()).toThrow('Viewer capture is not one identified Slack media modal');
    const opener = sourceToolbarFixture();
    opener.preflight.observations[1].content.nodes[opener.toolbar.index].classes.push(
      'c-message__actions--offscreen'
    );
    expect(() => selectSaveMediaAction(opener.preflight, opener.resolved)).toThrow();
  });

  function modernFooter(f = fixture()) {
    f.viewer.footer.classes = [
      'p-media_viewer_modal__footer',
      'p-media_viewer_modal__footer--slide_over_content',
    ];
    Object.assign(f.viewer.download, {
      classes: [
        'c-button-unstyled',
        'c-icon_button',
        'c-icon_button--size_medium',
        'p-media_viewer_modal__icon_button',
        'c-icon_button--dark',
      ],
      enabled: true,
      selected: false,
      stateValue: '',
      AXValue: '',
    });
    f.refreshViewer();
    return f;
  }

  test('accepts the observed modern footer Download without the legacy header class', () => {
    const f = modernFooter();
    const before = structuredClone(f.viewerPreflight);
    const selected = f.select();
    expect(selected.controlIndex).toBe(f.viewer.download.index);
    expect(selected.footerIndex).toBe(f.viewer.footer.index);
    expect(selected.sourceURL).toBe(f.sourceURL);
    expect(selected.fileDownloadEvidence).toBeNull();
    expect(saveMediaSelectionOutput(selected)).toEqual({
      representation: 'observed-viewer-download',
      originalSelection: { status: 'unavailable', basis: 'viewer-download-route-unexposed' },
      originalFile: null,
    });
    expect(f.viewerPreflight).toEqual(before);
  });

  test('modern exact class sets are order independent and preserve unknown captured enabled state', () => {
    const f = modernFooter();
    f.viewer.download.classes.reverse();
    f.viewer.footer.classes.reverse();
    delete f.viewer.download.enabled;
    f.refreshViewer();
    expect(f.select().controlIndex).toBe(f.viewer.download.index);
    expect(() => f.select({ originalRequired: true })).toThrow(
      'No source-bound original file Download route is exposed in the viewer'
    );
  });

  test('accepts only the observed focused modern Download class addition', () => {
    const f = modernFooter();
    f.viewer.download.classes.push('c-button--focus-visible');
    f.refreshViewer();
    expect(f.select().controlIndex).toBe(f.viewer.download.index);
    expect(() => f.select({ originalRequired: true })).toThrow(
      'No source-bound original file Download route is exposed in the viewer'
    );
    f.viewer.download.classes.push('unknown-focus-class');
    f.refreshViewer();
    expect(() => f.select()).toThrow('Viewer Download control');
  });

  test('focused modern Download still requires every base class and a unique focus class', () => {
    for (const name of modernFooter().viewer.download.classes) {
      const f = modernFooter();
      f.viewer.download.classes = [
        'c-button--focus-visible',
        ...f.viewer.download.classes.filter((value) => value !== name),
      ];
      f.refreshViewer();
      expect(() => f.select()).toThrow('Viewer Download control');
    }
    const f = modernFooter();
    f.viewer.download.classes.push('c-button--focus-visible', 'c-button--focus-visible');
    f.refreshViewer();
    expect(() => f.select()).toThrow('Viewer Download control');
    f.viewer.download.classes.pop();
    f.viewer.download.selected = true;
    f.refreshViewer();
    expect(() => f.select()).toThrow('Viewer Download control');
  });

  test('focus classes are not normalized from sources, footers or cross-capture evidence', () => {
    const source = modernFooter();
    source.viewerPreflight.observations[1].source.content.nodes[0].classes.push(
      'c-button--focus-visible'
    );
    expect(() => source.select()).toThrow('Retained attachment source changed');
    const footer = modernFooter();
    footer.viewer.footer.classes.push('c-button--focus-visible');
    footer.refreshViewer();
    expect(() => footer.select()).toThrow('Viewer Download control');
    for (const index of [0, 1]) {
      const changed = modernFooter();
      changed.viewerPreflight.observations[index].content.nodes[
        changed.viewer.download.index
      ].classes.push('c-button--focus-visible');
      expect(() => changed.select()).toThrow('Active viewer changed between captures');
    }
  });

  test.each([
    ...[
      'c-button-unstyled',
      'c-icon_button',
      'c-icon_button--size_medium',
      'p-media_viewer_modal__icon_button',
      'c-icon_button--dark',
    ].map((name) => [
      `missing button class ${name}`,
      (v) => {
        v.download.classes = v.download.classes.filter((value) => value !== name);
      },
    ]),
    [
      'extra button class',
      (v) => {
        v.download.classes.push('unknown-control-variant');
      },
    ],
    [
      'duplicate button class',
      (v) => {
        v.download.classes.push(v.download.classes[0]);
      },
    ],
    [
      'wrong footer variant',
      (v) => {
        v.footer.classes[1] = 'p-media_viewer_modal__footer--unknown';
      },
    ],
    [
      'extra footer class',
      (v) => {
        v.footer.classes.push('unknown-footer');
      },
    ],
    [
      'duplicate footer class',
      (v) => {
        v.footer.classes.push(v.footer.classes[0]);
      },
    ],
    ...['download', 'footer'].flatMap((key) => [
      [
        `${key} ID`,
        (v) => {
          v[key].id = 'unverified-id';
        },
      ],
      [
        `${key} missing ID`,
        (v) => {
          delete v[key].id;
        },
      ],
      [
        `${key} label`,
        (v) => {
          v[key].label += ' ';
        },
      ],
      [
        `${key} URL`,
        (v) => {
          v[key].url = 'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.png';
        },
      ],
    ]),
    [
      'button role',
      (v) => {
        v.download.role = 'AXLink';
      },
    ],
    [
      'footer role',
      (v) => {
        v.footer.role = 'AXGroup';
      },
    ],
    [
      'selected button',
      (v) => {
        v.download.selected = true;
      },
    ],
    [
      'missing selected state',
      (v) => {
        delete v.download.selected;
      },
    ],
    [
      'changed state value',
      (v) => {
        v.download.stateValue = '1';
      },
    ],
    [
      'missing state value',
      (v) => {
        delete v.download.stateValue;
      },
    ],
    [
      'changed AXValue',
      (v) => {
        v.download.AXValue = '1';
      },
    ],
    [
      'missing AXValue',
      (v) => {
        delete v.download.AXValue;
      },
    ],
    [
      'disabled button',
      (v) => {
        v.download.enabled = false;
      },
    ],
    [
      'button child',
      (v) => {
        v.add(v.download, 'AXStaticText', [], 'Download');
      },
    ],
    [
      'button moved to file viewer',
      (v) => {
        v.download.parent = v.media.index;
      },
    ],
    [
      'button nested under footer',
      (v) => {
        v.download.parent = v.add(v.footer, 'AXGroup').index;
      },
    ],
    [
      'footer moved into file viewer',
      (v) => {
        v.footer.parent = v.media.index;
      },
    ],
    [
      'duplicate footer',
      (v) => {
        v.add(v.branch, 'AXToolbar', v.footer.classes, 'Media controls');
      },
    ],
    [
      'unlisted Download sibling',
      (v) => {
        v.add(v.footer, 'AXButton', [], 'Download another file');
      },
    ],
    [
      'active image changed but file ID stayed the same',
      (v) => {
        v.image.url = 'https://files.slack.com/files-pri/TDEMO-FDEMO/different.png';
      },
    ],
  ])('rejects modern Download with %s', (_name, mutate) => {
    const f = modernFooter();
    mutate(f.viewer);
    f.refreshViewer();
    expect(() => f.select()).toThrow();
  });

  test('modern Download keeps exact retained source and candidate bindings', () => {
    const source = modernFooter();
    source.viewerPreflight.observations[1].source.content.nodes[0].label = 'Changed source';
    expect(() => source.select()).toThrow('Retained attachment source changed');
    for (const key of ['controlIndex', 'footerIndex', 'mediaIndex', 'imageIndex', 'sourceURL']) {
      const f = modernFooter();
      f.viewerPreflight.candidates[0][key] = key === 'sourceURL' ? 'https://example.test' : 999;
      expect(() => f.select()).toThrow('differs from its active image or scoped controls');
    }
  });

  test('modern Download rejects a changed footer or supported legacy switch between captures', () => {
    for (const change of [
      (node) => {
        node.label = 'Changed controls';
      },
      (node) => {
        node.classes.push('p-file_viewer__header__button');
      },
    ]) {
      const f = modernFooter();
      const second = f.viewerPreflight.observations[1].content.nodes;
      change(second[f.viewer.download.index]);
      expect(() => f.select()).toThrow();
    }
    const f = modernFooter();
    f.viewerPreflight.observations[1].content.nodes[f.viewer.footer.index].AXHelp = 'Changed help';
    expect(() => f.select()).toThrow('Active viewer changed between captures');
  });

  function addThreadToggle(f, stateValue = '1') {
    return f.viewer.add(
      f.viewer.footer,
      'AXCheckBox',
      ['p-media_viewer_toggle_thread_button', 'p-media_viewer_modal__icon_button'],
      'Show thread',
      { stateValue }
    );
  }
  test.each(['multimedia', 'branch'])(
    'accepts the sole viewer Close directly under verified %s without selecting it',
    (owner) => {
      const f = fixture();
      f.viewer.close.parent = f.viewer[owner].index;
      f.refreshViewer();
      const before = structuredClone(f.viewerPreflight);
      const selected = f.select();
      expect(selected.controlIndex).toBe(f.viewer.download.index);
      expect(selected.controlIndex).not.toBe(f.viewer.close.index);
      expect(f.viewerPreflight).toEqual(before);
    }
  );
  test.each([
    [
      'missing known class',
      (v) => {
        v.close.classes = [];
      },
    ],
    [
      'wrong role',
      (v) => {
        v.close.role = 'AXLink';
      },
    ],
    [
      'wrong label',
      (v) => {
        v.close.label = 'Dismiss';
      },
    ],
    [
      'modal owner',
      (v) => {
        v.close.parent = v.modal.index;
      },
    ],
    [
      'thread owner',
      (v) => {
        v.close.parent = v.thread.index;
      },
    ],
    [
      'footer owner',
      (v) => {
        v.close.parent = v.footer.index;
      },
    ],
    [
      'file owner',
      (v) => {
        v.close.parent = v.media.index;
      },
    ],
    [
      'nested owner',
      (v) => {
        v.close.parent = v.add(v.branch, 'AXGroup').index;
      },
    ],
    [
      'duplicate under other allowed owner',
      (v) => {
        v.add(v.branch, 'AXButton', ['p-media_viewer_modal__tabs_close'], 'Close');
      },
    ],
    [
      'duplicate with wrong role and label',
      (v) => {
        v.add(v.thread, 'AXLink', ['p-media_viewer_modal__tabs_close'], 'Dismiss');
      },
    ],
  ])('rejects viewer Close with %s', (_name, mutate) => {
    const f = fixture();
    mutate(f.viewer);
    f.refreshViewer();
    expect(() => f.select()).toThrow('Close');
  });
  test('unrelated Close buttons do not become the owned viewer Close', () => {
    const f = fixture();
    f.viewer.add(f.viewer.thread, 'AXButton', ['unrelated-close'], 'Close');
    f.refreshViewer();
    expect(f.select().controlIndex).toBe(f.viewer.download.index);
    f.viewer.close.classes = [];
    f.refreshViewer();
    expect(() => f.select()).toThrow('Close');
  });
  test.each(['placement', 'state'])(
    'rejects viewer Close %s drift between fresh captures',
    (change) => {
      const f = fixture();
      const close = f.viewerPreflight.observations[1].content.nodes[f.viewer.close.index];
      if (change === 'placement') close.parent = f.viewer.branch.index;
      else close.AXHelp = 'Changed close action';
      expect(() => f.select()).toThrow('changed between captures');
    }
  );
  test.each(['0', '1'])(
    'permits the observed footer thread toggle without selecting it (state=%s)',
    (stateValue) => {
      const f = fixture();
      const toggle = addThreadToggle(f, stateValue);
      f.refreshViewer();
      const selected = f.select();
      expect(selected.controlIndex).toBe(f.viewer.download.index);
      expect(selected.controlIndex).not.toBe(toggle.index);
    }
  );
  test.each([
    [
      'outside the footer',
      (f, toggle) => {
        toggle.parent = f.viewer.media.index;
      },
    ],
    [
      'missing thread-toggle class',
      (_f, toggle) => {
        toggle.classes = ['p-media_viewer_modal__icon_button'];
      },
    ],
    [
      'missing viewer-control class',
      (_f, toggle) => {
        toggle.classes = ['p-media_viewer_toggle_thread_button'];
      },
    ],
    [
      'unknown state',
      (_f, toggle) => {
        toggle.stateValue = '';
      },
    ],
    [
      'changed label',
      (_f, toggle) => {
        toggle.label = 'Unknown control';
      },
    ],
    [
      'playback label',
      (_f, toggle) => {
        toggle.label = 'Play';
      },
    ],
    [
      'unexpected URL',
      (_f, toggle) => {
        toggle.url = 'https://example.test/';
      },
    ],
    [
      'duplicate toggle',
      (f) => {
        addThreadToggle(f);
      },
    ],
  ])('rejects a thread-like checkbox with %s', (_name, mutate) => {
    const f = fixture();
    mutate(f, addThreadToggle(f));
    f.refreshViewer();
    expect(() => f.select()).toThrow('playback or message controls');
  });
  test.each(['Play', 'Pause'])(
    'still rejects a generic %s button beside a valid thread toggle',
    (label) => {
      const f = fixture();
      addThreadToggle(f);
      f.viewer.add(f.viewer.footer, 'AXButton', [], label);
      f.refreshViewer();
      expect(() => f.select()).toThrow('playback or message controls');
    }
  );
  test('selects only the active image footer and preserves unknown Download representation', () => {
    const f = fixture(),
      selected = f.select();
    expect(selected).toEqual({
      ...f.viewerCandidate,
      route: { teamId: 'TDEMO', fileId: 'FDEMO' },
      fileDownloadEvidence: null,
      contextId: 'EDEMO',
      correlation: 'viewer-file-identity',
    });
    expect(saveMediaSelectionOutput(selected)).toEqual({
      representation: 'observed-viewer-download',
      originalSelection: { status: 'unavailable', basis: 'viewer-download-route-unexposed' },
      originalFile: null,
    });
  });
  test('strict original stops before selecting the URL-less Download', () => {
    const f = fixture();
    expect(() => f.select({ originalRequired: true })).toThrow('Rerun without --original');
  });
  test('same-file but different active image URL in both captures is insufficient', () => {
    const f = fixture();
    for (const capture of f.viewerPreflight.observations)
      capture.content.nodes[f.viewer.image.index].url =
        'https://files.slack.com/files-pri/TDEMO-FDEMO/other.png';
    expect(() => f.select()).toThrow('exact source URL');
  });
  test.each([
    [
      'changed original source',
      (f) => {
        f.viewerPreflight.observations[0].source.content.nodes[0].label = 'different';
      },
    ],
    [
      'wrong retained media',
      (f) => {
        f.viewerPreflight.observations[0].source.mediaIndex++;
      },
    ],
    [
      'wrong retained opener',
      (f) => {
        f.viewerPreflight.observations[0].source.controlIndex++;
      },
    ],
    [
      'truncated retained source',
      (f) => {
        f.viewerPreflight.observations[0].source.content.truncated = true;
      },
    ],
    [
      'truncated viewer',
      (f) => {
        f.viewerPreflight.observations[0].content.truncated = true;
      },
    ],
    [
      'only one capture',
      (f) => {
        f.viewerPreflight.observations.pop();
      },
    ],
    [
      'wrong workspace',
      (f) => {
        f.viewerPreflight.observations[0].before.url += '/wrong';
      },
    ],
    [
      'wrong view',
      (f) => {
        f.viewerPreflight.observations[1].after.title += ' changed';
      },
    ],
    [
      'changed modal',
      (f) => {
        f.viewerPreflight.observations[0].content.nodes[0].id = 'other';
      },
    ],
    [
      'missing modal identity',
      (f) => {
        f.viewerPreflight.observations[0].content.nodes[0].id = '';
      },
    ],
    [
      'wrong source URL',
      (f) => {
        f.viewerPreflight.observations[0].content.nodes[f.viewer.image.index].url +=
          '?origin_team=EDEMO';
      },
    ],
    [
      'changed footer',
      (f) => {
        f.viewerPreflight.observations[0].content.nodes[f.viewer.footer.index].label = 'changed';
      },
    ],
    [
      'wrong opener token',
      (f) => {
        f.viewerPreflight.opener.token = 'other';
      },
    ],
    [
      'wrong phase',
      (f) => {
        f.viewerPreflight.phase = 'select';
      },
    ],
    [
      'wrong process',
      (f) => {
        f.viewerPreflight.pid++;
      },
    ],
    [
      'wrong reference',
      (f) => {
        f.viewerPreflight.requested = 'FOTHER';
      },
    ],
    [
      'extra candidate',
      (f) => {
        f.viewerPreflight.candidates.push(f.viewerPreflight.candidates[0]);
      },
    ],
    [
      'missing candidate',
      (f) => {
        f.viewerPreflight.candidates = [];
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => f.select()).toThrow();
  });
  test.each([
    'token',
    'scope',
    'openerToken',
    'viewerIndex',
    'branchIndex',
    'mediaIndex',
    'imageIndex',
    'footerIndex',
    'controlIndex',
    'url',
    'sourceURL',
    'fileId',
    'ownerTeamId',
    'routeKind',
  ])('binds candidate %s', (key) => {
    const f = fixture();
    f.viewerPreflight.candidates[0][key] = key === 'token' ? 'invalid token!' : 'wrong';
    expect(() => f.select()).toThrow();
  });
  test.each([
    [
      'duplicate image',
      (v) => {
        v.add(v.imageGroup, 'AXImage', ['p-image_viewer__image'], '', { url: v.image.url });
      },
    ],
    [
      'duplicate footer',
      (v) => {
        v.add(v.branch, 'AXToolbar', ['p-media_viewer_modal__footer']);
      },
    ],
    [
      'duplicate active file',
      (v) => {
        v.add(v.branch, 'AXGroup', ['p-file_viewer']);
      },
    ],
    [
      'duplicate branch',
      (v) => {
        v.add(v.multimedia, 'AXGroup', ['p-media_viewer_modal__multimedia_video']);
      },
    ],
    [
      'duplicate Download',
      (v) => {
        v.add(v.footer, 'AXButton', v.download.classes, 'Download');
      },
    ],
    [
      'Download link',
      (v) => {
        v.download.role = 'AXLink';
      },
    ],
    [
      'disabled Download',
      (v) => {
        v.download.enabled = false;
      },
    ],
    [
      'Download URL',
      (v) => {
        v.download.url = 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png';
      },
    ],
    [
      'Download all',
      (v) => {
        v.download.label = 'Download all';
      },
    ],
    [
      'missing Download class',
      (v) => {
        v.download.classes = [];
      },
    ],
    [
      'footer moved into thread',
      (v) => {
        v.footer.parent = v.thread.index;
      },
    ],
    [
      'image moved outside active file',
      (v) => {
        v.image.parent = v.thread.index;
      },
    ],
    [
      'playback in active branch',
      (v) => {
        v.add(v.media, 'AXCheckBox', [], 'Play');
      },
    ],
    [
      'composer in active branch',
      (v) => {
        v.add(v.media, 'AXTextArea', ['p-message_input']);
      },
    ],
    [
      'message in active branch',
      (v) => {
        v.add(v.media, 'AXGroup', ['c-message_kit__actions']);
      },
    ],
    [
      'nested viewer',
      (v) => {
        v.add(v.thread, 'AXGroup', ['p-media_viewer_modal']);
      },
    ],
  ])('refuses %s', (_name, mutate) => {
    const f = fixture();
    mutate(f.viewer);
    f.refreshViewer();
    expect(() => f.select()).toThrow();
  });
  test('a candidate pointing at a cloned thread Download is refused', () => {
    const f = fixture();
    f.viewerPreflight.candidates[0].controlIndex = f.viewer.decoy.index;
    expect(() => f.select()).toThrow('active image or scoped controls');
  });
});

function phaseFixture() {
  const f = fixture();
  f.selected = f.select();
  f.receipt = {
    operation: 'save-media',
    phase: 'started',
    requested: 'FDEMO',
    pid: 123,
    selection: { ...f.viewerCandidate },
    action: { attempted: true, accepted: true, startedAt: 1700000000123 },
    viewerAction: { attempted: true, accepted: true, opened: true, closed: false },
    verification: {
      sourceMatched: true,
      downloadRequested: true,
      playbackUnchanged: true,
      viewerMatched: true,
    },
  };
  return f;
}

describe('viewer receipts and output', () => {
  test('accepts independently verified viewer Download receipt', () => {
    const f = phaseFixture();
    expect(() => verifySavePhase(f.receipt, f.preflight, f.selected, 'started')).not.toThrow();
  });
  test.each([
    'scope',
    'openerToken',
    'viewerIndex',
    'branchIndex',
    'mediaIndex',
    'imageIndex',
    'footerIndex',
    'controlIndex',
    'url',
    'sourceURL',
    'fileId',
    'ownerTeamId',
    'routeKind',
  ])('binds receipt %s', (key) => {
    const f = phaseFixture();
    f.receipt.selection[key] = 'wrong';
    expect(() => verifySavePhase(f.receipt, f.preflight, f.selected, 'started')).toThrow();
  });
  test.each(['attempted', 'accepted', 'opened'])('requires viewer %s proof', (key) => {
    const f = phaseFixture();
    f.receipt.viewerAction[key] = false;
    expect(() => verifySavePhase(f.receipt, f.preflight, f.selected, 'started')).toThrow(
      'viewer continuity'
    );
  });
  test('requires native viewerMatched', () => {
    const f = phaseFixture();
    f.receipt.verification.viewerMatched = false;
    expect(() => verifySavePhase(f.receipt, f.preflight, f.selected, 'started')).toThrow(
      'viewer continuity'
    );
  });
  test('requires verified owned-viewer closure on the final receipt', () => {
    const f = phaseFixture();
    f.receipt.phase = 'result';
    expect(() => verifySavePhase(f.receipt, f.preflight, f.selected, 'result')).toThrow(
      'viewer continuity'
    );
    f.receipt.viewerAction.closed = true;
    expect(() => verifySavePhase(f.receipt, f.preflight, f.selected, 'result')).not.toThrow();
  });
  function outputFixture() {
    const f = fixture();
    f.selected = f.select();
    f.destination = '/tmp/requested/example.png';
    const identity = { device: '1', inode: '2', size: '12', mtimeNs: '3' };
    f.publication = {
      operation: 'save-media-publish',
      status: 'ok',
      source: { path: '/tmp/native/example.png', identity },
      artifact: {
        path: f.destination,
        bytes: 12,
        sha256: 'a'.repeat(64),
        published: true,
        verified: true,
      },
    };
    f.download = {
      correlation: 'viewer-file-identity',
      sourceURL: f.sourceURL,
      fileOwnerTeamId: 'TDEMO',
      sourcePath: f.publication.source.path,
      expectedSource: { ...identity },
      download: {
        downloadState: 'completed',
        downloadPath: f.publication.source.path,
        url: 'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.png?origin_team=EDEMO',
        id: 'FDEMO',
        teamId: 'EDEMO',
      },
    };
    f.output = () =>
      savedMediaOutput(f.resolved, f.publication, f.download, f.destination, f.selected);
    return f;
  }
  test('actual ledger URL cannot retroactively turn a URL-less action into an original selection', () => {
    const output = outputFixture().output();
    expect(output.saved.representation).toBe('observed-viewer-download');
    expect(output.saved.originalSelection).toEqual({
      status: 'unavailable',
      basis: 'viewer-download-route-unexposed',
    });
    expect(output.saved.originalFile).toBeNull();
    expect(output.saved.correlation).toBe('viewer-file-identity');
  });
  test.each([
    [
      'missing correlation',
      (f) => {
        delete f.download.correlation;
      },
    ],
    [
      'wrong source URL',
      (f) => {
        f.download.sourceURL += '?origin_team=EDEMO';
      },
    ],
    [
      'wrong source owner',
      (f) => {
        f.download.fileOwnerTeamId = 'TOTHER';
      },
    ],
    [
      'wrong actual URL file',
      (f) => {
        f.download.download.url = f.download.download.url.replace('FDEMO', 'FOTHER');
      },
    ],
    [
      'wrong actual URL owner',
      (f) => {
        f.download.download.url = f.download.download.url.replace('TDEMO', 'TOTHER');
      },
    ],
    [
      'wrong ledger context',
      (f) => {
        f.download.download.teamId = 'TOTHER';
      },
    ],
    [
      'wrong ledger file',
      (f) => {
        f.download.download.id = 'FOTHER';
      },
    ],
    [
      'wrong selected context',
      (f) => {
        f.selected.contextId = 'TOTHER';
      },
    ],
    [
      'guessed selection URL',
      (f) => {
        f.selected.url = f.download.download.url;
      },
    ],
    [
      'guessed selection route',
      (f) => {
        f.selected.route.url = f.download.download.url;
      },
    ],
    [
      'retroactive file evidence',
      (f) => {
        f.selected.fileDownloadEvidence = {};
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const f = outputFixture();
    mutate(f);
    expect(f.output).toThrow();
  });
});
