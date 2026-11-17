import { describe, expect, test } from 'bun:test';
import { formatOutput, parseCLI } from './slack-format.mjs';
import { normalizeSearchQuery } from './slack-search-query.mjs';

const message = (index) => ({
  id: `message-${index}`,
  author: `Person ${index}`,
  displayedTime: `10:${String(index).padStart(2, '0')}`,
  text: `Message body ${index}.`,
  permalink: `https://demo.slack.com/archives/CDEMO/p${index}`,
  thread: { replyCount: null, repliesRead: false },
  attachments: [],
});
const messages = (count) => Array.from({ length: count }, (_, index) => message(index + 1));
const base = () => ({
  schemaVersion: 1,
  operation: 'read-channel',
  workspace: { name: 'Example Workspace' },
  conversation: { name: 'project-help', kind: 'channel' },
  messages: messages(2),
  coverage: { complete: false, warnings: [] },
  pagination: { supported: false, hasMore: null, nextCursor: null },
  desktop: { samples: [{ foregroundPid: 31415, cursor: [100, 200] }] },
});
const threadResult = (count = 2) => ({
  ...base(),
  operation: 'read-thread',
  messages: undefined,
  requested: 'https://demo.slack.com/archives/CDEMO/p1700000000000000',
  thread: {
    requestedMessageTS: '1700000000.000000',
    rootTS: '1700000000.000000',
    rootPermalink: 'https://demo.slack.com/archives/CDEMO/p1700000000000000',
    displayedReplyCount: count,
    observedReplyCount: count,
    root: {
      ...message(0),
      text: 'Distinct root message.',
      permalink: 'https://demo.slack.com/archives/CDEMO/p1700000000000000',
    },
    replies: messages(count),
  },
  coverage: { complete: false, threadRepliesIncluded: true, warnings: [] },
});

describe('format option parsing', () => {
  test('defaults to text and accepts one format anywhere before the separator', () => {
    expect(parseCLI(['search', 'release notes'])).toEqual({
      args: ['search', 'release notes'],
      interaction: 'background',
      format: 'text',
    });
    for (const argv of [
      ['--format=json', 'search', 'term'],
      ['search', '--format=json', 'term'],
      ['search', 'term', '--format=json'],
    ]) {
      expect(parseCLI(argv)).toEqual({
        interaction: 'background',
        args: ['search', 'term'],
        format: 'json',
      });
    }
    expect(parseCLI(['permissions', '--request', '--format=full-json'])).toEqual({
      args: ['permissions', '--request'],
      interaction: 'background',
      format: 'full-json',
    });
    expect(parseCLI(['--help'])).toEqual({
      interaction: 'background',
      args: ['--help'],
      format: 'text',
    });
  });

  test('preserves literal format-like queries after --', () => {
    expect(parseCLI(['search', '--', '--format=json'])).toEqual({
      args: ['search', '--format=json'],
      interaction: 'background',
      format: 'text',
    });
    expect(parseCLI(['--format=json', 'search', '--', '--format=full-json'])).toEqual({
      args: ['search', '--format=full-json'],
      interaction: 'background',
      format: 'json',
    });
    expect(parseCLI(['search', '--', '-excluded-term'])).toEqual({
      args: ['search', '-excluded-term'],
      interaction: 'background',
      format: 'text',
    });
  });

  test('rejects duplicate formats, unknown formats and unknown flags before UI work', () => {
    for (const argv of [
      ['inspect', '--format=json', '--format=text'],
      ['inspect', '--format=text', '--format=text'],
      ['inspect', '--format=yaml'],
      ['inspect', '--format='],
      ['inspect', '--format', 'json'],
      ['inspect', '--verbose'],
      ['inspect', '-q'],
    ]) {
      let error;
      try {
        parseCLI(argv);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error.exitCode).toBe(2);
    }
  });

  test('retains a previously selected format when a later argument is invalid', () => {
    for (const format of ['json', 'full-json']) {
      let failure;
      try {
        parseCLI([`--format=${format}`, '--invalid']);
      } catch (error) {
        failure = error;
      }
      expect(failure.format).toBe(format);
      expect(failure.exitCode).toBe(2);
    }
  });
});

describe('member collection time budget', () => {
  test('accepts canonical seconds independently of page and workspace limits', () => {
    for (const seconds of [1, 9, 10, 70, 160, 899, 900]) {
      for (const argv of [
        [`--max-seconds=${seconds}`, 'members', 'demo'],
        ['members', `--max-seconds=${seconds}`, 'demo'],
        ['members', 'demo', `--max-seconds=${seconds}`],
      ])
        expect(parseCLI(argv)).toEqual({
          args: ['members', 'demo'],
          format: 'text',
          interaction: 'background',
          maxSeconds: seconds,
        });
    }
    expect(
      parseCLI([
        'members',
        'demo',
        '--pages=3',
        '--max-seconds=900',
        '--workspace=Demo',
        '--lock-timeout=60',
        '--format=full-json',
      ])
    ).toEqual({
      args: ['members', 'demo'],
      format: 'full-json',
      interaction: 'background',
      pages: 3,
      maxSeconds: 900,
      workspaceTarget: 'Demo',
      lockTimeout: 60,
    });
    expect(parseCLI(['members', 'demo'])).not.toHaveProperty('maxSeconds');
    expect(parseCLI(['members', 'demo', '--pages=1'])).not.toHaveProperty('maxSeconds');
    expect(parseCLI(['search', '--', '--max-seconds=900'])).toEqual({
      args: ['search', '--max-seconds=900'],
      format: 'text',
      interaction: 'background',
    });
  });

  test('rejects malformed, duplicate and non-member budgets before input in every format', () => {
    const invalid = [
      ...[
        '',
        '0',
        '901',
        '1000',
        '01',
        '0900',
        '-1',
        '+1',
        '1.0',
        '1e2',
        'NaN',
        'Infinity',
        ' 1',
        '1 ',
        '1\n',
        '１',
        '1=2',
      ].map((value) => ['members', 'demo', `--max-seconds=${value}`]),
      ['members', 'demo', '--max-seconds=1', '--max-seconds=2'],
      ['members', 'demo', '--max-seconds', '1'],
      ['members', '--max-seconds=1'],
      ['members', 'demo', 'extra', '--max-seconds=1'],
      ['members', 'demo', '--max-seconds=1', '--interaction=foreground'],
      ...[
        'inspect',
        'channels',
        'dms',
        'browse-channels',
        'browse-people',
        'close-members',
        'close-thread',
        'permissions',
        '--help',
      ].map((command) => [command, '--max-seconds=1']),
      ...[
        'search',
        'channel',
        'read-channel',
        'read-dm',
        'read-thread',
        'read-transcript',
        'read-media',
        'save-media',
        'switch-workspace',
      ].map((command) => [command, 'target', '--max-seconds=1']),
    ];
    for (const format of ['text', 'json', 'full-json']) {
      for (const argv of invalid) {
        let failure;
        try {
          parseCLI([`--format=${format}`, ...argv]);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure.exitCode).toBe(2);
        expect(failure.format).toBe(format);
      }
    }
  });
});

describe('interaction mode parsing and output', () => {
  test('keeps background as the default and accepts either explicit mode syntax', () => {
    expect(parseCLI(['search', 'term']).interaction).toBe('background');
    for (const interaction of ['background', 'foreground']) {
      for (const option of [[`--interaction=${interaction}`], ['--interaction', interaction]]) {
        for (const argv of [
          [...option, 'search', 'term'],
          ['search', ...option, 'term'],
          ['search', 'term', ...option],
        ]) {
          expect(parseCLI(argv)).toEqual({ args: ['search', 'term'], format: 'text', interaction });
        }
      }
    }
  });

  test('allows foreground mode for every supported interacting command', () => {
    for (const argv of [
      ['channels', '--pages=2'],
      ['dms', '--search=Alex', '--allow-clipboard', '--pages=2'],
      ['channel', 'general'],
      ['search', 'term', '--pages=2'],
      ['read-channel', 'general', '--pages=2'],
      ['read-dm', '@alex', '--pages=2'],
      ['read-thread', 'CDEMO:1700000000.000001', '--pages=2'],
      ['read-transcript', 'FDEMO', '--pages=2'],
      ['save-media', 'FDEMO', '--output=/tmp/attachment.bin'],
    ]) {
      for (const format of ['text', 'json', 'full-json']) {
        expect(parseCLI([...argv, '--interaction=foreground', `--format=${format}`])).toEqual({
          ...parseCLI([...argv, `--format=${format}`]),
          interaction: 'foreground',
        });
      }
    }
  });

  test('read-only and setup commands accept background but reject foreground', () => {
    for (const argv of [
      ['inspect'],
      ['inspect', '--ui', '--prepare'],
      ['read-media', 'FDEMO'],
      ['permissions'],
      ['permissions', '--request'],
      ['--help'],
    ]) {
      expect(parseCLI([...argv, '--interaction=background'])).toEqual(parseCLI(argv));
      expect(() => parseCLI([...argv, '--interaction=foreground'])).toThrow(
        'requires a command that interacts'
      );
    }
  });

  test('rejects missing, unknown and duplicate modes without consuming literal arguments', () => {
    for (const argv of [
      ['search', 'term', '--interaction'],
      ['search', 'term', '--interaction='],
      ['search', 'term', '--interaction=auto'],
      ['search', 'term', '--interaction=Foreground'],
      ['search', 'term', '--interaction=foreground=extra'],
      ['search', '--interaction', '--', 'foreground'],
      ['search', 'term', '--interaction=background', '--interaction=foreground'],
      ['search', 'term', '--interaction', 'foreground', '--interaction=foreground'],
      ['search', 'term', '--interaction=background', '--interaction', 'background'],
      ['--interaction=foreground'],
      ['unknown', '--interaction=foreground'],
    ]) {
      let failure;
      try {
        parseCLI(['--format=json', ...argv]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('json');
    }
    expect(parseCLI(['search', '--', '--interaction=foreground'])).toEqual({
      args: ['search', '--interaction=foreground'],
      format: 'text',
      interaction: 'background',
    });
    expect(parseCLI(['search', '--', '--interaction'])).toEqual({
      args: ['search', '--interaction'],
      format: 'text',
      interaction: 'background',
    });
  });

  test('preserves ordinary output and adds one explicit foreground notice', () => {
    const compact = base();
    const before = formatOutput(compact);
    expect(formatOutput(compact, 'text', { interaction: { mode: 'background' } })).toBe(before);
    expect(JSON.parse(formatOutput(compact, 'json'))).not.toHaveProperty('interaction');
    for (const activated of [true, false]) {
      const interaction = { mode: 'foreground', activationRequested: true, activated };
      const receipt = { interaction, desktop: { foregroundBefore: 123, pid: 456 } };
      const output = formatOutput(compact, 'text', receipt);
      expect(output).toBe(`${before}\n\nForeground interaction requested; no automatic retry.`);
      expect(output.match(/Foreground interaction requested/g)).toHaveLength(1);
      expect(output).not.toContain('activated');
      expect(JSON.parse(formatOutput(compact, 'json', receipt)).interaction).toEqual(interaction);
      expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
      expect(compact).not.toHaveProperty('interaction');
    }
  });

  test('foreground notices preserve failures and semantic JSON strips diagnostic identifiers', () => {
    const compact = {
      status: 'stopped',
      operation: 'search',
      error: 'Activation was not verified; input withheld',
      interaction: {
        mode: 'foreground',
        activationRequested: true,
        activated: false,
        foregroundBefore: 123,
        pid: 456,
      },
    };
    const output = formatOutput(compact);
    expect(output).toStartWith('Stopped: Activation was not verified; input withheld');
    expect(output).toContain('Foreground interaction requested; no automatic retry.');
    expect(JSON.parse(formatOutput(compact, 'json')).interaction).toEqual({
      mode: 'foreground',
      activationRequested: true,
      activated: false,
    });
  });
});

describe('coordination and UI option parsing', () => {
  test('ordinary DM reads optionally authorize fallback without changing cursors or formats', () => {
    for (const format of ['text', 'json', 'full-json']) {
      for (const name of ['Alex Example', '@alex.example']) {
        expect(
          parseCLI(['read-dm', name, '--allow-clipboard', '--pages=3', `--format=${format}`])
        ).toEqual({
          interaction: 'background',
          args: ['read-dm', name],
          allowClipboard: true,
          pages: 3,
          format,
        });
        expect(parseCLI(['read-dm', name, `--format=${format}`])).toEqual({
          args: ['read-dm', name],
          interaction: 'background',
          format,
        });
      }
    }
    expect(
      parseCLI(['read-dm', 'Alex Example', '--allow-clipboard', '--before=DDEMO:1700000000.000000'])
        .page
    ).toEqual({ direction: 'older', cursor: 'DDEMO:1700000000.000000' });
    expect(() => parseCLI(['read-channel', 'general', '--allow-clipboard'])).toThrow();
    expect(() => parseCLI(['read-dm', 'Alex', '--allow-clipboard', '--allow-clipboard'])).toThrow();
  });
  test('native DMs search and named group lookup require explicit clipboard permission', () => {
    for (const format of ['text', 'json', 'full-json']) {
      expect(parseCLI(['dms', `--format=${format}`, '--search='])).toEqual({
        args: ['dms'],
        interaction: 'background',
        format,
        dmSearch: '',
      });
      for (const query of ['Alex', ' Alex = example ', '🙂'.repeat(200)]) {
        expect(() => parseCLI(['dms', `--search=${query}`])).toThrow('--allow-clipboard');
        expect(
          parseCLI([
            'dms',
            `--format=${format}`,
            `--search=${query}`,
            '--allow-clipboard',
            '--filter=Local',
            '--pages=3',
          ])
        ).toEqual({
          args: ['dms'],
          interaction: 'background',
          format,
          dmSearch: query,
          allowClipboard: true,
          dmFilter: 'Local',
          pages: 3,
        });
      }
    }
    expect(
      parseCLI(['read-dm', 'group-name:Project planning', '--allow-clipboard', '--pages=2'])
    ).toEqual({
      args: ['read-dm', 'group-name:Project planning'],
      interaction: 'background',
      format: 'text',
      allowClipboard: true,
      pages: 2,
    });
    expect(parseCLI(['search', '--', '--search=Alex'])).toEqual({
      args: ['search', '--search=Alex'],
      interaction: 'background',
      format: 'text',
    });
  });

  test('rejects unsupported clipboard use, duplicate search options and unsafe names', () => {
    for (const argv of [
      ['dms', '--allow-clipboard'],
      ['dms', '--search=', '--allow-clipboard'],
      ['dms', '--search=   ', '--allow-clipboard'],
      ['dms', '--search=\u00a0', '--allow-clipboard'],
      ['dms', '--search=Alex', '--allow-clipboard', '--allow-clipboard'],
      ['dms', '--search=Alex', '--search=Other', '--allow-clipboard'],
      ['inspect', '--search=Alex', '--allow-clipboard'],
      ['dms', '--search=Alex', '--allow-clipboard', '--ui'],
      ['read-dm', 'group:CGROUP', '--allow-clipboard'],
      ['read-dm', 'group-name:Project'],
      ['read-dm', 'group-name:', '--allow-clipboard'],
      ['read-dm', 'group-name:  ', '--allow-clipboard'],
      ['read-dm', 'group-name:' + 'x'.repeat(201), '--allow-clipboard'],
      ...['\n', '\x00', '\x7f', '\x85', '🙂'.repeat(201)].map((query) => [
        'dms',
        `--search=${query}`,
        '--allow-clipboard',
      ]),
    ])
      expect(() => parseCLI(argv)).toThrow();
  });

  test('DM filters distinguish omission, unrestricted empty text and exact text', () => {
    expect(parseCLI(['dms'])).toEqual({ interaction: 'background', args: ['dms'], format: 'text' });
    for (const filter of ['', 'Alex', ' Alex = example ', '🙂'.repeat(200)]) {
      expect(parseCLI(['dms', `--filter=${filter}`])).toEqual({
        args: ['dms'],
        interaction: 'background',
        format: 'text',
        dmFilter: filter,
      });
      expect(
        parseCLI([`--filter=${filter}`, 'dms', '--pages=3', '--format=json', '--lock-timeout=0'])
      ).toEqual({
        interaction: 'background',
        args: ['dms'],
        format: 'json',
        dmFilter: filter,
        pages: 3,
        lockTimeout: 0,
      });
    }
    expect(parseCLI(['search', '--', '--filter=Alex'])).toEqual({
      args: ['search', '--filter=Alex'],
      interaction: 'background',
      format: 'text',
    });
  });

  test('DM filters reject UI-only options, duplicates and invalid text before native work', () => {
    expect(() => parseCLI(['dms', '--filter=Alex', '--filter='])).toThrow('only once');
    for (const argument of ['--ui', '--prepare', '--limit=80', '--depth=20'])
      expect(() => parseCLI(['dms', '--filter=Alex', argument])).toThrow('inspect --ui');
    for (const value of ['\n', '\x00', '\x7f', '\x85', '🙂'.repeat(201)])
      expect(() => parseCLI(['dms', `--filter=${value}`])).toThrow('200 Unicode');
    for (const argv of [
      ['dms', '--filter', 'Alex'],
      ['dms', 'Alex', '--filter=Alex'],
      ['channels', '--filter=Alex'],
      ['read-dm', 'Alex', '--filter=Alex'],
      ['search', 'Alex', '--filter=Alex'],
    ])
      expect(() => parseCLI(argv)).toThrow();
  });

  test('keeps lock timeout separate from native arguments', () => {
    for (const timeout of [0, 1, 30, 99, 100, 119, 120])
      expect(parseCLI(['--lock-timeout=' + timeout, 'dms'])).toEqual({
        args: ['dms'],
        interaction: 'background',
        format: 'text',
        lockTimeout: timeout,
      });
    expect(parseCLI(['search', '--', '--lock-timeout=0'])).toEqual({
      args: ['search', '--lock-timeout=0'],
      interaction: 'background',
      format: 'text',
    });
    for (const flag of ['-1', '121', '01', '1.5', '', 'Infinity', '1e2'])
      expect(() => parseCLI(['dms', '--lock-timeout=' + flag])).toThrow();
    expect(() => parseCLI(['dms', '--lock-timeout=0', '--lock-timeout=30'])).toThrow('only once');
  });

  test('normalizes bounded UI flags and preserves empty or Unicode filters', () => {
    expect(parseCLI(['inspect', '--ui'])).toEqual({
      args: ['inspect'],
      interaction: 'background',
      format: 'text',
      ui: { filter: '', limit: 80, depth: 20, prepare: false },
    });
    expect(
      parseCLI([
        '--filter=  🙂é  ',
        '--limit=500',
        'inspect',
        '--ui',
        '--depth=0',
        '--prepare',
        '--lock-timeout=0',
        '--format=json',
      ])
    ).toEqual({
      args: ['inspect'],
      interaction: 'background',
      format: 'json',
      lockTimeout: 0,
      ui: { filter: '  🙂é  ', limit: 500, depth: 0, prepare: true },
    });
    expect(parseCLI(['inspect', '--ui', '--filter=']).ui.filter).toBe('');
    expect(parseCLI(['inspect', '--ui', '--filter=' + '🙂'.repeat(200)]).ui.filter).toBe(
      '🙂'.repeat(200)
    );
    expect(parseCLI(['search', '--', '--ui'])).toEqual({
      args: ['search', '--ui'],
      interaction: 'background',
      format: 'text',
    });
  });

  test('rejects unsupported command scope, duplicate options and invalid bounds', () => {
    for (const argv of [
      ['dms', '--ui'],
      ['inspect', '--prepare'],
      ['inspect', '--filter='],
      ['inspect', '--depth=0'],
      ['inspect', '--ui', 'extra'],
      ['search', 'query', '--ui'],
      ['inspect', '--ui', '--ui'],
      ['inspect', '--ui', '--prepare', '--prepare'],
      ['inspect', '--ui', '--filter=a', '--filter=b'],
      ['inspect', '--ui', '--limit=1', '--limit=2'],
      ['inspect', '--ui', '--depth=0', '--depth=1'],
      ['inspect', '--ui', '--pages=2'],
      ...['0', '501', '01', '1.5', '-1', ''].map((n) => ['inspect', '--ui', '--limit=' + n]),
      ...['41', '00', '-1', '1.5', ''].map((n) => ['inspect', '--ui', '--depth=' + n]),
      ...['\n', '\x00', '\x7f', '\x85', '🙂'.repeat(201)].map((s) => [
        'inspect',
        '--ui',
        '--filter=' + s,
      ]),
    ]) {
      expect(() => parseCLI(argv)).toThrow();
    }
  });
});

describe('lock diagnostics', () => {
  const failure = () => ({
    status: 'stopped',
    error: 'Timed out waiting',
    next: 'Retry later',
    lock: {
      path: '/tmp/example/active.lock',
      reason: 'timeout',
      waitedMs: 30100,
      timeoutSeconds: 30,
      ownerStatus: 'known',
      ownerPid: 1234,
      operation: 'dms',
      acquiredAt: '2026-11-09T00:00:00.000Z',
      processState: 'running',
      scope: 'cooperating helper processes only',
      token: 'never-output',
      query: 'private query',
      nodes: ['private'],
      owner: { pid: 4321, token: 'private' },
    },
  });
  test('reports owner liveness concisely without claiming UI ownership', () => {
    const output = formatOutput(failure());
    expect(output).toContain('Lock: waited 30.1s (limit 30s); owner PID 1234, dms; PID running.');
    expect(output).not.toContain('never-output');
    expect(output.indexOf('Lock:')).toBeGreaterThan(output.indexOf('Stopped:'));
    expect(output.indexOf('Next:')).toBeGreaterThan(output.indexOf('Lock:'));
  });
  test('projects only explicit lock fields into semantic JSON', () => {
    const output = JSON.parse(formatOutput(failure(), 'json'));
    expect(output.lock.ownerPid).toBe(1234);
    expect(output.lock.token).toBeUndefined();
    expect(output.lock.owner).toBeUndefined();
    expect(output.lock.query).toBeUndefined();
    expect(output.lock.nodes).toBeUndefined();
    expect(output.error).toBe('Timed out waiting');
  });
  test('unknown owners remain explicit and malformed diagnostics never replace failure', () => {
    const result = failure();
    Object.assign(result.lock, {
      ownerStatus: 'legacy-or-initializing',
      ownerPid: null,
      operation: null,
      acquiredAt: null,
      processState: 'unknown',
    });
    expect(formatOutput(result)).toContain('owner legacy-or-initializing');
    result.lock.waitedMs = -1;
    expect(JSON.parse(formatOutput(result, 'json')).lock).toBeUndefined();
    expect(formatOutput(result)).toContain('Stopped: Timed out waiting');
    expect(formatOutput(result)).not.toContain('Lock:');
    result.observation = { ui: { nodes: [{ label: 'unverified control' }] } };
    expect(JSON.parse(formatOutput(result, 'json')).observation).toBeUndefined();
    expect(formatOutput(result)).toContain('Stopped: Timed out waiting');
  });
});

describe('local DM match output', () => {
  const result = (query, matches = 1) => ({
    operation: 'dms',
    requested: null,
    dms: matches
      ? [{ id: 'D1', name: 'Alex', kind: 'one-to-one', participantLabels: [], navigation: null }]
      : [],
    coverage: {
      source: 'dms-view',
      complete: false,
      observedCount: 3,
      filters: { query: 'Existing Slack filter', unreadOnly: true },
      match: {
        query,
        fields: ['name', 'participantLabels'],
        observedCount: 3,
        matchedCount: matches,
        scope: 'captured DM names and observed participant header labels',
      },
    },
  });
  test('shows local query and match fraction separately from preserved Slack filters', () => {
    const compact = result(' ALEX ');
    const text = formatOutput(compact);
    expect(text).toContain('Local filter: " ALEX "; 1 of 3 observed conversations matched.');
    expect(text).toContain('Filters: search "Existing Slack filter"; unread only.');
    expect(text).not.toContain('cleared');
    expect(JSON.parse(formatOutput(compact, 'json')).coverage.match).toEqual(
      compact.coverage.match
    );
  });
  test('zero local matches remain bounded rather than claiming an empty DM directory', () => {
    const text = formatOutput(result('Nobody', 0));
    expect(text).toContain('0 of 3 observed conversations matched');
    expect(text).toContain('No captured DM conversations matched the local filter.');
    expect(text).not.toContain('No DM conversations were exposed');
    expect(text).toContain('other DM conversations may be outside this view');
  });
  test('explains participant-only matches without dumping participant labels', () => {
    const compact = result('Leah');
    compact.dms[0] = {
      id: 'CPLAN',
      name: 'Planning',
      kind: 'group',
      participantLabels: ['Leah Example, Other Person'],
      navigation: null,
    };
    const text = formatOutput(compact);
    expect(text).toContain('Planning (group DM) (participant match)');
    expect(text).not.toContain('Leah Example, Other Person');
  });
  test('empty local restriction does not claim to clear the Slack query', () => {
    const compact = result('');
    compact.coverage.match.observedCount = 1;
    const text = formatOutput(compact);
    expect(text).toContain('Local filter: none; all 1 observed conversations included.');
    expect(text).toContain('Existing Slack filter');
    expect(text).not.toContain('cleared');
  });
});

describe('native DMs search output', () => {
  const result = (query) => ({
    operation: 'dms',
    requested: null,
    dms: [{ id: 'DA', name: 'Example', kind: 'one-to-one', navigation: null }],
    coverage: {
      source: 'dms-view',
      complete: false,
      observedCount: 1,
      filters: { query, unreadOnly: true },
      search: { source: 'slack-dms-view', requestedQuery: query, verified: true },
    },
  });

  test('shows verified native search separately from local matching and unread filters', () => {
    const compact = result(' Alex ');
    compact.coverage.match = {
      query: 'example',
      fields: ['name', 'participantLabels'],
      observedCount: 3,
      matchedCount: 1,
      scope: 'captured DM names and observed participant header labels',
    };
    const text = formatOutput(compact);
    expect(text).toContain('Slack DMs search: " Alex ".');
    expect(text).toContain('Local filter: "example"; 1 of 3 observed conversations matched.');
    expect(text).toContain('Filters: unread only.');
    expect(text).not.toContain('Filters: search');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.requested).toBeNull();
    expect(json.coverage.search).toEqual(compact.coverage.search);
    expect(json.coverage.match.query).toBe('example');
  });

  test('reports explicit native clear without claiming the local filter cleared Slack', () => {
    expect(formatOutput(result(''))).toContain('Slack DMs search: cleared.');
    expect(formatOutput(result(''))).toContain('Filters: unread only.');
    const compact = result('Alex');
    compact.coverage.search.verified = false;
    expect(() => formatOutput(compact)).toThrow('Native DMs search summary');
    compact.coverage.search.verified = true;
    compact.coverage.filters.query = 'Other';
    expect(() => formatOutput(compact)).toThrow('Native DMs search summary');
  });
});

describe('trimmed plain text', () => {
  test('caps channels at 30 with explicit counts and no desktop diagnostics', () => {
    const compact = {
      ...base(),
      operation: 'channels',
      channels: Array.from({ length: 35 }, (_, index) => ({
        name: `channel-${index + 1}`,
        unread: index === 0,
      })),
    };
    const output = formatOutput(compact);
    expect(output).toContain('Channels — Example Workspace');
    expect(output).toContain('#channel-1 (unread)');
    expect(output).toContain('#channel-30 · read-channel channel-30\n');
    expect(output).not.toContain('#channel-31');
    expect(output).toContain('Showing 30 of 35 captured channels; 5 omitted.');
    expect(output).toContain('--format=json');
    expect(output).not.toContain('31415');
    expect(output).not.toContain('desktop');
    expect(output).toContain('Showing exposed sidebar channels');
  });

  test('shows the last ten loaded messages with source links and metadata', () => {
    const compact = { ...base(), messages: messages(12) };
    const output = formatOutput(compact);
    expect(output).toContain('Showing last 10 of 12 captured messages; 2 omitted.');
    expect(output).not.toContain('Message body 1.');
    expect(output).not.toContain('Message body 2.');
    expect(output).toContain('Person 3\n  10:03  Message body 3.');
    expect(output).toContain('Message body 12.');
    expect(output).toContain('https://demo.slack.com/archives/CDEMO/p12');
    expect(output).toContain('older messages and thread replies may be outside this view');
  });

  test('prints conversations as a transcript grouped by day and author with short references', () => {
    const at = (index, day, time, author, extra = {}) => ({
      ...message(index),
      id: `message-list_1700000000.00000${index}`,
      author,
      displayedTime: `${day} at ${time}`,
      permalink: `https://demo.slack.com/archives/CDEMO1/p170000000000000${index}`,
      ...extra,
    });
    const compact = {
      ...base(),
      conversation: { name: 'project-help', kind: 'channel', id: 'CDEMO1' },
      messages: [
        at(1, 'Yesterday', '21:14:48', 'Alex Example'),
        at(2, 'Yesterday', '21:15:03', 'Alex Example', {
          authorInferred: true,
          authorSourceMessageId: 'message-list_1700000000.000001',
        }),
        at(3, 'Yesterday', '21:16:00', 'Sam Example'),
        at(4, 'Today', '09:00:00', 'Sam Example'),
        at(5, 'Today', '09:01:00', 'Sam Example', {
          authorInferred: true,
          authorSourceMessageId: 'message-list_1699999999.000000',
        }),
      ],
      pagination: {
        supported: true,
        cursor: null,
        status: 'advanced',
        hasMore: null,
        older: {
          cursor: 'CDEMO1:1700000000.000001',
          navigation: { command: 'read-channel', args: ['project-help', '--before=CDEMO1:1700000000.000001'] },
        },
        newer: {
          cursor: 'CDEMO1:1700000000.000003',
          navigation: { command: 'read-channel', args: ['project-help', '--after=CDEMO1:1700000000.000003'] },
        },
        batch: {
          attemptedPages: 1,
          completedPages: 1,
          direction: 'older',
          requestedPages: 3,
          stopReason: 'no-progress',
          deduplicatedCount: 0,
        },
      },
    };
    const output = formatOutput(compact);
    expect(output).toContain(
      'Each [TIMESTAMP] is a message reference: use CDEMO1:TIMESTAMP with read-thread, edit or delete.'
    );
    expect(output).toContain(
      [
        '── Yesterday ──',
        'Alex Example',
        '  21:14:48  Message body 1.  [1700000000.000001]',
        ' ~21:15:03  Message body 2.  [1700000000.000002]',
        '',
        'Sam Example',
        '  21:16:00  Message body 3.  [1700000000.000003]',
        '',
        '── Today ──',
        'Sam Example',
        '  09:00:00  Message body 4.  [1700000000.000004]',
        '',
        'Sam Example (inferred)',
        '  09:01:00  Message body 5.  [1700000000.000005]',
      ].join('\n')
    );
    // An author inferred from the group's own first row keeps a ~ marker instead of a new heading.
    expect(output).not.toContain('Alex Example (inferred)');
    expect(output).toContain(
      'A ~ before the time marks a message whose author Slack did not show; it is inferred from an earlier message in the same group.'
    );
    expect(output).not.toContain('https://demo.slack.com');
    expect(output).toContain('Older: read-channel project-help --before=CDEMO1:1700000000.000001');
    // The read started at the newest messages, so a Newer hint would only revisit them.
    expect(output).not.toContain('Newer:');
    compact.pagination.cursor = 'CDEMO1:1700000000.000009';
    expect(formatOutput(compact)).toContain('Newer: read-channel project-help --after=');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.messages[0].permalink).toBe('https://demo.slack.com/archives/CDEMO1/p1700000000000001');
  });

  test('shows the first ten search snippets including inspect of a search page', () => {
    const compact = {
      ...base(),
      operation: 'inspect',
      search: { query: 'test query', totalResults: 123, page: 2, pageCount: 7 },
      messages: messages(12).map((item) => ({ ...item, channel: 'project-help', snippet: true })),
    };
    const output = formatOutput(compact);
    expect(output).toContain('Search: test query');
    expect(output).toContain('123 results · page 2 of 7');
    expect(output).toContain('Showing first 10 of 12 captured messages; 2 omitted.');
    expect(output).toContain('Message body 1.');
    expect(output).not.toContain('Message body 11.');
    expect(output).toContain('· #project-help');
    expect(output).toContain('Showing search snippets');
    compact.messages[0].channel = 'Thread in project-help';
    expect(formatOutput(compact)).toContain('· Thread in project-help');
    expect(formatOutput(compact)).not.toContain('#Thread in');
  });

  test('caps each message at 500 Unicode code points and reports shortened messages', () => {
    const compact = base();
    compact.messages = [{ ...message(1), text: '🙂'.repeat(700) }];
    const output = formatOutput(compact);
    const body = output
      .split('\n')
      .find((line) => line.startsWith('  10:01  🙂'))
      .slice('  10:01  '.length);
    expect(Array.from(body)).toHaveLength(500);
    expect(body.endsWith('…')).toBe(true);
    expect(body).not.toContain('\ufffd');
    expect(output).toContain('1 message shortened to 500 characters.');
    expect(output).toContain('--format=json');
  });

  test('sanitizes ANSI, terminal controls and directional overrides in all human fields', () => {
    const compact = base();
    compact.workspace.name = '\x1b[2JWorkspace\u202e';
    compact.messages = [
      {
        ...message(1),
        author: '\x1b[31mName\x1b[0m\nSpoof',
        text: 'Safe \x1b]8;;https://evil.example\x1b\\link\x1b]8;;\x1b\\\x07\b\rNext\u2066line\u2069',
        permalink: 'https://example.com/\nInjected',
      },
    ];
    const output = formatOutput(compact);
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    expect(output).toContain('Name Spoof');
    expect(output).toContain('Safe link');
    expect(output).not.toContain('evil.example');
    expect(output).not.toContain('Injected');
  });

  test('handles missing metadata, attachment-only messages and empty search results', () => {
    const compact = {
      ...base(),
      operation: 'read-dm',
      conversation: { kind: 'dm', name: 'Alex Example' },
      messages: [
        { author: null, displayedTime: null, text: null, attachments: [{ label: 'file.txt' }] },
      ],
    };
    const output = formatOutput(compact);
    expect(output).toContain('Author not exposed\n  Time not exposed  [No text exposed');
    expect(output).toContain('No text exposed; 1 attachment captured');
    const empty = formatOutput({
      operation: 'search',
      search: { query: 'nothing', totalResults: 0, page: null },
      messages: [],
    });
    expect(empty).toContain('0 results');
    expect(empty).toContain('No results.');
    expect(empty).not.toContain('undefined');
  });

  test('renders inspect query state as unsubmitted with bounded suggestions', () => {
    const output = formatOutput({
      operation: 'inspect',
      view: { title: 'Example Slack view', url: 'https://app.slack.com/client/TDEMO/search' },
      query: {
        value: 'alex',
        suggestions: Array.from({ length: 12 }, (_, index) => ({
          label: `Alex ${index}`,
          handle: `@alex${index}`,
        })),
      },
    });
    expect(output).toContain('Slack view: Example Slack view');
    expect(output).toContain('Search box: alex (not submitted).');
    expect(output).toContain('Alex 0 (@alex0)');
    expect(output).not.toContain('Alex 10');
    expect(output).toContain('Showing 10 of 12 captured suggestions');
  });

  test('keeps unsupported-view warnings while avoiding duplicate search coverage notes', () => {
    const unsupported = formatOutput({
      operation: 'inspect',
      view: { title: 'Example view' },
      coverage: {
        warnings: [
          'This view has no supported message list. Use --format=full-json for diagnostics.',
        ],
      },
    });
    expect(unsupported).toContain('Note: This view has no supported message list.');
    expect(unsupported).toContain('--format=full-json');
    const search = formatOutput({
      operation: 'search',
      search: { query: 'example' },
      messages: messages(1),
      coverage: {
        warnings: [
          'Search results are snippets; full messages and thread replies were not read.',
          'One result lacked readable text.',
        ],
      },
    });
    expect(search).toContain('Showing search snippets');
    expect(search).not.toContain('Note: Search results are snippets');
    expect(search).toContain('Note: One result lacked readable text.');
  });

  test('keeps permission setup and stopped-state remedies useful', () => {
    const permission = formatOutput({
      status: 'permission-required',
      accessibilityTrusted: false,
      postEventAccess: false,
      promptRequested: false,
      settingsOpenRequested: false,
      next: 'Run permissions --request, then check access again.',
      executable: '/tmp/example-helper',
    });
    expect(permission).toContain('Slack permissions: required in this execution context.');
    expect(permission).toContain(
      'Accessibility: unavailable here. Keyboard input: unavailable here.'
    );
    expect(permission).toContain('Next: Run permissions --request');
    expect(permission).toContain('/tmp/example-helper');
    const stopped = formatOutput({
      status: 'stopped',
      error: '\x1b[31mSelection changed\x1b[0m',
      next: 'Inspect before retrying.',
      desktopSamples: [{ foregroundPid: 31415 }],
    });
    expect(stopped).toBe('Stopped: Selection changed\nNext: Inspect before retrying.');
  });

  test('missing trust with an unattempted AX probe reports context-scoped permission refusal', () => {
    const receipt = {
      operation: 'permissions',
      status: 'permission-required',
      permissionScope: 'current-execution-context',
      accessibilityTrusted: false,
      postEventAccess: false,
      accessibilityProbe: {
        status: 'not-checked',
        reason: 'accessibility-trust-missing',
        checkedAttributes: [],
      },
      promptRequested: false,
      settingsOpenRequested: false,
      next: 'Verify approved host execution, then rerun read-only permissions.',
    };
    const text = formatOutput(receipt);
    expect(text).toContain('Slack permissions: required in this execution context.');
    expect(text).toContain('Accessibility: unavailable here. Keyboard input: unavailable here.');
    expect(text).toContain('Slack AX: not checked.');
    expect(text).not.toContain('Slack permissions: unavailable.');
    expect(text).not.toContain('setup required');
    expect(text).not.toContain('Permission prompt requested');
    expect(text).not.toContain('System Settings opening requested');
    expect(JSON.parse(formatOutput(receipt, 'json'))).toMatchObject({
      status: 'permission-required',
      permissionScope: 'current-execution-context',
      accessibilityTrusted: false,
      postEventAccess: false,
      accessibilityProbe: receipt.accessibilityProbe,
    });
    expect(JSON.parse(formatOutput(receipt, 'full-json', receipt))).toEqual(receipt);
  });

  test('permission text and JSON retain failed AX access despite trusted flags', () => {
    for (const postEventAccess of [true, false]) {
      const receipt = {
        operation: 'permissions',
        status: 'permission-required',
        accessibilityTrusted: true,
        postEventAccess,
        accessibilityProbe: {
          status: 'api-disabled',
          checkedAttributes: ['AXRole'],
          pid: 123,
          error: { code: -25211, name: 'apiDisabled', operation: 'AXRole' },
        },
        error: 'Slack AX API is disabled.',
        next: 'Check host access.',
      };
      const text = formatOutput(receipt);
      expect(text).toContain('Slack permissions: required in this execution context.');
      expect(text).toContain('Slack AX: API disabled (-25211).');
      expect(text).toContain('Stopped: Slack AX API is disabled.');
      expect(text).toContain('Next: Check host access.');
      expect(text).not.toContain('permissions: ready');
      expect(text).not.toContain('inspection only');
      const semantic = JSON.parse(formatOutput(receipt, 'json'));
      expect(semantic.accessibilityProbe).toEqual({
        status: 'api-disabled',
        checkedAttributes: ['AXRole'],
        error: { code: -25211, name: 'apiDisabled', operation: 'AXRole' },
      });
      expect(semantic.status).toBe('permission-required');
      expect(JSON.parse(formatOutput(receipt, 'full-json', receipt))).toEqual(receipt);
    }
  });

  test('permission rendering distinguishes accessible, inspection-only and unavailable states', () => {
    const common = {
      operation: 'permissions',
      accessibilityTrusted: true,
      postEventAccess: true,
      accessibilityProbe: { status: 'accessible', checkedAttributes: ['AXRole', 'AXChildren'] },
    };
    expect(formatOutput({ ...common, status: 'ready' })).toContain('Slack permissions: ready.');
    expect(
      formatOutput({ ...common, status: 'inspection-only', postEventAccess: false })
    ).toContain('Slack permissions: inspection only.');
    for (const probeStatus of ['unavailable', 'not-running', 'ambiguous', 'not-checked']) {
      const text = formatOutput({
        ...common,
        status: 'unavailable',
        accessibilityProbe: { status: probeStatus },
        error: 'Target access unavailable.',
        next: 'Inspect Slack state.',
      });
      expect(text).toContain('Slack permissions: unavailable.');
      expect(text).toContain('Stopped: Target access unavailable.');
      expect(text).toContain('Next: Inspect Slack state.');
      expect(text).not.toContain('permissions: ready');
    }
    for (const status of ['ready', 'inspection-only']) {
      const text = formatOutput({
        ...common,
        status,
        accessibilityProbe: { status: 'api-disabled' },
      });
      expect(text).toContain('Slack permissions: required in this execution context.');
      expect(text).not.toContain('permissions: ready');
      expect(text).not.toContain('inspection only');
    }
  });

  test('ordinary stopped output includes short AX diagnostics without dumping the tree', () => {
    const compact = {
      operation: 'channels',
      status: 'stopped',
      error: 'AX unavailable.',
      accessStatus: 'unavailable',
      accessibilityProbe: {
        status: 'unavailable',
        pid: 321,
        checkedAttributes: ['AXChildren'],
        error: { code: -25204, name: 'cannotComplete', operation: 'AXChildren' },
      },
      next: 'Inspect Slack state.',
    };
    expect(formatOutput(compact)).toBe(
      'Stopped: AX unavailable.\nSlack AX: unavailable (-25204).\nNext: Inspect Slack state.'
    );
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.accessStatus).toBe('unavailable');
    expect(json.accessibilityProbe.error.code).toBe(-25204);
    expect(json.accessibilityProbe.pid).toBeUndefined();
  });
});

