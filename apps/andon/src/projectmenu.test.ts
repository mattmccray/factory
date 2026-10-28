import { describe, expect, test } from 'bun:test';
import { OPEN_IN_ID, PROJECT_MENU_METHOD, exitReason, failureText, itemId, menuRequest, parseItemId, pickT3, projectMenuItems, resolveAction, t3Candidates } from './projectmenu';
import type { Availability, MenuProject, ProjectAction, ProjectItem } from './projectmenu';

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null },
  { id: 'cccccccccccc', name: '', root: '/r/unnamed' },
];
const KINDS: ProjectItem[] = ['copy', 'reveal', 'vscode', 't3', 'ghostty'];
const ALL_THERE: Availability = { vscode: true, ghostty: true, t3: '/home/me/.t3/bin/t3' };

describe('AC1: the menu', () => {
  test('Copy Project Path, Reveal in Finder, a separator, then Open in ▸ VS Code, T3 Code, Ghostty', () => {
    expect(projectMenuItems(PID, ALL_THERE)).toEqual([
      { id: `project-menu:copy:${PID}`, label: 'Copy Project Path' },
      { id: `project-menu:reveal:${PID}`, label: 'Reveal in Finder' },
      { separator: true },
      {
        id: OPEN_IN_ID,
        label: 'Open in',
        submenu: [
          { id: `project-menu:vscode:${PID}`, label: 'VS Code', enabled: true },
          { id: `project-menu:t3:${PID}`, label: 'T3 Code', enabled: true },
          { id: `project-menu:ghostty:${PID}`, label: 'Ghostty', enabled: true },
        ],
      },
    ]);
  });

  test('a missing app or t3 grays its item out, and only its item', () => {
    const open = (a: Availability): (boolean | undefined)[] => projectMenuItems(PID, a)[3]?.submenu?.map((i) => i.enabled) ?? [];
    expect(open({ vscode: false, ghostty: true, t3: '/x/t3' })).toEqual([false, true, true]);
    expect(open({ vscode: true, ghostty: false, t3: '/x/t3' })).toEqual([true, true, false]);
    expect(open({ vscode: true, ghostty: true, t3: null })).toEqual([true, false, true]);
    expect(open({ vscode: false, ghostty: false, t3: null })).toEqual([false, false, false]);
    // copy and reveal are never grayed out
    for (const item of projectMenuItems(PID, { vscode: false, ghostty: false, t3: null }).slice(0, 2)) expect(item.enabled).toBeUndefined();
  });

  test('t3 is looked for at ~/.t3/bin/t3, then /opt/homebrew/bin/t3; the home one wins', () => {
    expect(t3Candidates('/Users/me')).toEqual(['/Users/me/.t3/bin/t3', '/opt/homebrew/bin/t3']);
    expect(t3Candidates('/Users/me/')).toEqual(['/Users/me/.t3/bin/t3', '/opt/homebrew/bin/t3']);
    expect(t3Candidates(undefined)).toEqual(['/opt/homebrew/bin/t3']);
    expect(t3Candidates('')).toEqual(['/opt/homebrew/bin/t3']);
    const both = new Set(['/Users/me/.t3/bin/t3', '/opt/homebrew/bin/t3']);
    expect(pickT3('/Users/me', (p) => both.has(p))).toBe('/Users/me/.t3/bin/t3');
    expect(pickT3('/Users/me', (p) => p === '/opt/homebrew/bin/t3')).toBe('/opt/homebrew/bin/t3');
    expect(pickT3('/Users/me', (p) => p === '/Users/me/.t3/bin/t3')).toBe('/Users/me/.t3/bin/t3');
    expect(pickT3('/Users/me', () => false)).toBeNull();
  });

  test('item ids round-trip their item and project id', () => {
    expect(parseItemId(itemId('ghostty', PID))).toEqual({ item: 'ghostty', pid: PID });
    expect(parseItemId(itemId('copy', 'a:b'))).toEqual({ item: 'copy', pid: 'a:b' });
    for (const id of [OPEN_IN_ID, 'project-menu:copy:', 'project-menu:rm:x', 'copy', 'statusbar', '']) expect({ id, parsed: parseItemId(id) }).toEqual({ id, parsed: null });
  });

  test('the method name is one fixed string', () => {
    expect(PROJECT_MENU_METHOD).toBe('projectMenu');
  });
});

