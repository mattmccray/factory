// `bun run release:push`: pushes a cut release to `origin` (docs/decisions.md, decision 14 as
// amended; brief `cli-global-install` decision 6). Root tooling run by a human as promotion's last
// step, after the `chore(factory): promote …` commit; `bun run release` itself never pushes.
// It pushes `main`, `release`, and the newest version's `vX.Y.Z` and `release-vX.Y.Z` tags in one
// `git push --atomic`, never with a force and never a `factory/*` ref. It refuses, pushing nothing,
// with a one-line reason: off `main` (or detached), a dirty tree, the newest `v*` tag without its
// `release-v*` tag (no bundle), that version already on `origin` ("nothing to push"), or
// `origin/main` (or `origin/release`) holding commits the local branch lacks (pushing would need a
// force). It reads `origin` with `git ls-remote` before pushing.
import { RELEASE_BRANCH, baseTag, releaseTag } from './release';

/** The install line printed for a pushed version. */
export const installLine = (version: string): string => `bun add -g github:mattmccray/factory#${releaseTag(version)}`;

function gitRun(repo: string, args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function git(repo: string, ...args: string[]): string {
  const r = gitRun(repo, args);
  if (r.code !== 0) throw new Error(`git ${args[0] ?? ''}: ${r.err.trim().split('\n')[0] ?? ''}`);
  return r.out;
}

const verify = (repo: string, ref: string): string | null => {
  const r = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.out.trim() : null;
};

// True when `ancestor` is a commit this repo has and it is an ancestor of `tip`.
const contains = (repo: string, tip: string, ancestor: string): boolean => gitRun(repo, ['merge-base', '--is-ancestor', ancestor, tip]).code === 0;

/** Pushes the newest cut release from `repo` to `origin`. `out` is what to print; non-zero `code` means nothing was pushed. */
export function releasePush(repo: string): { code: number; out: string } {
  const refuse = (reason: string): { code: number; out: string } => ({ code: 1, out: `release:push refused: ${reason}\n` });
  try {
    const branch = gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const on = branch.code === 0 ? branch.out.trim() : 'detached HEAD';
    if (on !== 'main') return refuse(`not on main (on ${on})`);
    if (git(repo, 'status', '--porcelain').trim() !== '') return refuse('working tree is dirty (git status --porcelain is not empty)');

    const base = baseTag(repo);
    if (base === null) return refuse('no v* release tag on main: run bun run release first');
    const tag = base.tag;
    const bundleTag = releaseTag(base.version);
    if (verify(repo, `refs/tags/${bundleTag}`) === null) return refuse(`${tag} has no ${bundleTag} tag (no bundle on ${RELEASE_BRANCH})`);
    const release = verify(repo, `refs/heads/${RELEASE_BRANCH}`);
    if (release === null) return refuse(`no local ${RELEASE_BRANCH} branch`);
    const main = verify(repo, 'refs/heads/main') ?? '';

    const refs = ['refs/heads/main', `refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}`, `refs/tags/${bundleTag}`];
    const listed = gitRun(repo, ['ls-remote', 'origin', ...refs]);
    if (listed.code !== 0) return refuse(`cannot read origin: ${listed.err.trim().split('\n')[0] ?? ''}`);
    const remote = new Map<string, string>();
    for (const line of listed.out.split('\n')) {
      const [sha, ref] = line.split('\t');
      if (sha !== undefined && ref !== undefined && sha !== '') remote.set(ref, sha);
    }
    if (remote.has(`refs/tags/${tag}`) && remote.has(`refs/tags/${bundleTag}`)) return { code: 1, out: `nothing to push: ${tag} and ${bundleTag} are already on origin\n` };
    const branches: [string, string][] = [
      ['main', main],
      [RELEASE_BRANCH, release],
    ];
    for (const [name, local] of branches) {
      const theirs = remote.get(`refs/heads/${name}`);
      if (theirs !== undefined && !contains(repo, local, theirs)) return refuse(`origin/${name} has commits the local ${name} lacks (pushing would need a force)`);
    }

    // One atomic push of exactly these four refs: every refspec is explicit and none is forced.
    const pushed = gitRun(repo, ['push', '--atomic', '--porcelain', 'origin', ...refs.map((r) => `${r}:${r}`)]);
    if (pushed.code !== 0) return { code: 1, out: `release:push failed, nothing was pushed: ${pushed.err.trim().split('\n')[0] ?? `exit ${pushed.code}`}\n` };
    const names = ['main', RELEASE_BRANCH, tag, bundleTag];
    return { code: 0, out: `${names.map((n) => `pushed ${n}`).join('\n')}\ninstall: ${installLine(base.version)}\n` };
  } catch (e) {
    return { code: 1, out: `release:push failed: ${e instanceof Error ? e.message : String(e)}\n` };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    process.stderr.write(`usage: bun run release:push (unknown: ${args.join(' ')})\n`);
    process.exit(2);
  }
  const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'pipe' });
  if (top.exitCode !== 0) {
    process.stderr.write('release:push refused: not in a git repository\n');
    process.exit(1);
  }
  const r = releasePush(top.stdout.toString().trim());
  (r.code === 0 ? process.stdout : process.stderr).write(r.out);
  process.exit(r.code);
}
