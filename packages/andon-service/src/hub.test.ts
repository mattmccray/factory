// The Andon service as a hub (docs/contract/v1.md "Andon service", "Andon peers"). Peers are real
// services (or bare `Bun.serve` fakes for old or odd peers) on loopback, reached through the
// injected transport, which maps each peer's tailnet URL to its local server and records every
// request. Reconnect timers are injected, so a test fires them by hand.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPeer, addRoot, appendEvent, machineName, parseConfig, parseEventInput, peersPath, registryPath, removePeer } from '@factory/contract';
import { projectId, startService } from './index';
import type { ReconnectTimers, Service, ServiceOptions, Transport } from './index';
import { backoff, parseSse } from './peers';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const TAILNET = 'manticore-hue.ts.net';
const urlOf = (name: string): string => `https://${name}.${TAILNET}:8766`;
const STUDIO = urlOf('studio');

let tmp: string;
let services: Service[];
let servers: Array<{ stop: (force?: boolean) => Promise<void> | void }>;
let routes: Map<string, string>; // a peer's tailnet origin → its local URL
let requests: Array<{ origin: string; path: string; redirect: RequestInit['redirect'] }>;
let intercept: (origin: string, path: string) => Response | Error | null;
let pending: Array<{ fn: () => void; ms: number; t: ReturnType<typeof setTimeout> }>;
let logs: string[];

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-hub-')));
  services = [];
  servers = [];
  routes = new Map();
  requests = [];
  intercept = () => null;
  pending = [];
  logs = [];
});
afterEach(async () => {
  for (const s of services) await s.stop();
  for (const s of servers) await s.stop(true);
  await rm(tmp, { recursive: true, force: true });
});

const transport: Transport = async (u, init) => {
  const url = new URL(u);
  const path = `${url.pathname}${url.search}`;
  requests.push({ origin: url.origin, path, redirect: init.redirect });
  const hit = intercept(url.origin, path);
  if (hit instanceof Error) throw hit;
  if (hit !== null) return hit;
  const local = routes.get(url.origin);
  if (local === undefined) throw new TypeError(`connect ECONNREFUSED ${url.host}`);
  return fetch(`${local}${path}`, init);
};

const timers: ReconnectTimers = {
  set: (fn, ms) => {
    const t = setTimeout(() => undefined, 1_000_000);
    t.unref();
    pending.push({ fn, ms, t });
    return t;
  },
  clear: (t) => {
    clearTimeout(t);
    pending = pending.filter((p) => p.t !== t);
  },
};
// Fires every pending reconnect timer.
function fire(): void {
  const due = pending;
  pending = [];
  for (const p of due) p.fn();
}

const writeAt = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

/** A machine's ANDON_HOME, with a project per name (each with a job), registered there. */
async function makeHome(machine: string, names: string[]): Promise<{ home: string; roots: string[] }> {
  const home = join(tmp, machine, 'andon');
  const roots: string[] = [];
  for (const name of names) {
    const root = join(tmp, machine, name);
    await writeAt(join(root, 'factory', 'config.json'), JSON.stringify(CONFIG));
    await appendEvent(join(root, 'factory'), '001-first-job', parseEventInput('job.claimed', {}, { id: '001-first-job', config: parseConfig(CONFIG) }));
    await addRoot(registryPath(home), root);
    roots.push(root);
  }
  return { home, roots };
}

async function serve(machine: string, home: string, more: Partial<ServiceOptions> = {}): Promise<Service> {
  const s = await startService({ port: 0, registryPath: registryPath(home), peersPath: peersPath(home), machine, debounceMs: 20, transport, reconnectTimers: timers, log: (l) => logs.push(l), ...more });
  services.push(s);
  return s;
}

/** A peer machine: its service, reachable at `urlOf(machine)` through the transport. */
async function peer(machine: string, names: string[], more: Partial<ServiceOptions> = {}, at: string = urlOf(machine)): Promise<{ service: Service; roots: string[]; home: string }> {
  const { home, roots } = await makeHome(new URL(at).hostname.split('.')[0] ?? machine, names);
  const service = await serve(machine, home, more);
  routes.set(at, service.url);
  return { service, roots, home };
}

async function stopService(s: Service): Promise<void> {
  await s.stop();
  services = services.filter((x) => x !== s);
}

