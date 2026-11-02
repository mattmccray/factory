import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The tests may run contract code; the UI never does (boundary.test.ts).
import { compactTokens as contractCompact, tokensOf as contractTokensOf, totalOf as contractTotalOf } from '@factory/contract';
import type { Usage, UsageCounts } from './job';
import { BLANK, NOT_RECORDED, combine, compactTokens, counted, spanCell, tokensOf, tokensPart, totalCell, totalOf, usageSummary } from './usage';

const c = (input: number, output: number, cacheWrite: number, cacheRead: number, model: string | null = 'claude-opus-5-5'): UsageCounts => ({ model, input, output, cacheWrite, cacheRead });

describe('the reimplemented contract helpers', () => {
  test('compactTokens and tokensOf match the contract, at every boundary', () => {
    for (const n of [0, 1, 950, 999, 1000, 1049, 12_345, 99_999, 999_949, 999_950, 1_000_000, 1_234_567, 63_999_999, 64_000_000, 1_234_567_890]) expect(compactTokens(n)).toBe(contractCompact(n));
    const t = c(1, 20, 300, 4000);
    expect(tokensOf(t)).toBe(contractTokensOf(t));
  });

  test('totalOf matches the contract for exact, partial, unavailable, and not recorded', () => {
    const cases: (Usage | null)[][] = [[], [c(1, 2, 3, 4)], [c(1, 2, 3, 4), null], [c(1, 2, 3, 4), { unavailable: 'x' }], [{ unavailable: 'x' }, null], [null, null]];
    for (const usages of cases) expect(totalOf(usages)).toEqual(contractTotalOf(usages));
  });
});

describe('combine', () => {
  test('sums counts, spans, and unknown; status the way totalOf takes it', () => {
    const a = totalOf([c(10, 20, 30, 40)]);
    const b = totalOf([c(1, 1, 1, 1), { unavailable: 'x' }]);
    expect(combine([a, b])).toEqual({ status: 'partial', input: 11, output: 21, cacheWrite: 31, cacheRead: 41, spans: 3, unknown: 1 });
    expect(combine([a, a]).status).toBe('exact');
    expect(combine([a, NOT_RECORDED]).status).toBe('partial');
    expect(combine([NOT_RECORDED, NOT_RECORDED]).status).toBe('not recorded');
    expect(combine([NOT_RECORDED, totalOf([{ unavailable: 'x' }])]).status).toBe('unavailable');
    expect(combine([]).status).toBe('exact');
    expect(counted(combine([]))).toBe(false);
  });
});

describe('the cells', () => {
  const span = (usage: Usage | null, finishedAt: string | null = '2026-10-22T11:00:00.000Z') => ({ role: 'builder', key: null, round: 1, startedAt: '2026-10-22T10:00:00.000Z', finishedAt, ms: null, verdict: null, usage });

  test('a span: counts, unavailable, not recorded, running', () => {
    const cell = spanCell(span(c(1_000_000, 200_000, 34_567, 0)));
    expect([cell.text, cell.muted]).toEqual([contractCompact(1_234_567), false]);
    expect(cell.title).toBe('input 1,000,000\noutput 200,000\ncache write 34,567\ncache read 0\nclaude-opus-5-5');
    expect(spanCell(span(c(1, 2, 3, 4, null))).title).toEndWith('\nmodel not recorded');
    expect(spanCell(span({ unavailable: 'transcript not found' }))).toEqual({ text: '?', muted: true, title: 'transcript not found' });
    expect(spanCell(span(null))).toEqual({ text: '—', muted: true, title: 'Not recorded (before token tracking)' });
    expect(spanCell(span(null, null))).toEqual(BLANK);
    expect(spanCell(span(c(1, 2, 3, 4), null))).toEqual(BLANK);
  });

  test('a total: exact, partial ≥, unavailable ?, not recorded —, empty blank', () => {
    expect(totalCell(totalOf([c(500, 400, 50, 0)]))).toEqual({ text: '950', muted: false, title: 'input 500\noutput 400\ncache write 50\ncache read 0' });
    const partial = totalCell(totalOf([c(10_000, 2_300, 0, 0), null, { unavailable: 'x' }]));
    expect(partial.text).toBe('≥ 12.3k');
    expect(partial.title).toEndWith('\n2 spans unavailable');
    expect(totalCell(totalOf([c(1, 0, 0, 0), null])).title).toEndWith('\n1 span unavailable');
    expect(totalCell(totalOf([{ unavailable: 'x' }]))).toEqual({ text: '?', muted: true, title: '1 span unavailable' });
    expect(totalCell(totalOf([null]))).toEqual({ text: '—', muted: true, title: 'Not recorded (before token tracking)' });
    expect(totalCell(totalOf([]))).toEqual(BLANK);
  });

  test('a header part and the usage summary only when something was counted', () => {
    expect(tokensPart(totalOf([c(64_000_000, 0, 0, 0)]))?.text).toBe('64.0M tokens');
    expect(tokensPart(totalOf([c(1_200_000, 0, 0, 0), null]))?.text).toBe('≥ 1.2M tokens');
    for (const none of [totalOf([]), totalOf([null]), totalOf([{ unavailable: 'x' }])]) {
      expect(tokensPart(none)).toBeNull();
      expect(usageSummary(none)).toBeNull();
    }
    expect(usageSummary(totalOf([c(1234, 5, 6, 7), null]))).toEqual({
      rows: [
        { label: 'Input', value: '≥ 1,234' },
        { label: 'Output', value: '≥ 5' },
        { label: 'Cache write', value: '≥ 6' },
        { label: 'Cache read', value: '≥ 7' },
      ],
      note: '1 span unavailable',
    });
    expect(usageSummary(totalOf([c(1, 2, 3, 4)]))?.rows.map((r) => r.value)).toEqual(['1', '2', '3', '4']);
  });
});

describe('the board, its popover, the desk widget, and the Settled sheet show no token spend (094 AC7)', () => {
  test('none of them reads usage', () => {
    for (const f of ['Token.svelte', 'TokenPopover.svelte', 'SettledSheet.svelte', 'DeskWidget.svelte', 'board.ts', 'lanes.ts', 'widget.ts']) {
      const text = readFileSync(join(import.meta.dir, f), 'utf8');
      expect({ f, usage: /usage|tokensOf|compactTokens|orchestrator/i.test(text) }).toEqual({ f, usage: false });
    }
  });
});
