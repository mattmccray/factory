import { describe, expect, test } from 'bun:test';
// The Mac app's hand-off module, imported by this test only: the page's sources never import Mac app
// code, and the Mac app's sources never import the UI (apps/andon/src/boundary.test.ts scans sources,
// not tests), so the two command builders stay apart and this pins that they agree.
import { factoryCommand } from '../../andon/src/handoff';
import { COPY_FAILED, HAND_OFF_METHOD, handOffCaller, handoffToast, narrowOutcome } from './handoff';
import type { HandoffOutcome, HandoffRequest } from './handoff';
import { abandonCommand, approveCommand, reworkCommand } from './inspector';
import { shellMode } from './sidebar';

describe('036 AC2: the Mac app builds the same command as the UI', () => {
  const ids = ['036-t3-handoff', '040-tag-migration', '001-a'];
  const notes = [
    'plain',
    'add the "tags" test',
    'a \\ backslash and \\" an escaped quote',
    'C:\\path\\to\\file',
    'line one\nline two\r\nline three\rfour',
    '   surrounding whitespace\t ',
    '\n\nleading and trailing newlines\n\n',
    "it's 'single' quotes and `backticks` and $(subshells)",
    'unicode: café — ✓',
    '"',
    '\\',
    'x',
  ];

  test('approve, rework, and abandon agree for every id and note in the table', () => {
    let n = 0;
    for (const id of ids) {
      expect({ id, mac: factoryCommand('approve', id, '') }).toEqual({ id, mac: approveCommand(id) });
      for (const note of notes) {
        expect({ id, note, mac: factoryCommand('rework', id, note) }).toEqual({ id, note, mac: reworkCommand(id, note).text });
        expect({ id, note, mac: factoryCommand('abandon', id, note) }).toEqual({ id, note, mac: abandonCommand(id, note).text });
        n++;
      }
    }
    expect(n).toBe(ids.length * notes.length);
  });

  test('the table pins the exact strings, too', () => {
    expect(factoryCommand('approve', '036-t3-handoff', '')).toBe('/factory approve 036-t3-handoff');
    expect(factoryCommand('rework', '036-t3-handoff', '  say "hi"\\now\n')).toBe('/factory rework 036-t3-handoff "say \\"hi\\"\\\\now"');
    expect(reworkCommand('036-t3-handoff', '  say "hi"\\now\n').text).toBe('/factory rework 036-t3-handoff "say \\"hi\\"\\\\now"');
    expect(factoryCommand('abandon', '036-t3-handoff', 'a\r\nb')).toBe('/factory abandon 036-t3-handoff "a b"');
    expect(abandonCommand('036-t3-handoff', 'a\r\nb').text).toBe('/factory abandon 036-t3-handoff "a b"');
  });
});

describe('036 AC7: the hand-off caller', () => {
  const approve: HandoffRequest = { project: 'aaaaaaaaaaaa', job: '036-t3-handoff', action: 'approve' };

  test('null in a plain browser, or when Tiny or its api.call is missing', () => {
    const host = { api: { call: async () => 'drafted' } };
    expect(handOffCaller('browser', host)).toBeNull();
    expect(handOffCaller(shellMode(''), host)).toBeNull();
    expect(handOffCaller(shellMode('?view=settings'), host)).toBeNull();
    for (const h of [undefined, null, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect(handOffCaller('mac', h)).toBeNull();
  });

  test('calls only the hand-off method, with the request as given', async () => {
    const calls: unknown[][] = [];
    const host = {
      api: {
        call: async (method: string, params: unknown) => {
          calls.push([method, params]);
          return 'sent';
        },
      },
    };
    const go = handOffCaller(shellMode('?shell=mac'), host);
    if (go === null) throw new Error('no caller');
    expect(await go(approve)).toBe('sent');
    expect(await go({ project: 'aaaaaaaaaaaa', job: '036-t3-handoff', action: 'rework', note: 'more tests' })).toBe('sent');
    expect(calls).toEqual([
      ['handOff', approve],
      ['handOff', { project: 'aaaaaaaaaaaa', job: '036-t3-handoff', action: 'rework', note: 'more tests' }],
    ]);
    expect(HAND_OFF_METHOD).toBe('handOff');
  });

  test('a refused, failed, or malformed answer is null', async () => {
    const answers: (() => unknown)[] = [
      () => null,
      () => undefined,
      () => 'DRAFTED',
      () => ({ outcome: 'drafted' }),
      () => Promise.reject(new Error('denied')),
      () => {
        throw new Error('gone');
      },
    ];
    for (const a of answers) expect(await handOffCaller('mac', { api: { call: a } })?.(approve)).toBeNull();
  });

  test('the outcome is narrowed to the four answers', () => {
    for (const o of ['drafted', 'sent', 'copy-only', 'no-github-remote'] satisfies HandoffOutcome[]) expect(narrowOutcome(o)).toBe(o);
    for (const o of [null, undefined, '', 'Sent', 'failed', 1, true, ['sent'], { sent: true }]) expect({ o, n: narrowOutcome(o) }).toEqual({ o, n: null });
  });
});

describe('036 AC7: the toast after a copy and a hand-off', () => {
  const cmd = '/factory approve 036-t3-handoff';

  test('per outcome: drafted, sent, no GitHub remote, and the rest as "Copied …"', () => {
    expect(handoffToast(true, 'drafted', cmd)).toEqual({ text: 'Opened a draft in T3 Code', ok: true });
    expect(handoffToast(true, 'sent', cmd)).toEqual({ text: 'Sent to T3 Code', ok: true });
    expect(handoffToast(true, 'no-github-remote', cmd)).toEqual({ text: 'No GitHub remote; copied /factory approve 036-t3-handoff', ok: true });
    expect(handoffToast(true, 'copy-only', cmd)).toEqual({ text: 'Copied /factory approve 036-t3-handoff', ok: true });
    expect(handoffToast(true, null, cmd)).toEqual({ text: 'Copied /factory approve 036-t3-handoff', ok: true }); // a browser, or a refused call
  });

  test('a failed copy says so, unless T3 Code got the command', () => {
    expect(handoffToast(false, null, cmd)).toEqual({ text: COPY_FAILED, ok: false });
    expect(handoffToast(false, 'copy-only', cmd)).toEqual({ text: COPY_FAILED, ok: false });
    expect(handoffToast(false, 'no-github-remote', cmd)).toEqual({ text: COPY_FAILED, ok: false });
    expect(handoffToast(false, 'drafted', cmd)).toEqual({ text: 'Opened a draft in T3 Code', ok: true });
    expect(handoffToast(false, 'sent', cmd).text).toBe('Sent to T3 Code');
  });
});
