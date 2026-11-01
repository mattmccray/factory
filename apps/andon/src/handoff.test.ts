import { describe, expect, test } from 'bun:test';
import { HAND_OFF_METHOD, JOB_ID, MAIN_WINDOW_ID, MAX_COMMAND, T3_HOSTS, draftFailureText, draftLink, draftTarget, factoryCommand, fromMainWindow, handoffRequest, linkable, machineLabel, primaryRepository, sameRepository, sendArgv, sendFailureText } from './handoff';
import type { AppRepository } from './state';
import type { MenuProject } from './projectmenu';

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT, machine: null, machineName: null, repositories: [] },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null, machine: null, machineName: null, repositories: [] },
  { id: 'cccccccccccc', name: 'relative', root: 'code/relative', machine: null, machineName: null, repositories: [] },
];
const JOB = '036-t3-handoff';

describe('036 AC1: the hand-off request', () => {
  test('a valid approve, rework, or abandon gets the project, the job, the action, and the built command', () => {
    expect(handoffRequest({ project: PID, job: JOB, action: 'approve' }, PROJECTS)).toEqual({ project: { id: PID, name: 'factory', root: ROOT, machine: null, machineName: null, repositories: [] }, job: JOB, action: 'approve', command: '/factory approve 036-t3-handoff' });
    expect(handoffRequest({ project: PID, job: JOB, action: 'rework', note: 'add the test' }, PROJECTS)?.command).toBe('/factory rework 036-t3-handoff "add the test"');
    expect(handoffRequest({ project: PID, job: JOB, action: 'abandon', note: ' superseded\n' }, PROJECTS)?.command).toBe('/factory abandon 036-t3-handoff "superseded"');
  });

  test('an unknown or rootless project, a malformed id, an unknown action, or a blank note is refused', () => {
    const bad: unknown[] = [
      { project: 'zzzzzzzzzzzz', job: JOB, action: 'approve' },
      { project: 'bbbbbbbbbbbb', job: JOB, action: 'approve' },
      { project: 'cccccccccccc', job: JOB, action: 'approve' },
      { project: ROOT, job: JOB, action: 'approve' },
      { project: '', job: JOB, action: 'approve' },
      ...['36-x', '036', '036-', '036-T3', '036-a b', '036-a;rm', '../036-a', '036-a\n', '0360-a', 'abc-def', ''].map((job) => ({ project: PID, job, action: 'approve' })),
      { project: PID, job: JOB, action: 'merge' },
      { project: PID, job: JOB, action: 'APPROVE' },
      { project: PID, job: JOB, action: '' },
      { project: PID, job: JOB, action: 'rework' },
      { project: PID, job: JOB, action: 'rework', note: '' },
      { project: PID, job: JOB, action: 'rework', note: '  \n\t ' },
      { project: PID, job: JOB, action: 'abandon', note: '' },
      { project: PID, job: JOB, action: 'abandon' },
    ];
    for (const p of bad) expect({ p, r: handoffRequest(p, PROJECTS) }).toEqual({ p, r: null });
  });

  test('extra keys, wrong types, and non-objects are refused', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'approve',
      42,
      [],
      [PID, JOB, 'approve'],
      {},
      { project: PID, job: JOB, action: 'approve', note: 'x' }, // approve takes no note
      { project: PID, job: JOB, action: 'approve', command: '/factory approve 036-t3-handoff' },
      { project: PID, job: JOB, action: 'rework', note: 'x', prompt: 'do it' },
      { project: PID, job: JOB, action: 'rework', note: 'x', root: ROOT },
      { project: PID, job: JOB, action: 'rework', note: 7 },
      { project: PID, job: JOB, action: 'rework', note: ['x'] },
      { project: 1, job: JOB, action: 'approve' },
      { project: PID, job: 36, action: 'approve' },
      { project: PID, job: JOB, action: ['approve'] },
      { project: PID, job: JOB },
      { job: JOB, action: 'approve' },
    ];
    for (const p of bad) expect({ p, r: handoffRequest(p, PROJECTS) }).toEqual({ p, r: null });
  });

  test('a command of exactly 8,000 characters is allowed, one more is refused', () => {
    const prefix = factoryCommand('rework', JOB, '').length - 2; // `/factory rework <id> ` before the quotes
    const fits = 'a'.repeat(MAX_COMMAND - prefix - 2);
    expect(MAX_COMMAND).toBe(8000);
    expect(handoffRequest({ project: PID, job: JOB, action: 'rework', note: fits }, PROJECTS)?.command.length).toBe(8000);
    expect(handoffRequest({ project: PID, job: JOB, action: 'abandon', note: `${fits}b` }, PROJECTS)).toBeNull();
    // escaping counts: 4,000 quotes become 8,000 characters
    expect(handoffRequest({ project: PID, job: JOB, action: 'rework', note: '"'.repeat(4000) }, PROJECTS)).toBeNull();
  });

  test('the job id form matches the contract', () => {
    expect(JOB_ID.source).toBe('^\\d{3}-[a-z0-9-]+$');
  });

  test('only the main window is answered', () => {
    expect(HAND_OFF_METHOD).toBe('handOff');
    expect(MAIN_WINDOW_ID).toBe('main');
    expect(fromMainWindow({ window: 'main' })).toBe(true);
    expect(fromMainWindow({ window: 'main', origin: 'http://127.0.0.1:8766' })).toBe(true);
    for (const meta of [{ window: 'settings' }, { window: 'Main' }, {}, null, undefined, 'main', { window: ['main'] }]) expect({ meta, ok: fromMainWindow(meta) }).toEqual({ meta, ok: false });
  });
});

