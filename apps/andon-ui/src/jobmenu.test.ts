import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_MENU_ATTR, JOB_MENU_METHOD, JOB_MENU_PROJECT_ATTR, jobMenuCaller, menuJobAt, tokenJobId } from './jobmenu';
import type { MenuJob } from './jobmenu';
import { PROJECT_MENU_ATTR, menuArmer, swallowsClick } from './projectmenu';
import { shellMode } from './sidebar';

/** A stand-in DOM element: `closest` walks up to the nearest ancestor (or itself) carrying the attribute. */
interface FakeEl {
  attrs: Record<string, string>;
  parent: FakeEl | null;
  closest(selector: string): FakeEl | null;
  getAttribute(name: string): string | null;
}
function el(attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  const node: FakeEl = {
    attrs,
    parent,
    closest(selector) {
      const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      for (let n: FakeEl | null = node; n !== null; n = n.parent) if (name !== undefined && name in n.attrs) return n;
      return null;
    },
    getAttribute: (name) => attrs[name] ?? null,
  };
  return node;
}

const PID = 'aaaaaaaaaaaa';
const JOB = '040-job-context-menu';
// The page as the Mac app shows it: a sidebar row, a lane with its gutter and a cell holding a board
// token (with its title inside) and a ghost, the inspector header, and the Settled sheet.
const page = el();
const row = el({ [PROJECT_MENU_ATTR]: PID }, page);
const lane = el({ role: 'row' }, page);
const gutter = el({ [PROJECT_MENU_ATTR]: PID }, lane);
const cell = el({ role: 'cell' }, lane);
const token = el({ [JOB_MENU_ATTR]: JOB, [JOB_MENU_PROJECT_ATTR]: PID }, el({}, cell));
const tokenTitle = el({}, el({}, token));
const other = el({ [JOB_MENU_ATTR]: '039-job-session-link', [JOB_MENU_PROJECT_ATTR]: 'bbbbbbbbbbbb' }, cell);
const ghost = el({}, cell);
const inspectorHeader = el({}, el({}, page));
const settledSheet = el({}, el({}, page));
const RIGHT = { button: 2, ctrlKey: false };
const CTRL = { button: 0, ctrlKey: true };
const LEFT = { button: 0, ctrlKey: false };

type Ask = ['projectMenu', string | null] | ['jobMenu', MenuJob];
function armed(mode: 'mac' | 'browser') {
  const asked: Ask[] = [];
  const arm = menuArmer(
    mode,
    (p) => asked.push(['projectMenu', p]),
    (j) => asked.push(['jobMenu', j]),
  );
  return { arm, asked };
}

describe('AC6: which job a pointer asks the menu for', () => {
  test('in the Mac app: a board job token, anywhere inside it', () => {
    for (const t of [token, tokenTitle]) expect(menuJobAt('mac', t)).toEqual({ project: PID, job: JOB });
    expect(menuJobAt('mac', other)).toEqual({ project: 'bbbbbbbbbbbb', job: '039-job-session-link' });
  });

  test('ghosts, the inspector header, the Settled sheet, gutters, rows, and the page have no job menu', () => {
    for (const t of [ghost, inspectorHeader, settledSheet, gutter, row, cell, lane, page]) expect(menuJobAt('mac', t)).toBeNull();
  });

  test('in a plain browser nothing has a job menu', () => {
    expect(menuJobAt(shellMode(''), token)).toBeNull();
    expect(menuJobAt('browser', tokenTitle)).toBeNull();
    expect(menuJobAt(shellMode('?shell=mac'), token)).toEqual({ project: PID, job: JOB });
  });

  test('a target that is not an element, or a token missing either id, has none', () => {
    for (const t of [null, undefined, 'x', {}, { closest: 7 }, el({ [JOB_MENU_ATTR]: JOB }), el({ [JOB_MENU_ATTR]: '', [JOB_MENU_PROJECT_ATTR]: PID }), el({ [JOB_MENU_ATTR]: JOB, [JOB_MENU_PROJECT_ATTR]: '' })]) {
      expect(menuJobAt('mac', t)).toBeNull();
    }
  });

  test("a token's job id comes from its key and its project id", () => {
    expect(tokenJobId(`${PID}/${JOB}`, PID)).toBe(JOB);
    expect(tokenJobId(`bbbbbbbbbbbb/${JOB}`, PID)).toBe('');
    expect(tokenJobId(JOB, PID)).toBe('');
  });
});

