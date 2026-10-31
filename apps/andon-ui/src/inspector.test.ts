import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMING, groupsOf, pickFile } from './docs';
import { HOUR, NOW, before, epic, inEpic, job, tag, tagEpic } from './fixtures';
import { HUB, LOCAL_FACTORY, STUDIO_FACTORY, localAt, machineEntry, machinesBody } from './fixtures';
import { jobHeader } from './inspector';
import { epicPage as epicPageOf, settledRows as settledRowsOf } from './inspector';
import { nowFor } from './machines';
import { ALL, boardEpics, boardJobs } from './projects';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';
import { summary, timingView } from './timing';
import { clock } from './time';
import {
  AUTO_HIDE_BELOW,
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  abandonCommand,
  abandonEpicCommand,
  approveCommand,
  autoHides,
  clampWidth,
  copiedText,
  currentRound,
  epicCommand,
  epicFileModel,
  epicLinkOf,
  epicPage,
  fileModel,
  quoteArg,
  reworkCommand,
  settledEpicRows,
  settledItems,
  settledRows,
  settledTitle,
  sidebarShown,
  stepFile,
  toggleSidebar,
  verdictTone,
} from './inspector';

describe('the needs-human commands (AC1)', () => {
  const id = '040-tag-migration';
  const messy = '  drop the "tags" column\\after backfill\nthen re-run\r\nthe gate  ';
  const escaped = '"drop the \\"tags\\" column\\\\after backfill then re-run the gate"';

  test('approve is the bare command', () => {
    expect(approveCommand(id)).toBe('/factory approve 040-tag-migration');
  });

  test('a note or reason is trimmed, quoted, backslash-escaped, and newlines become spaces', () => {
    expect(quoteArg(messy)).toBe(escaped);
    expect(reworkCommand(id, messy)).toEqual({ text: `/factory rework 040-tag-migration ${escaped}`, copyable: true });
    expect(abandonCommand(id, messy)).toEqual({ text: `/factory abandon 040-tag-migration ${escaped}`, copyable: true });
    expect(reworkCommand(id, 'plain')).toEqual({ text: '/factory rework 040-tag-migration "plain"', copyable: true });
  });

  test('a blank or whitespace-only note or reason is not copyable', () => {
    for (const blank of ['', '   ', '\n\t \r\n']) {
      expect(reworkCommand(id, blank).copyable).toBe(false);
      expect(abandonCommand(id, blank).copyable).toBe(false);
    }
    expect(reworkCommand(id, '').text).toBe('/factory rework 040-tag-migration ""');
  });

  test('the toast names the copied command', () => {
    expect(copiedText('/factory approve 040-tag-migration')).toBe('Copied /factory approve 040-tag-migration');
  });
});

describe('the inspector width and the sidebar rule (AC2)', () => {
  test('a width is clamped to 320–560, and the default is 392', () => {
    expect([INSPECTOR_MIN, INSPECTOR_DEFAULT, INSPECTOR_MAX]).toEqual([320, 392, 560]);
    expect(clampWidth(100)).toBe(320);
    expect(clampWidth(320)).toBe(320);
    expect(clampWidth(400.6)).toBe(401);
    expect(clampWidth(560)).toBe(560);
    expect(clampWidth(9000)).toBe(560);
    expect(clampWidth(Number.NaN)).toBe(392);
  });

  test('the sidebar auto-hides only while the inspector is open and the window is below 1640px', () => {
    expect(AUTO_HIDE_BELOW).toBe(1640);
    expect(autoHides(1440, true)).toBe(true);
    expect(autoHides(1639, true)).toBe(true);
    expect(autoHides(1640, true)).toBe(false);
    expect(autoHides(1440, false)).toBe(false);
    const user = { user: true, override: false };
    expect(sidebarShown(user, 1440, true)).toBe(false);
    expect(sidebarShown(user, 1800, true)).toBe(true);
    expect(sidebarShown({ user: false, override: false }, 1800, false)).toBe(false);
  });

  test("closing the inspector restores the user's own choice", () => {
    const shown = { user: true, override: false };
    expect(sidebarShown(shown, 1440, true)).toBe(false); // auto-hidden while open
    expect(sidebarShown(shown, 1440, false)).toBe(true); // back on close
    const hidden = { user: false, override: false };
    expect(sidebarShown(hidden, 1440, false)).toBe(false); // a hidden sidebar stays hidden
  });

  test('the toggle always flips what is on screen; showing it over the rule lasts until the inspector closes', () => {
    const auto = toggleSidebar({ user: true, override: false }, 1440, true);
    expect(auto).toEqual({ user: true, override: true });
    expect(sidebarShown(auto, 1440, true)).toBe(true);
    const off = toggleSidebar(auto, 1440, true);
    expect(sidebarShown(off, 1440, true)).toBe(false);
    expect(sidebarShown(off, 1440, false)).toBe(false);
    expect(toggleSidebar({ user: false, override: false }, 1800, false)).toEqual({ user: true, override: false });
  });
});

