import { describe, expect, test } from 'bun:test';
import {
  compactCompose,
  normalizeMessageText,
  renderCompose,
  validMessageReference,
  validSendDestination,
} from './slack-compose.mjs';
import { formatOutput, parseCLI } from './slack-format.mjs';

describe('send activation evidence', () => {
  const sent = {
    status: 'ok',
    operation: 'send',
    timestamp: '1700000000.000002',
    permalink: 'https://team.slack.com/archives/D0DEMO/p1700000000000002',
    composer: 'Message to ploog',
  };
  test('a focus+Return send is named in text and json', () => {
    const compact = compactCompose({ ...sent, activation: 'focus+Return' }, 'send', 'ploog');
    expect(compact.activation).toBe('focus+Return');
    expect(renderCompose(compact)).toContain('activated once with focus and one Return');
    expect(JSON.parse(formatOutput(compact, 'json', sent)).activation).toBe('focus+Return');
  });
  test('a pressed send stays quiet and unknown methods are dropped', () => {
    expect(renderCompose(compactCompose({ ...sent, activation: 'AXPress' }, 'send', 'ploog'))).not.toContain('Return');
    expect('activation' in compactCompose({ ...sent, activation: 'Return' }, 'send', 'ploog')).toBe(false);
  });
});

describe('readback divergence evidence', () => {
  const readback = {
    observed: true,
    expectedLength: 8,
    observedLength: 8,
    firstDifference: 4,
    windowStart: 1,
    expectedAround: ['letter', 'letter', 'U+0020', 'U+0022', 'letter', 'letter', 'U+0022'],
    observedAround: ['letter', 'letter', 'U+0020', 'U+201C', 'letter', 'letter', 'U+201D'],
    comparedWithoutShortcodes: false,
    equalAfterQuoteFolding: true,
    equalIgnoringWhitespace: false,
    observedIsPrefix: false,
  };
  const receipt = {
    status: 'stopped',
    error: 'Composer text did not read back exactly; nothing was sent',
    actionMayHaveOccurred: false,
    readback,
    recovery: ['Cleared the unverified text this command entered; nothing was sent'],
  };

  test('text, json and full-json all carry where the readback diverged', () => {
    const compact = compactCompose(receipt, 'send', '@alex');
    expect(compact.readback).toEqual(readback);
    const text = formatOutput(compact, 'text', receipt);
    expect(text).toContain('Nothing was changed.');
    expect(text).toContain('first difference at character 4 (expected 8 characters, observed 8)');
    expect(text).toContain('U+201C');
    expect(text).toContain('matches once curly quotes are folded');
    expect(JSON.parse(formatOutput(compact, 'json', receipt)).readback).toEqual(readback);
    expect(JSON.parse(formatOutput(compact, 'full-json', receipt)).readback).toEqual(readback);
  });

  test('only offsets, lengths, character kinds and booleans pass through', () => {
    const compact = compactCompose(
      {
        ...receipt,
        readback: {
          ...readback,
          observedText: 'private words',
          expectedAround: ['letter', 'private'],
          firstDifference: -1,
        },
      },
      'send',
      '@alex'
    );
    expect(compact.readback.observedText).toBeUndefined();
    expect(compact.readback.expectedAround).toBeNull();
    expect(compact.readback.firstDifference).toBeNull();
    expect(JSON.stringify(compact)).not.toContain('private');
  });

  test('an unreadable composer and an absent readback stay distinct', () => {
    const unreadable = compactCompose(
      { ...receipt, readback: { observed: false, expectedLength: 2 } },
      'edit',
      'C0CHAN:1700000000.000002'
    );
    expect(unreadable.readback).toEqual({ observed: false, expectedLength: 2 });
    expect(renderCompose(unreadable)).toContain('composer value could not be read');
    const plain = compactCompose({ status: 'stopped', error: 'x' }, 'send', '#general');
    expect('readback' in plain).toBe(false);
    expect(renderCompose(plain)).not.toContain('Readback');
  });
});

describe('message text normalization', () => {
  test('translates known emoji to shortcodes with word boundaries', () => {
    const result = normalizeMessageText('ship it 🚀done');
    expect(result.submittedText).toBe('ship it :rocket: done');
    expect(result.substitutions).toEqual([{ unicode: '🚀', shortcode: ':rocket:' }]);
  });

  test('keeps plain text, newlines and explicit shortcodes unchanged', () => {
    const text = 'line one\nline two :tada:';
    expect(normalizeMessageText(text)).toEqual({
      requestedText: text,
      submittedText: text,
      substitutions: [],
    });
    expect(normalizeMessageText('a\r\nb').submittedText).toBe('a\nb');
  });

  test('refuses empty, control-character, oversized and unknown-emoji text', () => {
    expect(() => normalizeMessageText('   \n')).toThrow('must not be empty');
    expect(() => normalizeMessageText('bell\u0007')).toThrow('control characters');
    expect(() => normalizeMessageText('x'.repeat(4001))).toThrow('exceeds 4000');
    expect(() => normalizeMessageText('odd \u{1FAE8}\u{1F3FF}')).toThrow('known Slack shortcode');
  });
});