describe('AC6: arming the job menu', () => {
  test('a job token asks jobMenu with { project, job }; rows and gutters ask projectMenu; elsewhere disarms', () => {
    const { arm, asked } = armed('mac');
    arm.point(tokenTitle);
    arm.point(token); // the same job: no ask
    arm.press(token, LEFT); // a plain click: no ask
    arm.press(tokenTitle, RIGHT); // the opening press asks again
    arm.press(token, CTRL);
    arm.point(other);
    arm.point(gutter);
    arm.point(token);
    arm.point(ghost);
    arm.point(token);
    arm.point(inspectorHeader);
    arm.point(token);
    arm.point(settledSheet);
    arm.point(row);
    arm.leave();
    expect(asked).toEqual([
      ['jobMenu', { project: PID, job: JOB }],
      ['jobMenu', { project: PID, job: JOB }],
      ['jobMenu', { project: PID, job: JOB }],
      ['jobMenu', { project: 'bbbbbbbbbbbb', job: '039-job-session-link' }],
      ['projectMenu', PID],
      ['jobMenu', { project: PID, job: JOB }],
      ['projectMenu', null],
      ['jobMenu', { project: PID, job: JOB }],
      ['projectMenu', null],
      ['jobMenu', { project: PID, job: JOB }],
      ['projectMenu', null],
      ['projectMenu', PID],
      ['projectMenu', null],
    ]);
  });

  test('every job ask carries only the project id and the job id', () => {
    const { arm, asked } = armed('mac');
    arm.point(token);
    for (const [, v] of asked) if (typeof v === 'object' && v !== null) expect(Object.keys(v).sort()).toEqual(['job', 'project']);
  });

  test('in a browser nothing is asked for a job, and nothing is swallowed', () => {
    const { arm, asked } = armed('browser');
    arm.point(token);
    arm.press(token, RIGHT);
    arm.press(tokenTitle, CTRL);
    expect(asked.filter(([m, v]) => m === 'jobMenu' || v !== null)).toEqual([]);
    expect(swallowsClick('browser', token, CTRL)).toBe(false);
  });

  test("a control-click on a job token doesn't click through; a plain click and a ghost still do", () => {
    for (const t of [token, tokenTitle]) expect(swallowsClick('mac', t, CTRL)).toBe(true);
    expect(swallowsClick('mac', token, LEFT)).toBe(false);
    expect(swallowsClick('mac', token, RIGHT)).toBe(false);
    for (const t of [ghost, inspectorHeader, settledSheet]) expect(swallowsClick('mac', t, CTRL)).toBe(false);
  });

  test('without a job caller the armer treats a token like the rest of the cell', () => {
    const asked: (string | null)[] = [];
    const arm = menuArmer('mac', (p) => asked.push(p));
    arm.point(gutter);
    arm.point(token);
    expect(asked).toEqual([PID, null]);
  });
});

describe("AC6: the page's job menu call", () => {
  function fakeHost(result: () => unknown = async () => undefined) {
    const calls: unknown[][] = [];
    return {
      host: {
        api: {
          call(...args: unknown[]) {
            calls.push(args);
            return result();
          },
        },
      },
      calls,
    };
  }

  test('in the Mac app it calls jobMenu with { project, job } and nothing else', () => {
    const { host, calls } = fakeHost();
    jobMenuCaller('mac', host)?.({ project: PID, job: JOB });
    expect(calls).toEqual([['jobMenu', { project: PID, job: JOB }]]);
    expect(JOB_MENU_METHOD).toBe('jobMenu');
  });

  test('in a browser, or without a usable window.tiny, there is no caller', () => {
    expect(jobMenuCaller('browser', fakeHost().host)).toBeNull();
    for (const host of [undefined, null, 1, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect(jobMenuCaller('mac', host)).toBeNull();
  });

  test('a refused or throwing call is swallowed', async () => {
    const refused = jobMenuCaller(
      'mac',
      fakeHost(async () => {
        throw new Error('denied');
      }).host,
    );
    expect(() => refused?.({ project: PID, job: JOB })).not.toThrow();
    const throwing = jobMenuCaller('mac', {
      api: {
        call: () => {
          throw new Error('boom');
        },
      },
    });
    expect(() => throwing?.({ project: PID, job: JOB })).not.toThrow();
    await new Promise((r) => setTimeout(r, 1));
  });

  test('board tokens carry the job marker and the lane passes its project id; ghosts do not', () => {
    const tokenSrc = readFileSync(join(import.meta.dir, 'Token.svelte'), 'utf8');
    const laneSrc = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(tokenSrc).toContain("data-job-menu={jobId === '' ? undefined : jobId}");
    expect(tokenSrc).toContain("data-job-menu-project={jobId === '' ? undefined : project}");
    expect(laneSrc).toContain('<Token token={t} project={lane.project.id}');
    expect(laneSrc).not.toContain('data-job-menu');
    const ghostLine = laneSrc.split('\n').find((l) => l.includes('class="ghost"')) ?? '';
    expect(ghostLine).not.toContain('<Token');
    expect(ghostLine).not.toContain('data-job-menu');
    for (const f of ['Inspector.svelte', 'SettledSheet.svelte', 'TokenPopover.svelte']) expect(readFileSync(join(import.meta.dir, f), 'utf8')).not.toContain('job-menu');
  });

  test('App wires the job caller into the armer', () => {
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("menuArmer(mode, ask, jobMenuCaller(mode, Reflect.get(window, 'tiny')),");
  });
});