describe('thread output', () => {
  test('provides channel navigation commands using only validated arguments', () => {
    const output = formatOutput({
      ...base(),
      operation: 'channels',
      channels: [
        { name: 'team-updates', unread: true },
        { name: '-literal' },
        { name: 'café' },
        { name: 'bad;command' },
        { name: 'quoted\u0027name' },
        { name: 'bad\nname' },
      ],
    });
    expect(output).toContain('#team-updates (unread) · read-channel team-updates');
    expect(output).toContain('#-literal · read-channel -- -literal');
    expect(output).toContain('#café · read-channel café');
    expect(output).not.toContain('read-channel bad');
    expect(output).not.toContain('read-channel quoted');
    expect(output).not.toContain('read-channel bad name');
    expect(parseCLI(['read-channel', '--', '-literal']).args).toEqual(['read-channel', '-literal']);
  });

  test('exposes short thread drill-down references on channel messages and search snippets', () => {
    const reference = 'CDEMO:1700000000.000001';
    for (const operation of ['read-channel', 'search']) {
      const compact = {
        ...base(),
        operation,
        messages: [
          { ...message(1), text: '🙂'.repeat(700), thread: { replyCount: 2, ref: reference } },
        ],
      };
      if (operation === 'search') compact.search = { query: 'example' };
      const output = formatOutput(compact);
      expect(output).toContain(`2 replies · read-thread ${reference}`);
      expect(output).toContain('1 message shortened to 500 characters.');
      expect(output).toContain(compact.messages[0].permalink);
      expect(JSON.parse(formatOutput(compact, 'json')).messages[0].thread.ref).toBe(reference);
      compact.messages[0].thread.replyCount = null;
      expect(formatOutput(compact)).toContain(`Thread · read-thread ${reference}`);
      compact.messages[0].thread.replyCount = 1;
      expect(formatOutput(compact)).toContain(`1 reply · read-thread ${reference}`);
    }
  });

  test('omits drill-down hints for absent or zero-reply references and rejects control text', () => {
    const compact = base();
    compact.messages = [{ ...message(1), thread: { replyCount: 3 } }];
    expect(formatOutput(compact)).not.toContain('read-thread');
    compact.messages[0].thread = { replyCount: 0, ref: 'CDEMO:1700000000.000001' };
    expect(formatOutput(compact)).not.toContain('read-thread');
    for (const ref of [
      'CDEMO:1700000000.000001\nInjected',
      '\x1b[31mCDEMO:1700000000.000001',
      'CDEMO:1700000000.000001; anything',
      'CDEMO:bad',
      'CDEMO:170000000.000001',
      'CDEMO:17000000000.000001',
    ]) {
      compact.messages[0].thread = { replyCount: 2, ref };
      const output = formatOutput(compact);
      expect(output).not.toContain('read-thread');
      expect(output).not.toContain('Injected');
      expect(output).not.toContain('\x1b');
    }
  });

  test('keeps one stable thread reference without repeating drill-down hints on root and replies', () => {
    const compact = threadResult(1);
    const reference = 'CDEMO:1700000000.000000';
    compact.thread.ref = reference;
    compact.thread.root.thread = { replyCount: 1, ref: reference };
    compact.thread.replies[0].thread = { replyCount: null, ref: reference };
    const output = formatOutput(compact);
    expect(output).toContain(`Reference: ${reference}`);
    expect(output).toContain('Back to channel: read-channel project-help');
    expect(output.match(new RegExp(reference.replace('.', '\\.'), 'g'))).toHaveLength(1);
    expect(output).not.toContain('read-thread');
    expect(JSON.parse(formatOutput(compact, 'json')).thread.ref).toBe(reference);
    compact.conversation.kind = null;
    expect(formatOutput(compact)).not.toContain('Back to channel:');
    compact.conversation = { kind: 'channel', name: 'bad;command' };
    expect(formatOutput(compact)).not.toContain('Back to channel:');
  });

  test('always shows the root separately while capping only the displayed replies', () => {
    const compact = threadResult(12);
    const output = formatOutput(compact);
    expect(output).toContain('Thread in #project-help — Example Workspace');
    expect(output).toContain('Root message\nPerson 0');
    expect(output.match(/Distinct root message\./g)).toHaveLength(1);
    expect(output).toContain(compact.thread.rootPermalink);
    expect(output).toContain('12 captured replies; Slack shows 12 replies.');
    expect(output).toContain('Showing last 10 of 12 captured replies; 2 omitted.');
    expect(output).not.toContain('Message body 1.');
    expect(output).not.toContain('Message body 2.');
    expect(output).toContain('Message body 3.');
    expect(output).toContain('Message body 12.');
    expect(output).toContain('--format=json');
    expect(output).toContain('More replies may be outside this view');
    expect(output).not.toContain('thread replies and attachment contents are not included');
    expect(output).not.toContain('31415');
    expect(compact.thread.replies).toHaveLength(12);
  });

  test('keeps the observed root link when virtualization leaves only replies in the view', () => {
    const compact = threadResult(14);
    compact.thread.root = null;
    compact.thread.ref = 'CDEMO:1700000000.000000';
    compact.coverage.warnings = [
      'Root message is outside this view.',
      'Unexposed replies and attachment contents were not read; missing metadata remains null',
    ];
    const output = formatOutput(compact);
    expect(output).toContain('Root message\nRoot message is outside this view.');
    expect(output.match(/Root message is outside this view\./g)).toHaveLength(1);
    expect(output).toContain(compact.thread.rootPermalink);
    expect(output).toContain('Reference: CDEMO:1700000000.000000');
    expect(output).toContain('Back to channel: read-channel project-help');
    expect(output).toContain('14 captured replies; Slack shows 14 replies.');
    expect(output).toContain('Showing last 10 of 14 captured replies; 4 omitted.');
    expect(output).not.toContain('Message body 4.');
    expect(output).toContain('Message body 5.');
    expect(output).toContain('Message body 14.');
    expect(output).not.toContain('Author not exposed');
    expect(output).not.toContain('[No text exposed]');
    expect(output).toContain('--format=json');
    const parsed = JSON.parse(formatOutput(compact, 'json'));
    expect(parsed.thread.root).toBeNull();
    expect(parsed.thread.replies).toHaveLength(14);
    expect(parsed.thread.rootPermalink).toBe(compact.thread.rootPermalink);
    expect(parsed.coverage.complete).toBe(false);
    expect(parsed.coverage.warnings).toContain('Root message is outside this view.');
    expect(() =>
      formatOutput({ ...compact, thread: { ...compact.thread, rootPermalink: null } })
    ).toThrow('Thread root permalink is unavailable');
  });

  test('caps root and reply text at 500 Unicode code points with one truncation note', () => {
    const compact = threadResult(1);
    compact.thread.root.text = '🙂'.repeat(650);
    compact.thread.replies[0].text = '🦊'.repeat(650);
    const output = formatOutput(compact);
    const bodies = output.split('\n').filter((line) => /^  [🙂🦊]/u.test(line));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(Array.from(body.slice(2))).toHaveLength(500);
      expect(body.endsWith('…')).toBe(true);
      expect(body).not.toContain('\ufffd');
    }
    expect(output).toContain('2 messages shortened to 500 characters.');
    expect(output.match(/Use --format=json/g)).toHaveLength(1);
    expect(output).toContain('1 captured reply; Slack shows 1 reply.');
  });

  test('omits a duplicate reply-count note from text while retaining JSON and distinct warnings', () => {
    const compact = threadResult(2);
    compact.thread.displayedReplyCount = 6;
    const countWarning = '2 of 6 displayed thread replies are exposed';
    compact.coverage.warnings = [countWarning, 'One reply contains an unloaded attachment.'];
    const output = formatOutput(compact);
    expect(output).toContain('2 captured replies; Slack shows 6 replies.');
    expect(output).toContain('More replies may be outside this view.');
    expect(output).not.toContain(countWarning);
    expect(output).toContain('Note: One reply contains an unloaded attachment.');
    expect(JSON.parse(formatOutput(compact, 'json')).coverage.warnings).toEqual(
      compact.coverage.warnings
    );
    compact.thread.displayedReplyCount = null;
    expect(formatOutput(compact)).toContain(`Note: ${countWarning}`);
  });

  test('preserves unknown total and does not infer zero replies from an empty capture', () => {
    const compact = threadResult(0);
    compact.thread.displayedReplyCount = null;
    const unknown = formatOutput(compact);
    expect(unknown).toContain('No replies were exposed; total reply count not exposed.');
    expect(unknown).not.toContain('0 replies');
    expect(unknown).not.toContain('No replies.');
    expect(unknown).toContain('More replies may be outside this view');
    compact.thread.displayedReplyCount = 4;
    expect(formatOutput(compact)).toContain('No replies were exposed; Slack shows 4 replies.');
    compact.thread.displayedReplyCount = 0;
    expect(formatOutput(compact)).toContain('Slack shows 0 replies.');
  });

  test('sanitizes thread fields and preserves missing author and attachment evidence', () => {
    const compact = threadResult(1);
    compact.conversation = { kind: null, name: '\x1b[2JPerson\u202e' };
    compact.thread.root = {
      author: null,
      displayedTime: null,
      text: 'Root\x1b[31m text\x1b[0m',
      permalink: null,
    };
    compact.thread.replies[0] = {
      author: '\x1b[32mAlex\x1b[0m',
      text: null,
      attachments: [{ label: 'note.txt' }],
      permalink: 'https://example.com/\nInjected',
    };
    const output = formatOutput(compact);
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    expect(output).toContain('Thread in Person');
    expect(output).not.toContain('#Person');
    expect(output).toContain('Author not exposed · Time not exposed');
    expect(output).toContain('Root text');
    expect(output).toContain(compact.thread.rootPermalink);
    expect(output).toContain('No text exposed; 1 attachment captured');
    expect(output).not.toContain('Injected');
    expect(() =>
      formatOutput({ ...compact, thread: { ...compact.thread, root: undefined } })
    ).toThrow('Thread root message is unavailable');
  });

  test('keeps the complete root and every captured reply in JSON without diagnostic fields', () => {
    const compact = threadResult(12);
    compact.thread.root.text = '\x1b[31mOriginal root\x1b[0m';
    compact.thread.replies[0].text = '🙂'.repeat(650);
    compact.thread.desktop = { samples: [{ foregroundPid: 31415 }] };
    compact.navigation = { actions: [{ command: 'read-channel', args: ['project-help'] }] };
    const parsed = JSON.parse(formatOutput(compact, 'json'));
    expect(parsed.thread.replies).toHaveLength(12);
    expect(parsed.thread.root.text).toBe(compact.thread.root.text);
    expect(parsed.thread.replies[0].text).toBe(compact.thread.replies[0].text);
    expect(parsed.thread.requestedMessageTS).toBe('1700000000.000000');
    expect(parsed.thread.displayedReplyCount).toBe(12);
    expect(parsed.coverage.complete).toBe(false);
    expect(parsed.coverage.threadRepliesIncluded).toBe(true);
    expect(parsed).not.toHaveProperty('desktop');
    expect(parsed.thread).not.toHaveProperty('desktop');
    expect(parsed.navigation).toEqual(compact.navigation);
    const receipt = {
      ...compact,
      content: { nodes: [{ role: 'AXGroup', label: 'thread diagnostic' }] },
    };
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
  });
});

