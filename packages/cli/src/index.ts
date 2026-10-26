// The factory CLI from source (docs/contract/v1.md "CLI"): the core commands (`core.ts`) plus the
// installer, which runs only from source:
//   init [--force]      install the managed core into the project
//   upgrade [--force]   replace the managed core with a new render
// `run` is the whole command surface as a testable function; `main.ts` is the process entry.
import { USAGE as CORE_USAGE, dispatchCore, guarded } from './core';
import type { Io } from './core';
import { init, upgrade } from './install';

export type { Io } from './core';

export const USAGE = {
  ...CORE_USAGE,
  init: 'usage: init [--force]',
  upgrade: 'usage: upgrade [--force]',
  // The source CLI's top-level line: the installed CLI's line plus `doctor` and the installer commands.
  source: `${CORE_USAGE.all} | doctor | init [--force] | upgrade [--force]`,
};

// `init` and `upgrade` take only `--force`; anything else is a usage error.
function parseForce(rest: readonly string[], usage: string): boolean {
  if (rest.length === 0) return false;
  if (rest.length === 1 && rest[0] === '--force') return true;
  throw new Error(usage);
}

// Returns the exit code: 0 on success, 1 on any rejection or usage error (one stderr line).
// `init` and `upgrade` dispatch before any config read, as `doctor` does.
export function run(argv: readonly string[], io: Io): Promise<number> {
  return guarded(io, async () => {
    const [cmd, ...rest] = argv;
    if (cmd === 'init') {
      await init(io.root, { force: parseForce(rest, USAGE.init), stdout: io.stdout, registry: io.registry });
      return 0;
    }
    if (cmd === 'upgrade') {
      await upgrade(io.root, { force: parseForce(rest, USAGE.upgrade), stdout: io.stdout });
      return 0;
    }
    return dispatchCore(argv, io, USAGE.source);
  });
}
