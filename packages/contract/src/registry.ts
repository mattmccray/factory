// The Andon machine registry (docs/contract/v1.md "Andon registry"): one JSON file per machine,
// `$ANDON_HOME/projects.json` (default `~/.andon/projects.json`), listing registered project
// roots. `factory init` adds to it and the Andon agent reads it. Parsing is strict; a write is a
// temp file plus rename, so a reader never sees a partial file.
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface RegistryProject {
  root: string; // absolute project (repo) root
}

export interface Registry {
  schema: 'factory/v1';
  projects: RegistryProject[];
}

const SCHEMA = 'factory/v1';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';

/** The registry file for an `ANDON_HOME` value: `<home>/projects.json`, default `~/.andon`. */
export function registryPath(andonHome: string | undefined): string {
  return join(andonHome !== undefined && andonHome !== '' ? andonHome : join(homedir(), '.andon'), 'projects.json');
}

/** Returns why `root` cannot be registered, or null when it is fine. */
export function checkRoot(root: string): string | null {
  if (root === '') return 'root is empty';
  if (root.includes('\0')) return 'root contains a NUL byte';
  if (!isAbsolute(root)) return `root ${JSON.stringify(root)} must be an absolute path`;
  return null;
}

/** Parses a registry file's JSON. Unknown keys, a wrong schema, or a bad root throw a one-line reason. */
export function parseRegistry(raw: unknown): Registry {
  if (!isRecord(raw)) throw new Error('registry: must be a JSON object');
  const extra = Object.keys(raw).filter((k) => k !== 'schema' && k !== 'projects');
  if (extra.length) throw new Error(`registry: unknown key ${extra.map((k) => `'${k}'`).join(', ')}`);
  if (raw.schema !== SCHEMA) throw new Error(`registry: schema must be "${SCHEMA}"`);
  if (!Array.isArray(raw.projects)) throw new Error('registry: projects must be an array');
  const projects: RegistryProject[] = [];
  const seen = new Set<string>();
  for (const [i, p] of raw.projects.entries()) {
    if (!isRecord(p)) throw new Error(`registry: projects[${i}] must be an object`);
    const pExtra = Object.keys(p).filter((k) => k !== 'root');
    if (pExtra.length) throw new Error(`registry: projects[${i}]: unknown key ${pExtra.map((k) => `'${k}'`).join(', ')}`);
    if (typeof p.root !== 'string') throw new Error(`registry: projects[${i}].root must be a string`);
    const why = checkRoot(p.root);
    if (why !== null) throw new Error(`registry: projects[${i}]: ${why}`);
    if (resolve(p.root) !== p.root) throw new Error(`registry: projects[${i}]: root ${JSON.stringify(p.root)} must be normalized (${JSON.stringify(resolve(p.root))})`);
    if (seen.has(p.root)) throw new Error(`registry: projects[${i}]: root ${JSON.stringify(p.root)} is listed twice`);
    seen.add(p.root);
    projects.push({ root: p.root });
  }
  return { schema: SCHEMA, projects };
}

/** Reads and parses the registry. A missing file is an empty registry. */
export async function readRegistry(path: string): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return { schema: SCHEMA, projects: [] };
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('registry: not valid JSON');
  }
  return parseRegistry(raw);
}

export const registryText = (r: Registry): string => `${JSON.stringify(r, null, 2)}\n`;

async function writeRegistry(path: string, r: Registry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(registryText(r), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Adds an absolute root (normalized). A root already listed changes nothing and writes nothing. */
export async function addRoot(path: string, root: string): Promise<Registry> {
  const why = checkRoot(root);
  if (why !== null) throw new Error(`registry: ${why}`);
  const norm = resolve(root);
  const current = await readRegistry(path);
  if (current.projects.some((p) => p.root === norm)) return current;
  const next: Registry = { schema: SCHEMA, projects: [...current.projects, { root: norm }] };
  await writeRegistry(path, next);
  return next;
}

/** Removes a root. A root not listed changes nothing and writes nothing. */
export async function removeRoot(path: string, root: string): Promise<Registry> {
  const why = checkRoot(root);
  if (why !== null) throw new Error(`registry: ${why}`);
  const norm = resolve(root);
  const current = await readRegistry(path);
  if (!current.projects.some((p) => p.root === norm)) return current;
  const next: Registry = { schema: SCHEMA, projects: current.projects.filter((p) => p.root !== norm) };
  await writeRegistry(path, next);
  return next;
}
