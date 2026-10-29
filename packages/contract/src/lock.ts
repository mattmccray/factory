// The CLI's `mkdir` locks and small fs helpers, shared by the job store (`store.ts`) and the epic
// store (`epicstore.ts`). Internal: not exported from the package index.
import { mkdir, rm, stat } from 'node:fs/promises';

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;

export const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
export const isExists = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Takes the `mkdir` lock at `lock`, waiting on a fresh holder and breaking one older than 30 s.
export async function acquire(lock: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (e) {
      if (!isExists(e)) throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
      } catch (s) {
        if (!isNotFound(s)) throw s;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export async function release(lock: string): Promise<void> {
  await rm(lock, { recursive: true, force: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}
