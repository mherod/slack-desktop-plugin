import { describe, expect, test } from 'bun:test';
import { extractMedia } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import { collectTranscriptPages } from './slack-transcript-pages.mjs';
import { transcriptOutput } from './slack-transcript.mjs';

// Synthetic accessibility structures and transcript text only.
function fixture(
  pageSegments = [
    [
      ['0 seconds', 'Opening.'],
      ['2 seconds', 'Repeated phrase.'],
    ],
    [
      ['2 seconds', 'Repeated phrase.'],
      ['4 seconds', 'Repeated phrase.'],
    ],
    [
      ['4 seconds', 'Repeated phrase.'],
      ['6 seconds', 'Closing.'],
    ],
  ]
) {
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
  const container = add(root, 'AXGroup', ['c-message_kit__actions']);
  const permalink = 'https://example.slack.com/archives/CDEMO/p1700000000000001';
  add(container, 'AXLink', ['c-timestamp'], 'Yesterday', { url: permalink });
  const media = add(container, 'AXGroup', ['p-video_message_file']);
  const overlay = add(media, 'AXGroup', ['p-video_controls_overlay'], 'example.mp4');
  add(overlay, 'AXCheckBox', [], 'Play, 10 seconds', { stateValue: '0' });
  const control = add(overlay, 'AXButton', [], 'View transcript');
  const requested = 'CDEMO:1700000000.000001/m1';
  const selection = {
    token: 'example-candidate',
    mediaIndex: media.index,
    containerIndex: container.index,
    controlIndex: control.index,
  };
  const observation = { content: { nodes, truncated: false } };
  const preflight = {
    operation: 'read-transcript',
    pid: 123,
    requested,
    observations: [observation, structuredClone(observation)],
    candidates: [selection],
  };
  const resolved = {
    status: 'ok',
    requested,
    workspace: { contextId: 'TDEMO', id: 'TDEMO' },
    view: { url: root.url, title: root.label },
    media: extractMedia(container, indexTree(nodes), { messageRef: 'CDEMO:1700000000.000001' })
      .attachments[0],
    sources: [{ messageRef: 'CDEMO:1700000000.000001', permalink }],
    navigation: [],
  };
  const frames = pageSegments.map((segments, index) => {
    const panelNodes = [
      {
        index: 0,
        parent: null,
        role: 'AXGroup',
        classes: ['p-media_transcript'],
        label: '',
        id: '',
      },
    ];
    for (const [timestamp, text] of segments) {
      for (const [name, label] of [
        ['timestamp', timestamp],
        ['text', text],
      ]) {
        panelNodes.push({
          index: panelNodes.length,
          parent: 0,
          role: 'AXButton',
          classes: [`p-media_transcript__${name}`],
          label,
          id: '',
        });
      }
    }
    const edge = index ? pageSegments[index - 1].at(-1) : null;
    const idle = () => [{ label: 'Play, 10 seconds', value: '0' }];
    return {
      transcript: { content: { nodes: panelNodes, truncated: false }, stable: true },
      verification: {
        sourceMatched: true,
        panelOpened: true,
        playbackUnchanged: true,
        bindingMode: 'video-active-control',
      },
      activeControl: {
        mode: 'video-active-control',
        verified: true,
        enabled: false,
        classes: ['c-button--disabled'],
      },
      playback: { before: idle(), afterOpen: idle(), afterCapture: idle() },
      pagination: {
        index: index + 1,
        status: index ? 'advanced' : 'initial',
        scrollAttempts: index ? 1 : 0,
        edge: edge ? { timestamp: edge[0], text: edge[1] } : null,
      },
    };
  });
  const receipt = {
    operation: 'read-transcript',
    phase: 'result',
    requested,
    pid: 123,
    status: 'ok',
    preflight,
    selection,
    transcriptPages: frames,
    transcriptBatch: {
      requestedPages: Math.max(2, frames.length),
      completedPages: frames.length,
      attemptedPages: frames.length,
      direction: 'down',
      stopReason: 'page-limit',
    },
  };
  const read = () =>
    collectTranscriptPages(receipt, resolved, receipt.transcriptBatch.requestedPages);
  return { receipt, resolved, frames, read };
}

