// A viewer is an additional source-bound step, never a retry for a rejected
// Download. Supported routes are the static image viewer and verified file details.
import { parseViewerSourceURL } from './slack-download-store.mjs';
import { isMediaRoot } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import { selectSaveMediaCandidate, verifiedSaveMediaSource } from './slack-save-media.mjs';
import {
  validateFileDetailsOpener,
  selectFileDetailsOpener,
  selectFileDetailsDownload,
} from './slack-save-details.mjs';

const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const has = (node, name) => node?.classes?.includes(name) === true;
const exactClasses = (node, names) =>
  node?.classes?.length === names.length && names.every((name) => has(node, name));
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
const indices = (value, names) =>
  names.every((name) => Number.isSafeInteger(value?.[name]) && value[name] >= 0);
const openerKeys = [
  'token',
  'scope',
  'containerIndex',
  'mediaIndex',
  'controlIndex',
  'sourceURL',
  'fileId',
  'ownerTeamId',
];
const controlRoles = new Set(['AXLink', 'AXButton', 'AXMenuItem', 'AXPopUpButton']);

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
  const local = new Map(nodes.map((node, index) => [node.index, index]));
  return nodes.map((node, index) => ({
    ...node,
    index,
    parent: index === 0 ? null : local.get(node.parent),
  }));
}

const signature = (tree, root) => JSON.stringify(canonical(subtree(tree, root)));

