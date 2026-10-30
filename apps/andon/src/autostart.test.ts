import { expect, test } from 'bun:test';
import { DEFAULT_PORT, INSTALL_NOTICE, PROBE_MS, pageUrl, probeService, resolvePort, SHELL_QUERY, waitForService } from './autostart';
import type { WaitDeps } from './autostart';
import type { Http } from './http';
import * as autostart from './autostart';

function deps(answers: boolean[], over: Partial<WaitDeps> = {}) {
  let probes = 0;
  let missing = 0;
  const slept: number[] = [];
  const d: WaitDeps = {
    probe: async () => answers[probes++] ?? false,
    sleep: async (ms) => void slept.push(ms),
    missing: () => void missing++,
    cancelled: () => false,
    ...over,
  };
  return { d, probes: () => probes, missing: () => missing, slept };
}

test('the port is $ANDON_PORT or 8766', () => {
  expect(resolvePort({})).toBe(DEFAULT_PORT);
  expect(DEFAULT_PORT).toBe(8766);
  expect(resolvePort({ ANDON_PORT: '9001' })).toBe(9001);
  for (const bad of ['', 'x', '70000', '0', '-1']) expect(resolvePort({ ANDON_PORT: bad })).toBe(DEFAULT_PORT);
});

test('062 AC8: a service already answering is used as it is, with no notice', async () => {
  const t = deps([true]);
  expect(await waitForService(t.d)).toEqual({ answered: true, waited: false });
  expect(t.missing()).toBe(0);
  expect(t.probes()).toBe(1);
});

test('062 AC8: with no service, the notice shows once, and the app probes until the service answers', async () => {
  const t = deps([false, false, false, true]);
  expect(await waitForService(t.d)).toEqual({ answered: true, waited: true });
  expect(t.missing()).toBe(1);
  expect(t.probes()).toBe(4);
  expect(t.slept).toEqual([PROBE_MS, PROBE_MS, PROBE_MS]);
});

test('062 AC8: quitting stops the probing', async () => {
  let quit = false;
  const t = deps([false, false], {
    sleep: async () => {
      quit = true;
    },
    cancelled: () => quit,
  });
  expect(await waitForService(t.d)).toEqual({ answered: false, waited: true });
  expect(t.probes()).toBe(1);
});

test('062 AC8: the notice names factory service install, and the module starts nothing', () => {
  expect(INSTALL_NOTICE).toContain('factory service install');
  expect(INSTALL_NOTICE).not.toContain('\n');
  const names = Object.keys(autostart);
  for (const gone of ['ensureService', 'serviceCommand']) expect(names).not.toContain(gone);
});

test('the probe is GET /projects, and only a 2xx counts', async () => {
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
