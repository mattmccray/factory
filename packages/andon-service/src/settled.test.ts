import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isEpicSnapshotSettled, isSettled, nextSettle, partition, summarize } from './settled';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const NONE = new Map<string, Record<string, unknown>>();

const oldMerged = { id: '001-old', stage: 'merged', endedAt: iso(NOW - 48 * H) };
const olderMerged = { id: '002-older', stage: 'merged', endedAt: iso(NOW - 72 * H) };
const recentMerged = { id: '003-recent', stage: 'merged', endedAt: iso(NOW - 1 * H) };
const noEnd = { id: '004-no-end', stage: 'merged', endedAt: null };
const badEnd = { id: '005-bad-end', stage: 'merged', endedAt: 'not a date' };
const abandoned = { id: '006-abandoned', stage: 'abandoned', endedAt: iso(NOW - 1000) };
const working = { id: '007-working', stage: 'build', endedAt: null };

const epic = (slug: string, state: string, endedAt: string | null): Record<string, unknown> => ({ schema: 'factory/v1', slug, state, endedAt, extra: { kept: slug } });
const member = (id: string, slug: string, stage: string, endedAt: string | null): Record<string, unknown> => ({ id, stage, endedAt, epic: slug, kind: 'member' });
const epics = (...list: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> => new Map(list.map((e) => [String(e.slug), e]));

describe('the settle rule, jobs without an epic (unchanged)', () => {
  test('abandoned at once; merged past settleAfterHours; no readable endedAt or other stages never', () => {
    expect(isSettled(abandoned, NONE, 24, NOW)).toBe(true);
    expect(isSettled(oldMerged, NONE, 24, NOW)).toBe(true);
    expect(isSettled(recentMerged, NONE, 24, NOW)).toBe(false);
    expect(isSettled(noEnd, NONE, 24, NOW)).toBe(false);
    expect(isSettled(badEnd, NONE, 24, NOW)).toBe(false);
    expect(isSettled(working, NONE, 24, NOW)).toBe(false);
    expect(isSettled({ stage: 'needs-human', endedAt: iso(NOW - 99 * H) }, NONE, 24, NOW)).toBe(false);
    // Exactly on the line is not yet settled; one ms past it is.
    const edge = { stage: 'merged', endedAt: iso(NOW - 24 * H) };
    expect(isSettled(edge, NONE, 24, NOW)).toBe(false);
    expect(isSettled(edge, NONE, 24, NOW + 1)).toBe(true);
    // An explicit `epic: null` is a standalone job.
    expect(isSettled({ ...oldMerged, epic: null }, NONE, 24, NOW)).toBe(true);
  });

  test('partition keeps order; summary counts settled jobs and takes the newest merged endedAt', () => {
    const jobs = [oldMerged, olderMerged, recentMerged, noEnd, badEnd, abandoned, working];
    const { unsettled, settled, unsettledEpics, settledEpics } = partition(jobs, NONE, 24, NOW);
    expect(unsettled.map((j) => j.id)).toEqual(['003-recent', '004-no-end', '005-bad-end', '007-working']);
    expect(settled.map((j) => j.id)).toEqual(['001-old', '002-older', '006-abandoned']);
    expect(unsettledEpics).toEqual([]);
    expect(settledEpics).toEqual([]);
    expect(summarize(settled, [])).toEqual({ count: 3, lastMergedAt: oldMerged.endedAt, epics: 0 });
    expect(summarize([], [])).toEqual({ count: 0, lastMergedAt: null, epics: 0 });
    expect(summarize([abandoned], [])).toEqual({ count: 1, lastMergedAt: null, epics: 0 });
  });

  test('nextSettle is the delay to the first unsettled merged job crossing, or null', () => {
    const soon = { stage: 'merged', endedAt: iso(NOW - 24 * H + 5000) };
    expect(nextSettle([oldMerged, recentMerged, soon, noEnd, abandoned], NONE, 24, NOW)).toBe(5001);
    expect(nextSettle([recentMerged], NONE, 24, NOW)).toBe(23 * H + 1);
    expect(nextSettle([oldMerged, noEnd, badEnd, abandoned, working], NONE, 24, NOW)).toBeNull();
    expect(nextSettle([], NONE, 24, NOW)).toBeNull();
  });
});

describe('the epic-aware settle rule (AC3)', () => {
  const longAgo = iso(NOW - 100 * H);
  test('a member of a running epic is never settled, however old its merge; an abandoned one settles at once', () => {
    for (const state of ['running', 'waiting', 'landing']) {
      const all = epics(epic('e', state, null));
      expect(isSettled(member('010-m', 'e', 'merged', longAgo), all, 24, NOW)).toBe(false);
      expect(isSettled(member('011-m', 'e', 'abandoned', longAgo), all, 24, NOW)).toBe(true);
      expect(isEpicSnapshotSettled(epic('e', state, null), 24, NOW)).toBe(false);
    }
  });

  test('an epic the board does not hold is unknown: its merged jobs are not settled', () => {
    expect(isSettled(member('010-m', 'gone', 'merged', longAgo), NONE, 24, NOW)).toBe(false);
  });

  test('a landed epic and its merged members settle together, by the epic endedAt', () => {
    const fresh = epics(epic('e', 'landed', iso(NOW - 1 * H)));
    const old = epics(epic('e', 'landed', iso(NOW - 25 * H)));
    const m = member('010-m', 'e', 'merged', longAgo);
    expect(isSettled(m, fresh, 24, NOW)).toBe(false);
    expect(isEpicSnapshotSettled(epic('e', 'landed', iso(NOW - 1 * H)), 24, NOW)).toBe(false);
    expect(isSettled(m, old, 24, NOW)).toBe(true);
    expect(isEpicSnapshotSettled(epic('e', 'landed', iso(NOW - 25 * H)), 24, NOW)).toBe(true);
    // A member merged a moment ago still settles with the epic.
    expect(isSettled(member('012-m', 'e', 'merged', iso(NOW - 1000)), old, 24, NOW)).toBe(true);
    // A landed epic with no readable endedAt never settles, nor do its members.
    expect(isSettled(m, epics(epic('e', 'landed', null)), 24, NOW)).toBe(false);
  });

  test('an abandoned epic settles at once, its merged members with it', () => {
    const all = epics(epic('e', 'abandoned', iso(NOW - 1000)));
    expect(isEpicSnapshotSettled(epic('e', 'abandoned', iso(NOW - 1000)), 24, NOW)).toBe(true);
    expect(isSettled(member('010-m', 'e', 'merged', iso(NOW - 1000)), all, 24, NOW)).toBe(true);
  });

  test('partition splits epics in slug order, and the summary counts settled epics (AC4)', () => {
    const all = epics(epic('a-landed-old', 'landed', iso(NOW - 30 * H)), epic('b-running', 'running', null), epic('c-abandoned', 'abandoned', iso(NOW)), epic('d-landed-new', 'landed', iso(NOW - H)));
    const jobs = [oldMerged, member('010-a', 'a-landed-old', 'merged', longAgo), member('011-b', 'b-running', 'merged', longAgo)];
    const r = partition(jobs, all, 24, NOW);
    expect(r.unsettledEpics.map((e) => e.slug)).toEqual(['b-running', 'd-landed-new']);
    expect(r.settledEpics.map((e) => e.slug)).toEqual(['a-landed-old', 'c-abandoned']);
    expect(r.settledEpics[0]).toBe(all.get('a-landed-old'));
    expect(r.unsettled.map((j) => j.id)).toEqual(['011-b']);
    expect(r.settled.map((j) => j.id)).toEqual(['001-old', '010-a']);
    expect(summarize(r.settled, r.settledEpics)).toEqual({ count: 2, lastMergedAt: oldMerged.endedAt, epics: 2 });
  });
});

describe('nextSettle with epics (AC5)', () => {
  test('a landed epic not yet settled arms its own crossing; members of a non-terminal epic arm nothing', () => {
    const landed = epics(epic('e', 'landed', iso(NOW - 24 * H + 7000)));
    expect(nextSettle([member('010-m', 'e', 'merged', iso(NOW - 24 * H + 1000))], landed, 24, NOW)).toBe(7001);
    // The earliest crossing among the epic and the jobs with no epic.
    const soon = { stage: 'merged', endedAt: iso(NOW - 24 * H + 3000) };
    expect(nextSettle([soon], landed, 24, NOW)).toBe(3001);
    // A running epic's members (merged long or just now) arm nothing.
    const running = epics(epic('e', 'running', null));
    expect(nextSettle([member('010-m', 'e', 'merged', iso(NOW - 24 * H + 1000))], running, 24, NOW)).toBeNull();
    // Settled or abandoned epics arm nothing.
    expect(nextSettle([], epics(epic('e', 'landed', iso(NOW - 30 * H))), 24, NOW)).toBeNull();
    expect(nextSettle([], epics(epic('e', 'abandoned', iso(NOW))), 24, NOW)).toBeNull();
  });
});

describe('one settle rule', () => {
  test('settled.ts imports the contract rule and carries no copy of its own', async () => {
    const text = await readFile(join(import.meta.dir, 'settled.ts'), 'utf8');
    expect(text).toContain("from '@factory/contract'");
    expect(text).toMatch(/isEpicSettled\(/);
    expect(text).toMatch(/settleRule\(/);
    expect(text).not.toMatch(/now - \w+ > hours \* HOUR_MS/);
    // No rule of its own on top: abandoned jobs settle by the contract rule too.
    expect(text).not.toMatch(/stage === 'abandoned'/);
  });
});