describe('the file model (AC3)', () => {
  // Today's drawer fixture, plus build.md and a second round.
  const files = [
    { path: 'briefs/x.md', text: 'brief' },
    { path: 'jobs/001-a/feature.md', text: 'feature' },
    { path: 'jobs/001-a/spec.md', text: '# Spec' },
    { path: 'jobs/001-a/build.md', text: '# Build' },
    { path: 'jobs/001-a/round-1/review-code.md', text: 'VERDICT: CHANGES\n…' },
    { path: 'jobs/001-a/round-1/review-security.md', text: 'PASS' },
    { path: 'jobs/001-a/round-2/review-code.md', text: 'VERDICT: PASS\n' },
    { path: 'jobs/001-a/round-2/review-security.md', text: 'VERDICT: PASS\n' },
    { path: 'jobs/001-a/decision.md', text: 'ESCALATE\nwhy' },
  ];

  test("every group and per-file verdict from groupsOf() is present, in order", () => {
    const model = fileModel(files, true, null);
    const fromDocs = groupsOf(files).map((g) => [g.name, g.files.map((f) => [f.path, f.label, f.verdict])]);
    const shown = model.groups.map((g) => [g.name, g.rows.filter((r) => r.path !== TIMING).map((r) => [r.path, r.label, r.verdict])]);
    expect(shown).toEqual(fromDocs);
    expect(model.groups.map((g) => g.name)).toEqual(['Job', 'Round 1', 'Round 2']);
  });

  test('the highest round is current', () => {
    expect(currentRound(groupsOf(files))).toBe('Round 2');
    expect(fileModel(files, false, null).groups.map((g) => g.current)).toEqual([false, false, true]);
    expect(currentRound(groupsOf(files.slice(0, 4)))).toBeNull();
    const out = groupsOf([{ path: 'jobs/x/round-10/review-a.md', text: '' }, { path: 'jobs/x/round-9/review-a.md', text: '' }]);
    expect(currentRound(out)).toBe('Round 10');
  });

  test('PASS and APPROVE are green, CHANGES orange, ESCALATE red', () => {
    expect(verdictTone('PASS')).toBe('green');
    expect(verdictTone('APPROVE')).toBe('green');
    expect(verdictTone('CHANGES')).toBe('orange');
    expect(verdictTone('ESCALATE')).toBe('red');
    expect(verdictTone(null)).toBeNull();
    const rows = fileModel(files, false, null).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.path === 'jobs/001-a/decision.md')?.tone).toBe('red');
    expect(rows.find((r) => r.path === 'jobs/001-a/round-1/review-code.md')?.tone).toBe('orange');
    expect(rows.find((r) => r.path === 'jobs/001-a/round-1/review-security.md')?.tone).toBe('green');
    const approved = fileModel([{ path: 'jobs/001-a/decision.md', text: 'APPROVE\n' }], false, null);
    expect(approved.groups[0]?.rows[0]?.tone).toBe('green');
  });

  test('the timing row is present exactly when the job has timing, first in Job', () => {
    expect(fileModel(files, true, null).groups[0]?.rows[0]).toEqual({ path: TIMING, label: 'timing', verdict: null, tone: null });
    expect(fileModel(files, false, null).groups.flatMap((g) => g.rows).some((r) => r.path === TIMING)).toBe(false);
    expect(fileModel([], true, null).groups.map((g) => g.rows.length)).toEqual([1]);
    expect(fileModel([], false, null).groups).toEqual([]);
  });

  test("the default file is pickFile()'s, and a chosen file stays while it exists", () => {
    expect(fileModel(files, true, null).selected).toBe(pickFile(null, files, true));
    expect(fileModel(files, true, TIMING).selected).toBe(TIMING);
    expect(fileModel(files, false, TIMING).selected).toBe(pickFile(TIMING, files, false));
    expect(fileModel(files, true, 'jobs/001-a/spec.md').selected).toBe('jobs/001-a/spec.md');
  });

  test('↑ and ↓ step through the rows in order, stopping at the ends', () => {
    const order = fileModel(files, true, null).order;
    expect(order[0]).toBe(TIMING);
    expect(order).toHaveLength(files.length + 1);
    expect(stepFile(order, TIMING, 1)).toBe('briefs/x.md');
    expect(stepFile(order, TIMING, -1)).toBe(TIMING);
    expect(stepFile(order, 'jobs/001-a/round-2/review-security.md', 1)).toBe('jobs/001-a/round-2/review-security.md');
    expect(stepFile(order, null, 1)).toBe(TIMING);
    expect(stepFile([], null, 1)).toBeNull();
  });
});

