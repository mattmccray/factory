import { expect, test } from 'bun:test';
import { agentCommand, DEFAULT_PORT, ensureAgent, probeAgent, resolvePort } from './autostart';
import type { AutostartDeps } from './autostart';
import type { Http } from './http';

const CMD = agentCommand('/repo', '/bin/bun');

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

test('AC4: the agent command is bun on the agent entry; the port is $ANDON_PORT or 8766', () => {
  expect(CMD).toEqual(['/bin/bun', '/repo/packages/andon-agent/src/main.ts']);
  expect(agentCommand('/repo/')).toEqual(['bun', '/repo/packages/andon-agent/src/main.ts']);
  expect(resolvePort({})).toBe(DEFAULT_PORT);
  expect(DEFAULT_PORT).toBe(8766);
  expect(resolvePort({ ANDON_PORT: '9001' })).toBe(9001);
  for (const bad of ['', 'x', '70000', '0', '-1']) expect(resolvePort({ ANDON_PORT: bad })).toBe(DEFAULT_PORT);
});

test('AC4: an agent already answering is not spawned, and is left alone on quit', async () => {
  const t = deps([true]);
  const agent = await ensureAgent(t.d);
  expect(agent).toMatchObject({ ok: true, started: false });
  expect(t.spawned).toEqual([]);
  agent.stop();
  expect(t.stops()).toBe(0);
});

test('AC4: an unreachable agent is spawned exactly once with ANDON_PORT, re-probed until it answers, and stopped on quit', async () => {
  const t = deps([false, false, false, true]);
  const agent = await ensureAgent(t.d);
  expect(agent).toMatchObject({ ok: true, started: true });
  expect(t.spawned).toEqual([{ argv: CMD, env: { ANDON_PORT: '9123' } }]);
  expect(t.probes()).toBe(4);
  agent.stop();
  agent.stop();
  expect(t.stops()).toBe(1);
});

test('AC4: retries are bounded, and giving up reports one line (its child is still stopped on quit)', async () => {
  const t = deps([]);
  const agent = await ensureAgent(t.d);
  expect(t.spawned).toHaveLength(1);
  expect(t.probes()).toBe(6); // the first probe, then 5 retries
  if (agent.ok) throw new Error('expected a failure');
  expect(agent.reason).toBe('the agent did not answer on http://127.0.0.1:9123 within 1s');
  expect(agent.reason).not.toContain('\n');
  agent.stop();
  expect(t.stops()).toBe(1);
});

test('AC4: a spawn that throws is a one-line failure, with nothing to stop', async () => {
  const t = deps([], {
    spawn: () => {
      throw new Error('ENOENT: no such file\nstack');
    },
  });
  const agent = await ensureAgent(t.d);
  if (agent.ok) throw new Error('expected a failure');
  expect(agent.reason).toBe('could not start the agent (/bin/bun /repo/packages/andon-agent/src/main.ts): ENOENT: no such file');
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
  expect(await probeAgent(answer(200))).toBe(true);
  expect(await probeAgent(answer(403))).toBe(false);
  expect(await probeAgent(answer('refused'))).toBe(false);
  expect(asked).toEqual(['/projects', '/projects', '/projects']);
});
