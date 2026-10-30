import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardJob } from './board';
import { HOUR, MINUTE, NOW, before, epic, fleetJobs, inEpic, job, narrowBoard, reviewerSpan, stageSpans, stopped, tag, tagEpic } from './fixtures';
import { COLUMNS, activity, age, boardColumns, buildLanes, columnOf, epicGutter, ghostOf, headerOf, isReviewFailed, kindOf, orderLanes, popoverOf, tagOf, tokenOf } from './lanes';
import { MARK_LEGEND } from './sidebar';
import type { Kind, Lane } from './lanes';
import { ALL, withSettled } from './projects';
import { applyEvent, applySettled, emptyState, startSettled } from './state';

const P1 = { id: 'p1', name: 'one' };
const at = (fields: Record<string, unknown>, project = P1, reviewers: string[] = []): BoardJob => tag(job(fields), project, 24, reviewers);
const kind = (fields: Record<string, unknown>): string => kindOf(at(fields), NOW);
const tagText = (fields: Record<string, unknown>): string | null => {
  const b = at(fields);
  return tagOf(b.job, kindOf(b, NOW));
};

describe('kinds (AC1)', () => {
  test('every row of the §5 table', () => {
    expect(kind({ id: '001-a', stage: 'needs-human', ...stopped('escalated', 'review') })).toBe('needs-human');
    expect(kind({ id: '001-a', stage: 'review', round: 1, reviews: { code: 'PASS', ui: 'CHANGES' } })).toBe('review-failed');
    expect(kind({ id: '001-a', stage: 'review', round: 1, reviews: { code: 'pending', ui: 'CHANGES' } })).toBe('reviewing');
    expect(kind({ id: '001-a', stage: 'review', round: 1, reviews: { code: 'PASS', ui: 'PASS' } })).toBe('reviewing');
    expect(kind({ id: '001-a', stage: 'review', round: 1, reviews: {} })).toBe('reviewing');
    expect(kind({ id: '001-a', stage: 'approve' })).toBe('approve');
    expect(kind({ id: '001-a', stage: 'build' })).toBe('build');
    expect(kind({ id: '001-a', stage: 'spec' })).toBe('spec');
    expect(kind({ id: '001-a', stage: 'claimed' })).toBe('claimed');
    expect(kind({ id: '001-a', stage: 'merged', endedAt: before(23 * HOUR) })).toBe('merged');
    expect(kind({ id: '001-a', stage: 'merged', endedAt: before(25 * HOUR) })).toBe('settled');
    expect(kind({ id: '001-a', stage: 'abandoned', endedAt: before(HOUR) })).toBe('abandoned');
  });

  test('line-2 tags', () => {
    expect(tagText({ id: '001-a', stage: 'needs-human', ...stopped('escalated', 'review') })).toBe('Escalated');
    expect(tagText({ id: '001-a', stage: 'review', round: 1, reviews: { code: 'CHANGES' } })).toBe('Changes');
    expect(tagText({ id: '001-a', stage: 'review', round: 1, reviews: { code: 'pending' } })).toBeNull();
    expect(tagText({ id: '001-a', stage: 'approve' })).toBeNull();
    expect(tagText({ id: '001-a', stage: 'build', round: 0 })).toBe('Building');
    expect(tagText({ id: '001-a', stage: 'build', round: 1, reviews: { code: 'CHANGES' } })).toBe('Rework → R2');
    expect(tagText({ id: '001-a', stage: 'build', round: 2, reviews: { code: 'CHANGES' } })).toBe('Rework → R3');
    expect(tagText({ id: '001-a', stage: 'spec' })).toBe('Drafting spec');
    expect(tagText({ id: '001-a', stage: 'claimed' })).toBe('Claimed');
    expect(tagText({ id: '001-a', stage: 'merged', endedAt: before(HOUR), note: 'merged 3c9e01a' })).toBeNull(); // a merged token is one line: no tag
  });

  test('a build job after CHANGES is kind build, not review-failed', () => {
    expect(kind({ id: '001-a', stage: 'build', round: 1, reviews: { code: 'CHANGES' } })).toBe('build');
  });

  test('needs-human: the merge-failed variant comes from stoppedBy', () => {
    expect(kind({ id: '001-a', stage: 'needs-human', decision: 'ESCALATE', ...stopped('merge-failed', 'approve') })).toBe('merge-failed');
    expect(tagText({ id: '001-a', stage: 'needs-human', ...stopped('merge-failed', 'approve') })).toBe('Merge failed');
    // stoppedBy wins over the decision
    expect(kind({ id: '001-a', stage: 'needs-human', decision: 'APPROVE', ...stopped('escalated', 'approve') })).toBe('needs-human');
  });

  test('with stoppedBy null or missing: APPROVE is merge-failed, APPROVE (human) is "Approved · not merged"', () => {
    for (const s of [{}, stopped(null, null)]) {
      expect(kind({ id: '001-a', stage: 'needs-human', decision: 'APPROVE', ...s })).toBe('merge-failed');
      expect(kind({ id: '001-a', stage: 'needs-human', decision: 'APPROVE (human)', ...s })).toBe('needs-human');
      expect(tagText({ id: '001-a', stage: 'needs-human', decision: 'APPROVE (human)', ...s })).toBe('Approved · not merged');
      expect(tagText({ id: '001-a', stage: 'needs-human', decision: 'ESCALATE', ...s })).toBe('Escalated');
      expect(tagText({ id: '001-a', stage: 'needs-human', decision: null, ...s })).toBe('Escalated');
    }
  });

  test('abandoned and settled jobs are never placed in a cell', () => {
    expect(columnOf('abandoned')).toBeNull();
    expect(columnOf('settled')).toBeNull();
    const jobs = [
      at({ id: '001-a', stage: 'abandoned', endedAt: before(HOUR) }),
      at({ id: '002-b', stage: 'merged', endedAt: before(30 * HOUR) }),
      at({ id: '003-c', stage: 'merged', endedAt: before(HOUR) }),
    ];
    const [lane] = buildLanes([P1], jobs, NOW, false);
    const placed = lane?.cells.flatMap((c) => c.tokens.map((t) => t.key));
    expect(placed).toEqual(['p1/003-c']);
  });

  test('the review-failed rule: stage review, every verdict in, at least one CHANGES', () => {
    expect(isReviewFailed(job({ id: '1', stage: 'review', round: 1, reviews: { code: 'CHANGES', ui: 'PASS' } }))).toBe(true);
    expect(isReviewFailed(job({ id: '1', stage: 'review', round: 1, reviews: { code: 'CHANGES', ui: 'pending' } }))).toBe(false);
    expect(isReviewFailed(job({ id: '1', stage: 'build', round: 1, reviews: { code: 'CHANGES' } }))).toBe(false);
    expect(isReviewFailed(job({ id: '1', stage: 'review', round: 1, reviews: { code: 'PASS' } }))).toBe(false);
  });
});

describe('columns and ghosts (AC2)', () => {
  test('claimed and spec go to Spec, needs-human to Andon, merged to Merged', () => {
    expect(COLUMNS.map((c) => c.name)).toEqual(['Andon', 'Spec', 'Build', 'Review', 'Approve', 'Merged']);
    expect([columnOf('claimed'), columnOf('spec'), columnOf('needs-human'), columnOf('merge-failed'), columnOf('merged')]).toEqual(['spec', 'spec', 'andon', 'andon', 'merged']);
    expect([columnOf('build'), columnOf('reviewing'), columnOf('review-failed'), columnOf('approve')]).toEqual(['build', 'review', 'review', 'approve']);
  });

  test('a ghost goes in the column of stoppedFrom (claimed maps to Spec)', () => {
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human', ...stopped('escalated', 'approve') }))?.column).toBe('approve');
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human', ...stopped('escalated', 'claimed') }))?.column).toBe('spec');
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human', ...stopped('escalated', 'build') }))?.column).toBe('build');
  });

  test('with stoppedFrom null: the last working stage in timing.stages before needs-human; with neither, no ghost', () => {
    const timing = { stages: stageSpans([['claimed', 5 * HOUR], ['spec', 4 * HOUR], ['build', 3 * HOUR], ['review', 2 * HOUR], ['needs-human', HOUR]]), agents: [] };
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human', timing }))?.column).toBe('review');
    const fromClaim = { stages: stageSpans([['claimed', 2 * HOUR], ['needs-human', HOUR]]), agents: [] };
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human', timing: fromClaim }))?.column).toBe('spec');
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human' }))).toBeNull();
    expect(ghostOf(at({ id: '040-a', stage: 'needs-human', timing: { stages: stageSpans([['needs-human', HOUR]]), agents: [] } }))).toBeNull();
    expect(ghostOf(at({ id: '040-a', stage: 'review' }))).toBeNull();
  });

  test('the ghost reads "<num> stopped here → Andon", or "merge broke here → Andon", and carries the key', () => {
    const g = ghostOf(at({ id: '040-tag-migration', stage: 'needs-human', ...stopped('escalated', 'approve') }));
    expect(g).toEqual({ key: 'p1/040-tag-migration', column: 'approve', num: '040', text: 'stopped here → Andon', label: '040 stopped here → Andon' });
    const m = ghostOf(at({ id: '111-x', stage: 'needs-human', ...stopped('merge-failed', 'approve') }));
    expect(m?.label).toBe('111 merge broke here → Andon');
  });

  test('each needs-human job leaves exactly one ghost in its lane', () => {
    const [lane] = buildLanes([P1], [at({ id: '040-a', stage: 'needs-human', ...stopped('escalated', 'review') }), at({ id: '041-b', stage: 'review', round: 1, reviews: { code: 'pending' } })], NOW, false);
    const ghosts = lane?.cells.flatMap((c) => c.ghosts.map((g) => [c.column, g.key]));
    expect(ghosts).toEqual([['review', 'p1/040-a']]);
    expect(lane?.cells.find((c) => c.column === 'andon')?.tokens.map((t) => t.key)).toEqual(['p1/040-a']);
  });
});

