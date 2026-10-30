// Finding the local Andon service. The OS service manager owns it (`factory service install`: a
// launchd LaunchAgent on macOS); the Mac app is only a client. On launch it probes `GET /projects`;
// when nothing answers, it shows a notice naming `factory service install` and keeps probing until
// the service answers or the app quits. It never starts the service and never stops it.
// Runtime-neutral: the probe and sleep are injected.
import type { Http } from './http';

export const DEFAULT_PORT = 8766; // the service's default (docs/contract/v1.md "Andon service")
/** How often the Mac app probes again while no service answers. */
export const PROBE_MS = 2000;
/** The notice the Mac app shows while no service answers. */
export const INSTALL_NOTICE = 'no Andon service is answering; run factory service install';

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

export interface WaitDeps {
  probe(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** Called once, when the first probe finds no service: show the notice. */
  missing(): void;
  /** True once the app is quitting: stop probing. */
  cancelled(): boolean;
  probeMs?: number;
}

/** The outcome of waiting: `answered` (false only when cancelled first), and `waited` (the first probe found none). */
export interface Found {
  answered: boolean;
  waited: boolean;
}

/** Probes until the service answers or the wait is cancelled. Starts nothing. */
export async function waitForService(d: WaitDeps): Promise<Found> {
  if (await d.probe()) return { answered: true, waited: false };
  if (d.cancelled()) return { answered: false, waited: true };
  d.missing();
  for (;;) {
    await d.sleep(d.probeMs ?? PROBE_MS);
    if (d.cancelled()) return { answered: false, waited: true };
    if (await d.probe()) return { answered: true, waited: true };
  }
}