const repo = (remote: string, host: string, owner: string, name: string): AppRepository => ({ remote, host, owner, name });
const project = (id: string, machineName: string | null, repositories: AppRepository[]): MenuProject => ({
  id,
  name: 'factory',
  root: '/r',
  machine: id.includes('@') ? (id.split('@')[1] ?? null) : null,
  machineName,
  repositories,
});

describe('086 AC4: the repository a draft names', () => {
  test("T3 Code's primary remote: upstream, else origin, else the first by remote name; none with none", () => {
    const up = repo('upstream', 'github.com', 'a', 'up');
    const origin = repo('origin', 'github.com', 'a', 'origin');
    const zeta = repo('zeta', 'github.com', 'a', 'zeta');
    const beta = repo('beta', 'github.com', 'a', 'beta');
    expect(primaryRepository([origin, up, zeta])).toEqual(up);
    expect(primaryRepository([zeta, origin, beta])).toEqual(origin);
    expect(primaryRepository([zeta, beta])).toEqual(beta);
    expect(primaryRepository([])).toBeNull();
  });

  test('the allowlist is github.com only; a link needs plain owner and name parts', () => {
    expect(T3_HOSTS).toEqual(['github.com']);
    expect(linkable(repo('origin', 'github.com', 'mattmccray', 'factory'))).toBe(true);
    expect(linkable(repo('origin', 'GitHub.com', 'My-Org_1', 'some.repo'))).toBe(true);
    for (const r of [
      repo('origin', 'bitbucket.org', 'a', 'b'),
      repo('origin', 'localhost:222', 'mattm', 'infra'),
      repo('origin', 'git.cafe', 'a', 'b'),
      repo('origin', 'github.com.evil.com', 'a', 'b'),
      repo('origin', 'github.com', 'a&b', 'c'),
      repo('origin', 'github.com', 'a', 'b#c'),
      repo('origin', 'github.com', '..', 'b'),
      repo('origin', 'github.com', 'a', 'b/c'),
    ]) {
      expect({ r, ok: linkable(r) }).toEqual({ r, ok: false });
    }
  });

  test('a self-hosted origin with a github remote on GitHub is not draftable (091: not-primary); a GitHub upstream beside it is', () => {
    const selfHosted = project('aaaaaaaaaaaa', 'rocinante', [repo('github', 'github.com', 'mattmccray', 'infra'), repo('origin', 'localhost:222', 'mattm', 'infra')]);
    expect(draftTarget(selfHosted, [selfHosted])).toEqual({ kind: 'not-primary', primary: 'origin', github: 'github' });
    const none = project('aaaaaaaaaaaa', 'rocinante', []);
    expect(draftTarget(none, [none])).toEqual({ kind: 'no-github-remote' });
    const withUpstream = project('aaaaaaaaaaaa', 'rocinante', [repo('origin', 'localhost:222', 'mattm', 'infra'), repo('upstream', 'github.com', 'mattmccray', 'infra')]);
    expect(draftTarget(withUpstream, [withUpstream])).toEqual({ kind: 'repo', repo: 'mattmccray/infra' });
  });

  test('a primary repository matched by another listed project, local or remote, without case, is on several machines', () => {
    const here = project('aaaaaaaaaaaa', 'rocinante', [repo('origin', 'github.com', 'mattmccray', 'factory')]);
    const there = project('bbbbbbbbbbbb@studio', 'studio', [repo('upstream', 'GITHUB.COM', 'MattMcCray', 'Factory')]);
    const moya = project('cccccccccccc@moya', 'moya', [repo('origin', 'github.com', 'mattmccray', 'factory')]);
    const other = project('dddddddddddd@moya', 'moya', [repo('origin', 'github.com', 'mattmccray', 'notes')]);
    // only as a non-primary remote: not a match
    const secondary = project('eeeeeeeeeeee@studio', 'studio', [repo('origin', 'github.com', 'mattmccray', 'other'), repo('upstream', 'github.com', 'x', 'y'), repo('zfork', 'github.com', 'mattmccray', 'factory')]);
    expect(sameRepository(repo('a', 'github.com', 'mattmccray', 'factory'), repo('b', 'GitHub.com', 'MATTMCCRAY', 'FACTORY'))).toBe(true);
    expect(sameRepository(repo('a', 'github.com', 'o', 'n'), repo('a', 'gitlab.com', 'o', 'n'))).toBe(false);
    expect(draftTarget(here, [here, other, secondary])).toEqual({ kind: 'repo', repo: 'mattmccray/factory' });
    expect(draftTarget(here, [here, there])).toEqual({ kind: 'several-machines', machines: ['rocinante', 'studio'] });
    expect(draftTarget(there, [here, there])).toEqual({ kind: 'several-machines', machines: ['rocinante', 'studio'] });
    expect(draftTarget(moya, [here, other, there, moya])).toEqual({ kind: 'several-machines', machines: ['rocinante', 'studio', 'moya'] });
    // two checkouts on one machine name it once
    const twin = project('ffffffffffff', 'rocinante', [repo('origin', 'github.com', 'mattmccray', 'factory')]);
    expect(draftTarget(here, [here, twin, there])).toEqual({ kind: 'several-machines', machines: ['rocinante', 'studio'] });
  });

  test("a toast's machine name: the entry's, else the id's, else this Mac", () => {
    expect(machineLabel({ machine: 'studio', machineName: 'studio' })).toBe('studio');
    expect(machineLabel({ machine: null, machineName: 'rocinante' })).toBe('rocinante');
    expect(machineLabel({ machine: 'studio', machineName: null })).toBe('studio');
    expect(machineLabel({ machine: null, machineName: null })).toBe('this Mac');
  });
});

