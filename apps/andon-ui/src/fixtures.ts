// Test fixtures: jobs as the service sends them (plain JSON), narrowed the way the UI narrows them,
// plus the design's 12-project, 30-job fleet (docs/design/andon-overview/README.md "The fixture")
// for the Assembly Lines fit check. `writeFleet` lays the fleet out on disk as a throwaway Andon
// home (a registry and 12 project roots) that a real service can serve, for screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardEpic, BoardJob } from './board';
import { toEpic, toJob } from './job';
import type { Epic, Job } from './job';

export const NOW = Date.parse('2026-10-22T12:00:00.000Z');
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
/** An ISO time `ms` before `NOW`. */
export const before = (ms: number): string => new Date(NOW - ms).toISOString();

/** A job.json value (unknown fields allowed), narrowed. */
export function job(fields: Record<string, unknown>): Job {
  const j = toJob({ title: 'A job', branch: 'factory/x', stage: 'spec', round: 0, ...fields });
  if (j === null) throw new Error('fixture has no id');
  return j;
}

export function tag(j: Job, project = { id: 'p1', name: 'one' }, settleAfterHours = 24, reviewers: string[] = []): BoardJob {
  return { key: `${project.id}/${j.id}`, project, settleAfterHours, reviewers, job: j };
}

/** An epic.json value (unknown fields allowed), narrowed: a running epic `auth` on main, started 11h 40m ago, by default. */
export function epic(fields: Record<string, unknown>): Epic {
  const slug = typeof fields.slug === 'string' ? fields.slug : 'auth';
  const e = toEpic({
    schema: 'factory/v1',
    slug,
    branch: `factory/epic/${slug}`,
    target: 'main',
    plan: `factory/epics/${slug}.md`,
    planError: null,
    state: 'running',
    waitingOn: null,
    note: '',
    session: null,
    sha: null,
    members: [],
    generated: [],
    counts: {},
    startedAt: before(11 * HOUR + 40 * MINUTE),
    endedAt: null,
    updated: before(MINUTE),
    ...fields,
  });
  if (e === null) throw new Error('fixture has no slug');
  return e;
}

/** An epic tagged with its project, as `boardEpics` tags one. */
export const tagEpic = (e: Epic, project = { id: 'p1', name: 'one' }, settleAfterHours = 24): BoardEpic => ({ key: `${project.id}/${e.slug}`, project, settleAfterHours, epic: e });

/** A job in an epic, tagged with its project and its epic (as `boardJobs` tags one). */
export function inEpic(fields: Record<string, unknown>, e: Epic, project = { id: 'p1', name: 'one' }, settleAfterHours = 24): BoardJob {
  const j = job({ epic: e.slug, kind: 'member', target: `factory/epic/${e.slug}`, ...fields });
  return { ...tag(j, project, settleAfterHours), epic: e };
}

/** Why a job stopped, as job 022's snapshot fields: `stopped('merge-failed', 'approve')`. */
export const stopped = (by: string | null, from: string | null): Record<string, unknown> => ({ stoppedBy: by, stoppedFrom: from });

/**
 * A `timing.stages` list from `[stage, msAgo]` pairs in order: each span exits when the next one
 * enters, and the last stays open. A span's round is the number of review entries so far, as the
 * contract's `round.started` bumps the round as review is entered.
 */
export function stageSpans(history: ReadonlyArray<readonly [string, number]>, at: (msAgo: number) => string = before): Array<Record<string, unknown>> {
  let round = 0;
  return history.map(([stage, ago], i) => {
    if (stage === 'review') round++;
    const next = history[i + 1];
    return { stage, round, enteredAt: at(ago), exitedAt: next === undefined ? null : at(next[1]), ms: next === undefined ? null : ago - next[1] };
  });
}

/** A reviewer's `timing.agents` span: finished with a verdict, or open (finishedAgo null). */
export function reviewerSpan(key: string, round: number, startedAgo: number, finishedAgo: number | null, verdict: string | null, at: (msAgo: number) => string = before): Record<string, unknown> {
  return {
    role: 'reviewer',
    key,
    round,
    startedAt: at(startedAgo),
    finishedAt: finishedAgo === null ? null : at(finishedAgo),
    ms: finishedAgo === null ? null : startedAgo - finishedAgo,
    verdict: finishedAgo === null ? null : verdict,
  };
}

