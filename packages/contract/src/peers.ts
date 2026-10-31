// The Andon peers file (docs/contract/v1.md "Andon peers"): one JSON file per machine,
// `$ANDON_HOME/peers.json` (default `~/.andon/peers.json`), beside the registry, listing the other
// machines' Andon services this machine's service follows (a hub). `factory peers add` and
// `remove` write it; the Andon service only reads and watches it. It copies the registry's rules:
// a strict parse with one-line `peers:` reasons, a missing file is an empty list, and a write is a
// temp file plus rename, with no write for an add or remove that changes nothing.
// The machine name (docs/contract/v1.md "Andon service") is derived here too, so the service and
// the CLI derive it the same way.
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface Peer {
  url: string; // a normalized `https:` origin: `https://<host>[:<port>]`, lowercase
}

export interface Peers {
  schema: 'factory/v1';
  peers: Peer[];
}

const SCHEMA = 'factory/v1';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';

/** The peers file for an `ANDON_HOME` value: `<home>/peers.json`, default `~/.andon`. */
export function peersPath(andonHome: string | undefined): string {
  return join(andonHome !== undefined && andonHome !== '' ? andonHome : join(homedir(), '.andon'), 'peers.json');
}

/** A machine name: lowercase letters, digits, and inner `-` only (never `@`, `.`, or empty). */
export const MACHINE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether `name` is a machine name. */
export const isMachineName = (name: string): boolean => MACHINE_NAME.test(name);

/**
 * The machine name for a host name: its first label, lowercased, with every character outside
 * `[a-z0-9-]` made `-` and leading and trailing `-` trimmed; `local` when nothing is left. A
 * tailnet host `studio.manticore-hue.ts.net` is `studio`; a hostname `Rocinante.local` is
 * `rocinante`. The result never contains `@`.
 */
export function machineName(host: string): string {
  const label = (host.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return label === '' ? 'local' : label;
}

/**
 * Normalizes a peer URL to `https://<host>[:<port>]`, lowercase. Throws a one-line `peers:` reason
 * when it isn't an `https:` origin: another scheme, userinfo, a path other than `/`, a query, or a
 * fragment.
 */
export function normalizePeerUrl(raw: string): string {
  const shown = JSON.stringify(raw);
  if (/[\s\0]/.test(raw)) throw new Error(`peers: ${shown} must not contain whitespace or NUL`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`peers: ${shown} is not a URL; give an https://<host>[:<port>] URL`);
  }
  if (u.protocol !== 'https:') throw new Error(`peers: ${shown} must be an https:// URL`);
  if (u.username !== '' || u.password !== '') throw new Error(`peers: ${shown} must not carry a user or password`);
  if (u.pathname !== '/' && u.pathname !== '') throw new Error(`peers: ${shown} must have no path`);
  if (u.search !== '' || raw.includes('?')) throw new Error(`peers: ${shown} must have no query`);
  if (u.hash !== '' || raw.includes('#')) throw new Error(`peers: ${shown} must have no fragment`);
  if (u.hostname === '') throw new Error(`peers: ${shown} has no host`);
  return `https://${u.host}`.toLowerCase();
}

/** The machine label of a peer URL: its host's first label (`studio` for `https://studio.manticore-hue.ts.net:8766`). */
export function peerLabel(url: string): string {
  try {
    return (new URL(url).hostname.split('.')[0] ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/** Parses a peers file's JSON. Unknown keys, a wrong schema, or a bad URL throw a one-line `peers:` reason. */
export function parsePeers(raw: unknown): Peers {
  if (!isRecord(raw)) throw new Error('peers: must be a JSON object');
  const extra = Object.keys(raw).filter((k) => k !== 'schema' && k !== 'peers');
  if (extra.length) throw new Error(`peers: unknown key ${extra.map((k) => `'${k}'`).join(', ')}`);
  if (raw.schema !== SCHEMA) throw new Error(`peers: schema must be "${SCHEMA}"`);
  if (!Array.isArray(raw.peers)) throw new Error('peers: peers must be an array');
  const peers: Peer[] = [];
  const seen = new Set<string>();
  for (const [i, p] of raw.peers.entries()) {
    if (!isRecord(p)) throw new Error(`peers: peers[${i}] must be an object`);
    const pExtra = Object.keys(p).filter((k) => k !== 'url');
    if (pExtra.length) throw new Error(`peers: peers[${i}]: unknown key ${pExtra.map((k) => `'${k}'`).join(', ')}`);
    if (typeof p.url !== 'string') throw new Error(`peers: peers[${i}].url must be a string`);
    let norm: string;
    try {
      norm = normalizePeerUrl(p.url);
    } catch (e) {
      throw new Error(`peers: peers[${i}]: ${(e instanceof Error ? e.message : String(e)).replace(/^peers: /, '')}`);
    }
    if (norm !== p.url) throw new Error(`peers: peers[${i}]: url ${JSON.stringify(p.url)} must be normalized (${JSON.stringify(norm)})`);
    if (seen.has(p.url)) throw new Error(`peers: peers[${i}]: url ${JSON.stringify(p.url)} is listed twice`);
    seen.add(p.url);
    peers.push({ url: p.url });
  }
  return { schema: SCHEMA, peers };
}

/** Reads and parses the peers file. A missing file is an empty list. */
export async function readPeers(path: string): Promise<Peers> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return { schema: SCHEMA, peers: [] };
    throw new Error(`peers: cannot read ${path}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('peers: not valid JSON');
  }
  return parsePeers(raw);
}

export const peersText = (p: Peers): string => `${JSON.stringify(p, null, 2)}\n`;

async function writePeers(path: string, p: Peers): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(peersText(p), 'utf8');
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

/** Adds a peer URL (normalized). A URL already listed changes nothing and writes nothing. */
export async function addPeer(path: string, url: string): Promise<Peers> {
  const norm = normalizePeerUrl(url);
  const current = await readPeers(path);
  if (current.peers.some((p) => p.url === norm)) return current;
  const next: Peers = { schema: SCHEMA, peers: [...current.peers, { url: norm }] };
  await writePeers(path, next);
  return next;
}

/** Removes a peer URL (normalized). A URL not listed changes nothing and writes nothing. */
export async function removePeer(path: string, url: string): Promise<Peers> {
  const norm = normalizePeerUrl(url);
  const current = await readPeers(path);
  if (!current.peers.some((p) => p.url === norm)) return current;
  const next: Peers = { schema: SCHEMA, peers: current.peers.filter((p) => p.url !== norm) };
  await writePeers(path, next);
  return next;
}