describe('091 AC1: a GitHub remote that is not the primary one', () => {
  const INFRA = [repo('gitea', 'localhost:222', 'mattm', 'infra'), repo('origin', 'localhost:222', 'mattm', 'infra'), repo('github', 'github.com', 'mattmccray', 'infra')];

  test("Infra's remotes (gitea and origin self-hosted, github on GitHub) name origin as primary and github as the fix", () => {
    const infra = project('aaaaaaaaaaaa', 'moya', INFRA);
    expect(draftTarget(infra, [infra])).toEqual({ kind: 'not-primary', primary: 'origin', github: 'github' });
  });

  test('with two linkable non-primary remotes, the first by remote name', () => {
    const two = project('aaaaaaaaaaaa', 'moya', [repo('zeta', 'github.com', 'a', 'z'), repo('origin', 'localhost:222', 'mattm', 'infra'), repo('hub', 'GitHub.com', 'a', 'h'), repo('bad', 'github.com', 'a&b', 'c')]);
    expect(draftTarget(two, [two])).toEqual({ kind: 'not-primary', primary: 'origin', github: 'hub' });
    // no upstream or origin: the primary is the first by name, and the GitHub one is another
    const named = project('aaaaaaaaaaaa', 'moya', [repo('mirror', 'github.com', 'a', 'm'), repo('gitea', 'localhost:222', 'mattm', 'infra')]);
    expect(draftTarget(named, [named])).toEqual({ kind: 'not-primary', primary: 'gitea', github: 'mirror' });
  });

  test('no repositories, or only non-allowlisted hosts, is still no-github-remote', () => {
    for (const repos of [
      [],
      [repo('origin', 'gitlab.com', 'a', 'b')],
      [repo('origin', 'bitbucket.org', 'a', 'b'), repo('gitea', 'localhost:222', 'a', 'b')],
      [repo('origin', 'localhost:222', 'mattm', 'infra'), repo('github', 'github.com.evil.com', 'a', 'b')],
    ]) {
      const p = project('aaaaaaaaaaaa', 'moya', repos);
      expect({ repos, t: draftTarget(p, [p]) }).toEqual({ repos, t: { kind: 'no-github-remote' } });
    }
  });

  test('upstream or origin on GitHub is still a repo target', () => {
    const up = project('aaaaaaaaaaaa', 'moya', [...INFRA, repo('upstream', 'github.com', 'mattmccray', 'infra')]);
    expect(draftTarget(up, [up])).toEqual({ kind: 'repo', repo: 'mattmccray/infra' });
    const origin = project('aaaaaaaaaaaa', 'moya', [repo('origin', 'github.com', 'mattmccray', 'infra'), repo('gitea', 'localhost:222', 'mattm', 'infra')]);
    expect(draftTarget(origin, [origin])).toEqual({ kind: 'repo', repo: 'mattmccray/infra' });
  });
});

