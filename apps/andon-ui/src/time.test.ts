import { describe, expect, test } from 'bun:test';
import { HOUR, NOW, before, job } from './fixtures';
import { abbr, chipLabel, chipTime, clock, fmt, fmtShort, reviewerSpan } from './time';
import { clockTime } from './time';
import { localAt } from './fixtures';

describe('formatting', () => {
  test('fmt and fmtShort match the vendored dashboard', () => {
    expect([fmt(-5), fmt(42_000), fmt(187_000), fmt(2 * HOUR + 5 * 60_000), fmt(28 * HOUR)]).toEqual(['0s', '42s', '3m 7s', '2h 05m', '1d 4h']);
    expect([fmtShort(12_000), fmtShort(8 * 60_000 + 30_000), fmtShort(HOUR + 5 * 60_000), fmtShort(51 * HOUR)]).toEqual(['12s', '8m', '1h05m', '2d3h']);
    expect([abbr('security'), abbr('contract'), abbr('ui')]).toEqual(['SEC', 'CONT', 'UI']);
  });
});

describe('timers (AC2)', () => {
  test('time in stage and total time for a job on the line', () => {
    const j = job({ id: '001-a', stage: 'build', startedAt: before(HOUR + 90_000), stageEnteredAt: before(90_000) });
    expect(clock(j, NOW)).toEqual({ main: 'build · 1m 30s', total: 'total 1h 01m' });
    expect(clock(j, NOW + 1000)).toEqual({ main: 'build · 1m 31s', total: 'total 1h 01m' });
  });

  test('a needs-human job shows how long it has waited', () => {
    const j = job({ id: '001-a', stage: 'needs-human', startedAt: before(HOUR), stageEnteredAt: before(5 * 60_000) });
    expect(clock(j, NOW)).toEqual({ main: 'waiting 5m 0s', total: null });
  });

  test('a merged job shows its final total', () => {
    const j = job({ id: '001-a', stage: 'merged', startedAt: before(3 * HOUR), stageEnteredAt: before(HOUR), endedAt: before(HOUR) });
    expect(clock(j, NOW)).toEqual({ main: 'total 2h 00m', total: null });
  });

  test('a legacy job with no startedAt gets no timers', () => {
    expect(clock(job({ id: '001-a', stage: 'build', updated: before(HOUR) }), NOW)).toBeNull();
    expect(clock(job({ id: '001-a', stage: 'build', stageEnteredAt: before(HOUR) }), NOW)).toBeNull();
  });

  test('each reviewer: elapsed for an open span, finished time for a closed one, nothing without a span', () => {
    const j = job({
      id: '001-a',
      stage: 'review',
      round: 1,
      timing: {
        stages: [],
        agents: [
          { role: 'reviewer', key: 'code', round: 1, startedAt: before(45_000), finishedAt: null, ms: null, verdict: null },
          { role: 'reviewer', key: 'security', round: 1, startedAt: before(10 * 60_000), finishedAt: before(5 * 60_000), ms: 5 * 60_000, verdict: 'PASS' },
          { role: 'reviewer', key: 'ui', round: 1, startedAt: before(10 * 60_000), finishedAt: before(9 * 60_000), ms: null, verdict: null },
        ],
      },
    });
    const at = (key: string, verdict: string) => chipTime(key, verdict, reviewerSpan(j, key, 1), NOW);
    expect(at('code', 'pending')).toEqual({ title: 'code pending · 45s', short: '45s', running: true });
    expect(at('security', 'PASS')).toEqual({ title: 'security PASS · 5m 0s', short: '5m', running: false });
    expect(at('ui', 'pending')).toEqual({ title: 'ui stopped · 1m 0s', short: '1m', running: false });
    expect(at('contract', 'pending')).toEqual({ title: 'contract: pending', short: '', running: false });
    expect(reviewerSpan(j, 'code', 2)).toBeNull();
  });
});

describe('token chip labels (025 AC6)', () => {
  test('two letters: se, ct, cd, ui, ux, otherwise the first two letters', () => {
    expect(['security', 'contract', 'code', 'ui', 'ux'].map(chipLabel)).toEqual(['se', 'ct', 'cd', 'ui', 'ux']);
    expect(['perf', 'a11y', 'docs-site', 'q'].map(chipLabel)).toEqual(['pe', 'a1', 'do', 'q']);
    expect(abbr('security')).toBe('SEC'); // the drawer keeps abbr
  });
});

describe("a machine's since and as-of time (brief andon-machines-ui)", () => {
  test('local 24-hour HH:MM today, with a short date before it otherwise', () => {
    const now = localAt(16, 30);
    expect(clockTime(localAt(14, 2), now)).toBe('14:02');
    expect(clockTime(localAt(0, 5), now)).toBe('00:05');
    expect(clockTime(localAt(23, 59), now)).toBe('23:59');
    expect(clockTime(localAt(14, 2, 21), now)).toBe('Oct 21 14:02');
    expect(clockTime(new Date(2025, 9, 22, 9, 7).getTime(), now)).toBe('Oct 22 09:07'); // a year ago is not today
  });
});
