// Closing a job for good (docs/contract/v1.md "CLI", `abandon`), shared by `abandon <id>` and
// `epic abandon`: logs `job.abandoned` (the transition check runs under the per-job lock), then
// removes the job's worktree and, when asked, its branch. The event is logged before cleanup, as
// `job.merged` is, so git and the board can't disagree about whether the job is closed.
import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { appendEvent, isJobId, parseEventInput } from '@factory/contract';
import type { JobSnapshot } from '@factory/contract';
import { deleteBranch, removeWorktree } from './git';
import { isNotFound } from './paths';

export const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
};

export interface AbandonJob {
  id: string;
  reason: string;
  force: boolean;
  deleteBranch: boolean;
}

/**
 * Abandons one job under `root` (the factory/ directory). A rejected event throws and touches
 * neither git nor the job. Returns the new snapshot and what cleanup left behind (empty: none).
 */
export async function abandonJob(root: string, args: AbandonJob): Promise<{ snap: JobSnapshot; left: string[] }> {
  if (!isJobId(args.id)) throw new Error(`job id '${args.id}' must match ^\\d{3}-[a-z0-9-]+$`);
  const input = parseEventInput('job.abandoned', { reason: args.reason });
  const snap = await appendEvent(root, args.id, input, undefined, { force: args.force });

  const repo = dirname(resolve(root));
  const branch = `factory/${args.id}`;
  const worktree = relative(repo, join(resolve(root), '.worktrees', args.id));
  const left: string[] = [];
  if (await isDir(join(repo, worktree))) {
    const why = await removeWorktree(repo, worktree);
    if (why !== null) left.push(`worktree ${worktree} (${why})`);
  }
  if (args.deleteBranch) {
    if (snap.branch !== branch) left.push(`branch ${snap.branch} (not ${branch}; not deleted)`);
    else if (left.length > 0) left.push(`branch ${branch} (its worktree is still there)`);
    else {
      const why = await deleteBranch(repo, branch);
      if (why !== null) left.push(`branch ${branch} (${why})`);
    }
  }
  return { snap, left };
}
