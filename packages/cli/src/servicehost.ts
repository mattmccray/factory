// The real `ServiceHost` for `factory service` (service.ts): this process's platform, home, uid, and
// env; `Bun.spawn` (never a shell) for launchctl, systemctl, and loginctl; `lsof` (or `ss` on Linux)
// for the port holder; the filesystem; `fetch` for the HTTP probe; and entry.ts `serve`.
// `main.ts` (source) and `release-main.ts` (the release bundle) both build theirs here.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { serve } from '@factory/andon-service/entry';
import type { Ran, ServiceHost } from './service';

const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';

/** Runs `argv` to its end; a command that isn't there is exit 127 with its reason on stderr. */
export async function spawnRun(argv: readonly string[]): Promise<Ran> {
  try {
    const p = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** The first pid in `lsof -t` output (one pid per line), or null. */
export function parseLsof(out: string): number | null {
  const m = /^(\d+)$/m.exec(out);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** The first `pid=N` in `ss -ltnpH` output, or null. */
export function parseSs(out: string): number | null {
  const m = /pid=(\d+)/.exec(out);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** The pid listening on TCP `port`: `lsof`, then on Linux `ss`; null when neither names one. */
export async function lookupPortHolder(port: number, run: (argv: readonly string[]) => Promise<Ran> = spawnRun, platform: string = process.platform): Promise<number | null> {
  const lsof = await run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = parseLsof(lsof.stdout);
  if (pid !== null || platform !== 'linux') return pid;
  return parseSs((await run(['ss', '-ltnpH', `sport = :${port}`])).stdout);
}

/**
 * The absolute, unresolved path of the `factory` command running `main` (the script Bun runs,
 * which Bun reports with symlinks resolved): the shell's `$_` or the `factory` on PATH when it
 * resolves to the same script, so a reinstall at that path keeps a unit valid; else `main` itself.
 */
export async function factoryCommand(main: string, candidates: readonly (string | null | undefined)[], resolve: (p: string) => Promise<string> = realpath): Promise<string> {
  let real: string;
  try {
    real = await resolve(main);
  } catch {
    return main;
  }
  for (const c of candidates) {
    if (c === null || c === undefined || !isAbsolute(c)) continue;
    try {
      if ((await resolve(c)) === real) return c;
    } catch {
      // not there: try the next
    }
  }
  return main;
}

/** A fresh, unpredictable temp path beside `unit`, for `writeUnitFile`. */
export function unitTempPath(unit: string): string {
  return join(dirname(unit), `.${basename(unit)}.${randomUUID()}.tmp`);
}

/**
 * Writes the unit file: `mkdir -p` its directory, write `text` to a temp file created
 * exclusively (`wx`: an existing file or symlink at `tmp` is never followed or overwritten),
 * mode 0644, then rename it over `unit`, so a reader never sees a partial unit. The temp file is
 * removed when the write or the rename fails. `tmp` is a seam for tests; the default is fresh.
 */
export async function writeUnitFile(unit: string, text: string, tmp: string = unitTempPath(unit)): Promise<void> {
  await mkdir(dirname(unit), { recursive: true });
  const fh = await open(tmp, 'wx', 0o644); // fails on anything already at tmp: nothing of ours to remove
  try {
    try {
      await fh.writeFile(text, 'utf8');
      await fh.chmod(0o644); // exactly 0644, whatever the umask
    } finally {
      await fh.close();
    }
    await rename(tmp, unit);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** A systemd `--user` manager is there: systemd is the init (`/run/systemd/system`), `systemctl` is on PATH, and the user manager's socket exists. */
function systemdUser(uid: number, env: Readonly<Record<string, string | undefined>>): boolean {
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  return existsSync('/run/systemd/system') && Bun.which('systemctl') !== null && existsSync(join(runtime, 'systemd', 'private'));
}

export async function realServiceHost(stdout: (line: string) => void): Promise<ServiceHost> {
  const env = process.env;
  const uid = process.getuid?.() ?? -1;
  return {
    platform: process.platform,
    home: env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : homedir(),
    uid,
    env,
    factory: await factoryCommand(Bun.main, [env._, Bun.which('factory')]),
    bun: process.execPath,
    run: spawnRun,
    systemd: async () => systemdUser(uid, env),
    portHolder: (port) => lookupPortHolder(port),
    fs: {
      exists: async (path) => existsSync(path),
      read: async (path) => {
        try {
          return await readFile(path, 'utf8');
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
      write: (path, text) => writeUnitFile(path, text),
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      remove: (path) => rm(path, { force: true }),
    },
    getJson: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      return body;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    serve,
    stdout,
  };
}