describe('JSON formats', () => {
  test('retains all captured semantic records and errors without raw trees or desktop evidence', () => {
    const compact = {
      ...base(),
      messages: messages(12),
      error: { message: 'Example error', code: 'EXAMPLE' },
      next: 'Inspect.',
      content: { nodes: [{ role: 'AXGroup', label: 'raw content' }] },
      before: { title: 'previous' },
      after: { title: 'next' },
    };
    const parsed = JSON.parse(formatOutput(compact, 'json'));
    expect(parsed.messages).toHaveLength(12);
    expect(parsed.error).toEqual({ message: 'Example error', code: 'EXAMPLE' });
    expect(parsed.next).toBe('Inspect.');
    expect(parsed).not.toHaveProperty('desktop');
    expect(parsed).not.toHaveProperty('content');
    expect(parsed).not.toHaveProperty('before');
    expect(parsed).not.toHaveProperty('after');
    expect(compact.desktop.samples[0].foregroundPid).toBe(31415);
  });

  test('preserves the complete supplied receipt and its strings in full-json', () => {
    const compact = base();
    const receipt = {
      ...compact,
      content: {
        nodes: [
          {
            role: 'AXStaticText',
            label: '\x1b[31mOriginal\x1b[0m',
            classes: ['example'],
            depth: 3,
          },
        ],
      },
      result: compact,
      customField: { retain: true },
    };
    const before = JSON.stringify(receipt);
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
    expect(JSON.stringify(receipt)).toBe(before);
  });

  test('does not silently substitute compact data when the full receipt is missing', () => {
    expect(() => formatOutput(base(), 'full-json')).toThrow('receipt is unavailable');
    expect(() => formatOutput(base(), 'yaml')).toThrow('Unknown output format');
  });
});

describe('emoji search translation output', () => {
  const translation = () => normalizeSearchQuery('in:project-help "🙂👍🏽🙂"');
  const translatedSearch = () => {
    const proof = translation();
    return {
      ...base(),
      operation: 'search',
      status: 'ok',
      requested: proof.submittedQuery,
      conversation: undefined,
      search: { query: proof.submittedQuery, totalResults: 2, page: 1, pageCount: 1 },
      searchTranslation: proof,
      messages: messages(2).map((item) => ({ ...item, snippet: true, channel: 'project-help' })),
      content: { nodes: [{ role: 'AXStaticText', label: 'RAW_TREE_MUST_NOT_REACH_TEXT' }] },
    };
  };

  test('concise search text distinguishes requested emoji from the verified submitted query', () => {
    const compact = translatedSearch();
    const before = JSON.stringify(compact);
    const output = formatOutput(compact);
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Message body 2.');
    expect(output).toContain(
      'Emoji query: ' +
        compact.searchTranslation.requestedQuery +
        ' → ' +
        compact.searchTranslation.submittedQuery
    );
    expect(output.match(/Emoji query:/g)).toHaveLength(1);
    for (const hidden of [
      'RAW_TREE_MUST_NOT_REACH_TEXT',
      'AXStaticText',
      '"substitutions"',
      '31415',
      'Foreground interaction requested',
    ])
      expect(output).not.toContain(hidden);
    expect(JSON.stringify(compact)).toBe(before);
  });

  test('semantic JSON retains complete ordered substitution proof and canonical search identity', () => {
    const compact = translatedSearch();
    compact.searchTranslation = normalizeSearchQuery('🙂'.repeat(20));
    compact.requested = compact.searchTranslation.submittedQuery;
    compact.search.query = compact.searchTranslation.submittedQuery;
    const before = JSON.stringify(compact);
    const result = JSON.parse(formatOutput(compact, 'json'));
    expect(result.searchTranslation).toEqual(compact.searchTranslation);
    expect(result.searchTranslation.substitutions).toHaveLength(20);
    expect(result.requested).toBe(compact.searchTranslation.submittedQuery);
    expect(result.search.query).toBe(compact.searchTranslation.submittedQuery);
    expect(result.messages).toEqual(compact.messages);
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('desktop');
    expect(JSON.stringify(compact)).toBe(before);
  });

  test('full JSON retains native failure, translation proof and raw diagnostics losslessly', () => {
    const compact = {
      operation: 'search',
      status: 'stopped',
      error: 'Selection changed; Return withheld',
      next: 'Inspect before retrying.',
      searchTranslation: translation(),
    };
    const receipt = {
      ...compact,
      result: compact,
      native: {
        status: 'stopped',
        phase: 'before-submit',
        error: compact.error,
        content: { nodes: [{ role: 'AXStaticText', label: '\x1b[31mraw diagnostic\x1b[0m' }] },
      },
      verification: { submissionAttempted: false, sourceMatched: null },
      desktop: { foregroundPid: 31415, samples: [{ cursor: [100, 200] }] },
    };
    const before = JSON.stringify(receipt);
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
    expect(JSON.stringify(receipt)).toBe(before);
    expect(JSON.parse(formatOutput(compact, 'json')).searchTranslation).toEqual(translation());
  });

  test('a stopped translation note describes mapping without implying search success', () => {
    const compact = {
      operation: 'search',
      status: 'stopped',
      error: 'Exact destination changed; Return withheld',
      next: 'Inspect before retrying.',
      searchTranslation: translation(),
    };
    const output = formatOutput(compact);
    expect(output).toStartWith('Stopped: Exact destination changed; Return withheld');
    expect(output).toContain('Next: Inspect before retrying.');
    expect(output).toContain('Emoji query:');
    expect(output.indexOf('Emoji query:')).toBeGreaterThan(output.indexOf('Next:'));
    expect(output).not.toMatch(/success|verified search|matches across|Message body/i);
    const result = JSON.parse(formatOutput(compact, 'json'));
    expect(result.status).toBe('stopped');
    expect(result.error).toBe(compact.error);
    expect(result.searchTranslation).toEqual(compact.searchTranslation);
    expect(result).not.toHaveProperty('messages');
  });

  test('partial search preserves verified records, pagination and refusal with the translation note', () => {
    const compact = {
      ...translatedSearch(),
      status: 'partial',
      error: 'Search query changed after the first page',
      next: 'Inspect before retrying.',
      pagination: {
        supported: true,
        status: 'partial',
        hasMore: null,
        nextCursor: null,
        batch: {
          requestedPages: 3,
          attemptedPages: 2,
          completedPages: 1,
          stopReason: 'error',
          direction: 'next',
          deduplicatedCount: 0,
        },
      },
    };
    const output = formatOutput(compact);
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Stopped: Search query changed after the first page');
    expect(output).toContain('Next: Inspect before retrying.');
    expect(output).toContain('Emoji query:');
    expect(output).not.toContain('RAW_TREE_MUST_NOT_REACH_TEXT');
    expect(output).not.toMatch(/search succeeded|all results|requested 3-page limit/i);
    const result = JSON.parse(formatOutput(compact, 'json'));
    expect(result.status).toBe('partial');
    expect(result.messages).toEqual(compact.messages);
    expect(result.pagination).toEqual(compact.pagination);
    expect(result.searchTranslation).toEqual(compact.searchTranslation);
  });

  test('formatter bounds oversized diagnostic metadata without truncating JSON', () => {
    const proof = {
      requestedQuery: '🙂'.repeat(200) + 'REQUEST_END',
      submittedQuery: ':slightly_smiling_face:'.repeat(40) + 'SUBMITTED_END',
      substitutions: [{ unicode: '🙂', shortcode: ':slightly_smiling_face:' }],
    };
    const compact = {
      operation: 'search',
      status: 'stopped',
      error: 'Canonical query exceeds the supported input bound; no input posted',
      searchTranslation: proof,
    };
    const note = formatOutput(compact)
      .split('\n')
      .find((line) => line.startsWith('Emoji query: '));
    const parts = note.match(/^Emoji query: (.+) → (.+)$/u);
    expect(parts).not.toBeNull();
    expect(Array.from(parts[1])).toHaveLength(160);
    expect(Array.from(parts[2])).toHaveLength(200);
    expect(parts[1]).toBe('🙂'.repeat(159) + '…');
    expect(parts[2]).toEndWith('…');
    expect(note).not.toContain('REQUEST_END');
    expect(note).not.toContain('SUBMITTED_END');
    expect(note).not.toContain('\uFFFD');
    expect(JSON.parse(formatOutput(compact, 'json')).searchTranslation).toEqual(proof);
  });

  test('translation text sanitizes controls while semantic proof stays exact', () => {
    const compact = {
      operation: 'search',
      status: 'stopped',
      error: 'Input withheld',
      searchTranslation: {
        requestedQuery: '\x1b[31m🙂\x1b[0m\nsecond\u202e',
        submittedQuery: ':slightly_smiling_face:\r\nsecond\x1b]0;terminal-title\x07',
        substitutions: [{ unicode: '🙂', shortcode: ':slightly_smiling_face:' }],
      },
    };
    const output = formatOutput(compact);
    expect(output).toContain('Emoji query: 🙂 second → :slightly_smiling_face: second');
    for (const hidden of ['\x1b', '\u202e', 'terminal-title']) expect(output).not.toContain(hidden);
    expect(output.split('\n').filter((line) => line.startsWith('Emoji query:'))).toHaveLength(1);
    expect(JSON.parse(formatOutput(compact, 'json')).searchTranslation).toEqual(
      compact.searchTranslation
    );
  });

  test('foreground notice and translation remain distinct on success and failure', () => {
    for (const status of ['ok', 'stopped']) {
      const compact = {
        ...translatedSearch(),
        status,
        ...(status === 'stopped' ? { error: 'Window ownership changed; input withheld' } : {}),
      };
      const receipt = {
        interaction: {
          mode: 'foreground',
          activationRequested: true,
          activated: true,
          ownershipLost: status === 'stopped',
          foregroundBefore: 123,
        },
      };
      const output = formatOutput(compact, 'text', receipt);
      expect(output).toContain('Emoji query:');
      expect(output).toEndWith('Foreground interaction requested; no automatic retry.');
      if (status === 'stopped') expect(output).toContain('Stopped: Window ownership changed');
      const result = JSON.parse(formatOutput(compact, 'json', receipt));
      expect(result.searchTranslation).toEqual(compact.searchTranslation);
      expect(result.interaction).toEqual({
        mode: 'foreground',
        activationRequested: true,
        activated: true,
        ownershipLost: status === 'stopped',
      });
    }
  });

  test('ordinary results and failures have no annotation or invented translation proof', () => {
    const compact = translatedSearch();
    delete compact.searchTranslation;
    for (const result of [
      compact,
      { operation: 'search', status: 'stopped', error: 'Input withheld' },
    ]) {
      expect(formatOutput(result)).not.toContain('Emoji query:');
      expect(JSON.parse(formatOutput(result, 'json'))).not.toHaveProperty('searchTranslation');
    }
  });
});