// Five projects, registered in this order: A (active 1), B (needs-human), C (idle), D (review failed), E (active 3).
const PA = { id: 'a', name: 'alpha' };
const PB = { id: 'b', name: 'beta' };
const PC = { id: 'c', name: 'gamma' };
const PD = { id: 'd', name: 'delta' };
const PE = { id: 'e', name: 'eps' };
const PROJECTS = [PA, PB, PC, PD, PE];

function world(over: Partial<Record<string, BoardJob[]>> = {}): BoardJob[] {
  const base: Record<string, BoardJob[]> = {
    a: [at({ id: '001-a', stage: 'build', startedAt: before(2 * HOUR) }, PA)],
    b: [at({ id: '001-b', stage: 'needs-human', ...stopped('escalated', 'build') }, PB)],
    c: [at({ id: '001-c', stage: 'merged', endedAt: before(50 * HOUR) }, PC)],
    d: [at({ id: '001-d', stage: 'review', round: 1, reviews: { code: 'CHANGES' } }, PD)],
    e: [at({ id: '001-e', stage: 'build' }, PE), at({ id: '002-e', stage: 'spec' }, PE), at({ id: '003-e', stage: 'claimed' }, PE)],
  };
  return PROJECTS.flatMap((p) => over[p.id] ?? base[p.id] ?? []);
}
const ids = (lanes: readonly Lane[]): string[] => lanes.map((l) => l.project.id);

describe('lane order and tiers (AC3)', () => {
  test('first load: non-idle, then more needs-human, more review-failed, more active, then registration order', () => {
    const { lanes } = orderLanes(buildLanes(PROJECTS, world(), NOW, false), null);
    expect(ids(lanes)).toEqual(['b', 'd', 'e', 'a', 'c']);
  });

  test('ties fall back to registration order', () => {
    const jobs = [at({ id: '001-a', stage: 'build' }, PA), at({ id: '001-e', stage: 'build' }, PE), at({ id: '001-c', stage: 'build' }, PC)];
    expect(ids(orderLanes(buildLanes([PA, PC, PE], jobs, NOW, false), null).lanes)).toEqual(['a', 'c', 'e']);
  });

  test('a job moving from Build to Review never reorders lanes, nor does a change in active count', () => {
    const first = orderLanes(buildLanes(PROJECTS, world(), NOW, false), null);
    const moved = world({
      a: [at({ id: '001-a', stage: 'review', round: 1, reviews: { code: 'pending' } }, PA), at({ id: '002-a', stage: 'spec' }, PA), at({ id: '003-a', stage: 'spec' }, PA), at({ id: '004-a', stage: 'claimed' }, PA)],
      e: [at({ id: '001-e', stage: 'review', round: 1, reviews: { code: 'pending' } }, PE)],
    });
    const next = orderLanes(buildLanes(PROJECTS, moved, NOW, false), first.order);
    expect(ids(next.lanes)).toEqual(['b', 'd', 'e', 'a', 'c']);
    // a fresh sort would now put a (4 active) above e (1 active)
    expect(ids(orderLanes(buildLanes(PROJECTS, moved, NOW, false), null).lanes)).toEqual(['b', 'd', 'a', 'e', 'c']);
  });

  test('a lane that gains a needs-human job moves; the rest keep their places', () => {
    const first = orderLanes(buildLanes(PROJECTS, world(), NOW, false), null);
    const next = orderLanes(buildLanes(PROJECTS, world({ a: [at({ id: '001-a', stage: 'needs-human', ...stopped('escalated', 'build') }, PA)] }), NOW, false), first.order);
    // a ties b on every count, so registration order puts it first; the others keep their order
    expect(ids(next.lanes)).toEqual(['a', 'b', 'd', 'e', 'c']);
  });

  test('a lane that loses its needs-human job, or goes idle, or goes active, moves', () => {
    const first = orderLanes(buildLanes(PROJECTS, world(), NOW, false), null);
    const lost = orderLanes(buildLanes(PROJECTS, world({ b: [at({ id: '001-b', stage: 'build' }, PB)] }), NOW, false), first.order);
    expect(ids(lost.lanes)).toEqual(['d', 'e', 'a', 'b', 'c']);
    const idle = orderLanes(buildLanes(PROJECTS, world({ d: [] }), NOW, false), first.order);
    expect(ids(idle.lanes)).toEqual(['b', 'e', 'a', 'c', 'd']);
    const active = orderLanes(buildLanes(PROJECTS, world({ c: [at({ id: '002-c', stage: 'claimed' }, PC)] }), NOW, false), first.order);
    expect(ids(active.lanes)).toEqual(['b', 'd', 'e', 'a', 'c']);
    const busy = orderLanes(buildLanes(PROJECTS, world({ c: [at({ id: '002-c', stage: 'build' }, PC), at({ id: '003-c', stage: 'build' }, PC)] }), NOW, false), first.order);
    expect(ids(busy.lanes)).toEqual(['b', 'd', 'e', 'c', 'a']);
  });

  test('a review-failed job turning into a build (rework) changes the tier', () => {
    const first = orderLanes(buildLanes(PROJECTS, world(), NOW, false), null);
    const next = orderLanes(buildLanes(PROJECTS, world({ d: [at({ id: '001-d', stage: 'build', round: 1, reviews: { code: 'CHANGES' } }, PD)] }), NOW, false), first.order);
    expect(ids(next.lanes)).toEqual(['b', 'e', 'a', 'd', 'c']);
  });

  test('a newly registered project is placed by the sort; a removed one drops out', () => {
    const first = orderLanes(buildLanes([PA, PB, PC], world(), NOW, false), null);
    expect(ids(first.lanes)).toEqual(['b', 'a', 'c']);
    const next = orderLanes(buildLanes([PA, PC, PD], world(), NOW, false), first.order);
    expect(ids(next.lanes)).toEqual(['d', 'a', 'c']);
  });

  test('idle lanes (no job that is not settled) are collapsed, with the last merge and the settled count', () => {
    const lanes = buildLanes(PROJECTS, world({ c: [at({ id: '001-c', stage: 'merged', endedAt: before(84 * HOUR) }, PC), at({ id: '002-c', stage: 'abandoned', endedAt: before(HOUR) }, PC)] }), NOW, false);
    const c = lanes.find((l) => l.project.id === 'c');
    expect(c?.idle).toBe(true);
    expect(c?.idleText).toBe('Idle · last merge 3d 12h ago');
    expect(c?.meta.settled).toBe(2);
    expect(c?.rows).toBe(0);
    expect(lanes.filter((l) => l.idle).map((l) => l.project.id)).toEqual(['c']);
    // a project with only a fresh merge is not idle
    const fresh = buildLanes([PC], [at({ id: '001-c', stage: 'merged', endedAt: before(HOUR) }, PC)], NOW, false)[0];
    expect(fresh?.idle).toBe(false);
    // no merge at all
    expect(buildLanes([PC], [], NOW, false)[0]?.idleText).toBe('Idle · no merges yet');
  });
});

