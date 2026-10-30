// `bun run promote`: the local-dev promotion in one command (docs/upgrade.md, "Self-upgrade of
// this repo"). Root tooling run by a human on `main`, after `bun run release`, never mid-job. It
// checks that `factory` runs this checkout's source (`bun run cli:link`), then runs
// `factory upgrade` and `bun factory/cli.ts doctor`, commits whatever the upgrade changed under
// `.claude/` and `factory/` as `chore(factory): promote vX.Y.Z`, and runs
// `factory service restart` so the Andon service runs the new copy. It never pushes.
// It refuses, changing nothing, off `main` (or detached), with changes outside `.claude/` and
// `factory/`, or when `factory --version` does not name this checkout as its source. Changes
// already in `.claude/` or `factory/` are taken into the promote commit with the upgrade's own.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The installed copy: the only paths the promote commit takes. */
export const INSTALLED = ['.claude', 'factory'];

export type Run = (cmd: string[], cwd: string) => { code: number; out: string; err: string };

const spawn: Run = (cmd, cwd) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

/** Paths `git status --porcelain` lists that lie outside the installed copy. */
export function outsideInstalled(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).split(' -> ').pop() ?? '')
    .filter((p) => !INSTALLED.some((dir) => p === dir || p.startsWith(`${dir}/`)));
}

/** Promotes this checkout's source into its installed copy. `run` runs every command, `log` takes progress lines. */
export function promote(repo: string, run: Run = spawn, log: (line: string) => void = () => {}): { code: number; out: string } {
  const refuse = (reason: string): { code: number; out: string } => ({ code: 1, out: `promote refused: ${reason}\n` });
  const fail = (step: string, r: { code: number; out: string; err: string }): { code: number; out: string } => ({
    code: 1,
    out: `promote failed at ${step} (exit ${r.code})\n${r.out}${r.err}`,
  });
  const git = (...args: string[]) => run(['git', '-C', repo, ...args], repo);

  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const on = branch.code === 0 ? branch.out.trim() : 'detached HEAD';
  if (on !== 'main') return refuse(`not on main (on ${on})`);
  const status = git('status', '--porcelain');
  if (status.code !== 0) return fail('git status', status);
  const outside = outsideInstalled(status.out);
  if (outside.length > 0) return refuse(`changes outside .claude/ and factory/: ${outside.join(', ')}`);

  const version = run(['factory', '--version'], repo);
  if (version.code !== 0) return refuse('`factory` did not run: run bun run cli:link, then retry');
  if (!version.out.includes(`(source: ${repo})`)) return refuse(`\`factory\` is not this checkout's source (${version.out.trim()}): run bun run cli:link, then retry`);

  log('factory upgrade');
  const upgraded = run(['factory', 'upgrade'], repo);
  if (upgraded.code !== 0) return fail('factory upgrade', upgraded);
  log('bun factory/cli.ts doctor');
  const doctor = run(['bun', 'factory/cli.ts', 'doctor'], repo);
  if (doctor.code !== 0) return fail('doctor', doctor);

  const lines: string[] = [];
  const added = git('add', '-A', '--', ...INSTALLED);
  if (added.code !== 0) return fail('git add', added);
  if (git('diff', '--cached', '--quiet').code === 0) lines.push('nothing to commit: the installed copy is already current');
  else {
    const pkg: unknown = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    const v = typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : null;
    if (v === null) return refuse('package.json has no version');
    const subject = `chore(factory): promote v${v}`;
    const committed = git('commit', '--quiet', '-m', subject);
    if (committed.code !== 0) return fail('git commit', committed);
    lines.push(`committed ${git('rev-parse', '--short', 'HEAD').out.trim()} ${subject}`);
  }

  log('factory service restart');
  const restarted = run(['factory', 'service', 'restart'], repo);
  if (restarted.code !== 0) return fail('factory service restart', restarted);
  lines.push('restarted the Andon service');
  return { code: 0, out: `${lines.join('\n')}\n` };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    process.stderr.write(`usage: bun run promote (unknown: ${args.join(' ')})\n`);
    process.exit(2);
  }
  const top = spawn(['git', 'rev-parse', '--show-toplevel'], process.cwd());
  if (top.code !== 0) {
    process.stderr.write('promote refused: not in a git repository\n');
    process.exit(1);
  }
  const r = promote(top.out.trim(), spawn, (line) => process.stdout.write(`> ${line}\n`));
  (r.code === 0 ? process.stdout : process.stderr).write(r.out);
  process.exit(r.code);
}
