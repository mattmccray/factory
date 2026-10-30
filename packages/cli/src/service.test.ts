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
  SERVICE_USAGE,
  UNIT,
  launchctl,
  launchdPath,
  lingerQuery,
  logPath,
  parseLaunchctlPrint,
  parseSystemctlShow,
  recordedPort,
  releaseLine,
  renderPlist,
  renderUnit,
  service,
  systemctl,
  systemdPath,
  unitPathVar,
} from './service';
import type { Ran, ServiceHost } from './service';
import { factoryCommand, lookupPortHolder, parseLsof, parseSs } from './servicehost';

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
}

function world(over: Partial<World> = {}): World {
  return { platform: 'darwin', env: {}, systemd: true, files: new Map(), dirs: [], removed: [], runs: [], out: [], served: [], loaded: false, pid: null, holder: null, linger: 'yes', release: null, ...over };
}

function host(w: World): ServiceHost {
  return {
    platform: w.platform,
    home: HOME,
    uid: UID,
    env: w.env,
    factory: FACTORY,
    bun: BUN,
    run: async (argv) => {
      const a = [...argv];
      w.runs.push(a);
      const line = a.join(' ');
      if (w.failOn === line) return fail('Boom\nlast reason');
      if (line === launchctl.print(UID).join(' ')) return w.loaded ? ok(`gui/${UID}/${LABEL} = {\n\tstate = ${w.pid === null ? 'not running' : 'running'}\n${w.pid === null ? '' : `\tpid = ${w.pid}\n`}}`) : fail('Could not find service', 113);
      if (line === launchctl.bootout(UID).join(' ')) w.loaded = false;
      if (line === launchctl.bootstrap(UID, PLIST).join(' ')) w.loaded = true;
      if (line === systemctl.show().join(' ')) return ok(`MainPID=${w.pid ?? 0}\nActiveState=${w.loaded ? 'active' : 'inactive'}\n`);
      if (a[0] === 'loginctl') return ok(`${w.linger}\n`);
      return ok();
    },
    systemd: async () => w.systemd,
    portHolder: async () => w.holder,
    fs: {
      exists: async (p) => w.files.has(p),
      read: async (p) => w.files.get(p) ?? null,
      write: async (p, t) => void w.files.set(p, t),
      mkdir: async (p) => void w.dirs.push(p),
      remove: async (p) => {
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

const MUTATING = /^(launchctl (bootstrap|bootout|kickstart|enable|disable|load|unload|remove|kill)|systemctl --user (?!show)|loginctl (?!show-user))/;
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
    expect(SERVICE_USAGE).toBe('usage: service install|uninstall|start|stop|restart|status|run');
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
