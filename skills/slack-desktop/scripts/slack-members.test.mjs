import { describe, expect, test } from 'bun:test';
import { compactMembers } from './slack-members.mjs';
import { formatOutput, parseCLI } from './slack-format.mjs';

// Synthetic identities only.
const receipt = (extra = {}) => ({
  operation: 'members',
  status: 'ok',
  observedAt: '2026-01-01T00:00:00Z',
  channel: { name: 'demo', url: 'https://app.slack.com/client/TDEMO/CDEMO' },
  total: 2,
  members: [
    { id: 'UALEX1', name: 'alex', title: 'Alex Example Engineer' },
    { id: 'UCASEY2', name: 'Casey' },
  ],
  listPages: 1,
  stopReason: 'complete',
  dialogOpened: true,
  dialogReused: false,
  dialogClosed: true,
  ...extra,
});

describe('members receipts', () => {
  test('a complete read lists every member with its channel identity', () => {
    const result = compactMembers(receipt(), 'demo');
    expect(result).toMatchObject({
      status: 'ok',
      channel: { name: 'demo', id: 'CDEMO' },
      total: 2,
      coverage: { complete: true, collected: 2, stopReason: 'complete' },
    });
    expect(formatOutput(result)).toBe(
      'Members of #demo — 2 of 2 listed\n\n- alex · Alex Example Engineer\n- Casey'
    );
    expect(JSON.parse(formatOutput(result, 'json'))).toMatchObject({
      total: 2,
      members: [{ id: 'UALEX1' }, { id: 'UCASEY2' }],
    });
  });

  test('an incomplete read says so and suggests more pages', () => {
    const result = compactMembers(
      receipt({ total: 5, stopReason: 'page-limit', listPages: 5 }),
      'demo'
    );
    expect(result.coverage.complete).toBe(false);
    expect(formatOutput(result)).toContain(
      'Not every member was reached (page-limit); rerun without --pages to read the whole list.'
    );
    expect(
      formatOutput(
        compactMembers(receipt({ total: 5, stopReason: 'time-limit', listPages: 40 }), 'demo')
      )
    ).toContain('Not every member was reached (time-limit).');
  });

  test('a dialog that was already open is accepted when it was closed afterwards', () => {
    expect(
      compactMembers(receipt({ dialogOpened: false, dialogReused: true }), 'demo').status
    ).toBe('ok');
  });

  test('bounded member runtime is retained without implying completeness', () => {
    const raw = receipt({ total: 5, stopReason: 'time-limit', maxSeconds: 600 });
    const result = compactMembers(raw, 'demo');
    expect(result.coverage).toMatchObject({ complete: false, maxSeconds: 600 });
    expect(formatOutput(result)).toContain('--max-seconds=900');
    expect(JSON.parse(formatOutput(result, 'json')).coverage.maxSeconds).toBe(600);
    expect(JSON.parse(formatOutput(result, 'full-json', raw)).maxSeconds).toBe(600);
    expect(formatOutput(compactMembers({ ...raw, maxSeconds: 900 }, 'demo'))).not.toContain(
      '--max-seconds=900'
    );
    expect(compactMembers(receipt({ maxSeconds: 1 }), 'demo').coverage.complete).toBe(true);
    for (const maxSeconds of [null, 0, -1, 901, 1.5, '600', NaN, Infinity])
      expect(() => compactMembers(receipt({ maxSeconds }), 'demo')).toThrow();
  });

  test('an observed All member filter is retained and other states are refused', () => {
    const memberFilter = { status: 'verified-all', label: 'Filter by: All', value: 'All' };
    expect(compactMembers(receipt({ memberFilter }), 'demo').coverage.memberFilter).toBe('All');
    expect(compactMembers(receipt(), 'demo').coverage.memberFilter).toBeUndefined();
    for (const invalid of [
      null,
      '',
      'All',
      false,
      { ...memberFilter, value: 'Guests' },
      { ...memberFilter, status: 'unknown' },
      { ...memberFilter, label: 'Filter by: Guests' },
    ])
      expect(() => compactMembers(receipt({ memberFilter: invalid }), 'demo')).toThrow();
  });

  test('a deadline before the first capture can return a verified closed empty prefix', () => {
    const empty = receipt({ members: [], listPages: 0, stopReason: 'time-limit', maxSeconds: 1 });
    expect(compactMembers(empty, 'demo').coverage).toMatchObject({
      complete: false,
      pages: 0,
      collected: 0,
    });
    for (const extra of [
      { dialogClosed: false },
      { stopReason: 'complete' },
      { total: 0 },
      { members: [{ id: 'UALEX1', name: 'Alex' }] },
      { listPages: -1 },
    ])
      expect(() => compactMembers({ ...empty, ...extra }, 'demo')).toThrow();
  });

  test('leaf profile labels remain separate from unknown member names', () => {
    const members = [
      { id: 'UALEX1', name: null, label: 'Alex Example Alex Example Staff Engineer' },
      { id: 'UCASEY2', name: 'Casey', title: 'Casey Example Designer' },
    ];
    const raw = receipt({ members });
    const result = compactMembers(raw, 'demo');
    expect(result.members).toEqual(members);
    expect(result.members[0].title).toBeUndefined();
    expect(result.coverage.complete).toBe(true);
    expect(formatOutput(result)).toBe(
      'Members of #demo — 2 of 2 listed\n\n- [profile label; name unavailable] Alex Example Alex Example Staff Engineer\n- Casey · Casey Example Designer'
    );
    expect(JSON.parse(formatOutput(result, 'json')).members).toEqual(members);
    expect(JSON.parse(formatOutput(result, 'full-json', raw)).members).toEqual(members);
  });

  test('long profile labels are bounded in text and complete in JSON', () => {
    const label = '🙂'.repeat(2000);
    const result = compactMembers(
      receipt({ total: 1, members: [{ id: 'UALEX1', name: null, label }] }),
      'demo'
    );
    const text = formatOutput(result);
    expect(text).toContain(`${'🙂'.repeat(299)}…`);
    expect(text).toContain(
      'Profile labels are shortened; use --format=json for all captured text.'
    );
    expect(JSON.parse(formatOutput(result, 'json')).members[0]).toEqual({
      id: 'UALEX1',
      name: null,
      label,
    });
  });

  test('unknown names require a bounded observed label without inferred title or mixed identity', () => {
    const invalid = [
      { id: 'UALEX1', name: null },
      { id: 'UALEX1', label: 'Alex Example' },
      { id: 'UALEX1', name: null, label: '' },
      { id: 'UALEX1', name: null, label: '  ' },
      { id: 'UALEX1', name: null, label: 'Alex\nExample' },
      { id: 'UALEX1', name: null, label: 'x'.repeat(2001) },
      { id: 'UALEX1', name: null, label: 'Alex Example', title: 'Engineer' },
      { id: 'UALEX1', name: 'Alex', label: 'Alex Example' },
      { id: 'invalid', name: null, label: 'Alex Example' },
    ];
    for (const member of invalid)
      expect(() => compactMembers(receipt({ total: 1, members: [member] }), 'demo')).toThrow();
    expect(() =>
      compactMembers(
        receipt({
          members: [
            { id: 'UALEX1', name: null, label: 'Alex Example' },
            { id: 'UALEX1', name: 'Alex' },
          ],
        }),
        'demo'
      )
    ).toThrow();
  });

  test('inconsistent or malformed evidence is refused', () => {
    const bad = [
      receipt({ dialogClosed: false }),
      receipt({ dialogOpened: true, dialogReused: true }),
      receipt({ dialogOpened: false, dialogReused: false }),
      receipt({ stopReason: 'page-limit' }),
      receipt({ total: 3, stopReason: 'complete' }),
      receipt({ total: 1 }),
      receipt({
        members: [
          { id: 'UALEX1', name: 'alex' },
          { id: 'UALEX1', name: 'again' },
        ],
      }),
      receipt({
        members: [
          { id: 'bad', name: 'alex' },
          { id: 'UCASEY2', name: 'Casey' },
        ],
      }),
      receipt({
        members: [
          { id: 'UALEX1', name: '' },
          { id: 'UCASEY2', name: 'Casey' },
        ],
      }),
      receipt({ channel: { name: 'demo', url: 'https://app.slack.com/client/TDEMO/DDM1' } }),
      receipt({ channel: { name: 'demo', url: 'https://example.com/client/TDEMO/CDEMO' } }),
      receipt({ stopReason: 'unknown' }),
      receipt({ operation: 'read-channel' }),
      null,
    ];
    for (const value of bad) expect(() => compactMembers(value, 'demo')).toThrow();
  });

  test('a stopped read reports whether a dialog may still be open', () => {
    const open = compactMembers(
      { operation: 'members', status: 'stopped', error: 'x', dialogOpened: true },
      'demo'
    );
    expect(open.dialogMayBeOpen).toBe(true);
    expect(formatOutput(open)).toContain('Stopped: x');
    expect(formatOutput(open)).toContain('Run close-members');
    expect(open.navigation).toEqual({ command: 'close-members', args: [] });
    expect(
      compactMembers(
        { status: 'stopped', error: 'x', dialogOpened: true, dialogClosed: true },
        'demo'
      ).navigation
    ).toBeUndefined();
    expect(
      compactMembers(
        { status: 'stopped', error: 'x', dialogOpened: true, dialogClosed: true },
        'demo'
      ).dialogMayBeOpen
    ).toBe(false);
  });

  test('the command takes one channel name and optional pages, nothing else', () => {
    expect(parseCLI(['members', 'demo']).args).toEqual(['members', 'demo']);
    expect(parseCLI(['members', 'demo', '--pages=3']).args).toEqual(['members', 'demo']);
    for (const argv of [
      ['members'],
      ['members', 'demo', '--before=CDEMO:1700000000.000001'],
      ['--interaction=foreground', 'members', 'demo'],
    ])
      expect(() => parseCLI(argv)).toThrow();
    // One-shot form: select the workspace, then read members, in one command.
    expect(parseCLI(['members', 'demo', '--workspace=Demo']).workspaceTarget).toBe('Demo');
  });
});
