// File details is a distinct, non-playing viewer capability. An explicit
// source-owned Details action and a fresh same-file card authorize its Download.
import { parseObservedDownloadURL } from './slack-download-store.mjs';
import { parseFilePageURL } from './slack-file-page.mjs';
import { isMediaRoot } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import {
  downloadRouteKind,
  fileDownloadEvidence,
  verifyDetailsMenuAction,
} from './slack-save-media.mjs';

const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const has = (node, name) => node?.classes?.includes(name) === true;
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
const index = (value) => Number.isSafeInteger(value) && value >= 0;
const controls = new Set(['AXLink', 'AXButton', 'AXMenuItem', 'AXPopUpButton']);
const composer = (node) =>
  ['AXTextField', 'AXTextArea'].includes(node.role) ||
  node.classes?.some((name) => /^(?:p-composer|p-message_input|p-workspace__input)/.test(name));
const openerKeys = [
  'token',
  'scope',
  'containerIndex',
  'mediaIndex',
  'controlIndex',
  'filePageIndex',
  'filePageURL',
  'fileId',
  'mediaKind',
  'openerKind',
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  return value;
}
function subtree(tree, root) {
  const nodes = [root, ...tree.descendants(root)];
  const positions = new Map(nodes.map((node, i) => [node.index, i]));
  return nodes.map((node, i) => ({
    ...node,
    index: i,
    parent: i ? positions.get(node.parent) : null,
  }));
}
const signature = (tree, root) => JSON.stringify(canonical(subtree(tree, root)));
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function searchCardRows(tree, root, selectedMediaIndex) {
  const rows = [root, ...tree.descendants(root)];
  const fields = [
    'index',
    'parent',
    'role',
    'classes',
    'id',
    'label',
    'AXTitle',
    'AXDescription',
    'AXValue',
    'AXHelp',
  ];
  const keysMatch = (node, expected) => equal(Object.keys(node).sort(), [...expected].sort());
  const emptyGroup = (node, classes) =>
    keysMatch(node, fields) &&
    node.role === 'AXGroup' &&
    equal(node.classes, classes) &&
    ['id', 'label', 'AXTitle', 'AXDescription', 'AXValue', 'AXHelp'].every(
      (key) => node[key] === ''
    );
  if (
    !index(selectedMediaIndex) ||
    !emptyGroup(root, [
      'c-message_kit__actions',
      'c-message_kit__actions--above',
      'c-search_message__actions_container--ia4',
    ])
  )
    return rows;
  const direct = tree.children(root);
  const wrappers = direct.filter(
    (node) =>
      has(node, 'c-search_message__body--card_clamp') ||
      has(node, 'c-search_message__body--card_clipped')
  );
  const expanders = direct.filter((node) => has(node, 'c-search__expand'));
  if (wrappers.length !== 1 || expanders.length !== 1) return rows;
  const wrapper = wrappers[0],
    button = expanders[0];
  const position = direct.indexOf(wrapper);
  if (
    !emptyGroup(wrapper, [
      'c-search_message__body--card_clamp',
      'c-search_message__body--card_clipped',
    ]) ||
    !keysMatch(button, [...fields, 'selected', 'stateValue']) ||
    button.role !== 'AXButton' ||
    !(
      equal(button.classes, ['c-button-unstyled', 'c-search__expand']) ||
      equal(button.classes, ['c-button--focus-visible', 'c-button-unstyled', 'c-search__expand'])
    ) ||
    button.label !== '... Show more' ||
    button.AXTitle !== '... Show more' ||
    !['id', 'AXDescription', 'AXValue', 'AXHelp', 'stateValue'].every(
      (key) => button[key] === ''
    ) ||
    button.selected !== false ||
    tree.children(button).length !== 0 ||
    position < 1 ||
    position + 2 >= direct.length ||
    direct[position - 1].role !== 'AXGroup' ||
    !equal(direct[position - 1].classes, [
      'c-search_message__content_header',
      'c-search_message__content_header--compact',
    ]) ||
    direct[position + 1] !== button
  )
    return rows;
  const run = [];
  for (const node of direct.slice(position + 2)) {
    if (
      node.role !== 'AXGroup' ||
      !equal(node.classes, [
        'p-video_message_file',
        'p-video_message_file--gallery_v3',
        'c-search_message__media_item',
      ])
    )
      break;
    run.push(node);
  }
  if (run.filter((node) => node.index === selectedMediaIndex).length !== 1) return rows;
  const children = tree.children(wrapper);
  if (children.length !== 1 || !emptyGroup(children[0], ['p-rich_text_section'])) return rows;
  const rich = children[0];
  const wrapperOffset = rows.indexOf(wrapper),
    buttonOffset = rows.indexOf(button);
  if (
    wrapperOffset + 1 >= buttonOffset ||
    rows[wrapperOffset + 1] !== rich ||
    !equal(
      [wrapper, ...tree.descendants(wrapper)].map((node) => node.index),
      rows.slice(wrapperOffset, buttonOffset).map((node) => node.index)
    )
  )
    return rows;
  // Only the complete observed search-card layout pair is neutral. Its entire
  // body and every video sibling, including nested expand controls, remain evidence.
  return rows
    .filter((node) => node !== wrapper && node !== button)
    .map((node) => (node === rich ? { ...node, parent: root.index } : node));
}