describe('AC2: an action uses only the looked-up root', () => {
  const t3 = '/Users/me/.t3/bin/t3';
  test('each item maps to its action', () => {
    expect(resolveAction(itemId('copy', PID), PROJECTS, t3)).toEqual({ kind: 'copy', root: ROOT, project: 'factory' });
    expect(resolveAction(itemId('reveal', PID), PROJECTS, t3)).toEqual({ kind: 'reveal', root: ROOT, project: 'factory' });
    expect(resolveAction(itemId('vscode', PID), PROJECTS, t3)).toEqual({ kind: 'spawn', argv: ['open', '-a', 'Visual Studio Code', ROOT], app: 'VS Code', project: 'factory' });
    expect(resolveAction(itemId('t3', PID), PROJECTS, t3)).toEqual({ kind: 'spawn', argv: [t3, 'app', ROOT], app: 'T3 Code', project: 'factory' });
    expect(resolveAction(itemId('ghostty', PID), PROJECTS, t3)).toEqual({ kind: 'spawn', argv: ['open', '-a', 'Ghostty', ROOT], app: 'Ghostty', project: 'factory' });
  });

  test('a project with no name is named by its id', () => {
    expect(resolveAction(itemId('copy', 'cccccccccccc'), PROJECTS, t3)).toEqual({ kind: 'copy', root: '/r/unnamed', project: 'cccccccccccc' });
  });

  test('an unknown project, a rootless project, an unknown item, a non-string id, or T3 Code without t3: nothing', () => {
    const none: unknown[] = [
      itemId('copy', 'zzzzzzzzzzzz'),
      itemId('copy', 'bbbbbbbbbbbb'),
      'project-menu:rm:aaaaaaaaaaaa',
      OPEN_IN_ID,
      `project-menu:copy:${ROOT}`,
      '/etc/passwd',
      null,
      42,
      { id: itemId('copy', PID) },
    ];
    for (const id of none) expect({ id, action: resolveAction(id, PROJECTS, t3) }).toEqual({ id, action: null });
    expect(resolveAction(itemId('t3', PID), PROJECTS, null)).toBeNull();
    expect(resolveAction(itemId('copy', PID), [], t3)).toBeNull();
  });

  test('no string the page could send reaches an argv, a clipboard write, or a reveal path', () => {
    // A hostile project id is only ever a lookup key: the project list decides the root.
    const hostile = ['/tmp/evil', '; rm -rf ~', '--help', 'Visual Studio Code', `${PID} /tmp/x`];
    for (const pid of hostile) {
      for (const item of KINDS) expect(resolveAction(itemId(item, pid), PROJECTS, t3)).toBeNull();
    }
    for (const item of KINDS) {
      const a = resolveAction(itemId(item, PID), PROJECTS, t3);
      const strings = a === null ? [] : a.kind === 'spawn' ? a.argv : [a.root];
      for (const s of strings) expect([ROOT, t3, 'open', '-a', 'Visual Studio Code', 'Ghostty', 'app']).toContain(s);
    }
  });

  test('the page asks with { project: id } or { project: null }; anything else is malformed', () => {
    expect(menuRequest({ project: PID })).toEqual({ project: PID });
    expect(menuRequest({ project: null })).toEqual({ project: null });
    for (const p of [undefined, null, PID, 42, [], {}, { project: 42 }, { project: '' }, { project: ['x'] }, { project: { id: PID } }]) {
      expect({ p, req: menuRequest(p) }).toEqual({ p, req: null });
    }
  });
});

describe('AC6: the failure text', () => {
  const t3 = '/x/t3';
  const act = (item: ProjectItem): ProjectAction => {
    const a = resolveAction(itemId(item, PID), PROJECTS, t3);
    if (a === null) throw new Error('no action');
    return a;
  };
  test('names the project, the app or action, and the reason', () => {
    expect(failureText(act('t3'), 'T3 Code is not running')).toBe("Couldn't open factory in T3 Code: T3 Code is not running");
    expect(failureText(act('vscode'), 'x')).toBe("Couldn't open factory in VS Code: x");
    expect(failureText(act('ghostty'), 'x')).toBe("Couldn't open factory in Ghostty: x");
    expect(failureText(act('copy'), 'x')).toBe("Couldn't copy the path of factory: x");
    expect(failureText(act('reveal'), 'x')).toBe("Couldn't reveal factory in Finder: x");
  });
  test("a failed command's reason is its last stderr line, or its exit status", () => {
    expect(exitReason(1, 'warn\nUnable to find application named \'Ghostty\'\n\n')).toBe("Unable to find application named 'Ghostty'");
    expect(exitReason(3, '  \n')).toBe('exited with status 3');
  });
});
