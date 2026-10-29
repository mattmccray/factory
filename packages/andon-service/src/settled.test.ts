import { describe, expect, test } from 'bun:test';
import { isSettled, nextSettle, partition, summarize } from './settled';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const oldMerged = { id: '001-old', stage: 'merged', endedAt: iso(NOW - 48 * H) };
const olderMerged = { id: '002-older', stage: 'merged', endedAt: iso(NOW - 72 * H) };
const recentMerged = { id: '003-recent', stage: 'merged', endedAt: iso(NOW - 1 * H) };
const noEnd = { id: '004-no-end', stage: 'merged', endedAt: null };
const badEnd = { id: '005-bad-end', stage: 'merged', endedAt: 'not a date' };
const abandoned = { id: '006-abandoned', stage: 'abandoned', endedAt: iso(NOW - 1000) };
const working = { id: '007-working', stage: 'build', endedAt: null };

describe('the settle rule', () => {
  test('abandoned at once; merged past settleAfterHours; no readable endedAt or other stages never', () => {
    expect(isSettled(abandoned, 24, NOW)).toBe(true);
    expect(isSettled(oldMerged, 24, NOW)).toBe(true);
    expect(isSettled(recentMerged, 24, NOW)).toBe(false);
    expect(isSettled(noEnd, 24, NOW)).toBe(false);
    expect(isSettled(badEnd, 24, NOW)).toBe(false);
    expect(isSettled(working, 24, NOW)).toBe(false);
    expect(isSettled({ stage: 'needs-human', endedAt: iso(NOW - 99 * H) }, 24, NOW)).toBe(false);
    // Exactly on the line is not yet settled; one ms past it is.
    const edge = { stage: 'merged', endedAt: iso(NOW - 24 * H) };
    expect(isSettled(edge, 24, NOW)).toBe(false);
    expect(isSettled(edge, 24, NOW + 1)).toBe(true);
  });

  test('partition keeps order; summary counts settled jobs and takes the newest merged endedAt', () => {
    const jobs = [oldMerged, olderMerged, recentMerged, noEnd, badEnd, abandoned, working];
    const { unsettled, settled } = partition(jobs, 24, NOW);
    expect(unsettled.map((j) => j.id)).toEqual(['003-recent', '004-no-end', '005-bad-end', '007-working']);
    expect(settled.map((j) => j.id)).toEqual(['001-old', '002-older', '006-abandoned']);
    expect(summarize(settled)).toEqual({ count: 3, lastMergedAt: oldMerged.endedAt });
    expect(summarize([])).toEqual({ count: 0, lastMergedAt: null });
    expect(summarize([abandoned])).toEqual({ count: 1, lastMergedAt: null });
  });

  test('nextSettle is the delay to the first unsettled merged job crossing, or null', () => {
    const soon = { stage: 'merged', endedAt: iso(NOW - 24 * H + 5000) };
    expect(nextSettle([oldMerged, recentMerged, soon, noEnd, abandoned], 24, NOW)).toBe(5001);
    expect(nextSettle([recentMerged], 24, NOW)).toBe(23 * H + 1);
    expect(nextSettle([oldMerged, noEnd, badEnd, abandoned, working], 24, NOW)).toBeNull();
    expect(nextSettle([], 24, NOW)).toBeNull();
  });
});
