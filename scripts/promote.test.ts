import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitIn } from '../packages/cli/src/gitrepo';
import { type Run, outsideInstalled, promote } from './promote';

// A temp repo on `main`; `factory` and `bun` are faked, git is real.
let repo: string;
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'factory-promote-')));
  gitIn(repo, 'init', '--quiet', '--initial-branch=main');
  await put('package.json', '{ "name": "factory", "version": "0.3.0" }\n');
  await put('factory/managed.json', '{ "version": "0.2.0" }\n');
  await put('.claude/skills/factory/SKILL.md', 'v0.2.0\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '--quiet', '-m', 'chore: seed');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
}

const ok = { code: 0, out: '', err: '' };
/** Fakes `factory` and `bun` (the test writes the upgrade's changes itself), recording each faked command. */
function fake(opts: { source?: string; fail?: string } = {}): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = (cmd, cwd) => {
    if (cmd[0] === 'git') {
      const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...cmd.slice(1)], { cwd, stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    }
    const line = cmd.join(' ');
    calls.push(line);
    if (line === opts.fail) return { code: 1, out: '', err: 'boom\n' };
    if (line === 'factory --version') return { ...ok, out: `factory 0.3.0 (source: ${opts.source ?? repo})\n` };
    return ok;
  };
  return { run, calls };
}

describe('outsideInstalled', () => {
  test('keeps only paths outside .claude/ and factory/', () => {
    expect(outsideInstalled(' M factory/CONTRACT.md\n M .claude/agents/x.md\n?? scripts/a.ts\nR  old.md -> docs/new.md\n M factoryish.txt\n')).toEqual(['scripts/a.ts', 'docs/new.md', 'factoryish.txt']);
  });
});

describe('promote', () => {
  test('upgrades, checks, commits only the installed copy, then restarts the service', async () => {
    await put('factory/managed.json', '{ "version": "0.3.0" }\n');
    await put('.claude/skills/factory/SKILL.md', 'v0.3.0\n');
    const f = fake();
    const r = promote(repo, f.run);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual(['factory --version', 'factory upgrade', 'bun factory/cli.ts doctor', 'factory service restart']);
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore(factory): promote v0.3.0');
    expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['.claude/skills/factory/SKILL.md', 'factory/managed.json']);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
  });

  test('with nothing changed, commits nothing and still restarts', () => {
    const f = fake();
    const r = promote(repo, f.run);
    expect(r).toEqual({ code: 0, out: 'nothing to commit: the installed copy is already current\nrestarted the Andon service\n' });
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore: seed');
  });

  test('refuses off main, with changes outside the installed copy, or a foreign factory', async () => {
    gitIn(repo, 'checkout', '--quiet', '-b', 'topic');
    expect(promote(repo, fake().run).out).toBe('promote refused: not on main (on topic)\n');
    gitIn(repo, 'checkout', '--quiet', 'main');

    const foreign = fake({ source: '/elsewhere' });
    expect(promote(repo, foreign.run).out).toStartWith("promote refused: `factory` is not this checkout's source");
    expect(foreign.calls).toEqual(['factory --version']);

    await put('docs/note.md', 'x\n');
    const f = fake();
    expect(promote(repo, f.run).out).toBe('promote refused: changes outside .claude/ and factory/: docs/\n');
    expect(f.calls).toEqual([]);
  });

  test('stops at a failing doctor: no commit, no restart', async () => {
    await put('factory/managed.json', '{ "version": "0.3.0" }\n');
    const f = fake({ fail: 'bun factory/cli.ts doctor' });
    const r = promote(repo, f.run);
    expect(r.code).toBe(1);
    expect(r.out).toStartWith('promote failed at doctor (exit 1)');
    expect(f.calls).not.toContain('factory service restart');
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore: seed');
  });
});