const get = async (url: string, init?: RequestInit): Promise<{ status: number; body: unknown; text: string; cache: string | null }> => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text
  }
  return { status: res.status, body, text, cache: res.headers.get('cache-control') };
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, k: string): unknown => (isRec(v) ? v[k] : undefined);
const list = (v: unknown, k: string): unknown[] => {
  const x = field(v, k);
  return Array.isArray(x) ? x : [];
};
const ids = (body: unknown): unknown[] => list(body, 'projects').map((p) => field(p, 'id'));
const machineOf = (body: unknown, name: string): unknown => list(body, 'machines').find((m) => field(m, 'name') === name);
const stateOf = async (hub: Service, name: string): Promise<unknown> => field(machineOf((await get(`${hub.url}/machines`)).body, name), 'state');
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits until `check` holds (a test-side wait; the service itself never polls). */
async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error('condition not met in time');
    await settle(10);
  }
}
const live = (hub: Service, name: string): Promise<void> => until(async () => (await stateOf(hub, name)) === 'live');

interface Sse {
  event: string;
  data: unknown;
}

async function connect(url: string, query = ''): Promise<{ next: (match: (e: Sse) => boolean, ms?: number) => Promise<Sse>; seen: Sse[]; close: () => void }> {
  const ctl = new AbortController();
  const res = await fetch(`${url}/events${query}`, { signal: ctl.signal });
  const body = res.body;
  if (body === null) throw new Error('no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen: Sse[] = [];
  let buf = '';
  void (async () => {
    try {
      let chunk = await reader.read();
      while (!chunk.done) {
        buf += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSse(buf);
        buf = parsed.rest;
        for (const f of parsed.frames) seen.push({ event: f.event, data: JSON.parse(f.data) });
        chunk = await reader.read();
      }
    } catch {
      // aborted
    }
  })();
  const next = async (match: (e: Sse) => boolean, ms = 3000): Promise<Sse> => {
    let hit: Sse | undefined;
    await until(() => {
      hit = seen.find(match);
      return hit !== undefined;
    }, ms).catch(() => {
      throw new Error(`no matching event within ${ms} ms; saw ${JSON.stringify(seen.map((s) => s.event))}`);
    });
    if (hit === undefined) throw new Error('unreachable');
    return hit;
  };
  return { next, seen, close: () => ctl.abort() };
}

const claim = async (root: string, id: string): Promise<void> => {
  await appendEvent(join(root, 'factory'), id, parseEventInput('job.claimed', {}, { id, config: parseConfig(CONFIG) }));
};

describe('a service with no peers.json (AC3)', () => {
  test('every project carries machine and a bare id; /machines lists only itself; /events sends machines after release', async () => {
    const { home, roots } = await makeHome('solo', ['alpha']);
    const root = roots[0] ?? '';
    const s = await serve('studio', home, { machine: undefined, tailnetHost: `studio.${TAILNET}` });
    const port = new URL(s.url).port;
    const projects = await get(`${s.url}/projects`);
    expect(projects.body).toEqual({ projects: [{ id: projectId(root), name: 'alpha', root, release: { installed: null, state: 'unknown' }, machine: 'studio' }] });
    expect(String(ids(projects.body)[0])).toMatch(/^[0-9a-f]{12}$/);
    const machines = await get(`${s.url}/machines`);
    expect(machines.cache).toBe('no-store');
    expect(machines.body).toEqual({ machines: [{ name: 'studio', url: `https://studio.${TAILNET}:${port}`, state: 'live', since: expect.any(String), reason: null, release: null }] });
    const since = String(field(list(machines.body, 'machines')[0], 'since'));
    expect(new Date(since).toISOString()).toBe(since);

    const c = await connect(s.url);
    await c.next((e) => e.event === 'machines');
    expect(c.seen.slice(0, 3).map((e) => e.event)).toEqual(['projects', 'release', 'machines']);
    expect(c.seen[0]?.data).toEqual(projects.body);
    expect(c.seen[2]?.data).toEqual(machines.body);
    c.close();
  });

  test('the machine name is the hostname\'s first label, sanitized, with no tailnet host; its url is the loopback one', async () => {
    const { home } = await makeHome('solo', []);
    const s = await serve('x', home, { machine: undefined });
    const port = new URL(s.url).port;
    expect((await get(`${s.url}/machines`)).body).toEqual({ machines: [{ name: machineName(hostname()), url: `http://127.0.0.1:${port}`, state: 'live', since: expect.any(String), reason: null, release: null }] });
    expect(machineName('Rocinante.local')).toBe('rocinante');
    await expect(startService({ port: 0, registryPath: registryPath(home), machine: 'a@b' })).rejects.toThrow('machine name');
  });

  test('scope=local returns exactly the local data; peer-free, every scope value is the same', async () => {
    const { home } = await makeHome('solo', ['alpha', 'beta']);
    const s = await serve('solo', home);
    const all = (await get(`${s.url}/projects`)).body;
    expect((await get(`${s.url}/projects?scope=local`)).body).toEqual(all);
    expect((await get(`${s.url}/projects?scope=other`)).body).toEqual(all);
    const c = await connect(s.url, '?scope=local');
    await c.next((e) => e.event === 'machines');
    expect(c.seen.map((e) => e.event)).toEqual(['projects', 'release', 'machines']);
    expect(c.seen[0]?.data).toEqual(all);
    expect(c.seen[2]?.data).toEqual((await get(`${s.url}/machines`)).body);
    c.close();
  });

  test('/machines is behind the same guards: a foreign Host is a 403, a POST a 405', async () => {
    const { home } = await makeHome('solo', []);
    const s = await serve('solo', home);
    expect((await get(`${s.url}/machines`, { headers: { host: 'evil.example:80' } })).status).toBe(403);
    expect((await get(`${s.url}/machines`, { method: 'POST' })).status).toBe(405);
    expect(requests).toEqual([]);
  });
});

describe('a hub with one peer (AC4)', () => {
  test('merged projects, rewritten peer events of the matching form, only two streams, and no release passed on', async () => {
    const studio = await peer('studio', ['web']);
    const pid = projectId(studio.roots[0] ?? '');
    const hubHome = await makeHome('rocinante', ['hubproj']);
    const hubRoot = hubHome.roots[0] ?? '';
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');

    const peerProjects = (await get(`${studio.service.url}/projects`)).body;
    const peerEntry = list(peerProjects, 'projects')[0];
    const want = {
      projects: [
        { id: projectId(hubRoot), name: 'hubproj', root: hubRoot, release: { installed: null, state: 'unknown' }, machine: 'rocinante' },
        { ...(isRec(peerEntry) ? peerEntry : {}), id: `${pid}@studio`, machine: 'studio' },
      ],
    };
    expect((await get(`${hub.url}/projects`)).body).toEqual(want);
    expect((await get(`${hub.url}/projects?scope=local`)).body).toEqual({ projects: [want.projects[0]] });
    expect((await get(`${hub.url}/projects?scope=Local`)).body).toEqual(want);

    const plain = await connect(hub.url);
    const narrow = await connect(hub.url, '?settled=summary');
    const localOnly = await connect(hub.url, '?scope=local');
    expect((await plain.next((e) => e.event === 'projects')).data).toEqual(want);
    expect((await narrow.next((e) => e.event === 'projects')).data).toEqual(want);
    expect((await localOnly.next((e) => e.event === 'projects')).data).toEqual({ projects: [want.projects[0]] });
    const machines = (await plain.next((e) => e.event === 'machines')).data;
    expect(list(machines, 'machines').map((m) => [field(m, 'name'), field(m, 'url'), field(m, 'state')])).toEqual([
      ['rocinante', `http://127.0.0.1:${new URL(hub.url).port}`, 'live'],
      ['studio', STUDIO, 'live'],
    ]);
    expect(list((await localOnly.next((e) => e.event === 'machines')).data, 'machines').map((m) => field(m, 'name'))).toEqual(['rocinante']);

    // A change on the peer reaches each hub client in its own form, rewritten.
    await claim(studio.roots[0] ?? '', '002-second-job');
    const pb = await plain.next((e) => e.event === 'board' && field(e.data, 'project') === `${pid}@studio` && list(e.data, 'jobs').length === 2);
    expect(field(pb.data, 'settled')).toBeUndefined();
    const nb = await narrow.next((e) => e.event === 'board' && field(e.data, 'project') === `${pid}@studio` && list(e.data, 'jobs').length === 2);
    expect(field(nb.data, 'settled')).toEqual({ count: 0, lastMergedAt: null, epics: 0 });
    expect(plain.seen.some((e) => e.event === 'board' && field(e.data, 'settled') !== undefined)).toBe(false);
    expect(narrow.seen.some((e) => e.event === 'board' && field(e.data, 'project') === `${pid}@studio` && field(e.data, 'settled') === undefined)).toBe(false);

    await writeAt(join(studio.roots[0] ?? '', 'factory', 'backlog.md'), '- [ ] a thing\n');
    await plain.next((e) => e.event === 'backlog' && field(e.data, 'project') === `${pid}@studio`);
    await narrow.next((e) => e.event === 'backlog' && field(e.data, 'project') === `${pid}@studio`);

    await writeFile(join(studio.roots[0] ?? '', 'factory', 'config.json'), '{ nope');
    expect(field((await plain.next((e) => e.event === 'error' && field(e.data, 'project') === `${pid}@studio`)).data, 'reason')).toContain('config.json');
    await narrow.next((e) => e.event === 'error' && field(e.data, 'project') === `${pid}@studio`);
    await settle(100);

    // Nothing of the peer reaches a scope=local client; every client got exactly the hub's own release event.
    expect(localOnly.seen.some((e) => JSON.stringify(e.data).includes('@studio'))).toBe(false);
    for (const c of [plain, narrow, localOnly]) expect(c.seen.filter((e) => e.event === 'release')).toHaveLength(1);

    // The peer saw only /machines, the two scope=local streams, and the on-demand board reads made when it went live.
    const seen = requests.filter((r) => r.origin === STUDIO).map((r) => r.path);
    expect(seen.filter((p) => p === '/machines')).toHaveLength(1);
    expect(seen.filter((p) => p.startsWith('/events')).sort()).toEqual(['/events?scope=local', '/events?scope=local&settled=summary']);
    for (const p of seen) expect(['/machines', '/release', '/events?scope=local', '/events?scope=local&settled=summary', `/projects/${pid}/board`, `/projects/${pid}/board?settled=summary`]).toContain(p);
    const count = requests.length;
    await settle(300);
    expect(requests.length).toBe(count); // no repeated polling
    expect(requests.every((r) => r.redirect === 'manual')).toBe(true);
    for (const c of [plain, narrow, localOnly]) c.close();
  });

  test('editing peers.json applies with no restart and sends fresh projects and machines; a bad edit keeps the peers and logs one line', async () => {
    const studio = await peer('studio', ['web']);
    const pid = projectId(studio.roots[0] ?? '');
    const hubHome = await makeHome('rocinante', ['hubproj']);
    const file = peersPath(hubHome.home);
    const hub = await serve('rocinante', hubHome.home);
    const c = await connect(hub.url);
    await c.next((e) => e.event === 'machines');
    expect(ids((await get(`${hub.url}/projects`)).body)).toHaveLength(1);

    await addPeer(file, STUDIO);
    await c.next((e) => e.event === 'machines' && machineOf(e.data, 'studio') !== undefined);
    await c.next((e) => e.event === 'projects' && ids(e.data).includes(`${pid}@studio`));
    await c.next((e) => e.event === 'machines' && field(machineOf(e.data, 'studio'), 'state') === 'live');

    const before = logs.length;
    await writeFile(file, '{ "schema": "factory/v1", "peers": [{ "url": "http://nope" }] }');
    await until(() => logs.length > before);
    await settle(100);
    // One line per reload of the bad file (a burst of watch events is one reload).
    for (const line of logs.slice(before)) {
      expect(line).toContain('peers: ');
      expect(line).toContain('keeping the current peers');
      expect(line).not.toContain('\n');
    }
    expect(await stateOf(hub, 'studio')).toBe('live');
    expect(ids((await get(`${hub.url}/projects`)).body)).toContain(`${pid}@studio`);

    await writeFile(file, `${JSON.stringify({ schema: 'factory/v1', peers: [{ url: STUDIO }] })}\n`);
    await removePeer(file, STUDIO);
    const seenBefore = c.seen.length;
    await until(() => c.seen.slice(seenBefore).some((e) => e.event === 'projects' && !ids(e.data).includes(`${pid}@studio`)));
    await until(() => c.seen.slice(seenBefore).some((e) => e.event === 'machines' && list(e.data, 'machines').length === 1));
    expect(ids((await get(`${hub.url}/projects`)).body)).toHaveLength(1);
    c.close();
  });
});

describe('forwarded reads (AC5)', () => {
  test('each read of a live peer\'s project, with @ or %40, is forwarded with its query and returns the peer\'s status and body, no-store', async () => {
    const studio = await peer('studio', ['web']);
    const root = studio.roots[0] ?? '';
    const pid = projectId(root);
    const f = join(root, 'factory');
    await writeAt(join(f, 'jobs', '001-first-job', 'spec.md'), '# spec\n');
    await writeAt(join(f, 'briefs', 'a-brief.md'), '# A brief\n\n- Status: draft\n');
    await writeAt(join(f, 'epics', 'an-epic.md'), '# An epic\n\n- Status: draft\n\n## Members\n- a-brief\n');
    const hubHome = await makeHome('rocinante', []);
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');

    const paths = ['board', 'board?settled=summary', 'board?settled=other', 'settled', 'jobs/001-first-job/docs', 'jobs/009-missing/docs', 'epics/an-epic/docs', 'backlog', 'briefs/a-brief', 'plans/an-epic', 'briefs/no-such'];
    for (const sep of ['@', '%40']) {
      for (const p of paths) {
        const direct = await get(`${studio.service.url}/projects/${pid}/${p}`);
        const from = requests.length;
        const via = await get(`${hub.url}/projects/${pid}${sep}studio/${p}`);
        expect({ p, sep, status: via.status, text: via.text, cache: via.cache }).toEqual({ p, sep, status: direct.status, text: direct.text, cache: 'no-store' });
        expect(requests.slice(from).map((r) => [r.origin, r.path, r.redirect])).toEqual([[STUDIO, `/projects/${pid}/${p}`, 'manual']]);
      }
    }
  });

  test('a malformed id, an unknown machine, or a bad job id, epic slug, or brief or plan slug is a 404 that sends no request', async () => {
    const studio = await peer('studio', ['web']);
    const pid = projectId(studio.roots[0] ?? '');
    const hubHome = await makeHome('rocinante', []);
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');
    const from = requests.length;
    for (const p of [
      `${pid.toUpperCase()}@studio/board`,
      `${pid.slice(1)}@studio/board`,
      `zzzzzzzzzzzz@studio/board`,
      `${pid}@goliath/board`,
      `${pid}@/board`,
      `${pid}@studio@studio/board`,
      `${pid}%40studio%40x/backlog`,
      `${pid}@rocinante/board`,
      `${pid}@studio/jobs/nope/docs`,
      `${pid}@studio/jobs/..%2F001-x/docs`,
      `${pid}@studio/epics/Bad_Slug/docs`,
      `${pid}@studio/briefs/..%2Fx`,
      `${pid}@studio/plans/UPPER`,
      `${pid}@studio/briefs/a--b`,
    ]) {
      expect({ p, status: (await get(`${hub.url}/projects/${p}`)).status }).toEqual({ p, status: 404 });
    }
    expect(requests.slice(from)).toEqual([]);
  });

  test('a redirect, or a network failure, on a live peer is a 502 naming the machine; the redirect is never followed', async () => {
    const studio = await peer('studio', ['web']);
    const pid = projectId(studio.roots[0] ?? '');
    const hubHome = await makeHome('rocinante', []);
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');
    intercept = (_origin, path) => {
      if (path === `/projects/${pid}/backlog`) return new Response(null, { status: 302, headers: { location: `${studio.service.url}/projects/${pid}/backlog` } });
      if (path === `/projects/${pid}/settled`) return new TypeError('socket hang up');
      return null;
    };
    const from = requests.length;
    for (const p of ['backlog', 'settled']) {
      const r = await get(`${hub.url}/projects/${pid}@studio/${p}`);
      expect(r.status).toBe(502);
      expect(r.text).toContain('studio');
      expect(r.cache).toBe('no-store');
    }
    expect(requests.slice(from).map((r) => r.path)).toEqual([`/projects/${pid}/backlog`, `/projects/${pid}/settled`]);
    expect(await stateOf(hub, 'studio')).toBe('live');

    // A forwarded answer is served as JSON or plain text only, whatever type the peer names.
    intercept = (_origin, path) => (path === `/projects/${pid}/briefs/x` ? new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }) : null);
    const html = await fetch(`${hub.url}/projects/${pid}@studio/briefs/x`);
    expect(html.headers.get('content-type')).toBe('text/plain;charset=utf-8');
    const board = await fetch(`${hub.url}/projects/${pid}@studio/board`);
    expect(board.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(board.headers.get('cache-control')).toBe('no-store');
  });
});