describe('pagination options and text', () => {
  const cursor = 'CDEMO:1700000000.000001';
  const page = (command, target, direction = 'older') => ({
    supported: true,
    direction: null,
    status: 'initial',
    hasMore: null,
    [direction]: {
      cursor,
      navigation: {
        command,
        args: [target, `--${direction === 'older' ? 'before' : 'after'}=${cursor}`],
      },
    },
  });

  test('parses one page option independently of output format and command position', () => {
    for (const operation of ['read-channel', 'read-dm', 'read-thread']) {
      for (const [option, direction] of [
        ['before', 'older'],
        ['after', 'newer'],
      ]) {
        const result = parseCLI([`--${option}=${cursor}`, operation, 'target', '--format=json']);
        expect(result).toEqual({
          args: [operation, 'target'],
          interaction: 'background',
          format: 'json',
          page: { direction, cursor },
          ...(operation === 'read-channel' ? { pages: 3 } : {}),
        });
      }
    }
    expect(parseCLI(['read-channel', `--before=${cursor}`, '--', '-literal'])).toEqual({
      args: ['read-channel', '-literal'],
      interaction: 'background',
      format: 'text',
      page: { direction: 'older', cursor },
      pages: 3,
    });
    expect(parseCLI(['search', '--', `--before=${cursor}`])).toEqual({
      args: ['search', `--before=${cursor}`],
      interaction: 'background',
      format: 'text',
    });
  });

  test('rejects malformed, duplicate, unsupported and incomplete page options before UI work', () => {
    for (const args of [
      ['read-channel', 'project-help', '--before=bad'],
      ['read-channel', 'project-help', `--before=${cursor}=extra`],
      ['read-channel', 'project-help', `--before=${cursor}\n`],
      ['read-channel', 'project-help', '--before=CDEMO:170000000.000001'],
      ['read-channel', 'project-help', '--before=CDEMO:17000000000.000001'],
      ['read-channel', 'project-help', '--before', cursor],
      ['read-channel', 'project-help', `--before=${cursor}`, `--before=${cursor}`],
      ['read-channel', 'project-help', `--before=${cursor}`, `--after=${cursor}`],
      ['search', 'term', `--before=${cursor}`],
      ['inspect', `--before=${cursor}`],
      ['read-dm', `--before=${cursor}`],
    ]) {
      let failure;
      try {
        parseCLI(['--format=full-json', ...args]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('full-json');
    }
  });

  test('renders every logical page message with short validated continuation commands', () => {
    const compact = {
      ...base(),
      messages: messages(10),
      pagination: page('read-channel', 'project-help'),
    };
    const output = formatOutput(compact);
    expect(output).toContain('10 messages on this page.');
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Message body 10.');
    expect(output).toContain(`Older: read-channel project-help --before=${cursor}`);
    expect(output).not.toContain('omitted');
    expect(output).not.toContain('all captured content');
    expect(output).not.toContain('No scrolling');
    expect(JSON.parse(formatOutput(compact, 'json')).pagination).toEqual(compact.pagination);
    compact.messages.push(message(11));
    expect(() => formatOutput(compact)).toThrow('page exceeds ten messages');
  });

  test('quotes DM names and places page flags before a literal leading-dash target', () => {
    const compact = {
      ...base(),
      operation: 'read-dm',
      pagination: page('read-dm', "Alex O'Neil; $(example)"),
    };
    expect(formatOutput(compact)).toContain(
      `Older: read-dm 'Alex O'\\''Neil; $(example)' --before=${cursor}`
    );
    compact.pagination = page('read-dm', '-literal');
    expect(formatOutput(compact)).toContain(`Older: read-dm --before=${cursor} -- -literal`);
    compact.operation = 'read-channel';
    compact.pagination = page('read-channel', '-literal');
    expect(formatOutput(compact)).toContain(`Older: read-channel --before=${cursor} -- -literal`);
  });

  test('keeps group reads and continuations bound to their observed conversation ID', () => {
    const compact = {
      ...base(),
      operation: 'read-dm',
      conversation: { kind: 'dm', dmKind: 'group', id: 'CDEMO', name: 'Alex, Sam' },
      pagination: page('read-dm', 'group:CDEMO'),
    };
    expect(formatOutput(compact)).toContain('Alex, Sam (group DM) — Example Workspace');
    expect(formatOutput(compact)).toContain(`Older: read-dm group:CDEMO --before=${cursor}`);
    expect(JSON.parse(formatOutput(compact, 'json')).conversation).toEqual(compact.conversation);
    for (const target of ['Alex, Sam', 'group:COTHER', 'group:DDEMO', 'group:CDEMO\n']) {
      compact.pagination = page('read-dm', target);
      expect(formatOutput(compact)).not.toContain('Older:');
    }
    compact.pagination = page('read-dm', 'group:CDEMO');
    for (const conversation of [
      { kind: 'channel', dmKind: 'group', id: 'CDEMO', name: 'Alex, Sam' },
      { kind: 'dm', id: 'CDEMO', name: 'Alex, Sam' },
      { kind: 'dm', dmKind: 'group', id: 'COTHER', name: 'Alex, Sam' },
      { kind: 'dm', dmKind: 'group', name: 'Alex, Sam' },
    ]) {
      compact.conversation = conversation;
      expect(formatOutput(compact)).not.toContain('Older:');
    }
  });

  test('rejects conflicting or malformed continuation actions without repairing their data', () => {
    const compact = { ...base(), pagination: page('read-channel', 'project-help') };
    for (const mutation of [
      (p) => {
        p.older.navigation.command = 'send-message';
      },
      (p) => {
        p.older.navigation.args[0] = 'bad;command';
      },
      (p) => {
        p.older.navigation.args[0] = 'bad\nname';
      },
      (p) => {
        p.older.navigation.args[1] = `--after=${cursor}`;
      },
      (p) => {
        p.older.cursor += '\nInjected';
      },
      (p) => {
        p.older.navigation.args.push('extra');
      },
    ]) {
      compact.pagination = page('read-channel', 'project-help');
      mutation(compact.pagination);
      expect(formatOutput(compact)).not.toContain('Older:');
    }
    compact.pagination = page('read-channel', 'project-help');
    compact.conversation.id = 'COTHER';
    expect(formatOutput(compact)).not.toContain('Older:');
  });

  test('shows forward thread pages from their first reply and retains root/back navigation', () => {
    const compact = threadResult(10);
    compact.thread.ref = 'CDEMO:1700000000.000000';
    compact.pagination = page('read-thread', compact.thread.ref, 'newer');
    compact.pagination.direction = 'newer';
    compact.pagination.status = 'advanced';
    compact.thread.displayedReplyCount = 24;
    const output = formatOutput(compact);
    expect(output).toContain('10 replies on this page; Slack shows 24 replies.');
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Message body 10.');
    expect(output).toContain('Distinct root message.');
    expect(output).toContain('Back to channel: read-channel project-help');
    expect(output).toContain(`More replies: read-thread ${compact.thread.ref} --after=${cursor}`);
    expect(output).not.toContain('Showing last');
    compact.thread.replies.push(message(11));
    expect(() => formatOutput(compact)).toThrow('page exceeds ten replies');
  });

  test('no-progress output preserves uncertainty and withholds the same-direction retry', () => {
    const compact = { ...base(), messages: [], pagination: page('read-channel', 'project-help') };
    compact.pagination.status = 'no-progress';
    compact.pagination.direction = 'older';
    const warning =
      'No additional messages were verified in this direction; the end of history is unknown.';
    compact.coverage.warnings = [warning, 'One attachment is unavailable.'];
    const output = formatOutput(compact);
    expect(output).toContain('No additional messages were exposed; history may continue.');
    expect(output).not.toContain('Older:');
    expect(output).not.toContain('Showing last');
    expect(output).not.toContain('0 messages');
    expect(output).not.toMatch(/end of history|all history|complete history/i);
    expect(output).toContain('Note: One attachment is unavailable.');
    expect(JSON.parse(formatOutput(compact, 'json')).coverage.warnings).toContain(warning);
    compact.pagination.status = 'advanced';
    expect(formatOutput(compact)).toContain(`Note: ${warning}`);
    const thread = threadResult(0);
    thread.thread.ref = 'CDEMO:1700000000.000000';
    thread.pagination = {
      ...page('read-thread', thread.thread.ref, 'newer'),
      status: 'no-progress',
      direction: 'newer',
    };
    expect(formatOutput(thread)).toContain(
      'No additional replies were exposed; history may continue.'
    );
    expect(formatOutput(thread)).not.toContain('More replies:');
  });

  test('keeps paginated thread exposure counts in JSON without duplicating text page summaries', () => {
    for (const [returned, captured, total] of [
      [0, 2, 6],
      [10, 14, 24],
    ]) {
      const compact = threadResult(returned);
      compact.thread.ref = 'CDEMO:1700000000.000000';
      compact.thread.displayedReplyCount = total;
      compact.thread.capturedReplyCount = captured;
      compact.pagination = {
        ...page('read-thread', compact.thread.ref, 'newer'),
        status: returned ? 'advanced' : 'no-progress',
        direction: 'newer',
      };
      const warning = `${captured} of ${total} displayed thread replies are exposed`;
      compact.coverage.warnings = [warning, 'One attachment is unavailable.'];
      const output = formatOutput(compact);
      expect(output).not.toContain(warning);
      expect(output).toContain(`Slack shows ${total} replies.`);
      expect(output).toContain('Note: One attachment is unavailable.');
      expect(JSON.parse(formatOutput(compact, 'json')).coverage.warnings).toContain(warning);
    }
  });

  test('shortened page content points to full text on this page rather than omitted history', () => {
    const compact = {
      ...base(),
      messages: [{ ...message(1), text: 'x'.repeat(600) }],
      pagination: page('read-channel', 'project-help'),
    };
    expect(formatOutput(compact)).toContain('Use --format=json for full text on this page.');
    expect(formatOutput(compact)).not.toContain('all captured content');
    const thread = threadResult(1);
    thread.thread.ref = 'CDEMO:1700000000.000000';
    thread.pagination = page('read-thread', thread.thread.ref, 'newer');
    thread.thread.replies[0].text = 'x'.repeat(600);
    expect(formatOutput(thread)).toContain('1 reply on this page');
    expect(formatOutput(thread)).toContain('Use --format=json for full text on this page.');
  });
});

describe('multi-page options and text', () => {
  const cursor = 'CDEMO:1700000000.000001';
  const batch = (overrides = {}) => ({
    requestedPages: 3,
    attemptedPages: 3,
    completedPages: 3,
    direction: 'older',
    stopReason: 'page-limit',
    deduplicatedCount: 0,
    ...overrides,
  });
  const page = (overrides = {}) => ({
    supported: true,
    direction: 'older',
    status: 'advanced',
    hasMore: null,
    older: {
      cursor,
      navigation: { command: 'read-channel', args: ['project-help', `--before=${cursor}`] },
    },
    batch: batch(),
    ...overrides,
  });

  test('parses a bounded page count on reads while preserving defaults and literal arguments', () => {
    for (const operation of ['read-channel', 'read-dm', 'read-thread', 'search']) {
      for (const count of [1, 2, 10]) {
        for (const args of [
          [`--pages=${count}`, operation, 'target'],
          [operation, `--pages=${count}`, 'target'],
          [operation, 'target', `--pages=${count}`],
        ])
          expect(parseCLI(args)).toEqual({
            args: [operation, 'target'],
            interaction: 'background',
            format: 'text',
            pages: count,
          });
      }
    }
    expect(
      parseCLI(['--pages=2', 'read-dm', '--format=json', `--after=${cursor}`, '--', '-literal'])
    ).toEqual({
      args: ['read-dm', '-literal'],
      interaction: 'background',
      format: 'json',
      pages: 2,
      page: { direction: 'newer', cursor },
    });
    expect(parseCLI(['search', '--', '--pages=3'])).toEqual({
      args: ['search', '--pages=3'],
      interaction: 'background',
      format: 'text',
    });
    expect(parseCLI(['read-dm', '--', '--pages=3'])).toEqual({
      args: ['read-dm', '--pages=3'],
      interaction: 'background',
      format: 'text',
    });
    // Channel reads default to three pages (thirty messages); an explicit count still wins.
    expect(parseCLI(['read-channel', 'project-help']).pages).toBe(3);
    expect(parseCLI(['read-channel', 'project-help', '--pages=1']).pages).toBe(1);
    expect(parseCLI(['read-channel', 'project-help', '--from=alex']).pages).toBe(5);
    expect(parseCLI(['read-channel', 'project-help', '--since=2026-01-31']).pages).toBe(10);
    expect(parseCLI(['read-dm', '@alex'])).not.toHaveProperty('pages');
    expect(parseCLI(['read-thread', 'CDEMO:1700000000.000001'])).not.toHaveProperty('pages');
  });

  test('rejects invalid, repeated and unsupported page counts before input with the chosen format', () => {
    const invalidCounts = [
      '',
      '0',
      '11',
      '01',
      '-1',
      '+2',
      '1.0',
      '1e0',
      'NaN',
      ' 2',
      '2 ',
      '2\n',
      '２',
      '2=3',
    ];
    const invalidArgs = [
      ...invalidCounts.map((count) => ['read-channel', 'project-help', `--pages=${count}`]),
      ['read-channel', 'project-help', '--pages=2', '--pages=2'],
      ['read-channel', 'project-help', '--pages', '2'],
      ['read-dm', '--pages=2'],
      ['read-thread', 'one', 'two', '--pages=2'],
      ['search', 'term', `--before=${cursor}`, '--pages=2'],
      ['search', 'term', `--after=${cursor}`, '--pages=2'],
      ['channel', 'project-help', '--pages=2'],
      ['channels', 'extra-target', '--pages=2'],
      ['inspect', '--pages=2'],
      ['permissions', '--request', '--pages=2'],
      ['--help', '--pages=2'],
    ];
    for (const args of invalidArgs) {
      let failure;
      try {
        parseCLI(['--format=json', ...args]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('json');
    }
  });

  test('shows all collected messages chronologically with the batch bound and concise summary', () => {
    const compact = { ...base(), messages: messages(24), pagination: page() };
    compact.messages[1].authorInferred = true;
    compact.messages[1].authorSourceMessageId = compact.messages[0].id;
    const output = formatOutput(compact);
    expect(output).toContain('24 messages across 3 pages.');
    expect(output).toContain('Reached the 3-page limit; history may continue.');
    expect(output).toContain(`Older: read-channel project-help --before=${cursor}`);
    expect(output).not.toContain('omitted');
    expect(output).not.toContain('on this page');
    let previous = -1;
    for (const item of compact.messages) {
      const position = output.indexOf(item.text);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(output).toContain('Person 2 (inferred)');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.messages).toEqual(compact.messages);
    expect(json.pagination.batch).toEqual(compact.pagination.batch);
    expect(json).not.toHaveProperty('desktop');
  });

  test('keeps the thread root once and renders all collected replies with per-message shortening', () => {
    const compact = threadResult(18);
    compact.thread.ref = 'CDEMO:1700000000.000000';
    compact.thread.displayedReplyCount = 32;
    compact.thread.root.text = 'Distinct root message. ' + '🙂'.repeat(600);
    compact.thread.replies[17].text = 'Final reply. ' + 'x'.repeat(600);
    compact.pagination = page({
      older: null,
      direction: 'newer',
      batch: batch({ requestedPages: 2, attemptedPages: 2, completedPages: 2, direction: 'newer' }),
    });
    const output = formatOutput(compact);
    expect(output).toContain('18 replies across 2 pages; Slack shows 32 replies.');
    expect(output.match(/Distinct root message\./g)).toHaveLength(1);
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Message body 17.');
    expect(output).toContain('Final reply.');
    expect(output).toContain('2 messages shortened to 500 characters.');
    expect(output).toContain('Use --format=json for full text on these pages.');
    expect(output).not.toContain('omitted');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.thread.root.text).toBe(compact.thread.root.text);
    expect(json.thread.replies).toHaveLength(18);
  });

  test('retains collected content on a later failure with a sanitized stop notice and no continuation', () => {
    const compact = {
      ...base(),
      status: 'partial',
      messages: messages(19),
      error: { message: '\x1b[31mQuery\x1b[0m\nchanged\u202e' },
      next: 'Inspect\x1b[2J\ncurrent state.',
      pagination: page({
        batch: batch({
          requestedPages: 4,
          attemptedPages: 3,
          completedPages: 2,
          stopReason: 'error',
        }),
      }),
    };
    const output = formatOutput(compact);
    expect(output).toContain('19 messages across 2 pages.');
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Message body 19.');
    expect(output).toContain('Stopped: Query changed');
    expect(output).toContain('Next: Inspect current state.');
    expect(output).not.toContain('Older:');
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.status).toBe('partial');
    expect(json.error).toEqual(compact.error);
    expect(json.messages).toHaveLength(19);
    const thread = {
      ...threadResult(12),
      status: 'partial',
      error: 'View changed.',
      pagination: compact.pagination,
    };
    expect(formatOutput(thread)).toContain('12 replies across 2 pages');
    expect(formatOutput(thread).match(/Distinct root message\./g)).toHaveLength(1);
    expect(formatOutput(thread)).toContain('Stopped: View changed.');
  });

  test('explains bounded early stops without claiming a history boundary', () => {
    const compact = {
      ...base(),
      messages: messages(10),
      pagination: page({
        status: 'no-progress',
        batch: batch({
          attemptedPages: 2,
          completedPages: 2,
          stopReason: 'no-progress',
          deduplicatedCount: 2,
        }),
      }),
    };
    const output = formatOutput(compact);
    expect(output).toContain('10 messages across 2 pages.');
    expect(output).toContain(
      'Stopped after a page exposed no additional messages; history may continue.'
    );
    expect(output).toContain('2 repeated viewport messages omitted.');
    expect(output).not.toContain('Older:');
    expect(output).not.toMatch(/all history|complete history|end of history/i);
    compact.pagination.batch.stopReason = 'no-next-page';
    expect(formatOutput(compact)).toContain(
      'No further page was offered from the verified view; coverage remains partial.'
    );
    compact.status = 'partial';
    compact.pagination.batch.stopReason = 'time-limit';
    expect(formatOutput(compact)).toContain(
      'The multi-page time limit was reached; only verified pages are included.'
    );
  });

  test('rejects malformed batch metadata and refuses records beyond the completed-page bound', () => {
    for (const invalid of [
      { requestedPages: 1 },
      { requestedPages: 11 },
      { completedPages: 0 },
      { completedPages: 4 },
      { attemptedPages: 2 },
      { attemptedPages: 4 },
      { direction: 'sideways' },
      { stopReason: 'complete-history' },
      { deduplicatedCount: -1 },
      { deduplicatedCount: 0.5 },
    ]) {
      const compact = { ...base(), pagination: page({ batch: batch(invalid) }) };
      expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
    }
    const compact = { ...base(), messages: messages(31), pagination: page() };
    expect(() => formatOutput(compact)).toThrow('Message batch exceeds its page limit');
    const thread = { ...threadResult(31), pagination: page() };
    expect(() => formatOutput(thread)).toThrow('Thread batch exceeds its page limit');
  });
});

describe('destination candidates and author inference', () => {
  test('incomplete direct lookup keeps opt-in candidate actions without claiming no matches', () => {
    const compact = {
      status: 'stopped',
      operation: 'read-dm',
      query: 'Alex',
      exactMatchCount: 1,
      candidates: [
        {
          name: 'Alex',
          handle: '@alex',
          navigation: { command: 'read-dm', args: ['@alex', '--allow-clipboard'] },
        },
      ],
      candidateCount: 1,
      next: 'Use an observed handle; unexposed suggestions remain unknown',
    };
    const text = formatOutput(compact);
    expect(text).toContain('Destination lookup incomplete: Alex');
    expect(text).toContain('read-dm --allow-clipboard @alex');
    expect(text).not.toContain('No exact destination match');
    expect(JSON.parse(formatOutput(compact, 'json')).exactMatchCount).toBe(1);
    compact.candidates[0].navigation.args[1] = '--unsafe';
    expect(formatOutput(compact)).not.toContain('read-dm');
  });
  const candidate = (index) => ({
    name: `Alex Example ${index}`,
    handle: `@alex${index}`,
    navigation: { command: 'read-dm', args: [`@alex${index}`] },
  });
  const ambiguous = () => ({
    status: 'ambiguous',
    operation: 'read-dm',
    query: 'Alex Example',
    error: 'Multiple destination suggestions matched.',
    next: 'Use an observed handle from an available candidate.',
    candidates: Array.from({ length: 20 }, (_, index) => candidate(index)),
    candidateCount: 24,
    candidatesTruncated: true,
  });

  test('shows eight available candidates before generic error handling and retains all returned candidates in JSON', () => {
    const compact = ambiguous(),
      before = JSON.stringify(compact);
    const output = formatOutput(compact);
    expect(output).toContain('Destination needs a choice: Alex Example');
    expect(output).toContain('Choose an available candidate:');
    expect(output).toContain('No destination was selected.');
    expect(output).toContain('Alex Example 0 (@alex0) · read-dm @alex0');
    expect(output).toContain('Alex Example 7 (@alex7) · read-dm @alex7');
    expect(output).not.toContain('Alex Example 8');
    expect(output).toContain('Showing 8 of 24 available candidates.');
    expect(output).toContain('The returned candidate list was capped.');
    expect(output).not.toContain('Stopped:');
    expect(output).not.toContain('exact candidates');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.status).toBe('ambiguous');
    expect(json.query).toBe(compact.query);
    expect(json.candidates).toEqual(compact.candidates);
    expect(json.candidateCount).toBe(24);
    expect(json.candidatesTruncated).toBe(true);
    expect(json.error).toBe(compact.error);
    expect(JSON.stringify(compact)).toBe(before);
  });

  test('not-found output offers available suggestions without labeling them exact matches', () => {
    const compact = {
      ...ambiguous(),
      status: 'not-found',
      query: 'alex.',
      candidates: [candidate(0)],
      candidateCount: 1,
      candidatesTruncated: false,
    };
    expect(formatOutput(compact)).toContain('No exact destination match: alex.');
    expect(formatOutput(compact)).toContain('Choose an available candidate:');
    expect(JSON.parse(formatOutput(compact, 'json')).status).toBe('not-found');
    compact.candidates = [];
    compact.candidateCount = 0;
    const output = formatOutput(compact);
    expect(output).toContain('No available candidates were exposed.');
    expect(output).not.toContain('Choose an available candidate:');
    expect(output).not.toContain('undefined');
  });

  test('sanitizes candidate text and withholds commands whose values contain terminal controls', () => {
    const compact = {
      ...ambiguous(),
      query: '\x1b[2JAlex\u202e\nQuery',
      next: 'Read\x1b[31m handle\x1b[0m\nnext',
      candidates: [
        {
          name: '\x1b[32mAlex\x1b[0m\nExample',
          handle: '@alex\u2066',
          navigation: { command: 'read-dm', args: ['@alex\u2066'] },
        },
      ],
      candidateCount: 1,
      candidatesTruncated: false,
    };
    const output = formatOutput(compact);
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    expect(output).toContain('Alex Query');
    expect(output).toContain('Alex Example (@alex)');
    expect(output).toContain('Next: Read handle next');
    expect(output).not.toContain('· read-dm');
  });

  test('quotes observed candidate arguments and preserves literal leading dashes', () => {
    const candidates = [
      {
        name: "Alex O'Neil; $(example)",
        handle: null,
        navigation: { command: 'read-dm', args: ["Alex O'Neil; $(example)"] },
      },
      { name: '-alex', handle: null, navigation: { command: 'read-dm', args: ['-alex'] } },
      {
        name: '-channel',
        handle: null,
        navigation: { command: 'read-channel', args: ['-channel'] },
      },
      { name: 'café', handle: null, navigation: { command: 'read-channel', args: ['café'] } },
    ];
    const output = formatOutput({
      ...ambiguous(),
      candidates,
      candidateCount: 4,
      candidatesTruncated: false,
    });
    expect(output).toContain("read-dm 'Alex O'\\''Neil; $(example)'");
    expect(output).toContain('read-dm -- -alex');
    expect(output).toContain('read-channel -- -channel');
    expect(output).toContain("read-channel 'café'");
  });

  test('does not advertise unsupported, extra-argument or unobserved destination actions', () => {
    for (const navigation of [
      { command: 'send-message', args: ['@alex0'] },
      { command: 'read-thread', args: ['@alex0'] },
      { command: 'read-dm', args: ['@alex0', 'extra'] },
      { command: 'read-dm', args: ['@unobserved'] },
      { command: 'read-channel', args: ['Alex Example 0'] },
    ]) {
      const compact = {
        ...ambiguous(),
        candidates: [{ ...candidate(0), navigation }],
        candidateCount: 1,
        candidatesTruncated: false,
      };
      const output = formatOutput(compact);
      expect(output).toContain('Alex Example 0 (@alex0)');
      expect(output).not.toContain(' · ');
    }
  });

  test('labels inferred authors in conversations, search snippets, root messages and replies', () => {
    for (const operation of ['read-channel', 'read-dm', 'search']) {
      const compact = {
        ...base(),
        operation,
        messages: [{ ...message(1), author: 'Alex Example', authorInferred: true }],
      };
      if (operation === 'search') compact.search = { query: 'example' };
      // Conversation reads put the author on its own heading line; search keeps "author · time".
      const after = operation === 'search' ? ' ·' : '\n';
      expect(formatOutput(compact)).toContain(`Alex Example (inferred)${after}`);
      expect(JSON.parse(formatOutput(compact, 'json')).messages[0].authorInferred).toBe(true);
      compact.messages[0].authorInferred = false;
      expect(formatOutput(compact)).toContain(`Alex Example${after}`);
      expect(formatOutput(compact)).not.toContain('(inferred)');
    }
    const thread = threadResult(1);
    thread.thread.root.authorInferred = true;
    thread.thread.replies[0].authorInferred = true;
    expect(formatOutput(thread)).toContain('Person 0 (inferred) ·');
    expect(formatOutput(thread)).toContain('Person 1 (inferred) ·');
  });

  test('does not invent an inferred author when the author is unknown', () => {
    const compact = {
      ...base(),
      messages: [{ ...message(1), author: null, authorInferred: true }],
    };
    expect(formatOutput(compact)).toContain('Author not exposed\n');
    expect(formatOutput(compact)).not.toContain('(inferred)');
    compact.messages[0].author = { displayName: '\x1b[31mAlex\x1b[0m\u202e' };
    expect(formatOutput(compact)).toContain('Alex (inferred)\n');
    expect(formatOutput(compact)).not.toContain('\x1b');
  });
});

describe('multi-page search output', () => {
  const searchResult = (count = 60) => ({
    ...base(),
    operation: 'search',
    requested: 'release notes',
    conversation: undefined,
    search: {
      query: 'release notes',
      totalResults: 123,
      page: 3,
      pageCount: 7,
      firstPage: 1,
      lastPage: 3,
    },
    messages: messages(count).map((item) => ({ ...item, snippet: true, channel: 'project-help' })),
    pagination: {
      supported: true,
      status: 'advanced',
      hasMore: true,
      nextCursor: null,
      batch: {
        requestedPages: 3,
        attemptedPages: 3,
        completedPages: 3,
        direction: 'next',
        stopReason: 'page-limit',
        deduplicatedCount: 2,
      },
    },
  });

  test('shows bounded search text with result range and explicit JSON recovery for omitted matches', () => {
    const compact = searchResult();
    const output = formatOutput(compact);
    expect(output).toContain('123 results · pages 1–3 of 7');
    expect(output).toContain('60 unique matches across 3 result pages.');
    expect(output).toContain('Showing first 30 of 60 collected matches; 30 omitted from text.');
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Message body 30.');
    expect(output).not.toContain('Message body 31.');
    expect(output).toContain(
      'Use --format=json for all collected matches and their full captured text.'
    );
    expect(output).toContain('Reached the 3-page limit; more matches may remain.');
    expect(output).toContain('2 repeated matches omitted.');
    expect(output).not.toContain('history may continue');
    expect(output).not.toContain('viewport');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.messages).toHaveLength(60);
    expect(json.messages[59].text).toBe('Message body 60.');
    expect(json.search).toEqual(compact.search);
    expect(json.pagination.batch).toEqual(compact.pagination.batch);
    expect(json).not.toHaveProperty('desktop');
  });

  test('retains result order and thread references while shortening body text only', () => {
    const compact = searchResult(3);
    compact.messages = [message(9), message(2), message(7)];
    compact.messages[0].text = 'x'.repeat(600);
    compact.messages[0].thread = {
      replyCount: 4,
      ref: 'CDEMO:1700000000.000001',
      navigation: { command: 'read-thread', args: ['CDEMO:1700000000.000001'] },
    };
    const output = formatOutput(compact);
    expect(output.indexOf('Person 9')).toBeLessThan(output.indexOf('Person 2'));
    expect(output.indexOf('Person 2')).toBeLessThan(output.indexOf('Person 7'));
    expect(output).toContain('3 unique matches across 3 result pages.');
    expect(output).toContain('4 replies · read-thread CDEMO:1700000000.000001');
    expect(output).toContain('1 message shortened to 500 characters.');
    expect(output).not.toContain('x'.repeat(500));
    expect(JSON.parse(formatOutput(compact, 'json')).messages[0].text).toHaveLength(600);
    expect(output).not.toContain('omitted from text');
  });

  test('retains partial search matches and sanitized stop details', () => {
    const compact = searchResult(35);
    compact.status = 'partial';
    compact.error = '\x1b[31mSearch query changed\x1b[0m\u202e';
    compact.next = 'Inspect before retrying.';
    compact.search.page = compact.search.lastPage = 2;
    compact.pagination.batch = {
      ...compact.pagination.batch,
      completedPages: 2,
      stopReason: 'error',
    };
    const output = formatOutput(compact);
    expect(output).toContain('35 unique matches across 2 result pages.');
    expect(output).toContain('Showing first 20 of 35 collected matches; 15 omitted from text.');
    expect(output).toContain('Message body 20.');
    expect(output).not.toContain('Message body 21.');
    expect(output).toContain('Stopped: Search query changed');
    expect(output).toContain('Next: Inspect before retrying.');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\u202e');
    expect(JSON.parse(formatOutput(compact, 'json')).messages).toHaveLength(35);
  });

  test('labels no-progress, empty results and a reached result boundary without archive claims', () => {
    const compact = searchResult(6);
    compact.pagination.batch.stopReason = 'no-progress';
    compact.pagination.status = 'no-progress';
    let output = formatOutput(compact);
    expect(output).toContain('6 unique matches across 3 result pages.');
    expect(output).toContain(
      'Stopped after a page exposed no additional matches; more matches may remain.'
    );
    expect(output).not.toContain('No message results were exposed');
    compact.messages = [];
    compact.search = {
      query: 'missing',
      totalResults: 0,
      page: null,
      pageCount: null,
      firstPage: null,
      lastPage: null,
    };
    compact.pagination.batch.completedPages = compact.pagination.batch.attemptedPages = 1;
    compact.pagination.batch.stopReason = 'no-next-page';
    compact.pagination.batch.deduplicatedCount = 0;
    output = formatOutput(compact);
    expect(output).toContain('0 unique matches across 1 result page.');
    expect(output).toContain('No message results were exposed.');
    expect(output).toContain(
      'No further page was offered from the verified view; coverage remains partial.'
    );
    expect(output).not.toContain('all messages');
    expect(output).not.toContain('page null');
  });

  test('validates search ranges and separates search directions from conversation directions', () => {
    for (const change of [
      { firstPage: 0 },
      { lastPage: 1 },
      { lastPage: 8 },
      { firstPage: 2.5 },
      { firstPage: null },
      { page: 2 },
    ]) {
      const compact = searchResult();
      Object.assign(compact.search, change);
      expect(() => formatOutput(compact)).toThrow('Search result page range is invalid');
    }
    for (const direction of ['older', 'newer', 'wrong']) {
      const compact = searchResult();
      compact.pagination.batch.direction = direction;
      expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
    }
    const compact = searchResult();
    compact.operation = 'read-channel';
    expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
  });

  test('accepts literal search flags with a page budget and preserves the single-page format', () => {
    expect(parseCLI(['--pages=2', '--format=json', 'search', '--', '--pages=3'])).toEqual({
      args: ['search', '--pages=3'],
      interaction: 'background',
      format: 'json',
      pages: 2,
    });
    expect(parseCLI(['search', 'term', '--pages=1'])).toEqual({
      args: ['search', 'term'],
      interaction: 'background',
      format: 'text',
      pages: 1,
    });
    const compact = searchResult(20);
    delete compact.pagination.batch;
    compact.pagination.supported = false;
    const output = formatOutput(compact);
    expect(output).toContain('Showing first 10 of 20 captured messages; 10 omitted.');
    expect(output).toContain('page 3 of 7');
    expect(output).not.toContain('unique matches');
    expect(output).not.toContain('pages 1–3');
  });
});

