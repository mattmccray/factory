import { describe, expect, test } from 'bun:test';
import type { GitRunner } from './archive';
import { parseRemoteUrl, readRepositories, sameRepositories } from './repositories';

const enc = new TextEncoder();
const answering = (code: number, out: string): GitRunner => async () => ({ code, stdout: enc.encode(out) });

describe('parseRemoteUrl (AC1)', () => {
  test('the five hosted forms parse; .git is stripped; no credential survives', () => {
    expect(parseRemoteUrl('https://github.com/mattmccray/factory.git')).toEqual({ host: 'github.com', owner: 'mattmccray', name: 'factory' });
    expect(parseRemoteUrl('git@github.com:mattmccray/factory')).toEqual({ host: 'github.com', owner: 'mattmccray', name: 'factory' });
    expect(parseRemoteUrl('ssh://git@localhost:222/mattm/infra.git')).toEqual({ host: 'localhost:222', owner: 'mattm', name: 'infra' });
    const secret = parseRemoteUrl('https://user:ghp_secret@github.com/o/n');
    expect(secret).toEqual({ host: 'github.com', owner: 'o', name: 'n' });
    expect(JSON.stringify(secret)).not.toContain('user');
    expect(JSON.stringify(secret)).not.toContain('ghp_secret');
    expect(parseRemoteUrl('https://bitbucket.org/team/repo.git')).toEqual({ host: 'bitbucket.org', owner: 'team', name: 'repo' });
  });

  test('local paths, file: URLs, relative paths, and deeper paths are null', () => {
    for (const url of ['/srv/repo.git', 'file:///x', '../other', 'https://github.com/a/b/c']) expect(parseRemoteUrl(url)).toBeNull();
  });

  test('the host is lowercased; empty, dot parts, other schemes, and bad characters are null', () => {
    expect(parseRemoteUrl('HTTPS://GitHub.COM/Owner/Name')).toEqual({ host: 'github.com', owner: 'Owner', name: 'Name' });
    expect(parseRemoteUrl('github.com:o/n.git')).toEqual({ host: 'github.com', owner: 'o', name: 'n' });
    expect(parseRemoteUrl('https://github.com/o/n/')).toEqual({ host: 'github.com', owner: 'o', name: 'n' });
    for (const url of ['', '   ', 'https://github.com/./n', 'https://github.com/o/..', 'git://github.com/o/n', 'http://github.com/o/n', 'https://github.com/o', 'https://github.com/o/n?x=1', 'host:/abs/path', 'https://github.com/o%20x/n', 'git@github.com:o/n/extra', 'C:\\repo\\x']) {
      expect({ url, parsed: parseRemoteUrl(url) }).toEqual({ url, parsed: null });
    }
  });
});

describe('readRepositories', () => {
  test('fetch remotes only, sorted by name, one entry per remote, unparsable ones skipped', async () => {
    const out = [
      'upstream\thttps://github.com/mattmccray/infra.git (fetch)',
      'upstream\thttps://github.com/mattmccray/infra.git (push)',
      'origin\tssh://git@localhost:222/mattm/infra.git (fetch)',
      'origin\tssh://git@localhost:222/mattm/infra.git (push)',
      'backup\t/srv/infra.git (fetch)',
      'origin\thttps://github.com/other/dupe (fetch)',
      'github\tgit@github.com:mattmccray/infra (fetch)',
      '',
    ].join('\n');
    expect(await readRepositories(answering(0, out), '/r')).toEqual([
      { remote: 'github', host: 'github.com', owner: 'mattmccray', name: 'infra' },
      { remote: 'origin', host: 'localhost:222', owner: 'mattm', name: 'infra' },
      { remote: 'upstream', host: 'github.com', owner: 'mattmccray', name: 'infra' },
    ]);
  });

  test('runs exactly `git remote -v` in the root; a failure, or a throw, is []', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git: GitRunner = async (args, { cwd }) => {
      calls.push({ args, cwd });
      return { code: 128, stdout: enc.encode('') };
    };
    expect(await readRepositories(git, '/not/a/repo')).toEqual([]);
    expect(calls).toEqual([{ args: ['remote', '-v'], cwd: '/not/a/repo' }]);
    expect(await readRepositories(async () => Promise.reject(new Error('no git')), '/r')).toEqual([]);
  });

  test('sameRepositories compares entry for entry', () => {
    const a = [{ remote: 'origin', host: 'github.com', owner: 'o', name: 'n' }];
    expect(sameRepositories(a, [{ ...a[0], remote: 'origin', host: 'github.com', owner: 'o', name: 'n' }])).toBe(true);
    expect(sameRepositories(a, [])).toBe(false);
    expect(sameRepositories(a, [{ remote: 'origin', host: 'github.com', owner: 'o', name: 'm' }])).toBe(false);
  });
});
