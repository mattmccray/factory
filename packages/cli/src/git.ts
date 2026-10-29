// The CLI's git calls (docs/contract/v1.md "`job.claimed`" and "CLI"): resolving `merge.target`
// to the branch a job is based on and merges into (a fact from the system, never from the
// caller), `abandon`'s cleanup of a job's worktree and branch, and the guarded runner `archive.ts`
// builds on.
import { BRANCH_PATTERN, CURRENT_TARGET, isTargetBranch } from '@factory/contract';

export interface GitResult {
  code: number;
  out: string; // stdout, trimmed
  raw: string; // stdout as git wrote it (NUL-separated output, blob bytes)
  err: string; // stderr's first line
}

// Variables that would point git at another repo, index, or object store than the one asked for.
const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR'];

// Git reads the project's own checkout only: an inherited GIT_DIR, GIT_WORK_TREE, index, or
// object directory never redirects it. `extra` is set on top, by the caller, on purpose.
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !REDIRECTS.includes(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

export interface GitOptions {
  what?: string; // names the caller in a can't-run-git reason
  input?: string; // stdin; none when absent
  env?: Record<string, string>; // set on top of the guarded environment
}

/** Runs `git -C <repo> <args>` without a shell; never throws on a non-zero exit. */
export async function runGit(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<GitResult> {
  const what = opts.what ?? 'git';
  let proc;
  try {
    proc = Bun.spawn(['git', '-C', repo, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: opts.input === undefined ? 'ignore' : new Blob([opts.input]),
      env: gitEnv(opts.env),
    });
  } catch (e) {
    throw new Error(`${what}: cannot run git: ${e instanceof Error ? e.message : String(e)}`);
  }
  const [raw, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: raw.trim(), raw, err: err.trim().split('\n')[0] ?? '' };
}

const git = (repo: string, args: readonly string[], what = 'merge.target'): Promise<GitResult> => runGit(repo, args, { what });

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

/** Whether `refs/heads/<branch>` exists in `repo`. Throws a one-line reason when git fails. */
export async function branchExists(repo: string, branch: string, what = 'epic'): Promise<boolean> {
  const r = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], what);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`${what}: git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
}

/**
 * Creates `branch` from `from` and checks it out in a new worktree at `path` (relative to `repo`),
 * with `git worktree add -b`. Returns null on success, else git's one-line reason.
 */
export async function addWorktree(repo: string, path: string, branch: string, from: string): Promise<string | null> {
  const r = await git(repo, ['worktree', 'add', '--quiet', '-b', branch, path, from], 'epic start');
  return r.code === 0 ? null : r.err || `exit ${r.code}`;
}
