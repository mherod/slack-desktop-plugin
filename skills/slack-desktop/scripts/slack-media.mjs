// Pure metadata extraction from a verified message's AX subtree. No input or I/O.
const has = (node, name) => node?.classes?.includes(name) === true;
const label = (node) =>
  typeof node?.label === 'string' ? node.label.replace(/[\uE000\uE001]/g, '').trim() || null : null;
const rootClasses = new Set([
  'p-message_gallery_image_file',
  'c-file_gallery_image_file',
  'p-message_file',
  'c-pillow_file_container',
  'p-video_message_file',
  'p-search_file--audio-player',
]);
export const isMediaRoot = (node) => node?.classes?.some((name) => rootClasses.has(name)) === true;
const isPreview = (node) => has(node, 'c-message_attachment_v3');
const isHeader = (node) => has(node, 'c-message_kit__file');
const isComposer = (node) =>
  ['AXTextArea', 'AXTextField'].includes(node.role) ||
  node.classes?.some((name) => /^(?:p-composer|p-message_input|p-workspace__input)/.test(name));
const isNativeAudio = (node) =>
  node.role === 'AXGroup' &&
  ['c-pillow_file_container', 'p-message_file', 'p-message_file--audio_message'].every((name) =>
    has(node, name)
  );

function safeURL(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function slackURL(value) {
  const safe = safeURL(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.protocol === 'https:' &&
    (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
    ? url
    : null;
}

function fileIdFromURL(value) {
  const url = slackURL(value);
  if (!url) return null;
  if (url.hostname === 'files.slack.com') {
    return (
      url.pathname.match(
        /^\/files-(?:pri|tmb)\/[TE][A-Z0-9]+-(F[A-Z0-9]+)(?:-[a-zA-Z0-9]+)?\//
      )?.[1] ?? null
    );
  }
  return url.pathname.match(/^\/files\/U[A-Z0-9]+\/(F[A-Z0-9]+)(?:\/|$)/)?.[1] ?? null;
}

function messageLink(value) {
  const url = slackURL(value);
  return url && /^\/archives\/[CDG][A-Z0-9]+\/p\d+$/.test(url.pathname) ? value : null;
}

const unique = (values) => [...new Set(values.filter(Boolean))];
const sole = (values) => {
  const entries = unique(values);
  return entries.length === 1 ? entries[0] : null;
};
const fileName = (value) => (value && /^[^\n\r]+\.[a-zA-Z0-9]{1,12}$/.test(value) ? value : null);

function scopedDescendants(root, tree, excludeMedia = true) {
  const descendants = tree.descendants(root);
  const within = new Set(descendants.map((node) => node.index));
  const boundary = (node) =>
    isComposer(node) || has(node, 'c-message_kit__actions') || (excludeMedia && isMediaRoot(node));
  return descendants.filter(
    (node) =>
      !boundary(node) &&
      !tree.ancestor(node, (parent) => within.has(parent.index) && boundary(parent))
  );
}

export function quotedMessageSource(card, tree) {
  if (!has(card, 'c-message_attachment')) return null;
  const within = new Set(tree.descendants(card).map((node) => node.index));
  const nodes = scopedDescendants(card, tree).filter(
    (node) =>
      !has(node, 'c-message_attachment') &&
      !isPreview(node) &&
      !tree.ancestor(
        node,
        (parent) =>
          within.has(parent.index) && (has(parent, 'c-message_attachment') || isPreview(parent))
      )
  );
  const authors = nodes.filter((item) => has(item, 'c-message_attachment__author_name'));
  if (authors.length !== 1) return null;
  return {
    kind: 'quoted',
    author: label(authors[0]),
    permalink: sole(
      nodes
        .filter(
          (item) =>
            item.role === 'AXLink' &&
            !tree.ancestor(item, isPreview) &&
            (has(item, 'c-timestamp') ||
              has(item, 'c-message_attachment__permalink') ||
              tree.ancestor(item, (parent) => has(parent, 'c-message_attachment__footer')))
        )
        .map((item) => messageLink(item.url))
    ),
  };
}

function quoteProvenance(node, tree, container) {
  const quoted = tree.ancestor(node, (parent) => has(parent, 'c-message_attachment'));
  if (!quoted || !tree.descendants(container).some((item) => item.index === quoted.index))
    return null;
  return quotedMessageSource(quoted, tree);
}

function ownedNodes(container, tree) {
  return tree.descendants(container).filter((node) => {
    if (isComposer(node) || tree.ancestor(node, isComposer)) return false;
    const owner = tree.ancestor(node, (parent) => has(parent, 'c-message_kit__actions'));
    if (!owner || owner.index === container.index) return true;
    // A quoted card can contain its own message wrapper; unrelated nested rows cannot.
    return quoteProvenance(owner, tree, container) !== null;
  });
}

function mediaKind(node, content, header) {
  if (has(node, 'p-search_file--audio-player') || isNativeAudio(node)) return 'audio';
  if (has(node, 'p-video_message_file')) return 'video';
  if (has(node, 'p-message_gallery_image_file') || has(node, 'c-file_gallery_image_file'))
    return 'image';
  const labels = [...content, ...(header?.content ?? [])]
    .filter((item) => item.role === 'AXStaticText')
    .map(label);
  return labels.some((value) =>
    /^(?:PDF|Word document|Document|Spreadsheet|Presentation)$/i.test(value ?? '')
  )
    ? 'document'
    : 'file';
}

function transcriptState(content) {
  const buttons = content.filter((node) => node.role === 'AXButton').map(label);
  const available = buttons.some((value) =>
    /^View transcript(?: for this (?:audio|video))?$/.test(value ?? '')
  );
  const generatable = buttons.some((value) =>
    /^Generate transcript(?: for this (?:audio|video))?$/.test(value ?? '')
  );
  return { state: available === generatable ? 'unknown' : available ? 'available' : 'generatable' };
}

function audioTranscriptIds(node, content) {
  if (
    node.role !== 'AXGroup' ||
    !has(node, 'c-pillow_file_container') ||
    !(has(node, 'p-search_file--audio-player') || isNativeAudio(node)) ||
    !content.some((item) => item.role === 'AXCheckBox' && has(item, 'c-audio_player_play_button'))
  )
    return [];
  return content.flatMap((item) => {
    if (item.role !== 'AXGroup' || !has(item, 'sr-only') || typeof item.id !== 'string') return [];
    const match = item.id.match(/^transcript-description-(F[A-Z0-9]+)$/);
    return match?.[0] === item.id ? [match[1]] : [];
  });
}

function fileDetailsAvailable(node, content, tree) {
  if (
    node.role !== 'AXGroup' ||
    ![
      'c-pillow_file_container',
      'p-message_file',
      'p-search_file--audio-player',
      'p-video_message_file',
    ].some((name) => has(node, name))
  )
    return false;
  const buttons = content.filter(
    (item) => item.role === 'AXButton' && item.label === 'View file details'
  );
  const menus = has(node, 'p-video_message_file')
    ? content.filter((item) => item.role === 'AXPopUpButton' && item.label === 'More actions')
    : [];
  if (menus.length > 0) {
    if (buttons.length > 0 || menus.length !== 1) return false;
    const menu = menus[0];
    const corner = content.find((item) => item.index === menu.parent);
    const overlay = tree.ancestor(menu, (item) => has(item, 'p-video_controls_overlay'));
    return (
      has(node, 'p-video_message_file--gallery_v3') &&
      has(menu, 'p-video_message_file--gallery_v3__controls_overlay_ellipsis') &&
      has(menu, 'p-video_controls_overlay__corner_button') &&
      !has(menu, 'c-button--disabled') &&
      menu.enabled !== false &&
      !menu.url &&
      corner?.role === 'AXGroup' &&
      has(corner, 'p-video_controls_overlay__corner') &&
      has(corner, 'p-video_controls_overlay__corner--gallery_v3') &&
      overlay?.role === 'AXGroup' &&
      content.includes(overlay) &&
      !tree.ancestor(menu, isPreview) &&
      tree.ancestor(menu, isMediaRoot) === node
    );
  }
  if (buttons.length !== 1) return false;
  const button = buttons[0];
  const actions = content.find((item) => item.index === button.parent);
  return (
    has(button, 'c-message_actions__button') &&
    !has(button, 'c-button--disabled') &&
    button.enabled !== false &&
    !button.url &&
    actions?.role === 'AXGroup' &&
    has(actions, 'c-file__actions') &&
    !tree.ancestor(button, isPreview) &&
    tree.ancestor(button, isMediaRoot) === node
  );
}

function duration(content, tree) {
  const controls = content.filter((node) => node.role === 'AXCheckBox');
  const explicit = sole(controls.map((node) => label(node)?.match(/^(?:Play|Pause), (.+)$/)?.[1]));
  if (!explicit) return null;
  const time = content.find((node) => has(node, 'p-video_controls_overlay__time'));
  const displayed = time
    ? sole([
        label(time),
        ...tree
          .descendants(time)
          .filter((node) => node.role === 'AXStaticText')
          .map(label),
      ])
    : null;
  const parts = [...explicit.matchAll(/(\d+) (hours?|minutes?|seconds?)/g)];
  const recognized =
    parts.length > 0 &&
    explicit.replace(/\d+ (?:hours?|minutes?|seconds?)/g, '').replace(/[,\s]/g, '') === '';
  const total = recognized
    ? parts.reduce(
        (sum, [, number, unit]) =>
          sum +
          Number(number) * (unit.startsWith('hour') ? 3600 : unit.startsWith('minute') ? 60 : 1),
        0
      )
    : null;
  const clock =
    displayed && /^(?:\d+:)?\d{1,2}:\d{2}$/.test(displayed)
      ? displayed.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
      : null;
  return total !== null && total === clock ? displayed : explicit;
}

function mediaRecord(node, tree, context, header, container) {
  const content = [node, ...scopedDescendants(node, tree)];
  const kind = mediaKind(node, content, header);
  const links = content.filter((item) => item.role === 'AXLink' && safeURL(item.url));
  const download = links.filter((item) => /^Download(?:\s|$)/.test(label(item) ?? ''));
  const primary = links.filter((item) => !download.includes(item));
  const filePages = primary.filter((item) => {
    const url = slackURL(item.url);
    return url && /^\/files\/U[A-Z0-9]+\/F[A-Z0-9]+(?:\/|$)/.test(url.pathname);
  });
  const images = content.filter(
    (item) =>
      item.role === 'AXImage' &&
      !has(item, 'c-emoji') &&
      !tree.ancestor(item, (parent) => has(parent, 'c-emoji'))
  );
  const thumbnail =
    images.find((item) => has(item, 'p-file_image_thumbnail__image')) ??
    images.find((item) => has(item, 'p-file_thumbnail__image')) ??
    (kind === 'image' ? images[0] : null);
  const overlay = content.find((item) => has(item, 'p-video_controls_overlay'));
  const headerLabel = header
    ? (label(header.node) ??
      header.content
        .filter((item) => item.role === 'AXStaticText')
        .map(label)
        .find(Boolean))
    : null;
  const filename =
    fileName(label(node)) ??
    fileName(label(overlay)) ??
    primary.map((item) => fileName(label(item))).find(Boolean) ??
    download.map((item) => fileName(label(item)?.replace(/^Download\s+/, ''))).find(Boolean) ??
    null;
  const name =
    label(node) ??
    filename ??
    label(overlay) ??
    headerLabel ??
    label(primary[0]) ??
    (isHeader(node)
      ? content
          .filter((item) => item.role === 'AXStaticText')
          .map(label)
          .find(Boolean)
      : null) ??
    (kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'File');
  const ids = unique([
    ...content.map((item) => fileIdFromURL(item.url)),
    ...content.map((item) => item.id?.match(/^caption-description-(F[A-Z0-9]+)$/)?.[1]),
    ...audioTranscriptIds(node, content),
  ]);
  const fileId = ids.length === 1 ? ids[0] : null;
  const ref = fileId ?? (context.messageRef ? `${context.messageRef}/m${context.ordinal}` : null);
  const description = kind === 'image' ? label(thumbnail) : null;
  const playbackTime = content.find((item) => has(item, 'c-audio_player__time'));
  const transcript = transcriptState(content);
  // Native transcript input currently supports search audio and video sources.
  // Observed availability on a native audio card is metadata, not opener proof.
  if (
    ref &&
    ['audio', 'video'].includes(kind) &&
    transcript.state === 'available' &&
    (kind !== 'audio' || has(node, 'p-search_file--audio-player'))
  )
    transcript.navigation = { command: 'read-transcript', args: [ref] };
  else if (kind === 'audio' && isNativeAudio(node) && transcript.state === 'available')
    transcript.navigation = null;
  return {
    label: name,
    url: sole(primary.map((item) => item.url)) ?? sole(download.map((item) => item.url)),
    contentRead: false,
    kind,
    fileId,
    ref,
    navigation: ref ? { command: 'read-media', args: [ref] } : null,
    referenceScope: fileId ? 'workspace-file' : ref ? 'message-media' : null,
    filename,
    description,
    descriptionSource: description ? 'accessibility' : null,
    thumbnailUrl: safeURL(thumbnail?.url),
    filePageUrl: sole(filePages.map((item) => item.url)),
    downloadUrl: sole(download.map((item) => item.url)),
    ...(fileDetailsAvailable(node, content, tree) ? { fileDetailsAvailable: true } : {}),
    displayedDuration: duration(content, tree),
    displayedPlaybackTime: playbackTime
      ? sole([
          label(playbackTime),
          ...scopedDescendants(playbackTime, tree)
            .filter((item) => item.role === 'AXStaticText')
            .map(label),
        ])
      : null,
    transcript,
    provenance: quoteProvenance(node, tree, container),
  };
}

function previewRecord(node, tree, messageRef, ordinal, container) {
  const content = scopedDescendants(node, tree);
  const titles = content.filter((item) => has(item, 'c-message_attachment__title_link'));
  const title =
    titles.length === 1
      ? label(titles[0])
      : node.role === 'AXLink'
        ? (tree
            .children(node)
            .filter((item) => item.role === 'AXStaticText')
            .map(label)
            .find(Boolean) ?? null)
        : null;
  const footer = content.find((item) => has(item, 'c-message_attachment__footer_icon'));
  const provider = label(footer);
  const descriptions = content
    .filter(
      (item) =>
        item.role === 'AXStaticText' && !tree.ancestor(item, (parent) => titles.includes(parent))
    )
    .map(label)
    .filter((value) => value && value !== title && value !== provider);
  const images = content.filter(
    (item) =>
      item.role === 'AXImage' &&
      !has(item, 'c-message_attachment__footer_icon') &&
      !has(item, 'c-emoji')
  );
  const video = content.some(
    (item) =>
      has(item, 'c-message_attachment__video_container') ||
      has(item, 'c-message_attachment__video_play')
  );
  const image = content.some(
    (item) =>
      has(item, 'c-message_attachment__image_container') || has(item, 'c-message_attachment__image')
  );
  const ref = messageRef ? `${messageRef}/p${ordinal}` : null;
  return {
    kind: video ? 'video' : image || images.length ? 'image' : 'link',
    title,
    description: unique(descriptions).join('\n') || null,
    provider,
    url:
      node.role === 'AXLink'
        ? safeURL(node.url)
        : titles.length === 1
          ? safeURL(titles[0].url)
          : null,
    thumbnailUrl: sole(images.map((item) => safeURL(item.url))),
    contentRead: false,
    ref,
    referenceScope: ref ? 'message-preview' : null,
    provenance: quoteProvenance(node, tree, container),
  };
}

export function extractMedia(container, tree, { messageRef = null } = {}) {
  messageRef =
    typeof messageRef === 'string' && /^[CDG][A-Z0-9]+:\d{10}\.\d{6}$/.test(messageRef)
      ? messageRef
      : null;
  const nodes = ownedNodes(container, tree);
  const allowed = new Set(nodes.map((node) => node.index));
  const excludedNodes = new Set();
  const previewRoots = nodes.filter(
    (node) =>
      isPreview(node) &&
      !tree.ancestor(node, (parent) => allowed.has(parent.index) && isPreview(parent))
  );
  const roots = nodes.filter((node) => {
    if (
      !isMediaRoot(node) ||
      tree.ancestor(
        node,
        (parent) => allowed.has(parent.index) && (isMediaRoot(parent) || isPreview(parent))
      )
    )
      return false;
    const content = scopedDescendants(node, tree);
    if (has(node, 'p-video_message_file'))
      return content.some(
        (item) => item.role === 'AXCheckBox' && /^(?:Play|Pause)(?:,|$)/.test(label(item) ?? '')
      );
    if (has(node, 'p-search_file--audio-player') || isNativeAudio(node))
      return content.some(
        (item) => item.role === 'AXCheckBox' && has(item, 'c-audio_player_play_button')
      );
    return Boolean(
      label(node) || content.some((item) => ['AXImage', 'AXLink'].includes(item.role))
    );
  });
  const headers = nodes.filter(
    (node) =>
      isHeader(node) &&
      !tree.ancestor(node, (parent) => isHeader(parent) || isMediaRoot(parent) || isPreview(parent))
  );
  const headerFor = new Map();
  for (const header of headers) {
    excludedNodes.add(header.index);
    if (tree.descendants(header).some((item) => roots.includes(item))) continue;
    const content = scopedDescendants(header, tree);
    const siblings = nodes.filter((item) => item.parent === header.parent);
    const following = siblings.slice(siblings.indexOf(header) + 1);
    const nextHeader = following.findIndex(isHeader);
    const group = nextHeader === -1 ? following : following.slice(0, nextHeader);
    const paired = roots.filter((root) =>
      group.some((item) => item.index === root.index || tree.descendants(item).includes(root))
    );
    if (paired.length)
      for (const root of paired) headerFor.set(root.index, { node: header, content });
    else if (
      label(header) ||
      content.some(
        (item) =>
          (item.role === 'AXStaticText' && label(item)) ||
          (item.role === 'AXLink' && safeURL(item.url))
      )
    )
      roots.push(header);
  }
  // Preserve actual tree order, not discovery passes (headers may precede roots).
  roots.sort((a, b) => nodes.indexOf(a) - nodes.indexOf(b));
  const attachments = [],
    bindings = [],
    seen = new Set();
  for (const root of roots) {
    excludedNodes.add(root.index);
    const record = mediaRecord(
      root,
      tree,
      { messageRef, ordinal: attachments.length + 1 },
      headerFor.get(root.index),
      container
    );
    // Shared labels, thumbnails and ordinary external URLs are not file identities.
    const key = record.fileId ? JSON.stringify([record.fileId, record.provenance]) : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    attachments.push(record);
    bindings.push({ rootIndex: root.index, media: record });
  }
  for (const node of nodes) {
    if (isMediaRoot(node) || /^caption-description-F[A-Z0-9]+$/.test(node.id ?? ''))
      excludedNodes.add(node.index);
  }
  const previews = previewRoots.map((node, index) => {
    excludedNodes.add(node.index);
    return previewRecord(node, tree, messageRef, index + 1, container);
  });
  return { attachments, previews, excludedNodes, bindings };
}