function sourceRows(tree, root, selectedMediaIndex, menu = null) {
  const omitted = new Set(
    menu ? [menu.popover, ...tree.descendants(menu.popover)].map((n) => n.index) : []
  );
  return searchCardRows(tree, root, selectedMediaIndex).filter((n) => !omitted.has(n.index));
}

// These are the neutral source changes observed when Slack opens file details:
// the verified search-card clamp, search highlights and video volume layout.
// Keep every identity, URL, state and remaining attribute in the comparison.
function sourceSignature(tree, root, selectedMediaIndex, menu = null) {
  const nodes = sourceRows(tree, root, selectedMediaIndex, menu);
  const positions = new Map(nodes.map((node, i) => [node.index, i]));
  return JSON.stringify(
    canonical(
      nodes.map((node, i) => {
        const row = { ...node, index: i, parent: i ? positions.get(node.parent) : null };
        for (const field of ['label', 'AXValue', 'AXTitle', 'AXDescription'])
          if (typeof row[field] === 'string')
            row[field] = row[field].replace(/[\uE000\uE001]/g, '');
        if (
          has(node, 'p-media_volume_slider') &&
          tree.ancestor(node, (n) => has(n, 'p-video_controls_overlay')) &&
          tree.ancestor(node, (n) => has(n, 'p-video_message_file'))
        )
          row.classes = row.classes.filter(
            (name) =>
              !['p-media_volume_slider--popover', 'p-media_volume_slider--vertical'].includes(name)
          );
        if (menu && node.index === menu.overlay.index)
          row.classes = row.classes.filter((name) => name !== 'p-video_controls_overlay--active');
        return row;
      })
    )
  );
}

function sourcePositionsMatch(proof, group, opener, currentTree, source, menu = null) {
  const before = sourceRows(proof.tree, group.container, group.media.index);
  const after = sourceRows(currentTree, currentTree.root, source.mediaIndex, menu);
  return ['mediaIndex', 'controlIndex', 'filePageIndex'].every((key) => {
    if (opener[key] === null) return source[key] === null;
    const expected = before.findIndex((node) => node.index === opener[key]);
    return expected >= 0 && after.findIndex((node) => node.index === source[key]) === expected;
  });
}

