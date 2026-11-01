import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL, boardJobs, needsHuman } from './projects';
import { HUB, LOCAL_FACTORY, LOCAL_NOTES, STUDIO_FACTORY, before, boardEvent, epic, inEpic, job, machineEntry, machinesBody, stageSpans, streamJob, tag, widgetEvents } from './fixtures';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';
import {
  DRAG_SLOP,
  FIT_MAX,
  FIT_MIN,
  FIT_WIDGET_METHOD,
  MERGED_SHOW_MS,
  OPEN_JOB_METHOD,
  SHOW_ANDON_METHOD,
  currentSegment,
  deskWidgetOn,
  fitHeight,
  footerText,
  openJobPush,
  pillFills,
  pillLabel,
  pillOf,
  pillTip,
  pillTone,
  pressClick,
  pressMove,
  pressStart,
  stageText,
  tipPlace,
  watchMerges,
  watchStart,
  widgetCaller,
  widgetView,
} from './widget';
import type { MergeWatch, Pill, RowItem, WidgetView } from './widget';

/** The state after the fleet's setup events and then `events`, applied as live.ts applies them. */
function stream(...events: Array<[string, unknown]>): UiState {
  let s = emptyState();
  for (const [event, data] of [...widgetEvents(), ...events]) s = applyEvent(s, event, data);
  return s;
}

/** The widget as the page keeps it: each state in turn through the merge watch at its time, then the view. */
function follow(steps: Array<{ s: UiState; at: number }>): { view: WidgetView; watch: MergeWatch } {
  let watch = watchStart();
  let last = emptyState();
  for (const { s, at } of steps) {
    watch = watchMerges(watch, boardJobs(s, ALL), at);
    last = s;
  }
  return { view: widgetView(last, watch), watch };
}

const pills = (item: RowItem): Pill[] => (item.kind === 'pill' ? [item.pill] : item.epic.pills);
const rowPills = (v: WidgetView, label: string): Pill[] => v.rows.find((r) => r.label === label)?.items.flatMap(pills) ?? [];

