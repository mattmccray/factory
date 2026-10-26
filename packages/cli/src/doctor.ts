// `factory doctor` (docs/contract/v1.md "CLI", "Managed files"): validates config.json,
// verifies managed-file hashes against factory/managed.json, and notes duplicate job numbers. It reports every finding instead of
// stopping at the first, and never reads a path outside the repo.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isJobId, parseConfig, parseManifest } from '@factory/contract';
import type { Manifest } from '@factory/contract';
import { isNotFound, locate } from './paths';

export interface Finding {
  ok: boolean;
  line: string;
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

const ok = (what: string): Finding => ({ ok: true, line: `ok    ${what}` });
const bad = (what: string, why: string): Finding => ({ ok: false, line: `FAIL  ${what}: ${why}` });

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function checkConfig(root: string): Promise<Finding> {
  let text: string | null;
  try {
    text = await readText(join(root, 'config.json'));
  } catch (e) {
    return bad('config.json', firstLine(e));
  }
  if (text === null) return bad('config.json', 'missing');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('config.json', 'not valid JSON');
  }
  try {
    parseConfig(raw);
  } catch (e) {
    return bad('config.json', firstLine(e));
  }
  return ok('config.json');
}

// Reads a checked manifest path through the shared containment rule (`paths.ts`): it never reads
// a file that resolves outside the repo. Returns null when the file is missing.
async function safeRead(repo: string, rel: string): Promise<Buffer | null> {
  const at = await locate(repo, rel);
  try {
    return await readFile(at);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function checkManaged(root: string): Promise<Finding[]> {
  let text: string | null;
  try {
    text = await readText(join(root, 'managed.json'));
  } catch (e) {
    return [bad('managed.json', firstLine(e))];
  }
  if (text === null) return [{ ok: true, line: 'note  unstamped install: no managed.json, hash checks skipped' }];
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(text));
  } catch (e) {
    return [bad('managed.json', e instanceof SyntaxError ? 'not valid JSON' : firstLine(e))];
  }
  const repo = dirname(resolve(root));
  const out: Finding[] = [ok(`managed.json (version ${manifest.version})`)];
  for (const [rel, want] of Object.entries(manifest.files)) {
    try {
      const data = await safeRead(repo, rel);
      if (data === null) {
        out.push(bad(rel, 'missing'));
        continue;
      }
      const got = createHash('sha256').update(data).digest('hex');
      out.push(got === want ? ok(rel) : bad(rel, 'changed (sha256 mismatch)'));
    } catch (e) {
      out.push(bad(rel, firstLine(e)));
    }
  }
  return out;
}

// A job number held by more than one job dir is a `note`, never a failure: existing duplicates
// keep working, and renaming one would break its branch, worktree, and log. Only dirs whose names
// match the job-id pattern count.
async function checkJobNumbers(root: string): Promise<Finding[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, 'jobs'), { withFileTypes: true })).filter((d) => d.isDirectory() && isJobId(d.name)).map((d) => d.name);
  } catch (e) {
    if (isNotFound(e)) return [];
    return [bad('jobs/', firstLine(e))];
  }
  const byNumber = new Map<string, string[]>();
  for (const name of names.sort()) {
    const n = name.slice(0, 3);
    byNumber.set(n, [...(byNumber.get(n) ?? []), name]);
  }
  return [...byNumber.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([n, ids]) => ({ ok: true, line: `note: job number ${n} is used by ${ids.join(', ')}` }));
}

// `root` is the factory/ directory; manifest paths are relative to its parent (the repo root).
export async function doctor(root: string): Promise<Finding[]> {
  return [await checkConfig(root), ...(await checkManaged(root)), ...(await checkJobNumbers(root))];
}
