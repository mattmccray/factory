import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EPIC_MENU_ATTR, EPIC_MENU_METHOD, EPIC_MENU_PROJECT_ATTR, epicMenuCaller, menuEpicAt } from './epicmenu';
import type { MenuEpic } from './epicmenu';
import { JOB_MENU_ATTR, JOB_MENU_PROJECT_ATTR } from './jobmenu';
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
const EPIC = 'andon-window-polish';
const JOB = '076-epic-context-menu';
// The page as the Mac app shows it: a lane with its project gutter, then an epic's sub-lane with its
// gutter (the epic name button, with its dot and name inside, and the progress line), a cell, and a
// job token in it. The epic name sits inside a project-marked region too, to show it takes precedence.
const page = el();
const lane = el({ role: 'row' }, page);
const gutter = el({ [PROJECT_MENU_ATTR]: PID }, lane);
const sub = el({ role: 'row' }, page);
const egut = el({}, sub);
const epicName = el({ [EPIC_MENU_ATTR]: EPIC, [EPIC_MENU_PROJECT_ATTR]: PID }, egut);
const epicNameText = el({}, epicName);
const progress = el({}, egut);
const cell = el({ role: 'cell' }, sub);
const token = el({ [JOB_MENU_ATTR]: JOB, [JOB_MENU_PROJECT_ATTR]: PID }, el({}, cell));
const wrapped = el({ [PROJECT_MENU_ATTR]: 'bbbbbbbbbbbb' }, page);
const nestedName = el({ [EPIC_MENU_ATTR]: 'other-epic', [EPIC_MENU_PROJECT_ATTR]: 'bbbbbbbbbbbb' }, wrapped);
const RIGHT = { button: 2, ctrlKey: false };
const CTRL = { button: 0, ctrlKey: true };
const LEFT = { button: 0, ctrlKey: false };

type Ask = ['projectMenu', string | null] | ['jobMenu', MenuJob] | ['epicMenu', MenuEpic];
function armed(mode: 'mac' | 'browser') {
  const asked: Ask[] = [];
  const arm = menuArmer(
    mode,
    (p) => asked.push(['projectMenu', p]),
    (j) => asked.push(['jobMenu', j]),
    (e) => asked.push(['epicMenu', e]),
  );
  return { arm, asked };
}

describe('076 AC6: which epic a pointer asks the menu for', () => {
  test("in the Mac app: an epic's name, anywhere inside it", () => {
    for (const t of [epicName, epicNameText]) expect(menuEpicAt('mac', t)).toEqual({ project: PID, epic: EPIC });
    expect(menuEpicAt('mac', nestedName)).toEqual({ project: 'bbbbbbbbbbbb', epic: 'other-epic' });
  });

  test("the sub-lane's progress line, cells, and job tokens, the project gutter, and the page have no epic menu", () => {
    for (const t of [progress, egut, sub, cell, token, gutter, lane, page, wrapped]) expect(menuEpicAt('mac', t)).toBeNull();
  });

  test('in a plain browser nothing has an epic menu', () => {
    expect(menuEpicAt(shellMode(''), epicName)).toBeNull();
    expect(menuEpicAt('browser', epicNameText)).toBeNull();
    expect(menuEpicAt(shellMode('?shell=mac'), epicName)).toEqual({ project: PID, epic: EPIC });
  });

  test('a target that is not an element, or a name missing either id, has none', () => {
    for (const t of [null, undefined, 'x', {}, { closest: 7 }, el({ [EPIC_MENU_ATTR]: EPIC }), el({ [EPIC_MENU_ATTR]: '', [EPIC_MENU_PROJECT_ATTR]: PID }), el({ [EPIC_MENU_ATTR]: EPIC, [EPIC_MENU_PROJECT_ATTR]: '' })]) {
      expect(menuEpicAt('mac', t)).toBeNull();
    }
  });
});

