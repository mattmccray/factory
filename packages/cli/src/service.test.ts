import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, registryPath } from '@factory/contract';
import type { Tree } from '@factory/andon-service/entry';
import { SOURCE_ROOT } from './bundle';
import { run, serviceTree } from './index';
import type { CliIo } from './index';
import {
  DEFAULT_PORT,
  JOURNAL,
  LABEL,
  LINGER_HINT,
  OPERATOR_LINE,
  SERVICE_USAGE,
  TAILSCALE_APP,
  UNIT,
  hasServeEntry,
  launchctl,
  launchdPath,
  lingerQuery,
  logPath,
  parseLaunchctlPrint,
  parseSystemctlShow,
  parseTailscaleStatus,
  recordedPort,
  recordedTailnetHost,
  releaseLine,
  renderPlist,
  renderUnit,
  service,
  systemctl,
  systemdPath,
  tailscale,
  unitPathVar,
} from './service';
import type { Ran, ServiceHost } from './service';
import { factoryCommand, findTailscale, lookupPortHolder, parseLsof, parseSs } from './servicehost';

const HOME = '/Users/me';
const FACTORY = '/Users/me/.bun/bin/factory';
const BUN = '/Users/me/.bun/bin/bun';
const UID = 501;
const TREE: Tree = { uiDir: '/t/ui', cloneRoot: '/t', versionFile: 'package.json' };
const PLIST = `${HOME}/Library/LaunchAgents/dev.factory.andon.plist`;
const SYSTEMD = `${HOME}/.config/systemd/user/andon.service`;

const ok = (stdout = ''): Ran => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'nope', code = 1): Ran => ({ code, stdout: '', stderr });

/** A fake machine: its unit files, what the service manager says, who holds the port, and what the HTTP probe answers. */
interface World {
  platform: string;
  env: Record<string, string | undefined>;
  systemd: boolean;
  files: Map<string, string>;
  dirs: string[];
  removed: string[];
  runs: string[][];
  out: string[];
  served: Tree[];
  /** launchd: loaded with this pid (null: loaded, not running), or not loaded. systemd: MainPID and ActiveState. */
  loaded: boolean;
  pid: number | null;
  holder: number | null;
  linger: string;
  release: unknown; // null: nothing answers
  failOn?: string; // an argv (joined) that exits 1
  paths?: Partial<Pick<ServiceHost, 'factory' | 'bun' | 'home'>>; // overrides FACTORY, BUN, HOME
  /** The `tailscale` CLI's path (null: none on this machine), what its `status --json` prints, and the HTTPS ports with a serve entry. */
  tsBin: string | null;
  tsStatus: unknown;
  entries: Set<number>;
  answers: Record<string, Ran>; // an argv (joined) and what it answers instead
  steps: string[]; // every run (joined) and unit write or remove (`write <path>`, `remove <path>`), in order
}

const TS = '/usr/local/bin/tailscale';
const NAME = 'studio.manticore-hue.ts.net';
const RUNNING = { BackendState: 'Running', Self: { DNSName: `${NAME}.` }, CertDomains: [NAME] };

/** `tailscale serve status --json` with an entry on each port (as Tailscale 1.104 prints it), or `{}`. */
function serveConfig(ports: Iterable<number>): unknown {
  const list = [...ports];
  if (list.length === 0) return {};
  return {
    TCP: Object.fromEntries(list.map((p) => [String(p), { HTTPS: true }])),
    Web: Object.fromEntries(list.map((p) => [`${NAME}:${p}`, { Handlers: { '/': { Proxy: `http://127.0.0.1:${p}` } } }])),
  };
}

function world(over: Partial<World> = {}): World {
  return { platform: 'darwin', env: {}, systemd: true, files: new Map(), dirs: [], removed: [], runs: [], out: [], served: [], loaded: false, pid: null, holder: null, linger: 'yes', release: null, tsBin: null, tsStatus: RUNNING, entries: new Set(), answers: {}, steps: [], ...over };
}

function host(w: World): ServiceHost {
  return {
    platform: w.platform,
    home: w.paths?.home ?? HOME,
    uid: UID,
    env: w.env,
    factory: w.paths?.factory ?? FACTORY,
    bun: w.paths?.bun ?? BUN,
    run: async (argv) => {
      const a = [...argv];
      w.runs.push(a);
      const line = a.join(' ');
      w.steps.push(line);
      if (w.failOn === line) return fail('Boom\nlast reason');
      const answer = w.answers[line];
      if (answer !== undefined) return answer;
      if (w.tsBin !== null && a[0] === w.tsBin) {
        if (line === tailscale.status(w.tsBin).join(' ')) return ok(JSON.stringify(w.tsStatus));
        if (line === tailscale.serveStatus(w.tsBin).join(' ')) return ok(JSON.stringify(serveConfig(w.entries)));
        const port = Number(/--https=(\d+)/.exec(line)?.[1]);
        if (line === tailscale.serve(w.tsBin, port).join(' ')) w.entries.add(port);
        if (line === tailscale.off(w.tsBin, port).join(' ')) w.entries.delete(port);
        return ok();
      }
      if (line === launchctl.print(UID).join(' ')) return w.loaded ? ok(`gui/${UID}/${LABEL} = {\n\tstate = ${w.pid === null ? 'not running' : 'running'}\n${w.pid === null ? '' : `\tpid = ${w.pid}\n`}}`) : fail('Could not find service', 113);
      if (line === launchctl.bootout(UID).join(' ')) w.loaded = false;
      if (line === launchctl.bootstrap(UID, PLIST).join(' ')) w.loaded = true;
      if (line === systemctl.show().join(' ')) return ok(`MainPID=${w.pid ?? 0}\nActiveState=${w.loaded ? 'active' : 'inactive'}\n`);
      if (a[0] === 'loginctl') return ok(`${w.linger}\n`);
      return ok();
    },
    systemd: async () => w.systemd,
    portHolder: async () => w.holder,
    tailscale: async () => w.tsBin,
    fs: {
      exists: async (p) => w.files.has(p),
      read: async (p) => w.files.get(p) ?? null,
      write: async (p, t) => {
        w.steps.push(`write ${p}`);
        w.files.set(p, t);
      },
      mkdir: async (p) => void w.dirs.push(p),
      remove: async (p) => {
        w.steps.push(`remove ${p}`);
        w.removed.push(p);
        w.files.delete(p);
      },
    },
    getJson: async (url) => {
      if (w.release === null) throw new Error(`refused: ${url}`);
      return w.release;
    },
    sleep: async () => undefined,
    serve: async (tree) => void w.served.push(tree),
    stdout: (l) => void w.out.push(l),
  };
}

/** `factory service …` through the CLI's `run`, with the fake machine. */
async function cli(w: World, ...args: string[]): Promise<{ code: number; err: string[] }> {
  const err: string[] = [];
  const io: CliIo = { root: '/nowhere/factory', stdout: (l) => w.out.push(l), stderr: (l) => err.push(l), service: async () => host(w) };
  const code = await run(['service', ...args], io);
  return { code, err };
}

const MUTATING = /^(launchctl (bootstrap|bootout|kickstart|enable|disable|load|unload|remove|kill)|systemctl --user (?!show)|loginctl (?!show-user)|\S*[Tt]ailscale (?!status|serve status))/;
const mutations = (w: World): string[] => w.runs.map((a) => a.join(' ')).filter((l) => MUTATING.test(l));
const noSudo = (w: World): void => {
  for (const a of w.runs) expect(a).not.toContain('sudo');
};