describe('gutter and crowded cells (AC4)', () => {
  test('gutter meta: "N active · <oldest claim age>", then "N at Andon" or "N sent back", and the settled count', () => {
    const jobs = [
      at({ id: '001-a', stage: 'build', startedAt: before(11 * HOUR + 40 * MINUTE) }),
      at({ id: '002-a', stage: 'needs-human', startedAt: before(3 * HOUR), ...stopped('escalated', 'review') }),
      at({ id: '003-a', stage: 'review', round: 1, reviews: { code: 'CHANGES' }, startedAt: before(HOUR) }),
      at({ id: '004-a', stage: 'merged', endedAt: before(30 * HOUR) }),
    ];
    const [lane] = buildLanes([P1], jobs, NOW, false);
    expect(lane?.meta).toEqual({ active: '3 active · 11h 40m', trouble: { tone: 'red', text: '1 at Andon' }, settled: 1, queued: 0 });
    expect(lane?.dot).toBe('red');
    const [failed] = buildLanes([P1], jobs.filter((b) => b.job.id !== '002-a'), NOW, false);
    expect(failed?.meta.trouble).toEqual({ tone: 'orange', text: '1 sent back' });
    expect(failed?.dot).toBe('orange');
    const [calm] = buildLanes([P1], [at({ id: '005-a', stage: 'spec' })], NOW, false);
    expect(calm?.meta).toEqual({ active: '1 active', trouble: null, settled: 0, queued: 0 }); // a legacy job has no claim time
  });

  test('the gutter header reads "N active · M idle", and each column has a count and a role', () => {
    const lanes = buildLanes(PROJECTS, world(), NOW, false);
    const h = headerOf(lanes, [24, 2]);
    expect(h.corner).toBe('4 active · 1 idle');
    expect(h.columns.map((c) => [c.key, c.count, c.who])).toEqual([
      ['andon', 1, 'needs a human'],
      ['spec', 2, 'spec-writer'],
      ['build', 2, 'builder'],
      ['review', 1, 'reviewers'],
      ['approve', 0, 'approver'],
      ['merged', 0, 'last 2 hours'],
    ]);
    expect(headerOf(lanes, []).columns[5]?.who).toBe('last 24 hours');
    expect(headerOf(lanes, [1]).columns[5]?.who).toBe('last hour');
  });

  test('cells are newest first', () => {
    const jobs = [
      at({ id: '001-a', stage: 'build', stageEnteredAt: before(3 * HOUR) }),
      at({ id: '002-a', stage: 'build', stageEnteredAt: before(1 * HOUR) }),
      at({ id: '003-a', stage: 'build', stageEnteredAt: before(2 * HOUR) }),
    ];
    const [lane] = buildLanes([P1], jobs, NOW, false);
    expect(lane?.cells.find((c) => c.column === 'build')?.tokens.map((t) => t.num)).toEqual(['002', '003', '001']);
  });

  test('four jobs in four columns need one row', () => {
    const jobs = [at({ id: '001-a', stage: 'spec' }), at({ id: '002-a', stage: 'build' }), at({ id: '003-a', stage: 'approve' }), at({ id: '004-a', stage: 'merged', endedAt: before(HOUR) })];
    const [lane] = buildLanes([P1], jobs, NOW, false);
    expect(lane?.rows).toBe(1);
    expect(lane?.cells.every((c) => c.more === 0)).toBe(true);
  });

  test('All Projects: at most 3 tokens plus "+N more"; four jobs in Build need 3 + "+1 more"', () => {
    const four = [1, 2, 3, 4].map((n) => at({ id: `00${n}-a`, stage: 'build', stageEnteredAt: before(n * HOUR) }));
    const [lane] = buildLanes([P1], four, NOW, false);
    const build = lane?.cells.find((c) => c.column === 'build');
    expect(build?.tokens.map((t) => t.num)).toEqual(['001', '002', '003']);
    expect(build?.more).toBe(1);
    expect(lane?.rows).toBe(4);
    const [three] = buildLanes([P1], four.slice(0, 3), NOW, false);
    expect(three?.rows).toBe(3);
    const [many] = buildLanes([P1], [...four, at({ id: '005-a', stage: 'build' }), at({ id: '006-a', stage: 'spec' })], NOW, false);
    expect(many?.cells.find((c) => c.column === 'build')?.more).toBe(2);
    expect(many?.rows).toBe(4);
  });

  test('a focused project is uncapped, and its Merged cell shows only unsettled merges, no dimmed tokens (050 AC5)', () => {
    const jobs = [
      ...[1, 2, 3, 4, 5].map((n) => at({ id: `00${n}-a`, stage: 'build' })),
      at({ id: '006-a', stage: 'merged', endedAt: before(HOUR) }),
      at({ id: '007-a', stage: 'merged', endedAt: before(40 * HOUR) }),
      at({ id: '008-a', stage: 'abandoned', endedAt: before(HOUR) }),
    ];
    const [lane] = buildLanes([P1], jobs, NOW, true);
    const build = lane?.cells.find((c) => c.column === 'build');
    expect(build?.tokens).toHaveLength(5);
    expect(build?.more).toBe(0);
    expect(lane?.rows).toBe(5);
    expect(lane?.cells.find((c) => c.column === 'merged')?.tokens.map((t) => t.num)).toEqual(['006']);
    expect(lane?.cells.flatMap((c) => c.tokens.map((t) => t.kind))).not.toContain('settled');
    // the job that settled on screen joins the lane's count instead
    expect(lane?.meta.settled).toBe(2);
    expect(buildLanes([P1], jobs, NOW, true, { p1: { count: 5, lastMergedAt: before(30 * HOUR) } })[0]?.meta.settled).toBe(7);
    // the settled job stays out of the All Projects lane
    expect(buildLanes([P1], jobs, NOW, false)[0]?.cells.find((c) => c.column === 'merged')?.tokens.map((t) => t.num)).toEqual(['006']);
  });
});

describe('recent activity (AC5)', () => {
  const timed = at({
    id: '041-notes',
    stage: 'review',
    round: 2,
    startedAt: before(5 * HOUR),
    timing: {
      stages: stageSpans([['claimed', 5 * HOUR], ['spec', 4 * HOUR], ['build', 3 * HOUR], ['review', 2 * HOUR], ['build', 90 * MINUTE], ['review', 30 * MINUTE]]),
      agents: [reviewerSpan('code', 1, 2 * HOUR, 100 * MINUTE, 'CHANGES'), reviewerSpan('ui', 1, 2 * HOUR, 110 * MINUTE, 'PASS'), reviewerSpan('ui', 2, 30 * MINUTE, 10 * MINUTE, 'PASS'), reviewerSpan('code', 2, 30 * MINUTE, null, null)],
    },
  });
  const merged = at({
    id: '039-digest',
    stage: 'merged',
    endedAt: before(20 * MINUTE),
    note: 'merged 3c9e01a',
    timing: { stages: stageSpans([['claimed', 6 * HOUR], ['approve', 25 * MINUTE], ['merged', 20 * MINUTE]]), agents: [] },
  });
  const legacy = at({ id: '030-old', stage: 'merged', updated: before(15 * MINUTE), note: 'merged 0ac41de' });
  const legacyLive = at({ id: '031-old', stage: 'build', updated: before(5 * MINUTE) });

  test('stage entries, reviewer verdicts, and merges, newest first, each with its time, number, text, and key', () => {
    const list = activity([timed, merged, legacy, legacyLive]);
    expect(list.slice(0, 6).map((a) => [a.num, a.text])).toEqual([
      ['041', 'R2 ui: PASS'],
      ['030', 'merged 0ac41de'],
      ['039', 'merged 3c9e01a'],
      ['039', 'entered approve'],
      ['041', 'entered review'],
      ['041', 'entered build'],
    ]);
    expect(list[0]).toEqual({ at: NOW - 10 * MINUTE, num: '041', text: 'R2 ui: PASS', key: 'p1/041-notes', tone: null });
    expect(list.find((a) => a.text === 'R1 code: CHANGES')?.tone).toBe('orange');
    for (let i = 1; i < list.length; i++) expect((list[i - 1]?.at ?? 0) >= (list[i]?.at ?? 0)).toBe(true);
  });

  test('the last 14 items only', () => {
    const many = [1, 2, 3].map((n) => at({ ...timed.job, id: `04${n}-x`, reviews: timed.job.reviews, timing: timed.job.timing }));
    expect(activity(many)).toHaveLength(14);
  });

  test('a legacy job (no timing) adds only its merge, if any', () => {
    expect(activity([legacy, legacyLive]).map((a) => [a.num, a.text])).toEqual([['030', 'merged 0ac41de']]);
  });

  test('a running reviewer and the merged stage span add nothing of their own', () => {
    const texts = activity([timed, merged]).map((a) => a.text);
    expect(texts.filter((t) => t.startsWith('R2 code'))).toEqual([]);
    expect(texts.filter((t) => t === 'entered merged')).toEqual([]);
  });
});

