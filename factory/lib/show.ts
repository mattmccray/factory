// Human-readable timing summary for `factory/cli.ts show`. Pure: `now` drives open spans.
import type { JobSnapshot } from './project';

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function span(ms: number | null, openSince: string, now: Date): string {
  return ms !== null ? duration(ms) : `running ${duration(now.getTime() - Date.parse(openSince))}`;
}

export function formatShow(snap: JobSnapshot, now: Date): string[] {
  const out = [`${snap.id}  ${snap.stage}${snap.title ? `  ${snap.title}` : ''}`];
  for (const s of snap.timing.stages) {
    const head = `stage  ${s.stage}${s.round ? ` r${s.round}` : ''}`;
    // merged is terminal: its span never closes, and it isn't running either.
    out.push(s.stage === 'merged' ? head : `${head}  ${span(s.ms, s.enteredAt, now)}`);
  }
  for (const a of snap.timing.agents) {
    const who = [a.role, a.key, a.round !== null ? `r${a.round}` : null, a.name].filter((x) => x !== null).join(' ');
    out.push(`agent  ${who}  ${span(a.ms, a.startedAt, now)}${a.verdict ? `  ${a.verdict}` : ''}`);
  }
  return out;
}