describe('the Settled sheet (AC4)', () => {
  const a = { id: 'pa', name: 'alpha' };
  const b = { id: 'pb', name: 'beta' };
  const settled = [
    tag(job({ id: '001-old', title: 'Old merge', stage: 'merged', round: 2, startedAt: before(80 * HOUR), endedAt: before(70 * HOUR), note: 'merged abc1234' }), a),
    tag(job({ id: '002-gave-up', title: 'Gave up', stage: 'abandoned', round: 1, startedAt: before(10 * HOUR), endedAt: before(2 * HOUR), note: 'superseded by 005' }), b),
    tag(job({ id: '003-mid', title: 'Mid merge', stage: 'merged', round: 1, startedAt: before(50 * HOUR), endedAt: before(30 * HOUR) }), b),
    tag(job({ id: '004-dropped', title: 'Dropped', stage: 'abandoned', round: 0, startedAt: before(40 * HOUR), endedAt: before(40 * HOUR), note: 'not needed' }), a),
  ];

  test('rows are newest end first', () => {
    expect(settledRows(settled, null).map((r) => r.id)).toEqual(['002-gave-up', '003-mid', '004-dropped', '001-old']);
  });

  test('a project filter keeps only that project', () => {
    expect(settledRows(settled, 'pa').map((r) => r.id)).toEqual(['004-dropped', '001-old']);
    expect(settledRows(settled, 'pb').map((r) => r.project)).toEqual(['beta', 'beta']);
  });

  test('abandoned rows carry the Abandoned tag and their note as the reason; merged rows carry no tag', () => {
    const rows = settledRows(settled, null);
    const by = (id: string) => rows.find((r) => r.id === id);
    expect(by('002-gave-up')).toMatchObject({ tag: 'Abandoned', reason: 'superseded by 005', end: NOW - 2 * HOUR });
    expect(by('004-dropped')).toMatchObject({ tag: 'Abandoned', reason: 'not needed' });
    expect(by('001-old')).toMatchObject({ tag: null, reason: null, total: '10h 00m', rounds: '2 rounds', key: 'pa/001-old', title: 'Old merge' });
    expect(by('003-mid')).toMatchObject({ tag: null, reason: null, rounds: '1 round' });
  });

  test('the title names the settle window', () => {
    expect(settledTitle(settled)).toBe('Settled · merged more than 24h ago');
    expect(settledTitle([...settled, tag(job({ id: '9', stage: 'merged' }), a, 2)])).toBe('Settled · merged more than 2h / 24h ago');
    expect(settledTitle([])).toBe('Settled · merged more than 24h ago');
  });
});

