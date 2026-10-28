import { expect, test } from 'bun:test';
import { serviceCommand, DEFAULT_PORT, ensureService, pageUrl, probeService, resolvePort, SHELL_QUERY } from './autostart';
import type { AutostartDeps } from './autostart';
import type { Http } from './http';

const CMD = serviceCommand('/repo', '/bin/bun');

function deps(answers: boolean[], over: Partial<AutostartDeps> = {}) {
  const spawned: Array<{ argv: string[]; env: Record<string, string> }> = [];
  let probes = 0;
  let stops = 0;
  const d: AutostartDeps = {
    probe: async () => answers[probes++] ?? false,
    spawn: (argv, env) => {
      spawned.push({ argv, env });
      return { stop: () => stops++ };
    },
    sleep: async () => undefined,
    command: CMD,
    port: 9123,
    retries: 5,
    retryMs: 200,
    ...over,
  };
  return { d, spawned, probes: () => probes, stops: () => stops };
}

test('AC4: the service command is bun on the service entry; the port is $ANDON_PORT or 8766', () => {
  expect(CMD).toEqual(['/bin/bun', '/repo/packages/andon-service/src/main.ts']);
  expect(serviceCommand('/repo/')).toEqual(['bun', '/repo/packages/andon-service/src/main.ts']);
  expect(resolvePort({})).toBe(DEFAULT_PORT);
  expect(DEFAULT_PORT).toBe(8766);
  expect(resolvePort({ ANDON_PORT: '9001' })).toBe(9001);
  for (const bad of ['', 'x', '70000', '0', '-1']) expect(resolvePort({ ANDON_PORT: bad })).toBe(DEFAULT_PORT);
});

test('AC4: a service already answering is not spawned, and is left alone on quit', async () => {
  const t = deps([true]);
  const service = await ensureService(t.d);
  expect(service).toMatchObject({ ok: true, started: false });
  expect(t.spawned).toEqual([]);
  service.stop();
  expect(t.stops()).toBe(0);
});

test('AC4: an unreachable service is spawned exactly once with ANDON_PORT, re-probed until it answers, and stopped on quit', async () => {
  const t = deps([false, false, false, true]);
  const service = await ensureService(t.d);
  expect(service).toMatchObject({ ok: true, started: true });
  expect(t.spawned).toEqual([{ argv: CMD, env: { ANDON_PORT: '9123' } }]);
  expect(t.probes()).toBe(4);
  service.stop();
  service.stop();
  expect(t.stops()).toBe(1);
});

test('AC4: retries are bounded, and giving up reports one line (its child is still stopped on quit)', async () => {
  const t = deps([]);
  const service = await ensureService(t.d);
  expect(t.spawned).toHaveLength(1);
  expect(t.probes()).toBe(6); // the first probe, then 5 retries
  if (service.ok) throw new Error('expected a failure');
  expect(service.reason).toBe('the service did not answer on http://127.0.0.1:9123 within 1s');
  expect(service.reason).not.toContain('\n');
  service.stop();
  expect(t.stops()).toBe(1);
});

test('AC4: a spawn that throws is a one-line failure, with nothing to stop', async () => {
  const t = deps([], {
    spawn: () => {
      throw new Error('ENOENT: no such file\nstack');
    },
  });
  const service = await ensureService(t.d);
  if (service.ok) throw new Error('expected a failure');
  expect(service.reason).toBe('could not start the service (/bin/bun /repo/packages/andon-service/src/main.ts): ENOENT: no such file');
  expect(t.probes()).toBe(1);
});

test('AC4: the probe is GET /projects, and only a 2xx counts', async () => {
  const asked: string[] = [];
  const answer =
    (status: number | 'refused'): Http =>
    async (path) => {
      asked.push(path);
      if (status === 'refused') throw new Error('refused');
      return { ok: status < 300, status, body: null, text: async () => '{}' };
    };
  expect(await probeService(answer(200))).toBe(true);
  expect(await probeService(answer(403))).toBe(false);
  expect(await probeService(answer('refused'))).toBe(false);
  expect(asked).toEqual(['/projects', '/projects', '/projects']);
});

test('the page URL is the service on loopback with ?shell=mac, at any port', () => {
  expect(SHELL_QUERY).toBe('?shell=mac');
  expect(pageUrl(DEFAULT_PORT)).toBe('http://127.0.0.1:8766/?shell=mac');
  expect(pageUrl(9123)).toBe('http://127.0.0.1:9123/?shell=mac');
  expect(new URL(pageUrl(9123)).searchParams.get('shell')).toBe('mac');
});
