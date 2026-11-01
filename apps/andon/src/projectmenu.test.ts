import { describe, expect, test } from 'bun:test';
import { BUNDLE_IDS, OPEN_IN_APPS, OPEN_IN_ID, PROJECT_MENU_METHOD, REPOSITORY_HOSTS, appFallbacks, exitReason, failureText, itemId, mdfindHit, mdfindQuery, menuRequest, openInLabel, parseItemId, pickAppPath, pickT3, projectMenuItems, repositoryLink, resolveAction, t3Candidates } from './projectmenu';
import type { AppRepository } from './state';
import type { AppIcons, Availability, ContextItem, MenuProject, ProjectAction, ProjectItem } from './projectmenu';

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT, machine: null, machineName: null, repositories: [] },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null, machine: null, machineName: null, repositories: [] },
  { id: 'cccccccccccc', name: '', root: '/r/unnamed', machine: null, machineName: null, repositories: [] },
];
const KINDS: ProjectItem[] = ['copy', 'reveal', 'vscode', 't3', 'ghostty'];
const ALL_THERE: Availability = { vscode: true, ghostty: true, t3: '/home/me/.t3/bin/t3' };

describe('AC1: the menu', () => {
  test('New Exploration…, Run Next, a separator, Copy Project Path, Reveal in Finder, Open Repository (grayed out with no repository), a separator, then Open in ▸ VS Code, T3 Code, Ghostty', () => {
    expect(projectMenuItems(PID, ALL_THERE)).toEqual([
      { id: `project-menu:explore:${PID}`, label: 'New Exploration…' },
      { id: `project-menu:next:${PID}`, label: 'Run Next' },
      { separator: true },
      { id: `project-menu:copy:${PID}`, label: 'Copy Project Path' },
      { id: `project-menu:reveal:${PID}`, label: 'Reveal in Finder' },
      { id: `project-menu:repo:${PID}`, label: 'Open Repository', enabled: false },
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
    const open = (a: Availability): (boolean | undefined)[] => projectMenuItems(PID, a)[7]?.submenu?.map((i) => i.enabled) ?? [];
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
      const strings = a === null ? [] : a.kind === 'spawn' ? a.argv : a.kind === 'push' ? [] : a.kind === 'open-url' ? [a.url] : [a.root];
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
  const openIn = (items: ContextItem[]): ContextItem[] => items[7]?.submenu ?? [];

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

  test('New Exploration…, Run Next, Copy Project Path, Reveal in Finder, Open Repository, the separators, and the Open in parent never carry an icon', () => {
    const items = projectMenuItems(PID, ALL_THERE, ICONS);
    expect(items.slice(0, 8).map((i) => 'icon' in i)).toEqual([false, false, false, false, false, false, false, false]);
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
    expect(items.slice(3).map((i) => i.label ?? '—')).toEqual(['Copy Project Path', 'Reveal in Finder', 'Open Repository', '—', 'Open in']);
  });

  test('every clickable id round-trips through parseItemId', () => {
    const ids = projectMenuItems(PID, ALL_THERE)
      .flatMap((i) => [i, ...(i.submenu ?? [])])
      .map((i) => i.id)
      .filter((id): id is string => id !== undefined && id !== OPEN_IN_ID);
    expect(ids.map((id) => parseItemId(id))).toEqual((['explore', 'next', 'copy', 'reveal', 'repo', 'vscode', 't3', 'ghostty'] satisfies ProjectItem[]).map((item) => ({ item, pid: PID })));
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
  const REMOTE: MenuProject[] = [...PROJECTS, { id: RID, name: 'factory', root: RROOT, machine: 'studio', machineName: 'studio', repositories: [] }];
  const t3 = '/Users/me/.t3/bin/t3';
  const ICONS: AppIcons = { vscode: '/tmp/vscode.png', t3: '/tmp/t3.png', ghostty: '/tmp/ghostty.png' };

  test("has today's items in today's order: Reveal in Finder and every Open in app grayed out, the submenu naming the machine", () => {
    expect(projectMenuItems(RID, ALL_THERE, {}, 'studio')).toEqual([
      { id: `project-menu:explore:${RID}`, label: 'New Exploration…' },
      { id: `project-menu:next:${RID}`, label: 'Run Next' },
      { separator: true },
      { id: `project-menu:copy:${RID}`, label: 'Copy Project Path' },
      { id: `project-menu:reveal:${RID}`, label: 'Reveal in Finder', enabled: false },
      { id: `project-menu:repo:${RID}`, label: 'Open Repository', enabled: false },
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
      expect(items[7]?.submenu?.map((i) => [i.enabled, i.icon])).toEqual([
        [false, '/tmp/vscode.png'],
        [false, '/tmp/t3.png'],
        [false, '/tmp/ghostty.png'],
      ]);
    }
  });

  test('a local project, with no machine, is as today', () => {
    expect(projectMenuItems(PID, ALL_THERE, {}, null)).toEqual(projectMenuItems(PID, ALL_THERE));
    expect(projectMenuItems(PID, ALL_THERE)[7]?.label).toBe('Open in');
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
    for (const item of ['explore', 'next', 'copy', 'reveal', 'repo', 'vscode', 't3', 'ghostty'] satisfies ProjectItem[]) expect(parseItemId(itemId(item, RID))).toEqual({ item, pid: RID });
  });
});

// ---- the project's repository page (088) ----

describe('088: Open on … the project\'s repository page', () => {
  const RID = '1a2b3c4d5e6f@studio';
  const t3 = '/Users/me/.t3/bin/t3';
  const repo = (remote: string, host: string, owner = 'mattmccray', name = 'factory'): AppRepository => ({ remote, host, owner, name });
  const local = (repositories: AppRepository[]): MenuProject => ({ id: PID, name: 'factory', root: ROOT, machine: null, machineName: null, repositories });
  const remote = (repositories: AppRepository[]): MenuProject => ({ id: RID, name: 'factory', root: '/Users/studio-me/code/factory', machine: 'studio', machineName: 'studio', repositories });
  /** The menu item and the clicked action, for one project. */
  const both = (p: MenuProject): { item: ContextItem | undefined; action: ProjectAction | null } => ({
    item: projectMenuItems(p.id, ALL_THERE, {}, p.machine, p.repositories).find((i) => i.id === itemId('repo', p.id)),
    action: resolveAction(itemId('repo', p.id), [p], t3),
  });

  test('AC1: a local and a remote project with a github.com remote list Open on GitHub right after Reveal in Finder, enabled, outside Open in', () => {
    for (const p of [local([repo('origin', 'github.com')]), remote([repo('origin', 'github.com')])]) {
      const items = projectMenuItems(p.id, ALL_THERE, {}, p.machine, p.repositories);
      expect(items.map((i) => i.label ?? '—')).toEqual(['New Exploration…', 'Run Next', '—', 'Copy Project Path', 'Reveal in Finder', 'Open on GitHub', '—', openInLabel(p.machine)]);
      expect(items[5]).toEqual({ id: `project-menu:repo:${p.id}`, label: 'Open on GitHub' });
      expect(items[5]?.enabled).not.toBe(false);
      expect(items[5]?.submenu).toBeUndefined();
      expect(items[7]?.submenu?.map((i) => i.id)).toEqual([itemId('vscode', p.id), itemId('t3', p.id), itemId('ghostty', p.id)]);
    }
  });

  test('AC2: each known host opens exactly https://<host>/<owner>/<name>, labeled Open on <provider>, local or remote', () => {
    const cases: [string, string][] = [
      ['github.com', 'GitHub'],
      ['bitbucket.org', 'Bitbucket'],
      ['gitlab.com', 'GitLab'],
      ['git.cafe', 'git.cafe'],
    ];
    for (const [host, provider] of cases) {
      for (const make of [local, remote]) {
        const p = make([repo('origin', host, 'some-owner', 'the.repo_1')]);
        const { item, action } = both(p);
        expect(item).toEqual({ id: itemId('repo', p.id), label: `Open on ${provider}` });
        expect(action).toEqual({ kind: 'open-url', url: `https://${host}/some-owner/the.repo_1`, provider, project: 'factory' });
      }
    }
    expect(Object.fromEntries(REPOSITORY_HOSTS.map((h) => [h.host, h.label]))).toEqual(Object.fromEntries(cases));
  });

  test('AC3: a github.com remote beats a self-hosted origin; with no GitHub, the first known by remote name; with several GitHub, the first GitHub by remote name', () => {
    expect(repositoryLink([repo('origin', 'localhost:222'), repo('zz-github', 'github.com', 'a', 'b')])).toEqual({ url: 'https://github.com/a/b', provider: 'GitHub' });
    expect(repositoryLink([repo('origin', 'gitlab.com', 'o', 'gl'), repo('backup', 'bitbucket.org', 'o', 'bb'), repo('a-self', 'git.example.com', 'o', 'x')])).toEqual({ url: 'https://bitbucket.org/o/bb', provider: 'Bitbucket' });
    expect(repositoryLink([repo('origin', 'github.com', 'o', 'second'), repo('fork', 'github.com', 'o', 'first'), repo('aaa', 'gitlab.com', 'o', 'gl')])).toEqual({ url: 'https://github.com/o/first', provider: 'GitHub' });
    // an unusable GitHub remote is passed over, not picked
    expect(repositoryLink([repo('a', 'github.com', 'o', 'a/b'), repo('b', 'gitlab.com', 'o', 'ok')])).toEqual({ url: 'https://gitlab.com/o/ok', provider: 'GitLab' });
    // the host compare is against the lowercased host
    expect(repositoryLink([repo('origin', 'GitHub.com', 'o', 'n')])).toEqual({ url: 'https://github.com/o/n', provider: 'GitHub' });
    const p = local([repo('origin', 'localhost:222'), repo('github', 'github.com', 'mattmccray', 'factory')]);
    expect(both(p).action).toEqual({ kind: 'open-url', url: 'https://github.com/mattmccray/factory', provider: 'GitHub', project: 'factory' });
  });

  test('AC4: with no usable remote, a grayed-out Open Repository in the same place, and its id resolves to nothing', () => {
    const unusable: AppRepository[][] = [
      [],
      [repo('origin', 'localhost:222')],
      [repo('origin', 'github.com:2222')],
      [repo('origin', 'git.example.com')],
      [repo('origin', 'github.com', 'a/b')],
      [repo('origin', 'github.com', 'o', 'a/b')],
      [repo('origin', 'github.com', '..')],
      [repo('origin', 'github.com', 'o', '.')],
      [repo('origin', 'github.com', 'o', 'with space')],
      [repo('origin', 'github.com', 'o', 'q?x')],
      [repo('origin', 'gitlab.com', 'o', 'h#x')],
      [repo('origin', 'bitbucket.org', 'o%2e', 'n')],
    ];
    for (const repos of unusable) {
      for (const make of [local, remote]) {
        const p = make(repos);
        const items = projectMenuItems(p.id, ALL_THERE, {}, p.machine, p.repositories);
        expect({ repos, item: items[5] }).toEqual({ repos, item: { id: itemId('repo', p.id), label: 'Open Repository', enabled: false } });
        expect(items.map((i) => i.label ?? '—').slice(3, 7)).toEqual(['Copy Project Path', 'Reveal in Finder', 'Open Repository', '—']);
        expect({ repos, action: resolveAction(itemId('repo', p.id), [p], t3) }).toEqual({ repos, action: null });
        expect(repositoryLink(repos)).toBeNull();
      }
    }
  });

  test('AC5: an id for an unlisted project, a rootless one, or one whose listed repositories no longer give a usable remote resolves to nothing', () => {
    const p = local([repo('origin', 'github.com')]);
    expect(resolveAction(itemId('repo', 'zzzzzzzzzzzz'), [p], t3)).toBeNull();
    expect(resolveAction(itemId('repo', PID), [], t3)).toBeNull();
    expect(resolveAction(itemId('repo', PID), [{ ...p, root: null }], t3)).toBeNull();
    expect(resolveAction(itemId('repo', PID), [local([repo('origin', 'localhost:222')])], t3)).toBeNull();
    // the URL comes from the listed project, never from the id
    expect(resolveAction(`project-menu:repo:${PID}`, [p], t3)).toEqual({ kind: 'open-url', url: 'https://github.com/mattmccray/factory', provider: 'GitHub', project: 'factory' });
    expect(resolveAction('project-menu:repo:https://evil.example/x', [p], t3)).toBeNull();
  });

  test('the failure text names the project and the provider', () => {
    expect(failureText({ kind: 'open-url', url: 'https://github.com/o/n', provider: 'GitHub', project: 'factory' }, 'the page did not open')).toBe("Couldn't open factory on GitHub: the page did not open");
  });
});