function ownNodes(media, tree) {
  const descendants = tree.descendants(media);
  const within = new Set(descendants.map((node) => node.index));
  const boundary = (node) =>
    isMediaRoot(node) || has(node, 'c-message_kit__actions') || composer(node);
  return descendants.filter(
    (node) =>
      !boundary(node) &&
      !tree.ancestor(node, (parent) => within.has(parent.index) && boundary(parent))
  );
}
function family(media) {
  if (
    has(media, 'p-search_file--audio-player') ||
    (media.role === 'AXGroup' &&
      ['c-pillow_file_container', 'p-message_file', 'p-message_file--audio_message'].every((name) =>
        has(media, name)
      ))
  )
    return 'audio';
  if (has(media, 'p-video_message_file')) return 'video';
  if (has(media, 'p-message_gallery_image_file') || has(media, 'c-file_gallery_image_file'))
    return null;
  return has(media, 'c-pillow_file_container') || has(media, 'p-message_file') ? 'file' : null;
}
function sourceIDs(nodes, mediaKind) {
  const ids = new Set();
  for (const node of nodes) {
    const description =
      node.role === 'AXGroup' && has(node, 'sr-only')
        ? mediaKind === 'video'
          ? node.id?.match(/^caption-description-(F[A-Z0-9]+)$/)?.[1]
          : mediaKind === 'audio'
            ? node.id?.match(/^transcript-description-(F[A-Z0-9]+)$/)?.[1]
            : null
        : null;
    if (description) ids.add(description);
    try {
      const url = new URL(node.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
      )
        continue;
      const id =
        url.hostname === 'files.slack.com'
          ? url.pathname.match(
              /^\/files-(?:pri|tmb)\/[TE][A-Z0-9]+-(F[A-Z0-9]+)(?:-[A-Za-z0-9]+)?\//
            )?.[1]
          : url.pathname.match(/^\/files\/U[A-Z0-9]+\/(F[A-Z0-9]+)(?:\/|$)/)?.[1];
      if (id) ids.add(id);
    } catch {
      /* Non-URLs are not file identities. */
    }
  }
  return [...ids].sort();
}
function pageLinks(nodes) {
  return nodes.filter((node) => {
    if (node.role !== 'AXLink') return false;
    try {
      return new URL(node.url).pathname.startsWith('/files/');
    } catch {
      return false;
    }
  });
}

export function validateFileDetailsOpener(candidate, proof) {
  const { tree, indexed, contextId } = proof;
  requireState(
    token(candidate?.token) &&
      candidate.scope === 'file-details-opener' &&
      ['containerIndex', 'mediaIndex', 'controlIndex'].every((key) => index(candidate[key])) &&
      (candidate.filePageIndex === null || index(candidate.filePageIndex)) &&
      /^[F][A-Z0-9]{1,63}$/.test(candidate.fileId ?? '') &&
      ['file', 'audio', 'video'].includes(candidate.mediaKind) &&
      ['details-button', 'video-menu'].includes(candidate.openerKind),
    'File-details opener identity is malformed'
  );
  const container = indexed.get(candidate.containerIndex),
    media = indexed.get(candidate.mediaIndex),
    control = indexed.get(candidate.controlIndex);
  requireState(
    container &&
      has(container, 'c-message_kit__actions') &&
      media?.role === 'AXGroup' &&
      family(media) === candidate.mediaKind &&
      tree.ancestor(media, (node) => has(node, 'c-message_kit__actions')) === container &&
      !tree.ancestor(
        media,
        (node) => composer(node) || has(node, 'p-file_details__references_footer')
      ),
    'File-details opener is outside its captured attachment'
  );
  const nodes = ownNodes(media, tree);
  const direct = nodes.filter(
    (node) =>
      node.role === 'AXButton' &&
      node.label === 'View file details' &&
      has(node, 'c-message_actions__button') &&
      has(indexed.get(node.parent), 'c-file__actions')
  );
  const menus = nodes.filter(
    (node) =>
      node.role === 'AXPopUpButton' &&
      node.label === 'More actions' &&
      has(node, 'p-video_message_file--gallery_v3__controls_overlay_ellipsis') &&
      has(node, 'p-video_controls_overlay__corner_button') &&
      indexed.get(node.parent)?.role === 'AXGroup' &&
      has(indexed.get(node.parent), 'p-video_controls_overlay__corner') &&
      has(indexed.get(node.parent), 'p-video_controls_overlay__corner--gallery_v3') &&
      indexed.get(indexed.get(node.parent)?.parent)?.role === 'AXGroup' &&
      has(indexed.get(indexed.get(node.parent)?.parent), 'p-video_controls_overlay') &&
      indexed.get(indexed.get(node.parent)?.parent)?.parent === media.index
  );
  const openers = candidate.openerKind === 'details-button' ? direct : menus;
  requireState(
    openers.length === 1 &&
      direct.length + menus.length === 1 &&
      openers[0] === control &&
      control.enabled !== false &&
      !has(control, 'c-button--disabled') &&
      !control.url &&
      (candidate.openerKind !== 'video-menu' ||
        (candidate.mediaKind === 'video' &&
          has(media, 'p-video_message_file--gallery_v3') &&
          direct.length === 0)),
    'File-details opener is absent, ambiguous or not the exact owned Details control'
  );
  requireState(
    equal(sourceIDs([media, ...nodes], candidate.mediaKind), [candidate.fileId]),
    'File-details source file identity is absent or contradictory'
  );
  requireState(
    idle(capturedPlayback([media, ...nodes]), ['audio', 'video'].includes(candidate.mediaKind)),
    'File-details source playback is not verified idle before opening'
  );
  const pages = pageLinks(nodes);
  for (const page of pages)
    requireState(
      parseFilePageURL(page.url, contextId).fileId === candidate.fileId,
      'File-details source page identifies another file'
    );
  requireState(
    new Set(pages.map((page) => page.url)).size <= 1,
    'File-details source pages are ambiguous'
  );
  if (pages.length) {
    requireState(
      index(candidate.filePageIndex) &&
        pages.some(
          (page) => page.index === candidate.filePageIndex && page.url === candidate.filePageURL
        ),
      'File-details opener lost its observed source page'
    );
  } else
    requireState(
      candidate.filePageIndex === null &&
        candidate.filePageURL === null &&
        candidate.mediaKind !== 'file',
      'File-details opener invented a source file page'
    );
  return { candidate, container, media, control, nodes };
}

