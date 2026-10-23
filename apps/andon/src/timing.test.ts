import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW, before, job } from './fixtures';
import { when } from './time';
import { NO_TIMING, summary, timingLine, timingView } from './timing';

const M = 60_000;
const HOUR_MS = 60 * M;
// Claimed 60m ago: spec 10m, build 20m, review R1 5m, build R2 10m, then review R2 open for 15m.
const timed = job({
  id: '001-a',
  stage: 'review',
  round: 2,
  startedAt: before(60 * M),
  stageEnteredAt: before(15 * M),
  timing: {
    stages: [
      { stage: 'claimed', round: 0, enteredAt: before(60 * M), exitedAt: before(60 * M), ms: 0 },
      { stage: 'spec', round: 0, enteredAt: before(60 * M), exitedAt: before(50 * M), ms: 10 * M },
      { stage: 'build', round: 1, enteredAt: before(50 * M), exitedAt: before(30 * M), ms: 20 * M },
      { stage: 'review', round: 1, enteredAt: before(30 * M), exitedAt: before(25 * M), ms: 5 * M },
      { stage: 'build', round: 2, enteredAt: before(25 * M), exitedAt: before(15 * M), ms: 10 * M },
      { stage: 'review', round: 2, enteredAt: before(15 * M), exitedAt: null, ms: null },
    ],
    agents: [
      { role: 'reviewer', key: 'code', round: 2, startedAt: before(14 * M), finishedAt: null, ms: null, verdict: null },
      { role: 'spec-writer', key: null, round: null, startedAt: before(59 * M), finishedAt: before(50 * M), ms: 9 * M, verdict: null },
      { role: 'reviewer', key: 'security', round: 1, startedAt: before(29 * M), finishedAt: before(26 * M), ms: 3 * M, verdict: 'CHANGES' },
      { role: 'approver', key: null, round: 1, startedAt: before(27 * M), finishedAt: before(26 * M), ms: null, verdict: null },
      { role: 'builder', key: null, round: 1, startedAt: before(49 * M), finishedAt: before(31 * M), ms: 18 * M, verdict: null, extra: 'ignored' },
    ],
  },
});

describe('drawer timing (AC2)', () => {
  test('summary: total, per-stage sums across rounds (claimed and merged excluded), rounds', () => {
    expect(summary(timed, NOW)).toEqual({ recorded: true, text: 'total 1h 00m · spec 10m 0s · build 30m 0s · review 20m 0s · 2 rounds' });
    expect(summary(timed, NOW + 5000).text).toContain('review 20m 5s');
  });

  test('a merged job totals to endedAt and never counts the merged span; needs-human reads "waiting"', () => {
    const j = job({
      id: '001-a',
      stage: 'merged',
      round: 1,
      startedAt: before(30 * M),
      endedAt: before(10 * M),
      timing: {
        stages: [
          { stage: 'spec', round: 0, enteredAt: before(30 * M), exitedAt: before(20 * M), ms: 10 * M },
          { stage: 'needs-human', round: 1, enteredAt: before(20 * M), exitedAt: before(10 * M), ms: 10 * M },
          { stage: 'merged', round: 1, enteredAt: before(10 * M), exitedAt: null, ms: null },
        ],
        agents: [],
      },
    });
    expect(summary(j, NOW).text).toBe('total 20m 0s · spec 10m 0s · waiting 10m 0s · 1 round');
    const v = timingView(j, NOW);
    expect(v?.bar.map((s) => s.stage)).toEqual(['spec', 'needs-human']);
    expect(v?.total).toBe('20m 0s');
    expect(v?.merged).not.toBeNull();
    expect(v?.agents).toEqual([]);
  });

  test('timing view: a bar segment and a row per work span, agents sorted by startedAt', () => {
    const v = timingView(timed, NOW);
    expect(v).not.toBeNull();
    expect(v?.bar.map((s) => [s.stage, s.grow])).toEqual([
      ['spec', 10 * M],
      ['build', 20 * M],
      ['review', 5 * M],
      ['build', 10 * M],
      ['review', 15 * M],
    ]);
    expect(v?.bar[2]?.title).toBe('review · R1 · 5m 0s');
    expect(v?.legend.map((l) => l.stage)).toEqual(['spec', 'build', 'review']);
    expect(v?.stages.map((r) => [r.stage, r.round, r.duration, r.open])).toEqual([
      ['spec', '—', '10m 0s', false],
      ['build', 'R1', '20m 0s', false],
      ['review', 'R1', '5m 0s', false],
      ['build', 'R2', '10m 0s', false],
      ['review', 'R2', '15m 0s', true],
    ]);
    expect(v?.agents.map((a) => [a.who, a.round, a.result, a.muted, a.duration])).toEqual([
      ['spec-writer', '—', 'done', false, '9m 0s'],
      ['builder', 'R1', 'done', false, '18m 0s'],
      ['security', 'R1', 'CHANGES', false, '3m 0s'],
      ['approver', 'R1', 'stopped', true, '1m 0s'],
      ['code', 'R2', 'running', false, '14m 0s'],
    ]);
    expect(v?.merged).toBeNull();
    expect(v?.total).toBe('1h 00m');
  });

  test('a job with no timing reports "no timing recorded" and has no timing view', () => {
    const legacy = job({ id: '001-a', stage: 'merged', updated: before(M) });
    expect(summary(legacy, NOW)).toEqual({ recorded: false, text: NO_TIMING });
    expect(NO_TIMING).toStartWith('no timing recorded');
    expect(timingView(legacy, NOW)).toBeNull();
  });
});

