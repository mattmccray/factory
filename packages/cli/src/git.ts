// The CLI's git calls (docs/contract/v1.md "`job.claimed`" and "CLI"): resolving `merge.target`
// to the branch a job is based on and merges into (a fact from the system, never from the
// caller), and `abandon`'s cleanup of a job's worktree and branch.
import { BRANCH_PATTERN, CURRENT_TARGET, isTargetBranch } from '@factory/contract';

interface GitResult {
  code: number;
  out: string;
  err: string;
}

// Git reads the project's own checkout only: an inherited GIT_DIR or GIT_WORK_TREE never redirects it.
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'GIT_DIR' && k !== 'GIT_WORK_TREE') env[k] = v;
  }
  return env;
}

async function git(repo: string, args: readonly string[], what = 'merge.target'): Promise<GitResult> {
  let proc;
  try {
    proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: gitEnv() });
  } catch (e) {
    throw new Error(`${what}: cannot run git: ${e instanceof Error ? e.message : String(e)}`);
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim().split('\n')[0] ?? '' };
}

function allowed(configured: string, branch: string): string {
  if (!isTargetBranch(branch)) {
    throw new Error(`merge.target '${configured}': branch ${JSON.stringify(branch)} is not an allowed target name (want ${BRANCH_PATTERN.source}, no '..', no '.lock' suffix)`);
  }
  return branch;
}

/**
 * Resolves the configured `merge.target` in `repo` (the main checkout): `"current"` is the branch
 * its HEAD is on; any other value must name an existing `refs/heads/<name>`. Either way the branch
 * must be an allowed target name (`isTargetBranch`). Throws a one-line reason on a detached HEAD,
 * a missing branch, a disallowed name, or a repo git can't read.
 */
export async function resolveTarget(repo: string, configured: string): Promise<string> {
  if (configured === CURRENT_TARGET) {
    const r = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (r.code === 0 && r.out !== '') return allowed(configured, r.out);
    if (r.code === 1) throw new Error(`merge.target '${CURRENT_TARGET}': the checkout at ${repo} has a detached HEAD (no branch to target)`);
    throw new Error(`merge.target '${CURRENT_TARGET}': git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
  }
  allowed(configured, configured);
  const r = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${configured}`]);
  if (r.code === 0) return configured;
  if (r.code === 1) throw new Error(`merge.target '${configured}': no branch refs/heads/${configured} in ${repo}`);
  throw new Error(`merge.target '${configured}': git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
}

/**
 * Removes the worktree at `path` (relative to `repo`, e.g. `factory/.worktrees/<id>`) with
 * `git worktree remove --force`. Returns null on success, else git's one-line reason.
 */
export async function removeWorktree(repo: string, path: string): Promise<string | null> {
  const r = await git(repo, ['worktree', 'remove', '--force', path], 'abandon');
  return r.code === 0 ? null : r.err || `exit ${r.code}`;
}

/**
 * Deletes `branch` with `git branch -D` when it exists. Returns null on success (or when there was
 * no such branch), else git's one-line reason.
 */
export async function deleteBranch(repo: string, branch: string): Promise<string | null> {
  const has = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 'abandon');
  if (has.code === 1) return null;
  if (has.code !== 0) return has.err || `exit ${has.code}`;
  const r = await git(repo, ['branch', '-D', branch], 'abandon');
  return r.code === 0 ? null : r.err || `exit ${r.code}`;
}