describe('the epic page (056 AC6)', () => {
  const P = { id: 'p1', name: 'one' };
  const auth = epic({
    slug: 'auth',
    target: 'main',
    startedAt: before(11 * HOUR + 40 * 60_000),
    members: [
      { slug: 'a', after: [], state: 'merged', job: '051-a', stage: 'merged', blockedOn: [] },
      { slug: 'b', after: ['a'], state: 'running', job: '052-b', stage: 'review', blockedOn: [] },
      { slug: 'c', after: ['b'], state: 'blocked', job: null, stage: null, blockedOn: [{ member: 'b', job: '052-b' }] },
      { slug: 'd', after: [], state: 'queued', job: null, stage: null, blockedOn: [] },
      { slug: 'e', after: ['a', 'd'], state: 'needs-human', job: '053-e', stage: 'needs-human', blockedOn: [] },
    ],
    generated: [{ id: '054-sync-main', kind: 'sync', stage: 'merged' }, { id: '055-fix-gate', kind: 'fix', stage: 'build' }],
  });
  const jobs = [
    inEpic({ id: '051-a', title: 'Session store', stage: 'merged', endedAt: before(HOUR) }, auth, P),
    inEpic({ id: '052-b', title: 'Token refresh', stage: 'review', round: 1, reviews: { code: 'CHANGES' } }, auth, P),
    inEpic({ id: '053-e', title: 'Login page', stage: 'needs-human' }, auth, P),
    inEpic({ id: '054-sync-main', title: 'Merge main into the epic', stage: 'merged', kind: 'sync', endedAt: before(HOUR) }, auth, P),
    inEpic({ id: '055-fix-gate', title: 'Make the gate green', stage: 'build', kind: 'fix', round: 1 }, auth, P),
  ];

  test('its pill, branch → target, timing, and progress split by member state', () => {
    const page = epicPage(tagEpic(auth, P), jobs, NOW);
    expect([page.name, page.project, page.state, page.stateLabel, page.lands, page.merged]).toEqual(['auth', 'one', 'running', 'Running', 'factory/epic/auth → main', '1/5 merged']);
    expect(page.timing).toContain('started ');
    expect(page.timing).toEndWith(' · 11h 40m running');
    expect(page.progress.map((s) => s.cls)).toEqual(['merged', 'p-review-failed', 'blocked', 'queued', 'needs-human', 'merged', 'p-build']);
    expect(page.waiting).toBeNull();
    const landed = epicPage(tagEpic(epic({ ...auth, state: 'landed', sha: 'abc1234', endedAt: before(HOUR) }), P), jobs, NOW);
    expect([landed.state, landed.timing.endsWith(' · landed after 10h 40m')]).toEqual(['landed', true]);
  });

  test('Members in plan order, each with its after: edges, state, and job link; then the Generated sync and fix jobs', () => {
    const page = epicPage(tagEpic(auth, P), jobs, NOW);
    expect(page.members.map((m) => [m.n, m.slug, m.title, m.after, m.tone, m.text, m.job?.key ?? null])).toEqual([
      [1, 'a', 'Session store', 'after: none', 'merged', 'merged in epic', 'p1/051-a'],
      [2, 'b', 'Token refresh', 'after: a', 'running', 'running · Review R1 · changes', 'p1/052-b'],
      [3, 'c', 'c', 'after: b', 'blocked', 'blocked on 052', null],
      [4, 'd', 'd', 'after: none', 'queued', 'queued', null],
      [5, 'e', 'Login page', 'after: a, d', 'needs-human', 'needs you', 'p1/053-e'],
    ]);
    expect(page.generated.map((g) => [g.kind, g.title, g.tone, g.text, g.job.num])).toEqual([
      ['sync', 'Merge main into the epic', 'merged', 'merged in epic', '054'],
      ['fix', 'Make the gate green', 'running', 'running · Build R1', '055'],
    ]);
  });

  test('waiting on you: the red box carries the note and /factory epic <slug> to copy', () => {
    const page = epicPage(tagEpic(epic({ ...auth, state: 'waiting', waitingOn: 'you', note: 'checkout is on dev' }), P), jobs, NOW);
    expect([page.state, page.stateLabel, page.waiting]).toEqual(['waiting', 'Waiting on you', { note: 'checkout is on dev', command: '/factory epic auth' }]);
    expect(epicPage(tagEpic(epic({ ...auth, state: 'waiting', waitingOn: 'members' }), P), jobs, NOW).waiting).toBeNull();
    expect(epicCommand('auth')).toBe('/factory epic auth');
  });

  test('the Abandon… sheet copies /factory epic abandon <slug> "<reason>", quoted as the job sheets quote it, and never with an empty reason', () => {
    const messy = '  drop the "auth" plan\\now\nfor good  ';
    expect(abandonEpicCommand('auth', messy)).toEqual({ text: `/factory epic abandon auth ${quoteArg(messy)}`, copyable: true });
    expect(abandonEpicCommand('auth', 'superseded')).toEqual({ text: '/factory epic abandon auth "superseded"', copyable: true });
    for (const blank of ['', '   ', '\n']) expect(abandonEpicCommand('auth', blank).copyable).toBe(false);
    const sheet = readFileSync(join(import.meta.dir, 'CommandSheet.svelte'), 'utf8');
    expect(sheet).toContain("kind === 'epic-abandon' ? abandonEpicCommand(id, text)");
    expect(sheet).toContain('disabled={!cmd.copyable}');
    expect(sheet).toContain("if (kind === 'epic-abandon') oncopy(cmd.text);");
  });

  test("a member job's page links to its epic; a standalone job's does not", () => {
    expect(epicLinkOf(jobs[0] ?? tag(job({ id: 'x' })))).toEqual({ key: 'p1/auth', text: 'Member of epic', name: 'auth' });
    expect(epicLinkOf(jobs[4] ?? tag(job({ id: 'x' })))).toEqual({ key: 'p1/auth', text: 'Generated fix job in epic', name: 'auth' });
    expect(epicLinkOf(tag(job({ id: '001-a' }), P))).toBeNull();
    expect(epicLinkOf(tag(job({ id: '001-a', epic: 'gone' }), P))).toBeNull(); // an epic Andon doesn't know: no link to a page that can't open
  });

  test('its documents: the plan, then the member briefs, the plan selected first', () => {
    const files = [
      { path: 'epics/auth.md', text: '# Auth' },
      { path: 'briefs/a.md', text: 'a' },
      { path: 'briefs/b.md', text: 'b' },
    ];
    const m = epicFileModel(files, null);
    expect(m.groups.map((g) => [g.name, g.rows.map((r) => r.label)])).toEqual([
      ['Plan', ['plan']],
      ['Member briefs', ['a.md', 'b.md']],
    ]);
    expect(m.selected).toBe('epics/auth.md');
    expect(epicFileModel(files, 'briefs/b.md').selected).toBe('briefs/b.md');
    expect(epicFileModel(files, 'briefs/gone.md').selected).toBe('epics/auth.md');
    expect(epicFileModel([], null)).toEqual({ groups: [], order: [], selected: null });
    const ins = readFileSync(join(import.meta.dir, 'Inspector.svelte'), 'utf8');
    expect(ins).toContain('fetchEpicDocs(fetcher, ep.project.id, ep.epic.slug)');
  });
});

