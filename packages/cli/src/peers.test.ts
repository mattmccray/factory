import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peersPath } from '@factory/contract';
import { run, USAGE } from './index';
import { PEERS_USAGE, ownMachineName, reportedName, tailnetPeerNames } from './peers';
import { GetJsonError, launchdPath } from './service';
import type { Ran, ServiceHost } from './service';
import { getJson } from './servicehost';

const STUDIO = 'https://studio.manticore-hue.ts.net:8766';
const AGENT = 'https://agentbox.manticore-hue.ts.net:8766';
const TS = '/usr/local/bin/tailscale';
const HOME = '/Users/me';

const STATUS = {
  BackendState: 'Running',
  Self: { DNSName: 'rocinante.manticore-hue.ts.net.' },
  Peer: {
    'nodekey:1': { DNSName: 'Studio.manticore-hue.ts.net.' },
    'nodekey:2': { DNSName: 'agentbox.manticore-hue.ts.net.' },
    'nodekey:3': { HostName: 'no-dns' },
  },
};

/** What a peer answers on an endpoint: a body, or an error to throw. */
type Answer = { body: unknown } | { error: Error };

const machinesOf = (name: string): Answer => ({ body: { machines: [{ name, url: `https://${name}.manticore-hue.ts.net:8766`, state: 'live', since: '2026-10-30T00:00:00.000Z', reason: null, release: '0.2.0' }] } });
const projectsOf = (machine: string): Answer => ({ body: { projects: [{ id: '0123456789ab', name: 'p', root: '/r', release: { installed: null, state: 'unknown' }, machine }] } });

interface World {
  tsBin: string | null;
  tsStatus: unknown;
  tsCode: number;
  answers: Map<string, Answer>; // full URL → answer; a URL with none is unreachable
  gets: string[];
  runs: string[];
  unit: string | null; // the launchd unit's text
  hostname: string;
}

function world(over: Partial<World> = {}): World {
  const answers = new Map<string, Answer>([
    [`${STUDIO}/machines`, machinesOf('studio')],
    [`${STUDIO}/projects?scope=local`, projectsOf('studio')],
    [`${AGENT}/machines`, machinesOf('agentbox')],
    [`${AGENT}/projects?scope=local`, projectsOf('agentbox')],
  ]);
  return { tsBin: TS, tsStatus: STATUS, tsCode: 0, answers, gets: [], runs: [], unit: null, hostname: 'Rocinante.local', ...over };
}

function host(w: World): ServiceHost {
  return {
    platform: 'darwin',
    home: HOME,
    uid: 501,
    env: {},
    factory: '/f',
    bun: '/b',
    run: async (argv): Promise<Ran> => {
      w.runs.push(argv.join(' '));
      if (argv.join(' ') === `${TS} status --json`) return { code: w.tsCode, stdout: w.tsCode === 0 ? JSON.stringify(w.tsStatus) : '', stderr: w.tsCode === 0 ? '' : 'failed to connect' };
      return { code: 0, stdout: '', stderr: '' };
    },
    systemd: async () => false,
    portHolder: async () => null,
    tailscale: async () => w.tsBin,
    fs: {
      exists: async () => false,
      read: async (p) => (p === launchdPath(HOME) ? w.unit : null),
      write: async () => {
        throw new Error('peers must never write a unit');
      },
      mkdir: async () => undefined,
      remove: async () => undefined,
    },
    hostname: w.hostname,
    getJson: async (url) => {
      w.gets.push(url);
      const a = w.answers.get(url);
      if (a === undefined) throw new Error('connect ECONNREFUSED');
      if ('error' in a) throw a.error;
      return a.body;
    },
    sleep: async () => undefined,
    serve: async () => undefined,
    stdout: () => undefined,
  };
}

