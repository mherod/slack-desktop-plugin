import { describe, expect, test } from 'bun:test';
import { compactThreadClose } from './slack-thread-close.mjs';
import { formatOutput, parseCLI } from './slack-format.mjs';

// Synthetic identities only.
const closed = (extra = {}) => ({
  operation: 'close-thread',
  status: 'ok',
  observedAt: '2026-01-01T00:00:00Z',
  wasOpen: true,
  closed: true,
  closeAttempted: true,
  thread: { conversationId: 'CDEMO', rootTS: '1700000000.000001' },
  ...extra,
});
const noop = (extra = {}) =>
  closed({ wasOpen: false, closed: false, closeAttempted: false, thread: null, ...extra });

describe('close-thread receipts', () => {
  test('a verified close reports the closed thread reference', () => {
    const result = compactThreadClose(closed());
    expect(result).toMatchObject({
      operation: 'close-thread',
      status: 'ok',
      wasOpen: true,
      closed: true,
      thread: { ref: 'CDEMO:1700000000.000001' },
    });
    expect(formatOutput(result)).toBe(
      'Closed thread pane: CDEMO:1700000000.000001.\nReopen: read-thread CDEMO:1700000000.000001'
    );
    expect(JSON.parse(formatOutput(result, 'json'))).toMatchObject({ wasOpen: true, closed: true });
  });

  test('a closed pane without a readable thread identity still verifies', () => {
    const result = compactThreadClose(closed({ thread: null }));
    expect(result.thread).toBeNull();
    expect(formatOutput(result)).toBe('Closed thread pane.');
  });

  test('no open pane is a verified no-op', () => {
    const result = compactThreadClose(noop());
    expect(result).toMatchObject({ wasOpen: false, closed: false, thread: null });
    expect(formatOutput(result)).toBe('No thread pane was open; nothing was closed.');
    expect(JSON.parse(formatOutput(result, 'json'))).toMatchObject({
      wasOpen: false,
      closed: false,
    });
  });

  test('inconsistent or malformed evidence is refused', () => {
    for (const receipt of [
      closed({ closed: false }),
      closed({ closeAttempted: false }),
      noop({ closeAttempted: true }),
      noop({ closed: true }),
      noop({ thread: { conversationId: 'CDEMO', rootTS: '1700000000.000001' } }),
      closed({ thread: { conversationId: 'cdemo', rootTS: '1700000000.000001' } }),
      closed({ thread: { conversationId: 'CDEMO', rootTS: '17' } }),
      closed({ wasOpen: undefined }),
      closed({ operation: 'read-thread' }),
      closed({ status: 'partial' }),
      null,
    ])
      expect(() => compactThreadClose(receipt)).toThrow();
  });

  test('a stopped close keeps its error and press uncertainty', () => {
    const stopped = compactThreadClose({
      operation: 'close-thread',
      status: 'stopped',
      error: 'Thread pane closure is unverified; inspect before retrying',
      closeAttempted: true,
    });
    expect(stopped).toMatchObject({ status: 'stopped', closeMayHaveBeenRequested: true });
    expect(formatOutput(stopped)).toContain('Stopped: Thread pane closure is unverified');
    expect(
      compactThreadClose({ status: 'stopped', error: 'early failure' }).closeMayHaveBeenRequested
    ).toBeNull();
  });

  test('the command accepts no positional arguments, pages or workspace flag', () => {
    expect(parseCLI(['close-thread']).args).toEqual(['close-thread']);
    for (const argv of [
      ['close-thread', 'CDEMO:1700000000.000001'],
      ['close-thread', '--pages=2'],
      ['--workspace=Demo', 'close-thread'],
      ['--interaction=foreground', 'close-thread'],
    ])
      expect(() => parseCLI(argv)).toThrow();
  });
});
