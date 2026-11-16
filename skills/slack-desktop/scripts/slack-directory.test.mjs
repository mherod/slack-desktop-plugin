import { describe, expect, test } from 'bun:test';
import { compactDirectory } from './slack-directory.mjs';
import { formatOutput, parseCLI } from './slack-format.mjs';

// Synthetic identities only.
const channels = (extra = {}) => ({
  operation: 'browse-channels',
  status: 'ok',
  observedAt: '2026-01-01T00:00:00Z',
  records: [
    { id: 'CDEMO1', name: 'demo-general', joined: true, memberCount: 12, description: 'Hello' },
    { id: 'CDEMO2', name: 'demo-solo', joined: false, memberCount: 1 },
  ],
  scrollSteps: 2,
  stopReason: 'no-progress',
  directoryOpened: true,
  ...extra,
});
const people = (extra = {}) => ({
  operation: 'browse-people',
  status: 'ok',
  records: [
    { id: 'UALEX1', name: 'Alex Example', title: 'Engineer' },
    { id: 'UCASEY2', name: 'Casey' },
  ],
  scrollSteps: 0,
  stopReason: 'no-progress',
  directoryOpened: false,
  ...extra,
});

describe('directory receipts', () => {
  test('channels list names, member counts and joined state, never claiming completeness', () => {
    const result = compactDirectory(channels(), 'browse-channels');
    expect(result.channels).toHaveLength(2);
    expect(result.coverage).toMatchObject({ complete: false, collected: 2 });
    const text = formatOutput(result);
    expect(text).toContain('- #demo-general · 12 members · joined');
    expect(text).toContain('- #demo-solo · 1 member');
    expect(text).toContain('may be incomplete');
    expect(JSON.parse(formatOutput(result, 'json')).channels[0]).toMatchObject({
      id: 'CDEMO1',
      joined: true,
    });
  });

  test('people list names and titles', () => {
    const result = compactDirectory(people(), 'browse-people');
    expect(result.people.map((person) => person.id)).toEqual(['UALEX1', 'UCASEY2']);
    expect(formatOutput(result)).toContain('- Alex Example · Engineer\n- Casey');
  });

  test('malformed or duplicated records are refused', () => {
    const bad = [
      [channels({ records: [{ id: 'bad', name: 'x', joined: true }] }), 'browse-channels'],
      [channels({ records: [{ id: 'CDEMO1', name: 'x' }] }), 'browse-channels'],
      [
        channels({
          records: [
            { id: 'CDEMO1', name: 'x', joined: true },
            { id: 'CDEMO1', name: 'y', joined: false },
          ],
        }),
        'browse-channels',
      ],
      [channels({ stopReason: 'end-of-list' }), 'browse-channels'],
      [people({ records: [{ id: 'CDEMO1', name: 'x' }] }), 'browse-people'],
      [people({ records: [{ id: 'UALEX1', name: '' }] }), 'browse-people'],
      [people(), 'browse-channels'],
      [null, 'browse-people'],
    ];
    for (const [receipt, operation] of bad)
      expect(() => compactDirectory(receipt, operation)).toThrow();
  });

  test('a stopped read keeps its error', () => {
    const stopped = compactDirectory(
      { operation: 'browse-people', status: 'stopped', error: 'Directory view did not open' },
      'browse-people'
    );
    expect(formatOutput(stopped)).toContain('Stopped: Directory view did not open');
  });

  test('the commands take pages and a workspace, but no positional arguments', () => {
    expect(parseCLI(['browse-channels', '--pages=3']).args).toEqual(['browse-channels']);
    expect(parseCLI(['browse-people', '--workspace=Demo']).workspaceTarget).toBe('Demo');
    for (const argv of [
      ['browse-channels', 'demo'],
      ['browse-people', '--before=CDEMO1:1700000000.000001'],
    ])
      expect(() => parseCLI(argv)).toThrow();
  });
});
