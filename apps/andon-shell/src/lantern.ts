// The lantern: what the Dock icon, the tray icon, and the Dock badge show for the board's state,
// across the listed projects only (the same rule as `needsHumanCount`). A stage the shell doesn't
// know counts as neither running nor needs-human. Runtime-neutral.
import { NEEDS_HUMAN } from './badge';
import type { ShellJob, ShellState } from './state';

/** The Dock icon: unlit (idle), blue flame (running), orange flame (escalated). */
export type DockLook = 'idle' | 'running' | 'escalated';

/** The working stages (docs/contract/v1.md): a job in one of these is running. */
export const RUNNING_STAGES: readonly string[] = ['claimed', 'spec', 'build', 'review', 'approve'];

function anyJob(s: ShellState, match: (j: ShellJob) => boolean): boolean {
  for (const p of s.projects) for (const j of s.boards[p.id]?.jobs ?? []) if (match(j)) return true;
  return false;
}

/** True when any listed job is in a running stage, whatever the needs-human count is. */
export const trayRunning = (s: ShellState): boolean => anyJob(s, (j) => RUNNING_STAGES.includes(j.stage));

/** `escalated` when any job needs a human (it wins), `running` when any job is running, else `idle`. */
export function dockLook(s: ShellState): DockLook {
  if (anyJob(s, (j) => j.stage === NEEDS_HUMAN)) return 'escalated';
  return trayRunning(s) ? 'running' : 'idle';
}

/** The Dock badge: cleared (`''`) at 0, else the count, the same text as the tray title. */
export const badgeText = (n: number): string => (n === 0 ? '' : String(n));