describe('bounded transcript collection', () => {
  test('deduplicates overlap while keeping the same phrase at different times', () => {
    const f = fixture();
    const result = f.read();
    expect(result.status).toBe('ok');
    expect(result.transcript.segments.map((segment) => segment.timestamp)).toEqual([
      '0 seconds',
      '2 seconds',
      '4 seconds',
      '6 seconds',
    ]);
    expect(result.transcript.text).toBe('Opening.\nRepeated phrase.\nRepeated phrase.\nClosing.');
    expect(result.pagination).toMatchObject({
      capturedCount: 6,
      returnedCount: 4,
      scrollAttempts: 2,
      hasMore: null,
      nextCursor: null,
      batch: {
        requestedPages: 3,
        completedPages: 3,
        deduplicatedCount: 2,
        stopReason: 'page-limit',
      },
    });
    expect(result.coverage).toMatchObject({
      complete: false,
      segmentCount: 4,
      firstTimestamp: '0 seconds',
      lastTimestamp: '6 seconds',
    });
  });
  test('preserves equal-time occurrence order including identical repeated occurrences', () => {
    const repeated = [
      ['2 seconds', 'One.'],
      ['2 seconds', 'One.'],
      ['2 seconds', 'Two.'],
    ];
    const f = fixture([
      [['0 seconds', 'Opening.'], ...repeated],
      [...repeated, ['4 seconds', 'Later.']],
    ]);
    expect(f.read().transcript.segments).toEqual([
      { timestamp: '0 seconds', text: 'Opening.' },
      ...repeated.map(([timestamp, text]) => ({ timestamp, text })),
      { timestamp: '4 seconds', text: 'Later.' },
    ]);
    expect(f.read().pagination.batch.deduplicatedCount).toBe(3);
  });
  test('normalizes timestamp identity while preserving the first observed label', () => {
    const f = fixture([
      [
        ['0 seconds', 'Opening.'],
        ['1 minute, 3 seconds', 'Overlap.'],
      ],
      [
        ['01:03', 'Overlap.'],
        ['1 minute, 5 seconds', 'Later.'],
      ],
    ]);
    expect(f.read().transcript.segments[1].timestamp).toBe('1 minute, 3 seconds');
    expect(f.read().transcript.segments).toHaveLength(3);
  });
  test('accepts full retained content and an exact suffix without inferring completion', () => {
    for (const last of [
      [
        ['0 seconds', 'Opening.'],
        ['2 seconds', 'Repeated phrase.'],
      ],
      [['2 seconds', 'Repeated phrase.']],
    ]) {
      const f = fixture([
        [
          ['0 seconds', 'Opening.'],
          ['2 seconds', 'Repeated phrase.'],
        ],
        last,
      ]);
      f.frames[1].pagination.status = 'no-progress';
      f.receipt.transcriptBatch.stopReason = 'no-progress';
      f.receipt.transcriptBatch.requestedPages = 5;
      const result = f.read();
      expect(result.status).toBe('ok');
      expect(result.transcript.segments).toHaveLength(2);
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.warnings.join(' ')).toContain('end of the transcript remains unknown');
    }
  });
  test('a changed shared timestamp never overwrites the verified prefix', () => {
    const f = fixture();
    f.frames[1].transcript.content.nodes[2].label = 'Changed text.';
    const result = f.read();
    expect(result.status).toBe('partial');
    expect(result.transcript.segments).toEqual([
      { timestamp: '0 seconds', text: 'Opening.' },
      { timestamp: '2 seconds', text: 'Repeated phrase.' },
    ]);
    expect(result.pagination.batch.completedPages).toBe(1);
    expect(result.error).toContain('overlap changed');
  });
  test('rejects missing, skipped, backwards or shortened overlap groups', () => {
    const initial = [
      ['0 seconds', 'Opening.'],
      ['2 seconds', 'A.'],
      ['2 seconds', 'B.'],
      ['4 seconds', 'Edge.'],
    ];
    for (const next of [
      [['6 seconds', 'Missing overlap.']],
      [
        ['0 seconds', 'Opening.'],
        ['4 seconds', 'Edge.'],
        ['6 seconds', 'Skipped.'],
      ],
      [
        ['0 seconds', 'Opening.'],
        ['2 seconds', 'A.'],
        ['2 seconds', 'B.'],
      ],
      [
        ['2 seconds', 'B.'],
        ['4 seconds', 'Edge.'],
        ['6 seconds', 'Partial group.'],
      ],
      [
        ['2 seconds', 'B.'],
        ['2 seconds', 'A.'],
        ['4 seconds', 'Edge.'],
      ],
    ]) {
      const f = fixture([initial, next]);
      const result = f.read();
      expect(result.status).toBe('partial');
      expect(result.transcript.segments).toHaveLength(4);
      expect(result.pagination.batch.completedPages).toBe(1);
    }
  });
  test('does not retain new segments from a frame that later fails parsing', () => {
    const f = fixture();
    f.frames[1].transcript.content.nodes.at(-1).label = '';
    const result = f.read();
    expect(result.status).toBe('partial');
    expect(result.transcript.segments).toHaveLength(2);
    expect(result.pagination.capturedCount).toBe(2);
  });
  test('verifies progress status and stops after the first no-progress frame', () => {
    const advanced = fixture();
    advanced.frames[1].pagination.status = 'no-progress';
    expect(advanced.read().pagination.batch.completedPages).toBe(1);
    const repeated = fixture([
      [['0 seconds', 'A.']],
      [['0 seconds', 'A.']],
      [
        ['0 seconds', 'A.'],
        ['2 seconds', 'B.'],
      ],
    ]);
    expect(repeated.read().pagination.batch.completedPages).toBe(1);
    repeated.frames[1].pagination.status = 'no-progress';
    expect(repeated.read().pagination.batch.completedPages).toBe(2);
    expect(repeated.read().error).toContain('continued after no progress');
  });
  test('checks the prior original edge and one-based frame/scroll counters', () => {
    for (const change of [
      (f) => {
        f.frames[1].pagination.edge.text = 'Wrong edge.';
      },
      (f) => {
        f.frames[1].pagination.edge.timestamp = '0:02';
      },
      (f) => {
        f.frames[1].pagination.index = 1;
      },
      (f) => {
        f.frames[1].pagination.scrollAttempts = 2;
      },
    ]) {
      const f = fixture();
      change(f);
      expect(f.read().pagination.batch.completedPages).toBe(1);
    }
  });
  test('requires each native source/control/stability verification', () => {
    for (const change of [
      (f) => {
        f.frames[1].verification.sourceMatched = false;
      },
      (f) => {
        f.frames[1].verification.playbackUnchanged = false;
      },
      (f) => {
        f.frames[1].verification.bindingMode = 'audio-popover';
      },
      (f) => {
        f.frames[1].activeControl.verified = false;
      },
      (f) => {
        f.frames[1].transcript.stable = false;
      },
      (f) => {
        f.frames[1].transcript.content.truncated = true;
      },
    ]) {
      const f = fixture();
      change(f);
      expect(f.read().pagination.batch.completedPages).toBe(1);
    }
  });
  test('requires playback to remain the same idle initial baseline', () => {
    for (const change of [
      (f) => {
        f.frames[1].playback.before = [];
      },
      (f) => {
        f.frames[1].playback.afterOpen[0].value = '1';
      },
      (f) => {
        f.frames[1].playback.afterCapture[0].label = 'Pause, 10 seconds';
      },
      (f) => {
        delete f.frames[1].playback.afterCapture;
      },
      (f) => {
        for (const values of Object.values(f.frames[1].playback))
          values[0].label = 'Play, 20 seconds';
      },
    ]) {
      const f = fixture();
      change(f);
      expect(f.read().pagination.batch.completedPages).toBe(1);
    }
  });
  test('first-page verification failure has no salvageable prefix', () => {
    const f = fixture();
    f.frames[0].verification.sourceMatched = false;
    expect(f.read).toThrow('was not verified');
    const playing = fixture();
    playing.frames[0].playback.before[0].value = '1';
    expect(playing.read).toThrow('playback');
  });
  test('native later errors and time limits preserve only successful captures', () => {
    for (const stopReason of ['error', 'time-limit']) {
      const f = fixture();
      f.receipt.transcriptPages = f.frames.slice(0, 1);
      Object.assign(f.receipt.transcriptBatch, {
        completedPages: 1,
        attemptedPages: 2,
        stopReason,
      });
      f.receipt.status = 'partial';
      f.receipt.error = 'Panel changed before page two.';
      const result = f.read();
      expect(result.status).toBe('partial');
      expect(result.transcript.segments).toHaveLength(2);
      expect(result.pagination.batch.stopReason).toBe(stopReason);
      expect(result.next).toContain('Inspect');
    }
  });
  test('malformed native errors retain verified content without revealing arbitrary values', () => {
    for (const error of [{ message: 'Private failure detail' }, true, false, '', '   ', 0, 7, []]) {
      const f = fixture();
      f.receipt.error = error;
      const result = f.read();
      expect(result.status).toBe('partial');
      expect(result.error).toBe('Transcript collection returned a malformed error receipt');
      expect(result.transcript.segments).toHaveLength(4);
      expect(JSON.stringify(result)).not.toContain('Private failure detail');
    }
    for (const error of [null, undefined]) {
      const f = fixture();
      f.receipt.error = error;
      expect(f.read().status).toBe('ok');
    }
  });
  test('disagreed terminal status and unverified attempts become partial', () => {
    for (const change of [
      (f) => {
        f.receipt.transcriptBatch.stopReason = 'no-progress';
      },
      (f) => {
        f.receipt.transcriptBatch.stopReason = 'error';
      },
      (f) => {
        f.receipt.transcriptBatch.stopReason = 'time-limit';
      },
      (f) => {
        f.receipt.transcriptBatch.requestedPages = 4;
      },
      (f) => {
        f.receipt.status = 'partial';
      },
      (f) => {
        delete f.receipt.status;
      },
      (f) => {
        f.receipt.status = 'unknown';
      },
    ]) {
      const f = fixture();
      change(f);
      expect(f.read().status).toBe('partial');
      expect(f.read().transcript.segments).toHaveLength(4);
    }
  });
  test('no-progress takes precedence over reaching the requested page budget', () => {
    const f = fixture([[['0 seconds', 'A.']], [['0 seconds', 'A.']]]);
    f.frames[1].pagination.status = 'no-progress';
    const result = f.read();
    expect(result.status).toBe('partial');
    expect(result.error).toContain('stop reason');
    f.receipt.transcriptBatch.stopReason = 'no-progress';
    expect(f.read().status).toBe('ok');
  });
  test('rejects invalid request and batch counters before aggregation', () => {
    for (const change of [
      (f) => {
        f.receipt.transcriptBatch.requestedPages = 1;
      },
      (f) => {
        f.receipt.transcriptBatch.requestedPages = 11;
      },
      (f) => {
        f.receipt.transcriptBatch.requestedPages = 2.5;
      },
      (f) => {
        f.receipt.transcriptBatch.completedPages = 2;
      },
      (f) => {
        f.receipt.transcriptBatch.attemptedPages = 2;
      },
      (f) => {
        f.receipt.transcriptBatch.attemptedPages = 4;
      },
      (f) => {
        f.receipt.transcriptBatch.direction = 'up';
      },
      (f) => {
        f.receipt.transcriptBatch.stopReason = 'complete';
      },
      (f) => {
        f.receipt.pid = null;
      },
      (f) => {
        f.receipt.preflight.pid = 456;
      },
      (f) => {
        f.receipt.phase = 'select';
      },
      (f) => {
        delete f.receipt.phase;
      },
      (f) => {
        f.receipt.requested = 'FOTHER';
      },
      (f) => {
        f.receipt.transcriptPages = [];
      },
    ]) {
      const f = fixture();
      change(f);
      expect(f.read).toThrow();
    }
    const f = fixture();
    expect(() => collectTranscriptPages(f.receipt, f.resolved, 2)).toThrow();
  });
  test('does not mutate receipts and keeps single-page parser behavior unchanged', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    f.read();
    expect(JSON.stringify(f)).toBe(before);
    const single = transcriptOutput(
      { ...f.receipt, ...f.frames[0], transcriptPages: undefined, transcriptBatch: undefined },
      f.resolved
    );
    expect(single.pagination).toBeUndefined();
    expect(single.transcript.segments).toHaveLength(2);
  });
});
