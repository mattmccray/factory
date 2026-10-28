import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_MENU_ATTR, PROJECT_MENU_METHOD, menuArmer, menuProjectAt, opensMenu, projectMenuCaller, swallowsClick } from './projectmenu';
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

// The page as the Mac app shows it: a sidebar with All Projects and a project row, and a lane with
// its gutter (name button, settled link) and a job cell with a token.
const page = el();
const allProjects = el({}, el({}, page));
const row = el({ [PROJECT_MENU_ATTR]: 'aaaaaaaaaaaa' }, page);
const rowName = el({}, row);
const lane = el({ role: 'row' }, page);
const gutter = el({ [PROJECT_MENU_ATTR]: 'bbbbbbbbbbbb' }, lane);
const gutterName = el({}, gutter);
const settledLink = el({}, el({}, gutter));
const cell = el({ role: 'cell' }, lane);
const token = el({}, cell);
const RIGHT = { button: 2, ctrlKey: false };
const CTRL = { button: 0, ctrlKey: true };
const LEFT = { button: 0, ctrlKey: false };

describe('AC5: which project a click asks the menu for', () => {
  test('in the Mac app: a sidebar project row or a lane gutter, anywhere inside it', () => {
    for (const t of [row, rowName]) expect(menuProjectAt('mac', t)).toBe('aaaaaaaaaaaa');
    for (const t of [gutter, gutterName, settledLink]) expect(menuProjectAt('mac', t)).toBe('bbbbbbbbbbbb');
  });

  test('All Projects, job cells, and the rest of the page have no project menu', () => {
    for (const t of [allProjects, cell, token, lane, page]) expect(menuProjectAt('mac', t)).toBeNull();
  });

  test('in a plain browser nothing has a project menu', () => {
    for (const t of [row, rowName, gutter, settledLink]) expect(menuProjectAt(shellMode(''), t)).toBeNull();
    expect(menuProjectAt(shellMode('?shell=mac'), row)).toBe('aaaaaaaaaaaa');
  });

  test('a target that is not an element, or an empty id, has none', () => {
    for (const t of [null, undefined, 'row', {}, { closest: 'x' }, { closest: () => ({ getAttribute: () => 7 }) }, el({ [PROJECT_MENU_ATTR]: '' })]) expect(menuProjectAt('mac', t)).toBeNull();
  });

  test('a right-click or a control-click opens the menu; a plain click does not', () => {
    expect(opensMenu(RIGHT)).toBe(true);
    expect(opensMenu(CTRL)).toBe(true);
    expect(opensMenu(LEFT)).toBe(false);
    expect(opensMenu({ button: 1, ctrlKey: false })).toBe(false);
  });

  test("a control-click on a row or gutter doesn't click through, so the selection, focus, and route stay; elsewhere and in a browser it does", () => {
    for (const t of [row, gutterName, settledLink]) expect(swallowsClick('mac', t, CTRL)).toBe(true);
    for (const t of [row, gutterName]) expect(swallowsClick('mac', t, LEFT)).toBe(false); // a plain click still selects
    for (const t of [allProjects, token]) expect(swallowsClick('mac', t, CTRL)).toBe(false);
    expect(swallowsClick('browser', row, CTRL)).toBe(false);
  });
});

describe('AC5: arming the menu', () => {
  test('one ask per change of project under the pointer, null off a project, and again on the opening press', () => {
    const asked: (string | null)[] = [];
    const arm = menuArmer('mac', (p) => asked.push(p));
    arm.point(page); // nothing armed yet: no ask
    arm.point(rowName);
    arm.point(row); // same project
    arm.press(row, LEFT); // a plain click: no ask
    arm.press(row, RIGHT); // the opening press asks again
    arm.point(token);
    arm.point(gutterName);
    arm.press(settledLink, CTRL);
    arm.point(allProjects);
    arm.point(gutter);
    arm.leave();
    arm.leave();
    expect(asked).toEqual(['aaaaaaaaaaaa', 'aaaaaaaaaaaa', null, 'bbbbbbbbbbbb', 'bbbbbbbbbbbb', null, 'bbbbbbbbbbbb', null]);
  });

  test('in a browser no target ever arms a project', () => {
    const asked: (string | null)[] = [];
    const arm = menuArmer('browser', (p) => asked.push(p));
    arm.point(row);
    arm.press(gutter, RIGHT);
    arm.point(token);
    expect(asked.filter((p) => p !== null)).toEqual([]);
  });
});

describe("AC4: the page's one backend call", () => {
  function fakeHost(result: () => unknown = async () => true) {
    const calls: unknown[][] = [];
    const host = {
      api: {
        call(...args: unknown[]) {
          calls.push(args);
          return result();
        },
      },
    };
    return { host, calls };
  }

  test('in the Mac app it calls projectMenu with the project id (or null) and nothing else', () => {
    const { host, calls } = fakeHost();
    const ask = projectMenuCaller('mac', host);
    ask?.('aaaaaaaaaaaa');
    ask?.(null);
    expect(calls).toEqual([
      ['projectMenu', { project: 'aaaaaaaaaaaa' }],
      ['projectMenu', { project: null }],
    ]);
    expect(PROJECT_MENU_METHOD).toBe('projectMenu');
  });

  test('in a browser, or without a usable window.tiny, there is no caller', () => {
    expect(projectMenuCaller('browser', fakeHost().host)).toBeNull();
    expect(projectMenuCaller(shellMode(''), fakeHost().host)).toBeNull();
    for (const host of [undefined, null, 1, 'tiny', [], {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) {
      expect({ host, ask: projectMenuCaller('mac', host) }).toEqual({ host, ask: null });
    }
  });

  test('a refused or throwing call is swallowed', async () => {
    const refused = projectMenuCaller('mac', fakeHost(async () => {
      throw new Error('denied');
    }).host);
    expect(() => refused?.('x')).not.toThrow();
    const throwing = projectMenuCaller('mac', {
      api: {
        call: () => {
          throw new Error('boom');
        },
      },
    });
    expect(() => throwing?.('x')).not.toThrow();
    await new Promise((r) => setTimeout(r, 1));
  });

  test('the sidebar rows and the lane gutters carry the project id, and All Projects and job cells do not', () => {
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    const laneSrc = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(sidebar.match(/data-project-menu=\{p\.id\}/g)?.length).toBe(1);
    expect(sidebar.match(/data-project-menu/g)?.length).toBe(1);
    expect(laneSrc.match(/<div class="gut" role="rowheader" data-project-menu=\{lane\.project\.id\}>/g)?.length).toBe(2);
    expect(laneSrc.match(/data-project-menu/g)?.length).toBe(2);
  });
});