// ---- the fleet: 12 projects, 30 jobs, one frozen moment (the design's mockups/data.js) ----

export interface FleetProject {
  name: string;
  reviewers: string[];
}

/** The registered projects, in registration order. */
export const FLEET_PROJECTS: readonly FleetProject[] = [
  { name: 'factory', reviewers: ['security', 'contract', 'code', 'ui'] },
  { name: 'minerva', reviewers: ['security', 'ux', 'ui', 'code'] },
  { name: 'aegis-v5', reviewers: ['security', 'code', 'ui'] },
  { name: 'brain-cli', reviewers: ['code'] },
  { name: 'tinyjs', reviewers: ['code', 'ui'] },
  { name: 'ledgerline', reviewers: ['security', 'code'] },
  { name: 'harbor', reviewers: ['security', 'code'] },
  { name: 'quill', reviewers: ['ux', 'code'] },
  { name: 'orchard', reviewers: ['security', 'ux', 'code'] },
  { name: 'beacon', reviewers: ['code'] },
  { name: 'cartograph', reviewers: ['code', 'ui'] },
  { name: 'sundial', reviewers: ['code'] },
];

type Verdict = readonly [string, number | null]; // [verdict, finished minutes ago | null: still running]
interface FleetJob {
  project: string;
  id: string;
  title: string;
  stage: string;
  history: ReadonlyArray<readonly [string, number]>; // [stage, minutes ago]
  rounds: ReadonlyArray<{ at: number; reviews: Record<string, Verdict> }>;
  decision?: string;
  note?: string;
  stoppedBy?: string;
  stoppedFrom?: string;
}