export function selectFileDetailsOpener(preflight, resolved, proof, inventory) {
  requireState(
    ['file', 'document', 'audio', 'video'].includes(resolved.media.kind) &&
      /^[F][A-Z0-9]{1,63}$/.test(resolved.media.fileId ?? ''),
    'No supported file-details opener matches the attachment; reread its source'
  );
  requireState(
    !proof.tree.nodes.some((node) => has(node, 'p-file_details__references_footer')) &&
      !proof.earlierTree.nodes.some((node) => has(node, 'p-file_details__references_footer')),
    'An existing file-details pane cannot authorize a new opener'
  );
  const entries = inventory.filter((entry) => entry.candidate.scope === 'file-details-opener');
  const selected = entries.filter(({ candidate, media, container }) =>
    proof.groups.some(
      (group) =>
        group.media === media &&
        group.container === container &&
        candidate.fileId === resolved.media.fileId
    )
  );
  requireState(
    selected.length > 0,
    'No supported source-owned View file details opener is available for this attachment. File-page links and playback controls alone cannot authorize saving. Locate the same attachment with search, then inspect its reference with read-media.'
  );
  requireState(
    proof.groups.every((group) =>
      selected.some((entry) => entry.media === group.media && entry.container === group.container)
    ),
    'Supported file-details opener inventory is incomplete'
  );
  requireState(
    selected.every(
      ({ candidate }) =>
        candidate.mediaKind ===
        (['file', 'document'].includes(resolved.media.kind) ? 'file' : resolved.media.kind)
    ),
    'File-details opener kind differs from the verified attachment'
  );
  requireState(
    new Set(selected.map(({ candidate }) => candidate.filePageURL).filter(Boolean)).size <= 1,
    'File-details source page targets are ambiguous'
  );
  selected.sort((a, b) => a.candidate.controlIndex - b.candidate.controlIndex);
  return { ...selected[0].candidate, action: 'open-viewer' };
}

function idle(values, required = false) {
  return (
    Array.isArray(values) &&
    (!required || values.length > 0) &&
    values.every(
      (value) =>
        value &&
        typeof value.label === 'string' &&
        /^Play(?:,|$)/.test(value.label) &&
        value.value === '0'
    )
  );
}
export function verifyDetailsPlayback(playback, mediaKind) {
  requireState(
    playback &&
      idle(playback.source, ['audio', 'video'].includes(mediaKind)) &&
      idle(playback.viewer),
    'File-details source or viewer playback is not verified idle'
  );
}
function capturedPlayback(nodes) {
  const players = nodes.filter(
    (node) => node.role === 'AXCheckBox' && /^(?:Play|Pause)(?:,|$)/.test(node.label ?? '')
  );
  requireState(
    !nodes.some(
      (node) => node.role === 'AXButton' && /^(?:Play|Pause)(?:,|$)/.test(node.label ?? '')
    ),
    'File-details playback uses an unsupported control'
  );
  return players.map((node) => ({ label: node.label, value: node.stateValue }));
}