describe('multi-page channel output', () => {
  const channelResult = (count = 70) => ({
    ...base(),
    operation: 'channels',
    requested: null,
    conversation: undefined,
    messages: undefined,
    channels: Array.from({ length: count }, (_, index) => ({
      id: `CDEMO${index + 1}`,
      name: `channel-${index + 1}`,
      unread: index === 0,
      navigation: { command: 'read-channel', args: [`channel-${index + 1}`] },
    })),
    pagination: {
      supported: true,
      direction: 'down',
      hasMore: null,
      nextCursor: null,
      batch: {
        requestedPages: 3,
        attemptedPages: 3,
        completedPages: 3,
        direction: 'down',
        stopReason: 'page-limit',
        deduplicatedCount: 5,
      },
    },
  });

  test('accepts bounded channel page counts without a positional target and preserves defaults', () => {
    for (const count of [1, 2, 10]) {
      for (const args of [
        [`--pages=${count}`, 'channels'],
        ['channels', `--pages=${count}`],
        ['--format=json', 'channels', `--pages=${count}`, '--'],
      ]) {
        expect(parseCLI(args)).toEqual({
          args: ['channels'],
          interaction: 'background',
          format: args.includes('--format=json') ? 'json' : 'text',
          pages: count,
        });
      }
    }
    expect(parseCLI(['channels'])).toEqual({
      interaction: 'background',
      args: ['channels'],
      format: 'text',
    });
    expect(parseCLI(['channels', '--format=full-json'])).toEqual({
      args: ['channels'],
      interaction: 'background',
      format: 'full-json',
    });
  });

  test('rejects channel cursors, positional arguments and malformed page counts before input', () => {
    const cursor = 'CDEMO:1700000000.000001';
    const invalidArgs = [
      ['channels', 'unexpected'],
      ['channels', '--pages=1', 'unexpected'],
      ['channels', '--pages=2', '--', 'unexpected'],
      ['channels', '--', '--pages=2'],
      ['channels', '--pages=2', '--pages=2'],
      ['channels', '--pages', '2'],
      ...['', '0', '11', '01', '-1', '+2', '2.0', '2e0', ' 2', '2 ', '２'].map((count) => [
        'channels',
        `--pages=${count}`,
      ]),
      ...['before', 'after'].flatMap((direction) => [
        ['channels', `--${direction}=${cursor}`],
        ['channels', '--pages=2', `--${direction}=${cursor}`],
      ]),
    ];
    for (const args of invalidArgs) {
      let failure;
      try {
        parseCLI(['--format=json', ...args]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('json');
    }
  });

  test('caps a channel collection at thirty text rows while retaining all unique JSON records', () => {
    const compact = channelResult();
    const output = formatOutput(compact);
    expect(output).toContain('Channels — Example Workspace');
    expect(output).toContain('70 unique channels across 3 sidebar captures.');
    expect(output).toContain('#channel-1 (unread) · read-channel channel-1');
    expect(output).toContain('#channel-30 · read-channel channel-30\n');
    expect(output).not.toContain('#channel-31');
    expect(output.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(30);
    expect(output).toContain('Showing 30 of 70 collected channels; 40 omitted from text.');
    expect(output).toContain('Use --format=json for all collected channels.');
    expect(output).toContain('Reached the 3-page limit; other channels may remain.');
    expect(output).toContain('5 repeated channel observations omitted.');
    expect(output).toContain('other channels may be outside these captures');
    expect(output).not.toContain('history');
    expect(output).not.toContain('messages');
    expect(output).not.toContain('31415');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.channels).toHaveLength(70);
    expect(json.channels[69].navigation).toEqual({
      command: 'read-channel',
      args: ['channel-70'],
    });
    expect(json.pagination.batch).toEqual(compact.pagination.batch);
    expect(json.coverage.complete).toBe(false);
    expect(json).not.toHaveProperty('desktop');
  });

  test('retains a bounded partial channel prefix before sanitized stop details', () => {
    const compact = channelResult(35);
    compact.status = 'partial';
    compact.error = '\x1b[31mSidebar identity changed\x1b[0m\u202e';
    compact.next = 'Inspect before retrying.';
    compact.pagination.batch.completedPages = 2;
    compact.pagination.batch.stopReason = 'error';
    compact.nodes = [{ value: 'Raw accessibility tree must stay diagnostic.' }];
    const output = formatOutput(compact);
    expect(output).toContain('35 unique channels across 2 sidebar captures.');
    expect(output).toContain('Showing 30 of 35 collected channels; 5 omitted from text.');
    expect(output).toContain('#channel-30 · read-channel channel-30');
    expect(output).not.toContain('#channel-31');
    expect(output.indexOf('#channel-30')).toBeLessThan(output.indexOf('Stopped:'));
    expect(output).toContain('Stopped: Sidebar identity changed');
    expect(output).toContain('Next: Inspect before retrying.');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\u202e');
    expect(output).not.toContain('Raw accessibility tree');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.status).toBe('partial');
    expect(json.channels).toHaveLength(35);
    expect(json.pagination.batch.attemptedPages).toBe(3);
    expect(json.pagination.batch.completedPages).toBe(2);
    expect(json).not.toHaveProperty('nodes');
    expect(json).not.toHaveProperty('desktop');
  });

  test('labels channel stop reasons and empty captures without a directory-completeness claim', () => {
    const compact = channelResult(1);
    compact.pagination.batch.stopReason = 'no-progress';
    compact.pagination.batch.deduplicatedCount = 1;
    let output = formatOutput(compact);
    expect(output).toContain('1 unique channel across 3 sidebar captures.');
    expect(output).toContain(
      'Stopped after a capture exposed no additional sidebar rows; other channels may remain.'
    );
    expect(output).toContain('1 repeated channel observation omitted.');
    expect(output).not.toContain('Use --format=json');
    expect(output).not.toContain('history');
    compact.channels = [];
    compact.pagination.batch.completedPages = compact.pagination.batch.attemptedPages = 1;
    compact.pagination.batch.stopReason = 'no-next-page';
    compact.pagination.batch.deduplicatedCount = 0;
    output = formatOutput(compact);
    expect(output).toContain('0 unique channels across 1 sidebar capture.');
    expect(output).toContain('No channels were exposed in the sidebar.');
    expect(output).toContain('coverage remains partial');
    expect(output).not.toContain('all channels');
    expect(output).not.toContain('workspace is empty');
  });

  test('validates channel batch direction and retains unbatched output', () => {
    for (const direction of ['older', 'newer', 'next', 'wrong']) {
      const compact = channelResult();
      compact.pagination.batch.direction = direction;
      expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
    }
    const compact = channelResult(35);
    delete compact.pagination.batch;
    compact.pagination.supported = false;
    const output = formatOutput(compact);
    expect(output).toContain('Showing 30 of 35 captured channels; 5 omitted.');
    expect(output).toContain('Use --format=json for all captured channels.');
    expect(output).toContain('Showing exposed sidebar channels');
    expect(output).not.toContain('sidebar captures');
    expect(output).not.toContain('unique channels');
    expect(output).not.toContain('Collected exposed');
  });
});

describe('DM sidebar output', () => {
  const dm = (index, overrides = {}) => ({
    id: `DDEMO${index}`,
    name: `Person ${index}`,
    kind: 'one-to-one',
    url: null,
    unread: null,
    selected: null,
    sections: ['Direct messages'],
    navigation: { command: 'read-dm', args: [`Person ${index}`] },
    ...overrides,
  });
  const dmResult = (count = 2, batch = false) => ({
    ...base(),
    operation: 'dms',
    requested: null,
    conversation: undefined,
    messages: undefined,
    dms: Array.from({ length: count }, (_, index) => dm(index + 1)),
    pagination: batch
      ? {
          supported: true,
          direction: 'down',
          hasMore: null,
          nextCursor: null,
          batch: {
            requestedPages: 3,
            attemptedPages: 3,
            completedPages: 3,
            direction: 'down',
            stopReason: 'page-limit',
            deduplicatedCount: 4,
          },
        }
      : { supported: false, hasMore: null, nextCursor: null },
  });

  test('parses dms with no target and optional bounded page counts or output format', () => {
    expect(parseCLI(['dms'])).toEqual({ interaction: 'background', args: ['dms'], format: 'text' });
    expect(parseCLI(['dms', '--format=full-json'])).toEqual({
      args: ['dms'],
      interaction: 'background',
      format: 'full-json',
    });
    for (const count of [1, 2, 10]) {
      for (const args of [
        [`--pages=${count}`, 'dms'],
        ['dms', `--pages=${count}`],
        ['--format=json', 'dms', `--pages=${count}`, '--'],
      ])
        expect(parseCLI(args)).toEqual({
          args: ['dms'],
          interaction: 'background',
          format: args.includes('--format=json') ? 'json' : 'text',
          pages: count,
        });
    }
  });

  test('parses observed group references with every format and bounded message pagination', () => {
    const cursor = 'CGROUP:1700000000.000001';
    for (const format of ['text', 'json', 'full-json']) {
      expect(
        parseCLI([
          'read-dm',
          'group:CGROUP',
          '--pages=3',
          `--before=${cursor}`,
          `--format=${format}`,
        ])
      ).toEqual({
        args: ['read-dm', 'group:CGROUP'],
        interaction: 'background',
        format,
        pages: 3,
        page: { direction: 'older', cursor },
      });
    }
    expect(parseCLI(['read-dm', 'group:GGROUP'])).toEqual({
      args: ['read-dm', 'group:GGROUP'],
      interaction: 'background',
      format: 'text',
    });
    for (const reference of [
      'group:',
      'group:C',
      'group:DDEMO',
      'group:cgroup',
      'group:CGROUP\n',
      'group:CGROUP extra',
      'group:CGROUP:extra',
    ]) {
      expect(() => parseCLI(['read-dm', reference, '--format=json'])).toThrow(
        'Group DM references'
      );
    }
    expect(parseCLI(['search', 'group:literal'])).toEqual({
      args: ['search', 'group:literal'],
      interaction: 'background',
      format: 'text',
    });
  });

  test('rejects DM list targets, message cursors and invalid page counts before input', () => {
    const cursor = 'DDEMO1:1700000000.000001';
    for (const args of [
      ['dms', 'Person'],
      ['dms', '--pages=1', 'Person'],
      ['dms', '--pages=2', '--', 'Person'],
      ['dms', '--', '--pages=2'],
      ['dms', '--pages=2', '--pages=2'],
      ['dms', '--pages', '2'],
      ...['', '0', '11', '01', '-1', '+2', '2.0', '2e0', ' 2', '2 ', '２'].map((count) => [
        'dms',
        `--pages=${count}`,
      ]),
      ...['before', 'after'].flatMap((direction) => [
        ['dms', `--${direction}=${cursor}`],
        ['dms', '--pages=2', `--${direction}=${cursor}`],
      ]),
    ]) {
      let failure;
      try {
        parseCLI(['--format=json', ...args]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('json');
    }
  });

  test('lists one-to-one, group and self DMs with only supplied supported read actions', () => {
    const compact = dmResult();
    compact.dms = [
      dm(1, { unread: true }),
      dm(2, {
        id: 'CGROUP',
        name: 'Alex, Sam',
        kind: 'group',
        navigation: { command: 'read-dm', args: ['group:CGROUP'] },
      }),
      dm(3, { kind: 'self' }),
      dm(4, { name: 'Same Name', navigation: null }),
      dm(5, { name: 'Same Name', navigation: null }),
    ];
    const output = formatOutput(compact);
    expect(output).toContain('DMs — Example Workspace');
    expect(output).toContain("- Person 1 (unread) · read-dm 'Person 1'");
    expect(output).toContain('- Alex, Sam (group DM) · read-dm group:CGROUP\n');
    expect(output).not.toContain("read-dm 'Alex, Sam'");
    expect(output).toContain("- Person 3 (you) · read-dm 'Person 3'");
    expect(output.match(/^- Same Name$/gm)).toHaveLength(2);
    expect(output).not.toContain("read-dm 'Same Name'");
    expect(output).toContain('5 captured DM conversations.');
    expect(output).toContain('other DM conversations may be outside this view');
    expect(output).not.toContain('31415');
    expect(output).not.toContain('unique DM');
  });

  test('only renders exact ID-bound group actions with group metadata', () => {
    const group = (id, target, overrides = {}) =>
      dm(1, {
        id,
        name: 'Same group name',
        kind: 'group',
        navigation: { command: 'read-dm', args: [target] },
        ...overrides,
      });
    const compact = dmResult();
    compact.dms = [
      group('CGROUP', 'group:CGROUP'),
      group('GGROUP', 'group:GGROUP'),
      group('COTHER', 'group:CGROUP'),
      group('DOTHER', 'group:DOTHER'),
      group('CGROUP', 'Same group name'),
      group('CGROUP\n', 'group:CGROUP\n'),
      group('CGROUP', 'group:CGROUP', { kind: 'one-to-one', name: 'group:CGROUP' }),
      group('CGROUP', 'group:CGROUP', {
        navigation: { command: 'read-channel', args: ['group:CGROUP'] },
      }),
      group('CGROUP', 'group:CGROUP', {
        navigation: { command: 'read-dm', args: ['group:CGROUP', 'extra'] },
      }),
    ];
    const output = formatOutput(compact);
    expect(output.match(/ · read-dm /g)).toHaveLength(2);
    expect(output).toContain('read-dm group:CGROUP');
    expect(output).toContain('read-dm group:GGROUP');
    expect(output).not.toContain("read-dm 'Same group name'");
    expect(output).not.toContain('read-dm group:DOTHER');
  });

  test('caps default and batch DM text at thirty total while JSON retains every record', () => {
    for (const batch of [false, true]) {
      const compact = dmResult(65, batch);
      const output = formatOutput(compact);
      expect(output.split('\n').filter((line) => line.startsWith('- Person '))).toHaveLength(30);
      expect(output).toContain("- Person 30 · read-dm 'Person 30'");
      expect(output).not.toContain('- Person 31');
      expect(output).toContain(
        `Showing 30 of 65 ${batch ? 'collected' : 'captured'} DM conversations; 35 omitted${batch ? ' from text' : ''}.`
      );
      expect(output).toContain(
        `Use --format=json for all ${batch ? 'collected' : 'captured'} DM conversations.`
      );
      if (batch) {
        expect(output).toContain('65 unique DM conversations across 3 sidebar captures.');
        expect(output).toContain('4 repeated DM observations omitted.');
        expect(output).toContain(
          'Reached the 3-page limit; other DM conversations may remain.'
        );
      }
      const json = JSON.parse(formatOutput(compact, 'json'));
      expect(json.dms).toHaveLength(65);
      expect(json.dms[64]).toEqual(compact.dms[64]);
      expect(json.pagination).toEqual(compact.pagination);
      expect(json.coverage.complete).toBe(false);
      expect(json).not.toHaveProperty('desktop');
      expect(json).not.toHaveProperty('channels');
    }
  });

  test('quotes supplied observed targets and rejects unobserved or unsafe DM navigation', () => {
    const compact = dmResult();
    compact.dms = [
      dm(1, {
        name: "O'Neil Example",
        navigation: { command: 'read-dm', args: ["O'Neil Example"] },
      }),
      dm(2, { name: '-literal', navigation: { command: 'read-dm', args: ['-literal'] } }),
      dm(3, {
        handle: '@observed.handle',
        navigation: { command: 'read-dm', args: ['@observed.handle'] },
      }),
      dm(4, { navigation: { command: 'read-dm', args: ['Different Person'] } }),
      dm(5, { navigation: { command: 'read-dm', args: ['@invented.handle'] } }),
      dm(6, { navigation: { command: 'read-channel', args: ['Person 6'] } }),
      dm(7, { navigation: { command: 'read-dm', args: ['Person 7', 'extra'] } }),
      dm(8, {
        name: '\x1b[31mUnsafe\x1b[0m\u202e',
        navigation: { command: 'read-dm', args: ['\x1b[31mUnsafe\x1b[0m\u202e'] },
      }),
      dm(9, { kind: 'unknown' }),
      dm(10, { navigation: null }),
    ];
    const output = formatOutput(compact);
    expect(output).toContain("read-dm 'O'\\''Neil Example'");
    expect(output).toContain('read-dm -- -literal');
    expect(output).toContain('read-dm @observed.handle');
    expect(output.match(/ · read-dm /g)).toHaveLength(3);
    expect(output).toContain('- Unsafe\n');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\u202e');
    expect(output).not.toContain('Different Person');
    expect(output).not.toContain('@invented.handle');
  });

  test('keeps verified DM records on a later failure and sanitizes the stop notice', () => {
    const compact = dmResult(35, true);
    compact.status = 'partial';
    compact.error = '\x1b[31mSidebar changed\x1b[0m\u202e';
    compact.next = 'Inspect before retrying.';
    compact.pagination.batch.completedPages = 2;
    compact.pagination.batch.stopReason = 'error';
    compact.nodes = [{ label: 'Raw private diagnostic' }];
    const output = formatOutput(compact);
    expect(output).toContain('35 unique DM conversations across 2 sidebar captures.');
    expect(output).toContain('Showing 30 of 35 collected DM conversations; 5 omitted from text.');
    expect(output.indexOf('- Person 30')).toBeLessThan(output.indexOf('Stopped: Sidebar changed'));
    expect(output).toContain('Next: Inspect before retrying.');
    expect(output).not.toContain('- Person 31');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\u202e');
    expect(output).not.toContain('Raw private diagnostic');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.dms).toHaveLength(35);
    expect(json.status).toBe('partial');
    expect(json.pagination.batch.completedPages).toBe(2);
    expect(json.pagination.batch.attemptedPages).toBe(3);
    expect(json).not.toHaveProperty('nodes');
    expect(json).not.toHaveProperty('desktop');
    const receipt = {
      operation: 'dms',
      status: 'partial',
      pages: [{ content: { nodes: compact.nodes } }],
      batch: compact.pagination.batch,
    };
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
  });

  test('describes DM no-progress in sidebar rows and leaves an empty capture bounded', () => {
    const compact = dmResult(1, true);
    compact.pagination.batch.stopReason = 'no-progress';
    compact.pagination.batch.deduplicatedCount = 1;
    let output = formatOutput(compact);
    expect(output).toContain('1 unique DM conversation across 3 sidebar captures.');
    expect(output).toContain('1 repeated DM observation omitted.');
    expect(output).toContain(
      'Stopped after a capture exposed no additional sidebar rows; other DM conversations may remain.'
    );
    expect(output).not.toContain('history');
    expect(output).not.toContain('no additional DM');
    compact.dms = [];
    output = formatOutput(compact);
    expect(output).toContain('0 unique DM conversations across 3 sidebar captures.');
    expect(output).toContain('No DM conversations were exposed in the sidebar.');
    expect(output).toContain('other DM conversations may be outside these captures');
    expect(output).not.toContain('all DMs');
    for (const direction of ['older', 'newer', 'next', 'wrong']) {
      compact.pagination.batch.direction = direction;
      expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
    }
  });

  test('describes single DMs-view captures while preserving supplied drill-down actions', () => {
    const compact = dmResult();
    compact.coverage.source = 'dms-view';
    compact.dms = [
      dm(1, { sections: [] }),
      dm(2, {
        id: 'CGROUP',
        name: 'Project group',
        kind: 'group',
        sections: [],
        navigation: { command: 'read-dm', args: ['group:CGROUP'] },
      }),
      dm(3, { kind: 'self', sections: [] }),
    ];
    const output = formatOutput(compact);
    expect(output).toContain('DMs — Example Workspace');
    expect(output).toContain('3 captured DM conversations.');
    expect(output).toContain('- Project group (group DM) · read-dm group:CGROUP');
    expect(output).toContain("- Person 3 (you) · read-dm 'Person 3'");
    expect(output).toContain(
      'Showing exposed DM conversations from the DMs view; other DM conversations may be outside this view.'
    );
    expect(output).not.toContain('sidebar');
    expect(JSON.parse(formatOutput(compact, 'json')).coverage.source).toBe('dms-view');
  });

  test('shows active DMs-view filters without confusing blank or unknown values with filters', () => {
    const compact = dmResult();
    compact.coverage.source = 'dms-view';
    compact.coverage.filters = { query: '  Project\nGroup  ', unreadOnly: true };
    expect(formatOutput(compact)).toContain('Filters: search "Project Group"; unread only.');
    compact.coverage.filters = { query: '', unreadOnly: false };
    expect(formatOutput(compact)).not.toContain('Filters:');
    compact.coverage.filters = { query: '', unreadOnly: null };
    expect(formatOutput(compact)).not.toContain('Filters:');
    compact.coverage.filters = { query: 'Project', unreadOnly: false };
    expect(formatOutput(compact)).toContain('Filters: search "Project".');
    delete compact.coverage.source;
    expect(formatOutput(compact)).not.toContain('Filters:');
  });

  test('caps DMs-view batches at thirty entries without trimming JSON or full diagnostics', () => {
    const compact = dmResult(65, true);
    compact.coverage.source = 'dms-view';
    const output = formatOutput(compact);
    expect(output).toContain('65 unique DM conversations across 3 DMs view captures.');
    expect(output).toContain('4 repeated DM observations omitted.');
    expect(output).toContain('Showing 30 of 65 collected DM conversations; 35 omitted from text.');
    expect(output).toContain('Use --format=json for all collected DM conversations.');
    expect(output).toContain('Collected exposed DM conversations from the DMs view');
    expect(output.split('\n').filter((line) => line.startsWith('- Person '))).toHaveLength(30);
    expect(output).not.toContain('sidebar');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.dms).toHaveLength(65);
    expect(json.pagination).toEqual(compact.pagination);
    expect(json.coverage.complete).toBe(false);
    const receipt = { operation: 'dms', pages: [{ content: { nodes: [{ id: 'D1' }] } }] };
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
  });

  test('reports DMs-view no-progress and partial results without implying an endpoint', () => {
    const compact = dmResult(1, true);
    compact.coverage.source = 'dms-view';
    compact.pagination.batch.stopReason = 'no-progress';
    let output = formatOutput(compact);
    expect(output).toContain(
      'Stopped after a capture exposed no additional rows in the DMs view; other DM conversations may remain.'
    );
    expect(output).not.toContain('sidebar');
    expect(output).not.toContain('all DMs');
    compact.status = 'partial';
    compact.error = 'DMs view filter changed';
    compact.next = 'Inspect the current DMs view before starting another command.';
    compact.pagination.batch.completedPages = 2;
    compact.pagination.batch.stopReason = 'error';
    output = formatOutput(compact);
    expect(output).toContain('1 unique DM conversation across 2 DMs view captures.');
    expect(output.indexOf('- Person 1')).toBeLessThan(
      output.indexOf('Stopped: DMs view filter changed')
    );
    expect(output).toContain('Next: Inspect the current DMs view before starting another command.');
    expect(JSON.parse(formatOutput(compact, 'json')).dms).toHaveLength(1);
  });
});

describe('read-media command', () => {
  const reference = 'CDEMO:1700000000.000001';
  const result = () => ({
    schemaVersion: 1,
    operation: 'read-media',
    requested: `${reference}/m1`,
    workspace: { name: 'Example Workspace' },
    media: {
      kind: 'video',
      label: 'Demo recording',
      filename: 'demo.mp4',
      ref: `${reference}/m1`,
      description: 'A detailed accessible description.',
      descriptionSource: 'accessibility',
      displayedDuration: '4:36',
      displayedPlaybackTime: '0:00',
      transcript: { state: 'available' },
      contentRead: false,
      filePageUrl: 'https://demo.slack.com/files/UDEMO/FDEMO/demo.mp4',
      downloadUrl: 'https://files.slack.com/files-pri/TDEMO-FDEMO/download/demo.mp4',
      thumbnailUrl: 'https://files.slack.com/files-tmb/TDEMO-FDEMO/demo.png',
      provenance: { kind: 'quoted', author: 'Original Author' },
    },
    sources: [
      {
        messageRef: reference,
        author: 'Example Person',
        permalink: 'https://demo.slack.com/archives/CDEMO/p1700000000000001',
        thread: {
          ref: reference,
          replyCount: 3,
          navigation: { command: 'read-thread', args: [reference] },
        },
      },
    ],
    navigation: [{ command: 'read-thread', args: [reference] }],
    coverage: { scope: 'exposed attachment metadata', complete: false, contentRead: false },
  });

  test('accepts attachment references with all formats and coordination options', () => {
    for (const format of ['text', 'json', 'full-json']) {
      for (const ref of ['FDEMO', `${reference}/m1`, `${reference}/m9999`]) {
        expect(parseCLI(['read-media', ref, `--format=${format}`, '--lock-timeout=0'])).toEqual({
          args: ['read-media', ref],
          interaction: 'background',
          format,
          lockTimeout: 0,
        });
      }
    }
  });

  test('rejects invalid references and unsupported flags before native work', () => {
    for (const args of [
      [],
      ['FDEMO', 'FEXTRA'],
      [''],
      ['F'],
      ['FDEMO\n'],
      [' FDEMO'],
      ['FDEMO;open'],
      [`${reference}/p1`],
      [`${reference}/m0`],
      [`${reference}/m01`],
      [`${reference}/m10000`],
      ['https://demo.slack.com/files/UDEMO/FDEMO/demo.mp4'],
      ['FDEMO', '--pages=1'],
      ['FDEMO', `--before=${reference}`],
      ['FDEMO', `--after=${reference}`],
      ['FDEMO', '--allow-clipboard'],
      ['FDEMO', '--ui'],
      ['FDEMO', '--filter=test'],
      ['FDEMO', '--search=test'],
      ['FDEMO', '--prepare'],
    ]) {
      let failure;
      try {
        parseCLI(['--format=json', 'read-media', ...args]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('json');
    }
  });

  test('shows fuller metadata and observed source actions without claiming content', () => {
    const compact = result();
    const output = formatOutput(compact);
    expect(output).toContain(`Video · Demo recording · [${reference}/m1]`);
    expect(output).toContain('Filename: demo.mp4');
    expect(output).toContain('Description (accessibility): A detailed accessible description.');
    expect(output).toContain('Duration: 4:36');
    expect(output).toContain('Displayed playback position: 0:00');
    expect(output).toContain('Transcript: available in Slack; content not read');
    expect(output).toContain('Quoted from: Original Author');
    expect(output).toContain(`File page: ${compact.media.filePageUrl}`);
    expect(output).toContain(`Download target (observed): ${compact.media.downloadUrl}`);
    expect(output).toContain(`Thumbnail: ${compact.media.thumbnailUrl}`);
    expect(output).toContain(`Source: Example Person · ${reference}`);
    expect(output).toContain(`3 replies · read-thread ${reference}`);
    expect(output).toContain('Metadata only; file contents and transcripts were not read.');
    expect(output).toContain(`Read transcript: read-transcript ${reference}/m1`);
    expect(output).not.toMatch(/save-media|Generated transcript/);
    expect(output.split('\n').length).toBeLessThan(20);
  });

  test('keeps generation offers and unknown metadata distinct', () => {
    const compact = result();
    compact.media.transcript.state = 'generatable';
    expect(formatOutput(compact)).toContain('generation offered in Slack; not generated');
    expect(formatOutput(compact)).not.toContain('read-transcript');
    compact.media.transcript.state = 'unknown';
    expect(formatOutput(compact)).toContain('availability unknown');
    expect(formatOutput(compact)).not.toContain('read-transcript');
    compact.media = { kind: 'file', contentRead: false, ref: 'FDEMO' };
    compact.requested = 'FDEMO';
    const output = formatOutput(compact);
    expect(output).toContain('File · [FDEMO]');
    expect(output).not.toMatch(/Duration:|Transcript:|Filename:|Description/);
  });

  test('keeps available native audio metadata while withholding an explicitly unsupported transcript action', () => {
    const compact = result();
    compact.media.kind = 'audio';
    compact.media.transcript = { state: 'available', navigation: null };
    const output = formatOutput(compact);
    expect(output).toContain('Transcript: available in Slack; content not read');
    expect(output).not.toContain('read-transcript');
    expect(JSON.parse(formatOutput(compact, 'json')).media.transcript).toEqual({
      state: 'available',
      navigation: null,
    });
    const receipt = { operation: 'read-media', resolution: compact, pid: 123 };
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
    delete compact.media.transcript.navigation;
    expect(formatOutput(compact)).toContain(`Read transcript: read-transcript ${reference}/m1`);
  });

  test('preserves inferred source attribution in text and JSON', () => {
    const compact = result();
    compact.sources[0].authorInferred = true;
    compact.sources[0].authorSourceMessageId = 'message-list_1700000000.000000';
    expect(formatOutput(compact)).toContain('Source: Example Person (inferred)');
    expect(JSON.parse(formatOutput(compact, 'json')).sources[0]).toMatchObject({
      author: 'Example Person',
      authorInferred: true,
      authorSourceMessageId: 'message-list_1700000000.000000',
    });
  });

  test('retains distinct quoted provenance with each source and verifies thread actions', () => {
    const compact = result();
    compact.media.provenance = null;
    compact.sources[0].provenance = [
      {
        kind: 'quoted',
        author: 'Quoted Author',
        permalink: 'https://demo.slack.com/archives/CDEMO/p1700000000000002',
      },
    ];
    compact.sources.push({
      ...compact.sources[0],
      author: 'Second Person',
      provenance: [{ kind: 'quoted', author: 'Another Author' }],
      thread: null,
    });
    expect(formatOutput(compact)).toContain('Quoted from: Quoted Author');
    expect(formatOutput(compact)).toContain('Quoted from: Another Author');
    compact.sources[0].thread.navigation.command = 'save-media';
    expect(formatOutput(compact)).not.toContain('read-thread');
    compact.sources[0].thread.navigation = {
      command: 'read-thread',
      args: ['COTHER:1700000000.000002'],
    };
    expect(formatOutput(compact)).not.toContain('read-thread');
  });

  test('bounds detail and sources while JSON preserves every captured observation', () => {
    const compact = result();
    compact.media.description = 'd'.repeat(1500);
    compact.sources = Array.from({ length: 8 }, (_, index) => ({
      ...compact.sources[0],
      author: `Author ${index}`,
    }));
    const output = formatOutput(compact);
    expect(output).not.toContain('d'.repeat(1200));
    expect(output).toContain('2 additional sources omitted.');
    expect(output).not.toContain('Author 6');
    expect(output).toContain('Some details were shortened or omitted; use --format=json');
    expect(output.match(/read-thread/g)).toHaveLength(1);
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.media).toEqual(compact.media);
    expect(json.sources).toEqual(compact.sources);
    expect(json.navigation).toEqual(compact.navigation);
    expect(json.coverage.contentRead).toBe(false);
    const receipt = { operation: 'read-media', content: { nodes: [{ label: 'raw' }] } };
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
  });

  test('sanitizes text and rejects unsafe URL and navigation hints', () => {
    const compact = result();
    compact.requested = 'FDEMO\n--malicious';
    compact.media.label = '\x1b[31mName\x1b[0m\u202e\nfile';
    compact.media.description = '\x1b]8;;https://evil.example\x1b\\Safe\x1b]8;;\x1b\\';
    compact.media.filePageUrl = 'javascript:alert(1)';
    compact.media.downloadUrl = 'https://user:secret@example.test/file';
    compact.media.thumbnailUrl = `https://example.test/${'x'.repeat(600)}`;
    compact.sources[0].thread.ref = `${reference}\nInjected`;
    compact.sources[0].permalink = 'https://example.test/\x1b[2J';
    compact.sources[0].author = 'Source\u2066\nPerson';
    compact.navigation = [{ command: 'save-media', args: ['FDEMO'] }];
    const output = formatOutput(compact);
    expect(output).toContain('Video · Name file');
    expect(output).toContain('Description (accessibility): Safe');
    expect(output).toContain('Source: Source Person');
    expect(output).not.toMatch(/read-thread|save-media|malicious|Injected|secret|evil.example/);
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    expect(output).toContain('Some details were shortened or omitted');
  });
});

describe('read-transcript command', () => {
  const ref = 'CDEMO:1700000000.000001/m1';
  const result = () => ({
    schemaVersion: 1,
    operation: 'read-transcript',
    status: 'ok',
    requested: ref,
    workspace: { name: 'Example Workspace' },
    media: { kind: 'video', label: 'Demo recording', ref, contentRead: false },
    transcript: {
      segments: [
        { timestamp: '2 seconds', text: 'First line.\nSecond line.' },
        { timestamp: '1 minute, 3 seconds', text: 'A later segment.' },
      ],
      text: 'First line.\nSecond line.\nA later segment.',
      contentRead: true,
    },
    sources: [
      {
        messageRef: 'CDEMO:1700000000.000001',
        author: 'Example Person',
        permalink: 'https://demo.slack.com/archives/CDEMO/p1700000000000001',
      },
    ],
    coverage: { scope: 'exposed existing transcript', complete: false },
  });
  const collection = (stopReason = 'page-limit') => {
    const compact = result();
    compact.coverage.segmentCount = compact.transcript.segments.length;
    compact.pagination = {
      supported: true,
      direction: 'down',
      hasMore: null,
      capturedCount: 3,
      returnedCount: 2,
      scrollAttempts: 1,
      batch: {
        requestedPages: 2,
        completedPages: 2,
        attemptedPages: 2,
        direction: 'down',
        stopReason,
        deduplicatedCount: 1,
      },
    };
    return compact;
  };

  test('accepts file and message media references in every format', () => {
    for (const reference of ['FDEMO', ref])
      for (const format of ['text', 'json', 'full-json'])
        expect(
          parseCLI(['read-transcript', reference, `--format=${format}`, '--lock-timeout=0'])
        ).toEqual({
          interaction: 'background',
          args: ['read-transcript', reference],
          format,
          lockTimeout: 0,
        });
  });

  test('accepts a bounded transcript page budget without changing reference or format', () => {
    for (const reference of ['FDEMO', ref])
      for (const format of ['text', 'json', 'full-json'])
        for (let pages = 1; pages <= 10; pages++) {
          const expected = {
            args: ['read-transcript', reference],
            interaction: 'background',
            format,
            pages,
            lockTimeout: 0,
          };
          expect(
            parseCLI([
              'read-transcript',
              reference,
              `--pages=${pages}`,
              `--format=${format}`,
              '--lock-timeout=0',
            ])
          ).toEqual(expected);
          expect(
            parseCLI([
              `--pages=${pages}`,
              `--format=${format}`,
              '--lock-timeout=0',
              'read-transcript',
              '--',
              reference,
            ])
          ).toEqual(expected);
        }
  });

  test('rejects noncanonical or repeated transcript page counts and keeps navigation flags out', () => {
    for (const flags of [
      ['--pages=0'],
      ['--pages=11'],
      ['--pages=01'],
      ['--pages=-1'],
      ['--pages=1.5'],
      ['--pages=2.0'],
      ['--pages=1e1'],
      ['--pages='],
      ['--pages= 2'],
      ['--pages=2\n'],
      ['--pages=1', '--pages=1'],
      ['--pages=1', '--pages=2'],
      ['--pages=2', '--before=CDEMO:1700000000.000001'],
      ['--pages=2', '--after=CDEMO:1700000000.000001'],
      ['--pages=2', '--allow-clipboard'],
      ['--pages=2', '--ui'],
      ['--pages=2', '--filter=demo'],
      ['--pages=2', '--search=demo'],
      ['--pages=2', '--prepare'],
      ['--pages=2', '--limit=40'],
      ['--pages=2', '--depth=3'],
    ])
      expect(() => parseCLI(['read-transcript', ref, ...flags])).toThrow();
    expect(() => parseCLI(['read-transcript', '--pages=2'])).toThrow();
    expect(() => parseCLI(['read-transcript', ref, 'FEXTRA', '--pages=2'])).toThrow();
    expect(() => parseCLI(['read-transcript', '--pages=2', '--', '--pages=3'])).toThrow();
    expect(() => parseCLI(['read-transcript', ref, '--', '--pages=2'])).toThrow();
    expect(() => parseCLI(['read-media', ref, '--pages=1'])).toThrow();
  });

  test('rejects malformed and preview references and unsupported navigation flags', () => {
    for (const args of [
      [],
      [ref, 'FEXTRA'],
      [''],
      ['F'],
      ['FDEMO\n'],
      ['Fdemo'],
      [' FDEMO'],
      ['https://demo.slack.com/files/UDEMO/FDEMO/video.mp4'],
      ['CDEMO:1700000000.000001/p1'],
      ['CDEMO:1700000000.000001'],
      ['CDEMO:1700000000.000001/m0'],
      ['CDEMO:1700000000.000001/m10000'],
      [ref, '--before=CDEMO:1700000000.000001'],
      [ref, '--after=CDEMO:1700000000.000001'],
      [ref, '--allow-clipboard'],
      [ref, '--search=demo'],
      [ref, '--filter=demo'],
      [ref, '--ui'],
      [ref, '--prepare'],
    ]) {
      let failure;
      try {
        parseCLI(['--format=json', 'read-transcript', ...args]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.exitCode).toBe(2);
      expect(failure.format).toBe('json');
    }
  });

  test('renders observed timestamp labels and text with source context and coverage', () => {
    const compact = result();
    compact.sources[0].authorInferred = true;
    const output = formatOutput(compact);
    expect(output).toContain(`Transcript · Video · Demo recording · [${ref}]`);
    expect(output).toContain('2 seconds · First line.\nSecond line.');
    expect(output).toContain('1 minute, 3 seconds · A later segment.');
    expect(output).toContain('Source: Example Person (inferred) · CDEMO:1700000000.000001');
    expect(output).toContain('2 captured transcript segments; completeness unknown.');
    expect(output).toContain(
      'Refresh attachment reference: inspect, then follow its read-media hint.'
    );
    expect(output).not.toMatch(/complete transcript|generated|playback|read-transcript/);
  });

  test('summarizes transcript collections without implying the end or offering cursors', () => {
    for (const [stopReason, expected] of [
      ['page-limit', 'Requested page limit reached'],
      ['no-progress', 'No new segments were verified'],
      ['error', 'The next page could not be verified'],
      ['time-limit', 'Collection time limit reached'],
    ]) {
      const compact = collection(stopReason);
      const output = formatOutput(compact);
      expect(output).toContain('2 seconds · First line.\nSecond line.');
      expect(output).toContain(
        '2 unique transcript segments across 2 of 2 requested pages; 1 repeated observation removed.'
      );
      expect(output).toContain(`${expected}; completeness unknown.`);
      expect(output).toContain(
        'Refresh attachment reference: inspect, then follow its read-media hint.'
      );
      expect(output).not.toMatch(
        /--before|--after|read-transcript|all segments|complete transcript|end of/
      );
      const json = JSON.parse(formatOutput(compact, 'json'));
      expect(json.status).toBe('ok');
      expect(json.pagination).toEqual(compact.pagination);
      expect(json.coverage.complete).toBe(false);
      expect(json.transcript).toEqual(compact.transcript);
    }
    const single = result();
    expect(formatOutput(single)).toContain('2 captured transcript segments; completeness unknown.');
    expect(JSON.parse(formatOutput(single, 'json'))).not.toHaveProperty('pagination');
  });

  test('refreshes positional transcript references while retaining direct file-ID hints and JSON', () => {
    for (const reference of [ref, 'FDEMO'])
      for (const partial of [false, true]) {
        const compact = partial ? collection('error') : result();
        compact.requested = reference;
        compact.media.ref = reference;
        if (partial) {
          compact.status = 'partial';
          compact.error = 'Later page could not be verified.';
        }
        const before = structuredClone(compact);
        const raw = { operation: 'read-transcript', resolution: compact, nodes: ['diagnostic'] };
        const output = formatOutput(compact);
        if (reference === ref) {
          expect(output).toContain(
            'Refresh attachment reference: inspect, then follow its read-media hint.'
          );
          expect(output).not.toContain(`read-media ${ref}`);
        } else {
          expect(output).toContain('Inspect attachment: read-media FDEMO');
          expect(output).not.toContain('Refresh attachment reference');
        }
        expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(before);
        expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
        expect(compact).toEqual(before);
      }
  });

  test('keeps verified transcript text before partial errors in every output format', () => {
    for (const stopReason of ['error', 'time-limit']) {
      const compact = collection(stopReason);
      compact.status = 'partial';
      compact.error = { message: '\x1b[31mTranscript source changed\x1b[0m\u202e' };
      compact.next = 'Read the source again\nthen use its refreshed media reference.';
      compact.pagination.batch.requestedPages = 3;
      compact.pagination.batch.attemptedPages = 3;
      const output = formatOutput(compact);
      expect(output).toContain('First line.\nSecond line.');
      expect(output).toContain('A later segment.');
      expect(output).toContain('2 unique transcript segments across 2 of 3 requested pages');
      expect(output).toContain('Stopped: Transcript source changed');
      expect(output).toContain(
        'Next: Read the source again then use its refreshed media reference.'
      );
      expect(output.indexOf('A later segment.')).toBeLessThan(output.indexOf('Stopped:'));
      expect(output).not.toMatch(/\x1b|\u202e|--before|--after/);
      const json = JSON.parse(formatOutput(compact, 'json'));
      expect(json.status).toBe('partial');
      expect(json.transcript).toEqual(compact.transcript);
      expect(json.pagination).toEqual(compact.pagination);
      expect(json.error).toEqual(compact.error);
      const raw = {
        operation: 'read-transcript',
        frames: [{ nodes: ['diagnostic'] }],
        resolution: compact,
      };
      expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    }
  });

  test('rejects malformed transcript collection counts and unsupported completion claims', () => {
    for (const [field, values] of [
      ['requestedPages', [undefined, 1, 11, 2.5, '2']],
      ['completedPages', [undefined, 0, 3, 1.5, '2']],
      ['attemptedPages', [undefined, 1, 3, 2.5, '2']],
      ['deduplicatedCount', [undefined, -1, 0, 2, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]],
      ['direction', ['up', 'older', 'newer', 'next', 'down\n']],
      ['stopReason', ['no-next-page', 'done', 'page-limit\n']],
    ])
      for (const value of values) {
        const compact = collection();
        compact.pagination.batch[field] = value;
        expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
      }
    for (const [field, values] of [
      ['capturedCount', [undefined, -1, 2, 4, 3.5, '3', Number.MAX_SAFE_INTEGER + 1]],
      ['returnedCount', [undefined, -1, 1, 3, 2.5, '2', Number.MAX_SAFE_INTEGER + 1]],
      ['scrollAttempts', [undefined, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]],
      ['direction', [undefined, 'up', 'older']],
      ['hasMore', [undefined, true, false]],
      ['supported', [undefined, false]],
    ])
      for (const value of values) {
        const compact = collection();
        compact.pagination[field] = value;
        expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
      }
    for (const [field, values] of [
      ['segmentCount', [undefined, 0, 1, 3, '2']],
      ['complete', [undefined, true]],
    ])
      for (const value of values) {
        const compact = collection();
        compact.coverage[field] = value;
        expect(() => formatOutput(compact)).toThrow('Multi-page summary is invalid');
      }
  });

  test('bounds the whole transcript collection while JSON retains every verified segment', () => {
    for (const hugeText of [false, true]) {
      const compact = collection('no-progress');
      compact.transcript.segments = Array.from({ length: 45 }, (_, index) => ({
        timestamp: `${index} seconds`,
        text: hugeText && index === 0 ? '🦉'.repeat(7000) : `Segment ${index}.`,
      }));
      compact.transcript.text = compact.transcript.segments.map(({ text }) => text).join('\n');
      compact.coverage.segmentCount = 45;
      compact.pagination.returnedCount = 45;
      compact.pagination.capturedCount = 50;
      compact.pagination.batch.deduplicatedCount = 5;
      const output = formatOutput(compact);
      expect(output).toContain(
        '45 unique transcript segments across 2 of 2 requested pages; 5 repeated observations removed.'
      );
      expect(output).toContain('Use --format=json for every captured segment and its full text.');
      expect(output).not.toContain('40 seconds · Segment 40.');
      expect(output).toContain(
        hugeText
          ? '44 additional transcript segments omitted'
          : '5 additional transcript segments omitted'
      );
      if (hugeText) {
        expect(output).toContain('Transcript text was shortened.');
        expect(Array.from(output).length).toBeLessThan(7000);
        expect(output).not.toContain('1 seconds · Segment 1.');
      } else expect(output).toContain('39 seconds · Segment 39.');
      expect(JSON.parse(formatOutput(compact, 'json')).transcript).toEqual(compact.transcript);
    }
  });

  test('caps displayed segments while JSON keeps all captured content', () => {
    const compact = result();
    compact.transcript.segments = Array.from({ length: 45 }, (_, i) => ({
      timestamp: `${i} seconds`,
      text: `Segment ${i}.`,
    }));
    const output = formatOutput(compact);
    expect(output).toContain('39 seconds · Segment 39.');
    expect(output).not.toContain('40 seconds · Segment 40.');
    expect(output).toContain('5 additional transcript segments omitted from text.');
    expect(output).toContain('Use --format=json for every captured segment and its full text.');
    expect(JSON.parse(formatOutput(compact, 'json')).transcript.segments).toEqual(
      compact.transcript.segments
    );
  });

  test('caps transcript text by Unicode characters, including one huge segment', () => {
    const compact = result();
    compact.transcript.segments = [
      { timestamp: '2 seconds', text: '🦉'.repeat(7000) },
      { timestamp: '3 seconds', text: 'Later text.' },
    ];
    const output = formatOutput(compact);
    expect(output).toContain('Transcript text was shortened.');
    expect(output).toContain('1 additional transcript segment omitted from text.');
    expect(output).not.toContain('Later text.');
    expect(Array.from(output).length).toBeLessThan(7000);
    expect(output).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(JSON.parse(formatOutput(compact, 'json')).transcript.segments[0].text).toHaveLength(
      14000
    );
  });

  test('sanitizes terminal controls and untrusted labels but preserves semantic text', () => {
    const compact = result();
    compact.media.label = '\x1b[31mRecording\x1b[0m\u202e';
    compact.transcript.segments[0] = {
      timestamp: '2 seconds\nInjected',
      text: '\x1b]8;;https://evil.example\x1b\\Safe\x1b]8;;\x1b\\\nText\u202e',
    };
    compact.sources[0].permalink = 'https://user:secret@example.test/file';
    compact.requested = `${ref}\nopen /tmp/nope`;
    const output = formatOutput(compact);
    expect(output).not.toMatch(/\x1b|\u202e|evil.example|secret|open \/tmp|read-media/);
    expect(output).toContain('2 seconds Injected · Safe\nText');
    expect(JSON.parse(formatOutput(compact, 'json')).transcript).toEqual(compact.transcript);
  });

  test('preserves full diagnostics and stopped status without exposing transcript as success', () => {
    const compact = result();
    const raw = {
      operation: 'read-transcript',
      transcript: { content: { nodes: [{ label: 'raw' }] } },
      resolution: compact,
    };
    expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    const stopped = {
      ...compact,
      status: 'stopped',
      error: 'Selected media changed',
      next: 'Reread the source.',
    };
    expect(formatOutput(stopped)).toContain('Stopped: Selected media changed');
    expect(formatOutput(stopped)).not.toContain('First line.');
    expect(JSON.parse(formatOutput(stopped, 'json')).status).toBe('stopped');
  });

  test('never offers reading for images, previews, malformed refs or generation-only controls', () => {
    for (const kind of ['audio', 'video', 'image', 'file'])
      for (const state of ['available', 'generatable', 'unknown']) {
        const media = { kind, label: 'Sample', ref: 'FDEMO', transcript: { state } };
        const compact = {
          ...base(),
          messages: [
            {
              ...message(1),
              attachments: [media],
              previews: [{ ...media, ref: 'CDEMO:1700000000.000001/p1' }],
            },
          ],
        };
        const output = formatOutput(compact);
        const expected = ['audio', 'video'].includes(kind) && state === 'available';
        expect(output.includes('read-transcript FDEMO')).toBe(expected);
        expect(output).not.toContain('read-transcript CDEMO:1700000000.000001/p1');
      }
    const compact = result();
    compact.operation = 'read-media';
    compact.media.transcript = { state: 'available' };
    compact.media.ref = 'FOTHER';
    expect(formatOutput(compact)).not.toContain('read-transcript');
  });
});

describe('rich-media output', () => {
  test.each(['read-channel', 'search', 'read-thread'])(
    '%s retains availability while explicit null navigation withholds the transcript command',
    (operation) => {
      const compact = operation === 'read-thread' ? threadResult(1) : { ...base(), operation };
      const item = operation === 'read-thread' ? compact.thread.replies[0] : compact.messages[0];
      item.attachments = [
        {
          kind: 'audio',
          label: 'Audio clip',
          ref: 'FAUDIO',
          transcript: { state: 'available', navigation: null },
        },
      ];
      if (operation === 'search') compact.search = { query: 'audio' };
      const output = formatOutput(compact);
      expect(output).toContain('transcript available');
      expect(output).toContain('read-media FAUDIO');
      expect(output).not.toContain('read-transcript');
      const json = JSON.parse(formatOutput(compact, 'json'));
      const jsonItem = operation === 'read-thread' ? json.thread.replies[0] : json.messages[0];
      expect(jsonItem.attachments[0].transcript).toEqual({ state: 'available', navigation: null });
      item.attachments[0].transcript.navigation = { command: 'read-transcript', args: ['FAUDIO'] };
      expect(formatOutput(compact)).toContain('read-transcript FAUDIO');
      delete item.attachments[0].transcript.navigation;
      expect(formatOutput(compact)).toContain('read-transcript FAUDIO');
    }
  );
  const mediaRef = 'CDEMO:1700000000.000001';
  const image = () => ({
    kind: 'image',
    label: 'diagram.png',
    ref: 'FIMAGE1',
    fileId: 'FIMAGE1',
    referenceScope: 'workspace-file',
    url: 'https://files.slack.com/files-pri/TDEMO-FIMAGE1/diagram.png',
    thumbnailUrl: 'https://files.slack.com/files-tmb/TDEMO-FIMAGE1/diagram_1024.png',
    description: 'A diagram showing three connected boxes.',
    descriptionSource: 'accessibility',
    contentRead: false,
  });
  const video = () => ({
    kind: 'video',
    label: 'demo.mp4',
    ref: `${mediaRef}/m2`,
    fileId: null,
    referenceScope: 'message-media',
    url: null,
    displayedDuration: '4:36',
    transcript: { state: 'available' },
    contentRead: false,
  });
  const preview = () => ({
    kind: 'video',
    title: 'External tutorial',
    description: 'A published walkthrough.',
    url: 'https://video.example.test/watch/demo',
    ref: `${mediaRef}/p1`,
    contentRead: false,
  });

  test('renders named media and short references alongside authored text and thread hints', () => {
    for (const operation of ['read-channel', 'read-dm', 'search']) {
      const compact = {
        ...base(),
        operation,
        ...(operation === 'search' ? { search: { query: 'demo', totalResults: 1 } } : {}),
        messages: [
          {
            ...message(1),
            attachments: [image(), video()],
            previews: [preview()],
            thread: { ref: mediaRef, replyCount: 2 },
          },
        ],
      };
      const output = formatOutput(compact);
      expect(output).toContain('Message body 1.');
      expect(output).toContain('Image · diagram.png');
      expect(output).toContain(
        'Description (accessibility): A diagram showing three connected boxes.'
      );
      expect(output).toContain('read-media FIMAGE1');
      expect(output).toContain(
        `Video · demo.mp4 · 4:36 · transcript available · read-media ${mediaRef}/m2`
      );
      expect(output).toContain(`Preview · Video · External tutorial`);
      expect(output).toContain(`[${mediaRef}/p1]`);
      expect(output).toContain(`2 replies · read-thread ${mediaRef}`);
      expect(output).toContain(
        'Media metadata only; file contents and external preview targets were not read.'
      );
      expect(output).toContain('Use --format=json for media URLs and full metadata');
      expect(output).toContain(`read-transcript ${mediaRef}/m2`);
      expect(output).not.toContain('save-media');
      expect(output).not.toContain('files-tmb');
    }
  });

  test('keeps observed generation offers distinct from available or unknown transcripts', () => {
    const compact = base();
    compact.messages = [
      {
        ...message(1),
        attachments: [
          { ...video(), kind: 'audio', label: 'voice.m4a', transcript: { state: 'generatable' } },
          { ...video(), label: 'unknown.mp4', transcript: { state: 'unknown' } },
        ],
      },
    ];
    const output = formatOutput(compact);
    expect(output).toContain('Audio · voice.m4a · 4:36 · transcript generation offered');
    expect(output).not.toContain('transcript available');
    expect(output).not.toContain('transcript unavailable');
    expect(output).not.toContain('Generate transcript');
    expect(output).not.toContain('read-transcript');
  });

  test('bounds combined media records and text fields with explicit JSON recovery', () => {
    const compact = base();
    compact.messages = [
      {
        ...message(1),
        attachments: [
          { ...image(), label: '🙂'.repeat(130), description: '🦊'.repeat(150) },
          { ...video(), displayedDuration: 'd'.repeat(50) },
          { kind: 'document', label: 'report.pdf', provenance: { author: 'A'.repeat(90) } },
        ],
        previews: [
          preview(),
          { ...preview(), title: 'Hidden preview' },
          { ...preview(), title: 'Another hidden preview' },
        ],
      },
    ];
    const output = formatOutput(compact);
    const imageLine = output.split('\n').find((line) => line.trimStart().startsWith('Image · '));
    expect(imageLine).toContain(`${'🙂'.repeat(119)}…`);
    expect(imageLine).toContain(`${'🦊'.repeat(139)}…`);
    expect(output).toContain(`${'d'.repeat(39)}…`);
    expect(output).toContain(`quoted from ${'A'.repeat(79)}…`);
    expect(output).toContain('2 additional media items omitted.');
    expect(output).not.toContain('Hidden preview');
    expect(output).not.toContain('Another hidden preview');
    expect(output).toContain('media metadata was shortened or omitted; use --format=json');
    expect(output).not.toContain('1 message shortened to 500 characters.');
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.messages[0].attachments).toEqual(compact.messages[0].attachments);
    expect(json.messages[0].previews).toHaveLength(3);
  });

  test('sanitizes all media fields and withholds malformed or cross-kind references', () => {
    for (const ref of [
      'FIMAGE1\nInjected',
      'FIMAGE1\x1b[2J',
      'FIMAGE1;open',
      `${mediaRef}/m0`,
      `${mediaRef}/m10000`,
      `${mediaRef}/p1`,
      'https://example.test/file',
      'CDEMO:not-a-timestamp/m1',
    ]) {
      const compact = base();
      compact.messages = [
        {
          ...message(1),
          attachments: [
            {
              ...image(),
              ref,
              label: '\x1b[31mfile\x1b[0m\nname\u202e\uE000.png\uE001',
              description: '\x1b]8;;https://evil.example\x1b\\Safe\x1b]8;;\x1b\\',
              displayedDuration: '\x1b[2J0:12',
              provenance: { author: '\u2066Original\u2069\nSender' },
            },
          ],
        },
      ];
      const output = formatOutput(compact);
      expect(output).toContain('Image · file name.png · 0:12');
      expect(output).toContain('quoted from Original Sender');
      expect(output).toContain('Description (accessibility): Safe');
      expect(output).not.toContain(`[${ref}]`);
      expect(output).not.toContain(`read-media ${ref}`);
      expect(output).not.toContain('Injected');
      expect(output).not.toContain('evil.example');
      expect(output).not.toMatch(
        /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\uE000\uE001]/
      );
    }
    const compact = base();
    compact.messages = [{ ...message(1), previews: [{ ...preview(), ref: 'FIMAGE1' }] }];
    expect(formatOutput(compact)).not.toContain('[FIMAGE1]');
  });

  test('shows quoted source text and media provenance separately, bounded within threads', () => {
    const compact = threadResult(1);
    compact.thread.root.attachments = [image()];
    compact.thread.replies[0].quotedMessages = [
      {
        author: 'Original Author',
        text: 'Quoted body.',
        permalink: 'https://demo.slack.com/archives/CDEMO/p1700000000000002',
      },
      { author: 'Second Author', text: 'q'.repeat(230) },
      { author: 'Hidden Author', text: 'Hidden quote' },
    ];
    compact.thread.replies[0].attachments = [
      { ...video(), provenance: { kind: 'quoted', author: 'Original Author' } },
    ];
    const output = formatOutput(compact);
    expect(output).toContain('Distinct root message.');
    expect(output).toContain('Image · diagram.png');
    expect(output).toContain('Message body 1.');
    expect(output).toContain('Quoted · Original Author: Quoted body.');
    expect(output).toContain(`Quoted · Second Author: ${'q'.repeat(219)}…`);
    expect(output).toContain('1 additional quote omitted.');
    expect(output).not.toContain('Hidden quote');
    expect(output).toContain('quoted from Original Author');
    expect(output.match(/Quoted content or media metadata was shortened or omitted/g)).toHaveLength(
      1
    );
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.thread.replies[0].quotedMessages).toEqual(compact.thread.replies[0].quotedMessages);
    expect(json.thread.replies[0].attachments).toEqual(compact.thread.replies[0].attachments);
  });

  test('retains full captured media metadata in JSON and untouched native diagnostics in full-json', () => {
    const compact = base();
    compact.messages = [{ ...message(1), attachments: [image(), video()], previews: [preview()] }];
    const receipt = {
      content: { nodes: [{ role: 'AXImage', label: '\x1b[2Jraw image label' }] },
      desktop: { foregroundPid: 123 },
    };
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.messages[0].attachments).toEqual(compact.messages[0].attachments);
    expect(json.messages[0].previews).toEqual(compact.messages[0].previews);
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
    expect(compact.messages[0].attachments[0].contentRead).toBe(false);
  });

  test('keeps media references on later collected pages without changing message or search bounds', () => {
    for (const operation of ['read-channel', 'read-dm', 'search']) {
      const count = operation === 'search' ? 24 : 20;
      const compact = {
        ...base(),
        operation,
        ...(operation === 'search' ? { search: { query: 'files', totalResults: 24 } } : {}),
        messages: messages(count).map((item, index) => ({
          ...item,
          attachments: [{ ...image(), label: `file-${index + 1}.png`, ref: `FFILE${index + 1}` }],
        })),
        pagination: {
          supported: true,
          status: 'page',
          hasMore: null,
          batch: {
            requestedPages: 2,
            completedPages: 2,
            attemptedPages: 2,
            direction: operation === 'search' ? 'next' : 'older',
            stopReason: 'page-limit',
            deduplicatedCount: 2,
          },
        },
      };
      const output = formatOutput(compact);
      expect(output).toContain('Image · file-1.png');
      expect(output).toContain('Image · file-20.png');
      expect(output).toContain('read-media FFILE20');
      expect(output).not.toContain('file-21.png');
      expect(output.match(/read-media FFILE\d+/g)).toHaveLength(20);
      const json = JSON.parse(formatOutput(compact, 'json'));
      expect(json.messages).toHaveLength(count);
      expect(json.messages.at(-1).attachments[0].ref).toBe(`FFILE${count}`);
    }
  });
});