describe('036 AC3: the prompt link', () => {
  test('the prompt link carries the url-encoded command and the repo', () => {
    expect(draftLink('/factory approve 036-t3-handoff', 'mattmccray/factory')).toBe('t3code://new?prompt=%2Ffactory%20approve%20036-t3-handoff&repo=mattmccray/factory');
    const cmd = factoryCommand('rework', JOB, 'a & b = "c"?#d');
    expect(draftLink(cmd, 'o/n')).toBe(`t3code://new?prompt=${encodeURIComponent(cmd)}&repo=o/n`);
    expect(new URL(draftLink(cmd, 'o/n')).searchParams.get('prompt')).toBe(cmd);
    expect(new URL(draftLink(cmd, 'o/n')).searchParams.get('repo')).toBe('o/n');
  });
});

describe('036 AC4: the send argv and the failure text', () => {
  test('a thread titled "<action> <id>" in the root, with the command, and no other flags', () => {
    const h = handoffRequest({ project: PID, job: JOB, action: 'rework', note: '--model x; rm -rf /' }, PROJECTS);
    if (h === null) throw new Error('refused');
    expect(sendArgv('/Users/me/.t3/bin/t3', h)).toEqual(['/Users/me/.t3/bin/t3', 'thread', 'start', '--title', 'rework 036-t3-handoff', ROOT, '/factory rework 036-t3-handoff "--model x; rm -rf /"']);
    expect(sendFailureText('T3 Code is not running')).toBe("Couldn't send to T3 Code: T3 Code is not running");
    expect(draftFailureText('no handler')).toBe("Couldn't open a draft in T3 Code: no handler");
  });
});
