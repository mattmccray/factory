// The tray badge: how many jobs need a human across every registered project, and the tray spec
// built from that count. Runtime-neutral.
import type { ShellState } from './state';

export const NEEDS_HUMAN = 'needs-human';

/** Jobs whose `stage` is `needs-human`, across the listed projects only. */
export function needsHumanCount(s: ShellState): number {
  let n = 0;
  for (const p of s.projects) for (const j of s.boards[p.id]?.jobs ?? []) if (j.stage === NEEDS_HUMAN) n++;
  return n;
}

export type TrayMenuItem = { id: string; label: string } | { separator: true };

export interface TraySpec {
  title: string;
  tooltip: string;
  menu: TrayMenuItem[];
}

export const SHOW_ID = 'show';
export const QUIT_ID = 'quit';
export const TRAY_MENU: TrayMenuItem[] = [{ id: SHOW_ID, label: 'Show Andon' }, { separator: true }, { id: QUIT_ID, label: 'Quit' }];

const spec = (title: string, tooltip: string): TraySpec => ({ title, tooltip, menu: TRAY_MENU });

/** The title is the count (empty at 0); the tooltip says it in words. */
export const traySpec = (n: number): TraySpec =>
  n === 0 ? spec('', 'Andon: all clear') : spec(String(n), `Andon: ${n} ${n === 1 ? 'needs' : 'need'} a human`);

/** Before the agent answers, or when it never does (`reason` is the one-line failure). */
export const trayNotice = (text: string): TraySpec => spec('', `Andon: ${text}`);