describe('settled epics in the Settled sheet (056 AC7)', () => {
  const P = { id: 'p1', name: 'one' };
  const Q = { id: 'p2', name: 'two' };
  const old = epic({ slug: 'old', title: 'Old auth', state: 'landed', sha: 'abc1234', endedAt: before(30 * HOUR), members: [{ slug: 'a' }, { slug: 'b' }] });
  const gone = epic({ slug: 'gone', state: 'abandoned', note: 'superseded', endedAt: before(2 * HOUR), members: [{ slug: 'x' }] });
  const settled = [
    inEpic({ id: '010-a', title: 'A', stage: 'merged', endedAt: before(40 * HOUR) }, old, P),
    inEpic({ id: '011-b', title: 'B', stage: 'merged', endedAt: before(35 * HOUR) }, old, P),
    tag(job({ id: '020-solo', title: 'Solo', stage: 'merged', endedAt: before(32 * HOUR) }), P),
    inEpic({ id: '030-x', title: 'X', stage: 'abandoned', note: 'superseded', endedAt: before(3 * HOUR) }, gone, Q),
  ];
  const epics = [tagEpic(old, P), tagEpic(gone, Q)];

  test('each epic is one row with its name, outcome, landing short sha, and member count, its jobs grouped under it', () => {
    const rows = settledEpicRows(settled, epics, null);
    expect(rows.map((r) => [r.key, r.name, r.outcome, r.sha, r.members, r.reason, r.jobs.map((j) => j.id)])).toEqual([
      ['p2/gone', 'gone', 'Abandoned', null, '1 member', 'superseded', ['030-x']],
      ['p1/old', 'Old auth', 'Landed', 'abc1234', '2 members', null, ['011-b', '010-a']],
    ]);
    expect(settledEpicRows(settled, epics, 'p1').map((r) => r.key)).toEqual(['p1/old']);
  });

  test('the list: epic rows and loose jobs by end, newest first; an epic\'s jobs are never loose', () => {
    expect(settledItems(settled, epics, null).map((i) => `${i.kind}:${i.row.key}`)).toEqual(['epic:p2/gone', 'epic:p1/old', 'job:p1/020-solo']);
    expect(settledItems(settled, epics, 'p2').map((i) => `${i.kind}:${i.row.key}`)).toEqual(['epic:p2/gone']);
    // with no epics, the list is the jobs' rows, as before
    expect(settledItems(settled, [], null).map((i) => i.row.key)).toEqual(settledRows(settled, null).map((r) => r.key));
  });

  test("opening an epic row opens the epic page", () => {
    const sheet = readFileSync(join(import.meta.dir, 'SettledSheet.svelte'), 'utf8');
    expect(sheet).toContain('onclick={() => onopenepic(e.key)}');
    expect(sheet).toContain('settledItems(settled, epics, project?.id ?? null)');
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toMatch(/<SettledSheet[\s\S]*?onopenepic=\{openEpicPage\}/);
  });
});