describe('AC1: macOS, the LaunchAgent', () => {
  const spec = { factory: FACTORY, bun: BUN, home: HOME, env: {} };

  test('the plist: label, that factory\'s service run with that bun, RunAtLoad, KeepAlive, and the log', () => {
    const p = renderPlist(spec);
    expect(p).toContain('<key>Label</key>\n  <string>dev.factory.andon</string>');
    expect(p).toContain(`<key>ProgramArguments</key>\n  <array>\n    <string>${BUN}</string>\n    <string>${FACTORY}</string>\n    <string>service</string>\n    <string>run</string>\n  </array>`);
    expect(p).toContain(`<key>PATH</key>\n    <string>/Users/me/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
    expect(p).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(p).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(p).toContain(`<key>StandardOutPath</key>\n  <string>${HOME}/.andon/service.log</string>`);
    expect(p).toContain(`<key>StandardErrorPath</key>\n  <string>${HOME}/.andon/service.log</string>`);
    expect(logPath(HOME)).toBe(`${HOME}/.andon/service.log`);
    expect(p).not.toContain('ANDON_PORT');
    expect(p).not.toContain('ANDON_HOME');
  });

  test('ANDON_PORT and ANDON_HOME are in the plist exactly when set; paths are XML-escaped', () => {
    const both = renderPlist({ ...spec, env: { ANDON_PORT: '9001', ANDON_HOME: '/data/a&b' } });
    expect(both).toContain('<key>ANDON_PORT</key>\n    <string>9001</string>');
    expect(both).toContain('<key>ANDON_HOME</key>\n    <string>/data/a&amp;b</string>');
    expect(recordedPort(both)).toBe(9001);
    const port = renderPlist({ ...spec, env: { ANDON_PORT: '9001' } });
    expect(port).not.toContain('ANDON_HOME');
    expect(renderPlist({ ...spec, factory: '/x/<f>' })).toContain('<string>/x/&lt;f&gt;</string>');
  });

  test('install writes the plist, then bootstraps and starts it in gui/<uid>, with no sudo', async () => {
    const w = world({ env: { ANDON_PORT: '9001' } });
    expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
    expect(launchdPath(HOME)).toBe(PLIST);
    expect(w.files.get(PLIST)).toBe(renderPlist({ ...spec, env: { ANDON_PORT: '9001' } }));
    expect(w.dirs).toEqual([`${HOME}/.andon`]);
    expect(mutations(w)).toEqual([`launchctl bootstrap gui/${UID} ${PLIST}`, `launchctl kickstart gui/${UID}/${LABEL}`]);
    expect(w.out).toEqual([`installed ${LABEL}: ${PLIST}`, `Andon service: http://127.0.0.1:9001/ (runs ${FACTORY} service run)`]);
    noSudo(w);
  });

  test('a second install rewrites the plist and restarts it (bootout, then bootstrap)', async () => {
    const w = world({ files: new Map([[PLIST, 'old']]), loaded: true, pid: 77, holder: 77 });
    expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
    expect(w.files.get(PLIST)).toBe(renderPlist(spec));
    expect(mutations(w)).toEqual([`launchctl bootout gui/${UID}/${LABEL}`, `launchctl bootstrap gui/${UID} ${PLIST}`, `launchctl kickstart gui/${UID}/${LABEL}`]);
    expect(w.out[0]).toBe(`reinstalled ${LABEL}: ${PLIST}`);
    noSudo(w);
  });

  test('a failed launchctl step exits 1 with one line naming it', async () => {
    const w = world({ failOn: `launchctl bootstrap gui/${UID} ${PLIST}` });
    expect(await cli(w, 'install')).toEqual({ code: 1, err: [`service: launchctl bootstrap gui/${UID} ${PLIST} failed: last reason`] });
  });

  test('install refuses a bad ANDON_PORT or a relative ANDON_HOME, writing and running nothing', async () => {
    for (const env of [{ ANDON_PORT: 'x' }, { ANDON_PORT: '0' }, { ANDON_PORT: '70000' }, { ANDON_HOME: 'rel/dir' }]) {
      const w = world({ env });
      const r = await cli(w, 'install');
      expect(r.code).toBe(1);
      expect(r.err).toHaveLength(1);
      expect(w.files.size + w.runs.length).toBe(0);
    }
  });
});

describe('install refuses a bad factory, bun, home, or ANDON_HOME path', () => {
  const bad = (abs: string): [string, string][] => [
    ['relative', 'rel/path'],
    ['newline', `${abs}\nX=1`],
    ['carriage return', `${abs}\rX=1`],
    ['NUL', `${abs}\0x`],
  ];
  const cases: { name: string; what: string; w: () => World; value: string }[] = [];
  for (const platform of ['darwin', 'linux']) {
    for (const [kind, value] of bad(FACTORY)) cases.push({ name: `${platform}: factory ${kind}`, what: 'the factory command', value, w: () => world({ platform, paths: { factory: value } }) });
    for (const [kind, value] of bad(BUN)) cases.push({ name: `${platform}: bun ${kind}`, what: 'bun', value, w: () => world({ platform, paths: { bun: value } }) });
    for (const [kind, value] of bad(HOME)) cases.push({ name: `${platform}: home ${kind}`, what: 'the home directory', value, w: () => world({ platform, paths: { home: value } }) });
    for (const [kind, value] of bad('/tmp/andon')) cases.push({ name: `${platform}: ANDON_HOME ${kind}`, what: 'ANDON_HOME', value, w: () => world({ platform, env: { ANDON_HOME: value } }) });
  }
  for (const c of cases) {
    test(`${c.name}: exit 1, one line naming it, no write, no mkdir, no run`, async () => {
      const w = c.w();
      const r = await cli(w, 'install');
      expect(r.code).toBe(1);
      expect(r.err).toHaveLength(1);
      const line = r.err[0] ?? '';
      expect(line.startsWith(`service: ${c.what} must`)).toBe(true);
      if (c.value.startsWith('/')) expect(line).toContain('must not contain a newline or NUL');
      else expect(line).toContain(JSON.stringify(c.value));
      expect(w.files.size).toBe(0);
      expect(w.dirs).toEqual([]);
      expect(w.runs).toEqual([]);
    });
  }
});

describe('AC2: Linux, the systemd --user unit', () => {
  const spec = { factory: FACTORY, bun: BUN, home: HOME, env: {} };

  test('the unit: that factory\'s service run, Restart=always, WantedBy=default.target, and the env rule', () => {
    const u = renderUnit(spec);
    expect(u).toContain(`ExecStart="${BUN}" "${FACTORY}" "service" "run"`);
    expect(u).toContain('Restart=always');
    expect(u).toContain('[Install]\nWantedBy=default.target');
    expect(u).toContain(`Environment="PATH=${unitPathVar('systemd', BUN)}"`);
    expect(u).not.toContain('ANDON_');
    const both = renderUnit({ ...spec, env: { ANDON_PORT: '9001', ANDON_HOME: '/data/andon' } });
    expect(both).toContain('Environment="ANDON_PORT=9001"');
    expect(both).toContain('Environment="ANDON_HOME=/data/andon"');
    expect(recordedPort(both)).toBe(9001);
    expect(renderUnit({ ...spec, env: { ANDON_HOME: '/d' } })).not.toContain('ANDON_PORT');
  });

  test('specifiers, variables, and quotes in paths are escaped', () => {
    const u = renderUnit({ ...spec, factory: '/a b/%h/$x/"q"', env: { ANDON_HOME: '/h/%n' } });
    expect(u).toContain('"/a b/%%h/$$x/\\"q\\""');
    expect(u).toContain('Environment="ANDON_HOME=/h/%%n"');
  });

  test('the unit path is $XDG_CONFIG_HOME/systemd/user, default ~/.config', () => {
    expect(systemdPath(HOME, {})).toBe(SYSTEMD);
    expect(systemdPath(HOME, { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/systemd/user/andon.service');
    expect(systemdPath(HOME, { XDG_CONFIG_HOME: 'rel' })).toBe(SYSTEMD);
  });

  test('install: daemon-reload and enable --now; lingering off prints one hint line and changes nothing', async () => {
    const w = world({ platform: 'linux', linger: 'no' });
    expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
    expect(w.files.get(SYSTEMD)).toBe(renderUnit(spec));
    expect(mutations(w)).toEqual(['systemctl --user daemon-reload', `systemctl --user enable --now ${UNIT}`]);
    expect(w.runs.filter((a) => a[0] === 'loginctl')).toEqual([lingerQuery(UID)]);
    expect(w.out.filter((l) => l.includes('loginctl enable-linger'))).toEqual([LINGER_HINT]);
    noSudo(w);
  });

  test('lingering on: no hint; a reinstall restarts', async () => {
    const w = world({ platform: 'linux', files: new Map([[SYSTEMD, 'old']]), loaded: true, pid: 55, holder: 55 });
    expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
    expect(mutations(w)).toEqual(['systemctl --user daemon-reload', `systemctl --user enable --now ${UNIT}`, `systemctl --user restart ${UNIT}`]);
    expect(w.out.some((l) => l.includes('enable-linger'))).toBe(false);
    noSudo(w);
  });
});

describe('AC3: uninstall, start, stop, restart', () => {
  test('launchd: start bootstraps an unloaded agent and kickstarts a loaded one; restart kickstarts -k; stop boots it out', async () => {
    const at = (over: Partial<World>): World => world({ files: new Map([[PLIST, 'x']]), ...over });
    let w = at({});
    expect(await cli(w, 'start')).toEqual({ code: 0, err: [] });
    expect(mutations(w)).toEqual([`launchctl bootstrap gui/${UID} ${PLIST}`]);
    w = at({ loaded: true, pid: 9 });
    await cli(w, 'start');
    expect(mutations(w)).toEqual([`launchctl kickstart gui/${UID}/${LABEL}`]);
    w = at({ loaded: true, pid: 9 });
    await cli(w, 'restart');
    expect(mutations(w)).toEqual([`launchctl kickstart -k gui/${UID}/${LABEL}`]);
    w = at({ loaded: true, pid: 9 });
    await cli(w, 'stop');
    expect(mutations(w)).toEqual([`launchctl bootout gui/${UID}/${LABEL}`]);
    expect(w.out).toEqual([`stopped ${LABEL}`]);
    noSudo(w);
  });

  test('systemd: start, stop, and restart pass through to systemctl --user', async () => {
    for (const verb of ['start', 'stop', 'restart']) {
      const w = world({ platform: 'linux', files: new Map([[SYSTEMD, 'x']]) });
      expect(await cli(w, verb)).toEqual({ code: 0, err: [] });
      expect(w.runs.map((a) => a.join(' '))).toEqual([`systemctl --user ${verb} ${UNIT}`]);
    }
  });

  test('start, stop, and restart refuse when not installed, running nothing', async () => {
    for (const platform of ['darwin', 'linux']) {
      const w = world({ platform });
      expect(await cli(w, 'restart')).toEqual({ code: 1, err: [`service: ${platform === 'darwin' ? LABEL : UNIT} is not installed; run factory service install`] });
      expect(w.runs).toEqual([]);
    }
  });

  test('uninstall: launchd boots it out and removes the plist; ~/.andon is untouched', async () => {
    const reg = `${HOME}/.andon/projects.json`;
    const w = world({ files: new Map([[PLIST, 'x'], [reg, '{}']]), loaded: true, pid: 3 });
    expect(await cli(w, 'uninstall')).toEqual({ code: 0, err: [] });
    expect(mutations(w)).toEqual([`launchctl bootout gui/${UID}/${LABEL}`]);
    expect(w.removed).toEqual([PLIST]);
    expect(w.files.get(reg)).toBe('{}');
    noSudo(w);
  });

  test('uninstall: systemd disables --now, removes the unit, and reloads; ~/.andon is untouched', async () => {
    const reg = `${HOME}/.andon/projects.json`;
    const w = world({ platform: 'linux', files: new Map([[SYSTEMD, 'x'], [reg, '{}']]), loaded: true });
    expect(await cli(w, 'uninstall')).toEqual({ code: 0, err: [] });
    expect(mutations(w)).toEqual([`systemctl --user disable --now ${UNIT}`, 'systemctl --user daemon-reload']);
    expect(w.removed).toEqual([SYSTEMD]);
    expect(w.files.get(reg)).toBe('{}');
  });

  test('uninstall with nothing installed says so and removes nothing', async () => {
    const w = world();
    expect(await cli(w, 'uninstall')).toEqual({ code: 0, err: [] });
    expect(w.out).toEqual([`not installed: ${LABEL}`]);
    expect(w.removed).toEqual([]);
  });
});

describe('AC4: the port held by another process', () => {
  for (const platform of ['darwin', 'linux']) {
    test(`${platform}: install refuses with the pid and port, writing no unit and changing nothing`, async () => {
      const w = world({ platform, holder: 4242, loaded: true, pid: 77 });
      expect(await cli(w, 'install')).toEqual({ code: 1, err: [`service: port ${DEFAULT_PORT} is held by pid 4242, not the installed Andon service; stop it, then run factory service install again`] });
      expect(w.files.size).toBe(0);
      expect(w.dirs).toEqual([]);
      expect(mutations(w)).toEqual([]);
      expect(w.out).toEqual([]);
    });
  }
});

describe('AC5: unsupported platforms and Linux without systemd --user', () => {
  for (const w0 of [{ platform: 'win32' }, { platform: 'freebsd' }, { platform: 'linux', systemd: false }]) {
    test(`${JSON.stringify(w0)}: every subcommand but run refuses in one line, writing and running nothing`, async () => {
      for (const sub of ['install', 'uninstall', 'start', 'stop', 'restart', 'status']) {
        const w = world(w0);
        const r = await cli(w, sub);
        expect(r.code).toBe(1);
        expect(r.err).toHaveLength(1);
        expect(r.err[0]).toMatch(/^service: (unsupported platform|systemd --user is not available)/);
        expect({ files: w.files.size, dirs: w.dirs, runs: w.runs, out: w.out }).toEqual({ files: 0, dirs: [], runs: [], out: [] });
      }
      const w = world(w0);
      expect(await cli(w, 'run')).toEqual({ code: 0, err: [] });
      expect(w.served).toHaveLength(1);
    });
  }

  test('usage errors print the usage line', async () => {
    for (const args of [[], ['frob'], ['install', 'extra'], ['run', '--x']]) {
      const w = world();
      expect(await cli(w, ...args)).toEqual({ code: 1, err: [SERVICE_USAGE] });
      expect(w.runs).toEqual([]);
    }
    expect(SERVICE_USAGE).toBe('usage: service install [--tailnet]|uninstall|start|stop|restart|status|run');
  });
});

describe('AC6: status', () => {
  test('launchd, running and current: the block, exit 0', async () => {
    const w = world({ files: new Map([[PLIST, renderPlist({ factory: FACTORY, bun: BUN, home: HOME, env: { ANDON_PORT: '9001' } })]]), loaded: true, pid: 321, release: { running: '0.3.0', onDisk: '0.3.0', changelog: [] } });
    expect(await cli(w, 'status')).toEqual({ code: 0, err: [] });
    expect(w.out).toEqual([
      `service: launchd ${LABEL}, installed (${PLIST})`,
      'running: pid 321',
      'url: http://127.0.0.1:9001/',
      'release: running v0.3.0, on disk v0.3.0',
      `logs: ${HOME}/.andon/service.log`,
    ]);
    expect(mutations(w)).toEqual([]);
  });

  test('systemd, running and behind: restart needed, the journalctl line, exit 0', async () => {
    const w = world({ platform: 'linux', files: new Map([[SYSTEMD, 'x']]), loaded: true, pid: 12, release: { running: '0.2.0', onDisk: '0.3.0', changelog: [] } });
    expect(await cli(w, 'status')).toEqual({ code: 0, err: [] });
    expect(w.out).toEqual([
      `service: systemd --user ${UNIT}, installed (${SYSTEMD})`,
      'running: pid 12',
      `url: http://127.0.0.1:${DEFAULT_PORT}/`,
      'release: running v0.2.0, on disk v0.3.0: restart needed (factory service restart)',
      `logs: ${JOURNAL}`,
    ]);
    expect(JOURNAL).toBe('journalctl --user -u andon.service');
  });

  test('not installed, or not running, or not answering: exit 1', async () => {
    let w = world();
    expect(await cli(w, 'status')).toEqual({ code: 1, err: [] });
    expect(w.out.slice(0, 2)).toEqual([`service: launchd ${LABEL}, not installed`, 'running: no']);
    expect(w.out[3]).toBe('release: unknown (the service is not answering)');
    w = world({ files: new Map([[PLIST, 'x']]), loaded: true, pid: 5 });
    expect(await cli(w, 'status')).toEqual({ code: 1, err: [] });
    expect(w.out[1]).toBe('running: pid 5, but not answering');
    w = world({ platform: 'linux', files: new Map([[SYSTEMD, 'x']]), release: { running: '0.3.0', onDisk: '0.3.0' } });
    expect(await cli(w, 'status')).toEqual({ code: 1, err: [] });
    expect(w.out[1]).toBe('running: no');
  });

  test('the release line tolerates missing fields', () => {
    expect(releaseLine({})).toBe('release: running unknown, on disk unknown');
    expect(releaseLine({ running: null, onDisk: '1.0.0' })).toBe('release: running unknown, on disk v1.0.0: restart needed (factory service restart)');
  });
});

describe('the service manager\'s answers', () => {
  test('launchctl print: loaded with a pid, loaded without one, or not loaded', () => {
    expect(parseLaunchctlPrint(ok('x = {\n\tstate = running\n\tpid = 4567\n}'))).toEqual({ loaded: true, pid: 4567 });
    expect(parseLaunchctlPrint(ok('x = {\n\tstate = not running\n}'))).toEqual({ loaded: true, pid: null });
    expect(parseLaunchctlPrint(fail('Could not find service', 113))).toEqual({ loaded: false, pid: null });
  });
  test('systemctl show: MainPID and ActiveState', () => {
    expect(parseSystemctlShow(ok('MainPID=88\nActiveState=active\n'))).toEqual({ loaded: true, pid: 88 });
    expect(parseSystemctlShow(ok('MainPID=0\nActiveState=inactive\n'))).toEqual({ loaded: false, pid: null });
  });
  test('the port holder: lsof, then ss on Linux', async () => {
    expect(parseLsof('123\n456\n')).toBe(123);
    expect(parseLsof('')).toBeNull();
    expect(parseSs('LISTEN 0 512 127.0.0.1:8766 0.0.0.0:* users:(("bun",pid=999,fd=12))')).toBe(999);
    const asked: string[] = [];
    const fake = async (argv: readonly string[]): Promise<Ran> => {
      asked.push(argv[0] ?? '');
      return argv[0] === 'ss' ? ok('users:(("bun",pid=31,fd=3))') : fail('', 127);
    };
    expect(await lookupPortHolder(8766, fake, 'linux')).toBe(31);
    expect(await lookupPortHolder(8766, fake, 'darwin')).toBeNull();
    expect(asked).toEqual(['lsof', 'ss', 'lsof']);
  });
  test('the factory command is the unresolved path that resolves to the running script', async () => {
    const links: Record<string, string> = { '/bin/factory': '/real/main.ts', '/real/main.ts': '/real/main.ts', '/other': '/x' };
    const resolve = async (p: string): Promise<string> => {
      const r = links[p];
      if (r === undefined) throw new Error('ENOENT');
      return r;
    };
    expect(await factoryCommand('/real/main.ts', ['/usr/bin/bun', '/bin/factory'], resolve)).toBe('/bin/factory');
    expect(await factoryCommand('/real/main.ts', [undefined, 'factory', '/other'], resolve)).toBe('/real/main.ts');
  });
});

describe('AC7: service run serves this CLI\'s tree', () => {
  test('run serves the source tree from source, and the bundle\'s tree from the release bundle', async () => {
    const w = world();
    expect(await cli(w, 'run')).toEqual({ code: 0, err: [] });
    expect(w.served).toEqual([{ uiDir: join(SOURCE_ROOT, 'apps', 'andon-ui', 'dist'), cloneRoot: SOURCE_ROOT, versionFile: 'packages/templates/package.json' }]);
    expect(serviceTree({ kind: 'release', root: '/b', files: { cli: async () => '', contract: async () => '' } })).toEqual({ uiDir: '/b/andon/ui', cloneRoot: '/b', versionFile: 'package.json' });
    expect(await service(['run'], host(w), TREE)).toBe(0);
    expect(w.served.at(-1)).toEqual(TREE);
  });

  describe('the source CLI in a real process', () => {
    let home: string;
    beforeEach(async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'factory-service-run-')));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    test('factory service run answers GET /projects on $ANDON_PORT, in the foreground', async () => {
      await addRoot(registryPath(home), join(home, 'proj'));
      const main = join(import.meta.dir, 'main.ts');
      const proc = Bun.spawn([process.execPath, main, 'service', 'run'], { cwd: home, env: { ...process.env, ANDON_HOME: home, ANDON_PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      try {
        const reader = proc.stdout.getReader();
        let out = '';
        while (!out.includes('\n')) {
          const { done, value } = await reader.read();
          if (done) break;
          out += new TextDecoder().decode(value);
        }
        const url = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        expect(url).toBeDefined();
        const body: unknown = await (await fetch(`${url}/projects`)).json();
        expect(JSON.stringify(body)).toContain(join(home, 'proj'));
        const release: unknown = await (await fetch(`${url}/release`)).json();
        const pkg: unknown = JSON.parse(await readFile(join(SOURCE_ROOT, 'packages', 'templates', 'package.json'), 'utf8'));
        expect(typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : null).toBe(typeof release === 'object' && release !== null && 'running' in release ? release.running : undefined);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 20_000);
  });
});

test('AC7: the root package.json no longer has andon:service', async () => {
  const pkg: unknown = JSON.parse(await readFile(join(SOURCE_ROOT, 'package.json'), 'utf8'));
  const scripts = typeof pkg === 'object' && pkg !== null && 'scripts' in pkg ? pkg.scripts : null;
  expect(typeof scripts === 'object' && scripts !== null && 'andon:service' in scripts).toBe(false);
});

describe('AC8: the docs point to factory service, not bun run andon:service', () => {
  const doc = (...p: string[]): Promise<string> => readFile(join(SOURCE_ROOT, ...p), 'utf8');
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`${heading}\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\n## ', start + heading.length);
    return text.slice(start, next < 0 ? undefined : next);
  };

  test('README "Andon" and docs/upgrade.md name install, run, and restart', async () => {
    const andon = section(await doc('README.md'), '## Andon');
    const upgrade = await doc('docs', 'upgrade.md');
    for (const text of [andon, upgrade]) {
      for (const cmd of ['factory service install', 'factory service run', 'factory service restart']) expect({ cmd, found: text.includes(cmd) }).toEqual({ cmd, found: true });
    }
    expect(andon).not.toContain('bun run andon:service');
    expect(upgrade).not.toMatch(/^bun run andon:service/m);
  });

  test('the contract: the CLI block lists the seven commands, "Andon service" names service run, and a dated changes entry', async () => {
    const v1 = await doc('docs', 'contract', 'v1.md');
    const cli = section(v1, '## CLI');
    for (const sub of ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'run']) expect(cli).toMatch(new RegExp(`^factory service ${sub} +# \\(source or release bundle\\)`, 'm'));
    expect(cli).toContain('### `service`');
    expect(cli).toContain(SERVICE_USAGE);
    const andon = section(v1, '## Andon service');
    expect(andon).toContain('`factory service run`');
    expect(andon).not.toContain('bun run andon:service');
    expect(section(v1, '## Versioning')).toContain('- **2026-10-30: `service`.** Additive within v1');
  });
});

// ---- job 078: the tailnet ----

const SPEC = { factory: FACTORY, bun: BUN, home: HOME, env: {} };
/** With no ANDON_PORT, and with one. */
const ENVS: Record<string, string>[] = [{}, { ANDON_PORT: '9001' }];
const unitAt = (platform: string): string => (platform === 'darwin' ? PLIST : SYSTEMD);
const render = (platform: string, env: Record<string, string>): string => (platform === 'darwin' ? renderPlist({ ...SPEC, env }) : renderUnit({ ...SPEC, env }));
const tsRuns = (w: World): string[] => w.runs.filter((a) => a[0] === w.tsBin || /tailscale/i.test(a[0] ?? '')).map((a) => a.join(' '));
const serveLine = (port: number, bin = TS): string => tailscale.serve(bin, port).join(' ');
const offLine = (port: number, bin = TS): string => tailscale.off(bin, port).join(' ');
const statusLine = (bin = TS): string => tailscale.status(bin).join(' ');
const serveStatusLine = (bin = TS): string => tailscale.serveStatus(bin).join(' ');

describe('job 078 AC3: install --tailnet', () => {
  for (const platform of ['darwin', 'linux']) {
    test(`${platform}: reads status, makes the serve entry, then writes ANDON_TAILNET_HOST beside ANDON_PORT and starts the service`, async () => {
      for (const env of ENVS) {
        const w = world({ platform, env, tsBin: TS });
        const port = env.ANDON_PORT === undefined ? DEFAULT_PORT : 9001;
        expect(await cli(w, 'install', '--tailnet')).toEqual({ code: 0, err: [] });
        expect(tsRuns(w)).toEqual([statusLine(), serveStatusLine(), `${TS} serve --bg --https=${port} http://127.0.0.1:${port}`]);
        expect(w.steps.indexOf(serveLine(port))).toBeLessThan(w.steps.indexOf(`write ${unitAt(platform)}`));
        const unit = w.files.get(unitAt(platform)) ?? '';
        expect(unit).toBe(render(platform, { ...env, ANDON_TAILNET_HOST: NAME }));
        if (platform === 'darwin') expect(unit).toContain(`<key>ANDON_TAILNET_HOST</key>\n    <string>${NAME}</string>`);
        else expect(unit).toContain(`Environment="ANDON_TAILNET_HOST=${NAME}"`);
        if (env.ANDON_PORT !== undefined) {
          const before = unit.indexOf('ANDON_PORT');
          expect(before).toBeGreaterThan(0);
          expect(unit.indexOf('ANDON_TAILNET_HOST')).toBeGreaterThan(before);
        }
        expect(recordedTailnetHost(unit)).toBe(NAME);
        expect(w.entries).toEqual(new Set([port]));
        expect(mutations(w).filter((l) => !l.startsWith(TS))).toEqual(
          platform === 'darwin' ? [`launchctl bootstrap gui/${UID} ${PLIST}`, `launchctl kickstart gui/${UID}/${LABEL}`] : ['systemctl --user daemon-reload', `systemctl --user enable --now ${UNIT}`],
        );
        expect(w.out.slice(0, 3)).toEqual([`installed ${platform === 'darwin' ? LABEL : UNIT}: ${unitAt(platform)}`, `Andon service: http://127.0.0.1:${port}/ (runs ${FACTORY} service run)`, `tailnet: https://${NAME}:${port}/`]);
        noSudo(w);
      }
    });
  }

  test('the name is Self.DNSName with its trailing dot stripped and lowercased', async () => {
    const w = world({ tsBin: TS, tsStatus: { BackendState: 'Running', Self: { DNSName: 'Studio.Manticore-Hue.TS.net.' }, CertDomains: ['studio.manticore-hue.ts.net'] } });
    expect(await cli(w, 'install', '--tailnet')).toEqual({ code: 0, err: [] });
    expect(recordedTailnetHost(w.files.get(PLIST) ?? '')).toBe(NAME);
  });

  test('a reinstall over an entry already on the port re-serves it, and other serve entries are left alone', async () => {
    const w = world({ tsBin: TS, files: new Map([[PLIST, renderPlist({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } })]]), loaded: true, pid: 7, holder: 7, entries: new Set([443, DEFAULT_PORT]) });
    expect(await cli(w, 'install', '--tailnet')).toEqual({ code: 0, err: [] });
    expect(tsRuns(w)).toEqual([statusLine(), serveStatusLine(), serveLine(DEFAULT_PORT)]);
    expect(w.entries).toEqual(new Set([443, DEFAULT_PORT]));
    expect(w.out[0]).toBe(`reinstalled ${LABEL}: ${PLIST}`);
  });

  test('the CLI is found on PATH, or else on macOS at the app-bundle path, and install runs the one it found', async () => {
    const which = (found: string | null) => (cmd: string): string | null => (cmd === 'tailscale' ? found : null);
    expect(findTailscale('darwin', which('/opt/homebrew/bin/tailscale'), () => true)).toBe('/opt/homebrew/bin/tailscale');
    expect(findTailscale('darwin', which(null), (p) => p === TAILSCALE_APP)).toBe(TAILSCALE_APP);
    expect(findTailscale('darwin', which(null), () => false)).toBeNull();
    expect(findTailscale('linux', which('/usr/bin/tailscale'), () => false)).toBe('/usr/bin/tailscale');
    expect(findTailscale('linux', which(null), () => true)).toBeNull();
    expect(TAILSCALE_APP).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    const w = world({ tsBin: TAILSCALE_APP });
    expect(await cli(w, 'install', '--tailnet')).toEqual({ code: 0, err: [] });
    expect(tsRuns(w)).toEqual([statusLine(TAILSCALE_APP), serveStatusLine(TAILSCALE_APP), serveLine(DEFAULT_PORT, TAILSCALE_APP)]);
  });
});

describe('job 078 AC4: install --tailnet refusals', () => {
  // `tried`: a changing command that ran and failed, so changed nothing (a denied `tailscale serve`).
  const refused = (w: World, r: { code: number; err: string[] }, tried: string[] = []): void => {
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(w.files.size).toBe(0);
    expect(w.dirs).toEqual([]);
    expect(w.entries.size).toBe(0);
    expect(mutations(w)).toEqual(tried);
    expect(w.out).toEqual([]);
    noSudo(w);
  };

  for (const platform of ['darwin', 'linux']) {
    test(`${platform}: no tailscale CLI`, async () => {
      const w = world({ platform, tsBin: null });
      const r = await cli(w, 'install', '--tailnet');
      refused(w, r);
      expect(r.err[0]).toStartWith('service: no tailscale CLI found (not on PATH');
      if (platform === 'darwin') expect(r.err[0]).toContain(TAILSCALE_APP);
      else expect(r.err[0]).not.toContain(TAILSCALE_APP);
    });

    test(`${platform}: Tailscale logged out or stopped (BackendState not Running)`, async () => {
      for (const state of ['NeedsLogin', 'Stopped', 'Starting']) {
        const w = world({ platform, tsBin: TS, tsStatus: { BackendState: state, Self: { DNSName: `${NAME}.` }, CertDomains: [NAME] } });
        const r = await cli(w, 'install', '--tailnet');
        refused(w, r);
        expect(r.err[0]).toContain(`BackendState ${state}`);
        expect(tsRuns(w)).toEqual([statusLine()]);
      }
    });

    test(`${platform}: HTTPS certificates not enabled (CertDomains lacks the name)`, async () => {
      for (const certs of [{}, { CertDomains: [] }, { CertDomains: ['rocinante.manticore-hue.ts.net'] }, { CertDomains: null }]) {
        const w = world({ platform, tsBin: TS, tsStatus: { BackendState: 'Running', Self: { DNSName: `${NAME}.` }, ...certs } });
        const r = await cli(w, 'install', '--tailnet');
        refused(w, r);
        expect(r.err[0]).toBe(`service: HTTPS certificates are not enabled on this tailnet (CertDomains lacks ${NAME}); enable HTTPS in the Tailscale admin console, then run factory service install --tailnet again`);
      }
    });

    test(`${platform}: tailscale status failing, or not naming this machine, is one line`, async () => {
      let w = world({ platform, tsBin: TS, answers: { [statusLine()]: fail('failed to connect to local tailscaled; it doesn’t appear to be running') } });
      let r = await cli(w, 'install', '--tailnet');
      refused(w, r);
      expect(r.err[0]).toStartWith(`service: ${statusLine()} failed: failed to connect`);
      for (const tsStatus of [{ BackendState: 'Running', CertDomains: [NAME] }, { BackendState: 'Running', Self: { DNSName: 'not a name' }, CertDomains: [NAME] }]) {
        w = world({ platform, tsBin: TS, tsStatus });
        r = await cli(w, 'install', '--tailnet');
        refused(w, r);
        expect(r.err[0]).toStartWith('service: Tailscale reports no MagicDNS name for this machine');
      }
      w = world({ platform, tsBin: TS, answers: { [statusLine()]: ok('not json') } });
      r = await cli(w, 'install', '--tailnet');
      refused(w, r);
    });
  }

  test('linux: tailscale serve denied for want of an operator is exactly the sudo tailscale set --operator=$USER line, and no sudo runs', async () => {
    for (const denial of [fail("Access denied: serve config denied\nUse 'sudo tailscale serve --bg 8766' or 'tailscale set --operator=$USER' to allow"), { code: 1, stdout: 'access denied', stderr: '' }]) {
      const w = world({ platform: 'linux', tsBin: TS, answers: { [serveLine(DEFAULT_PORT)]: denial } });
      const r = await cli(w, 'install', '--tailnet');
      refused(w, r, [serveLine(DEFAULT_PORT)]);
      expect(r.err).toEqual([OPERATOR_LINE]);
      expect(OPERATOR_LINE).toContain('sudo tailscale set --operator=$USER');
      expect(tsRuns(w)).toEqual([statusLine(), serveStatusLine(), serveLine(DEFAULT_PORT)]);
    }
  });

  test('another tailscale serve failure is one line naming it; on macOS an operator-like denial is not the Linux line', async () => {
    for (const platform of ['darwin', 'linux']) {
      const w = world({ platform, tsBin: TS, answers: { [serveLine(DEFAULT_PORT)]: fail(platform === 'darwin' ? 'access denied' : 'serve: port in use') } });
      const r = await cli(w, 'install', '--tailnet');
      refused(w, r, [serveLine(DEFAULT_PORT)]);
      expect(r.err[0]).toBe(`service: ${serveLine(DEFAULT_PORT)} failed: ${platform === 'darwin' ? 'access denied' : 'serve: port in use'}`);
    }
  });

  test('the existing refusals come first and run no tailscale command', async () => {
    const cases: World[] = [
      world({ tsBin: TS, holder: 4242 }),
      world({ platform: 'linux', tsBin: TS, holder: 4242 }),
      world({ tsBin: TS, env: { ANDON_PORT: 'x' } }),
      world({ tsBin: TS, env: { ANDON_HOME: 'rel' } }),
      world({ tsBin: TS, paths: { factory: 'rel/factory' } }),
      world({ platform: 'linux', tsBin: TS, paths: { bun: `${BUN}\nX=1` } }),
      world({ platform: 'win32', tsBin: TS }),
    ];
    for (const w of cases) {
      const r = await cli(w, 'install', '--tailnet');
      refused(w, r);
      expect(tsRuns(w)).toEqual([]);
    }
  });

  for (const platform of ['darwin', 'linux']) {
    test(`${platform}: a unit step failing after tailscale serve removes the entry again and puts the old unit back`, async () => {
      const step = platform === 'darwin' ? `launchctl bootstrap gui/${UID} ${PLIST}` : `systemctl --user enable --now ${UNIT}`;
      for (const old of [null, render(platform, {})]) {
        const w = world({ platform, tsBin: TS, failOn: step, entries: new Set([443]), files: old === null ? new Map() : new Map([[unitAt(platform), old]]) });
        const r = await cli(w, 'install', '--tailnet');
        expect(r).toEqual({ code: 1, err: [`service: ${step} failed: last reason`] });
        expect(tsRuns(w)).toEqual([statusLine(), serveStatusLine(), serveLine(DEFAULT_PORT), offLine(DEFAULT_PORT)]);
        expect(w.entries).toEqual(new Set([443]));
        expect(w.files.get(unitAt(platform)) ?? null).toBe(old);
        noSudo(w);
      }
    });
  }

  test('when the rollback\'s off fails too, the one line says so and names the command to run', async () => {
    const step = `launchctl bootstrap gui/${UID} ${PLIST}`;
    const w = world({ tsBin: TS, answers: { [step]: fail('Bootstrap failed: 5'), [offLine(DEFAULT_PORT)]: fail('no') } });
    expect(await cli(w, 'install', '--tailnet')).toEqual({ code: 1, err: [`service: ${step} failed: Bootstrap failed: 5; removing the serve entry again failed too: run tailscale serve --https=${DEFAULT_PORT} off`] });
    expect(w.files.size).toBe(0);
  });

  test('when removing the old port\'s entry fails after the new unit runs, the one line names it and the command to run', async () => {
    const w = world({ tsBin: TS, failOn: offLine(9001), files: new Map([[PLIST, renderPlist({ ...SPEC, env: { ANDON_PORT: '9001', ANDON_TAILNET_HOST: NAME } })]]), entries: new Set([9001]) });
    const r = await cli(w, 'install', '--tailnet');
    expect(r).toEqual({ code: 1, err: [`service: ${offLine(9001)} failed: last reason; the service is installed on port ${DEFAULT_PORT}, but the old serve entry on https port 9001 is still there: run tailscale serve --https=9001 off`] });
    expect(w.entries).toEqual(new Set([9001, DEFAULT_PORT]));
  });

  test('a failed unit step over a unit that already records the name keeps that entry and that unit', async () => {
    const old = renderPlist({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } });
    const w = world({ tsBin: TS, failOn: `launchctl bootstrap gui/${UID} ${PLIST}`, files: new Map([[PLIST, old]]), entries: new Set([DEFAULT_PORT]) });
    expect((await cli(w, 'install', '--tailnet')).code).toBe(1);
    expect(tsRuns(w)).toEqual([statusLine(), serveStatusLine(), serveLine(DEFAULT_PORT)]);
    expect(w.entries).toEqual(new Set([DEFAULT_PORT]));
    expect(w.files.get(PLIST)).toBe(old);
  });
});

describe('job 078 AC5: install without --tailnet', () => {
  for (const platform of ['darwin', 'linux']) {
    test(`${platform}: a unit recording no tailnet host is rewritten byte-identical, and no tailscale command runs`, async () => {
      const w = world({ platform, tsBin: TS, files: new Map([[unitAt(platform), render(platform, {})]]), entries: new Set([DEFAULT_PORT]) });
      expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
      expect(w.files.get(unitAt(platform))).toBe(render(platform, {}));
      expect(w.files.get(unitAt(platform))).not.toContain('ANDON_TAILNET_HOST');
      expect(tsRuns(w)).toEqual([]);
      expect(w.entries).toEqual(new Set([DEFAULT_PORT])); // not ours: untouched
      expect(w.out.some((l) => l.startsWith('tailnet:'))).toBe(false);
    });

    test(`${platform}: a unit recording one: the --https=<port> entry is removed before the unit is rewritten without it`, async () => {
      for (const env of ENVS) {
        const port = env.ANDON_PORT === undefined ? DEFAULT_PORT : 9001;
        const w = world({ platform, env, tsBin: TS, files: new Map([[unitAt(platform), render(platform, { ...env, ANDON_TAILNET_HOST: NAME })]]), entries: new Set([443, port]) });
        expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
        expect(tsRuns(w)).toEqual([serveStatusLine(), offLine(port)]);
        expect(w.steps.indexOf(offLine(port))).toBeLessThan(w.steps.indexOf(`write ${unitAt(platform)}`));
        expect(w.files.get(unitAt(platform))).toBe(render(platform, env));
        expect(w.entries).toEqual(new Set([443]));
        expect(w.out).toContain('tailnet: off');
        noSudo(w);
      }
    });
  }

  test('a recorded host whose entry is already gone: no off, and the unit is rewritten without it', async () => {
    const w = world({ tsBin: TS, files: new Map([[PLIST, renderPlist({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } })]]) });
    expect(await cli(w, 'install')).toEqual({ code: 0, err: [] });
    expect(tsRuns(w)).toEqual([serveStatusLine()]);
    expect(w.files.get(PLIST)).toBe(renderPlist(SPEC));
  });

  test('when the entry cannot be removed (no CLI, or off failing), install exits 1 with one line and keeps the unit', async () => {
    const recorded = renderPlist({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } });
    for (const over of [{ tsBin: null }, { tsBin: TS, failOn: offLine(DEFAULT_PORT) }, { tsBin: TS, answers: { [serveStatusLine()]: fail('no tailscaled') } }]) {
      const w = world({ ...over, files: new Map([[PLIST, recorded]]), entries: new Set([DEFAULT_PORT]) });
      const r = await cli(w, 'install');
      expect(r.code).toBe(1);
      expect(r.err).toHaveLength(1);
      expect(w.files.get(PLIST)).toBe(recorded);
      expect(mutations(w).filter((l) => l.startsWith('launchctl'))).toEqual([]);
      expect(w.entries).toEqual(new Set([DEFAULT_PORT]));
    }
  });

  test('install --tailnet over a unit recording another port removes the old port\'s entry, after the new unit runs', async () => {
    const w = world({ tsBin: TS, files: new Map([[PLIST, renderPlist({ ...SPEC, env: { ANDON_PORT: '9001', ANDON_TAILNET_HOST: NAME } })]]), entries: new Set([443, 9001]) });
    expect(await cli(w, 'install', '--tailnet')).toEqual({ code: 0, err: [] });
    expect(tsRuns(w)).toEqual([statusLine(), serveStatusLine(), serveLine(DEFAULT_PORT), serveStatusLine(), offLine(9001)]);
    expect(w.steps.indexOf(offLine(9001))).toBeGreaterThan(w.steps.indexOf(`launchctl kickstart gui/${UID}/${LABEL}`));
    expect(w.entries).toEqual(new Set([443, DEFAULT_PORT]));
    expect(w.files.get(PLIST)).toBe(renderPlist({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } }));
  });
});