describe('076 AC6: arming the epic menu', () => {
  test('an epic name asks epicMenu with { project, epic }, once per change and again on an opening press; cells and tokens arm as before', () => {
    const { arm, asked } = armed('mac');
    arm.point(epicNameText);
    arm.point(epicName); // the same epic: no ask
    arm.press(epicName, LEFT); // a plain click: no ask
    arm.press(epicNameText, RIGHT); // the opening press asks again
    arm.press(epicName, CTRL);
    arm.point(progress); // the rest of the epic gutter: no menu
    arm.point(token);
    arm.point(cell);
    arm.point(nestedName); // inside a project-marked region: the epic wins
    arm.point(gutter);
    arm.point(epicName);
    arm.leave();
    expect(asked).toEqual([
      ['epicMenu', { project: PID, epic: EPIC }],
      ['epicMenu', { project: PID, epic: EPIC }],
      ['epicMenu', { project: PID, epic: EPIC }],
      ['projectMenu', null],
      ['jobMenu', { project: PID, job: JOB }],
      ['projectMenu', null],
      ['epicMenu', { project: 'bbbbbbbbbbbb', epic: 'other-epic' }],
      ['projectMenu', PID],
      ['epicMenu', { project: PID, epic: EPIC }],
      ['projectMenu', null],
    ]);
  });

  test('every epic ask carries only the project id and the epic slug', () => {
    const { arm, asked } = armed('mac');
    arm.point(epicName);
    expect(asked.length).toBe(1);
    for (const [, v] of asked) if (typeof v === 'object' && v !== null) expect(Object.keys(v).sort()).toEqual(['epic', 'project']);
  });

  test("a control-click on an epic's name is swallowed, so it opens no epic page; a plain click still does", () => {
    for (const t of [epicName, epicNameText, nestedName]) expect(swallowsClick('mac', t, CTRL)).toBe(true);
    expect(swallowsClick('mac', epicName, LEFT)).toBe(false);
    expect(swallowsClick('mac', epicName, RIGHT)).toBe(false);
    for (const t of [progress, cell]) expect(swallowsClick('mac', t, CTRL)).toBe(false);
    expect(swallowsClick('browser', epicName, CTRL)).toBe(false);
  });

  test('in a browser nothing is asked for an epic', () => {
    const { arm, asked } = armed('browser');
    arm.point(epicName);
    arm.press(epicName, RIGHT);
    expect(asked.filter(([m, v]) => m !== 'projectMenu' || v !== null)).toEqual([]);
  });

  test('without an epic caller the armer treats the epic name like the rest of the gutter', () => {
    const asked: (string | null)[] = [];
    const arm = menuArmer('mac', (p) => asked.push(p));
    arm.point(gutter);
    arm.point(epicName);
    arm.point(nestedName);
    expect(asked).toEqual([PID, null, 'bbbbbbbbbbbb']);
  });
});

describe("076 AC6: the page's epic menu call", () => {
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

  test('in the Mac app it calls epicMenu with { project, epic } and nothing else', () => {
    const { host, calls } = fakeHost();
    epicMenuCaller('mac', host)?.({ project: PID, epic: EPIC });
    expect(calls).toEqual([['epicMenu', { project: PID, epic: EPIC }]]);
    expect(EPIC_MENU_METHOD).toBe('epicMenu');
  });

  test('in a browser, or without a usable window.tiny, there is no caller', () => {
    expect(epicMenuCaller('browser', fakeHost().host)).toBeNull();
    expect(epicMenuCaller(shellMode(''), fakeHost().host)).toBeNull();
    for (const host of [undefined, null, 1, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect(epicMenuCaller('mac', host)).toBeNull();
  });

  test('a refused or throwing call is swallowed', async () => {
    const refused = epicMenuCaller(
      'mac',
      fakeHost(async () => {
        throw new Error('denied');
      }).host,
    );
    expect(() => refused?.({ project: PID, epic: EPIC })).not.toThrow();
    const throwing = epicMenuCaller('mac', {
      api: {
        call: () => {
          throw new Error('boom');
        },
      },
    });
    expect(() => throwing?.({ project: PID, epic: EPIC })).not.toThrow();
    await new Promise((r) => setTimeout(r, 1));
  });

  test("the epic name button in a sub-lane carries the epic's slug and project id, and nothing else in the lane does", () => {
    const laneSrc = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(laneSrc.match(/<button class="en"[^>]* data-epic-menu=\{sub\.slug\} data-epic-menu-project=\{lane\.project\.id\}/g)?.length).toBe(1);
    expect(laneSrc.match(/data-epic-menu=/g)?.length).toBe(1);
    expect(laneSrc.match(/data-epic-menu-project=/g)?.length).toBe(1);
    expect(EPIC_MENU_ATTR).toBe('data-epic-menu');
    expect(EPIC_MENU_PROJECT_ATTR).toBe('data-epic-menu-project');
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("menuArmer(mode, ask, jobMenuCaller(mode, Reflect.get(window, 'tiny')), epicMenuCaller(mode, Reflect.get(window, 'tiny')))");
  });
});
