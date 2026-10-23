// The CLI's git reads (docs/contract/v1.md "`job.claimed`"): resolving `merge.target` to the
// branch a job is based on and merges into. A fact from the system, never from the caller.
import { CURRENT_TARGET } from '@factory/contract';

interface GitResult {
  code: number;
  out: string;
  err: string;
}

async function git(repo: string, args: readonly string[]): Promise<GitResult> {
  let proc;
  try {
    proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  } catch (e) {
    throw new Error(`merge.target: cannot run git: ${e instanceof Error ? e.message : String(e)}`);
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim().split('\n')[0] ?? '' };
}

/**
 * Resolves the configured `merge.target` in `repo` (the main checkout): `"current"` is the branch
 * its HEAD is on; any other value must name an existing `refs/heads/<name>`. Throws a one-line
 * reason on a detached HEAD, a missing branch, or a repo git can't read.
 */
export async function resolveTarget(repo: string, configured: string): Promise<string> {
  if (configured === CURRENT_TARGET) {
    const r = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (r.code === 0 && r.out !== '') return r.out;
    if (r.code === 1) throw new Error(`merge.target '${CURRENT_TARGET}': the checkout at ${repo} has a detached HEAD (no branch to target)`);
    throw new Error(`merge.target '${CURRENT_TARGET}': git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
  }
  const r = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${configured}`]);
  if (r.code === 0) return configured;
  if (r.code === 1) throw new Error(`merge.target '${configured}': no branch refs/heads/${configured} in ${repo}`);
  throw new Error(`merge.target '${configured}': git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
}
