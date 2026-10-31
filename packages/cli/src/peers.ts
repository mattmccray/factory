// `factory peers` (docs/contract/v1.md "CLI" → "`peers`" and "Andon peers"): the only writer of the
// machine's peers file, `$ANDON_HOME/peers.json`, the other machines' Andon services this
// machine's service follows.
//   peers list                    one URL per line, in file order, or `no peers`
//   peers add <machine|url>       resolve a machine name through `tailscale status --json`, check
//                                 the peer answers in this epic's shapes, and list it
//   peers remove <machine|url>    unlist the peer at that URL, or whose host's first label is that name
// Every write goes through the contract's `addPeer` / `removePeer` (temp file plus rename); a
// refusal is one stderr line, exit 1, and writes nothing. `add` reaches the machine through
// `ServiceHost` (`run`, `tailscale()`, `getJson` with no redirect followed, and the unit file), so
// its tests fake it. It needs no `factory/` directory in the cwd and runs no `sudo`.
import { addPeer, isMachineName, machineName, normalizePeerUrl, peerLabel, readPeers, removePeer } from '@factory/contract';
import { DEFAULT_PORT, GetJsonError, manager, recordedTailnetHost, tailscale } from './service';
import type { ServiceHost } from './service';

export const PEERS_USAGE = 'usage: peers add <machine|url> | remove <machine|url> | list';

/** How long `add` waits for each answer from a peer (the tailnet may be slow to set up a path). */
export const PEER_TIMEOUT_MS = 10_000;

export interface PeersIo {
  peers: string | undefined; // the peers file
  stdout: (line: string) => void;
  host?: () => Promise<ServiceHost>; // the machine `add` resolves and probes through
}

type Command = { kind: 'list' } | { kind: 'add'; arg: string } | { kind: 'remove'; arg: string };

function parse(rest: readonly string[]): Command {
  const [sub, ...args] = rest;
  if (sub === 'list' && args.length === 0) return { kind: 'list' };
  const arg = args[0];
  if ((sub === 'add' || sub === 'remove') && args.length === 1 && arg !== undefined && arg !== '') return { kind: sub, arg };
  throw new Error(PEERS_USAGE);
}

const isUrl = (arg: string): boolean => arg.includes('://');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

/** The tailnet peers' MagicDNS names in `tailscale status --json` (`Peer[*].DNSName`, trailing dot stripped, lowercased). */
export function tailnetPeerNames(stdout: string): string[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  const peers = v.Peer;
  if (!isRecord(peers)) return [];
  const out: string[] = [];
  for (const p of Object.values(peers)) {
    if (!isRecord(p) || typeof p.DNSName !== 'string') continue;
    const name = p.DNSName.replace(/\.$/, '').toLowerCase();
    if (name !== '') out.push(name);
  }
  return out;
}

// A machine name resolved to its peer URL through `tailscale status --json`: the first peer whose
// DNSName's first label is the name, at the default service port.
async function resolveMachine(host: ServiceHost, name: string): Promise<string> {
  const bin = await host.tailscale();
  if (bin === null) throw new Error(`peers: no tailscale CLI found, so ${name} can't be resolved; install Tailscale, or give the peer as an https:// URL`);
  const argv = tailscale.status(bin);
  const r = await host.run(argv);
  if (r.code !== 0) throw new Error(`peers: ${argv.join(' ')} failed: ${r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`}`);
  const names = tailnetPeerNames(r.stdout);
  if (names === null) throw new Error(`peers: ${argv.join(' ')} did not print a JSON object`);
  const dns = names.find((n) => n.split('.')[0] === name);
  if (dns === undefined) throw new Error(`peers: no tailnet peer named ${name} (tailscale status --json)`);
  return normalizePeerUrl(`https://${dns}:${DEFAULT_PORT}`);
}

/** This machine's name: from the unit's recorded tailnet host, else from the OS hostname. */
export async function ownMachineName(host: ServiceHost): Promise<string> {
  try {
    const text = await host.fs.read((await manager(host)).unitPath);
    const tailnet = text === null ? null : recordedTailnetHost(text);
    if (tailnet !== null) return machineName(tailnet);
  } catch {
    // no service manager here: the hostname names the machine
  }
  return machineName(host.hostname);
}

const UPGRADE = 'run factory upgrade and factory service restart on that machine';