describe('one hop, clashes, old peers, and other releases (AC6)', () => {
  test('two services that list each other each serve every project exactly once', async () => {
    const a = await makeHome('rocinante', ['one', 'two']);
    const b = await makeHome('studio', ['three']);
    await addPeer(peersPath(a.home), STUDIO);
    await addPeer(peersPath(b.home), urlOf('rocinante'));
    const hubA = await serve('rocinante', a.home);
    const hubB = await serve('studio', b.home);
    routes.set(STUDIO, hubB.url);
    routes.set(urlOf('rocinante'), hubA.url);
    fire(); // whichever started before its peer was routed reconnects now
    await live(hubA, 'studio');
    await live(hubB, 'rocinante');
    const pa = a.roots.map((r) => projectId(r));
    const pb = b.roots.map((r) => projectId(r));
    expect(ids((await get(`${hubA.url}/projects`)).body)).toEqual([...pa, ...pb.map((p) => `${p}@studio`)]);
    expect(ids((await get(`${hubB.url}/projects`)).body)).toEqual([...pb, ...pa.map((p) => `${p}@rocinante`)]);
    for (const h of [hubA, hubB]) for (const id of ids((await get(`${h.url}/projects`)).body)) expect(String(id).split('@').length).toBeLessThanOrEqual(2);
  });

  test('a peer reporting the hub\'s own name, or an earlier peer\'s, is error and nothing of it is merged', async () => {
    await peer('rocinante', ['mirror'], {}, urlOf('mirror'));
    const first = await peer('studio', ['web']);
    await peer('studio', ['twin'], {}, urlOf('studio2'));
    const hubHome = await makeHome('rocinante', ['hubproj']);
    for (const u of [urlOf('mirror'), STUDIO, urlOf('studio2')]) await addPeer(peersPath(hubHome.home), u);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');
    await until(async () => list((await get(`${hub.url}/machines`)).body, 'machines').filter((m) => field(m, 'state') === 'error').length === 2);
    const machines = list((await get(`${hub.url}/machines`)).body, 'machines');
    const mirror = machines.find((m) => field(m, 'url') === urlOf('mirror'));
    const twin = machines.find((m) => field(m, 'url') === urlOf('studio2'));
    expect(field(mirror, 'state')).toBe('error');
    expect(String(field(mirror, 'reason'))).toContain("own machine name rocinante");
    expect(field(twin, 'state')).toBe('error');
    expect(String(field(twin, 'reason'))).toContain(`already the name of ${STUDIO}`);
    expect(ids((await get(`${hub.url}/projects`)).body)).toEqual([projectId(hubHome.roots[0] ?? ''), `${projectId(first.roots[0] ?? '')}@studio`]);
  });

  test('a later peer already live is put in error when an earlier one claims its name', async () => {
    const hubHome = await makeHome('rocinante', []);
    await addPeer(peersPath(hubHome.home), STUDIO);
    await addPeer(peersPath(hubHome.home), urlOf('studio2'));
    await peer('studio', ['twin'], {}, urlOf('studio2'));
    const hub = await serve('rocinante', hubHome.home);
    await until(async () => field(list((await get(`${hub.url}/machines`)).body, 'machines')[2], 'state') === 'live');
    expect(ids((await get(`${hub.url}/projects`)).body)).toHaveLength(1);
    const first = await peer('studio', ['web']);
    fire();
    await live(hub, 'studio');
    await until(async () => field(list((await get(`${hub.url}/machines`)).body, 'machines')[2], 'state') === 'error');
    expect(ids((await get(`${hub.url}/projects`)).body)).toEqual([`${projectId(first.roots[0] ?? '')}@studio`]);
  });

  const preEpic: Array<[string, (req: Request) => Response | null]> = [
    ['no /machines (a 404)', (req) => (new URL(req.url).pathname === '/machines' ? new Response('Not found', { status: 404 }) : null)],
    ['projects with no machine', () => null],
    ['an id containing @ under scope=local', () => null],
  ];
  for (const [name, override] of preEpic) {
    test(`a pre-epic peer (${name}) is error naming factory upgrade and factory service restart, and nothing of it is merged`, async () => {
      const entry = name.includes('@') ? { id: '0123456789ab@x', name: 'p', root: '/r', release: {}, machine: 'x' } : { id: '0123456789ab', name: 'p', root: '/r', release: {} };
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (req) => {
          const o = override(req);
          if (o !== null) return o;
          const path = new URL(req.url).pathname;
          if (path === '/machines') return Response.json({ machines: [{ name: 'oldbox', url: 'x', state: 'live', since: 'x', reason: null, release: '0.1.0' }] });
          if (path === '/events') {
            const body = `event: projects\ndata: ${JSON.stringify({ projects: [entry] })}\n\nevent: release\ndata: {}\n\n`;
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
          }
          return Response.json({ projects: [entry] });
        },
      });
      servers.push(server);
      routes.set(urlOf('oldbox'), `http://127.0.0.1:${server.port}`);
      const hubHome = await makeHome('rocinante', ['hubproj']);
      await addPeer(peersPath(hubHome.home), urlOf('oldbox'));
      const hub = await serve('rocinante', hubHome.home);
      await until(async () => (await stateOf(hub, 'oldbox')) === 'error');
      const reason = String(field(machineOf((await get(`${hub.url}/machines`)).body, 'oldbox'), 'reason'));
      expect(reason).toContain('factory upgrade');
      expect(reason).toContain('factory service restart');
      expect(reason).toContain('on that machine');
      expect(reason).not.toContain('\n');
      expect(ids((await get(`${hub.url}/projects`)).body)).toEqual([projectId(hubHome.roots[0] ?? '')]);
      expect((await get(`${hub.url}/projects/0123456789ab@oldbox/board`)).status).toBe(404);
      // It is retried on the backoff, and stays error with the same since while nothing changes.
      const since = field(machineOf((await get(`${hub.url}/machines`)).body, 'oldbox'), 'since');
      fire();
      await settle(100);
      expect(field(machineOf((await get(`${hub.url}/machines`)).body, 'oldbox'), 'since')).toBe(since);
      expect(await stateOf(hub, 'oldbox')).toBe('error');
    });
  }

  test('a peer on another release passes through unchanged, its release on its machine entry', async () => {
    const clone = join(tmp, 'clone');
    await writeAt(join(clone, 'packages', 'templates', 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const studio = await peer('studio', ['web'], { cloneRoot: clone });
    const pid = projectId(studio.roots[0] ?? '');
    const hubHome = await makeHome('rocinante', []);
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');
    expect(field(machineOf((await get(`${hub.url}/machines`)).body, 'studio'), 'release')).toBe('9.9.9');
    expect(field(list((await get(`${hub.url}/projects`)).body, 'projects')[0], 'release')).toEqual(field(list((await get(`${studio.service.url}/projects`)).body, 'projects')[0], 'release'));
    expect((await get(`${hub.url}/projects/${pid}@studio/board`)).text).toBe((await get(`${studio.service.url}/projects/${pid}/board`)).text);
    expect(field((await get(`${hub.url}/release`)).body, 'running')).toBeNull(); // /release stays the hub's own
  });
});