describe('the timing view header line (009 AC1)', () => {
  // Afternoon local times, so the formatted times end in PM (the case Svelte used to squash).
  const claimedAt = new Date(2026, 9, 22, 13, 5).getTime();
  const mergedAt = new Date(2026, 9, 22, 15, 35).getTime();
  const spaced = (line: string): void => {
    for (const sep of line.matchAll(/·/g)) {
      const i = sep.index;
      expect(line.slice(i - 2, i + 3)).toMatch(/^\S · \S$/);
    }
  };

  test('a merged job reads "Claimed <t> · merged <t> · total <d>", one space each side of every ·', () => {
    const j = job({ id: '001-a', stage: 'merged', round: 1, startedAt: new Date(claimedAt).toISOString(), endedAt: new Date(mergedAt).toISOString(), timing: { stages: [], agents: [] } });
    const v = timingView(j, mergedAt + HOUR_MS);
    expect(v?.line).toBe(`Claimed ${when(claimedAt)} · merged ${when(mergedAt)} · total 2h 30m`);
    expect(v?.line.match(/·/g)?.length).toBe(2);
    spaced(v?.line ?? '');
  });

  test('an unmerged job reads "Claimed <t> · total <d>" with no merged part', () => {
    const j = job({ id: '001-a', stage: 'build', round: 1, startedAt: new Date(claimedAt).toISOString(), timing: { stages: [], agents: [] } });
    const v = timingView(j, claimedAt + 20 * M);
    expect(v?.line).toBe(`Claimed ${when(claimedAt)} · total 20m 0s`);
    expect(v?.line).not.toContain('merged');
    spaced(v?.line ?? '');
  });

  test('timingLine joins its parts with " · " and TimingView.svelte renders the line as is', () => {
    expect(timingLine('1:05 PM', '3:35 PM', '2h 30m')).toBe('Claimed 1:05 PM · merged 3:35 PM · total 2h 30m');
    expect(timingLine('1:05 PM', null, '20m 0s')).toBe('Claimed 1:05 PM · total 20m 0s');
    const svelte = readFileSync(join(import.meta.dir, 'TimingView.svelte'), 'utf8');
    expect(svelte).toContain('<p>{view.line}</p>');
    expect(svelte).not.toContain('· merged');
  });
});