describe('job 078 AC6: uninstall, status, and usage', () => {
  for (const platform of ['darwin', 'linux']) {
    test(`${platform}: uninstall removes the recorded port's serve entry before the unit`, async () => {
      for (const env of ENVS) {
        const port = env.ANDON_PORT === undefined ? DEFAULT_PORT : 9001;
        const w = world({ platform, tsBin: TS, loaded: true, pid: 3, files: new Map([[unitAt(platform), render(platform, { ...env, ANDON_TAILNET_HOST: NAME })]]), entries: new Set([443, port]) });
        expect(await cli(w, 'uninstall')).toEqual({ code: 0, err: [] });
        expect(tsRuns(w)).toEqual([serveStatusLine(), offLine(port)]);
        expect(w.steps.indexOf(offLine(port))).toBeLessThan(w.steps.indexOf(`remove ${unitAt(platform)}`));
        expect(w.removed).toEqual([unitAt(platform)]);
        expect(w.entries).toEqual(new Set([443]));
        noSudo(w);
      }
    });

    test(`${platform}: when removing the entry fails, uninstall exits 1 with one line and keeps the unit`, async () => {
      const recorded = render(platform, { ANDON_TAILNET_HOST: NAME });
      for (const over of [{ tsBin: TS, failOn: offLine(DEFAULT_PORT) }, { tsBin: null }]) {
        const w = world({ platform, ...over, loaded: true, pid: 3, files: new Map([[unitAt(platform), recorded]]), entries: new Set([DEFAULT_PORT]) });
        const r = await cli(w, 'uninstall');
        expect(r.code).toBe(1);
        expect(r.err).toHaveLength(1);
        expect(r.err[0]).toEndWith('; the unit is kept');
        expect(w.files.get(unitAt(platform))).toBe(recorded);
        expect(w.removed).toEqual([]);
        expect(mutations(w).filter((l) => !l.startsWith(TS))).toEqual([]);
      }
    });
  }

  test('uninstall of a unit recording no host runs no tailscale command', async () => {
    const w = world({ tsBin: TS, loaded: true, pid: 3, files: new Map([[PLIST, renderPlist(SPEC)]]), entries: new Set([DEFAULT_PORT]) });
    expect(await cli(w, 'uninstall')).toEqual({ code: 0, err: [] });
    expect(tsRuns(w)).toEqual([]);
    expect(w.entries).toEqual(new Set([DEFAULT_PORT]));
  });

  test('status prints the tailnet line after url: when the unit records a host, and exactly five lines when not', async () => {
    const release = { running: '0.3.0', onDisk: '0.3.0', changelog: [] };
    let w = world({ tsBin: TS, files: new Map([[PLIST, renderPlist({ ...SPEC, env: { ANDON_PORT: '9001', ANDON_TAILNET_HOST: NAME } })]]), loaded: true, pid: 321, release });
    expect(await cli(w, 'status')).toEqual({ code: 0, err: [] });
    expect(w.out).toEqual([`service: launchd ${LABEL}, installed (${PLIST})`, 'running: pid 321', 'url: http://127.0.0.1:9001/', `tailnet: https://${NAME}:9001/`, 'release: running v0.3.0, on disk v0.3.0', `logs: ${HOME}/.andon/service.log`]);
    expect(tsRuns(w)).toEqual([]);
    w = world({ platform: 'linux', tsBin: TS, files: new Map([[SYSTEMD, renderUnit({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } })]]), loaded: true, pid: 12, release });
    await cli(w, 'status');
    expect(w.out[3]).toBe(`tailnet: https://${NAME}:${DEFAULT_PORT}/`);
    expect(w.out).toHaveLength(6);
    w = world({ tsBin: TS, files: new Map([[PLIST, renderPlist(SPEC)]]), loaded: true, pid: 321, release });
    await cli(w, 'status');
    expect(w.out).toHaveLength(5);
    expect(w.out.some((l) => l.startsWith('tailnet:'))).toBe(false);
  });

  test('the usage line names install [--tailnet]; --tailnet anywhere else, or any other flag, is a usage error', async () => {
    expect(SERVICE_USAGE).toContain('install [--tailnet]');
    for (const args of [['install', '--tailnet', '--tailnet'], ['install', '--tailnet', 'x'], ['install', '--other'], ['install', '--tailnet=1'], ['install', '--TAILNET'], ['uninstall', '--tailnet'], ['start', '--tailnet'], ['stop', '--tailnet'], ['restart', '--tailnet'], ['status', '--tailnet'], ['run', '--tailnet'], ['--tailnet'], ['--tailnet', 'install']]) {
      const w = world({ tsBin: TS });
      expect({ args, ...(await cli(w, ...args)) }).toEqual({ args, code: 1, err: [SERVICE_USAGE] });
      expect(w.runs).toEqual([]);
      expect(w.files.size).toBe(0);
    }
  });
});

