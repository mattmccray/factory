// A project's repositories (docs/contract/v1.md "Andon service", `repositories`): its fetch
// remotes, read with `git -C <root> remote -v` through the service's injected runner, each parsed
// into `{ host, owner, name }`. Only `https://`, `ssh://`, and scp-like `[user@]host:owner/name`
// URLs with exactly two path parts parse; a local path, a `file:` URL, a deeper path, or anything
// else is skipped. A parsed host never carries a user or a token. Git is only read; the parser is
// pure and never throws.
import type { GitRunner } from './archive';

/** One remote URL, parsed. */
export interface ParsedRemote {
  host: string; // lowercased, with its port when it has one (`localhost:222`)
  owner: string;
  name: string; // without a trailing `.git`
}

/** One entry of a project's `repositories`. */
export interface Repository extends ParsedRemote {
  remote: string; // the git remote's name (`origin`, `upstream`, …)
}

const PART = /^[A-Za-z0-9._-]+$/;
const HOST = /^[A-Za-z0-9.-]+(:[0-9]+)?$/;
// `[user@]host:path`, where the host has no slash and the path doesn't start with one.
const SCP = /^(?:[^@/:]+@)?([^@/:]+):(?!\/)(.+)$/;

const part = (s: string): boolean => PART.test(s) && s !== '.' && s !== '..';

function fromPath(host: string, path: string): ParsedRemote | null {
  const h = host.toLowerCase();
  if (!HOST.test(h) || h.startsWith('.') || h.startsWith('-')) return null;
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? '';
  const raw = parts[1] ?? '';
  const name = raw.endsWith('.git') ? raw.slice(0, -'.git'.length) : raw;
  if (!part(owner) || !part(name)) return null;
  return { host: h, owner, name };
}

/** Parses one remote URL to `{ host, owner, name }`, or null when it isn't a hosted two-part repository URL. Never throws. */
export function parseRemoteUrl(url: string): ParsedRemote | null {
  try {
    return parse(url);
  } catch {
    return null;
  }
}

function parse(url: string): ParsedRemote | null {
  const s = url.trim();
  if (s === '' || /\s/.test(s)) return null;
  const scheme = s.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (scheme !== null) {
    const kind = (scheme[1] ?? '').toLowerCase();
    if (kind !== 'https' && kind !== 'ssh') return null;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.search !== '' || u.hash !== '' || u.hostname === '') return null;
    // The path is never decoded: a `%` escape fails the part check, so an encoded path is skipped.
    // `URL` drops https's default port; ssh's (22) is dropped the same way.
    const port = kind === 'ssh' && u.port === '22' ? '' : u.port;
    return fromPath(port === '' ? u.hostname : `${u.hostname}:${port}`, u.pathname);
  }
  const scp = s.match(SCP);
  if (scp === null) return null;
  return fromPath(scp[1] ?? '', scp[2] ?? '');
}

const decoder = new TextDecoder();
const FETCH_LINE = /^(\S+)\t(\S+) \(fetch\)$/;

/**
 * The fetch remotes of the repo at `root` that parse, as `{ remote, host, owner, name }`, sorted by
 * remote name, one entry per remote. A failed git, or a root that isn't a git repo, gives `[]`.
 */
export async function readRepositories(git: GitRunner, root: string): Promise<Repository[]> {
  let out: string;
  try {
    const r = await git(['remote', '-v'], { cwd: root });
    if (r.code !== 0) return [];
    out = decoder.decode(r.stdout);
  } catch {
    return [];
  }
  const byRemote = new Map<string, Repository>();
  for (const line of out.split('\n')) {
    const m = line.trimEnd().match(FETCH_LINE);
    if (m === null) continue;
    const remote = m[1] ?? '';
    if (byRemote.has(remote)) continue;
    const parsed = parseRemoteUrl(m[2] ?? '');
    if (parsed !== null) byRemote.set(remote, { remote, ...parsed });
  }
  return [...byRemote.values()].sort((a, b) => (a.remote < b.remote ? -1 : a.remote > b.remote ? 1 : 0));
}

/** Whether two repository lists are the same, entry for entry. */
export function sameRepositories(a: readonly Repository[], b: readonly Repository[]): boolean {
  return a.length === b.length && a.every((r, i) => {
    const o = b[i];
    return o !== undefined && o.remote === r.remote && o.host === r.host && o.owner === r.owner && o.name === r.name;
  });
}
