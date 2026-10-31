// The factory CLI, run from source or from the release bundle (docs/contract/v1.md "CLI"): the core
// commands (`core.ts`) plus the installer, the Andon registry command, and the version:
//   init [--force]      install the managed core into the project
//   upgrade [--force]   replace the managed core with a new render
//   projects [prune [--dry-run] | remove <path>]   list, prune, or remove Andon registry roots (projects.ts)
//   service install [--tailnet]|uninstall|start|stop|restart|status|run   the Andon service as an OS service (service.ts)
//   --version           print the release and how this CLI runs
// `run` is the whole command surface as a testable function; `main.ts` (source) and
// `release-main.ts` (the release bundle) are the process entries. They differ only in their
// origin: where `init` and `upgrade` take the installed CLI and contract from, what `--version`
// says, and which tree `service run` serves.
import { bundleTree, sourceTree } from '@factory/andon-service/entry';
import type { Tree } from '@factory/andon-service/entry';
import { VERSION } from '@factory/templates';
import { SOURCE_RELEASE, SOURCE_ROOT } from './bundle';
import type { ReleaseFiles } from './bundle';
import { USAGE as CORE_USAGE, dispatchCore, guarded } from './core';
import type { Io } from './core';
import { init, upgrade } from './install';
import { PROJECTS_USAGE, projects } from './projects';
import { SERVICE_USAGE, service } from './service';
import type { ServiceHost } from './service';

export type { Io } from './core';

/** The source and release entries' io: the core io plus the machine `service` works on, built on demand. */
export interface CliIo extends Io {
  service?: () => Promise<ServiceHost>;
}

/** How this CLI runs: from a source checkout (its root), or from the release bundle (its root and baked files). */
export type Origin = { kind: 'source'; root: string; files: ReleaseFiles } | { kind: 'release'; root: string; files: ReleaseFiles };

/** The Andon service tree `service run` serves: the source clone's, or the release bundle's. */
export const serviceTree = (origin: Origin): Tree => (origin.kind === 'source' ? sourceTree(origin.root) : bundleTree(origin.root));

/** The source CLI's origin: this checkout. */
export const SOURCE_ORIGIN: Origin = { kind: 'source', root: SOURCE_ROOT, files: SOURCE_RELEASE };

export const USAGE = {
  ...CORE_USAGE,
  init: 'usage: init [--force]',
  upgrade: 'usage: upgrade [--force]',
  version: 'usage: --version',
  projects: PROJECTS_USAGE,
  service: SERVICE_USAGE,
  // The source CLI's top-level line: the installed CLI's line plus `doctor`, the installer commands, and `--version`.
  source: `${CORE_USAGE.all} | doctor | init [--force] | upgrade [--force] | --version`,
};

/** `factory --version`'s line: `factory <version> (source: <clone path>)` or `factory <version> (release)`. */
export function versionLine(origin: Origin): string {
  return `factory ${VERSION} (${origin.kind === 'source' ? `source: ${origin.root}` : 'release'})`;
}

// `init` and `upgrade` take only `--force`; anything else is a usage error.
function parseForce(rest: readonly string[], usage: string): boolean {
  if (rest.length === 0) return false;
  if (rest.length === 1 && rest[0] === '--force') return true;
  throw new Error(usage);
}

// Returns the exit code: 0 on success, 1 on any rejection or usage error (one stderr line).
// `init`, `upgrade`, `projects`, `service`, and `--version` dispatch before any config read, as `doctor` does.
// `projects` works on the machine's Andon registry and `service` on the machine's service manager,
// not on a project, so neither needs a factory/ directory.
export function run(argv: readonly string[], io: CliIo, origin: Origin = SOURCE_ORIGIN): Promise<number> {
  return guarded(io, async () => {
    const [cmd, ...rest] = argv;
    if (cmd === '--version') {
      if (rest.length > 0) throw new Error(USAGE.version);
      io.stdout(versionLine(origin));
      return 0;
    }
    if (cmd === 'init') {
      await init(io.root, { force: parseForce(rest, USAGE.init), stdout: io.stdout, registry: io.registry, from: origin.files });
      return 0;
    }
    if (cmd === 'upgrade') {
      await upgrade(io.root, { force: parseForce(rest, USAGE.upgrade), stdout: io.stdout, from: origin.files });
      return 0;
    }
    if (cmd === 'projects') return projects(rest, { registry: io.registry, stdout: io.stdout });
    if (cmd === 'service') {
      if (io.service === undefined) throw new Error('service: no service host configured');
      return service(rest, await io.service(), serviceTree(origin));
    }
    return dispatchCore(argv, io, USAGE.source);
  });
}