const FLEET_JOBS: readonly FleetJob[] = [
  { project: 'factory', id: '022-board-timeline', title: 'Timeline view for the Andon overview', stage: 'build', history: [['claimed', 52], ['spec', 50], ['build', 31]], rounds: [] },
  { project: 'factory', id: '023-upgrade-dry-run', title: 'factory upgrade --dry-run prints the plan', stage: 'review', history: [['claimed', 140], ['spec', 138], ['build', 121], ['review', 64]],
    rounds: [{ at: 64, reviews: { security: ['PASS', 41], contract: ['pending', null], code: ['pending', null], ui: ['PASS', 58] } }] },
  { project: 'factory', id: '021-tinyjs-065-types', title: 'Move the Mac app to Tiny JS 0.65 types', stage: 'merged', history: [['claimed', 410], ['spec', 405], ['build', 380], ['review', 300], ['approve', 230], ['merged', 214]],
    rounds: [{ at: 300, reviews: { security: ['PASS', 270], contract: ['PASS', 262], code: ['PASS', 241], ui: ['PASS', 255] } }], decision: 'APPROVE', note: 'merged 7905ffe' },
  { project: 'factory', id: '020-overlay-outcome', title: 'Overlay outcome rule in role templates', stage: 'merged', history: [['claimed', 2900], ['spec', 2890], ['build', 2860], ['review', 2790], ['build', 2740], ['review', 2690], ['approve', 2640], ['merged', 2620]],
    rounds: [{ at: 2790, reviews: { security: ['PASS', 2770], contract: ['CHANGES', 2750], code: ['PASS', 2760], ui: ['PASS', 2775] } }, { at: 2690, reviews: { security: ['PASS', 2670], contract: ['PASS', 2655], code: ['PASS', 2660], ui: ['PASS', 2680] } }],
    decision: 'APPROVE', note: 'merged a1edc16' },

  { project: 'minerva', id: '041-notes-search', title: 'Full-text search across notes', stage: 'review', history: [['claimed', 300], ['spec', 296], ['build', 270], ['review', 200], ['build', 160], ['review', 38]],
    rounds: [{ at: 200, reviews: { security: ['PASS', 180], ux: ['PASS', 175], ui: ['PASS', 178], code: ['CHANGES', 162] } }, { at: 38, reviews: { security: ['PASS', 22], ux: ['pending', null], ui: ['PASS', 19], code: ['pending', null] } }] },
  { project: 'minerva', id: '040-tag-migration', title: 'Migrate tags to a join table', stage: 'needs-human', history: [['claimed', 520], ['spec', 515], ['build', 490], ['review', 430], ['approve', 380], ['needs-human', 366]],
    rounds: [{ at: 430, reviews: { security: ['PASS', 410], ux: ['PASS', 405], ui: ['PASS', 400], code: ['PASS', 392] } }], decision: 'ESCALATE', note: 'approver: migration drops notes.tags without a backfill', stoppedBy: 'escalated', stoppedFrom: 'approve' },
  { project: 'minerva', id: '039-daily-digest', title: 'Daily digest email', stage: 'merged', history: [['claimed', 240], ['spec', 236], ['build', 210], ['review', 150], ['approve', 90], ['merged', 64]],
    rounds: [{ at: 150, reviews: { security: ['PASS', 130], ux: ['PASS', 120], ui: ['PASS', 125], code: ['PASS', 100] } }], decision: 'APPROVE', note: 'merged 3c9e01a' },
  { project: 'minerva', id: '038-keyboard-nav', title: 'Keyboard navigation in the sidebar', stage: 'merged', history: [['claimed', 3100], ['spec', 3095], ['build', 3070], ['review', 3010], ['approve', 2960], ['merged', 2950]],
    rounds: [{ at: 3010, reviews: { security: ['PASS', 2990], ux: ['PASS', 2980], ui: ['PASS', 2985], code: ['PASS', 2970] } }], decision: 'APPROVE', note: 'merged 77ad2b0' },

  { project: 'aegis-v5', id: '112-admin-roles', title: 'Admin role editor', stage: 'approve', history: [['claimed', 180], ['spec', 176], ['build', 150], ['review', 70], ['approve', 6]],
    rounds: [{ at: 70, reviews: { security: ['PASS', 30], code: ['PASS', 12], ui: ['PASS', 44] } }] },
  { project: 'aegis-v5', id: '113-audit-log', title: 'Audit log for project changes', stage: 'spec', history: [['claimed', 9], ['spec', 7]], rounds: [] },
  { project: 'aegis-v5', id: '111-session-timeout', title: 'Configurable session timeout', stage: 'needs-human', history: [['claimed', 400], ['spec', 396], ['build', 370], ['review', 310], ['approve', 250], ['needs-human', 232]],
    rounds: [{ at: 310, reviews: { security: ['PASS', 290], code: ['PASS', 270], ui: ['PASS', 280] } }], decision: 'APPROVE', note: 'merge failed: conflict in src/routes/(admin)/+layout.svelte', stoppedBy: 'merge-failed', stoppedFrom: 'approve' },
  { project: 'aegis-v5', id: '110-project-archive', title: 'Archive projects', stage: 'merged', history: [['claimed', 4300], ['spec', 4295], ['build', 4270], ['review', 4200], ['approve', 4150], ['merged', 4140]],
    rounds: [{ at: 4200, reviews: { security: ['PASS', 4180], code: ['PASS', 4170], ui: ['PASS', 4175] } }], decision: 'APPROVE', note: 'merged e01f9c2' },

  { project: 'brain-cli', id: '017-stage-diff', title: '017-stage-diff', stage: 'claimed', history: [['claimed', 1]], rounds: [] },
  { project: 'brain-cli', id: '016-milestone-close', title: 'Close a milestone from the CLI', stage: 'merged', history: [['claimed', 470], ['spec', 466], ['build', 440], ['review', 400], ['approve', 380], ['merged', 372]],
    rounds: [{ at: 400, reviews: { code: ['PASS', 385] } }], decision: 'APPROVE', note: 'merged 5b2d7e4' },

  { project: 'tinyjs', id: '066-tray-menu', title: 'Tray menu API', stage: 'build', history: [['claimed', 220], ['spec', 216], ['build', 190], ['review', 120], ['build', 17]],
    rounds: [{ at: 120, reviews: { code: ['PASS', 90], ui: ['CHANGES', 20] } }], note: 'R1 ui: menu items ignore the disabled flag' },
  { project: 'tinyjs', id: '065-window-types', title: 'Ship window types in the package', stage: 'merged', history: [['claimed', 1900], ['spec', 1896], ['build', 1870], ['review', 1820], ['approve', 1790], ['merged', 1780]],
    rounds: [{ at: 1820, reviews: { code: ['PASS', 1800], ui: ['PASS', 1805] } }], decision: 'APPROVE', note: 'merged 0ac41de' },

  { project: 'ledgerline', id: '008-csv-import', title: 'Import transactions from CSV', stage: 'review', history: [['claimed', 160], ['spec', 156], ['build', 130], ['review', 55]],
    rounds: [{ at: 55, reviews: { security: ['CHANGES', 3], code: ['PASS', 26] } }], note: 'R1 security: CSV formulas not escaped on export' },
  { project: 'ledgerline', id: '007-oauth-banks', title: 'OAuth bank connections', stage: 'needs-human', history: [['claimed', 700], ['spec', 695], ['build', 660], ['review', 590], ['build', 560], ['review', 470], ['needs-human', 440]],
    rounds: [{ at: 590, reviews: { security: ['CHANGES', 565], code: ['PASS', 575] } }, { at: 470, reviews: { security: ['CHANGES', 442], code: ['PASS', 455] } }],
    note: 'review budget spent: security CHANGES in R2 (tokens logged)', stoppedBy: 'escalated', stoppedFrom: 'review' },
  { project: 'ledgerline', id: '006-currency-format', title: 'Locale-aware currency format', stage: 'merged', history: [['claimed', 2300], ['spec', 2296], ['build', 2270], ['review', 2220], ['approve', 2190], ['merged', 2185]],
    rounds: [{ at: 2220, reviews: { security: ['PASS', 2200], code: ['PASS', 2205] } }], decision: 'APPROVE', note: 'merged 91be3f0' },

  { project: 'harbor', id: '014-health-checks', title: 'Container health checks', stage: 'merged', history: [['claimed', 5200], ['spec', 5195], ['build', 5160], ['review', 5100], ['approve', 5070], ['merged', 5060]],
    rounds: [{ at: 5100, reviews: { security: ['PASS', 5080], code: ['PASS', 5085] } }], decision: 'APPROVE', note: 'merged 4d0c8aa' },
  { project: 'harbor', id: '013-port-ranges', title: 'Port range validation', stage: 'merged', history: [['claimed', 6100], ['spec', 6095], ['build', 6070], ['review', 6000], ['build', 5970], ['review', 5900], ['approve', 5870], ['merged', 5860]],
    rounds: [{ at: 6000, reviews: { security: ['PASS', 5980], code: ['CHANGES', 5975] } }, { at: 5900, reviews: { security: ['PASS', 5885], code: ['PASS', 5880] } }], decision: 'APPROVE', note: 'merged 2e7b11c' },

  { project: 'quill', id: '003-export-pdf', title: 'Export a draft to PDF', stage: 'build', history: [['claimed', 75], ['spec', 72], ['build', 48]], rounds: [] },
  { project: 'quill', id: '002-word-count', title: 'Live word count', stage: 'merged', history: [['claimed', 1300], ['spec', 1296], ['build', 1270], ['review', 1230], ['approve', 1210], ['merged', 1200]],
    rounds: [{ at: 1230, reviews: { ux: ['PASS', 1215], code: ['PASS', 1218] } }], decision: 'APPROVE', note: 'merged c3f0b19' },

  { project: 'orchard', id: '019-sync-retry', title: 'Retry failed syncs with backoff', stage: 'review', history: [['claimed', 95], ['spec', 92], ['build', 70], ['review', 12]],
    rounds: [{ at: 12, reviews: { security: ['pending', null], ux: ['pending', null], code: ['pending', null] } }] },
  { project: 'orchard', id: '018-offline-queue', title: 'Offline write queue', stage: 'merged', history: [['claimed', 3600], ['spec', 3595], ['build', 3560], ['review', 3500], ['approve', 3470], ['merged', 3460]],
    rounds: [{ at: 3500, reviews: { security: ['PASS', 3480], ux: ['PASS', 3485], code: ['PASS', 3478] } }], decision: 'APPROVE', note: 'merged 6a5e2d9' },

  { project: 'beacon', id: '005-status-page', title: 'Public status page', stage: 'merged', history: [['claimed', 8000], ['spec', 7995], ['build', 7960], ['review', 7900], ['approve', 7880], ['merged', 7870]],
    rounds: [{ at: 7900, reviews: { code: ['PASS', 7885] } }], decision: 'APPROVE', note: 'merged b77e0f3' },

  { project: 'cartograph', id: '031-tile-cache', title: 'Disk cache for map tiles', stage: 'approve', history: [['claimed', 260], ['spec', 256], ['build', 230], ['review', 170], ['build', 140], ['review', 60], ['approve', 14]],
    rounds: [{ at: 170, reviews: { code: ['CHANGES', 145], ui: ['PASS', 150] } }, { at: 60, reviews: { code: ['PASS', 15], ui: ['PASS', 40] } }] },
  { project: 'cartograph', id: '030-geojson-layers', title: 'GeoJSON overlay layers', stage: 'merged', history: [['claimed', 330], ['spec', 326], ['build', 300], ['review', 230], ['approve', 140], ['merged', 128]],
    rounds: [{ at: 230, reviews: { code: ['PASS', 160], ui: ['PASS', 190] } }], decision: 'APPROVE', note: 'merged 8f13ac7' },

  { project: 'sundial', id: '005-cron-parse', title: 'Parse cron expressions', stage: 'spec', history: [['claimed', 22], ['spec', 20]], rounds: [] },
  { project: 'sundial', id: '004-tz-support', title: 'Time zone support', stage: 'merged', history: [['claimed', 2600], ['spec', 2596], ['build', 2570], ['review', 2520], ['approve', 2500], ['merged', 2490]],
    rounds: [{ at: 2520, reviews: { code: ['PASS', 2505] } }], decision: 'APPROVE', note: 'merged 1d4e6b8' },
];

