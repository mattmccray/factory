// `factory/managed.json` (docs/contract/v1.md "Managed files"): the managed-file manifest that
// `factory doctor` verifies. Pure and dependency-free: parsing and path rules only, no I/O.

export interface Manifest {
  schema: 'factory/v1';
  version: string;
  files: Record<string, string>; // repo-relative path -> sha256 hex
}

const SCHEMA = 'factory/v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A manifest path is repo-relative, `/`-separated, and has no `..` segment. Returns the reason a
// path is unsafe, or null when it is fine. Callers still confirm containment after symlinks.
export function checkManifestPath(p: string): string | null {
  if (p === '') return 'empty path';
  if (p.includes('\0')) return 'path contains a NUL byte';
  if (p.includes('\\')) return 'path must use forward slashes';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'path must be repo-relative, not absolute';
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