function existingFileToolbar(tree, root, offscreen) {
  if (root.role !== 'AXGroup' || !has(root, 'c-message_kit__actions')) return null;
  const rootClasses = ['c-message_actions__container', 'c-message__actions'];
  const rootMarkers = [...rootClasses, 'c-message__actions--offscreen'];
  const source = [root, ...tree.descendants(root)];
  const candidates = source.filter((node) => rootMarkers.some((name) => has(node, name)));
  if (candidates.length !== 1 || candidates[0].parent !== root.index) return null;
  const toolbar = [candidates[0], ...tree.descendants(candidates[0])];
  if (toolbar.length !== 9) return null;
  const owned = new Set(toolbar.map((node) => node.index));
  if (
    source.some(
      (node) =>
        node.classes.some((name) =>
          ['c-message_actions__', 'c-message-actions--', 'c-message__actions'].some((prefix) =>
            name.startsWith(prefix)
          )
        ) && !owned.has(node.index)
    )
  )
    return null;
  const button = [
    'c-button--focus-visible',
    'c-button-unstyled',
    'c-icon_button',
    'c-icon_button--size_smedium',
    'c-message_actions__button',
    'c-icon_button--default',
  ];
  const shape = [
    [-1, 'AXGroup', offscreen ? rootMarkers : rootClasses, ''],
    [
      0,
      'AXGroup',
      ['c-message_actions__group', 'c-message-actions--hover-actions'],
      'Message actions',
    ],
    [1, 'AXGroup', ['container___lGTS'], ''],
    [2, 'AXButton', button, 'Add reaction…', ''],
    [1, 'AXButton', button, 'Reply in thread', ''],
    [1, 'AXButton', button, 'Forward file…', ''],
    [1, 'AXButton', button, 'Add to-do', ''],
    [1, 'AXPopUpButton', button, 'Ask Slackbot', ''],
    [1, 'AXPopUpButton', [...button, 'c-message_actions__button--more'], 'More actions', ''],
  ];
  const plain = [
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
  const matches = shape.every(([parent, role, classes, label, state], index) => {
    const node = toolbar[index];
    const keys = state === undefined ? plain : [...plain, 'stateValue', 'selected'];
    return (
      Object.keys(node).length === keys.length &&
      keys.every((key) => Object.hasOwn(node, key)) &&
      node.parent === (parent === -1 ? root.index : toolbar[parent].index) &&
      node.role === role &&
      exactClasses(node, classes) &&
      node.id === '' &&
      node.label === label &&
      node.AXTitle === label &&
      node.AXDescription === label &&
      node.AXValue === '' &&
      node.AXHelp === '' &&
      (state === undefined || (node.stateValue === state && node.selected === false))
    );
  });
  return matches ? candidates[0] : null;
}

// Only an already present, complete file-actions toolbar may become offscreen
// while the verified viewer is open. Preserve every other raw source field.
function retainedViewerSourceMatches(initialTree, initialRoot, currentTree) {
  const before = subtree(initialTree, initialRoot);
  const after = subtree(currentTree, currentTree.root);
  const beforeSignature = JSON.stringify(canonical(before));
  if (beforeSignature === JSON.stringify(canonical(after))) return true;
  if (before.length !== after.length) return false;
  const original = existingFileToolbar(initialTree, initialRoot, false);
  const current = existingFileToolbar(currentTree, currentTree.root, true);
  if (!original || !current) return false;
  const currentRows = [currentTree.root, ...currentTree.descendants(currentTree.root)];
  const currentIndex = currentRows.findIndex((node) => node.index === current.index);
  after[currentIndex].classes = after[currentIndex].classes.filter(
    (name) => name !== 'c-message__actions--offscreen'
  );
  return beforeSignature === JSON.stringify(canonical(after));
}

function ownedNodes(group, tree) {
  const within = new Set(tree.descendants(group.media).map((node) => node.index));
  return tree
    .descendants(group.media)
    .filter(
      (node) =>
        !tree.ancestor(
          node,
          (parent) =>
            within.has(parent.index) &&
            (isMediaRoot(parent) ||
              has(parent, 'c-message_kit__actions') ||
              has(parent, 'p-message_input'))
        )
    );
}

function rawDownloads(groups, tree) {
  return groups.flatMap((group) =>
    ownedNodes(group, tree).filter(
      (node) => controlRoles.has(node.role) && /^download\b/i.test(node.label ?? '')
    )
  );
}

function galleryOpeners(group, tree, contextId, fileId) {
  if (
    group.binding.media.kind !== 'image' ||
    group.media.role !== 'AXGroup' ||
    !has(group.media, 'p-message_gallery_image_file') ||
    !has(group.media, 'c-file_gallery_image_file')
  )
    return [];
  return ownedNodes(group, tree).filter((node) => {
    if (
      node.role !== 'AXLink' ||
      !has(node, 'p-file_image_thumbnail__wrapper') ||
      node.parent !== group.media.index ||
      node.enabled === false
    )
      return false;
    if (
      tree
        .descendants(node)
        .filter((child) => child.role === 'AXImage' && has(child, 'p-file_image_thumbnail__image'))
        .length !== 1
    )
      return false;
    try {
      return parseViewerSourceURL(node.url, contextId).fileId === fileId;
    } catch {
      return false;
    }
  });
}

function validateImageOpener(candidate, proof) {
  const { tree, contextId } = proof;
  requireState(candidate.scope === 'viewer-opener', 'Viewer opener scope is unsupported');
  const container = proof.indexed.get(candidate.containerIndex),
    media = proof.indexed.get(candidate.mediaIndex),
    control = proof.indexed.get(candidate.controlIndex);
  requireState(
    container &&
      has(container, 'c-message_kit__actions') &&
      media?.role === 'AXGroup' &&
      has(media, 'p-message_gallery_image_file') &&
      has(media, 'c-file_gallery_image_file') &&
      tree.descendants(container).includes(media) &&
      control?.role === 'AXLink' &&
      has(control, 'p-file_image_thumbnail__wrapper') &&
      control.parent === media.index &&
      control.enabled !== false &&
      tree.ancestor(media, (node) => has(node, 'c-message_kit__actions')) === container,
    'Viewer opener is outside its captured static image attachment'
  );
  const route = parseViewerSourceURL(control.url, contextId);
  requireState(
    candidate.sourceURL === control.url &&
      candidate.fileId === route.fileId &&
      candidate.ownerTeamId === route.teamId,
    'Viewer opener URL or file identity differs from its captured source'
  );
  return { candidate, container, media, control, route };
}

export function selectSaveMediaAction(preflight, resolved, { originalRequired = false } = {}) {
  requireState(
    typeof originalRequired === 'boolean',
    'Original selection requirement must be boolean'
  );
  const proof = verifiedSaveMediaSource(preflight, resolved);
  const { groups, earlier, tree, earlierTree, contextId } = proof;
  // Include disabled and unsupported Download controls. Filtering one out must
  // never turn an ambiguous or unsafe direct selection into viewer permission.
  if (rawDownloads(groups, tree).length || rawDownloads(earlier, earlierTree).length)
    return {
      ...selectSaveMediaCandidate(preflight, resolved, { originalRequired }),
      action: 'download',
    };
  requireState(
    groups.length > 0 &&
      earlier.length === groups.length &&
      resolved.sources.every((source) =>
        groups.some((group) => group.messageRef === source.messageRef)
      ),
    'Viewer fallback requires every verified attachment source to remain exposed'
  );
  const sourceInventory = (entries, sourceTree) =>
    entries.map((group) => signature(sourceTree, group.container)).sort();
  requireState(
    JSON.stringify(sourceInventory(groups, tree)) ===
      JSON.stringify(sourceInventory(earlier, earlierTree)),
    'Viewer source changed between captures'
  );
  requireState(
    !tree.nodes.some((node) => has(node, 'p-media_viewer_modal')) &&
      !earlierTree.nodes.some((node) => has(node, 'p-media_viewer_modal')),
    'An existing media viewer cannot authorize a new opener'
  );
  requireState(
    Array.isArray(preflight.viewerCandidates) && preflight.viewerCandidates.length <= 1000,
    'Viewer opener inventory is unavailable or exceeds bounds'
  );
  const tokens = new Set(),
    controls = new Set();
  const inventory = preflight.viewerCandidates.map((candidate) => {
    requireState(
      token(candidate?.token) &&
        indices(candidate, ['containerIndex', 'mediaIndex', 'controlIndex']) &&
        !tokens.has(candidate.token) &&
        !controls.has(candidate.controlIndex),
      'Viewer opener identity is malformed or duplicated'
    );
    tokens.add(candidate.token);
    controls.add(candidate.controlIndex);
    return candidate.scope === 'file-details-opener'
      ? validateFileDetailsOpener(candidate, proof)
      : validateImageOpener(candidate, proof);
  });
  if (resolved.media.kind !== 'image')
    return selectFileDetailsOpener(preflight, resolved, proof, inventory);
  requireState(
    /^[F][A-Z0-9]+$/.test(resolved.media.fileId ?? ''),
    'No supported static image viewer opener matches the attachment; reread its source'
  );
  const observed = groups.flatMap((group) =>
    galleryOpeners(group, tree, contextId, resolved.media.fileId).map((control) => ({
      group,
      control,
    }))
  );
  const matches = [];
  for (const { candidate, container, media, control, route } of inventory.filter(
    (entry) => entry.candidate.scope === 'viewer-opener'
  )) {
    // Native inventories every gallery, just as it inventories every Download.
    // Only the immutable resolved source groups may supply the selected action.
    if (
      !groups.some(
        (group) => group.container.index === container.index && group.media.index === media.index
      )
    )
      continue;
    const entry = observed.find(
      ({ group, control }) =>
        group.container.index === candidate.containerIndex &&
        group.media.index === candidate.mediaIndex &&
        control.index === candidate.controlIndex
    );
    requireState(entry, 'Viewer opener is outside its verified static image attachment');
    requireState(
      candidate.sourceURL === entry.control.url &&
        candidate.fileId === route.fileId &&
        candidate.ownerTeamId === route.teamId &&
        candidate.fileId === resolved.media.fileId,
      'Viewer opener URL or file identity differs from its verified source'
    );
    matches.push({ ...candidate, action: 'open-viewer' });
  }
  requireState(
    observed.length > 0 &&
      matches.length === observed.length &&
      groups.every((group) => observed.some((entry) => entry.group === group)),
    'Supported viewer opener inventory is incomplete; no target was selected'
  );
  requireState(
    new Set(matches.map((candidate) => candidate.sourceURL)).size === 1,
    'Viewer opener targets are ambiguous; reread the source before selecting'
  );
  matches.sort((a, b) => a.controlIndex - b.controlIndex);
  return matches[0];
}

function viewerCapture(capture, initial, opener, resolved) {
  requireState(
    capture?.content?.truncated === false && capture.source?.content?.truncated === false,
    'Viewer or retained source capture is incomplete'
  );
  requireState(
    [capture.before, capture.after].every(
      (view) => view?.url === resolved.view.url && view.title === resolved.view.title
    ),
    'Viewer capture changed the verified workspace/view'
  );
  const sourceTree = indexTree(capture.source.content.nodes);
  const initialGroup = initial.groups.find(
    (group) =>
      group.container.index === opener.containerIndex && group.media.index === opener.mediaIndex
  );
  requireState(
    initialGroup && retainedViewerSourceMatches(initial.tree, initialGroup.container, sourceTree),
    'Retained attachment source changed while opening the viewer'
  );
  const normalized = subtree(initial.tree, initialGroup.container);
  const initialNodes = [
    initialGroup.container,
    ...initial.tree.descendants(initialGroup.container),
  ];
  requireState(
    capture.source.mediaIndex ===
      initialNodes.findIndex((node) => node.index === opener.mediaIndex) &&
      capture.source.controlIndex ===
        initialNodes.findIndex((node) => node.index === opener.controlIndex) &&
      sourceTree.root.index === 0 &&
      normalized.length === sourceTree.nodes.length,
    'Retained viewer opener is not the originally verified source element'
  );
  const tree = indexTree(capture.content.nodes),
    modal = tree.root;
  requireState(
    modal.index === 0 &&
      modal.role === 'AXGroup' &&
      has(modal, 'p-media_viewer_modal') &&
      typeof modal.id === 'string' &&
      modal.id.length > 0 &&
      tree.nodes.filter((node) => has(node, 'p-media_viewer_modal')).length === 1,
    'Viewer capture is not one identified Slack media modal'
  );
  const multimedia = tree
    .children(modal)
    .filter((node) => has(node, 'p-media_viewer_modal__multimedia'));
  requireState(multimedia.length === 1, 'Active viewer multimedia region is ambiguous');
  const branches = tree
    .children(multimedia[0])
    .filter((node) => has(node, 'p-media_viewer_modal__multimedia_video'));
  requireState(branches.length === 1, 'Active viewer media branch is ambiguous');
  const branch = branches[0];
  const closes = tree.nodes.filter((node) => has(node, 'p-media_viewer_modal__tabs_close'));
  requireState(
    closes.length === 1 &&
      closes[0].role === 'AXButton' &&
      closes[0].label === 'Close' &&
      [multimedia[0].index, branch.index].includes(closes[0].parent),
    'Viewer Close control is absent, ambiguous, or outside its verified owner'
  );
  const close = closes[0],
    closeOwner = close.parent === branch.index ? 'active-branch' : 'multimedia';
  const viewers = tree.children(branch).filter((node) => has(node, 'p-file_viewer'));
  const footers = tree
    .children(branch)
    .filter((node) => node.role === 'AXToolbar' && has(node, 'p-media_viewer_modal__footer'));
  requireState(
    viewers.length === 1 && footers.length === 1,
    'Active viewer file or controls are ambiguous'
  );
  const media = viewers[0],
    footer = footers[0];
  const contents = tree
    .children(media)
    .filter((node) => node.role === 'AXGroup' && has(node, 'p-file_viewer__content'));
  requireState(contents.length === 1, 'Active viewer file content is ambiguous');
  const imageViewers = tree.children(contents[0]);
  requireState(
    imageViewers.length === 1 &&
      imageViewers[0].role === 'AXGroup' &&
      has(imageViewers[0], 'p-image_viewer'),
    'Active viewer content must contain one static image viewer'
  );
  const images = tree.children(imageViewers[0]);
  requireState(
    images.length === 1 && images[0].role === 'AXImage' && has(images[0], 'p-image_viewer__image'),
    'Active viewer must expose one static image'
  );
  const image = images[0];
  requireState(
    image.url === opener.sourceURL &&
      parseViewerSourceURL(image.url, initial.contextId).fileId === opener.fileId,
    'Active viewer image does not match the exact source URL'
  );
  const branchNodes = tree.descendants(branch);
  // Slack represents its footer's thread visibility toggle as a checkbox. It
  // is not a player, and is never selected or pressed by this operation.
  const threadToggles = branchNodes.filter(
    (node) =>
      node.role === 'AXCheckBox' &&
      node.parent === footer.index &&
      node.label === 'Show thread' &&
      has(node, 'p-media_viewer_toggle_thread_button') &&
      has(node, 'p-media_viewer_modal__icon_button') &&
      ['0', '1'].includes(node.stateValue) &&
      !node.url
  );
  requireState(
    threadToggles.length <= 1 &&
      !branchNodes.some(
        (node) =>
          (node.role === 'AXCheckBox' && !threadToggles.includes(node)) ||
          (['AXButton', 'AXCheckBox'].includes(node.role) &&
            /^(Play|Pause)/.test(node.label ?? '')) ||
          has(node, 'p-video_message_file') ||
          has(node, 'c-audio_player') ||
          has(node, 'p-message_input') ||
          has(node, 'c-message_kit__actions')
      ),
    'Active viewer branch contains playback or message controls'
  );
  const downloads = tree
    .descendants(branch)
    .filter((node) => controlRoles.has(node.role) && /^download\b/i.test(node.label ?? ''));
  const download = downloads[0];
  // This observed footer variant omits the legacy file-viewer header class.
  // Bind its exact button state and class sets to the same verified footer.
  const modernClasses = [
    'c-button-unstyled',
    'c-icon_button',
    'c-icon_button--size_medium',
    'p-media_viewer_modal__icon_button',
    'c-icon_button--dark',
  ];
  const modernDownload =
    downloads.length === 1 &&
    download.id === '' &&
    download.selected === false &&
    download.stateValue === '' &&
    download.AXValue === '' &&
    tree.children(download).length === 0 &&
    (exactClasses(download, modernClasses) ||
      exactClasses(download, ['c-button--focus-visible', ...modernClasses])) &&
    footer.id === '' &&
    footer.label === 'Media controls' &&
    !footer.url &&
    exactClasses(footer, [
      'p-media_viewer_modal__footer',
      'p-media_viewer_modal__footer--slide_over_content',
    ]);
  requireState(
    downloads.length === 1 &&
      download.parent === footer.index &&
      download.role === 'AXButton' &&
      download.label === 'Download' &&
      ((has(download, 'p-file_viewer__header__button') &&
        has(download, 'p-media_viewer_modal__icon_button')) ||
        modernDownload) &&
      download.enabled !== false &&
      !download.url,
    'Viewer Download control is absent, ambiguous, or unsupported'
  );
  return {
    tree,
    modal,
    branch,
    media,
    image,
    footer,
    close,
    closeOwner,
    sourceSignature: signature(sourceTree, sourceTree.root),
    control: download,
  };
}

export function selectViewerDownloadCandidate(
  viewerPreflight,
  preflight,
  resolved,
  opener,
  { originalRequired = false } = {}
) {
  requireState(
    typeof originalRequired === 'boolean',
    'Original selection requirement must be boolean'
  );
  const expectedOpener = selectSaveMediaAction(preflight, resolved, { originalRequired: false });
  requireState(
    expectedOpener.action === 'open-viewer' &&
      viewerPreflight?.operation === 'save-media' &&
      viewerPreflight.phase === 'viewer-select' &&
      viewerPreflight.requested === preflight.requested &&
      viewerPreflight.pid === preflight.pid,
    'Viewer selection does not match the authorized source opener'
  );
  requireState(
    Array.isArray(viewerPreflight.observations) && viewerPreflight.observations.length === 2,
    'Viewer selection requires two fresh scoped captures'
  );
  const initial = verifiedSaveMediaSource(preflight, resolved);
  if (expectedOpener.scope === 'file-details-opener')
    return selectFileDetailsDownload(
      viewerPreflight,
      preflight,
      resolved,
      opener,
      expectedOpener,
      initial,
      { originalRequired }
    );
  requireState(
    openerKeys.every((key) => opener?.[key] === expectedOpener[key]) &&
      openerKeys.every((key) => viewerPreflight?.opener?.[key] === expectedOpener[key]),
    'Viewer selection does not match the authorized source opener'
  );
  const captures = viewerPreflight.observations.map((capture) =>
    viewerCapture(capture, initial, opener, resolved)
  );
  const current = captures[1];
  requireState(
    captures[0].modal.id === current.modal.id &&
      captures[0].sourceSignature === current.sourceSignature &&
      signature(captures[0].tree, captures[0].branch) === signature(current.tree, current.branch) &&
      captures[0].closeOwner === current.closeOwner &&
      signature(captures[0].tree, captures[0].close) === signature(current.tree, current.close),
    'Active viewer changed between captures'
  );
  requireState(
    Array.isArray(viewerPreflight.candidates) && viewerPreflight.candidates.length === 1,
    'Viewer Download candidate inventory must contain exactly one control'
  );
  const candidate = viewerPreflight.candidates[0];
  requireState(
    token(candidate?.token) &&
      candidate.scope === 'viewer' &&
      candidate.openerToken === opener.token &&
      indices(candidate, [
        'viewerIndex',
        'branchIndex',
        'mediaIndex',
        'imageIndex',
        'footerIndex',
        'controlIndex',
      ]) &&
      candidate.viewerIndex === current.modal.index &&
      candidate.branchIndex === current.branch.index &&
      candidate.mediaIndex === current.media.index &&
      candidate.imageIndex === current.image.index &&
      candidate.footerIndex === current.footer.index &&
      candidate.controlIndex === current.control.index &&
      candidate.url === null &&
      candidate.routeKind === 'unknown' &&
      candidate.sourceURL === opener.sourceURL &&
      candidate.fileId === opener.fileId &&
      candidate.ownerTeamId === opener.ownerTeamId,
    'Viewer Download candidate differs from its active image or scoped controls'
  );
  requireState(
    !originalRequired,
    'No source-bound original file Download route is exposed in the viewer. Rerun without --original to allow the observed viewer Download.'
  );
  return {
    ...candidate,
    route: { teamId: opener.ownerTeamId, fileId: opener.fileId },
    fileDownloadEvidence: null,
    contextId: initial.contextId,
    correlation: 'viewer-file-identity',
  };
}