describe('092 AC4: one row per project with live work, on every machine', () => {
  const s = stream(
    ['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'build'), streamJob('089-b', 'merged', { endedAt: before(60_000) })])],
    ['board', boardEvent(LOCAL_NOTES.id, [streamJob('012-c', 'merged', { endedAt: before(60_000) }), streamJob('013-d', 'abandoned')])],
    ['board', boardEvent(STUDIO_FACTORY.id, [streamJob('081-x', 'review', { round: 1 })])],
  );
  const v = widgetView(s, watchMerges(watchStart(), boardJobs(s, ALL), 0));

  test('a row for each project with an unsettled job, labeled with projectLabel (a remote one names its machine)', () => {
    expect(v.rows.map((r) => r.label)).toEqual(['factory', 'factory · studio']);
    expect(v.rows.map((r) => r.key)).toEqual([LOCAL_FACTORY.id, STUDIO_FACTORY.id]);
    expect(v.empty).toBe(false);
  });

  test('an idle project (only merged or abandoned jobs) has no row, and merged jobs already there at load never show', () => {
    expect(v.rows.some((r) => r.key === LOCAL_NOTES.id)).toBe(false);
    expect(rowPills(v, 'factory').map((p) => p.id)).toEqual(['090-a']);
  });

  test('with no live work anywhere, the view is empty (the small, nearly empty glass panel)', () => {
    const idle = stream(['board', boardEvent(LOCAL_NOTES.id, [streamJob('012-c', 'merged', { endedAt: before(60_000) })])]);
    expect(widgetView(idle, watchStart())).toEqual({ rows: [], footer: { needsYou: 0, live: 0, merged: 0 }, empty: true });
    expect(widgetView(emptyState(), watchStart()).empty).toBe(true);
    const view = readFileSync(join(import.meta.dir, 'DeskWidget.svelte'), 'utf8');
    expect(view).toContain('class:empty={view.empty}');
    expect(view).toContain('Nothing running');
  });

  test('without peers, nothing names a machine', () => {
    let solo = emptyState();
    for (const [event, data] of [['projects', { projects: [LOCAL_FACTORY] }], ['machines', machinesBody(machineEntry(HUB))], ['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'spec')])]] satisfies Array<[string, unknown]>) solo = applyEvent(solo, event, data);
    expect(widgetView(solo, watchStart()).rows.map((r) => r.label)).toEqual(['factory']);
  });
});

describe('092 AC5: a pill per job', () => {
  const at = (stage: string, fields: Record<string, unknown> = {}): Pill => pillOf(tag(job({ id: '050-x', stage, ...fields })));

  test('the current segment has its stage color, earlier ones dimmed, later ones empty; claimed counts as spec', () => {
    expect([at('claimed').tone, at('claimed').fills]).toEqual(['spec', ['cur', 'empty', 'empty', 'empty']]);
    expect([at('spec').tone, at('spec').fills]).toEqual(['spec', ['cur', 'empty', 'empty', 'empty']]);
    expect([at('build').tone, at('build').fills]).toEqual(['build', ['done', 'cur', 'empty', 'empty']]);
    expect([at('review').tone, at('review').fills]).toEqual(['review', ['done', 'done', 'cur', 'empty']]);
    expect([at('approve').tone, at('approve').fills]).toEqual(['approve', ['done', 'done', 'done', 'cur']]);
  });

  test("a needs-human job's current segment is the stage it stopped from, red", () => {
    const from = (fields: Record<string, unknown>): Pill => at('needs-human', fields);
    expect([from({ stoppedFrom: 'build' }).tone, from({ stoppedFrom: 'build' }).fills]).toEqual(['human', ['done', 'cur', 'empty', 'empty']]);
    expect(from({ stoppedFrom: 'spec' }).fills).toEqual(['cur', 'empty', 'empty', 'empty']);
    // no stoppedFrom: its last working stage on record
    const timed = job({ id: '050-x', stage: 'needs-human', timing: { stages: stageSpans([['spec', 3_600_000], ['build', 1_800_000], ['review', 600_000], ['needs-human', 60_000]]), agents: [] } });
    expect(currentSegment(timed)).toBe(2);
    expect(pillFills(timed, false)).toEqual(['done', 'done', 'cur', 'empty']);
    // nothing says: approve
    expect(from({}).fills).toEqual(['done', 'done', 'done', 'cur']);
    const view = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    expect(view).toMatch(/\.dw-pill\.t-human i\.f-cur \{ background: var\(--dw-human\); \}/);
    expect(view).toMatch(/\.dw-pill\.t-human \{ box-shadow: [^}]*var\(--dw-human\)/); // the red glow
  });

  test("the pills use Andon's stage palette", () => {
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    expect(css).toContain('--dw-spec: var(--teal); --dw-build: var(--indigo); --dw-review: var(--purple); --dw-approve: var(--blue); --dw-human: var(--red); --dw-merged: var(--green);');
  });

  test("an epic's member jobs are grouped in one bracket on their project's row, after its other pills", () => {
    const auth = { slug: 'auth', title: 'Sign-in' };
    const s = stream(
      [
        'board',
        boardEvent(
          LOCAL_FACTORY.id,
          [streamJob('090-a', 'build'), streamJob('091-b', 'review', { round: 1, epic: 'auth', kind: 'member' }), streamJob('092-c', 'spec', { epic: 'auth', kind: 'member' })],
          [{ ...epicJson(auth.slug), title: auth.title }],
        ),
      ],
    );
    const row = widgetView(s, watchStart()).rows[0];
    expect(row?.items.map((i) => i.kind)).toEqual(['pill', 'epic']);
    const bracket = row?.items[1];
    if (bracket?.kind !== 'epic') throw new Error('no bracket');
    expect(bracket.epic.key).toBe(`${LOCAL_FACTORY.id}/auth`);
    expect(bracket.epic.pills.map((p) => p.id)).toEqual(['091-b', '092-c']);
    expect(bracket.epic.tip).toBe('factory · epic Sign-in\n2 member jobs live');
  });

  test('pills on a row: needs you first, then approve, review, build, spec', () => {
    const s = stream([
      'board',
      boardEvent(LOCAL_FACTORY.id, [streamJob('001-s', 'spec'), streamJob('002-b', 'build'), streamJob('003-h', 'needs-human', { stoppedFrom: 'approve' }), streamJob('004-r', 'review', { round: 1 }), streamJob('005-a', 'approve', { round: 1 })]),
    ]);
    expect(rowPills(widgetView(s, watchStart()), 'factory').map((p) => p.tone)).toEqual(['human', 'approve', 'review', 'build', 'spec']);
  });

  test('a stage change in the stream updates the pill in place, with no reload', () => {
    const s1 = stream(['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'build')])]);
    const s2 = applyEvent(s1, 'board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'review', { round: 1 })]));
    const a = follow([{ s: s1, at: 0 }]).view;
    const b = follow([
      { s: s1, at: 0 },
      { s: s2, at: 1000 },
    ]).view;
    expect(rowPills(a, 'factory').map((p) => [p.key, p.tone])).toEqual([[`${LOCAL_FACTORY.id}/090-a`, 'build']]);
    expect(rowPills(b, 'factory').map((p) => [p.key, p.tone])).toEqual([[`${LOCAL_FACTORY.id}/090-a`, 'review']]);
  });

  test('a live job that merges in the stream turns green, counts, then leaves the view', () => {
    const live = stream(['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'approve', { round: 1 })])]);
    const merged = applyEvent(live, 'board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'merged', { round: 1, endedAt: before(0) })]));
    const steps = [
      { s: live, at: 0 },
      { s: merged, at: 1000 },
    ];
    const green = follow(steps).view;
    const pill = rowPills(green, 'factory')[0];
    expect([pill?.tone, pill?.fills]).toEqual(['merged', ['cur', 'cur', 'cur', 'cur']]);
    expect(green.footer).toEqual({ needsYou: 0, live: 0, merged: 1 });
    expect(green.empty).toBe(false); // a project with only a fading job keeps its row
    const still = follow([...steps, { s: merged, at: 1000 + MERGED_SHOW_MS - 1 }]).view;
    expect(rowPills(still, 'factory').map((p) => p.tone)).toEqual(['merged']);
    const gone = follow([...steps, { s: merged, at: 1000 + MERGED_SHOW_MS }]).view;
    expect(gone.rows).toEqual([]);
    expect(gone.empty).toBe(true);
    expect(gone.footer.merged).toBe(1); // merged since the page loaded
  });

  test('a needs-human job approved to merged fades the same way; an abandoned one just leaves', () => {
    const live = stream(['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'needs-human', { stoppedFrom: 'approve' }), streamJob('091-b', 'build')])]);
    const after = applyEvent(live, 'board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'merged', { endedAt: before(0) }), streamJob('091-b', 'abandoned')]));
    const v = follow([
      { s: live, at: 0 },
      { s: after, at: 10 },
    ]).view;
    expect(rowPills(v, 'factory').map((p) => [p.id, p.tone])).toEqual([['090-a', 'merged']]);
  });

  test('the watch is unchanged (the same object) when nothing changed, so the page re-renders nothing', () => {
    const s = stream(['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'build')])]);
    const w = watchMerges(watchStart(), boardJobs(s, ALL), 0);
    expect(watchMerges(w, boardJobs(s, ALL), 5000)).toBe(w);
  });

  test('the page animates color, enter, exit, and reflow, and honors reduced motion', () => {
    const view = readFileSync(join(import.meta.dir, 'DeskWidget.svelte'), 'utf8');
    expect(view).toContain('animate:flip={{ duration: motionMs(450) }}');
    expect(view).toContain('in:scale=');
    expect(view).toContain('out:scale=');
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8');
    expect(css).toContain('transition: background-color .5s ease;');
  });
});

/** An epic.json value as the stream sends it (the fixture's, as JSON). */
const epicJson = (slug: string): Record<string, unknown> => {
  const e = epic({ slug });
  return { schema: 'factory/v1', ...e, session: null };
};

describe('092 AC6: the tooltip and the footer', () => {
  test('a pill names the project (with its machine when remote), the job id, its epic, and the stage with its round', () => {
    expect(pillTip(tag(job({ id: '090-a', stage: 'review', round: 2 }), { id: LOCAL_FACTORY.id, name: 'factory' }), false)).toBe('factory · 090-a\nreview · round 2');
    expect(pillTip({ ...tag(job({ id: '081-x', stage: 'build', round: 1 })), project: { id: STUDIO_FACTORY.id, name: 'factory', remote: 'studio' } }, false)).toBe('factory · studio · 081-x\nbuild · round 1 fixes');
    const e = epic({ slug: 'auth', title: 'Sign-in' });
    expect(pillTip(inEpic({ id: '091-b', stage: 'spec' }, e, { id: LOCAL_FACTORY.id, name: 'factory' }), false)).toBe('factory · 091-b · epic Sign-in\nspec');
    // an epic the board doesn't hold: its slug
    expect(pillTip(tag(job({ id: '091-b', stage: 'approve', round: 1, epic: 'auth', kind: 'member' }), { id: LOCAL_FACTORY.id, name: 'factory' }), false)).toBe('factory · 091-b · epic auth\napprove · round 1');
    expect(stageText(job({ id: '001-a', stage: 'build', round: 0 }), false)).toBe('build');
    expect(stageText(job({ id: '001-a', stage: 'claimed' }), false)).toBe('claimed');
    expect(stageText(job({ id: '001-a', stage: 'merged' }), true)).toBe('just merged');
  });

  test("for a needs-human job, why it needs you: its card's note", () => {
    const tip = pillTip(tag(job({ id: '090-a', stage: 'needs-human', note: 'approver escalated: the API changed\nmore detail', stoppedBy: 'escalated', stoppedFrom: 'approve' }), { id: LOCAL_FACTORY.id, name: 'factory' }), false);
    expect(tip).toBe('factory · 090-a\nneeds you · approver escalated: the API changed');
    expect(stageText(job({ id: '001-a', stage: 'needs-human', stoppedBy: 'merge-failed', stoppedFrom: 'approve' }), false)).toBe('needs you · the merge failed');
    expect(stageText(job({ id: '001-a', stage: 'needs-human', stoppedBy: 'escalated', stoppedFrom: 'build' }), false)).toBe('needs you · escalated');
    expect(stageText(job({ id: '001-a', stage: 'needs-human', note: 'x'.repeat(200) }), false)).toHaveLength('needs you · '.length + 120);
    expect(pillLabel(pillOf(tag(job({ id: '090-a', stage: 'spec' }), { id: LOCAL_FACTORY.id, name: 'factory' })))).toBe('factory · 090-a, spec');
  });

  test('the footer reads "<n> needs you" (the tray badge\'s count: needs-human jobs plus epics waiting on you), the live count, and the merged count', () => {
    const s = stream(
      ['board', boardEvent(LOCAL_FACTORY.id, [streamJob('090-a', 'needs-human', { stoppedFrom: 'build' }), streamJob('091-b', 'build')], [{ ...epicJson('auth'), state: 'waiting', waitingOn: 'you' }])],
      ['board', boardEvent(STUDIO_FACTORY.id, [streamJob('081-x', 'needs-human', { stoppedFrom: 'review' }), streamJob('080-y', 'merged', { endedAt: before(0) })])],
    );
    const v = widgetView(s, watchStart());
    expect(v.footer).toEqual({ needsYou: 3, live: 3, merged: 0 });
    expect(v.footer.needsYou).toBe(needsHuman(s).total);
    expect(footerText(v.footer)).toEqual({ needs: '3 needs you', counts: '3 live · 0 merged' });
  });
});

describe('092 AC7: the widget page asks the Mac app', () => {
  test('null in a browser, or when Tiny or its api.call is missing', () => {
    const host = { api: { call: async () => true } };
    expect(widgetCaller('browser', host)).toBeNull();
    for (const h of [undefined, null, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect(widgetCaller('mac', h)).toBeNull();
  });

  test('a pill calls openJob with its project and job id, the glass calls showAndon with nothing, the fit calls fitWidget with the height', () => {
    expect([OPEN_JOB_METHOD, SHOW_ANDON_METHOD, FIT_WIDGET_METHOD]).toEqual(['openJob', 'showAndon', 'fitWidget']);
    const calls: unknown[][] = [];
    const api = widgetCaller('mac', { api: { call: async (method: string, params: unknown) => void calls.push([method, params]) } });
    api?.openJob(LOCAL_FACTORY.id, '090-a');
    api?.showAndon();
    api?.fit(158);
    expect(calls).toEqual([
      ['openJob', { project: LOCAL_FACTORY.id, job: '090-a' }],
      ['showAndon', null],
      ['fitWidget', { height: 158 }],
    ]);
    const view = readFileSync(join(import.meta.dir, 'DeskWidget.svelte'), 'utf8');
    expect(view).toContain('onclick={() => mac?.openJob(p.project, p.id)}');
    expect(view).toContain('if (click) mac?.showAndon();');
  });

  test('a refused or failing call is ignored', async () => {
    for (const call of [() => Promise.reject(new Error('denied')), () => {
      throw new Error('gone');
    }]) {
      const api = widgetCaller('mac', { api: { call } });
      expect(() => api?.openJob('a', 'b')).not.toThrow();
      expect(() => api?.showAndon()).not.toThrow();
      expect(() => api?.fit(100)).not.toThrow();
    }
    await new Promise((r) => setTimeout(r, 0));
  });

  test('a drag uses Tiny\'s own window drag; without it, nothing happens', async () => {
    let dragged = 0;
    await widgetCaller('mac', { api: { call: async () => true }, win: { startDrag: async () => void dragged++ } })?.drag();
    expect(dragged).toBe(1);
    await widgetCaller('mac', { api: { call: async () => true } })?.drag();
    await widgetCaller('mac', { api: { call: async () => true }, win: { startDrag: async () => Promise.reject(new Error('no')) } })?.drag();
    expect(dragged).toBe(1);
  });

  test('a press on the glass is a click until it moves past the slop, then a drag (once)', () => {
    const p = pressStart(100, 100);
    const small = pressMove(p, 100 + DRAG_SLOP - 1, 100);
    expect(small.drag).toBe(false);
    expect(pressClick(small.press)).toBe(true);
    const far = pressMove(small.press, 100 + DRAG_SLOP, 100 + 1);
    expect(far.drag).toBe(true);
    expect(pressClick(far.press)).toBe(false);
    expect(pressMove(far.press, 300, 300).drag).toBe(false);
  });

  test('the fit height is whole points within the Mac app\'s bounds', () => {
    expect([fitHeight(157.2), fitHeight(10), fitHeight(5000), fitHeight(Number.NaN)]).toEqual([158, FIT_MIN, FIT_MAX, FIT_MIN]);
    const mac = readFileSync(join(import.meta.dir, '..', '..', 'andon', 'src', 'appmenu.ts'), 'utf8');
    expect(mac).toContain(`export const WIDGET_MIN_HEIGHT = ${FIT_MIN};`);
    expect(mac).toContain(`export const WIDGET_MAX_HEIGHT = ${FIT_MAX};`);
  });

  test('the tooltip sits over the pill, inside the glass: above when there is room, else below, kept off the edges', () => {
    const glass = { width: 332, height: 158 };
    const tip = { width: 160, height: 34 };
    expect(tipPlace({ x: 100, y: 80, width: 40, height: 12 }, glass, tip)).toEqual({ x: 40, y: 40 });
    expect(tipPlace({ x: 100, y: 14, width: 40, height: 12 }, glass, tip)).toEqual({ x: 40, y: 32 });
    expect(tipPlace({ x: 2, y: 80, width: 40, height: 12 }, glass, tip)).toEqual({ x: 6, y: 40 });
    expect(tipPlace({ x: 300, y: 80, width: 30, height: 12 }, glass, tip)).toEqual({ x: 332 - 160 - 6, y: 40 });
  });
});

describe('092 AC7: the main window selects the job a pill asks for', () => {
  const listed = [{ id: LOCAL_FACTORY.id }, { id: STUDIO_FACTORY.id }];

  test('exactly a listed project and a job id; anything else does nothing', () => {
    expect(openJobPush({ project: LOCAL_FACTORY.id, id: '090-a' }, listed)).toEqual({ project: LOCAL_FACTORY.id, id: '090-a' });
    for (const d of [null, {}, { project: LOCAL_FACTORY.id }, { project: 'unlisted', id: '090-a' }, { project: LOCAL_FACTORY.id, id: '' }, { project: LOCAL_FACTORY.id, id: 1 }, { project: LOCAL_FACTORY.id, id: '090-a', extra: 1 }]) {
      expect({ d, ref: openJobPush(d, listed) }).toEqual({ d, ref: null });
    }
  });

  test('the board subscribes to openjob and opens the job by its route key', () => {
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('const offOpenJob = subscribe?.(OPEN_JOB_EVENT, (data) => {');
    expect(app).toContain('if (ref !== null) openJob(jobKey(ref));');
  });

  test('the desk widget event carries { on }', () => {
    expect(deskWidgetOn({ on: true })).toBe(true);
    expect(deskWidgetOn({ on: false })).toBe(false);
    for (const d of [null, {}, { on: 'true' }, true]) expect(deskWidgetOn(d)).toBeNull();
  });
});

test('pillTone and pillFills for a just-merged pill', () => {
  const j = job({ id: '001-a', stage: 'merged' });
  expect(pillTone(j, true)).toBe('merged');
  expect(pillFills(j, true)).toEqual(['cur', 'cur', 'cur', 'cur']);
});