/** rocinante (the hub) and studio, each with a `factory`; studio's has a needs-human job and an epic. */
function twoFactories(studio: Record<string, unknown> = machineEntry('studio')): UiState {
  let s = applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
  const at = new Date(localAt(13, 50)).toISOString();
  s = applyEvent(s, 'board', { project: LOCAL_FACTORY.id, config: {}, jobs: [{ id: '001-a', stage: 'build', startedAt: at, stageEnteredAt: at }] });
  s = applyEvent(s, 'board', {
    project: STUDIO_FACTORY.id,
    config: {},
    jobs: [{ id: '007-x', stage: 'needs-human', startedAt: new Date(localAt(12, 0)).toISOString(), stageEnteredAt: at, epic: 'auth', kind: 'member' }],
    epics: [{ schema: 'factory/v1', slug: 'auth', branch: 'factory/epic/auth', target: 'main', plan: 'factory/epics/auth.md', planError: null, state: 'running', waitingOn: null, note: '', session: null, sha: null, members: [], generated: [], counts: {}, startedAt: new Date(localAt(11, 0)).toISOString(), endedAt: null, updated: at }],
  });
  return applyEvent(s, 'machines', machinesBody(machineEntry(HUB), studio));
}

describe('machines in the inspector (brief andon-machines-ui)', () => {
  test("AC4: a remote job's header and crumbs name its machine; a local one's don't, and the two factories are told apart", () => {
    const jobs = boardJobs(twoFactories(), ALL);
    const remote = jobs.find((b) => b.project.id === STUDIO_FACTORY.id);
    const local = jobs.find((b) => b.project.id === LOCAL_FACTORY.id);
    if (remote === undefined || local === undefined) throw new Error('missing jobs');
    expect(jobHeader(remote)).toEqual({ bar: 'factory · studio / 007-x', project: 'factory · studio' });
    expect(jobHeader(local)).toEqual({ bar: 'factory / 001-a', project: 'factory' });
    const e = boardEpics(twoFactories(), ALL)[0];
    if (e === undefined) throw new Error('no epic');
    expect(epicPageOf(e, [remote], localAt(14, 0)).project).toBe('factory · studio');
    expect(settledRowsOf([remote, local], null).map((r) => r.project).sort()).toEqual(['factory', 'factory · studio']);
    const src = readFileSync(join(import.meta.dir, 'Inspector.svelte'), 'utf8');
    expect(src).toContain('<span class="lbl">{jobHeader(item).bar}</span>');
    expect(src).toContain('<div class="crumbs"><span>{jobHeader(item).project}</span>');
  });

  test("AC5: a stale machine's job is timed at its as-of time: its card clock, timing summary, and timing view don't advance", () => {
    const s = twoFactories(machineEntry('studio', 'down', new Date(localAt(14, 2)).toISOString()));
    const remote = boardJobs(s, ALL).find((b) => b.project.id === STUDIO_FACTORY.id);
    if (remote === undefined) throw new Error('no remote job');
    const at = (now: number) => nowFor(s, STUDIO_FACTORY.id, now);
    expect(at(localAt(16, 0))).toBe(localAt(14, 2));
    expect(clock(remote.job, at(localAt(16, 0)))).toEqual(clock(remote.job, at(localAt(19, 0))));
    expect(clock(remote.job, at(localAt(16, 0)))?.main).toBe('waiting 12m 0s');
    expect(summary(remote.job, at(localAt(16, 0)))).toEqual(summary(remote.job, at(localAt(19, 0))));
    expect(timingView(remote.job, at(localAt(16, 0)))).toEqual(timingView(remote.job, at(localAt(19, 0))));
    expect(nowFor(s, LOCAL_FACTORY.id, localAt(16, 0))).toBe(localAt(16, 0)); // a local job counts from the clock
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('const inspectorNow = $derived(nowFor(ui, inspectorPid, now));');
    expect(app).toContain('now={inspectorNow}');
  });

  test('AC1: with only the hub listed, the header carries no machine', () => {
    const s = applyEvent(twoFactories(), 'machines', machinesBody(machineEntry(HUB)));
    for (const b of boardJobs(s, ALL)) expect(jobHeader(b).project).toBe('factory');
  });
});