describe('job 078: what tailscale prints', () => {
  test('status --json: Running, a DNS name, and that name in CertDomains', () => {
    expect(parseTailscaleStatus(JSON.stringify(RUNNING))).toEqual({ ok: true, name: NAME });
    expect(parseTailscaleStatus(JSON.stringify({ ...RUNNING, CertDomains: [`${NAME}.`] }))).toEqual({ ok: true, name: NAME });
    for (const bad of ['', '[]', 'null', '"x"', JSON.stringify({ ...RUNNING, BackendState: 'NeedsLogin' }), JSON.stringify({ ...RUNNING, Self: null }), JSON.stringify({ ...RUNNING, Self: { DNSName: 'x:1.ts.net' } }), JSON.stringify({ ...RUNNING, CertDomains: 'x' })]) {
      expect({ bad, ok: parseTailscaleStatus(bad).ok }).toEqual({ bad, ok: false });
    }
  });
  test('serve status --json: an entry on the port is a TCP port or a Web <host>:<port>; anything else is none', () => {
    expect(hasServeEntry(JSON.stringify(serveConfig([8766])), 8766)).toBe(true);
    expect(hasServeEntry(JSON.stringify({ Web: { [`${NAME}:8766`]: {} } }), 8766)).toBe(true);
    expect(hasServeEntry(JSON.stringify({ TCP: { '8766': {} } }), 8766)).toBe(true);
    expect(hasServeEntry(JSON.stringify(serveConfig([443])), 8766)).toBe(false);
    expect(hasServeEntry(JSON.stringify(serveConfig([18766])), 8766)).toBe(false);
    expect(hasServeEntry('{}', 8766)).toBe(false);
    expect(hasServeEntry('', 8766)).toBeNull();
    expect(hasServeEntry('[]', 8766)).toBeNull();
  });
  test('recordedTailnetHost reads the plist and the systemd unit', () => {
    expect(recordedTailnetHost(renderPlist({ ...SPEC, env: { ANDON_TAILNET_HOST: NAME } }))).toBe(NAME);
    expect(recordedTailnetHost(renderUnit({ ...SPEC, env: { ANDON_PORT: '1', ANDON_TAILNET_HOST: NAME } }))).toBe(NAME);
    expect(recordedTailnetHost(renderPlist(SPEC))).toBeNull();
    expect(recordedTailnetHost(renderUnit(SPEC))).toBeNull();
  });
});