describe('tokens (AC6)', () => {
  test('chips: the current round, two-letter labels in project reviewer order; pending pulses only while reviewing', () => {
    const reviewers = ['security', 'contract', 'code', 'ui'];
    const b = at({ id: '023-x', stage: 'review', round: 1, maxRound: 2, reviews: { ui: 'PASS', code: 'pending', perf: 'pending', security: 'PASS', contract: 'CHANGES' } }, P1, reviewers);
    const t = tokenOf(b, NOW);
    expect(t.chips.map((c) => [c.label, c.verdict, c.pulse])).toEqual([
      ['se', 'PASS', false],
      ['ct', 'CHANGES', false],
      ['cd', 'pending', true],
      ['ui', 'PASS', false],
      ['pe', 'pending', true],
    ]);
    expect(t.round).toBe('R1/2');
    const build = tokenOf(at({ id: '023-x', stage: 'build', round: 1, reviews: { code: 'pending' } }, P1, reviewers), NOW);
    expect(build.chips.map((c) => c.pulse)).toEqual([false]);
  });

  test('line 1, line 2, and line 3 (working and needs-human kinds)', () => {
    const human = tokenOf(at({ id: '040-tag-migration', title: 'Migrate tags', stage: 'needs-human', round: 1, stageEnteredAt: before(6 * HOUR + 6 * MINUTE), note: 'approver: drops tags', ...stopped('escalated', 'approve') }), NOW);
    expect([human.num, human.title, human.tag, human.time, human.note]).toEqual(['040', 'Migrate tags', 'Escalated', '6h 6m', 'approver: drops tags']);
    const claimed = tokenOf(at({ id: '017-stage-diff', title: '017-stage-diff', stage: 'claimed' }), NOW);
    expect([claimed.num, claimed.title, claimed.time]).toEqual(['017', 'stage-diff', null]); // the title is the id until the spec names it; legacy: no time
    const build = tokenOf(at({ id: '022-x', stage: 'build', note: 'R1 ui: a note' }), NOW);
    expect(build.note).toBeNull(); // only needs-human and merge-failed get a third line
  });

  test('a merged token is one line: number, title, and the largest-unit time; no tag, chips, round, or note (038 AC1)', () => {
    const merged = tokenOf(at({ id: '039-digest', title: 'Digest', stage: 'merged', round: 1, endedAt: before(64 * MINUTE), note: 'merged 3c9e01a' }), NOW);
    expect([merged.kind, merged.num, merged.title, merged.time, merged.tag, merged.round, merged.chips, merged.note]).toEqual(['merged', '039', 'Digest', '1h', null, null, [], null]);
    const times = [42_000, 45 * MINUTE, HOUR + 59 * MINUTE, 71 * HOUR].map((ms) => tokenOf(at({ id: '039-x', stage: 'merged', round: 1, endedAt: before(ms) }), NOW).time);
    expect(times).toEqual(['42s', '45m', '1h', '2d']);
    for (const t of times) expect(t).not.toContain('ago');
  });

  test('a settled job\'s token model is the same one line (038 AC1); it is never placed in a cell (050 AC5)', () => {
    const settled = tokenOf(at({ id: '039-old', stage: 'merged', round: 2, reviews: { code: 'PASS' }, endedAt: before(71 * HOUR), note: 'merged 3c9e01a' }, P1, ['code']), NOW);
    expect([settled.kind, settled.shape, settled.label, settled.time, settled.tag, settled.round, settled.chips, settled.note]).toEqual(['settled', 'faded', 'Settled', '2d', null, null, [], null]);
    expect('dimmed' in settled).toBe(false);
    const legacy = tokenOf(at({ id: '039-legacy', stage: 'merged', note: 'merged 0ac41de' }), NOW);
    expect(legacy.time).toBeNull(); // no merge time recorded: no time, as before
  });

  test('the other kinds keep their tag, chips, round, time in stage, note, and branch (038 AC5)', () => {
    const reviewers = ['code', 'ui'];
    const tok = (f: Record<string, unknown>) => tokenOf(at(f, P1, reviewers), NOW);
    const pick = (t: ReturnType<typeof tokenOf>) => [t.kind, t.tag, t.chips.map((c) => `${c.label}:${c.verdict}`), t.round, t.time, t.note, t.branch];
    expect(pick(tok({ id: '040-a', stage: 'needs-human', round: 1, stageEnteredAt: before(6 * HOUR + 6 * MINUTE), note: 'approver: drops tags', ...stopped('escalated', 'approve') }))).toEqual(['needs-human', 'Escalated', [], 'R1/2', '6h 6m', 'approver: drops tags', 'factory/x']);
    expect(pick(tok({ id: '041-a', stage: 'needs-human', round: 1, stageEnteredAt: before(38 * MINUTE), note: 'conflict', ...stopped('merge-failed', 'approve') }))).toEqual(['merge-failed', 'Merge failed', [], 'R1/2', '38m', 'conflict', 'factory/x']);
    expect(pick(tok({ id: '042-a', stage: 'review', round: 1, stageEnteredAt: before(38 * MINUTE), reviews: { code: 'PASS', ui: 'CHANGES' } }))).toEqual(['review-failed', 'Changes', ['cd:PASS', 'ui:CHANGES'], 'R1/2', '38m', null, 'factory/x']);
    expect(pick(tok({ id: '043-a', stage: 'review', round: 2, stageEnteredAt: before(38 * MINUTE), reviews: { code: 'pending', ui: 'PASS' } }))).toEqual(['reviewing', null, ['cd:pending', 'ui:PASS'], 'R2/2', '38m', null, 'factory/x']);
    expect(pick(tok({ id: '044-a', stage: 'approve', round: 1, stageEnteredAt: before(38 * MINUTE), reviews: { code: 'PASS', ui: 'PASS' } }))).toEqual(['approve', null, ['cd:PASS', 'ui:PASS'], 'R1/2', '38m', null, 'factory/x']);
    expect(pick(tok({ id: '045-a', stage: 'build', round: 1, stageEnteredAt: before(6 * HOUR + 6 * MINUTE), reviews: { code: 'CHANGES' } }))).toEqual(['build', 'Rework → R2', ['cd:CHANGES'], 'R1/2', '6h 6m', null, 'factory/x']);
    expect(pick(tok({ id: '046-a', stage: 'spec', stageEnteredAt: before(38 * MINUTE) }))).toEqual(['spec', 'Drafting spec', [], null, '38m', null, 'factory/x']);
    expect(pick(tok({ id: '047-a', stage: 'claimed', stageEnteredAt: before(38 * MINUTE) }))).toEqual(['claimed', 'Claimed', [], null, '38m', null, 'factory/x']);
  });

  test('the merged token markup is one line: the time on line 1, no line 2 or branch (038 AC2)', () => {
    const svelte = readFileSync(join(import.meta.dir, 'Token.svelte'), 'utf8');
    // merged and settled kinds take the one-line layout
    expect(svelte).toMatch(/const oneLine = \$derived\(t\.kind === 'merged' \|\| t\.kind === 'settled'\)/);
    // line 1 holds the number, the title, and (one line only) the time
    const l1 = /<span class="l1">([\s\S]*?)<\/span>\n/.exec(svelte)?.[1] ?? '';
    expect(l1).toContain('<span class="num">{t.num}</span>');
    expect(l1).toContain('<span class="sl">{t.title}</span>');
    expect(l1).toMatch(/\{#if oneLine && t\.time !== null\}<span class="age">\{t\.time\}<\/span>\{\/if\}/);
    // line 2 and the branch line render only when it is not one line
    expect(svelte).toMatch(/\{#if !oneLine\}\s*<span class="l2">/);
    expect(svelte).toMatch(/\{#if !oneLine\}<span class="br">\{t\.branch\}<\/span>\{\/if\}/);
    // no merged check icon on a tag that no longer exists
    expect(svelte).not.toContain("t.shape === 'check'");
    // the time on line 1 never shrinks or wraps; the title is what gives way
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    const rule = /\.tok \.l1 \.age \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('flex: none');
    expect(css).toMatch(/\.tok \.age \{[^}]*margin-left: auto[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.tok \.sl \{[^}]*min-width: 0[^}]*text-overflow: ellipsis/);
  });

  test('every kind has a distinct tag, edge, or shape (never color alone)', () => {
    const marks = new Set<string>();
    const kinds = [
      { id: '001-a', stage: 'needs-human', ...stopped('escalated', 'review') },
      { id: '001-a', stage: 'needs-human', ...stopped('merge-failed', 'approve') },
      { id: '001-a', stage: 'review', round: 1, reviews: { code: 'CHANGES' } },
      { id: '001-a', stage: 'review', round: 1, reviews: { code: 'pending' } },
      { id: '001-a', stage: 'approve' },
      { id: '001-a', stage: 'build' },
      { id: '001-a', stage: 'spec' },
      { id: '001-a', stage: 'claimed' },
      { id: '001-a', stage: 'merged', endedAt: before(HOUR) },
    ].map((f) => tokenOf(at(f), NOW));
    for (const t of kinds) marks.add(`${t.kind}:${t.tag ?? ''}:${t.shape}`);
    expect(marks.size).toBe(kinds.length);
    expect(new Set(kinds.map((t) => t.shape)).size).toBe(kinds.length);
  });

  test('the popover: title, project · id, stage, time in stage, round, each round\'s verdicts, and the note', () => {
    const b = at({ id: '041-notes', title: 'Search', stage: 'review', round: 2, maxRound: 2, stageEnteredAt: before(38 * MINUTE), reviews: { code: 'pending', ui: 'PASS' }, history: [{ round: 1, reviews: { code: 'CHANGES', ui: 'PASS' } }], note: 'a note' }, P1, ['ui', 'code']);
    expect(popoverOf(b, NOW)).toEqual({
      title: 'Search',
      where: 'one · 041-notes',
      stage: 'In review',
      timeLabel: 'In stage',
      time: '38m',
      round: '2 of 2',
      rounds: [
        { round: 1, chips: [{ key: 'ui', label: 'ui', verdict: 'PASS', pulse: false }, { key: 'code', label: 'cd', verdict: 'CHANGES', pulse: false }] },
        { round: 2, chips: [{ key: 'ui', label: 'ui', verdict: 'PASS', pulse: false }, { key: 'code', label: 'cd', verdict: 'pending', pulse: true }] },
      ],
      note: 'a note',
    });
    const merged = popoverOf(at({ id: '039-x', stage: 'merged', endedAt: before(HOUR) }), NOW);
    expect([merged.timeLabel, merged.time, merged.round]).toEqual(['Merged', '1h 0m ago', '— of 2']);
  });

  test('age: s, m, h m, d h', () => {
    expect([age(42_000), age(12 * MINUTE), age(11 * HOUR + 40 * MINUTE), age(84 * HOUR), age(-5)]).toEqual(['42s', '12m', '11h 40m', '3d 12h', '0s']);
  });
});

describe('the fleet fixture (AC8)', () => {
  const jobs = fleetJobs();
  const projects = [...new Map(jobs.map((b) => [b.project.id, b.project])).values()];
  const all = [...projects, { id: 'harbor', name: 'harbor' }, { id: 'beacon', name: 'beacon' }].filter((p, i, list) => list.findIndex((q) => q.id === p.id) === i);

  test('12 projects and 30 jobs, covering every kind on the board', () => {
    expect(all).toHaveLength(12);
    expect(jobs).toHaveLength(30);
    const kinds = new Set(jobs.map((b) => kindOf(b, NOW)));
    const expected: Kind[] = ['needs-human', 'merge-failed', 'review-failed', 'reviewing', 'approve', 'build', 'spec', 'claimed', 'merged', 'settled'];
    for (const k of expected) expect({ k, has: kinds.has(k) }).toEqual({ k, has: true });
  });

  test('in All Projects every lane is short: harbor and beacon are idle, and no lane needs more than one token row', () => {
    const { lanes } = orderLanes(buildLanes(all, jobs, NOW, false), null);
    expect(lanes.filter((l) => l.idle).map((l) => l.project.name)).toEqual(['harbor', 'beacon']);
    expect(lanes.slice(0, 3).map((l) => l.project.name)).toEqual(['ledgerline', 'aegis-v5', 'minerva']);
    expect(Math.max(...lanes.map((l) => l.rows))).toBe(1);
    expect(lanes.flatMap((l) => l.cells.flatMap((c) => c.ghosts.map((g) => `${l.project.name}:${c.column}`)))).toEqual(['ledgerline:review', 'aegis-v5:approve', 'minerva:approve']);
  });
});

describe('the old board components are gone (AC7)', () => {
  test('Board.svelte and Card.svelte do not exist, and nothing imports them', () => {
    const files = readdirSync(import.meta.dir);
    expect(files).not.toContain('Board.svelte');
    expect(files).not.toContain('Card.svelte');
    const sources = [...files.filter((f) => f.endsWith('.ts') || f.endsWith('.svelte')).map((f) => join(import.meta.dir, f)), join(import.meta.dir, '..', 'main.ts')];
    for (const file of sources) expect({ file, imports: /['"]\.\/(Board|Card)\.svelte['"]/.test(readFileSync(file, 'utf8')) }).toEqual({ file, imports: false });
  });
});

describe('narrow boards: counts and idle text from the settled summary (050 AC2)', () => {
  const PN = { id: 'pn', name: 'narrow' };
  const raw = (fields: Record<string, unknown>): Record<string, unknown> => ({ title: 'A job', branch: 'factory/x', stage: 'spec', round: 0, ...fields });
  const tagAll = (list: ReadonlyArray<Record<string, unknown>>): BoardJob[] => list.map((f) => tag(job(f), PN));
  const pick = (l: Lane | undefined) => (l === undefined ? null : { meta: l.meta, idle: l.idle, idleText: l.idleText, lastMergeAt: l.lastMergeAt, rows: l.rows, cells: l.cells.map((c) => [c.column, c.tokens.map((t) => t.key), c.more]) });
  const same = (full: ReadonlyArray<Record<string, unknown>>, focused: boolean): void => {
    const n = narrowBoard(full);
    const before = buildLanes([PN], tagAll(full), NOW, focused);
    const after = buildLanes([PN], tagAll(n.jobs), NOW, focused, { pn: n.settled });
    expect(pick(after[0])).toEqual(pick(before[0]));
  };

  test('an active lane with settled history reads as it did on the full board', () => {
    const full = [
      raw({ id: '001-old', stage: 'merged', endedAt: before(84 * HOUR) }),
      raw({ id: '002-older', stage: 'merged', endedAt: before(120 * HOUR) }),
      raw({ id: '003-gone', stage: 'abandoned', endedAt: before(HOUR) }),
      raw({ id: '004-fresh', stage: 'merged', endedAt: before(2 * HOUR) }),
      raw({ id: '005-build', stage: 'build', startedAt: before(3 * HOUR) }),
      raw({ id: '006-human', stage: 'needs-human', ...stopped('escalated', 'review') }),
    ];
    same(full, false);
    expect(buildLanes([PN], tagAll(narrowBoard(full).jobs), NOW, false, { pn: narrowBoard(full).settled })[0]?.meta.settled).toBe(3);
  });

  test('an idle lane: "Idle · last merge …" from the summary\'s lastMergedAt, or the later held merge', () => {
    // only settled jobs: the summary alone
    const quiet = [raw({ id: '001-c', stage: 'merged', endedAt: before(84 * HOUR) }), raw({ id: '002-c', stage: 'abandoned', endedAt: before(HOUR) })];
    same(quiet, false);
    const [c] = buildLanes([PN], [], NOW, false, { pn: narrowBoard(quiet).settled });
    expect([c?.idle, c?.idleText, c?.meta.settled, c?.rows]).toEqual([true, 'Idle · last merge 3d 12h ago', 2, 0]);
    // a held merge newer than the summary's wins
    const [held] = buildLanes([PN], tagAll([raw({ id: '003-c', stage: 'merged', endedAt: before(30 * HOUR) })]), NOW, false, { pn: { count: 1, lastMergedAt: before(84 * HOUR) } });
    expect(held?.idleText).toBe('Idle · last merge 1d 6h ago');
    // the summary's newer than the held one wins
    const [summ] = buildLanes([PN], tagAll([raw({ id: '003-c', stage: 'merged', endedAt: before(90 * HOUR) })]), NOW, false, { pn: { count: 1, lastMergedAt: before(84 * HOUR) } });
    expect(summ?.idleText).toBe('Idle · last merge 3d 12h ago');
    // only abandoned settled jobs, nothing merged: no merges yet
    const [none] = buildLanes([PN], [], NOW, false, { pn: { count: 2, lastMergedAt: null } });
    expect([none?.idleText, none?.meta.settled]).toEqual(['Idle · no merges yet', 2]);
    expect(buildLanes([PN], [], NOW, false)[0]?.idleText).toBe('Idle · no merges yet');
  });

  test('a held job that crosses on screen leaves Merged and joins the count before the next push', () => {
    const held = tagAll([raw({ id: '009-x', stage: 'merged', endedAt: before(24 * HOUR - 1000) })]);
    const summary = { pn: { count: 4, lastMergedAt: before(48 * HOUR) } };
    const [pre] = buildLanes([PN], held, NOW, true, summary);
    expect([pre?.cells.find((c) => c.column === 'merged')?.tokens.map((t) => t.num), pre?.meta.settled]).toEqual([['009'], 4]);
    const [post] = buildLanes([PN], held, NOW + 2000, true, summary);
    expect([post?.cells.find((c) => c.column === 'merged')?.tokens.map((t) => t.num), post?.meta.settled, post?.idle]).toEqual([[], 5, true]);
  });
});

describe('a focused project\'s Recent activity draws on its settled list (050 AC6)', () => {
  const P = { id: 'aaaaaaaaaaaa', name: 'one', root: '/r/one' };
  const config = { schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
  const timed = (id: string, stage: string, ago: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: id,
    stage,
    round: 1,
    ...extra,
    timing: {
      stages: stageSpans([['claimed', ago + 5 * HOUR], ['spec', ago + 4 * HOUR], ['build', ago + 3 * HOUR], ['review', ago + 2 * HOUR], ['approve', ago + HOUR]]),
      agents: [reviewerSpan('code', 1, ago + 2 * HOUR, ago + 90 * MINUTE, 'PASS')],
    },
  });
  const full = [
    timed('040-old', 'merged', 60 * HOUR, { endedAt: before(60 * HOUR), note: 'merged aaa1111' }),
    timed('041-older', 'merged', 90 * HOUR, { endedAt: before(90 * HOUR), note: 'merged bbb2222' }),
    timed('042-dropped', 'abandoned', 30 * HOUR, { endedAt: before(30 * HOUR) }),
    timed('043-live', 'review', 0),
  ];
  const n = narrowBoard(full);
  const board = applyEvent(applyEvent(emptyState(), 'projects', { projects: [P] }), 'board', { project: P.id, jobs: n.jobs, config, settled: n.settled });

  test('with the list loaded it lists the same 14 events as the full board did, and settled jobs are never Merged tokens', () => {
    const fullState = applyEvent(applyEvent(emptyState(), 'projects', { projects: [P] }), 'board', { project: P.id, jobs: full, config });
    const expected = activity(withSettled(fullState, P.id));
    expect(expected).toHaveLength(14);
    const started = startSettled(board, P.id);
    const loaded = applySettled(started.state, P.id, started.rev, { ok: true, data: { jobs: n.settledJobs } });
    expect(activity(withSettled(loaded, P.id))).toEqual(expected);
    expect(activity(withSettled(loaded, ALL))).toEqual(expected);
    // the settled jobs feed only the activity: the focused lane holds none of them
    const [lane] = buildLanes([P], withSettled(board, P.id), NOW, true, { [P.id]: n.settled });
    expect(lane?.cells.flatMap((c) => c.tokens.map((t) => t.num))).toEqual(['043']);
  });

  test('before the list loads it is built from the held jobs alone', () => {
    expect(new Set(activity(withSettled(board, P.id)).map((a) => a.num))).toEqual(new Set(['043']));
  });
});

describe('the settled link and the Settled sheet markup (050 AC3, AC5)', () => {
  test('a lane shows its "N settled" link when focused too, opening the sheet filtered to its project', () => {
    const lane = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    const full = lane.split('{:else}')[1] ?? '';
    expect(full).toMatch(/\{#if lane\.meta\.settled > 0\}<button class="slink" type="button" aria-haspopup="dialog" onclick=\{\(\) => onsettled\(lane\.project\.id\)\}>/);
    expect(full).not.toMatch(/settled > 0 && !focused/);
  });

  test('the sheet says it is loading, shows a failed fetch\'s reason, and says "Nothing has settled" only when neither', () => {
    const sheet = readFileSync(join(import.meta.dir, 'SettledSheet.svelte'), 'utf8');
    expect(sheet).toMatch(/\{#each status\.failures as f \(f\.id\)\}/);
    expect(sheet).toMatch(/\{#if status\.loading\}\s*<li class="empty" role="status">Loading settled jobs…<\/li>\s*\{:else if status\.failures\.length === 0\}\s*<li class="empty">Nothing has settled\.<\/li>/);
    const token = readFileSync(join(import.meta.dir, 'Token.svelte'), 'utf8');
    expect(token).not.toContain('t.dimmed');
  });
});

// ---- epics (056) ----


const member = (slug: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ slug, after: [], state, job: null, stage: null, blockedOn: [], ...extra });

describe('epic sub-lanes (056 AC2)', () => {
  const auth = epic({ slug: 'auth', startedAt: before(3 * HOUR), members: [member('a', 'merged', { job: '051-a', stage: 'merged' }), member('b', 'running', { job: '052-b', stage: 'review' }), member('c', 'queued'), member('d', 'blocked', { blockedOn: [{ member: 'b', job: '052-b' }] })] });
  const older = epic({ slug: 'billing', startedAt: before(9 * HOUR), members: [member('x', 'running', { job: '060-x', stage: 'build' })] });
  const jobs: BoardJob[] = [
    at({ id: '040-solo', stage: 'build', stageEnteredAt: before(HOUR) }),
    inEpic({ id: '051-a', stage: 'merged', endedAt: before(30 * HOUR) }, auth), // older than settleAfterHours: still on the line
    inEpic({ id: '052-b', stage: 'review', round: 1, reviews: { code: 'pending' }, stageEnteredAt: before(20 * MINUTE) }, auth),
    inEpic({ id: '053-sync-main', stage: 'build', kind: 'sync', stageEnteredAt: before(5 * MINUTE) }, auth),
    inEpic({ id: '054-fix-gate', stage: 'spec', kind: 'fix', stageEnteredAt: before(4 * MINUTE) }, auth),
    inEpic({ id: '060-x', stage: 'build', stageEnteredAt: before(2 * HOUR) }, older),
  ];
  const epics = [tagEpic(auth), tagEpic(older)];
  const lane = (): Lane => {
    const l = buildLanes([P1], jobs, NOW, false, {}, epics)[0];
    if (l === undefined) throw new Error('no lane');
    return l;
  };
  const keysIn = (cells: Lane['cells']): string[] => cells.flatMap((c) => c.tokens.map((t) => `${c.column}:${t.num}`));

  test("each epic has a sub-lane in the same six columns, holding only its jobs; the project lane keeps the rest", () => {
    const l = lane();
    expect(keysIn(l.cells)).toEqual(['build:040']);
    expect(l.subs.map((s) => s.key)).toEqual(['p1/billing', 'p1/auth']); // oldest start first
    const sub = l.subs[1];
    expect(sub?.cells.map((c) => c.column)).toEqual(COLUMNS.map((c) => c.key));
    expect(keysIn(sub?.cells ?? []).sort()).toEqual(['build:053', 'merged:051', 'review:052', 'spec:054']);
    expect(keysIn(l.subs[0]?.cells ?? [])).toEqual(['build:060']);
  });

  test('generated jobs are tagged sync or fix; members and standalone jobs are not', () => {
    const tokens = [...lane().cells, ...lane().subs.flatMap((s) => s.cells)].flatMap((c) => c.tokens);
    expect(Object.fromEntries(tokens.map((t) => [t.num, t.helper]))).toEqual({ '040': null, '051': null, '052': null, '053': 'sync', '054': 'fix', '060': null });
  });

  test('queued and blocked members never become tokens: only jobs do', () => {
    const sub = lane().subs[1];
    expect(sub?.cells.flatMap((c) => c.tokens).length).toBe(4);
    expect(sub?.cells.flatMap((c) => c.tokens.map((t) => t.title))).not.toContain('c');
  });

  test('a job whose epic is missing from epics falls back to the project lane', () => {
    const lost = { ...at({ id: '070-lost', stage: 'build', epic: 'gone', kind: 'member', stageEnteredAt: before(MINUTE) }) };
    const l = buildLanes([P1], [...jobs, lost], NOW, false, {}, epics)[0];
    expect(keysIn(l?.cells ?? []).sort()).toEqual(['build:040', 'build:070']);
  });

  test('the per-cell cap applies to each sub-lane cell; focused, it is uncapped', () => {
    const many = [1, 2, 3, 4, 5].map((n) => inEpic({ id: `08${n}-m`, stage: 'build', stageEnteredAt: before(n * MINUTE) }, auth));
    const capped = buildLanes([P1], many, NOW, false, {}, [tagEpic(auth)])[0]?.subs[0];
    const build = capped?.cells.find((c) => c.column === 'build');
    expect([build?.tokens.length, build?.more, capped?.rows]).toEqual([3, 2, 4]);
    const open = buildLanes([P1], many, NOW, true, {}, [tagEpic(auth)])[0]?.subs[0];
    expect([open?.cells.find((c) => c.column === 'build')?.tokens.length, open?.cells.find((c) => c.column === 'build')?.more]).toEqual([5, 0]);
  });

  test('"+N more" in a sub-lane focuses the project (Lane.svelte)', () => {
    const src = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(src).toMatch(/\{#if cell\.more > 0\}\s*<button class="more" type="button" onclick=\{\(\) => onfocus\(lane\.project\.id\)\}>/);
    // the sub-lanes render with the same cell snippet, inside the lane's own slot, so they move with it
    expect(src).toMatch(/\{#each sub\.cells as cell \(cell\.column\)\}\s*\{@render cellOf\(/);
  });

  test("a sub-lane never reorders apart from its project lane: lanes order by project, sub-lanes ride inside", () => {
    const P2 = { id: 'p2', name: 'two' };
    const hot = epic({ slug: 'hot', waitingOn: 'you', state: 'waiting', note: 'checkout is on dev' });
    const lanes = buildLanes([P1, P2], [at({ id: '001-a', stage: 'build' }), at({ id: '002-b', stage: 'build' }, P2)], NOW, false, {}, [tagEpic(hot, P2)]);
    const ordered = orderLanes(lanes, null).lanes;
    expect(ordered.map((l) => [l.project.id, l.subs.map((s) => s.key)])).toEqual([
      ['p2', ['p2/hot']], // its waiting epic sorts the project up
      ['p1', []],
    ]);
  });

  test('a landed epic keeps its sub-lane until it settles; then its sub-lane and its merged jobs leave the board', () => {
    const landed = epic({ slug: 'auth', state: 'landed', sha: 'abc1234', endedAt: before(2 * HOUR), members: [member('a', 'merged', { job: '051-a', stage: 'merged' })] });
    const merged = inEpic({ id: '051-a', stage: 'merged', endedAt: before(30 * HOUR) }, landed);
    const fresh = buildLanes([P1], [merged], NOW, false, {}, [tagEpic(landed)])[0];
    expect(fresh?.subs.map((s) => s.key)).toEqual(['p1/auth']);
    expect(keysIn(fresh?.subs[0]?.cells ?? [])).toEqual(['merged:051']);
    const old = epic({ ...landed, endedAt: before(25 * HOUR) });
    const settled = buildLanes([P1], [{ ...merged, epic: old }], NOW, false, {}, [tagEpic(old)])[0];
    expect([settled?.subs.length, settled?.idle]).toEqual([0, true]);
  });
});

describe('the sub-lane gutter (056 AC3)', () => {
  const gutter = (fields: Record<string, unknown>, jobs: BoardJob[] = []) => epicGutter(epic(fields), jobs, NOW);
  const members = [member('a', 'merged'), member('b', 'merged'), member('c', 'merged'), member('d', 'running'), member('e', 'running'), member('f', 'blocked', { blockedOn: [{ member: 'd', job: '052-d' }] }), member('g', 'queued')];

  test('three lines: the name and dot; N/M merged · K running · elapsed; and what it waits on', () => {
    const g = gutter({ members });
    expect(g).toEqual({ name: 'auth', dot: 'blue', state: 'Running', progress: '3/7 merged · 2 running · 11h 40m', waiting: { tone: null, text: '1 blocked on 052 · 1 queued' } });
    expect(gutter({ members, title: 'Auth rewrite' }).name).toBe('Auth rewrite');
    expect(gutter({ members: [member('a', 'running')] }).waiting).toBeNull();
    // several blocked on one job, and one blocked on a member with no job yet
    expect(gutter({ members: [member('a', 'blocked', { blockedOn: [{ member: 'x', job: '052-x' }] }), member('b', 'blocked', { blockedOn: [{ member: 'x', job: '052-x' }] }), member('c', 'blocked', { blockedOn: [{ member: 'y', job: null }] })] }).waiting?.text).toBe('2 blocked on 052 · 1 blocked on y');
  });

  test('Landing… while landing; red "Waiting on you: <note>" when waitingOn is "you", which turns the dot red', () => {
    expect(gutter({ members, state: 'landing' })).toMatchObject({ dot: 'green', state: 'Landing', waiting: { tone: 'green', text: 'Landing…' } });
    expect(gutter({ members, state: 'waiting', waitingOn: 'you', note: 'checkout is on dev' })).toMatchObject({ dot: 'red', state: 'Waiting on you', waiting: { tone: 'red', text: 'Waiting on you: checkout is on dev' } });
    // a derived wait (an escalated member): the member is the needs-human token; the gutter shows what's blocked
    const auth = epic({ members });
    const derived = gutter({ members, state: 'waiting', waitingOn: 'members' }, [inEpic({ id: '052-d', stage: 'needs-human', ...stopped('escalated', 'review') }, auth)]);
    expect(derived).toMatchObject({ dot: 'red', state: 'Waiting on members', waiting: { tone: null, text: '1 blocked on 052 · 1 queued' } });
  });

  test('elapsed runs to endedAt once the epic ended', () => {
    expect(gutter({ members: [member('a', 'merged')], state: 'landed', sha: 'abc1234', startedAt: before(5 * HOUR), endedAt: before(HOUR) })).toMatchObject({ progress: '1/1 merged · 0 running · 4h 0m', waiting: { tone: 'green', text: 'Landed abc1234' } });
  });

  test('the gutter markup: indented with an elbow and a tint, the name opens the epic page, a waiting epic turns it red (Lane.svelte, app.css)', () => {
    const src = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(src).toContain('class="row lane sub" class:last={i === lane.subs.length - 1} class:hotgut={sub.hot}');
    expect(src).toContain('onclick={() => onopenepic(sub.key)}');
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    for (const rule of ['.row.sub > .gut {', '.row.sub > .gut::before {', '.row.sub.hotgut > .gut {', '.row.sub {']) expect(css).toContain(rule);
  });
});

describe('the "in epic" merged token (056 AC4)', () => {
  const auth = epic({ slug: 'auth', target: 'main' });
  const merged = inEpic({ id: '051-a', title: 'Session store', stage: 'merged', endedAt: before(HOUR), note: 'merged 3c9e01a' }, auth);

  test('a member merged into a running epic is the compact one-line merged token, marked in epic', () => {
    const t = tokenOf(merged, NOW);
    expect([t.kind, t.round, t.tag, t.chips, t.time]).toEqual(['merged', null, null, [], '1h']);
    expect(t.inEpic).toBe('Merged into factory/epic/auth · lands on main with the epic');
    const pop = popoverOf(merged, NOW);
    expect([pop.epic, pop.stage, pop.note]).toEqual(['auth', 'Merged into the epic', 'merged 3c9e01a · Merged into factory/epic/auth · lands on main with the epic']);
  });

  test('no mark once the epic is terminal, for a standalone merged job, or for an unmerged member', () => {
    expect(tokenOf({ ...merged, epic: epic({ slug: 'auth', state: 'landed', endedAt: before(MINUTE) }) }, NOW).inEpic).toBeNull();
    expect(tokenOf(at({ id: '039-x', stage: 'merged', endedAt: before(HOUR) }), NOW).inEpic).toBeNull();
    expect(tokenOf(inEpic({ id: '052-b', stage: 'build' }, auth), NOW).inEpic).toBeNull();
    // a job whose epic is unknown: never settled, and no mark (nothing says where it lands)
    const unknown = at({ id: '053-c', stage: 'merged', epic: 'gone', kind: 'member', endedAt: before(48 * HOUR) });
    expect([kindOf(unknown, NOW), tokenOf(unknown, NOW).inEpic]).toEqual(['merged', null]);
  });

  test('the markup: a dashed green edge and the branch-merge icon before the time, its tooltip and label the mark; the legend has its entry', () => {
    const token = readFileSync(join(import.meta.dir, 'Token.svelte'), 'utf8');
    expect(token).toContain('class:ie={t.inEpic !== null}');
    expect(token).toMatch(/\{#if oneLine && t\.inEpic !== null\}<span class="iem" role="img" title=\{t\.inEpic\} aria-label=\{t\.inEpic\}><svg[\s\S]*?<\/span>\{\/if\}\{#if oneLine && t\.time !== null\}<span class="age">/);
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    expect(css).toMatch(/\.tok\.ie::before \{[^}]*repeating-linear-gradient\(180deg, var\(--green\)/);
    expect(css).toMatch(/\.tok\.ie \{[^}]*border-style: dashed/);
    expect(MARK_LEGEND).toEqual([{ key: 'in-epic', label: 'In epic' }]);
    const bar = readFileSync(join(import.meta.dir, 'StatusBar.svelte'), 'utf8');
    expect(bar).toContain('{#each MARK_LEGEND as l (l.key)}');
    expect(bar).toContain('class="iem"');
  });
});

describe('epics and trouble first in the lanes (056 AC5)', () => {
  const hot = epic({ slug: 'hot', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev' });
  const auth = epic({ slug: 'auth' });

  test("a project's tier counts its epics' jobs and each epic waiting on you; one whose only activity is a waiting epic is needs-human", () => {
    const only = buildLanes([P1], [], NOW, false, {}, [tagEpic(hot)])[0];
    expect([only?.idle, only?.state, only?.dot, only?.counts]).toEqual([false, 'needs-human', 'red', { human: 1, failed: 0, active: 0 }]);
    const escalated = inEpic({ id: '052-b', stage: 'needs-human', ...stopped('escalated', 'review') }, auth);
    const working = inEpic({ id: '053-c', stage: 'build' }, auth);
    const l = buildLanes([P1], [escalated, working], NOW, false, {}, [tagEpic(auth)])[0];
    expect([l?.state, l?.counts, l?.tier]).toEqual(['needs-human', { human: 1, failed: 0, active: 2 }, 'live|1|0']); // the escalated member counts once
    expect(l?.meta.trouble).toBeNull(); // the project's own gutter counts its own cells only
    expect(l?.subs[0]?.cells.find((c) => c.column === 'andon')?.tokens.map((t) => t.num)).toEqual(['052']);
  });

  test('the header counts sub-lane jobs, and the Andon count adds each epic waiting on you', () => {
    const lanes = buildLanes([P1], [at({ id: '001-a', stage: 'needs-human', ...stopped('escalated', 'build') }), inEpic({ id: '052-b', stage: 'build' }, auth)], NOW, false, {}, [tagEpic(auth), tagEpic(hot)]);
    const h = headerOf(lanes, [24]);
    expect(h.columns.map((c) => [c.key, c.count])).toEqual([['andon', 2], ['spec', 0], ['build', 1], ['review', 0], ['approve', 0], ['merged', 0]]);
  });

  test('Needs Me: a lane shown only for its sub-lanes collapses to a one-line header; focus shows every sub-lane expanded', () => {
    const header = buildLanes([P1], [], NOW, false, {}, [tagEpic(hot)], true)[0];
    expect([header?.header, header?.rows, header?.subs.map((s) => [s.key, s.rows])]).toEqual([true, 0, [['p1/hot', 1]]]);
    const own = buildLanes([P1], [at({ id: '001-a', stage: 'needs-human', ...stopped('escalated', 'build') })], NOW, false, {}, [tagEpic(hot)], true)[0];
    expect(own?.header).toBe(false);
    expect(buildLanes([P1], [], NOW, false, {}, [tagEpic(hot)], false)[0]?.header).toBe(false); // only under Needs Me
    const focused = buildLanes([P1], [inEpic({ id: '052-b', stage: 'build' }, auth)], NOW, true, {}, [tagEpic(auth), tagEpic(hot)])[0];
    expect([focused?.idle, focused?.header, focused?.subs.map((s) => s.key)]).toEqual([false, false, ['p1/auth', 'p1/hot']]);
  });
});

// ---- the Merged column switch (063) ----

describe('063 AC3: the board with the Merged column hidden', () => {
  const merged = at({ id: '090-done', stage: 'merged', endedAt: before(2 * HOUR), note: 'merged 3c9e01a' });
  const building = at({ id: '091-wip', stage: 'build', stageEnteredAt: before(HOUR) });
  const five = COLUMNS.filter((c) => c.key !== 'merged').map((c) => c.key);
  const keysIn = (cells: Lane['cells']): string[] => cells.flatMap((c) => c.tokens.map((t) => `${c.column}:${t.num}`));

  test('the columns: all six shown, or the other five when hidden', () => {
    expect(boardColumns(false)).toEqual(COLUMNS);
    expect(boardColumns(true).map((c) => c.key)).toEqual(['andon', 'spec', 'build', 'review', 'approve']);
  });

  test('hidden: the header and every lane have the other five columns, and a merged job sits in none', () => {
    const lanes = buildLanes([P1], [merged, building], NOW, false, {}, [], false, true);
    expect(lanes[0]?.cells.map((c) => c.column)).toEqual(five);
    expect(keysIn(lanes[0]?.cells ?? [])).toEqual(['build:091']);
    const h = headerOf(lanes, [24], true);
    expect(h.columns.map((c) => c.key)).toEqual(five);
    expect(h.columns.map((c) => c.count)).toEqual([0, 0, 1, 0, 0]);
    // shown (the default): six columns, the merged job in Merged
    const shown = buildLanes([P1], [merged, building], NOW, false);
    expect(shown[0]?.cells.map((c) => c.column)).toEqual(COLUMNS.map((c) => c.key));
    expect(keysIn(shown[0]?.cells ?? []).sort()).toEqual(['build:091', 'merged:090']);
    expect(headerOf(shown, [24]).columns.map((c) => c.count)).toEqual([0, 0, 1, 0, 0, 1]);
  });

  test("hidden: an epic's sub-lane has the other five columns too, without its merged members", () => {
    const auth = epic({ slug: 'auth', startedAt: before(3 * HOUR) });
    const jobs = [inEpic({ id: '051-a', stage: 'merged', endedAt: before(HOUR) }, auth), inEpic({ id: '052-b', stage: 'review', round: 1, reviews: { code: 'pending' }, stageEnteredAt: before(MINUTE) }, auth)];
    const sub = buildLanes([P1], jobs, NOW, false, {}, [tagEpic(auth)], false, true)[0]?.subs[0];
    expect(sub?.cells.map((c) => c.column)).toEqual(five);
    expect(keysIn(sub?.cells ?? [])).toEqual(['review:052']);
    const h = headerOf(buildLanes([P1], jobs, NOW, false, {}, [tagEpic(auth)], false, true), [24], true);
    expect(h.columns.map((c) => c.count)).toEqual([0, 0, 0, 1, 0]);
  });

  test('hidden: a project whose only live job is merged is idle; its gutter still counts its settled jobs', () => {
    const [lane] = buildLanes([P1], [merged], NOW, false, { p1: { count: 2, lastMergedAt: null } }, [], false, true);
    expect(lane?.idle).toBe(true);
    expect(lane?.rows).toBe(0);
    expect(lane?.idleText).toBe('Idle · last merge 2h 0m ago');
    expect(lane?.meta.settled).toBe(2);
    expect(buildLanes([P1], [merged], NOW, false)[0]?.idle).toBe(false); // shown: it sits in Merged
  });

  test("hidden: a focused project's recent activity still lists the merge, and the Settled sheet's jobs are untouched", () => {
    expect(activity([merged]).map((a) => a.text)).toContain('merged 3c9e01a');
    const [lane] = buildLanes([P1], [merged, building], NOW, true, {}, [], false, true);
    expect(lane?.cells.map((c) => c.column)).toEqual(five);
  });

  test('Lines.svelte sizes the matrix by the header: the others share the hidden column\'s width', () => {
    const lines = readFileSync(join(import.meta.dir, 'Lines.svelte'), 'utf8');
    expect(lines).toContain('style:--n={header.columns.length}');
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    expect(css).toContain('.matrix { --cols: 148px repeat(var(--n, 6), minmax(150px, 1fr)); min-width: calc(148px + var(--n, 6) * 150px);');
    expect(css).toContain('.lines.focus .matrix { --cols: 180px repeat(var(--n, 6), minmax(150px, 1fr)); min-width: calc(180px + var(--n, 6) * 150px); }');
  });
});

describe('067 AC1: the "N queued" gutter link', () => {
  const P2 = { id: 'p2', name: 'two' };
  const jobs = [at({ id: '001-a', stage: 'build', startedAt: before(HOUR) }), at({ id: '002-b', stage: 'spec' }, P2)];

  test('the gutter meta carries the board\'s queued count; nothing else on the lane changes', () => {
    const without = buildLanes([P1, P2], jobs, NOW, false, {}, [], false, false);
    const withCounts = buildLanes([P1, P2], jobs, NOW, false, {}, [], false, false, { p1: { queued: 3, exploring: 1 } });
    expect(withCounts.map((l) => l.meta.queued)).toEqual([3, 0]);
    expect(without.map((l) => l.meta.queued)).toEqual([0, 0]);
    const strip = (l: Lane) => ({ ...l, meta: { ...l.meta, queued: 0 } });
    expect(withCounts.map(strip)).toEqual(without);
    // an idle lane carries it too
    const [idle] = buildLanes([P2], [], NOW, false, {}, [], false, false, { p2: { queued: 2, exploring: 0 } });
    expect([idle?.idle, idle?.meta.queued]).toEqual([true, 2]);
  });

  test('the lane shows the link beside "N settled" only when queued > 0, and it opens the sheet filtered to the project', () => {
    const lane = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(lane).toContain('{#if lane.meta.queued > 0}');
    expect(lane).toContain('onclick={() => onbacklog(lane.project.id)}>{lane.meta.queued} queued</button>');
    expect(lane).toContain('onclick={() => onbacklog(lane.project.id)}>Queued <b>{lane.meta.queued}</b></button>');
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('onbacklog={openBacklog}');
    expect(app).toContain('backlogCounts = $derived(Object.fromEntries(ui.projects.map((p): [string, BacklogCounts] => [p.id, ui.boards[p.id]?.backlog ?? NO_BACKLOG])))');
  });
});
