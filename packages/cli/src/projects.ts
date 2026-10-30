// `factory projects` (docs/contract/v1.md "CLI" and "Andon registry"), source CLI only: lists the
// roots registered in the machine's Andon registry with their state, prunes the dead ones, and
// removes one root whatever its state. `init` stays the only way to register a root.
//   projects                     <state>  <root>, one line per root, in registry order
//   projects prune [--dry-run]   removes the `missing` and `not a factory project` roots
//   projects remove <path>       unregisters one root
// The state and removable-volume checks take an injected `Probe`, so tests need no real mounts.
// Every write goes through `removeRoot` (temp file plus rename); a refusal writes nothing.
import { stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { readRegistry, removeRoot } from '@factory/contract';

export const PROJECTS_USAGE = 'usage: projects [prune [--dry-run] | remove <path>]';

export type RootState = 'ok' | 'missing' | 'not a factory project';

export interface PathInfo {
  dev: number; // the device id of the filesystem the path is on
  dir: boolean;
}

/** Looks up a path (following symlinks): its info, or null when it does not exist. */
export type Probe = (path: string) => Promise<PathInfo | null>;

const code = (e: unknown): unknown => (typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined);

/** The real filesystem probe. A missing path (or one under a non-directory) is null; any other error throws. */
export const fsProbe: Probe = async (path) => {
  try {
    const s = await stat(path);
    return { dev: s.dev, dir: s.isDirectory() };
  } catch (e) {
    const c = code(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return null;
    throw e;
  }
};

/** A root's state: `missing` (no such path), `not a factory project` (no `factory/` directory), or `ok`. */
export async function rootState(root: string, probe: Probe): Promise<RootState> {
  if ((await probe(root)) === null) return 'missing';
  const factory = await probe(join(root, 'factory'));
  return factory !== null && factory.dir ? 'ok' : 'not a factory project';
}

// The mount parents of removable volumes: macOS `/Volumes/<name>`, Linux `/media/…`,
// `/run/media/…`, and `/mnt/<name>`.
const VOLUME_PREFIXES = ['/Volumes', '/media', '/run/media', '/mnt'];

/** The removable-volume prefix `root` is under (strictly below it), or null when it is under none. */
export function volumePrefix(root: string): string | null {
  const norm = resolve(root);
  return VOLUME_PREFIXES.find((p) => norm.startsWith(p + sep) && norm.length > p.length + 1) ?? null;
}

/**
 * Whether `root` is on a removable volume that is not mounted: it is under a volume prefix and no
 * directory between that prefix and the root (the root included) is a mount point. A directory is
 * a mount point when it exists and its device id differs from its parent's. False for a root
 * under no prefix.
 */
export async function volumeUnmounted(root: string, probe: Probe): Promise<boolean> {
  const prefix = volumePrefix(root);
  if (prefix === null) return false;
  let dir = resolve(root);
  while (dir !== prefix) {
    const here = await probe(dir);
    if (here !== null) {
      const parent = await probe(dirname(dir));
      if (parent !== null && parent.dev !== here.dev) return false;
    }
    dir = dirname(dir);
  }
  return true;
}

export interface ProjectsIo {
  registry: string | undefined; // the Andon registry file
  stdout: (line: string) => void;
  cwd?: string; // resolves a relative `remove <path>`; default process.cwd()
  probe?: Probe; // default fsProbe
}

type Command = { kind: 'list' } | { kind: 'prune'; dryRun: boolean } | { kind: 'remove'; path: string };

function parse(rest: readonly string[]): Command {
  const [sub, ...args] = rest;
  if (sub === undefined) return { kind: 'list' };
  if (sub === 'prune') {
    if (args.length === 0) return { kind: 'prune', dryRun: false };
    if (args.length === 1 && args[0] === '--dry-run') return { kind: 'prune', dryRun: true };
  }
  if (sub === 'remove' && args.length === 1 && args[0] !== undefined && args[0] !== '') return { kind: 'remove', path: args[0] };
  throw new Error(PROJECTS_USAGE);
}

const NONE = 'no projects registered';

/** Runs `projects …` (the args after `projects`). Throws a one-line reason on a usage error or a bad registry. */
export async function projects(rest: readonly string[], io: ProjectsIo): Promise<number> {
  const cmd = parse(rest);
  if (io.registry === undefined) throw new Error('projects: no Andon registry configured');
  const file = io.registry;
  const probe = io.probe ?? fsProbe;
  const registry = await readRegistry(file);

  if (cmd.kind === 'remove') {
    const root = resolve(io.cwd ?? process.cwd(), cmd.path);
    if (!registry.projects.some((p) => p.root === root)) {
      io.stdout(`not registered: ${root}`);
      return 0;
    }
    await removeRoot(file, root);
    io.stdout(`removed ${root}`);
    return 0;
  }

  if (registry.projects.length === 0) {
    io.stdout(NONE);
    return 0;
  }
  // Every root is checked before anything is written, so a probe failure writes nothing.
  const checked: { root: string; state: RootState; unmounted: boolean }[] = [];
  for (const { root } of registry.projects) {
    checked.push({ root, state: await rootState(root, probe), unmounted: await volumeUnmounted(root, probe) });
  }

  if (cmd.kind === 'list') {
    for (const c of checked) io.stdout(`${c.state}  ${c.root}${c.unmounted ? '  (volume not mounted)' : ''}`);
    return 0;
  }

  let acted = false;
  for (const c of checked) {
    if (c.state === 'ok') continue;
    acted = true;
    if (c.unmounted) {
      io.stdout(`skipped ${c.root}: volume not mounted`);
    } else if (cmd.dryRun) {
      io.stdout(`would remove ${c.root} (${c.state})`);
    } else {
      await removeRoot(file, c.root);
      io.stdout(`removed ${c.root} (${c.state})`);
    }
  }
  if (!acted) io.stdout('nothing to prune');
  return 0;
}
