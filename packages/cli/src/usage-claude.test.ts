import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeUsageReader, findAgentTranscript, projectFolder, sessionTranscript, transcriptRoot } from './usage-claude';
import { messageLines, projectDir, userLine, writeAgent, writeSession } from './transcriptfixture';

let claudeDir: string;
let repo: string;
beforeEach(async () => {
  claudeDir = await realpath(await mkdtemp(join(tmpdir(), 'factory-claude-')));
  repo = '/Users/someone/Projects/my.repo';
});
afterEach(async () => {
  await rm(claudeDir, { recursive: true, force: true });
});

const at = (min: number): string => new Date(Date.parse('2026-11-02T10:00:00.000Z') + min * 60_000).toISOString();
const reader = () => claudeUsageReader({ repo, env: { CLAUDE_CONFIG_DIR: claudeDir } });

describe('transcript root and project folder', () => {
  test('CLAUDE_CONFIG_DIR wins; else HOME/.claude; then projects/', () => {
    expect(transcriptRoot({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' })).toBe('/c/projects');
    expect(transcriptRoot({ HOME: '/h' })).toBe('/h/.claude/projects');
    expect(transcriptRoot({ CLAUDE_CONFIG_DIR: '', HOME: '/h' })).toBe('/h/.claude/projects');
  });
  test('the project folder is the path with every non-alphanumeric character as -', () => {
    expect(projectFolder('/Users/someone/Projects/my.repo')).toBe('-Users-someone-Projects-my-repo');
  });
  test("an agent transcript's session transcript is <project>/<session>.jsonl", () => {
    expect(sessionTranscript('/p/proj/sess-1/subagents/agent-abc.jsonl')).toBe('/p/proj/sess-1.jsonl');
  });
});

describe('AC1: the Claude reader sums a window', () => {
  test('each message counts once; outside-window and malformed lines are skipped; only the model and four counts come back', async () => {
    const project = projectDir(claudeDir, repo);
    const lines = [
      userLine(at(0), 'sess-SECRETID'),
      ...messageLines({ id: 'msg_before', at: at(1), input: 1000, output: 1000, cacheWrite: 1000, cacheRead: 1000 }, 'sess-SECRETID'),
      ...messageLines({ id: 'msg_1', at: at(5), input: 10, output: 200, cacheWrite: 3000, cacheRead: 40000, blocks: 3 }, 'sess-SECRETID'),
      '{"timestamp": "2026-11-02T10:06:00.000Z", "message": {', // malformed (torn) line
      ...messageLines({ id: 'msg_2', at: at(7), input: 1, output: 20, cacheWrite: 300, cacheRead: 4000, model: 'claude-sonnet-4-5' }, 'sess-SECRETID'),
      ...messageLines({ id: 'msg_3', at: at(8), input: 2, output: 30, cacheWrite: 0, cacheRead: 5000, blocks: 1 }, 'sess-SECRETID'),
      ...messageLines({ id: 'msg_after', at: at(20), input: 9000, output: 9000, cacheWrite: 9000, cacheRead: 9000 }, 'sess-SECRETID'),
    ];
    await writeAgent(project, 'sess-SECRETID', 'a1b2c3', lines);
    const usage = await reader().agent('a1b2c3', { from: at(2), to: at(10) });
    // Hand-computed: msg_1 + msg_2 + msg_3, each once.
    expect(usage).toEqual({ model: 'claude-opus-4-5', input: 13, output: 250, cacheWrite: 3300, cacheRead: 49000 });
    expect(Object.keys(usage).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'model', 'output']);
    const text = JSON.stringify(usage);
    for (const leak of ['SECRET', 'sess-', '/secret/cwd', 'msg_', 'standard']) expect(text).not.toContain(leak);
  });

  test('the model is the one with the most output tokens', async () => {
    const project = projectDir(claudeDir, repo);
    await writeAgent(project, 's', 'm1', [
      ...messageLines({ id: 'a', at: at(1), input: 1, output: 10, cacheWrite: 0, cacheRead: 0, model: 'claude-opus-4-5' }, 's'),
      ...messageLines({ id: 'b', at: at(2), input: 1, output: 50, cacheWrite: 0, cacheRead: 0, model: 'claude-haiku-4-5' }, 's'),
    ]);
    expect(await reader().agent('m1', { from: at(0), to: at(3) })).toMatchObject({ model: 'claude-haiku-4-5', output: 60 });
  });

  test('the window is inclusive at both ends', async () => {
    await writeAgent(projectDir(claudeDir, repo), 's', 'edge', [
      ...messageLines({ id: 'a', at: at(1), input: 1, output: 0, cacheWrite: 0, cacheRead: 0 }, 's'),
      ...messageLines({ id: 'b', at: at(3), input: 2, output: 0, cacheWrite: 0, cacheRead: 0 }, 's'),
    ]);
    expect(await reader().agent('edge', { from: at(1), to: at(3) })).toMatchObject({ input: 3 });
  });

  test('looks under the repo root project folder first, then any project folder', async () => {
    const root = join(claudeDir, 'projects');
    await writeAgent(join(root, '-elsewhere'), 's', 'x1', messageLines({ id: 'a', at: at(1), input: 7, output: 0, cacheWrite: 0, cacheRead: 0 }, 's'));
    expect(await findAgentTranscript(root, repo, 'x1')).toBe(join(root, '-elsewhere', 's', 'subagents', 'agent-x1.jsonl'));
    expect(await reader().agent('x1', { from: at(0), to: at(2) })).toMatchObject({ input: 7 });
    await writeAgent(projectDir(claudeDir, repo), 's', 'x1', messageLines({ id: 'b', at: at(1), input: 9, output: 0, cacheWrite: 0, cacheRead: 0 }, 's'));
    expect(await reader().agent('x1', { from: at(0), to: at(2) })).toMatchObject({ input: 9 });
  });
});

describe('the Claude reader: unavailable', () => {
  test('a missing transcript, an unsafe id, an unknown format, and an empty window are one-line reasons', async () => {
    const r = reader();
    expect(await r.agent('nope', { from: at(0), to: at(1) })).toEqual({ unavailable: 'no Claude Code transcript for agent nope' });
    expect(await r.agent('../etc', { from: at(0), to: at(1) })).toEqual({ unavailable: 'agentId is not a safe id (want ^[A-Za-z0-9_-]+$)' });
    await writeAgent(projectDir(claudeDir, repo), 's', 'weird', ['{"ts":"x","msg":{}}', 'not json']);
    expect(await r.agent('weird', { from: at(0), to: at(1) })).toEqual({ unavailable: 'Claude Code transcript format not recognized' });
    await writeAgent(projectDir(claudeDir, repo), 's', 'quiet', messageLines({ id: 'a', at: at(9), input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }, 's'));
    expect(await r.agent('quiet', { from: at(0), to: at(1) })).toEqual({ unavailable: 'no assistant messages inside the span' });
  });
});

describe('the Claude reader: orchestrator', () => {
  test('sums the parent sessions of the agent ids inside the window, each message once', async () => {
    const project = projectDir(claudeDir, repo);
    await writeAgent(project, 'sess-a', 'ag1', messageLines({ id: 'x', at: at(1), input: 999, output: 999, cacheWrite: 0, cacheRead: 0 }, 'sess-a'));
    await writeAgent(project, 'sess-a', 'ag2', []);
    await writeAgent(project, 'sess-b', 'ag3', []);
    await writeSession(project, 'sess-a', [
      userLine(at(0), 'sess-a'),
      ...messageLines({ id: 'o1', at: at(2), input: 5, output: 50, cacheWrite: 500, cacheRead: 5000 }, 'sess-a'),
      ...messageLines({ id: 'o_late', at: at(30), input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }, 'sess-a'),
    ]);
    await writeSession(project, 'sess-b', messageLines({ id: 'o2', at: at(3), input: 1, output: 10, cacheWrite: 100, cacheRead: 1000 }, 'sess-b'));
    const usage = await reader().orchestrator(['ag1', 'ag2', 'ag3', 'missing'], { from: at(1), to: at(10) });
    expect(usage).toEqual({ model: 'claude-opus-4-5', input: 6, output: 60, cacheWrite: 600, cacheRead: 6000 });
  });

  test('no ids, no session found, or a missing session transcript is unavailable', async () => {
    const r = reader();
    expect(await r.orchestrator([], { from: at(0), to: at(1) })).toEqual({ unavailable: 'no agent ids recorded to find the orchestrating session' });
    expect(await r.orchestrator(['ghost'], { from: at(0), to: at(1) })).toEqual({ unavailable: 'no Claude Code session found from the agent ids' });
    await writeAgent(projectDir(claudeDir, repo), 'sess-c', 'ag', []);
    expect(await r.orchestrator(['ag'], { from: at(0), to: at(1) })).toEqual({ unavailable: 'an orchestrating session transcript is missing' });
  });

  test('a session with nothing in the window is zero, not unavailable', async () => {
    const project = projectDir(claudeDir, repo);
    await writeAgent(project, 'sess-d', 'ag', []);
    await writeFile(join(project, 'sess-d.jsonl'), `${messageLines({ id: 'o', at: at(50), input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }, 'sess-d').join('\n')}\n`);
    expect(await reader().orchestrator(['ag'], { from: at(0), to: at(1) })).toEqual({ model: null, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  });
});
