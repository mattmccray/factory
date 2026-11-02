import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactTokens as contractCompact, tokensOf as contractTokensOf } from '@factory/contract';
import { NOW, before, counts, job, usageTotal } from './fixtures';
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
    expect(summary(timed, NOW)).toEqual({ recorded: true, text: 'total 1h 00m · spec 10m 0s · build 30m 0s · review 20m 0s · 2 rounds', title: null });
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
    expect(summary(legacy, NOW)).toEqual({ recorded: false, text: NO_TIMING, title: null });
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

describe('token spend in the timing view (094)', () => {
  const A = counts(1_000_000, 200_000, 30_000, 4_000_000);
  const B = counts(5_000, 1_200, 0, 90_000, null);
  const C = counts(900, 50, 0, 0);
  const agents = [
    { role: 'spec-writer', key: null, round: null, startedAt: before(59 * M), finishedAt: before(50 * M), ms: 9 * M, verdict: null, usage: A },
    { role: 'builder', key: null, round: 1, startedAt: before(49 * M), finishedAt: before(31 * M), ms: 18 * M, verdict: null, usage: B },
    { role: 'reviewer', key: 'security', round: 1, startedAt: before(29 * M), finishedAt: before(26 * M), ms: 3 * M, verdict: 'PASS', usage: { unavailable: 'transcript not found' } },
    { role: 'reviewer', key: 'code', round: 1, startedAt: before(28 * M), finishedAt: before(26 * M), ms: 2 * M, verdict: 'CHANGES', usage: C },
    { role: 'builder', key: null, round: 2, startedAt: before(24 * M), finishedAt: before(16 * M), ms: 8 * M, verdict: null },
    { role: 'reviewer', key: 'code', round: 2, startedAt: before(14 * M), finishedAt: null, ms: null, verdict: null, usage: null },
  ];
  const stages = [
    { stage: 'spec', round: 0, enteredAt: before(60 * M), exitedAt: before(50 * M), ms: 10 * M },
    { stage: 'build', round: 1, enteredAt: before(50 * M), exitedAt: before(30 * M), ms: 20 * M },
    { stage: 'review', round: 1, enteredAt: before(30 * M), exitedAt: before(25 * M), ms: 5 * M },
    { stage: 'build', round: 2, enteredAt: before(25 * M), exitedAt: before(15 * M), ms: 10 * M },
    { stage: 'review', round: 2, enteredAt: before(15 * M), exitedAt: null, ms: null },
  ];
  // The job: A + B + C counted, the unavailable review and the not-recorded build unknown, plus an orchestrator stretch.
  const sum = (u: Record<string, unknown>[], k: string) => u.reduce((n, x) => n + Number(x[k]), 0);
  const jobTotal = usageTotal(sum([A, B, C], 'input') + 7_000, sum([A, B, C], 'output') + 300, sum([A, B, C], 'cacheWrite'), sum([A, B, C], 'cacheRead') + 600_000, 6, 2);
  const orchestrator = usageTotal(7_000, 300, 0, 600_000, 1);
  const tracked = (fields: Record<string, unknown> = {}) =>
    job({ id: '094-a', stage: 'review', round: 2, startedAt: before(60 * M), timing: { stages, agents }, usage: { stages: [], rounds: [], job: jobTotal, orchestrator }, ...fields });
  const exactSum = (u: Record<string, unknown>): string => contractCompact(contractTokensOf({ input: Number(u.input), output: Number(u.output), cacheWrite: Number(u.cacheWrite), cacheRead: Number(u.cacheRead) }));

  test('AC2: each agent row: counts as the contract formats them, ? with the reason, — when not recorded, blank while running', () => {
    const rows = timingView(tracked(), NOW)?.agents ?? [];
    expect(rows.map((r) => [r.who, r.round, r.tokens.text, r.tokens.muted])).toEqual([
      ['spec-writer', '—', exactSum(A), false],
      ['builder', 'R1', exactSum(B), false],
      ['security', 'R1', '?', true],
      ['code', 'R1', exactSum(C), false],
      ['builder', 'R2', '—', true],
      ['code', 'R2', '', false],
    ]);
    expect(rows[0]?.tokens.title).toBe('input 1,000,000\noutput 200,000\ncache write 30,000\ncache read 4,000,000\nclaude-opus-5-5');
    expect(rows[1]?.tokens.title).toEndWith('cache read 90,000\nmodel not recorded');
    expect(rows[2]?.tokens.title).toBe('transcript not found');
    expect(rows[4]?.tokens.title).toBe('Not recorded (before token tracking)');
    expect(rows[5]?.tokens.title).toBeNull();
  });

  test('AC3: each stage row totals the closed agent spans that started inside it, per round', () => {
    const rows = timingView(tracked(), NOW)?.stages ?? [];
    expect(rows.map((r) => [r.stage, r.round, r.tokens.text, r.tokens.muted])).toEqual([
      ['spec', '—', exactSum(A), false],
      ['build', 'R1', exactSum(B), false],
      ['review', 'R1', `≥ ${exactSum(C)}`, false],
      ['build', 'R2', '—', true],
      ['review', 'R2', '', false],
    ]);
    expect(rows[0]?.tokens.title).toBe('input 1,000,000\noutput 200,000\ncache write 30,000\ncache read 4,000,000');
    expect(rows[2]?.tokens.title).toEndWith('\n1 span unavailable');
    // a waiting row has no agent: blank
    const waiting = job({ id: '094-b', stage: 'needs-human', round: 1, startedAt: before(60 * M), timing: { stages: [{ stage: 'needs-human', round: 1, enteredAt: before(10 * M), exitedAt: null, ms: null }], agents }, usage: { job: jobTotal, orchestrator } });
    expect(timingView(waiting, NOW)?.stages[0]?.tokens.text).toBe('');
  });

  test('AC4: a standalone job ends its Agents table with the orchestrator, and has a usage summary by kind', () => {
    const v = timingView(tracked(), NOW);
    expect(v?.orchestrator?.text).toBe(contractCompact(607_300));
    expect(v?.orchestrator?.muted).toBe(false);
    expect(v?.usage?.rows.map((r) => r.label)).toEqual(['Input', 'Output', 'Cache write', 'Cache read']);
    expect(v?.usage?.rows.every((r) => r.value.startsWith('≥ '))).toBe(true);
    expect(v?.usage?.rows[0]?.value).toBe(`≥ ${Number(jobTotal.input).toLocaleString('en-US')}`);
    expect(v?.usage?.note).toBe('2 spans unavailable');
    const exact = timingView(tracked({ usage: { job: usageTotal(1, 2, 3, 4, 1), orchestrator: usageTotal(0, 0, 0, 0, 0) } }), NOW);
    expect(exact?.usage?.rows.map((r) => r.value)).toEqual(['1', '2', '3', '4']);
    expect(exact?.orchestrator).toEqual({ text: '', muted: false, title: null }); // no stretch ended yet: blank
  });

  test('AC4: a member job reads "in epic"; a job with nothing recorded has neither the orchestrator row nor the summary', () => {
    const member = timingView(tracked({ epic: 'auth', kind: 'member', usage: { job: jobTotal, orchestrator: null } }), NOW);
    expect(member?.orchestrator).toEqual({ text: 'in epic', muted: true, title: 'Counted once for epic auth (epic page)' });
    for (const usage of [undefined, { job: usageTotal(0, 0, 0, 0, 3, 3, 'not recorded'), orchestrator: usageTotal(0, 0, 0, 0, 0) }]) {
      const v = timingView(tracked({ usage }), NOW);
      expect(v?.orchestrator).toBeNull();
      expect(v?.usage).toBeNull();
    }
    // a legacy job's spans read — (no usage on them)
    const legacy = timingView(job({ id: '094-c', stage: 'review', startedAt: before(60 * M), timing: { stages, agents: agents.map(({ usage: _, ...a }) => a) } }), NOW);
    expect(legacy?.agents.map((a) => a.tokens.text)).toEqual(['—', '—', '—', '—', '—', '']);
  });

  test('TimingView.svelte renders the Tokens column, the orchestrator row, and the usage summary', () => {
    const svelte = readFileSync(join(import.meta.dir, 'TimingView.svelte'), 'utf8');
    expect(svelte.match(/<th class="n">Tokens<\/th>/g)?.length).toBe(2);
    expect(svelte).toContain('view.orchestrator');
    expect(svelte).toContain('view.usage');
  });

  test('AC5: the summary line ends with the job total; none when nothing was counted, never 0', () => {
    expect(summary(tracked(), NOW).text).toEndWith(` · ≥ ${exactSum(jobTotal)} tokens`);
    expect(summary(tracked(), NOW).title).toEndWith('\n2 spans unavailable');
    const exact = summary(tracked({ usage: { job: usageTotal(64_000_000, 0, 0, 0, 3), orchestrator } }), NOW);
    expect(exact.text).toEndWith(' · 2 rounds · 64.0M tokens');
    const none = [undefined, { job: usageTotal(0, 0, 0, 0, 3, 3, 'not recorded'), orchestrator }, { job: usageTotal(0, 0, 0, 0, 0), orchestrator: usageTotal(0, 0, 0, 0, 0) }];
    for (const usage of none) {
      const s = summary(tracked({ usage }), NOW);
      expect(s.text).not.toContain('tokens');
      expect(s.text).toEndWith(' · 2 rounds');
      expect(s.title).toBeNull();
    }
    expect(summary(job({ id: '094-d', stage: 'merged', usage: { job: jobTotal, orchestrator } }), NOW)).toEqual({ recorded: false, text: NO_TIMING, title: null });
  });
});

describe('the Tokens cells keep their table layout (094 round 1)', () => {
  test('TimingView.svelte never reuses the board token card class `tok`', () => {
    const svelte = readFileSync(join(import.meta.dir, 'TimingView.svelte'), 'utf8');
    expect(svelte).not.toMatch(/class="[^"]*\btok\b/);
    expect(svelte.match(/class="n tcount"/g)?.length).toBe(3);
  });
});