function verifyMenuCapture(capture, proof, opener) {
  requireState(
    capture?.content?.truncated === false && capture.source?.content?.truncated === false,
    'File-details menu or retained source capture is incomplete'
  );
  const tree = indexTree(capture.content.nodes),
    corner = tree.root;
  requireState(
    corner.index === 0 &&
      corner.role === 'AXGroup' &&
      has(corner, 'p-video_controls_overlay__corner') &&
      has(corner, 'p-video_controls_overlay__corner--gallery_v3'),
    'File-details menu is outside the source video corner'
  );
  const children = tree.children(corner);
  const popups = children.filter(
    (node) =>
      node.role === 'AXPopUpButton' &&
      node.label === 'More actions' &&
      has(node, 'p-video_message_file--gallery_v3__controls_overlay_ellipsis') &&
      has(node, 'p-video_controls_overlay__corner_button')
  );
  const popovers = children.filter(
    (node) =>
      node.role === 'AXGroup' &&
      [
        'ReactModal__Content',
        'ReactModal__Content--after-open',
        'popover',
        'c-popover__content',
      ].every((name) => has(node, name))
  );
  requireState(
    popups.length === 1 &&
      popovers.length === 1 &&
      children.every(
        (node) =>
          node === popups[0] ||
          node === popovers[0] ||
          (node.role === 'AXButton' &&
            ['View transcript', 'Expand', 'Dock to corner'].includes(node.label) &&
            has(node, 'c-icon_button') &&
            !node.url &&
            tree.descendants(node).length === 0)
      ) &&
      popups[0].index === capture.openerIndex &&
      popups[0].enabled !== false &&
      !popups[0].url,
    'File-details menu ownership or opener is ambiguous'
  );
  const menus = tree.nodes.filter((node) => node.role === 'AXMenu');
  requireState(
    menus.length === 1 &&
      menus[0].index === capture.menuIndex &&
      menus[0].parent === popovers[0].index &&
      has(menus[0], 'c-menu__items') &&
      tree.children(popovers[0]).length === 1 &&
      !tree.nodes.some((node) => composer(node) || ['AXDialog', 'AXSheet'].includes(node.role)),
    'File-details source menu structure is unsupported'
  );
  const items = tree.children(menus[0]);
  const details = items.filter(
    (node) => node.role === 'AXMenuItem' && node.label === 'View details'
  );
  const detailChildren = details.length === 1 ? tree.children(details[0]) : [];
  const detailLabel =
    detailChildren.length === 1 &&
    detailChildren[0].role === 'AXGroup' &&
    has(detailChildren[0], 'c-menu_item__label')
      ? tree.children(detailChildren[0])
      : detailChildren;
  requireState(
    details.length === 1 &&
      details[0].index === capture.controlIndex &&
      has(details[0], 'c-menu_item__button') &&
      details[0].enabled !== false &&
      !details[0].url &&
      detailChildren.length === 1 &&
      detailLabel.length === 1 &&
      detailLabel[0].role === 'AXStaticText' &&
      detailLabel[0].label === 'View details' &&
      tree.descendants(details[0]).length === (detailChildren[0].role === 'AXGroup' ? 2 : 1) &&
      equal(
        items.filter((node) => node.role === 'AXMenuItem').map((node) => node.label),
        ['Download', 'Share file…', 'Copy link', 'Open in', 'View details', 'Add to section']
      ) &&
      items.filter((node) => node.role === 'AXSplitter').length === 2 &&
      items.every(
        (node) =>
          node.role === 'AXSplitter' ||
          (node.role === 'AXMenuItem' && has(node, 'c-menu_item__button'))
      ),
    'File-details menu has no unique supported View details item'
  );
  const sourceTree = indexTree(capture.source.content.nodes);
  const sourceControl = sourceTree.nodes.find((node) => node.index === capture.source.controlIndex);
  const sourceCorner = sourceTree.nodes.find((node) => node.index === sourceControl?.parent);
  const overlay = sourceTree.nodes.find((node) => node.index === sourceCorner?.parent);
  const media = sourceTree.nodes.find((node) => node.index === capture.source.mediaIndex);
  const sourcePopover =
    sourceCorner &&
    sourceTree.children(sourceCorner).find((node) => has(node, 'c-popover__content'));
  const group = proof.groups.find(
    (entry) =>
      entry.container.index === opener.containerIndex && entry.media.index === opener.mediaIndex
  );
  requireState(
    group &&
      sourceCorner &&
      sourcePopover &&
      overlay &&
      media &&
      signature(sourceTree, sourceCorner) === signature(tree, corner) &&
      has(overlay, 'p-video_controls_overlay') &&
      overlay.parent === media.index &&
      sourceControl.role === 'AXPopUpButton' &&
      sourceSignature(sourceTree, sourceTree.root, capture.source.mediaIndex, {
        popover: sourcePopover,
        overlay,
      }) === sourceSignature(proof.tree, group.container, group.media.index),
    'File-details menu is not bound to the retained original source'
  );
  requireState(
    sourcePositionsMatch(proof, group, opener, sourceTree, capture.source, {
      popover: sourcePopover,
      overlay,
    }) &&
      equal(sourceIDs([media, ...ownNodes(media, sourceTree)], 'video'), [opener.fileId]) &&
      idle(capturedPlayback([media, ...sourceTree.descendants(media)]), true) &&
      equal(capturedPlayback([media, ...sourceTree.descendants(media)]), capture.source.playback),
    'File-details menu source identity or idle playback changed'
  );
  return signature(tree, corner);
}

