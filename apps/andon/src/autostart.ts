// Starting the local Andon service. On launch the Mac app probes `GET /projects`; if nothing answers,
// it spawns the service once and re-probes, a bounded number of times, until the service answers or
// it gives up with a one-line reason. On quit it stops only a service it started itself.
// Runtime-neutral: the probe, spawn, and sleep are injected.
import type { Http } from './http';

export const DEFAULT_PORT = 8766; // the service's default (docs/contract/v1.md "Andon service")
export const RETRIES = 40;
export const RETRY_MS = 250;

/** `$ANDON_PORT` when it is a port number, else the service's default. */
export function resolvePort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.ANDON_PORT;
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_PORT;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

export const serviceUrl = (port: number): string => `http://127.0.0.1:${port}`;

/** The query that tells the page it runs in the Mac app (the traffic-light inset, drag regions, vibrancy). */
export const SHELL_QUERY = '?shell=mac';

/** The page the main window shows: the service's UI in Mac-app mode. tinyjs.json's `url` is this at the default port. */
export const pageUrl = (port: number): string => `${serviceUrl(port)}/${SHELL_QUERY}`;

/** `bun <repo>/packages/andon-service/src/main.ts`; `bun` may be an absolute path. */
export const serviceCommand = (repo: string, bun = 'bun'): string[] => [bun, `${repo.replace(/\/+$/, '')}/packages/andon-service/src/main.ts`];

/** True when the service answers `GET /projects` with a 2xx. */
export async function probeService(http: Http): Promise<boolean> {
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
  /** Starts `argv` with `env` added to the Mac app's own environment. */
  spawn(argv: string[], env: Record<string, string>): Child;
  sleep(ms: number): Promise<void>;
  command: string[];
  port: number;
  retries?: number;
  retryMs?: number;
}

export type Service =
  | { ok: true; started: boolean; stop(): void } // `started`: the Mac app spawned it
  | { ok: false; reason: string; stop(): void };

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

export async function ensureService(d: AutostartDeps): Promise<Service> {
  if (await d.probe()) return { ok: true, started: false, stop: () => undefined }; // not ours: left alone
  let child: Child;
  try {
    child = d.spawn(d.command, { ANDON_PORT: String(d.port) });
  } catch (e) {
    return { ok: false, reason: `could not start the service (${d.command.join(' ')}): ${firstLine(e)}`, stop: () => undefined };
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
  return { ok: false, reason: `the service did not answer on ${serviceUrl(d.port)} within ${Math.round((retries * ms) / 100) / 10}s`, stop };
}