const reviewsOf = (r: { reviews: Record<string, Verdict> }): Record<string, string> => Object.fromEntries(Object.entries(r.reviews).map(([k, [v]]) => [k, v]));

/** One fleet job as its `job.json`, with times measured back from `now`. */
function fleetJson(f: FleetJob, now: number): Record<string, unknown> {
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * MINUTE).toISOString();
  const first = f.history[0];
  const last = f.history[f.history.length - 1];
  if (first === undefined || last === undefined) throw new Error(`${f.id}: no history`);
  const current = f.rounds[f.rounds.length - 1];
  return {
    schema: 'factory/v1',
    id: f.id,
    title: f.title,
    branch: `factory/${f.id}`,
    target: 'main',
    stage: f.stage,
    round: f.rounds.length,
    maxRound: 2,
    reviews: current === undefined ? {} : reviewsOf(current),
    history: f.rounds.slice(0, -1).map((r, i) => ({ round: i + 1, reviews: reviewsOf(r) })),
    reworks: 0,
    decision: f.decision ?? null,
    note: f.note ?? '',
    stoppedBy: f.stoppedBy ?? null,
    stoppedFrom: f.stoppedFrom ?? null,
    startedAt: at(first[1]),
    stageEnteredAt: at(last[1]),
    endedAt: f.stage === 'merged' ? at(last[1]) : null,
    updated: at(last[1]),
    timing: {
      stages: stageSpans(f.history, at).map((s) => ({ ...s, ms: typeof s.ms === 'number' ? s.ms * MINUTE : null })),
      agents: f.rounds.flatMap((r, i) => Object.entries(r.reviews).map(([k, [v, done]]) => reviewerSpan(k, i + 1, r.at, done, v, at))).map((a) => ({ ...a, ms: typeof a.ms === 'number' ? a.ms * MINUTE : null })),
    },
  };
}