function verifyDetailsMenu(value, proof, opener) {
  verifyDetailsMenuAction(value.detailsMenuAction, opener.openerKind);
  if (opener.openerKind === 'details-button') {
    requireState(
      value.detailsMenu == null ||
        (Array.isArray(value.detailsMenu.observations) &&
          value.detailsMenu.observations.length === 0),
      'A direct file-details opener cannot claim menu observations'
    );
    return;
  }
  requireState(
    Array.isArray(value.detailsMenu?.observations) && value.detailsMenu.observations.length === 2,
    'File-details menu requires two source-bound observations'
  );
  const [before, after] = value.detailsMenu.observations.map((capture) =>
    verifyMenuCapture(capture, proof, opener)
  );
  requireState(before === after, 'File-details source menu changed before View details');
}

function detailsCapture(capture, proof, opener, resolved) {
  requireState(
    capture?.content?.truncated === false && capture.source?.content?.truncated === false,
    'File-details or retained source capture is incomplete'
  );
  requireState(
    [capture.before, capture.after].every(
      (view) => view?.url === resolved.view.url && view.title === resolved.view.title
    ),
    'File-details capture changed the verified workspace/view'
  );
  const group = proof.groups.find(
    (entry) =>
      entry.container.index === opener.containerIndex && entry.media.index === opener.mediaIndex
  );
  const sourceTree = indexTree(capture.source.content.nodes);
  requireState(
    group &&
      sourceTree.root.index === 0 &&
      sourceSignature(sourceTree, sourceTree.root, capture.source.mediaIndex) ===
        sourceSignature(proof.tree, group.container, group.media.index),
    'Retained attachment source changed while opening file details'
  );
  requireState(
    sourcePositionsMatch(proof, group, opener, sourceTree, capture.source),
    'Retained file-details source control identity changed'
  );
  verifyDetailsPlayback(capture.detailsPlayback, opener.mediaKind);
  const sourceMedia = sourceTree.nodes.find((node) => node.index === capture.source.mediaIndex);
  requireState(
    sourceMedia &&
      equal(
        capturedPlayback([sourceMedia, ...sourceTree.descendants(sourceMedia)]),
        capture.detailsPlayback.source
      ),
    'File-details source playback differs from its capture'
  );
  const tree = indexTree(capture.content.nodes),
    pane = tree.root;
  requireState(
    pane.index === 0 &&
      pane.role === 'AXGroup' &&
      has(pane, 'p-view_contents') &&
      has(pane, 'p-view_contents--secondary') &&
      tree.nodes.filter((node) => has(node, 'p-view_contents--secondary')).length === 1 &&
      !tree.nodes.some(
        (node) =>
          has(node, 'p-media_viewer_modal') ||
          composer(node) ||
          ['AXDialog', 'AXSheet', 'AXMenu'].includes(node.role)
      ),
    'File-details capture is not one supported isolated pane'
  );
  const children = tree.children(pane);
  const headers = children.filter(
    (node) => node.role === 'AXToolbar' && has(node, 'p-flexpane_header')
  );
  const bodies = children.filter(
    (node) => node.role === 'AXGroup' && has(node, 'p-flexpane__body')
  );
  const footers = children.filter(
    (node) =>
      node.role === 'AXGroup' &&
      has(node, 'c-file__actions') &&
      has(node, 'p-file_details__references_footer')
  );
  requireState(
    headers.length === 1 && bodies.length === 1 && footers.length === 1,
    'File-details header, body or footer is ambiguous'
  );
  const closes = tree
    .children(headers[0])
    .filter(
      (node) =>
        node.role === 'AXButton' &&
        node.label === 'Close' &&
        has(node, 'p-flexpane_header__control')
    );
  requireState(
    closes.length === 1 && closes[0].enabled !== false,
    'File-details scoped Close is unavailable or ambiguous'
  );
  const cards = tree
    .children(bodies[0])
    .filter(
      (node) =>
        node.role === 'AXGroup' &&
        ((has(node, 'c-pillow_file_container') && has(node, 'p-message_file')) ||
          (has(node, 'p-video_message_file') && has(node, 'p-video_message_file--gallery_v3')))
    );
  requireState(cards.length === 1, 'File-details active file card is absent or ambiguous');
  const card = cards[0];
  const links = tree
    .children(card)
    .filter((node) => node.role === 'AXLink' && has(node, 'p-file_link_button--link'));
  requireState(links.length <= 1, 'File-details active file link is ambiguous');
  const fileLink = links[0] ?? null;
  const cardNodes = [card, ...tree.descendants(card)];
  let identity;
  if (fileLink) {
    requireState(
      parseFilePageURL(fileLink.url, proof.contextId).fileId === opener.fileId &&
        (opener.filePageURL === null || opener.filePageURL === fileLink.url),
      'File-details active page does not match the retained source'
    );
    identity = fileLink;
  } else {
    const identities = tree
      .descendants(card)
      .filter(
        (node) =>
          node.role === 'AXGroup' &&
          has(node, 'sr-only') &&
          node.id ===
            `${opener.mediaKind === 'audio' ? 'transcript' : 'caption'}-description-${opener.fileId}`
      );
    requireState(
      opener.filePageURL === null &&
        ['audio', 'video'].includes(opener.mediaKind) &&
        identities.length === 1,
      'File-details active card has no unique source-bound file identity'
    );
    identity = identities[0];
  }
  requireState(
    equal(sourceIDs(cardNodes, opener.mediaKind), [opener.fileId]),
    'File-details active card does not match the retained source file'
  );
  const playerCard = opener.mediaKind === 'audio' && has(card, 'p-message_file--audio_message');
  const videoCard =
    opener.mediaKind === 'video' &&
    has(card, 'p-video_message_file') &&
    has(card, 'p-video_message_file--gallery_v3');
  requireState(
    !tree.descendants(card).some((node) => isMediaRoot(node) || composer(node)),
    'File-details active card contains unsupported playback or nested media controls'
  );
  const playback = capturedPlayback(cardNodes);
  requireState(
    equal(playback, capture.detailsPlayback.viewer) &&
      (!(playerCard || videoCard) || playback.length === 1) &&
      (playback.length === 0 ||
        ((playerCard || videoCard) &&
          playback.length === 1 &&
          cardNodes.some(
            (node) =>
              node.role === 'AXCheckBox' &&
              (playerCard
                ? has(node, 'c-audio_player_play_button') && node.label === 'Play'
                : has(node, 'p-video_controls_overlay__controls__pill') &&
                  /^Play,/.test(node.label ?? '')) &&
              node.stateValue === '0'
          ))),
    'File-details viewer playback differs from its supported idle card'
  );
  const footer = footers[0];
  const downloads = tree
    .descendants(footer)
    .filter((node) => controls.has(node.role) && /^download\b/i.test(node.label ?? ''));
  requireState(
    downloads.length === 1 &&
      downloads[0].parent === footer.index &&
      downloads[0].role === 'AXLink' &&
      /^Download(?: .+)?$/.test(downloads[0].label ?? '') &&
      !['Download all', 'Download all files'].includes(downloads[0].label) &&
      has(downloads[0], 'p-file_details__references_actions') &&
      has(downloads[0], 'c-message_actions__button') &&
      downloads[0].enabled !== false,
    'File-details Download control is absent, ambiguous or unsupported'
  );
  const control = downloads[0],
    route = parseObservedDownloadURL(control.url);
  requireState(route.fileId === opener.fileId, 'File-details Download identifies another file');
  return {
    tree,
    pane,
    card,
    fileLink,
    identity,
    footer,
    control,
    route,
    playback: capture.detailsPlayback,
  };
}

