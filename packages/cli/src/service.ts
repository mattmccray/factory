// `factory service` (docs/contract/v1.md "CLI" → "`service`"): makes the Andon service a per-user OS
// service, owned by the OS service manager only, and starts, stops, restarts, and reports on it:
//   service install     write the unit, enable it, and start it (again: rewrite it and restart)
//   service install --tailnet   the same, after publishing it on the tailnet with `tailscale serve`
//   service uninstall   stop and disable it and remove the unit; ~/.andon (the registry) stays
//   service start | stop | restart   pass through to launchctl / systemctl --user
//   service status      installed, running (pid), the URL, the running and on-disk release, the logs
//   service run         the service in the foreground, for this CLI's tree: what the unit runs
// macOS: a launchd LaunchAgent, label `dev.factory.andon`, in `gui/<uid>`. Linux: a systemd `--user`
// unit, `andon.service`. Nothing runs `sudo`, and lingering is only reported, never changed.
// `--tailnet` publishes the loopback service with `tailscale serve --https=<port>` and records the
// machine's MagicDNS name in the unit (`ANDON_TAILNET_HOST`), which the service's guard then accepts;
// `install` without it, and `uninstall`, remove that serve entry. Only that port's entry is touched.
// Everything that touches the machine (the platform, home, uid, env, the process runner, the
// port-holder lookup, the filesystem, the HTTP probe, and the service itself) comes in through
// `ServiceHost`, so this module renders and decides the same on any machine; `servicehost.ts` is
// the real one.
import { dirname, isAbsolute, join } from 'node:path';
import { isTailnetHost } from '@factory/andon-service/entry';
import type { Tree } from '@factory/andon-service/entry';

export const SERVICE_USAGE = 'usage: service install [--tailnet]|uninstall|start|stop|restart|status|run';
/** The launchd label, and the plist's name without `.plist`. */
export const LABEL = 'dev.factory.andon';
/** The systemd `--user` unit's name. */
export const UNIT = 'andon.service';
/** The service's default port (docs/contract/v1.md "Andon service"). */
export const DEFAULT_PORT = 8766;
/** What `install` prints when lingering is off on Linux; the CLI never runs it. */
export const LINGER_HINT = `hint: lingering is off, so ${UNIT} stops when you log out; to keep it running, run: loginctl enable-linger`;
/** The macOS app bundle's `tailscale` CLI, used when `tailscale` isn't on PATH. */
export const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
/** What `install --tailnet` prints, and stops, when Linux's `tailscale serve` needs an operator; the CLI never runs it. `$USER` is literal, for the shell. */
export const OPERATOR_LINE = 'service: tailscale serve needs operator permission on this machine; run once: sudo tailscale set --operator=$USER, then run factory service install --tailnet again';

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs one argv to its end. It never goes through a shell. */
export type Runner = (argv: readonly string[]) => Promise<Ran>;