let tmp: string;
let file: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'factory-peers-'));
  file = peersPath(join(tmp, 'andon'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string[];
  err: string[];
}
async function cli(w: World, ...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['peers', ...argv], { root: join(tmp, 'nowhere', 'factory'), peers: file, stdout: (l) => out.push(l), stderr: (l) => err.push(l), service: async () => host(w) });
  return { code, out, err };
}
async function seed(...urls: string[]): Promise<string> {
  const text = `${JSON.stringify({ schema: 'factory/v1', peers: urls.map((url) => ({ url })) }, null, 2)}\n`;
  await mkdir(join(tmp, 'andon'), { recursive: true });
  await writeFile(file, text);
  return text;
}
const left = async (): Promise<string[]> => readdir(join(tmp, 'andon')).catch((): string[] => []);
const exists = async (): Promise<boolean> => (await left()).includes('peers.json');

describe('peers list and remove (AC1)', () => {
  test('list prints no peers with no file, and writes nothing', async () => {
    expect(await cli(world(), 'list')).toEqual({ code: 0, out: ['no peers'], err: [] });
    expect(await exists()).toBe(false);
  });

  test('list prints one URL per line, in file order, and writes nothing', async () => {
    const text = await seed(STUDIO, AGENT);
    expect(await cli(world(), 'list')).toEqual({ code: 0, out: [STUDIO, AGENT], err: [] });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test('remove <url> and remove <machine> print removed <url>', async () => {
    await seed(STUDIO, AGENT);
    expect(await cli(world(), 'remove', 'https://Studio.manticore-hue.ts.net:8766/')).toEqual({ code: 0, out: [`removed ${STUDIO}`], err: [] });
    expect(await cli(world(), 'remove', 'agentbox')).toEqual({ code: 0, out: [`removed ${AGENT}`], err: [] });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema: 'factory/v1', peers: [] });
    expect(await left()).toEqual(['peers.json']);
  });

  test('remove of an unmatched argument prints not listed, exits 1, and writes nothing', async () => {
    const text = await seed(STUDIO);
    for (const arg of ['goliath', AGENT, 'http://nope']) {
      expect(await cli(world(), 'remove', arg)).toEqual({ code: 1, out: [], err: [`not listed: ${arg}`] });
    }
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test('remove <machine> that names two listed URLs refuses and writes nothing', async () => {
    const text = await seed(STUDIO, 'https://studio.manticore-hue.ts.net:9000');
    const r = await cli(world(), 'remove', 'studio');
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain('more than one peer');
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test('a bad peers.json makes every subcommand print its one-line reason, exit 1, and write nothing', async () => {
    await mkdir(join(tmp, 'andon'), { recursive: true });
    const text = JSON.stringify({ schema: 'factory/v1', peers: [], extra: true });
    await writeFile(file, text);
    for (const argv of [['list'], ['remove', 'studio'], ['add', 'studio'], ['add', STUDIO]]) {
      const w = world();
      const r = await cli(w, ...argv);
      expect(r).toEqual({ code: 1, out: [], err: ["peers: unknown key 'extra'"] });
      expect(w.gets).toEqual([]);
    }
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(await left()).toEqual(['peers.json']);
  });

  test('a usage error prints the usage line and exits 1', async () => {
    expect(PEERS_USAGE).toBe('usage: peers add <machine|url> | remove <machine|url> | list');
    expect(USAGE.peers).toBe(PEERS_USAGE);
    for (const argv of [[], ['nope'], ['list', 'x'], ['add'], ['remove'], ['add', 'a', 'b'], ['add', '']]) {
      expect(await cli(world(), ...argv)).toEqual({ code: 1, out: [], err: [PEERS_USAGE] });
    }
    expect(await exists()).toBe(false);
  });

  test('peers needs no factory/ directory and reads no config', async () => {
    // `cli` runs with a root that does not exist; list still works.
    expect((await cli(world(), 'list')).code).toBe(0);
  });
});

describe('peers add (AC2)', () => {
  test('add <machine> resolves through tailscale, checks the peer, and lists it', async () => {
    const w = world();
    expect(await cli(w, 'add', 'studio')).toEqual({ code: 0, out: [`added studio ${STUDIO}`], err: [] });
    expect(w.runs).toEqual([`${TS} status --json`]);
    expect(w.gets).toEqual([`${STUDIO}/machines`, `${STUDIO}/projects?scope=local`]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema: 'factory/v1', peers: [{ url: STUDIO }] });
    expect(await left()).toEqual(['peers.json']);
  });

  test('add <url> stores the normalized URL with no tailscale run', async () => {
    const w = world({ tsBin: null });
    expect(await cli(w, 'add', 'https://STUDIO.manticore-hue.ts.net:8766/')).toEqual({ code: 0, out: [`added studio ${STUDIO}`], err: [] });
    expect(w.runs).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema: 'factory/v1', peers: [{ url: STUDIO }] });
  });

  test('adding a URL that is already listed prints already listed, writes nothing, and exits 0', async () => {
    const text = await seed(STUDIO);
    const w = world();
    expect(await cli(w, 'add', 'studio')).toEqual({ code: 0, out: [`already listed: ${STUDIO}`], err: [] });
    expect(await cli(w, 'add', STUDIO)).toEqual({ code: 0, out: [`already listed: ${STUDIO}`], err: [] });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  const refusals: Array<[string, () => World, string[], string[]]> = [
    ['no tailscale CLI', () => world({ tsBin: null }), ['studio'], ['no tailscale CLI']],
    ['tailscale status failing', () => world({ tsCode: 1 }), ['studio'], ['tailscale status --json failed']],
    ['no tailnet peer by that name', () => world(), ['goliath'], ['no tailnet peer named goliath']],
    ['an http URL', () => world(), ['http://studio.manticore-hue.ts.net:8766'], ['must be an https:// URL']],
    ['a URL with a path', () => world(), [`${STUDIO}/x`], ['no path']],
    ['a malformed argument', () => world(), ['studio.manticore-hue.ts.net'], ['neither a machine name nor an https:// URL']],
    ['an unreachable peer', () => world({ answers: new Map() }), [STUDIO], ['is not reachable', 'GET /machines']],
    [
      'a redirect',
      () => world({ answers: new Map([[`${STUDIO}/machines`, { error: new GetJsonError('redirect', 302) }]]) }),
      [STUDIO],
      ['redirect (HTTP 302)', 'never followed'],
    ],
    [
      'a non-JSON answer',
      () => world({ answers: new Map([[`${STUDIO}/machines`, { error: new GetJsonError('not json', 200) }]]) }),
      [STUDIO],
      ['is not an Andon service'],
    ],
    [
      'JSON in another shape',
      () => world({ answers: new Map([[`${STUDIO}/machines`, { body: { hello: 'world' } }]]) }),
      [STUDIO],
      ['is not an Andon service', 'GET /machines'],
    ],
    [
      'a projects list in another shape',
      () => world({ answers: new Map([[`${STUDIO}/machines`, machinesOf('studio')], [`${STUDIO}/projects?scope=local`, { body: { projects: 'x' } }]]) }),
      [STUDIO],
      ['is not an Andon service', 'GET /projects?scope=local'],
    ],
    [
      'a pre-epic peer with no /machines',
      () => world({ answers: new Map([[`${STUDIO}/machines`, { error: new GetJsonError('status', 404) }]]) }),
      [STUDIO],
      ['factory upgrade', 'factory service restart', 'on that machine'],
    ],
    [
      'a pre-epic peer whose projects carry no machine',
      () => world({ answers: new Map([[`${STUDIO}/machines`, machinesOf('studio')], [`${STUDIO}/projects?scope=local`, { body: { projects: [{ id: '0123456789ab', name: 'p', root: '/r' }] } }]]) }),
      [STUDIO],
      ['factory upgrade', 'factory service restart', 'on that machine'],
    ],
    [
      'a peer reporting this machine\'s name (from the hostname)',
      () => world({ hostname: 'Studio.local' }),
      [STUDIO],
      ["this machine's own name studio"],
    ],
    [
      'a peer reporting this machine\'s name (from the unit\'s tailnet host)',
      () => world({ hostname: 'other', unit: '<key>ANDON_TAILNET_HOST</key>\n<string>studio.manticore-hue.ts.net</string>' }),
      [STUDIO],
      ["this machine's own name studio"],
    ],
  ];
  for (const [name, mk, argv, wants] of refusals) {
    test(`add refuses ${name} with one line, exit 1, and leaves peers.json as it was`, async () => {
      const r = await cli(mk(), 'add', ...argv);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
      for (const want of wants) expect(r.err[0]).toContain(want);
      expect(await exists()).toBe(false);
    });
  }

  test('add refuses a peer reporting the name of an already-listed peer that answers; an unanswering one does not count', async () => {
    const text = await seed(AGENT);
    const clash = world();
    clash.answers.set(`${STUDIO}/machines`, machinesOf('agentbox'));
    const r = await cli(clash, 'add', STUDIO);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`peers: ${STUDIO} reports the name agentbox, already the name of ${AGENT}; nothing written`]);
    expect(await readFile(file, 'utf8')).toBe(text);

    const quiet = world();
    quiet.answers.set(`${STUDIO}/machines`, machinesOf('agentbox'));
    quiet.answers.delete(`${AGENT}/machines`);
    expect(await cli(quiet, 'add', STUDIO)).toEqual({ code: 0, out: [`added agentbox ${STUDIO}`], err: [] });
  });

  test('the own machine name comes from the unit\'s recorded tailnet host, else the hostname', async () => {
    expect(await ownMachineName(host(world()))).toBe('rocinante');
    expect(await ownMachineName(host(world({ unit: '<key>ANDON_TAILNET_HOST</key>\n<string>box.manticore-hue.ts.net</string>' })))).toBe('box');
    expect(await ownMachineName(host(world({ hostname: "Matt's Mac_Book.local" })))).toBe('matt-s-mac-book');
  });

  test('tailscale status peers and a reported name are read strictly', () => {
    expect(tailnetPeerNames(JSON.stringify(STATUS))).toEqual(['studio.manticore-hue.ts.net', 'agentbox.manticore-hue.ts.net']);
    expect(tailnetPeerNames('nope')).toBeNull();
    expect(tailnetPeerNames('{}')).toEqual([]);
    expect(reportedName({ machines: [{ name: 'studio' }] })).toBe('studio');
    expect(reportedName({ machines: [{ name: 'a@b' }] })).toBeNull();
    expect(reportedName({ machines: [] })).toBeNull();
    expect(reportedName(null)).toBeNull();
  });
});

describe('the real getJson follows no redirect (AC2)', () => {
  test('a 3xx is refused, a 404 is a status error, a non-JSON body is not json, and JSON parses', async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/target') hits++;
        if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/target' } });
        if (path === '/missing') return new Response('Not found', { status: 404 });
        if (path === '/html') return new Response('<html>', { status: 200 });
        return Response.json({ ok: true });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const why = async (path: string): Promise<unknown> => getJson(`${base}${path}`).catch((e: unknown) => e);
      const redirect = await why('/redirect');
      expect(redirect).toBeInstanceOf(GetJsonError);
      expect(redirect instanceof GetJsonError ? [redirect.kind, redirect.status] : null).toEqual(['redirect', 302]);
      expect(hits).toBe(0);
      const missing = await why('/missing');
      expect(missing instanceof GetJsonError ? [missing.kind, missing.status] : null).toEqual(['status', 404]);
      const html = await why('/html');
      expect(html instanceof GetJsonError ? html.kind : null).toBe('not json');
      expect(await getJson(`${base}/target`)).toEqual({ ok: true });
    } finally {
      await server.stop(true);
    }
  });
});
