import { describe, expect, test } from 'bun:test';
import { extractMedia, isMediaRoot, quotedMessageSource } from './slack-media.mjs';

// Structural fixtures only; no private Slack captures or content.
function fixture() {
  const nodes = [];
  const add = (parent, role = 'AXGroup', classes = [], label = '', extra = {}) => {
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
  const root = add(null, 'AXWebArea');
  const container = add(root, 'AXGroup', ['c-message_kit__actions']);
  const children = (node) => nodes.filter((item) => item.parent === node.index);
  const descendants = (node) => children(node).flatMap((item) => [item, ...descendants(item)]);
  const ancestor = (node, predicate) => {
    for (let parent = nodes[node.parent]; parent; parent = nodes[parent.parent])
      if (predicate(parent)) return parent;
    return null;
  };
  const tree = { nodes, children, descendants, ancestor };
  const extract = (context = { messageRef: 'CDEMO:1700000000.000001' }) =>
    extractMedia(container, tree, context);
  const video = (parent = container, name = 'walkthrough.mp4', control = 'View transcript') => {
    const media = add(parent, 'AXGroup', ['p-video_message_file']);
    const overlay = add(media, 'AXGroup', ['p-video_controls_overlay'], name);
    add(overlay, 'AXCheckBox', [], 'Play, 4 minutes, 36 seconds');
    const duration = add(overlay, 'AXGroup', ['p-video_controls_overlay__time']);
    add(duration, 'AXStaticText', [], '4:36');
    if (control) add(overlay, 'AXButton', [], control);
    return media;
  };
  const image = (parent = container, id = 'FIMAGE1') => {
    const media = add(parent, 'AXGroup', ['p-message_gallery_image_file']);
    const link = add(media, 'AXLink', ['p-file_image_thumbnail__wrapper'], 'diagram.png', {
      url: `https://files.slack.com/files-pri/TDEMO-${id}/diagram.png`,
    });
    add(link, 'AXImage', ['p-file_image_thumbnail__image'], 'A labelled process diagram', {
      url: `https://files.slack.com/files-tmb/TDEMO-${id}-abc/diagram_1024.png`,
    });
    return media;
  };
  return { nodes, root, container, add, tree, extract, video, image };
}

describe('rich-media metadata', () => {
  test('keeps native media bindings private and offers only existing transcript actions', () => {
    const f = fixture();
    const video = f.video();
    const result = f.extract();
    expect(result.bindings).toEqual([{ rootIndex: video.index, media: result.attachments[0] }]);
    expect(result.attachments[0]).not.toHaveProperty('rootIndex');
    expect(result.attachments[0].transcript.navigation).toEqual({
      command: 'read-transcript',
      args: ['CDEMO:1700000000.000001/m1'],
    });
    const generation = fixture();
    generation.video(undefined, 'later.mp4', 'Generate transcript');
    expect(generation.extract().attachments[0].transcript).toEqual({ state: 'generatable' });
    const unbound = fixture();
    unbound.video();
    expect(unbound.extract({ messageRef: null }).attachments[0].transcript).toEqual({
      state: 'available',
    });
  });
  test('pairs a sibling image header once, preserving description and separate thumbnail', () => {
    const f = fixture();
    const header = f.add(f.container, 'AXGroup', ['c-message_kit__file']);
    f.add(header, 'AXStaticText', [], 'Architecture diagram');
    f.add(header, 'AXButton', [], 'Toggle attachment');
    const media = f.image();
    const result = f.extract();
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      label: 'diagram.png',
      filename: 'diagram.png',
      kind: 'image',
      fileId: 'FIMAGE1',
      ref: 'FIMAGE1',
      referenceScope: 'workspace-file',
      contentRead: false,
      description: 'A labelled process diagram',
      descriptionSource: 'accessibility',
      url: 'https://files.slack.com/files-pri/TDEMO-FIMAGE1/diagram.png',
      thumbnailUrl: 'https://files.slack.com/files-tmb/TDEMO-FIMAGE1-abc/diagram_1024.png',
      downloadUrl: null,
    });
    expect(result.excludedNodes.has(header.index)).toBe(true);
    expect(result.excludedNodes.has(media.index)).toBe(true);
  });

  test('retains a PDF file page and download target as distinct observations', () => {
    const f = fixture();
    const header = f.add(f.container, 'AXGroup', ['c-message_kit__file']);
    f.add(header, 'AXStaticText', [], 'PDF');
    const media = f.add(
      f.container,
      'AXGroup',
      ['c-pillow_file_container', 'p-message_file'],
      'brief.pdf'
    );
    const page = f.add(media, 'AXLink', ['p-file_link_button--link'], 'brief.pdf PDF', {
      url: 'https://demo.enterprise.slack.com/files/UDEMO/FREPORT/brief.pdf?origin_team=TDEMO',
    });
    f.add(page, 'AXStaticText', [], 'brief.pdf');
    f.add(page, 'AXStaticText', [], 'PDF');
    f.add(media, 'AXLink', [], 'Download brief.pdf', {
      url: 'https://files.slack.com/files-pri/TDEMO-FREPORT/download/brief.pdf',
    });
    expect(f.extract().attachments).toHaveLength(1);
    expect(f.extract().attachments[0]).toMatchObject({
      kind: 'document',
      filename: 'brief.pdf',
      fileId: 'FREPORT',
      filePageUrl: page.url,
      url: page.url,
      downloadUrl: 'https://files.slack.com/files-pri/TDEMO-FREPORT/download/brief.pdf',
      contentRead: false,
    });
  });

  test('video labels and durations do not require a URL or assumed file ID', () => {
    const f = fixture();
    f.video();
    const media = f.extract().attachments[0];
    expect(media).toMatchObject({
      kind: 'video',
      label: 'walkthrough.mp4',
      filename: 'walkthrough.mp4',
      displayedDuration: '4:36',
      fileId: null,
      url: null,
      ref: 'CDEMO:1700000000.000001/m1',
      referenceScope: 'message-media',
      transcript: { state: 'available' },
    });
    expect(media.navigation).toEqual({ command: 'read-media', args: [media.ref] });
    expect(media).not.toHaveProperty('mimeType');
  });

  test('keeps generation-only and unavailable transcript controls distinct', () => {
    const f = fixture();
    f.video(f.container, 'one', 'Generate transcript');
    f.video(f.container, 'two', null);
    const conflicting = f.video(f.container, 'three');
    f.add(conflicting, 'AXButton', [], 'Generate transcript');
    expect(f.extract().attachments.map((media) => media.transcript.state)).toEqual([
      'generatable',
      'unknown',
      'unknown',
    ]);
    expect(f.extract().attachments.map((media) => media.filename)).toEqual([null, null, null]);
  });

  test('audio structure overrides a transcoded URL suffix without inventing original-file semantics', () => {
    const f = fixture();
    const media = f.add(
      f.container,
      'AXGroup',
      ['c-pillow_file_container', 'p-search_file--audio-player'],
      'memo.\uE000m4a\uE001'
    );
    f.add(media, 'AXCheckBox', ['c-audio_player_play_button'], 'Play');
    f.add(media, 'AXButton', [], 'Generate transcript for this audio');
    const time = f.add(media, 'AXGroup', ['c-audio_player__time']);
    f.add(time, 'AXStaticText', [], '0:00');
    const download = f.add(media, 'AXLink', [], 'Download memo.\uE000m4a\uE001', {
      url: 'https://files.slack.com/files-tmb/TDEMO-FAUDIO-abc/download/memo_audio.mp4?x=1',
    });
    expect(f.extract().attachments[0]).toMatchObject({
      kind: 'audio',
      label: 'memo.m4a',
      filename: 'memo.m4a',
      downloadUrl: download.url,
      fileId: 'FAUDIO',
      ref: 'FAUDIO',
      displayedDuration: null,
      displayedPlaybackTime: '0:00',
      transcript: { state: 'generatable' },
      contentRead: false,
    });
    expect(f.extract().attachments[0]).not.toHaveProperty('originalUrl');
  });

  test('unknown audio time and size remain unknown when no time node is exposed', () => {
    const f = fixture();
    const media = f.add(f.container, 'AXGroup', ['p-search_file--audio-player'], 'memo.m4a');
    f.add(media, 'AXCheckBox', ['c-audio_player_play_button'], 'Play');
    expect(f.extract().attachments[0]).toMatchObject({
      displayedDuration: null,
      displayedPlaybackTime: null,
    });
    expect(f.extract().attachments[0]).not.toHaveProperty('size');
  });

  test('caption-description IDs are evidence, not caption text or an invented file URL', () => {
    const f = fixture();
    const media = f.video();
    const hint = f.add(media, 'AXGroup', ['sr-only'], '', { id: 'caption-description-FVIDEO' });
    f.add(hint, 'AXStaticText', [], 'Captions are now available for this video.');
    const result = f.extract();
    expect(result.attachments[0]).toMatchObject({ fileId: 'FVIDEO', ref: 'FVIDEO', url: null });
    expect(result.excludedNodes.has(hint.index)).toBe(true);
  });

  test('conflicting file identities withhold file references', () => {
    const f = fixture();
    const media = f.image();
    f.add(media, 'AXLink', [], 'Download diagram.png', {
      url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/download/diagram.png',
    });
    expect(f.extract().attachments[0]).toMatchObject({
      fileId: null,
      ref: 'CDEMO:1700000000.000001/m1',
      referenceScope: 'message-media',
    });
  });

  test('host and path lookalikes cannot supply Slack file identities', () => {
    const f = fixture();
    for (const url of [
      'https://files.slack.com.evil.test/files-pri/TDEMO-FSECRET/a.png',
      'https://example.test/files/UDEMO/FSECRET/a.png',
      'http://files.slack.com/files-pri/TDEMO-FSECRET/a.png',
      'https://files.slack.com/other/TDEMO-FSECRET/a.png',
    ]) {
      const media = f.add(f.container, 'AXGroup', ['p-message_gallery_image_file']);
      f.add(media, 'AXLink', [], 'a.png', { url });
    }
    expect(f.extract().attachments.map((media) => media.fileId)).toEqual([null, null, null, null]);
  });

  test('unsafe URLs are never emitted and missing message bindings produce no fallback ref', () => {
    const f = fixture();
    const media = f.add(f.container, 'AXGroup', ['p-message_gallery_image_file'], 'image');
    f.add(media, 'AXLink', [], 'a.png', { url: 'javascript:alert(1)' });
    f.add(media, 'AXImage', ['p-file_image_thumbnail__image'], 'A diagram', {
      url: 'https://name:secret@example.test/a.png',
    });
    const result = f.extract({ messageRef: 'not a verified message' }).attachments[0];
    expect(result).toMatchObject({
      url: null,
      thumbnailUrl: null,
      ref: null,
      referenceScope: null,
    });
  });

  test('only shared observed IDs deduplicate physical attachments; same labels remain distinct', () => {
    const f = fixture();
    f.image();
    f.image();
    f.image(f.container, 'FIMAGE2');
    f.video(f.container, 'same label');
    f.video(f.container, 'same label');
    expect(f.extract().attachments.map((media) => media.ref)).toEqual([
      'FIMAGE1',
      'FIMAGE2',
      'CDEMO:1700000000.000001/m3',
      'CDEMO:1700000000.000001/m4',
    ]);
  });

  test('rejects out-of-message, composer, nested-message and nested-player false positives', () => {
    const f = fixture();
    const real = f.video();
    f.video(real, 'nested duplicate');
    f.video(f.root, 'outside message');
    const composer = f.add(f.container, 'AXTextArea');
    f.video(composer, 'draft');
    const nestedMessage = f.add(f.container, 'AXGroup', ['c-message_kit__actions']);
    f.video(nestedMessage, 'unrelated nested message');
    expect(f.nodes.filter(isMediaRoot)).toHaveLength(5);
    expect(f.extract().attachments).toHaveLength(1);
    expect(f.extract().attachments[0].label).toBe('walkthrough.mp4');
  });

  test('preserves standalone legacy attachments without duplicating nested actual file roots', () => {
    const f = fixture();
    const standalone = f.add(f.container, 'AXGroup', ['c-message_kit__file']);
    f.add(standalone, 'AXStaticText', [], 'Collapsed file');
    const wrapper = f.add(f.container, 'AXGroup', ['c-message_kit__file']);
    f.image(wrapper);
    expect(f.extract().attachments.map((media) => media.label)).toEqual([
      'Collapsed file',
      'diagram.png',
    ]);
  });

  test('quoted attribution remains attached to its file and does not exclude the whole card', () => {
    const f = fixture();
    const quote = f.add(f.container, 'AXGroup', ['c-message_attachment']);
    f.add(quote, 'AXButton', ['c-message_attachment__author_name'], 'Alex Example');
    f.add(quote, 'AXLink', ['c-timestamp'], 'Original message', {
      url: 'https://demo.slack.com/archives/COTHER/p1700000000000002',
    });
    f.image(quote);
    const result = f.extract();
    expect(result.attachments[0].provenance).toEqual({
      kind: 'quoted',
      author: 'Alex Example',
      permalink: 'https://demo.slack.com/archives/COTHER/p1700000000000002',
    });
    expect(result.excludedNodes.has(quote.index)).toBe(false);
  });

  test('external unfurls remain preview records rather than Slack attachments', () => {
    const f = fixture();
    const preview = f.add(f.container, 'AXGroup', ['c-message_attachment_v3']);
    const title = f.add(preview, 'AXLink', ['c-message_attachment__title_link'], 'A demo', {
      url: 'https://video.example.test/watch?v=demo',
    });
    f.add(title, 'AXStaticText', [], 'A demo');
    f.add(preview, 'AXStaticText', [], 'A short explanation');
    f.add(preview, 'AXImage', ['c-message_attachment__footer_icon'], 'Video Site', {
      url: 'https://video.example.test/icon.png',
    });
    f.add(preview, 'AXStaticText', [], 'Video Site');
    f.add(preview, 'AXGroup', ['c-message_attachment__video_container']);
    const result = f.extract();
    expect(result.attachments).toHaveLength(0);
    expect(result.previews).toEqual([
      {
        kind: 'video',
        title: 'A demo',
        description: 'A short explanation',
        provider: 'Video Site',
        url: title.url,
        thumbnailUrl: null,
        contentRead: false,
        ref: 'CDEMO:1700000000.000001/p1',
        referenceScope: 'message-preview',
        provenance: null,
      },
    ]);
    expect(result.excludedNodes.has(preview.index)).toBe(true);
  });

  test('quoted body citations do not masquerade as the quoted source permalink', () => {
    const f = fixture();
    const quote = f.add(f.container, 'AXGroup', ['c-message_attachment']);
    f.add(quote, 'AXButton', ['c-message_attachment__author_name'], 'Alex Example');
    f.add(quote, 'AXLink', [], 'A cited message', {
      url: 'https://demo.slack.com/archives/COTHER/p1700000000000002',
    });
    f.image(quote);
    expect(f.extract().attachments[0].provenance).toEqual({
      kind: 'quoted',
      author: 'Alex Example',
      permalink: null,
    });
  });

  test('shared quoted-source extraction keeps nested cards and their sources separate', () => {
    const f = fixture();
    const outer = f.add(f.container, 'AXGroup', ['c-message_attachment']);
    f.add(outer, 'AXButton', ['c-message_attachment__author_name'], 'Alex Example');
    const inner = f.add(outer, 'AXGroup', ['c-message_attachment']);
    f.add(inner, 'AXButton', ['c-message_attachment__author_name'], 'Sam Example');
    f.add(inner, 'AXLink', ['c-timestamp'], 'Original message', {
      url: 'https://demo.slack.com/archives/COTHER/p1700000000000002',
    });
    expect(quotedMessageSource(outer, f.tree)).toEqual({
      kind: 'quoted',
      author: 'Alex Example',
      permalink: null,
    });
    expect(quotedMessageSource(inner, f.tree)).toEqual({
      kind: 'quoted',
      author: 'Sam Example',
      permalink: 'https://demo.slack.com/archives/COTHER/p1700000000000002',
    });
    expect(quotedMessageSource(f.container, f.tree)).toBeNull();
  });

  test('previews inside quoted cards retain attribution without inventing a source permalink', () => {
    const f = fixture();
    const quote = f.add(f.container, 'AXGroup', ['c-message_attachment']);
    f.add(quote, 'AXButton', ['c-message_attachment__author_name'], 'Alex Example');
    const preview = f.add(quote, 'AXLink', ['c-message_attachment_v3'], '', {
      url: 'https://example.test/article',
    });
    f.add(preview, 'AXStaticText', [], 'An article');
    f.add(preview, 'AXLink', ['c-timestamp'], 'Referenced message', {
      url: 'https://demo.slack.com/archives/COTHER/p1700000000000002',
    });
    expect(f.extract().previews[0].provenance).toEqual({
      kind: 'quoted',
      author: 'Alex Example',
      permalink: null,
    });
  });

  test('file-like metadata inside an external preview is not a Slack attachment', () => {
    const f = fixture();
    const preview = f.add(f.container, 'AXGroup', ['c-message_attachment_v3']);
    f.add(preview, 'AXLink', ['c-message_attachment__title_link'], 'Document preview', {
      url: 'https://example.test/document',
    });
    const header = f.add(preview, 'AXGroup', ['c-message_kit__file']);
    f.add(header, 'AXStaticText', [], 'External file label');
    f.add(header, 'AXLink', [], 'File', { url: 'https://example.test/file.pdf' });
    expect(f.extract().attachments).toEqual([]);
    expect(f.extract().previews).toHaveLength(1);
  });

  test('generic search file cards preserve preview thumbnails without inferring file type', () => {
    const f = fixture();
    f.video();
    const list = f.add(f.container, 'AXGroup', ['c-search_message__files']);
    for (const id of ['FFIRST', 'FSECOND']) {
      const media = f.add(
        list,
        'AXGroup',
        ['c-pillow_file_container', 'p-search_file--file-entity'],
        'example.png'
      );
      const page = f.add(
        media,
        'AXLink',
        ['p-file_link_button--link'],
        'example.png Shared by Alex Example',
        { url: `https://demo.slack.com/files/UDEMO/${id}/example.png` }
      );
      const thumb = f.add(page, 'AXGroup', ['p-file_thumbnail__container--image']);
      f.add(thumb, 'AXImage', ['p-file_thumbnail__image'], 'example.png', {
        url: `https://files.slack.com/files-tmb/TDEMO-${id}-abc/example_1024.png`,
      });
      f.add(media, 'AXLink', [], 'Download example.png', {
        url: `https://files.slack.com/files-pri/TDEMO-${id}/download/example.png`,
      });
    }
    const attachments = f.extract().attachments;
    expect(attachments).toHaveLength(3);
    expect(attachments.map((item) => item.kind)).toEqual(['video', 'file', 'file']);
    expect(attachments.slice(1).map((item) => item.fileId)).toEqual(['FFIRST', 'FSECOND']);
    expect(attachments[1]).toMatchObject({
      description: null,
      thumbnailUrl: 'https://files.slack.com/files-tmb/TDEMO-FFIRST-abc/example_1024.png',
    });
  });

  test('elapsed playback labels cannot replace the explicit total video duration', () => {
    const f = fixture();
    f.video();
    f.nodes.find((node) => node.role === 'AXStaticText' && node.label === '4:36').label = '0:12';
    expect(f.extract().attachments[0].displayedDuration).toBe('4 minutes, 36 seconds');
  });

  test('nested message or composer metadata never reenters file or preview content', () => {
    const f = fixture();
    const image = f.image();
    const nestedMessage = f.add(image, 'AXGroup', ['c-message_kit__actions']);
    f.add(nestedMessage, 'AXLink', [], 'Download wrong.png', {
      url: 'https://files.slack.com/files-pri/TDEMO-FWRONG/wrong.png',
    });
    const preview = f.add(f.container, 'AXLink', ['c-message_attachment_v3'], '', {
      url: 'https://example.test/article',
    });
    f.add(preview, 'AXStaticText', [], 'Article');
    const composer = f.add(preview, 'AXTextArea');
    f.add(composer, 'AXStaticText', [], 'Private draft');
    const nestedPreviewMessage = f.add(preview, 'AXGroup', ['c-message_kit__actions']);
    f.add(nestedPreviewMessage, 'AXStaticText', [], 'Other message');
    const result = f.extract();
    expect(result.attachments[0]).toMatchObject({ fileId: 'FIMAGE1', downloadUrl: null });
    expect(result.previews[0]).toMatchObject({ title: 'Article', description: null });
  });

  test('fallback refs require canonical timestamp widths', () => {
    const f = fixture();
    f.video();
    expect(f.extract({ messageRef: 'CDEMO:100.000001' }).attachments[0].ref).toBeNull();
  });

  test('linked preview cards retain their source URL without using aggregate container text', () => {
    const f = fixture();
    const preview = f.add(
      f.container,
      'AXLink',
      ['c-message_attachment_v3'],
      'Duplicate aggregate title description',
      { url: 'https://example.test/article' }
    );
    f.add(preview, 'AXStaticText', [], 'An article');
    f.add(preview, 'AXStaticText', [], 'Article description');
    const picture = f.add(preview, 'AXGroup', ['c-message_attachment__image_container']);
    f.add(picture, 'AXImage', [], 'An article', { url: 'https://example.test/preview.jpg' });
    expect(f.extract().previews[0]).toMatchObject({
      kind: 'image',
      title: 'An article',
      description: 'Article description',
      url: 'https://example.test/article',
      thumbnailUrl: 'https://example.test/preview.jpg',
    });
  });
});