describe('a peer that goes down (AC7)', () => {
  test('down within a reconnect, projects and last boards kept, other reads 502, backoff 3 s doubling to 60 s, then live again with fresh events', async () => {
    const studio = await peer('studio', ['web', 'broken']);
    const pid = projectId(studio.roots[0] ?? '');
    const broken = projectId(studio.roots[1] ?? '');
    await writeFile(join(studio.roots[1] ?? '', 'factory', 'config.json'), '{ nope');
    const hubHome = await makeHome('rocinante', []);
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await live(hub, 'studio');
    const plainBoard = (await get(`${studio.service.url}/projects/${pid}/board`)).text;
    const narrowBoard = (await get(`${studio.service.url}/projects/${pid}/board?settled=summary`)).text;
    // The boards fetched when it went live are held.
    await settle(100);
    const c = await connect(hub.url);
    await c.next((e) => e.event === 'machines');
    const listed = ids((await get(`${hub.url}/projects`)).body);
    expect(pending).toEqual([]);

    routes.delete(STUDIO);
    await stopService(studio.service);
    const down = await c.next((e) => e.event === 'machines' && field(machineOf(e.data, 'studio'), 'state') === 'down');
    const entry = machineOf(down.data, 'studio');
    const since = String(field(entry, 'since'));
    expect(new Date(since).toISOString()).toBe(since);
    expect(typeof field(entry, 'reason')).toBe('string');
    expect(ids((await get(`${hub.url}/projects`)).body)).toEqual(listed);

    const plain = await get(`${hub.url}/projects/${pid}@studio/board`);
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual(JSON.parse(plainBoard));
    expect(plain.cache).toBe('no-store');
    expect((await get(`${hub.url}/projects/${pid}%40studio/board?settled=summary`)).body).toEqual(JSON.parse(narrowBoard));
    const none = await get(`${hub.url}/projects/${broken}@studio/board`);
    expect(none.status).toBe(502);
    expect(none.text).toContain('studio');
    for (const p of ['settled', 'jobs/001-first-job/docs', 'epics/x/docs', 'backlog', 'briefs/x', 'plans/x']) {
      const r = await get(`${hub.url}/projects/${pid}@studio/${p}`);
      expect({ p, status: r.status, names: r.text.includes('studio') }).toEqual({ p, status: 502, names: true });
    }

    // Reconnects back off from 3 s, doubling, up to 60 s.
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await until(() => pending.length === 1);
      delays.push(pending[0]?.ms ?? -1);
      fire();
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    expect([0, 1, 2, 3, 4, 5, 6].map(backoff)).toEqual(delays);
    await until(() => pending.length === 1);
    expect(await stateOf(hub, 'studio')).toBe('down');

    // It comes back: connecting, then live, then fresh projects and board events.
    const back = await serve('studio', studio.home);
    routes.set(STUDIO, back.url);
    const mark = c.seen.length;
    fire();
    await c.next((e) => c.seen.indexOf(e) >= mark && e.event === 'machines' && field(machineOf(e.data, 'studio'), 'state') === 'live');
    const after = c.seen.slice(mark);
    const states = after.filter((e) => e.event === 'machines').map((e) => field(machineOf(e.data, 'studio'), 'state'));
    expect(states.indexOf('connecting')).toBeGreaterThanOrEqual(0);
    expect(states.indexOf('connecting')).toBeLessThan(states.indexOf('live'));
    await c.next((e) => c.seen.indexOf(e) >= mark && e.event === 'projects' && ids(e.data).includes(`${pid}@studio`));
    await c.next((e) => c.seen.indexOf(e) >= mark && e.event === 'board' && field(e.data, 'project') === `${pid}@studio`);
    c.close();

    // Nothing about peers is written to disk.
    expect(await readdir(hubHome.home)).toEqual(['peers.json']);
  });

  test('a hub started while its peer is down lists it down with no projects', async () => {
    const hubHome = await makeHome('rocinante', ['hubproj']);
    await addPeer(peersPath(hubHome.home), STUDIO);
    const hub = await serve('rocinante', hubHome.home);
    await until(async () => (await stateOf(hub, 'studio')) === 'down');
    expect(ids((await get(`${hub.url}/projects`)).body)).toEqual([projectId(hubHome.roots[0] ?? '')]);
    const r = await get(`${hub.url}/projects/0123456789ab@studio/backlog`);
    expect(r.status).toBe(502);
    expect(r.text).toContain('studio');
    expect(pending.map((p) => p.ms)).toEqual([3000]);
  });
});

describe('the SSE parse', () => {
  test('frames split on blank lines; a partial frame is kept; comments and CRLF are handled', () => {
    expect(parseSse('event: a\ndata: {"x":1}\n\n: hi\n\nevent: b\r\ndata: 1\r\n\r\nevent: c\ndata: 2')).toEqual({
      frames: [
        { event: 'a', data: '{"x":1}' },
        { event: 'b', data: '1' },
      ],
      rest: 'event: c\ndata: 2',
    });
  });
});