/** The fleet's jobs at `now`, each as its job.json, by project name (registration order). */
export function fleet(now: number = NOW): Array<{ project: FleetProject; jobs: Array<Record<string, unknown>> }> {
  return FLEET_PROJECTS.map((project) => ({ project, jobs: FLEET_JOBS.filter((f) => f.project === project.name).map((f) => fleetJson(f, now)) }));
}

/** The fleet as board jobs (each tagged with its project, id = name), narrowed as the UI does. */
export function fleetJobs(now: number = NOW): BoardJob[] {
  return fleet(now).flatMap(({ project, jobs }) =>
    jobs.map((raw) => {
      const j = toJob(raw);
      if (j === null) throw new Error('fleet job has no id');
      return { key: `${project.name}/${j.id}`, project: { id: project.name, name: project.name }, settleAfterHours: 24, reviewers: project.reviewers, job: j };
    }),
  );
}

/**
 * Writes the fleet under `home` as a throwaway Andon home: `projects.json` and one project root
 * per project (`<home>/<name>/factory/config.json` and `jobs/<id>/job.json`), with times measured
 * back from `now`. Run the service on it with `ANDON_HOME=<home> ANDON_PORT=<port> factory service run`.
 */
export function writeFleet(home: string, now: number = Date.now()): void {
  const roots: string[] = [];
  for (const { project, jobs } of fleet(now)) {
    const root = join(home, project.name);
    roots.push(root);
    mkdirSync(join(root, 'factory', 'jobs'), { recursive: true });
    const config = { schema: 'factory/v1', reviewers: project.reviewers, maxRound: 2, dashboard: { settleAfterHours: 24 } };
    writeFileSync(join(root, 'factory', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    for (const j of jobs) {
      const dir = join(root, 'factory', 'jobs', String(j.id));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'job.json'), `${JSON.stringify(j, null, 2)}\n`);
    }
  }
  writeFileSync(join(home, 'projects.json'), `${JSON.stringify({ schema: 'factory/v1', projects: roots.map((root) => ({ root })) }, null, 2)}\n`);
}

