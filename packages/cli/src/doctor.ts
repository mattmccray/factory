// `factory doctor` (docs/contract/v1.md "CLI", "Managed files"): validates config.json and
// verifies managed-file hashes against factory/managed.json. It reports every finding instead of
// stopping at the first, and never reads a path outside the repo.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseConfig } from '@factory/contract';

export interface Finding {
  ok: boolean;
  line: string;
}

export interface Manifest {
  schema: 'factory/v1';
  version: string;
  files: Record<string, string>;
}

const SCHEMA = 'factory/v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

const ok = (what: string): Finding => ({ ok: true, line: `ok    ${what}` });
const bad = (what: string, why: string): Finding => ({ ok: false, line: `FAIL  ${what}: ${why}` });

// A manifest path is repo-relative, forward-slash separated, and stays inside the repo.
export function checkManifestPath(p: string): string | null {
  if (p === '') return 'empty path';
  if (p.includes('\0')) return 'path contains a NUL byte';
  if (p.includes('\\')) return 'path must use forward slashes';
  if (isAbsolute(p) || p.startsWith('/')) return 'path must be repo-relative, not absolute';
  if (p.split('/').some((seg) => seg === '..')) return "path must not contain '..'";
  return null;
}

export function parseManifest(raw: unknown): Manifest {
  if (!isRecord(raw)) throw new Error('must be a JSON object');
  const extra = Object.keys(raw).filter((k) => !['schema', 'version', 'files'].includes(k));
  if (extra.length) throw new Error(`unknown key ${extra.map((k) => `'${k}'`).join(', ')}`);
  if (raw.schema !== SCHEMA) throw new Error(`schema must be "${SCHEMA}"`);
  if (typeof raw.version !== 'string' || raw.version === '') throw new Error('version must be a non-empty string');
  if (!isRecord(raw.files)) throw new Error('files must be an object');
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(raw.files)) {
    const why = checkManifestPath(path);
    if (why !== null) throw new Error(`${JSON.stringify(path)}: ${why}`);
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) throw new Error(`${JSON.stringify(path)}: hash must be 64 lowercase hex characters (sha256)`);
    files[path] = hash;
  }
  return { schema: SCHEMA, version: raw.version, files };
}

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

// Resolves a checked manifest path and confirms, after following symlinks, that it is still
// inside the repo. Returns null when the file is missing.
async function safeRead(repo: string, rel: string): Promise<Buffer | null> {
  const repoReal = await realpath(repo);
  let real: string;
  try {
    real = await realpath(resolve(repo, rel));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  const back = relative(repoReal, real);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error('resolves outside the repo');
  }
  return readFile(real);
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

// `root` is the factory/ directory; manifest paths are relative to its parent (the repo root).
export async function doctor(root: string): Promise<Finding[]> {
  return [await checkConfig(root), ...(await checkManaged(root))];
}
