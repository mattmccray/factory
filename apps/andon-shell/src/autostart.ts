// Starting the local Andon agent. On launch the shell probes `GET /projects`; if nothing answers,
// it spawns the agent once and re-probes, a bounded number of times, until the agent answers or
// it gives up with a one-line reason. On quit it stops only an agent it started itself.
// Runtime-neutral: the probe, spawn, and sleep are injected.
import type { Http } from './http';

export const DEFAULT_PORT = 8766; // the agent's default (docs/contract/v1.md "Andon agent")
export const RETRIES = 40;
export const RETRY_MS = 250;

/** `$ANDON_PORT` when it is a port number, else the agent's default. */
export function resolvePort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.ANDON_PORT;
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_PORT;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

export const agentUrl = (port: number): string => `http://127.0.0.1:${port}`;

/** `bun <repo>/packages/andon-agent/src/main.ts`; `bun` may be an absolute path. */
export const agentCommand = (repo: string, bun = 'bun'): string[] => [bun, `${repo.replace(/\/+$/, '')}/packages/andon-agent/src/main.ts`];

/** True when the agent answers `GET /projects` with a 2xx. */
export async function probeAgent(http: Http): Promise<boolean> {
  try {
    const res = await http('/projects');
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

export interface Child {
  stop(): void;
}

export interface AutostartDeps {
  probe(): Promise<boolean>;
  /** Starts `argv` with `env` added to the shell's own environment. */
  spawn(argv: string[], env: Record<string, string>): Child;
  sleep(ms: number): Promise<void>;
  command: string[];
  port: number;
  retries?: number;
  retryMs?: number;
}

export type Agent =
  | { ok: true; started: boolean; stop(): void } // `started`: the shell spawned it
  | { ok: false; reason: string; stop(): void };

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

export async function ensureAgent(d: AutostartDeps): Promise<Agent> {
  if (await d.probe()) return { ok: true, started: false, stop: () => undefined }; // not ours: left alone
  let child: Child;
  try {
    child = d.spawn(d.command, { ANDON_PORT: String(d.port) });
  } catch (e) {
    return { ok: false, reason: `could not start the agent (${d.command.join(' ')}): ${firstLine(e)}`, stop: () => undefined };
  }
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    child.stop();
  };
  const retries = d.retries ?? RETRIES;
  const ms = d.retryMs ?? RETRY_MS;
  for (let i = 0; i < retries; i++) {
    await d.sleep(ms);
    if (await d.probe()) return { ok: true, started: true, stop };
  }
  return { ok: false, reason: `the agent did not answer on ${agentUrl(d.port)} within ${Math.round((retries * ms) / 100) / 10}s`, stop };
}