describe('file-details source metadata', () => {
  function audio(nativeMessage = false) {
    const f = fixture();
    const root = f.add(
      f.container,
      'AXGroup',
      nativeMessage
        ? ['c-pillow_file_container', 'p-message_file', 'p-message_file--audio_message']
        : ['c-pillow_file_container', 'p-search_file--audio-player'],
      'memo.m4a'
    );
    const play = f.add(root, 'AXCheckBox', ['c-audio_player_play_button'], 'Play', {
      stateValue: '0',
    });
    const description = f.add(root, 'AXGroup', ['sr-only'], '', {
      id: 'transcript-description-FAUDIO',
    });
    f.add(description, 'AXStaticText', [], 'Transcript available');
    return { ...f, media: root, play, description };
  }
  function details(f, media) {
    const actions = f.add(media, 'AXGroup', ['c-file__actions']);
    const button = f.add(actions, 'AXButton', ['c-message_actions__button'], 'View file details');
    return { actions, button };
  }
  function videoMenu() {
    const f = fixture();
    const media = f.video();
    media.classes.push('p-video_message_file--gallery_v3');
    const overlay = f.tree.children(media)[0];
    const corner = f.add(overlay, 'AXGroup', [
      'p-video_controls_overlay__corner',
      'p-video_controls_overlay__corner--gallery_v3',
    ]);
    const menu = f.add(
      corner,
      'AXPopUpButton',
      [
        'p-video_message_file--gallery_v3__controls_overlay_ellipsis',
        'p-video_controls_overlay__corner_button',
      ],
      'More actions'
    );
    f.add(media, 'AXGroup', ['sr-only'], '', { id: 'caption-description-FVIDEO' });
    return { ...f, media, overlay, corner, menu };
  }

  test('video details capability identifies the supported source menu without opening it', () => {
    const f = videoMenu();
    expect(f.extract().attachments[0]).toMatchObject({
      kind: 'video',
      fileId: 'FVIDEO',
      fileDetailsAvailable: true,
      filePageUrl: null,
      downloadUrl: null,
      contentRead: false,
    });
    const url = 'https://files.slack.com/files-pri/TDEMO-FVIDEO/download/demo.mp4';
    f.add(f.media, 'AXLink', [], 'Download', { url });
    // Capability metadata never removes a source Download that takes precedence at runtime.
    expect(f.extract().attachments[0]).toMatchObject({
      fileDetailsAvailable: true,
      downloadUrl: url,
    });
  });

  for (const [name, change] of [
    ['generic file root', (f) => (f.media.classes = ['p-message_file'])],
    ['missing gallery class', (f) => (f.media.classes = ['p-video_message_file'])],
    ['wrong role', (f) => (f.menu.role = 'AXButton')],
    ['wrong label', (f) => (f.menu.label = 'More actions now')],
    ['highlighted label', (f) => (f.menu.label = '\uE000More actions\uE001')],
    ['missing ellipsis class', (f) => f.menu.classes.shift()],
    ['missing corner-button class', (f) => f.menu.classes.pop()],
    ['disabled class', (f) => f.menu.classes.push('c-button--disabled')],
    ['disabled state', (f) => (f.menu.enabled = false)],
    ['URL-bearing popup', (f) => (f.menu.url = 'https://example.test/video')],
    ['wrong corner role', (f) => (f.corner.role = 'AXToolbar')],
    ['missing corner class', (f) => f.corner.classes.shift()],
    ['missing gallery corner class', (f) => f.corner.classes.pop()],
    ['missing overlay class', (f) => (f.overlay.classes = [])],
    ['wrong overlay role', (f) => (f.overlay.role = 'AXToolbar')],
    ['competing details button', (f) => details(f, f.media)],
    ['duplicate menu', (f) => f.add(f.corner, f.menu.role, f.menu.classes, f.menu.label)],
    ['unrelated message controls', (f) => (f.corner.parent = f.container.index)],
    ['foreign video controls', (f) => (f.corner.parent = f.tree.children(f.video())[0].index)],
    ...[
      ['nested media', 'AXGroup', 'p-message_file'],
      ['nested message', 'AXGroup', 'c-message_kit__actions'],
      ['nested composer', 'AXTextArea', 'p-message_input'],
      ['nested preview', 'AXGroup', 'c-message_attachment_v3'],
    ].map(([name, role, className]) => [
      name,
      (f) => (f.corner.parent = f.add(f.overlay, role, [className]).index),
    ]),
  ]) {
    test(`does not offer video details for ${name}`, () => {
      const f = videoMenu();
      change(f);
      expect(f.extract().attachments[0]).not.toHaveProperty('fileDetailsAvailable');
    });
  }

  test('audio transcript identity remains available without a Download or file-page URL', () => {
    const f = audio();
    details(f, f.media);
    const record = f.extract().attachments[0];
    expect(record).toMatchObject({
      kind: 'audio',
      fileId: 'FAUDIO',
      ref: 'FAUDIO',
      filePageUrl: null,
      downloadUrl: null,
      url: null,
      fileDetailsAvailable: true,
      contentRead: false,
    });
    // Reading metadata preserves identity even while the native input guard would stop playback.
    f.play.label = 'Pause';
    f.play.stateValue = '1';
    expect(f.extract().attachments[0].fileId).toBe('FAUDIO');
  });

  test('native message audio retains its owned canonical transcript identity without a file URL', () => {
    const f = audio(true);
    const record = f.extract().attachments[0];
    expect(record).toMatchObject({
      kind: 'audio',
      fileId: 'FAUDIO',
      ref: 'FAUDIO',
      referenceScope: 'workspace-file',
      filePageUrl: null,
      downloadUrl: null,
      url: null,
      contentRead: false,
    });
    expect(record).not.toHaveProperty('fileDetailsAvailable');
    f.add(f.media, 'AXLink', [], 'memo.m4a', {
      url: 'https://example.slack.com/files/UDEMO/FAUDIO/memo.m4a',
    });
    expect(f.extract().attachments[0]).toMatchObject({ kind: 'audio', fileId: 'FAUDIO' });
    f.play.label = 'Pause';
    f.play.stateValue = '1';
    expect(f.extract().attachments[0]).toMatchObject({ kind: 'audio', fileId: 'FAUDIO' });
  });
  test('native audio preserves transcript availability without advertising an unsupported opener', () => {
    const f = audio(true);
    f.add(f.media, 'AXButton', [], 'View transcript');
    expect(f.extract().attachments[0].transcript).toEqual({ state: 'available', navigation: null });
    f.media.classes = ['c-pillow_file_container', 'p-search_file--audio-player'];
    expect(f.extract().attachments[0].transcript).toEqual({
      state: 'available',
      navigation: { command: 'read-transcript', args: ['FAUDIO'] },
    });
  });

  test.each([
    [
      'missing pillow',
      (f) => {
        f.media.classes = f.media.classes.filter((name) => name !== 'c-pillow_file_container');
      },
    ],
    [
      'missing message-file',
      (f) => {
        f.media.classes = f.media.classes.filter((name) => name !== 'p-message_file');
      },
    ],
    [
      'missing audio-message',
      (f) => {
        f.media.classes = f.media.classes.filter(
          (name) => name !== 'p-message_file--audio_message'
        );
      },
    ],
    [
      'wrong root role',
      (f) => {
        f.media.role = 'AXButton';
      },
    ],
    [
      'wrong transcript role',
      (f) => {
        f.description.role = 'AXStaticText';
      },
    ],
    [
      'missing sr-only',
      (f) => {
        f.description.classes = [];
      },
    ],
    [
      'noncanonical transcript ID',
      (f) => {
        f.description.id += '\n';
      },
    ],
    [
      'foreign nested transcript',
      (f) => {
        const nested = f.add(f.media, 'AXGroup', ['c-pillow_file_container']);
        f.description.parent = nested.index;
      },
    ],
    [
      'composer transcript',
      (f) => {
        const nested = f.add(f.media, 'AXTextArea', ['p-message_input']);
        f.description.parent = nested.index;
      },
    ],
    [
      'other-message transcript',
      (f) => {
        const nested = f.add(f.media, 'AXGroup', ['c-message_kit__actions']);
        f.description.parent = nested.index;
      },
    ],
  ])('native audio cannot obtain canonical identity from %s', (_name, mutate) => {
    const f = audio(true);
    mutate(f);
    expect(f.extract().attachments.every((record) => record.fileId !== 'FAUDIO')).toBe(true);
  });
  test.each([
    [
      'noncheckbox Play',
      (f) => {
        f.play.role = 'AXButton';
      },
    ],
    [
      'missing Play class',
      (f) => {
        f.play.classes = [];
      },
    ],
    [
      'nested media Play',
      (f) => {
        const nested = f.add(f.media, 'AXGroup', ['c-pillow_file_container']);
        f.play.parent = nested.index;
      },
    ],
    [
      'composer Play',
      (f) => {
        const nested = f.add(f.media, 'AXTextArea', ['p-message_input']);
        f.play.parent = nested.index;
      },
    ],
  ])('native audio requires an owned audio checkbox despite a filename: %s', (_name, mutate) => {
    const f = audio(true);
    mutate(f);
    expect(f.extract().attachments).toEqual([]);
  });
  test.each(['url', 'caption', 'transcript'])(
    'native audio rejects conflicting %s identity',
    (evidence) => {
      const f = audio(true);
      if (evidence === 'url')
        f.add(f.media, 'AXLink', [], 'Download other.m4a', {
          url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/download/other.m4a',
        });
      else
        f.add(f.media, 'AXGroup', ['sr-only'], '', {
          id: `${evidence === 'caption' ? 'caption' : 'transcript'}-description-FOTHER`,
        });
      expect(f.extract().attachments[0]).toMatchObject({
        kind: 'audio',
        fileId: null,
        referenceScope: 'message-media',
      });
    }
  );

  for (const [name, change] of [
    ['missing file-card root', (f) => (f.media.classes = ['p-search_file--audio-player'])],
    ['missing audio root', (f) => (f.media.classes = ['c-pillow_file_container'])],
    ['wrong root role', (f) => (f.media.role = 'AXButton')],
    ['wrong description role', (f) => (f.description.role = 'AXStaticText')],
    ['missing sr-only marker', (f) => (f.description.classes = [])],
    ['lowercase file ID', (f) => (f.description.id = 'transcript-description-Faudio')],
    ['empty file ID', (f) => (f.description.id = 'transcript-description-F')],
    ['trailing newline', (f) => (f.description.id += '\n')],
    ['extra suffix', (f) => (f.description.id += '-extra')],
    [
      'nested description in another attachment',
      (f) => {
        const nested = f.add(f.media, 'AXGroup', ['c-pillow_file_container'], 'nested');
        f.description.parent = nested.index;
      },
    ],
    [
      'nested description in another message',
      (f) => {
        const nested = f.add(f.media, 'AXGroup', ['c-message_kit__actions']);
        f.description.parent = nested.index;
      },
    ],
    [
      'nested description in composer',
      (f) => {
        const nested = f.add(f.media, 'AXTextArea', ['p-message_input']);
        f.description.parent = nested.index;
      },
    ],
  ]) {
    test(`does not obtain audio file identity from ${name}`, () => {
      const f = audio();
      change(f);
      expect(f.extract().attachments[0].fileId).toBeNull();
    });
  }

  test('a description without a genuine audio Play checkbox cannot identify a file', () => {
    const f = audio();
    f.play.role = 'AXButton';
    // Without a recognized audio player this root does not become an attachment.
    expect(f.extract().attachments).toEqual([]);
  });

  for (const evidence of ['url', 'caption', 'transcript']) {
    test(`conflicting ${evidence} identity withholds the audio file reference`, () => {
      const f = audio();
      if (evidence === 'url')
        f.add(f.media, 'AXLink', [], 'Download other.m4a', {
          url: 'https://files.slack.com/files-pri/TDEMO-FOTHER/download/other.m4a',
        });
      else
        f.add(f.media, 'AXGroup', ['sr-only'], '', {
          id: `${evidence === 'caption' ? 'caption' : 'transcript'}-description-FOTHER`,
        });
      expect(f.extract().attachments[0]).toMatchObject({
        fileId: null,
        ref: 'CDEMO:1700000000.000001/m1',
      });
    });
  }

  test('details capability is scoped to document, generic-file and video source controls', () => {
    const f = fixture();
    const document = f.add(f.container, 'AXGroup', ['c-pillow_file_container'], 'brief.pdf');
    f.add(document, 'AXStaticText', [], 'PDF');
    const generic = f.add(f.container, 'AXGroup', ['p-message_file'], 'archive.bin');
    const video = f.video();
    for (const root of [document, generic, video]) details(f, root);
    expect(
      f.extract().attachments.map((record) => [record.kind, record.fileDetailsAvailable])
    ).toEqual([
      ['document', true],
      ['file', true],
      ['video', true],
    ]);
  });

  for (const [name, change] of [
    ['wrong role', (_f, action) => (action.button.role = 'AXLink')],
    ['wrong label', (_f, action) => (action.button.label = 'View file details now')],
    ['highlighted label', (_f, action) => (action.button.label = '\uE000View file details\uE001')],
    ['missing button class', (_f, action) => (action.button.classes = [])],
    ['disabled class', (_f, action) => action.button.classes.push('c-button--disabled')],
    ['disabled state', (_f, action) => (action.button.enabled = false)],
    ['a URL on the action', (_f, action) => (action.button.url = 'https://example.test/file')],
    ['wrong action group role', (_f, action) => (action.actions.role = 'AXToolbar')],
    ['missing action group', (_f, action) => (action.actions.classes = [])],
    [
      'duplicate details buttons',
      (f, action) =>
        f.add(action.actions, 'AXButton', ['c-message_actions__button'], 'View file details'),
    ],
    [
      'nested media controls',
      (f, action) => {
        const nested = f.add(f.media, 'AXGroup', ['p-message_file'], 'nested.bin');
        action.actions.parent = nested.index;
      },
    ],
    [
      'nested message controls',
      (f, action) => {
        const nested = f.add(f.media, 'AXGroup', ['c-message_kit__actions']);
        action.actions.parent = nested.index;
      },
    ],
    [
      'nested composer controls',
      (f, action) => {
        const nested = f.add(f.media, 'AXTextArea', ['p-message_input']);
        action.actions.parent = nested.index;
      },
    ],
    [
      'nested external preview controls',
      (f, action) => {
        const nested = f.add(f.media, 'AXGroup', ['c-message_attachment_v3']);
        action.actions.parent = nested.index;
      },
    ],
    ['unrelated message actions', (f, action) => (action.actions.parent = f.container.index)],
  ]) {
    test(`does not offer file details for ${name}`, () => {
      const f = audio();
      const action = details(f, f.media);
      change(f, action);
      expect(f.extract().attachments[0]).not.toHaveProperty('fileDetailsAvailable');
    });
  }
});