// ---- narrow boards (`?settled=summary`) ----

/**
 * Splits job.json values the way the service's narrow board does (packages/andon-service
 * settled.ts): an abandoned job is settled, and a merged one once its `endedAt` is more than
 * `hours` before `now`. Returns the narrow board's `jobs` and `settled` summary, and the
 * `GET /projects/<pid>/settled` list.
 */
export function narrowBoard(
  jobs: ReadonlyArray<Record<string, unknown>>,
  hours = 24,
  now: number = NOW,
): { jobs: Array<Record<string, unknown>>; settled: { count: number; lastMergedAt: string | null }; settledJobs: Array<Record<string, unknown>> } {
  const ended = (j: Record<string, unknown>): number | null => (j.stage === 'merged' && typeof j.endedAt === 'string' && !Number.isNaN(Date.parse(j.endedAt)) ? Date.parse(j.endedAt) : null);
  const isSettled = (j: Record<string, unknown>): boolean => {
    const at = ended(j);
    return j.stage === 'abandoned' || (at !== null && now - at > hours * HOUR);
  };
  const settledJobs = jobs.filter(isSettled);
  let last: { at: number; text: string } | null = null;
  for (const j of settledJobs) {
    const at = ended(j);
    if (at !== null && typeof j.endedAt === 'string' && (last === null || at > last.at)) last = { at, text: j.endedAt };
  }
  return { jobs: jobs.filter((j) => !isSettled(j)), settled: { count: settledJobs.length, lastMergedAt: last?.text ?? null }, settledJobs };
}

// ---- factory releases (059) ----
// As the service sends them (docs/contract/v1.md "Andon service"): a project entry's `release`, and
// the `GET /release` body (also the `release` event's data), its changelog newest first.

/** A project entry's `release`, as JSON. */
export const projectRelease = (installed: string | null, state: string): Record<string, unknown> => ({ installed, state });

/** A changelog entry, as JSON. */
export const changeEntry = (text: string, area: string | null = null, job: string | null = null): Record<string, unknown> => ({ area, text, job });

/** Three releases, newest first: 0.3.0 (all three sections), 0.2.0 (Added only), and 0.1.0 (Fixed only). */
export const CHANGELOG: ReadonlyArray<Record<string, unknown>> = [
  {
    version: '0.3.0',
    date: '2026-10-29',
    sections: {
      breaking: [changeEntry('the overlay moves to factory/roles', 'CLI', '057-roles')],
      added: [changeEntry("What's New in the sidebar", 'Andon', '059-andon-version-ui'), changeEntry('a release script')],
      fixed: [changeEntry('doctor reads a symlinked repo', 'CLI', null)],
    },
  },
  { version: '0.2.0', date: '2026-10-20', sections: { breaking: [], added: [changeEntry('epics', 'CLI', '050-epics')], fixed: [] } },
  { version: '0.1.0', date: '2026-10-01', sections: { breaking: [], added: [], fixed: [changeEntry('the first release')] } },
];

