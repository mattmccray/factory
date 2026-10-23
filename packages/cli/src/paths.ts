// The one containment rule for repo-relative managed paths, shared by `doctor` (which reads them)
// and the installer (which writes and deletes them): docs/contract/v1.md "Managed files".
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { checkManifestPath } from '@factory/contract';

export const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';

function assertInside(repoReal: string, p: string): void {
  const back = relative(repoReal, p);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error('resolves outside the repo');
  }
}

/**
 * Locates a repo-relative managed path. It must pass `checkManifestPath`; every existing ancestor
 * directory is resolved through symlinks and must stay inside the repo; and when the path itself
 * exists (or is a symlink to something that exists), its real target must stay inside too.
 * Returns the path with its existing ancestors resolved, which is where to read, write, or unlink.
 * Throws a one-line reason (without the path) otherwise.
 */
export async function locate(repo: string, rel: string): Promise<string> {
  const why = checkManifestPath(rel);
  if (why !== null) throw new Error(why);
  const repoReal = await realpath(repo);
  const abs = resolve(repoReal, rel);
  const rest = [basename(abs)];
  let dir = dirname(abs);
  let dirReal: string | null = null;
  while (dirReal === null) {
    try {
      dirReal = await realpath(dir);
    } catch (e) {
      if (!isNotFound(e) || dirname(dir) === dir) throw e;
      rest.unshift(basename(dir));
      dir = dirname(dir);
    }
  }
  const at = join(dirReal, ...rest);
  assertInside(repoReal, at);
  try {
    assertInside(repoReal, await realpath(at));
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  return at;
}

// Overlay and runtime state the installer must never write or delete, whatever a manifest lists
// (CLAUDE.md "Source and state"; v1.md "Role overlays"). Compared case-insensitively after
// normalizing, so `factory/./Config.json` on a case-insensitive disk is still refused.
const PROTECTED = [
  '.git',
  'factory/config.json',
  'factory/managed.json',
  'factory/roles',
  'factory/backlog.md',
  'factory/briefs',
  'factory/jobs',
  'factory/.lock',
  'factory/.worktrees',
];

/** Returns why the installer may not touch `rel`, or null when it may. */
export function protectedReason(rel: string): string | null {
  const norm = posix.normalize(rel).replace(/\/+$/, '').toLowerCase();
  if (norm === '.' || norm === '' || norm === '..' || norm.startsWith('../')) return 'not a file inside the repo';
  const hit = PROTECTED.find((p) => norm === p || norm.startsWith(`${p}/`));
  return hit === undefined ? null : `is overlay, runtime state, or VCS data (${hit}), never a managed file`;
}