// GETs one of a peer's endpoints; each failure is the one-line refusal naming its cause.
async function get(host: ServiceHost, url: string, path: string): Promise<unknown> {
  try {
    return await host.getJson(`${url}${path}`, PEER_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof GetJsonError) {
      if (e.kind === 'redirect') throw new Error(`peers: ${url} answered GET ${path} with a redirect (HTTP ${e.status}), which is never followed; nothing written`);
      if (e.kind === 'status' && e.status === 404 && path === '/machines') throw new Error(`peers: ${url} runs an Andon service from before peers (no GET /machines); ${UPGRADE}, then add it again`);
      throw new Error(`peers: ${url} is not an Andon service (GET ${path}: ${e.message}); nothing written`);
    }
    throw new Error(`peers: ${url} is not reachable (GET ${path}: ${message(e)}); is its Andon service installed with factory service install --tailnet?`);
  }
}

/** The machine name a `GET /machines` body reports for itself (its first entry's `name`), or null when it isn't one. */
export function reportedName(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.machines)) return null;
  const first: unknown = body.machines[0];
  if (!isRecord(first) || typeof first.name !== 'string' || !isMachineName(first.name)) return null;
  return first.name;
}

// Checks that the peer answers `GET /machines` and `GET /projects?scope=local` in this epic's
// shapes, and returns the name it reports.
async function probe(host: ServiceHost, url: string): Promise<string> {
  const machines = await get(host, url, '/machines');
  const name = reportedName(machines);
  if (name === null) throw new Error(`peers: ${url} is not an Andon service (GET /machines is not { machines: [{ name, … }] }); nothing written`);
  const projects = await get(host, url, '/projects?scope=local');
  if (!isRecord(projects) || !Array.isArray(projects.projects) || !projects.projects.every((p) => isRecord(p) && typeof p.id === 'string')) {
    throw new Error(`peers: ${url} is not an Andon service (GET /projects?scope=local is not { projects: [{ id, … }] }); nothing written`);
  }
  if (!projects.projects.every((p) => isRecord(p) && typeof p.machine === 'string' && typeof p.id === 'string' && !p.id.includes('@'))) {
    throw new Error(`peers: ${url} runs an Andon service from before peers (its projects carry no machine); ${UPGRADE}, then add it again`);
  }
  return name;
}

// The name an already-listed peer reports, or null when it doesn't answer as one.
async function listedName(host: ServiceHost, url: string): Promise<string | null> {
  try {
    return reportedName(await host.getJson(`${url}/machines`, PEER_TIMEOUT_MS));
  } catch {
    return null;
  }
}

async function add(file: string, arg: string, io: PeersIo, listed: readonly string[]): Promise<number> {
  let url: string;
  if (isUrl(arg)) url = normalizePeerUrl(arg);
  else if (isMachineName(arg.toLowerCase())) url = '';
  else throw new Error(`peers: ${JSON.stringify(arg)} is neither a machine name nor an https:// URL`);
  if (io.host === undefined) throw new Error('peers: no machine configured to reach peers through');
  const host = await io.host();
  if (url === '') url = await resolveMachine(host, arg.toLowerCase());
  if (listed.includes(url)) {
    io.stdout(`already listed: ${url}`);
    return 0;
  }
  const name = await probe(host, url);
  const own = await ownMachineName(host);
  if (name === own) throw new Error(`peers: ${url} reports this machine's own name ${name}; nothing written`);
  for (const other of listed) {
    if ((await listedName(host, other)) === name) throw new Error(`peers: ${url} reports the name ${name}, already the name of ${other}; nothing written`);
  }
  await addPeer(file, url);
  io.stdout(`added ${name} ${url}`);
  return 0;
}

async function remove(file: string, arg: string, io: PeersIo, listed: readonly string[]): Promise<number> {
  let match: string[];
  if (isUrl(arg)) {
    let norm: string | null = null;
    try {
      norm = normalizePeerUrl(arg);
    } catch {
      norm = null;
    }
    match = listed.filter((u) => u === norm);
  } else {
    const name = arg.toLowerCase();
    match = listed.filter((u) => peerLabel(u) === name);
  }
  const [url, ...more] = match;
  if (url === undefined) throw new Error(`not listed: ${arg}`);
  if (more.length > 0) throw new Error(`peers: ${arg} names more than one peer (${match.join(', ')}); remove one by its URL`);
  await removePeer(file, url);
  io.stdout(`removed ${url}`);
  return 0;
}

/** Runs `peers …` (the args after `peers`). Throws a one-line reason on a usage error, a bad peers.json, or a refusal. */
export async function peers(rest: readonly string[], io: PeersIo): Promise<number> {
  const cmd = parse(rest);
  if (io.peers === undefined) throw new Error('peers: no peers file configured');
  const file = io.peers;
  const listed = (await readPeers(file)).peers.map((p) => p.url);
  if (cmd.kind === 'list') {
    if (listed.length === 0) io.stdout('no peers');
    for (const url of listed) io.stdout(url);
    return 0;
  }
  if (cmd.kind === 'remove') return remove(file, cmd.arg, io, listed);
  return add(file, cmd.arg, io, listed);
}