/** A `GET /release` body (or `release` event): the service runs `running`, its clone has `onDisk`. */
export const releaseBody = (running: string | null, onDisk: string | null = running, changelog: ReadonlyArray<Record<string, unknown>> = CHANGELOG): Record<string, unknown> => ({
  running,
  onDisk,
  changelog,
});

// ---- the backlog (brief andon-backlog-ui) ----

/** A `GET /projects/<pid>/backlog` body, as the service sends it: three queued lines (a brief, an epic, free text) and one exploration. */
export const backlogBody = (): { queued: unknown[]; exploring: unknown[] } => ({
  queued: [
    { kind: 'brief', slug: 'notes-search', title: 'Full-text search', done: 'search finds notes by body', status: 'ready', members: null, abandoned: ['003-notes-search: too broad'] },
    { kind: 'epic', slug: 'auth', title: 'Sign-in', done: null, status: 'ready', members: 3, abandoned: [] },
    { kind: 'text', slug: null, title: 'Tidy the README', done: 'the README reads well', status: null, members: null, abandoned: [] },
  ],
  exploring: [{ kind: 'brief', slug: 'tag-cloud', title: 'A tag cloud', done: null, status: 'draft', members: null, abandoned: [] }],
});

/** A plan's text with three members (one with `after:`), prose, and a later section. */
export const planText = `# Sign-in

- Status: ready

## Intent
Users sign in.

## Members
- \`auth-service\` — the service
- \`auth-ui\` — the UI after: \`auth-service\`
  (continued on an indented line)
- \`auth-docs\` — the docs
Some prose that is not a member.

## Notes
- \`not-a-member\` — listed after the section ends
`;

/** A brief's text with a `- Status:` line. */
export const briefText = (status: string, title = 'A brief'): string => `# ${title}\n\n- Status: ${status}\n- Date: 2026-10-30\n\n## Intent\nSomething.\n`;

// ---- machines (brief andon-machines-ui) ----
// As the hub sends them (docs/contract/v1.md "Andon service", "Peers"): `machine` on each project
// entry, a peer's projects as `<pid>@<machine>`, and the `GET /machines` body (also the `machines`
// event's data), the hub's own machine first.

/** The hub's own machine in these fixtures. */
export const HUB = 'rocinante';

/** A local time on Oct 22, 2026 (the machine tests' "today"), in ms. */
export const localAt = (hour: number, minute: number, day = 22): number => new Date(2026, 9, day, hour, minute).getTime();

/** One `GET /machines` entry, as JSON: live since `since` by default, with a tailnet URL and release 0.2.0. */
export function machineEntry(name: string, state = 'live', since: string = new Date(localAt(9, 0)).toISOString(), fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, url: `https://${name}.example.ts.net:8766`, state, since, reason: null, release: '0.2.0', ...fields };
}

/** A `GET /machines` body (and `machines` event data), as JSON. */
export const machinesBody = (...entries: unknown[]): { machines: unknown[] } => ({ machines: entries });

/** A project entry as the hub sends it: a local one's bare id, a peer's `<pid>@<machine>`. */
export function machineProject(pid: string, name: string, machine: string): { id: string; name: string; root: string; machine: string } {
  return { id: machine === HUB ? pid : `${pid}@${machine}`, name, root: `/Users/m/${name}`, machine };
}

/** The three-machine fleet: rocinante (the hub) with `factory` and `notes`, studio with `factory` and `api`, agentbox with `lab`. */
export const LOCAL_FACTORY = machineProject('a0a0a0a0a0a0', 'factory', HUB);
export const LOCAL_NOTES = machineProject('a1a1a1a1a1a1', 'notes', HUB);
export const STUDIO_FACTORY = machineProject('1a2b3c4d5e6f', 'factory', 'studio');
export const STUDIO_API = machineProject('b2b2b2b2b2b2', 'api', 'studio');
export const AGENT_LAB = machineProject('c3c3c3c3c3c3', 'lab', 'agentbox');
export const MACHINE_PROJECTS = [LOCAL_FACTORY, LOCAL_NOTES, STUDIO_FACTORY, STUDIO_API, AGENT_LAB];
