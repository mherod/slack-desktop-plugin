import { describe, expect, test } from 'bun:test';
import {
  compactCompose,
  normalizeMessageText,
  renderCompose,
  validMessageReference,
  validSendDestination,
} from './slack-compose.mjs';
import { parseCLI } from './slack-format.mjs';

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
