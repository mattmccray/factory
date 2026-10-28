import { describe, expect, test } from 'bun:test';
import { HAND_OFF_METHOD, JOB_ID, MAIN_WINDOW_ID, MAX_COMMAND, draftFailureText, draftLink, factoryCommand, fromMainWindow, githubRepo, handoffRequest, originArgv, sendArgv, sendFailureText } from './handoff';
import type { MenuProject } from './projectmenu';

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null },
  { id: 'cccccccccccc', name: 'relative', root: 'code/relative' },
];
const JOB = '036-t3-handoff';

describe('036 AC1: the hand-off request', () => {
  test('a valid approve, rework, or abandon gets the project, the job, the action, and the built command', () => {
    expect(handoffRequest({ project: PID, job: JOB, action: 'approve' }, PROJECTS)).toEqual({ project: { id: PID, name: 'factory', root: ROOT }, job: JOB, action: 'approve', command: '/factory approve 036-t3-handoff' });
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

describe('036 AC3: the origin remote as a GitHub repo', () => {
  test('https, scp-style ssh, and ssh:// github.com URLs, with or without .git, give owner/name', () => {
    const good: [string, string][] = [
      ['https://github.com/mattmccray/factory', 'mattmccray/factory'],
      ['https://github.com/mattmccray/factory.git', 'mattmccray/factory'],
      ['https://github.com/mattmccray/factory.git\n', 'mattmccray/factory'],
      ['git@github.com:mattmccray/factory', 'mattmccray/factory'],
      ['git@github.com:mattmccray/factory.git\n', 'mattmccray/factory'],
      ['ssh://git@github.com/mattmccray/factory', 'mattmccray/factory'],
      ['ssh://git@github.com/mattmccray/factory.git', 'mattmccray/factory'],
      ['https://github.com/My-Org_1/some.repo.git', 'My-Org_1/some.repo'],
    ];
    for (const [url, repo] of good) expect({ url, repo: githubRepo(url) }).toEqual({ url, repo });
  });

  test('another host, a local path, empty output, or a failed git gives null', () => {
    const bad: (string | null)[] = [
      null,
      '',
      '\n',
      'https://gitlab.com/mattmccray/factory.git',
      'https://github.com.evil.com/mattmccray/factory',
      'https://evil.com/github.com/mattmccray/factory',
      'git@gitlab.com:mattmccray/factory.git',
      'ssh://git@gitlab.com/mattmccray/factory.git',
      '/Users/me/code/factory',
      '../factory',
      'file:///Users/me/factory.git',
      'http://github.com/mattmccray/factory',
      'https://github.com/mattmccray',
      'https://github.com/mattmccray/factory/tree/main',
      'https://github.com/matt mccray/factory',
      'https://github.com/mattmccray/fac&tory',
      'https://github.com/mattmccray/factory?x=1',
      'https://user@github.com/mattmccray/factory',
      'https://github.com/mattmccray/.git',
      'https://github.com/../factory',
      ' https://github.com/mattmccray/factory',
      'https://github.com/mattmccray/factory\nhttps://github.com/a/b',
    ];
    for (const url of bad) expect({ url, repo: githubRepo(url) }).toEqual({ url, repo: null });
  });

  test('git is asked for the origin of the root, as an argv', () => {
    expect(originArgv(ROOT)).toEqual(['git', '-C', ROOT, 'remote', 'get-url', 'origin']);
  });

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