describe('save-media CLI and receipts', () => {
  test('requires one media reference and an explicit output path in each format', () => {
    for (const format of ['text', 'json', 'full-json']) {
      expect(
        parseCLI(['--format=' + format, 'save-media', 'F012ABC', '--output=clips/音声 = 1.mp4'])
      ).toEqual({
        args: ['save-media', 'F012ABC'],
        interaction: 'background',
        format,
        output: 'clips/音声 = 1.mp4',
        originalRequired: false,
      });
    }
    for (const args of [
      ['save-media', 'F012ABC'],
      ['save-media', 'F012ABC', '--output='],
      ['save-media', 'F012ABC', '--output=one', '--output=two'],
      ['save-media', 'F012ABC', '--output=bad\nfile'],
      ['save-media', 'F012ABC', '--output=' + 'x'.repeat(4097)],
      ['save-media', 'CABC:1700000000.000001/p1', '--output=file'],
      ['read-media', 'F012ABC', '--output=file'],
      ['save-media', 'F012ABC', '--output=file', '--original', '--original'],
      ['save-media', 'F012ABC', '--output=file', '--original=true'],
      ['read-media', 'F012ABC', '--original'],
      ['search', 'original', '--original'],
      ...[
        '--pages=1',
        '--after=CABC:1700000000.000001',
        '--allow-clipboard',
        '--ui',
        '--search=x',
        '--filter=x',
      ].map((flag) => ['save-media', 'F012ABC', '--output=file', flag]),
    ])
      expect(() => parseCLI(args)).toThrow();
  });
  test('requires original-route selection only for the explicit save option', () => {
    for (const format of ['text', 'json', 'full-json']) {
      expect(
        parseCLI(['--original', 'save-media', 'F012ABC', '--output=file', `--format=${format}`])
      ).toEqual({
        args: ['save-media', 'F012ABC'],
        interaction: 'background',
        format,
        output: 'file',
        originalRequired: true,
      });
    }
    expect(parseCLI(['search', '--', '--original'])).toEqual({
      args: ['search', '--original'],
      interaction: 'background',
      format: 'text',
    });
  });
  test('names selected file-download and fallback evidence without claiming original bytes', () => {
    for (const published of [true, null]) {
      const compact = {
        schemaVersion: 1,
        operation: 'save-media',
        status: published ? 'ok' : 'stopped',
        saved: {
          path: '/tmp/attachment.bin',
          published,
          verified: published === true,
          bytes: 120,
          representation: 'slack-file-download',
          originalSelection: {
            status: 'selected',
            basis: 'source-bound-private-file-download',
          },
          originalFile: null,
        },
        coverage: { originalFileVerified: null },
      };
      const text = formatOutput(compact);
      expect(text).toContain(
        'Original download route selected; uploaded-byte identity remains unknown.'
      );
      if (published) expect(text).toContain('120 bytes · Slack file download');
      else expect(text).toContain('Publication uncertain; inspect: /tmp/attachment.bin');
      expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
      const raw = { native: true, resolution: compact };
      expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
      const fallback = {
        ...compact,
        saved: {
          ...compact.saved,
          representation: 'observed-download-target',
          originalSelection: { status: 'unavailable', basis: 'observed-download-target' },
        },
      };
      expect(formatOutput(fallback)).toContain(
        'Original download route unavailable; observed Download target selected.'
      );
      expect(formatOutput(fallback)).not.toContain('Slack file download');
    }
  });
  test('keeps saved path and checksum concise while JSON retains the semantic result', () => {
    const compact = {
      schemaVersion: 1,
      operation: 'save-media',
      status: 'ok',
      requested: 'F012ABC',
      saved: {
        path: '/tmp/clip.mp4',
        published: true,
        verified: true,
        bytes: 120,
        sha256: 'a'.repeat(64),
        originalFile: null,
      },
      coverage: { contentInterpreted: false },
    };
    expect(formatOutput(compact)).toBe(
      'Saved: /tmp/clip.mp4\n120 bytes · Slack Download target\nSHA-256: ' + 'a'.repeat(64)
    );
    expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
    expect(
      JSON.parse(formatOutput(compact, 'full-json', { native: true, resolution: compact }))
    ).toEqual({ native: true, resolution: compact });
    const failure = {
      ...compact,
      status: 'stopped',
      error: 'Source changed',
      downloadMayHaveStarted: true,
    };
    expect(formatOutput(failure)).toContain('Saved: /tmp/clip.mp4');
    expect(formatOutput(failure)).toContain('Stopped: Source changed');
    expect(
      formatOutput({
        ...failure,
        saved: { path: '/tmp/clip.mp4', published: null, verified: false },
      })
    ).toContain('Publication uncertain; inspect: /tmp/clip.mp4');
    expect(
      formatOutput({
        ...failure,
        saved: { path: '/tmp/clip.mp4', published: true, verified: false },
      })
    ).toContain('Published; verification incomplete: /tmp/clip.mp4');
    expect(
      formatOutput({
        ...failure,
        error: 'bad\u001b[31m value',
        saved: { path: '/tmp/\nnew', published: true, verified: true },
      })
    ).not.toContain('\u001b');
  });
});