export function selectFileDetailsDownload(
  viewerPreflight,
  preflight,
  resolved,
  opener,
  expected,
  proof,
  { originalRequired = false } = {}
) {
  requireState(
    expected.action === 'open-viewer' &&
      openerKeys.every((key) => opener?.[key] === expected[key]) &&
      openerKeys.every((key) => viewerPreflight?.opener?.[key] === expected[key]),
    'File-details selection does not match the authorized source opener'
  );
  verifyDetailsMenu(viewerPreflight, proof, opener);
  const captures = viewerPreflight.observations.map((capture) =>
    detailsCapture(capture, proof, opener, resolved)
  );
  const current = captures[1];
  requireState(
    signature(captures[0].tree, captures[0].card) === signature(current.tree, current.card) &&
      signature(captures[0].tree, captures[0].footer) === signature(current.tree, current.footer) &&
      equal(captures[0].playback, current.playback),
    'Active file details changed between captures'
  );
  requireState(
    Array.isArray(viewerPreflight.candidates) && viewerPreflight.candidates.length === 1,
    'File-details Download candidate inventory must contain exactly one control'
  );
  const candidate = viewerPreflight.candidates[0];
  requireState(
    token(candidate?.token) &&
      candidate.scope === 'file-details' &&
      candidate.openerToken === opener.token &&
      ['paneIndex', 'cardIndex', 'identityIndex', 'footerIndex', 'controlIndex'].every((key) =>
        index(candidate[key])
      ) &&
      (candidate.fileLinkIndex === null || index(candidate.fileLinkIndex)) &&
      candidate.paneIndex === current.pane.index &&
      candidate.cardIndex === current.card.index &&
      candidate.identityIndex === current.identity.index &&
      candidate.fileLinkIndex === (current.fileLink?.index ?? null) &&
      candidate.footerIndex === current.footer.index &&
      candidate.controlIndex === current.control.index &&
      candidate.filePageURL === (current.fileLink?.url ?? null) &&
      candidate.fileId === opener.fileId &&
      candidate.mediaKind === opener.mediaKind &&
      candidate.openerKind === opener.openerKind &&
      candidate.url === current.control.url &&
      candidate.routeKind === downloadRouteKind(candidate.url, proof.contextId),
    'File-details Download candidate differs from the active file or scoped control'
  );
  const evidence = fileDownloadEvidence(
    candidate.url,
    { fileId: opener.fileId, filePageUrl: current.fileLink?.url },
    proof.contextId
  );
  requireState(
    !originalRequired || evidence !== null,
    'No source-bound original file Download route is exposed in file details'
  );
  return {
    ...candidate,
    route: current.route,
    fileDownloadEvidence: evidence,
    contextId: proof.contextId,
    detailsPlayback: current.playback,
    detailsMenuAction: viewerPreflight.detailsMenuAction,
  };
}
