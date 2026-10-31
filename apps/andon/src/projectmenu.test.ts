import { describe, expect, test } from 'bun:test';
import { BUNDLE_IDS, OPEN_IN_APPS, OPEN_IN_ID, PROJECT_MENU_METHOD, appFallbacks, exitReason, failureText, itemId, mdfindHit, mdfindQuery, menuRequest, parseItemId, pickAppPath, pickT3, projectMenuItems, resolveAction, t3Candidates } from './projectmenu';
import type { AppIcons, Availability, ContextItem, MenuProject, ProjectAction, ProjectItem } from './projectmenu';

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT, machine: null },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null, machine: null },
  { id: 'cccccccccccc', name: '', root: '/r/unnamed', machine: null },
];
const KINDS: ProjectItem[] = ['copy', 'reveal', 'vscode', 't3', 'ghostty'];
const ALL_THERE: Availability = { vscode: true, ghostty: true, t3: '/home/me/.t3/bin/t3' };

describe('AC1: the menu', () => {
  test('New Exploration…, Run Next, a separator, Copy Project Path, Reveal in Finder, a separator, then Open in ▸ VS Code, T3 Code, Ghostty', () => {
    expect(projectMenuItems(PID, ALL_THERE)).toEqual([
      { id: `project-menu:explore:${PID}`, label: 'New Exploration…' },
      { id: `project-menu:next:${PID}`, label: 'Run Next' },
      { separator: true },
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
    const open = (a: Availability): (boolean | undefined)[] => projectMenuItems(PID, a)[6]?.submenu?.map((i) => i.enabled) ?? [];
    expect(open({ vscode: false, ghostty: true, t3: '/x/t3' })).toEqual([false, true, true]);
    expect(open({ vscode: true, ghostty: false, t3: '/x/t3' })).toEqual([true, true, false]);
    expect(open({ vscode: true, ghostty: true, t3: null })).toEqual([true, false, true]);
    expect(open({ vscode: false, ghostty: false, t3: null })).toEqual([false, false, false]);
    // New Exploration…, Run Next, copy, and reveal are never grayed out
    for (const item of projectMenuItems(PID, { vscode: false, ghostty: false, t3: null }).slice(0, 5)) expect(item.enabled).toBeUndefined();
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
      const strings = a === null ? [] : a.kind === 'spawn' ? a.argv : a.kind === 'push' ? [] : [a.root];
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

// ---- 043: the Open in apps' own icons ----

describe('043 AC1: an Open in item carries its app icon whenever one was found', () => {
  const ICONS: AppIcons = { vscode: '/tmp/vscode.png', t3: '/tmp/t3.png', ghostty: '/tmp/ghostty.png' };
  const openIn = (items: ContextItem[]): ContextItem[] => items[6]?.submenu ?? [];

  test('every item with an icon carries it; ids, labels, and enabled are as without icons', () => {
    for (const apps of [ALL_THERE, { vscode: false, ghostty: true, t3: null }, { vscode: false, ghostty: false, t3: null }]) {
      const plain = projectMenuItems(PID, apps);
      const withIcons = projectMenuItems(PID, apps, ICONS);
      expect(openIn(withIcons).map((i) => i.icon)).toEqual(['/tmp/vscode.png', '/tmp/t3.png', '/tmp/ghostty.png']);
      expect(openIn(withIcons).map(({ icon: _icon, ...rest }) => rest)).toEqual(openIn(plain));
    }
  });

  test('a grayed-out item keeps its icon (T3 Code with its .app found but no t3)', () => {
    const t3 = openIn(projectMenuItems(PID, { vscode: true, ghostty: true, t3: null }, { t3: '/tmp/t3.png' }))[1];
    expect(t3).toEqual({ id: `project-menu:t3:${PID}`, label: 'T3 Code', enabled: false, icon: '/tmp/t3.png' });
  });

  test('an app with no icon has no icon key', () => {
    const items = openIn(projectMenuItems(PID, ALL_THERE, { ghostty: '/tmp/ghostty.png' }));
    expect(items.map((i) => 'icon' in i)).toEqual([false, false, true]);
    expect(openIn(projectMenuItems(PID, ALL_THERE)).some((i) => 'icon' in i)).toBe(false);
    expect(openIn(projectMenuItems(PID, ALL_THERE, {})).some((i) => 'icon' in i)).toBe(false);
  });

  test('New Exploration…, Run Next, Copy Project Path, Reveal in Finder, the separators, and the Open in parent never carry an icon', () => {
    const items = projectMenuItems(PID, ALL_THERE, ICONS);
    expect(items.slice(0, 7).map((i) => 'icon' in i)).toEqual([false, false, false, false, false, false, false]);
  });
});

describe('043 AC2: where each app is looked for', () => {
  test('the bundle ids', () => {
    expect(OPEN_IN_APPS).toEqual(['vscode', 't3', 'ghostty']);
    expect(BUNDLE_IDS).toEqual({ vscode: 'com.microsoft.VSCode', t3: 'com.t3tools.t3code', ghostty: 'com.mitchellh.ghostty' });
    expect(mdfindQuery('vscode')).toBe('kMDItemCFBundleIdentifier == "com.microsoft.VSCode"');
    expect(mdfindQuery('t3')).toBe('kMDItemCFBundleIdentifier == "com.t3tools.t3code"');
    expect(mdfindQuery('ghostty')).toBe('kMDItemCFBundleIdentifier == "com.mitchellh.ghostty"');
  });

  test('the fallbacks: under /Applications, then ~/Applications, only for an absolute HOME', () => {
    expect(appFallbacks('vscode', '/Users/me')).toEqual(['/Applications/Visual Studio Code.app', '/Users/me/Applications/Visual Studio Code.app']);
    expect(appFallbacks('ghostty', '/Users/me/')).toEqual(['/Applications/Ghostty.app', '/Users/me/Applications/Ghostty.app']);
    expect(appFallbacks('t3', '/Users/me')).toEqual(['/Applications/T3 Code.app', '/Applications/T3 Code (Beta).app', '/Users/me/Applications/T3 Code.app', '/Users/me/Applications/T3 Code (Beta).app']);
    for (const home of [undefined, '', 'Users/me', '~']) expect(appFallbacks('vscode', home)).toEqual(['/Applications/Visual Studio Code.app']);
  });

  test("the found path: mdfind's first hit, then the first fallback present", () => {
    const hits = '/Users/me/Applications/Visual Studio Code.app\n/Volumes/old/Visual Studio Code.app\n';
    expect(mdfindHit(hits)).toBe('/Users/me/Applications/Visual Studio Code.app');
    expect(mdfindHit('\n  \n')).toBeNull();
    expect(mdfindHit(null)).toBeNull();
    expect(pickAppPath('vscode', hits, '/Users/me', () => true)).toBe('/Users/me/Applications/Visual Studio Code.app');
    const present = new Set(['/Users/me/Applications/T3 Code (Beta).app', '/Applications/T3 Code (Beta).app']);
    expect(pickAppPath('t3', '', '/Users/me', (p) => present.has(p))).toBe('/Applications/T3 Code (Beta).app');
    expect(pickAppPath('t3', null, '/Users/me', (p) => p === '/Users/me/Applications/T3 Code (Beta).app')).toBe('/Users/me/Applications/T3 Code (Beta).app');
    expect(pickAppPath('ghostty', null, '/Users/me', () => false)).toBeNull();
  });
});

describe('075 AC2/AC3: New Exploration… and Run Next', () => {
  const t3 = '/Users/me/.t3/bin/t3';

  test('today\'s items are unchanged after the two new items and their separator', () => {
    const items = projectMenuItems(PID, ALL_THERE);
    expect(items.slice(0, 3)).toEqual([{ id: itemId('explore', PID), label: 'New Exploration…' }, { id: itemId('next', PID), label: 'Run Next' }, { separator: true }]);
    expect(items.slice(3).map((i) => i.label ?? '—')).toEqual(['Copy Project Path', 'Reveal in Finder', '—', 'Open in']);
  });

  test('every clickable id round-trips through parseItemId', () => {
    const ids = projectMenuItems(PID, ALL_THERE)
      .flatMap((i) => [i, ...(i.submenu ?? [])])
      .map((i) => i.id)
      .filter((id): id is string => id !== undefined && id !== OPEN_IN_ID);
    expect(ids.map((id) => parseItemId(id))).toEqual((['explore', 'next', 'copy', 'reveal', 'vscode', 't3', 'ghostty'] satisfies ProjectItem[]).map((item) => ({ item, pid: PID })));
    expect(itemId('explore', PID)).toBe(`project-menu:explore:${PID}`);
    expect(itemId('next', PID)).toBe(`project-menu:next:${PID}`);
  });

  test('New Exploration… on a listed project with a root shows the main window and pushes { action: new-exploration, project }', () => {
    expect(resolveAction(itemId('explore', PID), PROJECTS, t3)).toEqual({ kind: 'push', payload: { action: 'new-exploration', project: PID }, show: true, project: 'factory' });
    expect(resolveAction(itemId('explore', PID), PROJECTS, null)).toEqual({ kind: 'push', payload: { action: 'new-exploration', project: PID }, show: true, project: 'factory' });
  });

  test('Run Next on such a project pushes { action: next, project }', () => {
    expect(resolveAction(itemId('next', PID), PROJECTS, t3)).toEqual({ kind: 'push', payload: { action: 'next', project: PID }, show: false, project: 'factory' });
    expect(resolveAction(itemId('next', 'cccccccccccc'), PROJECTS, null)).toEqual({ kind: 'push', payload: { action: 'next', project: 'cccccccccccc' }, show: false, project: 'cccccccccccc' });
  });

  test('either one on an unlisted or rootless project does nothing', () => {
    for (const item of ['explore', 'next'] satisfies ProjectItem[]) {
      for (const pid of ['zzzzzzzzzzzz', 'bbbbbbbbbbbb', ROOT, '; rm -rf ~']) expect({ item, pid, action: resolveAction(itemId(item, pid), PROJECTS, t3) }).toEqual({ item, pid, action: null });
      expect(resolveAction(itemId(item, PID), [], t3)).toBeNull();
    }
  });
});

// ---- machines (081) ----

describe("081 AC5: a remote project's menu", () => {
  const RID = '1a2b3c4d5e6f@studio';
  const RROOT = '/Users/studio-me/code/factory';
  const REMOTE: MenuProject[] = [...PROJECTS, { id: RID, name: 'factory', root: RROOT, machine: 'studio' }];
  const t3 = '/Users/me/.t3/bin/t3';
  const ICONS: AppIcons = { vscode: '/tmp/vscode.png', t3: '/tmp/t3.png', ghostty: '/tmp/ghostty.png' };

  test("has today's items in today's order: Reveal in Finder and every Open in app grayed out, the submenu naming the machine", () => {
    expect(projectMenuItems(RID, ALL_THERE, {}, 'studio')).toEqual([
      { id: `project-menu:explore:${RID}`, label: 'New Exploration…' },
      { id: `project-menu:next:${RID}`, label: 'Run Next' },
      { separator: true },
      { id: `project-menu:copy:${RID}`, label: 'Copy Project Path' },
      { id: `project-menu:reveal:${RID}`, label: 'Reveal in Finder', enabled: false },
      { separator: true },
      {
        id: OPEN_IN_ID,
        label: 'Open in (on studio)',
        submenu: [
          { id: `project-menu:vscode:${RID}`, label: 'VS Code', enabled: false },
          { id: `project-menu:t3:${RID}`, label: 'T3 Code', enabled: false },
          { id: `project-menu:ghostty:${RID}`, label: 'Ghostty', enabled: false },
        ],
      },
    ]);
  });

  test('stays grayed out whatever the app check found, and keeps the icons found', () => {
    for (const apps of [ALL_THERE, { vscode: false, ghostty: true, t3: null }, { vscode: false, ghostty: false, t3: null }]) {
      const items = projectMenuItems(RID, apps, ICONS, 'studio');
      expect(items[4]?.enabled).toBe(false);
      expect(items[6]?.submenu?.map((i) => [i.enabled, i.icon])).toEqual([
        [false, '/tmp/vscode.png'],
        [false, '/tmp/t3.png'],
        [false, '/tmp/ghostty.png'],
      ]);
    }
  });

  test('a local project, with no machine, is as today', () => {
    expect(projectMenuItems(PID, ALL_THERE, {}, null)).toEqual(projectMenuItems(PID, ALL_THERE));
    expect(projectMenuItems(PID, ALL_THERE)[6]?.label).toBe('Open in');
    expect(projectMenuItems(PID, ALL_THERE)[4]).toEqual({ id: itemId('reveal', PID), label: 'Reveal in Finder' });
  });

  test('resolveAction refuses reveal, VS Code, T3 Code, and Ghostty on it, so a stale or forged id runs nothing', () => {
    for (const item of ['reveal', 'vscode', 't3', 'ghostty'] satisfies ProjectItem[]) {
      for (const found of [t3, null]) expect({ item, found, action: resolveAction(itemId(item, RID), REMOTE, found) }).toEqual({ item, found, action: null });
    }
  });

  test('New Exploration… and Run Next push startwork for it, and Copy Project Path copies the remote root', () => {
    expect(resolveAction(itemId('explore', RID), REMOTE, t3)).toEqual({ kind: 'push', payload: { action: 'new-exploration', project: RID }, show: true, project: 'factory' });
    expect(resolveAction(itemId('next', RID), REMOTE, null)).toEqual({ kind: 'push', payload: { action: 'next', project: RID }, show: false, project: 'factory' });
    expect(resolveAction(itemId('copy', RID), REMOTE, t3)).toEqual({ kind: 'copy', root: RROOT, project: 'factory' });
  });

  test("a local project's actions are unchanged beside it", () => {
    expect(resolveAction(itemId('reveal', PID), REMOTE, t3)).toEqual({ kind: 'reveal', root: ROOT, project: 'factory' });
    expect(resolveAction(itemId('t3', PID), REMOTE, t3)).toEqual({ kind: 'spawn', argv: [t3, 'app', ROOT], app: 'T3 Code', project: 'factory' });
  });

  test('its item ids round-trip with the @-suffixed project id', () => {
    for (const item of ['explore', 'next', 'copy', 'reveal', 'vscode', 't3', 'ghostty'] satisfies ProjectItem[]) expect(parseItemId(itemId(item, RID))).toEqual({ item, pid: RID });
  });
});