test('viewer saves name the observed target and preserve separate opening uncertainty', () => {
  const compact = {
    schemaVersion: 1,
    operation: 'save-media',
    status: 'ok',
    saved: {
      path: '/tmp/viewer-image.bin',
      published: true,
      verified: true,
      bytes: 120,
      representation: 'observed-viewer-download',
      originalSelection: { status: 'unavailable', basis: 'viewer-download-route-unexposed' },
      originalFile: null,
    },
    viewerMayHaveOpened: true,
    viewer: { opened: true, closed: true },
  };
  expect(formatOutput(compact)).toContain('120 bytes · Slack file viewer Download');
  expect(formatOutput(compact)).toContain(
    'Original route was not exposed; viewer Download target selected.'
  );
  expect(formatOutput(compact)).not.toContain('may be open');
  expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
  const raw = { phase: 'result', resolution: compact };
  expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
  const stopped = {
    schemaVersion: 1,
    operation: 'save-media',
    status: 'stopped',
    error: 'Viewer identity changed',
    viewerMayHaveOpened: true,
    downloadMayHaveStarted: false,
    viewer: { opened: null, closed: null },
  };
  expect(formatOutput(stopped)).toContain('file viewer may be open');
  expect(formatOutput(stopped)).not.toContain('may have started a download');
  expect(formatOutput(stopped)).not.toContain('Saved:');
  expect(JSON.parse(formatOutput(stopped, 'json'))).toEqual(stopped);
  expect(formatOutput({ ...stopped, viewer: { opened: true, closed: true } })).not.toContain(
    'may be open'
  );
});

test.each([
  ['closed', true, 'Viewer cleanup: closed.'],
  ['withheld', false, 'Viewer cleanup: withheld.'],
  ['unverified', false, 'Viewer cleanup: closure unverified.'],
])(
  'viewer refusal reports %s cleanup and bounded diagnostics in every format',
  (status, closed, line) => {
    const failure = {
      phase: 'viewer-capture',
      reason: 'source-url-mismatch',
      capturedAt: '2026-11-15T14:42:25Z',
      captureComplete: false,
      sourceVerifiedAtCaptureStart: true,
      windowVerifiedAtCaptureStart: true,
      activeImageCount: 2,
      images: [
        {
          index: 4,
          parent: 3,
          role: 'AXImage',
          classes: ['p-file_image'],
          urlPresent: true,
          urlMatchesSource: false,
          fileMatchesSource: true,
          ownerMatchesSource: true,
        },
      ],
    };
    const cleanup = { status, closeAttempted: status !== 'withheld', closed };
    const compact = {
      schemaVersion: 1,
      operation: 'save-media',
      status: 'stopped',
      error: 'Opened viewer image does not match the retained source URL',
      downloadMayHaveStarted: false,
      viewerMayHaveOpened: true,
      viewer: { opened: true, closed, closeAttempted: status !== 'withheld', failure, cleanup },
    };
    const text = formatOutput(compact);
    expect(text).toContain('Viewer check: source-url-mismatch · 2 observed active images');
    expect(text).toContain(line);
    expect(text).not.toMatch(/Saved:|may have started a download|AXImage|p-file_image|https?:/);
    expect(text.includes('file viewer may be open')).toBe(!closed);
    expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
    const raw = {
      phase: 'result',
      viewerFailure: failure,
      viewerCleanup: cleanup,
      resolution: compact,
    };
    expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
  }
);

test.each(['file', 'audio', 'video'])(
  '%s file-details rejection preserves diagnostics and safe cleanup in every format',
  (mediaKind) => {
    const failure = {
      family: 'file-details',
      mediaKind,
      phase: 'opening',
      reason: 'source-matched-download-unavailable',
      capturedAt: 1794755440635,
      captureComplete: true,
      sourceVerifiedAtCaptureStart: true,
      windowVerifiedAtCaptureStart: true,
      cardCount: 1,
      cards: [{ index: 4, role: 'AXGroup', fileMatchesSource: true }],
      identityCount: 1,
      identities: [{ index: 5, fileMatchesSource: true, pageMatchesSource: null }],
      downloadControlCount: 0,
      downloadControls: [],
    };
    for (const closed of [true, false, null]) {
      const cleanup = {
        status: closed === true ? 'closed' : closed === false ? 'withheld' : 'unverified',
        closeAttempted: closed !== false,
        closed: closed === true,
      };
      const compact = {
        operation: 'save-media',
        status: 'stopped',
        error: 'File details opened once but no source-matched Download control verified',
        downloadMayHaveStarted: false,
        viewerMayHaveOpened: true,
        viewer: { opened: true, closed, failure, cleanup },
      };
      const text = formatOutput(compact);
      expect(text).toContain(
        'Viewer check: source-matched-download-unavailable · 1 observed file card'
      );
      expect(text).not.toMatch(/active image|Saved:|AXGroup|may have started a download/);
      expect(text.includes('file viewer may be open')).toBe(closed !== true);
      expect(text.includes('Viewer cleanup: closed.')).toBe(closed === true);
      expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
      const raw = { viewerFailure: failure, viewerCleanup: cleanup, resolution: compact };
      expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    }
  }
);

test.each([null, -1, 1.5, '2'])(
  'file-details diagnostic ignores invalid card count %s',
  (cardCount) => {
    const text = formatOutput({
      operation: 'save-media',
      status: 'stopped',
      viewer: {
        failure: {
          family: 'file-details',
          reason: 'source-check-failed',
          cardCount,
          activeImageCount: 1,
        },
      },
    });
    expect(text).toContain('Viewer check: source-check-failed');
    expect(text).not.toMatch(/observed file card|active image/);
  }
);

test('viewer diagnostic text rejects invalid counts and escapes untrusted reasons', () => {
  const compact = {
    operation: 'save-media',
    status: 'stopped',
    error: 'Viewer check failed',
    viewerMayHaveOpened: true,
    viewer: {
      opened: true,
      closed: null,
      failure: { reason: 'bad\u001b[31m\nreason', activeImageCount: -1 },
      cleanup: { status: 'closed', closeAttempted: true, closed: true },
    },
  };
  const text = formatOutput(compact);
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('observed active image');
  expect(text).toContain('Viewer cleanup: closure unverified.');
  expect(text).toContain('file viewer may be open');
  expect(text).not.toContain('Viewer cleanup: closed.');
});

test('reopened source saves retain navigation evidence without adding text lines', () => {
  const compact = {
    schemaVersion: 1,
    operation: 'save-media',
    status: 'ok',
    requested: 'F012ABC',
    saved: {
      path: '/tmp/reopened-attachment.bin',
      published: true,
      verified: true,
      bytes: 120,
      sha256: 'a'.repeat(64),
      representation: 'slack-file-download',
      originalSelection: {
        status: 'selected',
        basis: 'source-bound-private-file-download',
      },
      originalFile: null,
    },
    sourceMayHaveReopened: true,
    source: { opened: true, messageRef: 'CABC:1700000000.000001' },
  };
  const expectedText = [
    'Saved: /tmp/reopened-attachment.bin',
    '120 bytes · Slack file download',
    `SHA-256: ${'a'.repeat(64)}`,
    'Original download route selected; uploaded-byte identity remains unknown.',
  ].join('\n');
  expect(formatOutput(compact)).toBe(expectedText);
  expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
  const raw = {
    phase: 'result',
    sourceRequest: { workspace: 'TABC', messageRef: compact.source.messageRef },
    sourceAction: { attempted: true, accepted: true, opened: true },
    resolution: compact,
  };
  expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
});

test('stopped source reopening retains known and unknown outcomes with inspection guidance', () => {
  for (const opened of [true, false, null]) {
    for (const messageRef of ['CABC:1700000000.000001', null]) {
      const compact = {
        schemaVersion: 1,
        operation: 'save-media',
        status: 'stopped',
        error: 'Source navigation could not be verified',
        sourceMayHaveReopened: true,
        source: { opened, messageRef },
        downloadMayHaveStarted: false,
        next: 'Inspect Slack before another request; source navigation may have changed the view. Do not replay automatically.',
      };
      expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
      expect(formatOutput(compact)).toBe(`Stopped: ${compact.error}\nNext: ${compact.next}`);
      const raw = { phase: 'result', sourceAction: { opened }, resolution: compact };
      expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    }
  }
});