export interface ServiceFs {
  exists(path: string): Promise<boolean>;
  /** The file's text, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Writes the file (temp file plus rename), creating its parent directories. */
  write(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Removes the file; a missing file is not an error. */
  remove(path: string): Promise<void>;
}

export interface ServiceHost {
  platform: string; // `process.platform`
  home: string; // the user's home directory
  uid: number;
  env: Readonly<Record<string, string | undefined>>; // ANDON_PORT, ANDON_HOME, XDG_CONFIG_HOME
  factory: string; // the absolute, unresolved path of the `factory` command that is running
  bun: string; // the absolute path of the `bun` running it
  run: Runner;
  /** Linux: whether a systemd `--user` manager is there to talk to. Runs no command. */
  systemd(): Promise<boolean>;
  /** The pid listening on `127.0.0.1:<port>`, or null when nothing is. */
  portHolder(port: number): Promise<number | null>;
  /** The `tailscale` CLI's path (on PATH, else on macOS the app bundle's), or null when there is none. Runs no command. */
  tailscale(): Promise<string | null>;
  fs: ServiceFs;
  /** GET `url` and parse its JSON; throws when nothing answers or the answer isn't a 2xx. */
  getJson(url: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  /** Starts the Andon service in this process for `tree` (entry.ts `serve`). */
  serve(tree: Tree): Promise<void>;
  stdout(line: string): void;
}

// ---- the platform ----

/** The service manager this machine has, with where its unit file lives. */
export type Manager = { kind: 'launchd'; uid: number; unitPath: string } | { kind: 'systemd'; unitPath: string };

export const launchdPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

/** `$XDG_CONFIG_HOME/systemd/user/andon.service`; an unset or relative XDG_CONFIG_HOME means `~/.config`. */
export function systemdPath(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.config'), 'systemd', 'user', UNIT);
}

/** The log file launchd writes the service's stdout and stderr to. */
export const logPath = (home: string): string => join(home, '.andon', 'service.log');
/** Where the logs are on Linux: the journal. */
export const JOURNAL = `journalctl --user -u ${UNIT}`;

/** This machine's service manager. Throws a one-line refusal on any other platform, or on Linux without systemd `--user`. */
export async function manager(host: ServiceHost): Promise<Manager> {
  if (host.platform === 'darwin') return { kind: 'launchd', uid: host.uid, unitPath: launchdPath(host.home) };
  if (host.platform === 'linux') {
    if (!(await host.systemd())) throw new Error('service: systemd --user is not available on this machine; factory service needs launchd (macOS) or systemd --user (Linux)');
    return { kind: 'systemd', unitPath: systemdPath(host.home, host.env) };
  }
  throw new Error(`service: unsupported platform ${host.platform}; factory service needs launchd (macOS) or systemd --user (Linux)`);
}

// ---- the commands ----

const target = (uid: number): string => `gui/${uid}/${LABEL}`;

/** Every `launchctl` argv the CLI runs. */
export const launchctl = {
  print: (uid: number): string[] => ['launchctl', 'print', target(uid)],
  bootstrap: (uid: number, plist: string): string[] => ['launchctl', 'bootstrap', `gui/${uid}`, plist],
  bootout: (uid: number): string[] => ['launchctl', 'bootout', target(uid)],
  kickstart: (uid: number, restart: boolean): string[] => ['launchctl', 'kickstart', ...(restart ? ['-k'] : []), target(uid)],
};

/** Every `systemctl --user` argv the CLI runs. */
export const systemctl = {
  show: (): string[] => ['systemctl', '--user', 'show', UNIT, '--property=MainPID', '--property=ActiveState'],
  daemonReload: (): string[] => ['systemctl', '--user', 'daemon-reload'],
  enableNow: (): string[] => ['systemctl', '--user', 'enable', '--now', UNIT],
  disableNow: (): string[] => ['systemctl', '--user', 'disable', '--now', UNIT],
  start: (): string[] => ['systemctl', '--user', 'start', UNIT],
  stop: (): string[] => ['systemctl', '--user', 'stop', UNIT],
  restart: (): string[] => ['systemctl', '--user', 'restart', UNIT],
};

/** The one `loginctl` argv the CLI runs: a read of the user's lingering setting. */
export const lingerQuery = (uid: number): string[] => ['loginctl', 'show-user', String(uid), '--property=Linger', '--value'];

/** Every `tailscale` argv the CLI runs, for the CLI at `bin`. Only the `--https=<port>` entry is ever changed. */
export const tailscale = {
  status: (bin: string): string[] => [bin, 'status', '--json'],
  serveStatus: (bin: string): string[] => [bin, 'serve', 'status', '--json'],
  serve: (bin: string, port: number): string[] => [bin, 'serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`],
  off: (bin: string, port: number): string[] => [bin, 'serve', `--https=${port}`, 'off'],
};

// ---- the unit ----

export interface UnitSpec {
  factory: string; // the absolute `factory` path the unit runs `service run` with
  bun: string; // the absolute `bun` path: the unit's program, and first on its PATH
  home: string;
  env: { ANDON_PORT?: string; ANDON_HOME?: string; ANDON_TAILNET_HOST?: string }; // recorded only when set at install (the tailnet host: only by `install --tailnet`)
}

// launchd and systemd don't see the login shell's PATH: the unit's PATH is the installing bun's
// directory, then the system's, so the service's own children (`git`) are found.
const SYSTEM_PATH: Record<'launchd' | 'systemd', string[]> = {
  launchd: ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  systemd: ['/usr/local/bin', '/usr/bin', '/bin'],
};

export function unitPathVar(kind: 'launchd' | 'systemd', bun: string): string {
  return [...new Set([dirname(bun), ...SYSTEM_PATH[kind]])].join(':');
}

/** The unit's environment, in a fixed order: PATH, then ANDON_PORT, ANDON_HOME, and ANDON_TAILNET_HOST when set. */
function unitEnv(kind: 'launchd' | 'systemd', spec: UnitSpec): [string, string][] {
  const out: [string, string][] = [['PATH', unitPathVar(kind, spec.bun)]];
  if (spec.env.ANDON_PORT !== undefined) out.push(['ANDON_PORT', spec.env.ANDON_PORT]);
  if (spec.env.ANDON_HOME !== undefined) out.push(['ANDON_HOME', spec.env.ANDON_HOME]);
  if (spec.env.ANDON_TAILNET_HOST !== undefined) out.push(['ANDON_TAILNET_HOST', spec.env.ANDON_TAILNET_HOST]);
  return out;
}

/** The argv the unit runs: the installing bun on the installing factory's `service run`. */
export const unitArgv = (spec: UnitSpec): string[] => [spec.bun, spec.factory, 'service', 'run'];

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The LaunchAgent plist: runs `service run` at load and keeps it alive, logging to `~/.andon/service.log`. */
export function renderPlist(spec: UnitSpec): string {
  const s = (v: string): string => `<string>${xml(v)}</string>`;
  const log = s(logPath(spec.home));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...unitArgv(spec).map((a) => `    ${s(a)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...unitEnv('launchd', spec).flatMap(([k, v]) => [`    <key>${k}</key>`, `    ${s(v)}`]),
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  ${s(spec.home)}`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  ${log}`,
    '  <key>StandardErrorPath</key>',
    `  ${log}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// systemd's quoting: in a double-quoted word, `\` and `"` are escaped, `%` (a specifier) is `%%`,
// and on ExecStart `$` (a variable) is `$$`.
const quoted = (s: string, exec: boolean): string => {
  const body = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${exec ? body.replace(/\$/g, '$$$$') : body}"`;
};

/** The systemd `--user` unit: runs `service run`, restarts it always, and is wanted by `default.target`. */
export function renderUnit(spec: UnitSpec): string {
  return [
    '[Unit]',
    'Description=Andon service (factory)',
    '',
    '[Service]',
    `ExecStart=${unitArgv(spec)
      .map((a) => quoted(a, true))
      .join(' ')}`,
    ...unitEnv('systemd', spec).map(([k, v]) => `Environment=${quoted(`${k}=${v}`, false)}`),
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The ANDON_PORT a unit file records, or null when it records none. */
export function recordedPort(text: string): number | null {
  const m = /<key>ANDON_PORT<\/key>\s*<string>(\d+)<\/string>/.exec(text) ?? /^Environment="ANDON_PORT=(\d+)"$/m.exec(text);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** The ANDON_TAILNET_HOST a unit file records, or null when it records none. */
export function recordedTailnetHost(text: string): string | null {
  const m = /<key>ANDON_TAILNET_HOST<\/key>\s*<string>([^<]+)<\/string>/.exec(text) ?? /^Environment="ANDON_TAILNET_HOST=([^"]+)"$/m.exec(text);
  return m?.[1] ?? null;
}

// ---- checks ----

/** A port from `ANDON_PORT`: null when unset; throws when it isn't a port number from 1 to 65535. */
export function envPort(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = env.ANDON_PORT;
  if (raw === undefined) return null;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error(`service: ANDON_PORT must be a port number (1-65535), got ${JSON.stringify(raw)}`);
  return port;
}

function checkPath(what: string, p: string): void {
  if (!isAbsolute(p)) throw new Error(`service: ${what} must be an absolute path, got ${JSON.stringify(p)}`);
  if (/[\n\r\0]/.test(p)) throw new Error(`service: ${what} must not contain a newline or NUL`);
}

/** The unit for this host, checked: absolute paths with no newline, and a valid ANDON_PORT. */
export function unitSpec(host: ServiceHost): UnitSpec {
  checkPath('the factory command', host.factory);
  checkPath('bun', host.bun);
  checkPath('the home directory', host.home);
  const env: UnitSpec['env'] = {};
  if (envPort(host.env) !== null && host.env.ANDON_PORT !== undefined) env.ANDON_PORT = host.env.ANDON_PORT;
  const andonHome = host.env.ANDON_HOME;
  if (andonHome !== undefined) {
    checkPath('ANDON_HOME', andonHome);
    env.ANDON_HOME = andonHome;
  }
  return { factory: host.factory, bun: host.bun, home: host.home, env };
}

// ---- running commands ----

const lastLine = (s: string): string =>
  s
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1) ?? '';

async function must(host: ServiceHost, argv: readonly string[]): Promise<Ran> {
  const r = await host.run(argv);
  if (r.code !== 0) throw new Error(`service: ${argv.join(' ')} failed: ${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}`);
  return r;
}

/** What the service manager says about the unit: whether it is loaded, and its pid when it runs. */
export interface UnitState {
  loaded: boolean;
  pid: number | null;
}

/** Parses `launchctl print` output (exit 0: loaded) for its `pid = N` line. */
export function parseLaunchctlPrint(r: Ran): UnitState {
  if (r.code !== 0) return { loaded: false, pid: null };
  const m = /^\s*pid = (\d+)\s*$/m.exec(r.stdout);
  const pid = m?.[1] === undefined ? 0 : Number(m[1]);
  return { loaded: true, pid: pid > 0 ? pid : null };
}

/** Parses `systemctl --user show andon.service --property=MainPID --property=ActiveState`. */
export function parseSystemctlShow(r: Ran): UnitState {
  if (r.code !== 0) return { loaded: false, pid: null };
  const field = (k: string): string => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1]?.trim() ?? '';
  const pid = Number(field('MainPID'));
  const active = field('ActiveState');
  return { loaded: active !== '' && active !== 'inactive' && active !== 'failed', pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

/** The unit's state, from the service manager (a read-only query). */
export async function unitState(host: ServiceHost, m: Manager): Promise<UnitState> {
  return m.kind === 'launchd' ? parseLaunchctlPrint(await host.run(launchctl.print(m.uid))) : parseSystemctlShow(await host.run(systemctl.show()));
}

// After `bootout`, launchd unloads the job asynchronously; `bootstrap` too soon fails. Wait for it.
const UNLOAD_TRIES = 20;
const UNLOAD_MS = 100;

async function bootout(host: ServiceHost, uid: number): Promise<void> {
  await must(host, launchctl.bootout(uid));
  for (let i = 0; i < UNLOAD_TRIES; i++) {
    if (!parseLaunchctlPrint(await host.run(launchctl.print(uid))).loaded) return;
    await host.sleep(UNLOAD_MS);
  }
  throw new Error(`service: ${LABEL} did not unload after launchctl bootout`);
}

const named = (m: Manager): string => (m.kind === 'launchd' ? LABEL : UNIT);
const urlOf = (port: number): string => `http://127.0.0.1:${port}/`;
const tailnetUrlOf = (name: string, port: number): string => `https://${name}:${port}/`;

// ---- the tailnet ----

const get = (v: unknown, k: string): unknown => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Reflect.get(v, k) : undefined);

function parseJson(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    return v;
  } catch {
    return undefined;
  }
}

/** What `tailscale status --json` says about this machine: whether it is up, its MagicDNS name, and whether that name can have an HTTPS certificate. */
export type TailnetSelf = { ok: true; name: string } | { ok: false; reason: string };

/** Reads `tailscale status --json`: `BackendState` must be `Running`, `Self.DNSName` (trailing dot stripped, lowercased) a DNS name, and in `CertDomains`. */
export function parseTailscaleStatus(stdout: string): TailnetSelf {
  const v = parseJson(stdout);
  if (typeof v !== 'object' || v === null) return { ok: false, reason: 'service: tailscale status --json did not print a JSON object' };
  const state = get(v, 'BackendState');
  if (state !== 'Running') {
    return { ok: false, reason: `service: Tailscale is not running or logged out (BackendState ${typeof state === 'string' ? state : 'unknown'}); connect it, then run factory service install --tailnet again` };
  }
  const dns = get(get(v, 'Self'), 'DNSName');
  const name = typeof dns === 'string' ? dns.replace(/\.$/, '').toLowerCase() : '';
  if (!isTailnetHost(name)) return { ok: false, reason: `service: Tailscale reports no MagicDNS name for this machine (Self.DNSName ${JSON.stringify(dns ?? null)}); turn on MagicDNS for the tailnet` };
  const certs = get(v, 'CertDomains');
  const listed = Array.isArray(certs) && certs.some((c) => typeof c === 'string' && c.replace(/\.$/, '').toLowerCase() === name);
  if (!listed) return { ok: false, reason: `service: HTTPS certificates are not enabled on this tailnet (CertDomains lacks ${name}); enable HTTPS in the Tailscale admin console, then run factory service install --tailnet again` };
  return { ok: true, name };
}

/** Whether `tailscale serve status --json` shows an entry on HTTPS port `port` (a `TCP` port, or a `Web` `<host>:<port>`); null when it isn't JSON. */
export function hasServeEntry(stdout: string, port: number): boolean | null {
  const v = parseJson(stdout);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const tcp = get(v, 'TCP');
  if (get(tcp, String(port)) !== undefined) return true;
  const web = get(v, 'Web');
  return typeof web === 'object' && web !== null && Object.keys(web).some((k) => k.endsWith(`:${port}`));
}

async function tailscaleBin(host: ServiceHost, why: string): Promise<string> {
  const bin = await host.tailscale();
  if (bin !== null) return bin;
  const where = host.platform === 'darwin' ? `not on PATH, and not at ${TAILSCALE_APP}` : 'not on PATH';
  throw new Error(`service: no tailscale CLI found (${where}); ${why}`);
}

/** Whether the `--https=<port>` serve entry is there, read from `tailscale serve status --json` (a read). */
async function serveEntry(host: ServiceHost, bin: string, port: number): Promise<boolean> {
  const argv = tailscale.serveStatus(bin);
  const r = await must(host, argv);
  const has = hasServeEntry(r.stdout, port);
  if (has === null) throw new Error(`service: ${argv.join(' ')} did not print a JSON object`);
  return has;
}

/** Removes the `--https=<port>` serve entry when `tailscale serve status --json` shows it; true when it removed one. */
async function removeServeEntry(host: ServiceHost, bin: string, port: number): Promise<boolean> {
  if (!(await serveEntry(host, bin, port))) return false;
  await must(host, tailscale.off(bin, port));
  return true;
}

const OPERATOR = /operator|access denied/i;

/** Publishes `127.0.0.1:<port>` on HTTPS port `<port>`. On Linux, a denial for want of an operator is the one `sudo tailscale set --operator=$USER` line. */
async function makeServeEntry(host: ServiceHost, bin: string, port: number): Promise<void> {
  const argv = tailscale.serve(bin, port);
  const r = await host.run(argv);
  if (r.code === 0) return;
  if (host.platform === 'linux' && OPERATOR.test(`${r.stderr}\n${r.stdout}`)) throw new Error(OPERATOR_LINE);
  throw new Error(`service: ${argv.join(' ')} failed: ${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}`);
}

// ---- the subcommands ----

/** Writes the unit and (re)starts it through the service manager. */
async function writeAndStart(host: ServiceHost, m: Manager, spec: UnitSpec, existed: boolean): Promise<void> {
  if (m.kind === 'launchd') {
    await host.fs.mkdir(dirname(logPath(host.home))); // launchd opens the log but makes no directory
    await host.fs.write(m.unitPath, renderPlist(spec));
    if ((await unitState(host, m)).loaded) await bootout(host, m.uid); // a loaded job keeps its old plist
    await must(host, launchctl.bootstrap(m.uid, m.unitPath));
    await must(host, launchctl.kickstart(m.uid, false));
  } else {
    await host.fs.write(m.unitPath, renderUnit(spec));
    await must(host, systemctl.daemonReload());
    await must(host, systemctl.enableNow());
    if (existed) await must(host, systemctl.restart());
  }
}

async function install(host: ServiceHost, m: Manager, tailnet: boolean): Promise<void> {
  const spec = unitSpec(host);
  const port = envPort(host.env) ?? DEFAULT_PORT;
  // A port held by anything but the installed unit's service (an app-spawned or terminal one)
  // would make the new unit crash-loop: refuse, writing nothing and changing nothing.
  const holder = await host.portHolder(port);
  if (holder !== null && holder !== (await unitState(host, m)).pid) {
    throw new Error(`service: port ${port} is held by pid ${holder}, not the installed Andon service; stop it, then run factory service install again`);
  }
  const old = await host.fs.read(m.unitPath);
  const existed = old !== null || (await host.fs.exists(m.unitPath));
  const oldName = old === null ? null : recordedTailnetHost(old);
  const oldPort = old === null ? DEFAULT_PORT : (recordedPort(old) ?? DEFAULT_PORT);

  let name: string | null = null;
  if (tailnet) {
    // Every tailnet refusal comes before anything is written or changed.
    const bin = await tailscaleBin(host, 'install Tailscale, then run factory service install --tailnet again');
    const self = parseTailscaleStatus((await must(host, tailscale.status(bin))).stdout);
    if (!self.ok) throw new Error(self.reason);
    name = self.name;
    spec.env.ANDON_TAILNET_HOST = name;
    // The entry is made before the unit is written; when a later unit step fails, the entry this
    // install made is removed again and the old unit put back, so a recorded name and its entry
    // never part. An entry that was already there (a reinstall) is left as it was.
    const had = await serveEntry(host, bin, port);
    await makeServeEntry(host, bin, port);
    try {
      await writeAndStart(host, m, spec, existed);
    } catch (e) {
      try {
        if (old === null) await host.fs.remove(m.unitPath);
        else await host.fs.write(m.unitPath, old);
      } catch {
        // the unit step's failure is the one to report
      }
      const why = e instanceof Error ? e.message : String(e);
      if (!had && (await host.run(tailscale.off(bin, port))).code !== 0) throw new Error(`${why}; removing the serve entry again failed too: run ${tailscale.off('tailscale', port).join(' ')}`);
      throw e;
    }
    // The old unit's entry on another port is this install's to remove, now that nothing serves it.
    if (oldName !== null && oldPort !== port) {
      try {
        await removeServeEntry(host, bin, oldPort);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}; the service is installed on port ${port}, but the old serve entry on https port ${oldPort} is still there: run ${tailscale.off('tailscale', oldPort).join(' ')}`);
      }
    }
  } else {
    // Turning tailnet access off: the entry goes before the unit stops recording its name.
    if (oldName !== null) await removeServeEntry(host, await tailscaleBin(host, `remove the serve entry on https port ${oldPort} (tailscale serve --https=${oldPort} off), then run factory service install again`), oldPort);
    await writeAndStart(host, m, spec, existed);
  }
  host.stdout(`${existed ? 'reinstalled' : 'installed'} ${named(m)}: ${m.unitPath}`);
  host.stdout(`Andon service: ${urlOf(port)} (runs ${spec.factory} service run)`);
  if (name !== null) host.stdout(`tailnet: ${tailnetUrlOf(name, port)}`);
  else if (oldName !== null) host.stdout('tailnet: off');
  if (m.kind === 'systemd') {
    const linger = await host.run(lingerQuery(host.uid));
    if (linger.code === 0 && linger.stdout.trim() === 'no') host.stdout(LINGER_HINT);
  }
}

async function uninstall(host: ServiceHost, m: Manager): Promise<void> {
  const text = await host.fs.read(m.unitPath);
  const name = text === null ? null : recordedTailnetHost(text);
  if (text !== null && name !== null) {
    // The serve entry goes first; when it can't be removed, the unit (and its record of it) stays.
    const port = recordedPort(text) ?? DEFAULT_PORT;
    try {
      await removeServeEntry(host, await tailscaleBin(host, `remove the serve entry on https port ${port} (tailscale serve --https=${port} off)`), port);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; the unit is kept`);
    }
  }
  const existed = text !== null || (await host.fs.exists(m.unitPath));
  if (m.kind === 'launchd') {
    const loaded = (await unitState(host, m)).loaded;
    if (!existed && !loaded) return host.stdout(`not installed: ${named(m)}`);
    if (loaded) await bootout(host, m.uid);
    await host.fs.remove(m.unitPath);
  } else {
    if (!existed) return host.stdout(`not installed: ${named(m)}`);
    await must(host, systemctl.disableNow());
    await host.fs.remove(m.unitPath);
    await must(host, systemctl.daemonReload());
  }
  host.stdout(`uninstalled ${named(m)}: removed ${m.unitPath} (the Andon registry is kept)`);
}

type Pass = 'start' | 'stop' | 'restart';
const PAST: Record<Pass, string> = { start: 'started', stop: 'stopped', restart: 'restarted' };

async function pass(host: ServiceHost, m: Manager, verb: Pass): Promise<void> {
  if (!(await host.fs.exists(m.unitPath))) throw new Error(`service: ${named(m)} is not installed; run factory service install`);
  if (m.kind === 'systemd') {
    await must(host, systemctl[verb]());
  } else {
    // A loaded LaunchAgent with KeepAlive comes back from a kill, so stop is `bootout` (until
    // the next login or start), and start loads it again with `bootstrap`.
    const loaded = (await unitState(host, m)).loaded;
    if (verb === 'stop') {
      if (!loaded) return host.stdout(`not running: ${named(m)}`);
      await bootout(host, m.uid);
    } else if (loaded) {
      await must(host, launchctl.kickstart(m.uid, verb === 'restart'));
    } else {
      await must(host, launchctl.bootstrap(m.uid, m.unitPath));
    }
  }
  host.stdout(`${PAST[verb]} ${named(m)}`);
}

const str = (v: unknown, k: string): string | null => {
  if (typeof v !== 'object' || v === null || !(k in v)) return null;
  const x: unknown = Reflect.get(v, k);
  return typeof x === 'string' ? x : null;
};

/** The `status` block's release line, from a `GET /release` body (or null when nothing answered). */
export function releaseLine(body: unknown): string {
  if (body === null) return 'release: unknown (the service is not answering)';
  const running = str(body, 'running');
  const onDisk = str(body, 'onDisk');
  const v = (x: string | null): string => (x === null ? 'unknown' : `v${x}`);
  const restart = onDisk !== null && onDisk !== running ? ': restart needed (factory service restart)' : '';
  return `release: running ${v(running)}, on disk ${v(onDisk)}${restart}`;
}

async function status(host: ServiceHost, m: Manager): Promise<number> {
  const text = await host.fs.read(m.unitPath);
  const port = (text === null ? null : recordedPort(text)) ?? envPort(host.env) ?? DEFAULT_PORT;
  const state = await unitState(host, m);
  let body: unknown = null;
  try {
    body = await host.getJson(`http://127.0.0.1:${port}/release`);
  } catch {
    body = null;
  }
  const running = state.pid !== null && body !== null;
  const manager = m.kind === 'launchd' ? `launchd ${LABEL}` : `systemd --user ${UNIT}`;
  host.stdout(`service: ${manager}, ${text === null ? 'not installed' : `installed (${m.unitPath})`}`);
  host.stdout(`running: ${state.pid === null ? 'no' : `pid ${state.pid}${body === null ? ', but not answering' : ''}`}`);
  host.stdout(`url: ${urlOf(port)}`);
  const name = text === null ? null : recordedTailnetHost(text);
  if (name !== null) host.stdout(`tailnet: ${tailnetUrlOf(name, port)}`);
  host.stdout(releaseLine(body));
  host.stdout(`logs: ${m.kind === 'launchd' ? logPath(host.home) : JOURNAL}`);
  return running ? 0 : 1;
}

/**
 * Runs `service …` (the args after `service`). `tree` is the tree `run` serves: this CLI's own
 * (the source clone's, or the release bundle's). Returns the exit code; throws a one-line reason
 * on a usage error or a refusal, before writing or running anything.
 */
export async function service(rest: readonly string[], host: ServiceHost, tree: Tree): Promise<number> {
  const [sub, ...args] = rest;
  const tailnet = sub === 'install' && args.length === 1 && args[0] === '--tailnet';
  if (args.length > 0 && !tailnet) throw new Error(SERVICE_USAGE);
  switch (sub) {
    case 'run':
      await host.serve(tree);
      return 0;
    case 'install':
      await install(host, await manager(host), tailnet);
      return 0;
    case 'uninstall':
      await uninstall(host, await manager(host));
      return 0;
    case 'start':
    case 'stop':
    case 'restart':
      await pass(host, await manager(host), sub);
      return 0;
    case 'status':
      return status(host, await manager(host));
    default:
      throw new Error(SERVICE_USAGE);
  }
}