describe('composition targets', () => {
  test('accepts explicit destination forms only', () => {
    for (const value of ['#general', '@alex.example', 'Alex Example', 'group:C0GROUP1'])
      expect(validSendDestination(value)).toBe(true);
    expect(validSendDestination('thread:C0CHAN:1700000000.000001')).toBe(true);
    for (const value of ['', '#', '#two words', 'group-name:Team', 'thread:bad', ' Alex', 'a\tb'])
      expect(validSendDestination(value)).toBe(false);
  });

  test('accepts message references and Slack permalinks', () => {
    expect(validMessageReference('C0CHAN:1700000000.000001')).toBe(true);
    expect(
      validMessageReference('https://team.slack.com/archives/C0CHAN/p1700000000000001?thread_ts=1')
    ).toBe(true);
    expect(validMessageReference('https://example.com/archives/C0CHAN/p1700000000000001')).toBe(
      false
    );
    expect(validMessageReference('C0CHAN')).toBe(false);
  });

  test('CLI requires text for send/edit and explicit confirmation for delete', () => {
    expect(parseCLI(['send', '#general', '--text=hi'])).toMatchObject({
      args: ['send', '#general'],
      text: 'hi',
    });
    expect(parseCLI(['delete', 'C0CHAN:1700000000.000001', '--confirm-delete']).confirmDelete).toBe(
      true
    );
    expect(() => parseCLI(['send', '#general'])).toThrow('require --text');
    expect(() => parseCLI(['delete', 'C0CHAN:1700000000.000001'])).toThrow('--confirm-delete');
    expect(() =>
      parseCLI(['edit', 'C0CHAN:1700000000.000001', '--text=x', '--confirm-delete'])
    ).toThrow('--confirm-delete');
    expect(() => parseCLI(['send', 'general', 'extra', '--text=x'])).toThrow('one destination');
    expect(() => parseCLI(['read-channel', 'general', '--text=x'])).toThrow(
      'require send, edit or delete'
    );
    expect(() => parseCLI(['edit', 'not-a-ref', '--text=x'])).toThrow('CONVERSATION:TIMESTAMP');
    expect(parseCLI(['--workspace=Example', 'send', '#general', '--text=x']).workspaceTarget).toBe(
      'Example'
    );
  });

  test('clipboard fallback is allowed only for name or handle DM sends', () => {
    expect(parseCLI(['send', '@alex', '--text=x', '--allow-clipboard']).allowClipboard).toBe(true);
    expect(() => parseCLI(['send', '#general', '--text=x', '--allow-clipboard'])).toThrow(
      '--allow-clipboard'
    );
  });
});

describe('composition receipts', () => {
  const sent = {
    status: 'ok',
    operation: 'send',
    timestamp: '1700000000.000002',
    permalink: 'https://team.slack.com/archives/C0CHAN/p1700000000000002',
    composer: 'Message to general',
  };

  test('verified send returns a reference with edit and delete hints', () => {
    const compact = compactCompose(sent, 'send', '#general');
    expect(compact).toMatchObject({ status: 'ok', ref: 'C0CHAN:1700000000.000002' });
    const text = renderCompose(compact);
    expect(text).toContain('Sent and verified (C0CHAN:1700000000.000002)');
    expect(text).toContain('delete C0CHAN:1700000000.000002 --confirm-delete');
  });

  test('success requires verified identity and delete evidence', () => {
    expect(() => compactCompose({ ...sent, timestamp: undefined }, 'send', '#g')).toThrow(
      'verified message identity'
    );
    expect(() =>
      compactCompose(
        { status: 'ok', operation: 'delete', timestamp: '1700000000.000002' },
        'delete',
        'C0CHAN:1700000000.000002'
      )
    ).toThrow('Deletion evidence');
    expect(() => compactCompose({ ...sent, operation: 'edit' }, 'send', '#g')).toThrow();
  });

  test('stopped receipts preserve action uncertainty instead of claiming no change', () => {
    const unknown = compactCompose({ status: 'stopped', error: 'x' }, 'send', '#general');
    expect(unknown.actionMayHaveOccurred).toBeNull();
    const pressed = compactCompose(
      { status: 'stopped', error: 'unverified', actionMayHaveOccurred: true },
      'send',
      '#general'
    );
    expect(renderCompose(pressed)).toContain('may have taken effect');
    const lookup = compactCompose(
      { status: 'not-found', error: 'no match', candidates: [{ name: 'Jordan', handle: null }] },
      'send',
      '@jordan'
    );
    expect(lookup).toMatchObject({ actionMayHaveOccurred: false, candidates: [{ name: 'Jordan' }] });
    expect(renderCompose(lookup)).toContain('Candidates: Jordan');
    expect(() => compactCompose({ status: 'weird' }, 'send', '#g')).toThrow('status is invalid');
  });

  test('deleting a thread root reports the placeholder', () => {
    const compact = compactCompose(
      { status: 'ok', operation: 'delete', timestamp: '1700000000.000002', placeholder: true },
      'delete',
      'C0CHAN:1700000000.000002'
    );
    expect(renderCompose(compact)).toContain('placeholder');
  });
});