describe('workspace command parsing and output', () => {
  const workspace = (
    contextId,
    name = 'Example Workspace',
    current = false,
    domain = `${contextId?.toLowerCase()}.slack.com`
  ) => ({
    name,
    contextId,
    id: contextId?.startsWith('T') ? contextId : null,
    domain,
    ref: `workspace:${domain}`,
    current,
    navigation: { command: 'switch-workspace', args: [`workspace:${domain}`] },
  });
  const current = () => ({ name: 'Example Workspace', contextId: 'EEXAMPLE', id: null });
  const listing = () => ({
    schemaVersion: 1,
    operation: 'workspaces',
    status: 'ok',
    workspace: current(),
    workspaces: [workspace('EEXAMPLE', 'Example Workspace', true), workspace('TOTHER', 'Other')],
    coverage: { scope: 'exposed-workspace-switcher', complete: false },
  });

  test('lists, inspects and switches with background defaults and every output format', () => {
    for (const argv of [
      ['workspaces'],
      ['current-workspace'],
      ['switch-workspace', 'Exact Name'],
    ]) {
      for (const format of ['text', 'json', 'full-json']) {
        expect(parseCLI([...argv, `--format=${format}`, '--lock-timeout=5'])).toEqual({
          args: argv,
          interaction: 'background',
          format,
          lockTimeout: 5,
        });
      }
    }
    expect(parseCLI(['switch-workspace', '--', '--literal-name']).args).toEqual([
      'switch-workspace',
      '--literal-name',
    ]);
    expect(parseCLI(['switch-workspace', 'EEXAMPLE', '--interaction=foreground']).interaction).toBe(
      'foreground'
    );
    for (const command of ['workspaces', 'current-workspace'])
      expect(() => parseCLI([command, '--interaction=foreground'])).toThrow();
  });

  test('rejects unsupported flags and command arities before native work', () => {
    for (const argv of [['workspaces'], ['current-workspace'], ['switch-workspace', 'TEXAMPLE']]) {
      for (const flag of [
        '--pages=1',
        '--before=CDEMO:1700000000.000001',
        '--after=CDEMO:1700000000.000001',
        '--ui',
        '--filter=',
        '--limit=1',
        '--depth=1',
        '--prepare',
        '--allow-clipboard',
        '--search=',
        '--original',
        '--output=/tmp/unused',
      ])
        expect(() => parseCLI([...argv, flag])).toThrow();
    }
    for (const argv of [
      ['workspaces', 'extra'],
      ['current-workspace', 'extra'],
      ['switch-workspace'],
      ['switch-workspace', 'One', 'Two'],
    ])
      expect(() => parseCLI(argv)).toThrow();
  });

  test('keeps exact target bytes and bounds Unicode scalar names without controls', () => {
    for (const value of [
      '',
      ' ',
      ' padded',
      'padded ',
      'A\nB',
      'A\tB',
      'A\u202eB',
      'A\u200dB',
      '\ud800',
      '😀'.repeat(201),
    ]) {
      let failure;
      try {
        parseCLI(['--format=json', 'switch-workspace', value]);
      } catch (error) {
        failure = error;
      }
      expect(failure?.exitCode).toBe(2);
      expect(failure?.format).toBe('json');
    }
    for (const value of ['Exact Name', "Name's Workspace", 'Équipe', '😀'.repeat(200)])
      expect(parseCLI(['switch-workspace', value]).args[1]).toBe(value);
  });

  test('renders a bounded exposed listing with current marker and canonical hints', () => {
    const compact = listing();
    expect(formatOutput(compact)).toBe(
      [
        'Workspaces: 2 exposed workspaces',
        '* Example Workspace (EEXAMPLE; eexample.slack.com) [current]',
        '  → switch-workspace workspace:eexample.slack.com',
        '- Other (TOTHER; tother.slack.com)',
        '  → switch-workspace workspace:tother.slack.com',
        'Coverage: exposed workspace switcher; other workspaces may be unavailable.',
      ].join('\n')
    );
    compact.workspaces = Array.from({ length: 35 }, (_, i) => workspace(`T${i}`, `Workspace ${i}`));
    const rendered = formatOutput(compact);
    expect(rendered.match(/→ switch-workspace /g)).toHaveLength(30);
    expect(rendered).toContain('5 more omitted; use --format=json');
    expect(rendered).not.toContain('Workspace 34');
    expect(JSON.parse(formatOutput(compact, 'json')).workspaces).toHaveLength(35);
  });

  test('sanitizes names while refusing invalid or mismatched navigation commands', () => {
    for (const domain of [
      'example.slack.com\n',
      'example.slack.com\r',
      'example.slack.com\u2028',
      'example.slack.com\u2029',
      'EXAMPLE.slack.com',
      '-example.slack.com',
      `${'a'.repeat(64)}.slack.com`,
      'https://example.slack.com',
      'example.slack.com;echo x',
      'example.slack.com.evil.test',
      'extra.example.slack.com',
    ]) {
      const compact = listing();
      compact.workspaces = [workspace(null, '\x1b[31mA\u202e\nB\x1b[0m', false, domain)];
      const rendered = formatOutput(compact);
      expect(rendered).not.toContain('→');
      expect(rendered).not.toMatch(/[\x1b\u202e]/);
      expect(rendered).toContain('A B');
    }
    for (const navigation of [
      undefined,
      { command: 'read-dm', args: ['workspace:tother.slack.com'] },
      { command: 'switch-workspace', args: ['workspace:wrong.slack.com'] },
      { command: 'switch-workspace', args: ['workspace:tother.slack.com', 'extra'] },
      { command: 'switch-workspace', args: ['TOTHER'] },
    ]) {
      const compact = listing();
      compact.workspaces = [{ ...workspace('TOTHER'), navigation }];
      expect(formatOutput(compact)).not.toContain('→');
    }
    for (const ref of [null, 'workspace:wrong.slack.com', 'workspace:tother.slack.com\n']) {
      const compact = listing();
      compact.workspaces = [{ ...workspace('TOTHER'), ref }];
      expect(formatOutput(compact)).not.toContain('→');
    }
  });

  test('exposed domains provide references without inventing inactive context IDs', () => {
    const compact = listing();
    compact.workspaces = [workspace(null, 'Inactive', false, 'demo.enterprise.slack.com')];
    const rendered = formatOutput(compact);
    expect(rendered).toContain('Inactive (demo.enterprise.slack.com)');
    expect(rendered).toContain('switch-workspace workspace:demo.enterprise.slack.com');
    expect(rendered).not.toContain('(null');
    expect(JSON.parse(formatOutput(compact, 'json')).workspaces[0]).toMatchObject({
      id: null,
      contextId: null,
      domain: 'demo.enterprise.slack.com',
    });
  });

  test('distinguishes a verified switch from an already-current no-op', () => {
    const to = { name: 'Other', contextId: 'TOTHER', id: 'TOTHER' };
    for (const changed of [true, false]) {
      const compact = {
        schemaVersion: 1,
        operation: 'switch-workspace',
        status: 'ok',
        workspace: to,
        switch: {
          requested: 'TOTHER',
          attempted: changed,
          changed,
          from: changed ? current() : to,
          to,
        },
      };
      const rendered = formatOutput(compact);
      expect(rendered).toContain(
        changed ? 'Switched workspace: Other (TOTHER)' : 'Already current: Other (TOTHER)'
      );
      expect(rendered.includes('From:')).toBe(changed);
      expect(rendered).toContain('Next: channels · dms · search QUERY');
      expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
    }
    expect(
      formatOutput({ operation: 'current-workspace', status: 'ok', workspace: current() })
    ).toBe('Current workspace: Example Workspace (EEXAMPLE)\nNext: workspaces');
  });

  test('preserves raw receipts and compact workspace fields without diagnostics', () => {
    const compact = listing();
    const raw = {
      ...compact,
      desktop: { samples: [{ foregroundPid: 42 }] },
      rawControl: { role: 'AXPopUpButton' },
    };
    expect(JSON.parse(formatOutput({ ...compact, desktop: raw.desktop }, 'json'))).toEqual(compact);
    expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    expect(formatOutput(compact)).not.toContain('AXPopUpButton');
  });

  test('workspace ambiguity uses workspace candidates and never DM hints', () => {
    const compact = {
      ...listing(),
      operation: 'switch-workspace',
      status: 'ambiguous',
      error: 'Exact workspace name is ambiguous',
      workspaceSwitchMayHaveBeenRequested: false,
      candidates: [workspace('TFIRST', 'Same Name'), workspace('TSECOND', 'Same Name')],
    };
    const rendered = formatOutput(compact);
    expect(rendered).toContain('Stopped: Exact workspace name is ambiguous');
    expect(rendered).toContain('No workspace-switch action was attempted.');
    expect(rendered).toContain('switch-workspace workspace:tfirst.slack.com');
    expect(rendered).toContain('switch-workspace workspace:tsecond.slack.com');
    expect(rendered).not.toContain('read-dm');
    expect(rendered).not.toContain('Switched workspace:');
  });

  test('retains true, false and unknown action uncertainty without claiming success', () => {
    for (const uncertain of [true, false, null]) {
      const compact = {
        schemaVersion: 1,
        operation: 'switch-workspace',
        status: 'stopped',
        error: 'Destination did not verify',
        workspaceSwitchMayHaveBeenRequested: uncertain,
      };
      const rendered = formatOutput(compact);
      expect(rendered).not.toContain('Switched workspace:');
      expect(rendered.includes('may have been requested')).toBe(uncertain === true);
      expect(rendered.includes('No workspace-switch action')).toBe(uncertain === false);
      expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
      expect(JSON.parse(formatOutput(compact, 'full-json', compact))).toEqual(compact);
    }
  });

  test('workspace candidates distinguish observed, JSON-retained and text-shown counts', () => {
    const observed = Array.from({ length: 27 }, (_, i) =>
      workspace(null, `Candidate ${i}`, false, `demo-${i}.slack.com`)
    );
    const compact = {
      schemaVersion: 1,
      operation: 'switch-workspace',
      status: 'not-found',
      error: 'Exact workspace unavailable',
      candidates: observed.slice(0, 20),
      candidateCount: 27,
      candidatesTruncated: true,
      workspaceSwitchMayHaveBeenRequested: false,
    };
    const rendered = formatOutput(compact);
    expect(rendered.match(/→ switch-workspace /g)).toHaveLength(8);
    expect(rendered).toContain(
      'Candidates: showing 8 of 27 observed; --format=json retains 20. Use --format=full-json for the full exposed inventory.'
    );
    expect(rendered).not.toContain('12 more candidates omitted');
    expect(rendered).not.toContain('Candidate 8');
    expect(JSON.parse(formatOutput(compact, 'json')).candidates).toHaveLength(20);
    const native = { operation: 'switch-workspace', status: 'not-found', candidates: observed };
    expect(JSON.parse(formatOutput(compact, 'full-json', native)).candidates).toHaveLength(27);
    const uncapped = {
      ...compact,
      candidates: observed.slice(0, 10),
      candidateCount: 10,
      candidatesTruncated: false,
    };
    expect(formatOutput(uncapped)).toContain(
      'Candidates: showing 8 of 10 observed; use --format=json for all 10 returned candidates.'
    );
    for (const candidateCount of [undefined, -1, 4, NaN]) {
      expect(formatOutput({ ...compact, candidateCount })).toContain(
        'Candidates: showing 8 of at least 20 observed; --format=json retains 20.'
      );
    }
  });

  test('workspace lock owners remain useful in concise and JSON failures', () => {
    for (const operation of ['workspaces', 'current-workspace', 'switch-workspace']) {
      const lock = {
        path: '/tmp/example.lock',
        reason: 'timeout',
        waitedMs: 1000,
        timeoutSeconds: 1,
        ownerStatus: 'known',
        ownerPid: 1234,
        operation,
        acquiredAt: '2026-11-14T00:00:00.000Z',
        processState: 'running',
        scope: 'cooperating helper processes only',
      };
      const compact = {
        operation: 'current-workspace',
        status: 'stopped',
        error: 'Held activity lock',
        lock,
      };
      expect(JSON.parse(formatOutput(compact, 'json')).lock).toEqual(lock);
      expect(formatOutput(compact)).toContain(`owner PID 1234, ${operation}; PID running.`);
    }
  });
});

describe('workspace-scoped read parsing and formatting', () => {
  const ref = 'workspace:scoped.slack.com';
  const flag = `--workspace=${ref}`;
  const identity = {
    name: 'Scoped Workspace',
    contextId: 'TSCOPED',
    id: 'TSCOPED',
    domain: 'scoped.slack.com',
    ref,
  };
  const selected = (changed = false) => ({
    schemaVersion: 1,
    operation: 'switch-workspace',
    status: 'ok',
    workspace: identity,
    switch: {
      requested: ref,
      attempted: changed,
      changed,
      from: changed ? { ...identity, contextId: 'TOTHER', id: 'TOTHER' } : identity,
      to: identity,
    },
  });
  const scoped = (compact, changed = false) => ({
    ...compact,
    workspace: identity,
    requestedWorkspace: ref,
    workspaceSelection: selected(changed),
  });
  const navigation = (command, ...args) => ({ command, args: [...args, flag] });

  test('accepts workspace scope anywhere before the literal separator for supported reads', () => {
    const commands = [
      ['channels'],
      ['dms'],
      ['search', 'term'],
      ['channel', 'general'],
      ['read-channel', 'general'],
      ['read-dm', 'Exact Person'],
      ['read-thread', 'CDEMO:1700000000.000001'],
      ['read-media', 'FDEMO'],
      ['read-transcript', 'FDEMO'],
      ['save-media', 'FDEMO', '--output=/tmp/scoped-unused'],
    ];
    for (const args of commands) {
      for (const argv of [
        [flag, ...args],
        [args[0], flag, ...args.slice(1)],
        [...args, flag],
      ]) {
        expect(parseCLI(argv)).toEqual({ ...parseCLI(args), workspaceTarget: ref });
      }
    }
    expect(parseCLI(['dms', flag, '--filter=Alex', '--pages=3', '--format=json'])).toMatchObject({
      workspaceTarget: ref,
      dmFilter: 'Alex',
      pages: 3,
      format: 'json',
    });
    expect(
      parseCLI(['read-channel', 'general', flag, '--before=CDEMO:1700000000.000001'])
    ).toMatchObject({
      workspaceTarget: ref,
      page: { direction: 'older', cursor: 'CDEMO:1700000000.000001' },
    });
    expect(parseCLI([flag, 'search', '--', '--workspace=literal']).args).toEqual([
      'search',
      '--workspace=literal',
    ]);
    expect(parseCLI(['search', '--', flag])).toEqual({
      args: ['search', flag],
      interaction: 'background',
      format: 'text',
    });
  });

  test('rejects invalid scoped targets, duplicates and unsupported commands before input', () => {
    for (const target of [
      '',
      ' padded',
      'padded ',
      'A\nB',
      'A\u202eB',
      '\ud800',
      '😀'.repeat(201),
    ]) {
      let failure;
      try {
        parseCLI(['--format=json', 'channels', `--workspace=${target}`]);
      } catch (error) {
        failure = error;
      }
      expect(failure?.exitCode).toBe(2);
      expect(failure?.format).toBe('json');
    }
    expect(parseCLI(['channels', `--workspace=${'😀'.repeat(200)}`]).workspaceTarget).toBe(
      '😀'.repeat(200)
    );
    for (const args of [
      ['inspect'],
      ['permissions'],
      ['--help'],
      ['workspaces'],
      ['current-workspace'],
      ['switch-workspace', 'TSCOPED'],
    ])
      expect(() => parseCLI([...args, flag])).toThrow('--workspace requires');
    expect(() => parseCLI(['channels', flag, flag])).toThrow('only once');
    expect(() => parseCLI(['channels', '--workspace', ref])).toThrow();
    expect(() => parseCLI(['read-media', 'FDEMO', flag, '--interaction=foreground'])).toThrow(
      'foreground'
    );
    expect(() => parseCLI(['read-media', 'FDEMO', flag, '--pages=2'])).toThrow('--pages');
    expect(() => parseCLI(['channels', flag, '--filter=Alex'])).toThrow('--filter');
  });

  test('keeps unscoped parsing and text bytes unchanged', () => {
    expect(parseCLI(['channel', 'general'])).toEqual({
      args: ['channel', 'general'],
      interaction: 'background',
      format: 'text',
    });
    const compact = {
      operation: 'channel',
      workspace: { name: 'Example Workspace' },
      note: 'Observed view.',
    };
    expect(formatOutput(compact)).toBe('Slack — Example Workspace\n\nObserved view.');
    expect(
      formatOutput({ ...compact, requestedWorkspace: undefined, workspaceSelection: undefined })
    ).toBe(formatOutput(compact));
  });

  test('scoped saves preserve output, original and explicit foreground options without adding read flags', () => {
    for (const format of ['text', 'json', 'full-json']) {
      expect(
        parseCLI([
          flag,
          'save-media',
          'FDEMO',
          '--output=clips/音声 = 1.mp4',
          '--original',
          '--interaction=foreground',
          `--format=${format}`,
        ])
      ).toEqual({
        args: ['save-media', 'FDEMO'],
        workspaceTarget: ref,
        output: 'clips/音声 = 1.mp4',
        originalRequired: true,
        interaction: 'foreground',
        format,
      });
    }
    for (const option of ['--pages=2', '--allow-clipboard', '--filter=x', '--search=x', '--ui'])
      expect(() => parseCLI(['save-media', 'FDEMO', '--output=file', flag, option])).toThrow();
    expect(() => parseCLI(['save-media', 'FDEMO', flag])).toThrow('requires --output');
    expect(() => parseCLI(['save-media', 'FDEMO', '--output=file', flag, flag])).toThrow(
      'only once'
    );
    expect(() => parseCLI(['save-media', 'FDEMO', '--output=file', '--workspace= bad'])).toThrow();
  });

  test('scoped attachment hints retain the required output option exactly once', () => {
    const compact = scoped({
      operation: 'read-media',
      status: 'ok',
      requested: 'FDEMO',
      media: {
        ref: 'FDEMO',
        kind: 'image',
        title: 'Example image',
        saveNavigation: { ...navigation('save-media', 'FDEMO'), requiredOption: '--output=PATH' },
      },
    });
    expect(formatOutput(compact)).toContain(
      `Save attachment: save-media ${flag} FDEMO --output=PATH`
    );
    expect(formatOutput(compact)).not.toContain(`${flag} ${flag}`);
    compact.media.saveNavigation.args = ['FDEMO'];
    expect(formatOutput(compact)).toContain(
      `Save attachment: save-media ${flag} FDEMO --output=PATH`
    );
    for (const args of [
      ['FOTHER', flag],
      ['FDEMO', flag, flag],
      ['FDEMO', '--workspace=workspace:foreign.slack.com'],
    ]) {
      compact.media.saveNavigation.args = args;
      expect(formatOutput(compact)).not.toContain('Save attachment:');
    }
    delete compact.workspaceSelection;
    compact.media.saveNavigation.args = ['FDEMO'];
    expect(formatOutput(compact)).not.toContain('Save attachment:');
  });

  test('workspace evidence does not upgrade uncertain saves or discard published artifacts', () => {
    for (const published of [false, null, true]) {
      const compact = scoped(
        {
          operation: 'save-media',
          status: 'stopped',
          error: 'Final source verification failed',
          saved: { path: '/tmp/scoped-artifact.bin', published, verified: false },
          downloadMayHaveStarted: true,
          viewerMayHaveOpened: true,
          viewer: { closed: null },
        },
        true
      );
      const text = formatOutput(compact);
      expect(text).toStartWith('Workspace: Scoped Workspace (TSCOPED) [switched]');
      expect(text).toContain('Stopped: Final source verification failed');
      expect(text).toContain('Slack may have started a download. Do not replay it automatically.');
      expect(text).toContain('The file viewer may be open.');
      expect(text).not.toContain('Saved:');
      if (published === true)
        expect(text).toContain('Published; verification incomplete: /tmp/scoped-artifact.bin');
      if (published === null)
        expect(text).toContain('Publication uncertain; inspect: /tmp/scoped-artifact.bin');
      expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
      const raw = {
        phase: 'result',
        workspaceScope: { contextId: 'TSCOPED' },
        resolution: compact,
      };
      expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    }
    const success = scoped({
      operation: 'save-media',
      status: 'ok',
      saved: { path: '/tmp/scoped-artifact.bin', published: true, verified: true },
    });
    expect(formatOutput(success)).toContain('Saved: /tmp/scoped-artifact.bin');
    for (const change of ['missing', 'context', 'failed']) {
      const compact = structuredClone(success);
      if (change === 'missing') delete compact.workspaceSelection;
      if (change === 'context') compact.workspace = { ...compact.workspace, contextId: 'TOTHER' };
      if (change === 'failed') compact.workspaceSelection.status = 'stopped';
      compact.downloadMayHaveStarted = true;
      const text = formatOutput(compact);
      expect(text).not.toContain('Saved:');
      expect(text).toContain('Published; verification incomplete: /tmp/scoped-artifact.bin');
      expect(text).toContain('Do not replay it automatically.');
      expect(text).toContain('Stopped:');
    }
  });

  test('verified rail selection can identify a save without inventing a domain hint', () => {
    const compact = scoped({
      operation: 'save-media',
      status: 'ok',
      saved: { path: '/tmp/scoped-artifact.bin', published: true, verified: true },
    });
    const railIdentity = { ...identity, domain: null, ref: null };
    compact.workspaceSelection = {
      ...selected(),
      workspace: railIdentity,
      switch: { ...selected().switch, to: railIdentity },
    };
    expect(formatOutput(compact)).toStartWith('Workspace: Scoped Workspace (TSCOPED)\n\nSaved:');
    const media = {
      ref: 'FDEMO',
      saveNavigation: { command: 'save-media', args: ['FDEMO'], requiredOption: '--output=PATH' },
    };
    expect(
      formatOutput({ ...compact, operation: 'read-media', requested: 'FDEMO', media })
    ).not.toContain('Save attachment:');
  });

  test('adds one verified workspace line without duplicating legacy suffixes', () => {
    for (const changed of [true, false]) {
      const compact = scoped(base(), changed);
      const rendered = formatOutput(compact);
      expect(rendered).toStartWith(
        `Workspace: Scoped Workspace (TSCOPED)${changed ? ' [switched]' : ''}\n\n#project-help`
      );
      expect(rendered.match(/Scoped Workspace/g)).toHaveLength(1);
      expect(JSON.parse(formatOutput(compact, 'json')).workspaceSelection).toEqual(
        selected(changed)
      );
      expect(JSON.parse(formatOutput(compact, 'json')).requestedWorkspace).toBe(ref);
      const raw = {
        operation: 'read-channel',
        workspaceSelection: { raw: true },
        resolution: compact,
      };
      expect(JSON.parse(formatOutput(compact, 'full-json', raw))).toEqual(raw);
    }
  });

  test('preserves successful selection evidence when the subsequent read stops', () => {
    const compact = {
      operation: 'read-dm',
      status: 'stopped',
      error: 'Conversation did not verify',
      requestedWorkspace: ref,
      workspaceSelection: selected(true),
    };
    const rendered = formatOutput(compact);
    expect(rendered).toStartWith('Workspace: Scoped Workspace (TSCOPED) [switched]');
    expect(rendered).toContain('Stopped: Conversation did not verify');
    expect(rendered).not.toContain('Workspace selection stopped');
  });

  test('failed scoped selection presents workspace choices and never DM choices', () => {
    const candidate = {
      ...identity,
      current: false,
      navigation: { command: 'switch-workspace', args: [ref] },
    };
    const selection = {
      operation: 'switch-workspace',
      status: 'not-found',
      error: 'Workspace not found',
      workspace: identity,
      candidates: [candidate],
      candidateCount: 1,
      candidatesTruncated: false,
      workspaceSwitchMayHaveBeenRequested: false,
    };
    const compact = {
      operation: 'read-dm',
      status: 'stopped',
      error: 'Scoped command stopped',
      requestedWorkspace: 'Missing',
      workspaceSelection: selection,
      workspaceSwitchMayHaveBeenRequested: false,
    };
    const rendered = formatOutput(compact);
    expect(rendered).toStartWith('Workspace selection stopped before read-dm.');
    expect(rendered).toContain(`switch-workspace ${ref}`);
    expect(rendered).not.toContain('read-dm --');
    expect(rendered).not.toContain('No destination was selected');
    expect(JSON.parse(formatOutput(compact, 'json'))).toEqual(compact);
    const uncertain = formatOutput({ ...compact, workspaceSwitchMayHaveBeenRequested: true });
    expect(uncertain).toContain('Workspace switching may have been requested');
    expect(uncertain).not.toContain('No workspace-switch action was attempted');
  });

  test('scopes synthesized channel, thread, media and transcript commands without changing body text', () => {
    const compact = scoped({
      ...base(),
      messages: [
        {
          ...message(1),
          text: 'Body says read-thread CDEMO:1700000000.000001',
          thread: { ref: 'CDEMO:1700000000.000001', replyCount: 2 },
          attachments: [
            { kind: 'audio', ref: 'FDEMO', label: 'Recording', transcript: { state: 'available' } },
          ],
        },
      ],
    });
    const rendered = formatOutput(compact);
    expect(rendered).toContain(`read-thread ${flag} CDEMO:1700000000.000001`);
    expect(rendered).toContain(`read-media ${flag} FDEMO`);
    expect(rendered).toContain(`read-transcript ${flag} FDEMO`);
    expect(rendered).toContain('Body says read-thread CDEMO:1700000000.000001');
    const channels = scoped({ operation: 'channels', channels: [{ name: '-example' }] });
    expect(formatOutput(channels)).toContain(`read-channel ${flag} -- -example`);
    const thread = scoped(threadResult());
    expect(formatOutput(thread)).toContain(`Back to channel: read-channel ${flag} project-help`);
    const media = scoped({
      operation: 'read-media',
      requested: 'FDEMO',
      media: { ref: 'FDEMO', kind: 'audio', transcript: { state: 'available' } },
      sources: [],
    });
    expect(formatOutput(media)).toContain(`read-transcript ${flag} FDEMO`);
    const transcript = scoped({
      operation: 'read-transcript',
      requested: 'FDEMO',
      media: { ref: 'FDEMO', kind: 'audio' },
      transcript: { segments: [] },
      sources: [],
    });
    expect(formatOutput(transcript)).toContain(`Inspect attachment: read-media ${flag} FDEMO`);
  });

  test('renders decorated structured hints exactly once and before literal target separators', () => {
    const candidates = scoped({
      operation: 'read-dm',
      status: 'ambiguous',
      requested: 'Alex',
      candidates: [
        { name: '-Alex', navigation: navigation('read-dm', '-Alex', '--allow-clipboard') },
      ],
    });
    expect(formatOutput(candidates)).toContain(`read-dm ${flag} --allow-clipboard -- -Alex`);
    const dms = scoped({
      operation: 'dms',
      dms: [
        {
          id: 'CDEMO',
          kind: 'group',
          name: 'Alex, Sam',
          navigation: navigation('read-dm', 'group:CDEMO'),
        },
        {
          id: 'DDEMO',
          kind: 'one-to-one',
          name: 'Alex',
          navigation: navigation('read-dm', 'Alex'),
        },
      ],
    });
    const rendered = formatOutput(dms);
    expect(rendered).toContain(`read-dm ${flag} group:CDEMO`);
    expect(rendered).toContain(`read-dm ${flag} Alex`);
    expect(rendered).not.toContain(`${flag} ${flag}`);
    const page = scoped({
      ...base(),
      pagination: {
        supported: true,
        status: 'initial',
        older: {
          cursor: 'CDEMO:1700000000.000001',
          navigation: navigation(
            'read-channel',
            'project-help',
            '--before=CDEMO:1700000000.000001'
          ),
        },
        newer: null,
      },
    });
    expect(formatOutput(page)).toContain(
      `Older: read-channel ${flag} project-help --before=CDEMO:1700000000.000001`
    );
  });

  test('refuses foreign, duplicate and unverified scoped hints', () => {
    for (const args of [
      ['Alex', '--workspace=workspace:foreign.slack.com'],
      ['Alex', flag, flag],
    ]) {
      const compact = scoped({
        operation: 'dms',
        dms: [
          {
            id: 'DDEMO',
            kind: 'one-to-one',
            name: 'Alex',
            navigation: { command: 'read-dm', args },
          },
        ],
      });
      expect(formatOutput(compact)).not.toContain(' · read-dm');
    }
    const forged = {
      command: 'read-channel',
      args: ['general', '--workspace=workspace:foreign.slack.com'],
    };
    expect(
      formatOutput(
        scoped({ operation: 'channels', channels: [{ name: 'general', navigation: forged }] })
      )
    ).not.toContain(' · read-channel');
    for (const change of ['context', 'ref', 'domain', 'status']) {
      const compact = scoped({ operation: 'channels', channels: [{ name: 'general' }] });
      if (change === 'context') compact.workspace = { ...identity, contextId: 'TOTHER' };
      if (change === 'ref')
        compact.workspaceSelection.workspace = { ...identity, ref: 'workspace:foreign.slack.com' };
      if (change === 'domain')
        compact.workspaceSelection.workspace = { ...identity, domain: 'scoped.slack.com\n' };
      if (change === 'status') compact.workspaceSelection.status = 'stopped';
      expect(formatOutput(compact)).not.toContain(`read-channel ${flag}`);
    }
    const compact = {
      operation: 'dms',
      dms: [
        {
          id: 'DDEMO',
          kind: 'one-to-one',
          name: 'Alex',
          navigation: navigation('read-dm', 'Alex'),
        },
      ],
    };
    expect(formatOutput(compact)).not.toContain(' · read-dm');
  });

  test('scopes autocomplete person and group-name hints while preserving clipboard opt-in', () => {
    const compact = scoped({
      operation: 'dms',
      status: 'ok',
      coverage: {
        source: 'dms-search-autocomplete',
        search: { source: 'dms-search-autocomplete', verified: true, requestedQuery: 'Alex' },
        filters: { query: 'Alex' },
      },
      pagination: {
        batch: {
          completedPages: 1,
          requestedPages: 1,
          stopReason: 'no-progress',
          deduplicatedCount: 0,
        },
      },
      dms: [
        {
          id: null,
          kind: 'person',
          name: 'Alex',
          handle: 'alex.example',
          navigation: navigation('read-dm', '@alex.example'),
        },
        {
          id: null,
          kind: 'group',
          name: 'Alex, Sam',
          navigation: navigation('read-dm', 'group-name:Alex, Sam', '--allow-clipboard'),
        },
      ],
    });
    const text = formatOutput(compact);
    expect(text).toContain(`read-dm ${flag} @alex.example`);
    expect(text).toContain(`read-dm ${flag} --allow-clipboard 'group-name:Alex, Sam'`);
    expect(text).not.toContain(`${flag} ${flag}`);
  });
});
