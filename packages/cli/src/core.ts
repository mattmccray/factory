// The factory CLI's core commands — the only writer of job state (docs/contract/v1.md "CLI").
//   event <id> <type> [field=value …]
//   rebuild <id> | --all
//   show <id>
//   doctor
// This is everything the installed, self-contained `factory/cli.ts` carries (`installed.ts`).
// The source CLI (`index.ts`) adds `init` and `upgrade` on top.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendEvent, formatShow, parseConfig, parseEventInput, parseFields, project, readLog, rebuild } from '@factory/contract';
import { doctor } from './doctor';

export interface Io {
  root: string; // the factory/ directory
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  registry?: string; // the Andon registry file `init` registers in (source CLI only); absent: none
  now?: () => Date; // drives `show`'s open spans; event timestamps always come from the store's clock
}

export const USAGE = {
  event: 'usage: event <id> <type> [field=value …]',
  rebuild: 'usage: rebuild <id> | --all',
  show: 'usage: show <id>',
  // The vendored CLI's exact top-level usage line; `doctor` is documented in docs/contract/v1.md.
  all: 'usage: event <id> <type> [k=v …] | rebuild <id>|--all | show <id>',
};

// Runs one core command; an unknown or missing command is a usage error naming `usage`.
export async function dispatchCore(argv: readonly string[], io: Io, usage: string = USAGE.all): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'doctor') {
    // A bad config.json is a finding here, not a crash before dispatch.
    const findings = await doctor(io.root);
    for (const f of findings) io.stdout(f.line);
    return findings.every((f) => f.ok) ? 0 : 1;
  }
  const config = parseConfig(JSON.parse(await readFile(join(io.root, 'config.json'), 'utf8')));
  switch (cmd) {
    case 'event': {
      const [id, type, ...kv] = rest;
      if (!id || !type) throw new Error(USAGE.event);
      const input = parseEventInput(type, parseFields(kv), { id, config });
      io.stdout((await appendEvent(io.root, id, input)).stage);
      return 0;
    }
    case 'rebuild': {
      const [target] = rest;
      if (!target) throw new Error(USAGE.rebuild);
      const ids = await rebuild(io.root, target === '--all' ? undefined : target);
      io.stdout(`rebuilt ${ids.length}: ${ids.join(' ')}`);
      return 0;
    }
    case 'show': {
      const [id] = rest;
      if (!id) throw new Error(USAGE.show);
      const log = await readLog(io.root, id);
      if (log.length === 0) throw new Error(`${id}: no events.jsonl (legacy or unknown job)`);
      for (const line of formatShow(project(log), (io.now ?? (() => new Date()))())) io.stdout(line);
      return 0;
    }
    default:
      throw new Error(usage);
  }
}

// Runs `body` and returns its exit code; any thrown error becomes exit 1 with one stderr line.
export async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    io.stderr((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '');
    return 1;
  }
}

// Returns the exit code: 0 on success, 1 on any rejection or usage error (one stderr line).
export function runCore(argv: readonly string[], io: Io): Promise<number> {
  return guarded(io, () => dispatchCore(argv, io));
}