describe('job 078 AC7: the contract and the decisions record the tailnet', () => {
  const doc = (...p: string[]): Promise<string> => readFile(join(SOURCE_ROOT, ...p), 'utf8');
  const section = (text: string, heading: string, next = '\n## '): string => {
    const start = text.indexOf(`${heading}\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(next, start + heading.length);
    return text.slice(start, end < 0 ? undefined : end);
  };

  test('"Andon service" states the guard accepts the recorded tailnet host, and only when one is recorded', async () => {
    const andon = section(await doc('docs', 'contract', 'v1.md'), '## Andon service');
    for (const s of ['`$ANDON_TAILNET_HOST`', '`Host` of `<name>:<port>`', '`Origin` of `https://<name>:<port>`', 'When a tailnet host is recorded', 'never another `*.ts.net` name', 'With no tailnet host, the guard is as\nabove', 'listens on `127.0.0.1` only']) {
      expect({ s, found: andon.includes(s) }).toEqual({ s, found: true });
    }
  });

  test('"`service`" states install --tailnet and its refusals, the unit, turning it off, uninstall, status, and the usage line', async () => {
    const v1 = await doc('docs', 'contract', 'v1.md');
    const svc = section(v1, '### `service`', '\n### ');
    for (const s of [
      '`install --tailnet`',
      '`tailscale serve --bg --https=<port> http://127.0.0.1:<port>`',
      '`ANDON_TAILNET_HOST`',
      'beside `ANDON_PORT`',
      '`BackendState` is not `Running`',
      '`CertDomains` lacks the',
      'there is no `tailscale` CLI',
      '`sudo tailscale set --operator=$USER`',
      '`install` without `--tailnet` records no `ANDON_TAILNET_HOST`, so it turns tailnet access off',
      'When the unit records a\n  tailnet host, it first removes that unit\'s `--https=<port>` serve entry',
      '`tailnet: https://<name>:<port>/`',
      SERVICE_USAGE,
    ]) {
      expect({ s, found: svc.includes(s) }).toEqual({ s, found: true });
    }
    expect(section(v1, '## CLI')).toMatch(/^factory service install --tailnet +# \(source or release bundle\)/m);
    expect(section(v1, '## Versioning')).toContain('- **2026-10-30: the Andon service over the tailnet.** Additive within v1');
  });

  test('decision 10 carries the dated amendment, and "Andon across multiple machines" is gone from Deferred', async () => {
    const decisions = await doc('docs', 'decisions.md');
    const ten = decisions.slice(decisions.indexOf('10. **Andon architecture:**'), decisions.indexOf('11. **The factory builds itself.**'));
    expect(ten).toContain('Amended 2026-10-30 (approved by Matt; brief `factory/briefs/andon-peer-access.md`)');
    expect(ten).toContain('`factory service install --tailnet`');
    expect(ten).toContain('`tailscale serve`');
    const deferred = section(decisions, '## Deferred (don\'t build yet)');
    expect(deferred).not.toContain('Andon across multiple machines');
    expect(deferred).toContain('Adding or removing projects from Andon');
  });
});
