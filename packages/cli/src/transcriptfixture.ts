// Test helper: writes Claude Code-shaped transcripts under a temp `CLAUDE_CONFIG_DIR` (never the
// real ~/.claude). Each assistant message is written as one line per content block, every line
// repeating the message's usage, as Claude Code does.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectFolder } from './usage-claude';

export interface FakeMessage {
  id: string;
  at: string; // ISO timestamp
  model?: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  blocks?: number; // lines written for it (default 2)
}

/** The lines Claude Code would write for `m`, with prompt-like content that must never be copied. */
export function messageLines(m: FakeMessage, sessionId: string): string[] {
  const usage = { input_tokens: m.input, output_tokens: m.output, cache_creation_input_tokens: m.cacheWrite, cache_read_input_tokens: m.cacheRead, service_tier: 'standard' };
  const out: string[] = [];
  for (let b = 0; b < (m.blocks ?? 2); b++) {
    out.push(JSON.stringify({
      type: 'assistant',
      sessionId,
      cwd: '/secret/cwd',
      timestamp: m.at,
      uuid: `${m.id}-${b}`,
      message: { id: m.id, role: 'assistant', model: m.model ?? 'claude-opus-4-5', content: [{ type: 'text', text: `SECRET PROMPT TEXT ${b}` }], usage },
    }));
  }
  return out;
}

/** A user line (no usage), as the transcript's first line, the spawn card, would be. */
export const userLine = (at: string, sessionId: string): string =>
  JSON.stringify({ type: 'user', sessionId, timestamp: at, message: { role: 'user', content: 'SECRET CARD' } });

/** Where transcripts for `repo` go: `<claudeDir>/projects/<project folder>`. */
export const projectDir = (claudeDir: string, repo: string): string => join(claudeDir, 'projects', projectFolder(repo));

/** Appends lines to the agent transcript `<project>/<session>/subagents/agent-<id>.jsonl`. */
export async function writeAgent(project: string, session: string, agentId: string, lines: string[]): Promise<string> {
  const dir = join(project, session, 'subagents');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.jsonl`);
  await appendFile(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

/** Appends lines to the session transcript `<project>/<session>.jsonl`. */
export async function writeSession(project: string, session: string, lines: string[]): Promise<string> {
  await mkdir(project, { recursive: true });
  const path = join(project, `${session}.jsonl`);
  await appendFile(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}
