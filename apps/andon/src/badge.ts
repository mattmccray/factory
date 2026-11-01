// The tray badge: how many jobs need a human across every registered project, plus each epic
// waiting on you (`waitingOn: "you"`, as the UI's sidebar counts it), and the tray spec built from
// that count, and the tray menu (Show Andon, the Desk Widget checkmark item, Quit). Runtime-neutral.
import { DESK_WIDGET_ID, DESK_WIDGET_LABEL } from './appmenu';
import { epicsOf, waitsOnYou } from './state';
import type { AppState } from './state';

export const NEEDS_HUMAN = 'needs-human';

/** Jobs whose `stage` is `needs-human`, plus epics waiting on you, across the listed projects only. */
export function needsHumanCount(s: AppState): number {
  let n = 0;
  for (const p of s.projects) {
    for (const j of s.boards[p.id]?.jobs ?? []) if (j.stage === NEEDS_HUMAN) n++;
    n += epicsOf(s.boards[p.id]).filter(waitsOnYou).length;
  }
  return n;
}

export type TrayMenuItem = { id: string; label: string; checked?: boolean } | { separator: true };

export interface TraySpec {
  title: string;
  tooltip: string;
  menu: TrayMenuItem[];
  /** A left click fires the tray click (the window toggle); the menu opens on right- or ctrl-click. */
  primaryAction: boolean;
}

export const SHOW_ID = 'show';
export const QUIT_ID = 'quit';

/** The tray menu: Show Andon, Desk Widget (092; checked while the desk widget is on, the same item the
 *  Window menu shows), then Quit. */
export function trayMenu(deskWidget: boolean): TrayMenuItem[] {
  return [{ id: SHOW_ID, label: 'Show Andon' }, { id: DESK_WIDGET_ID, label: DESK_WIDGET_LABEL, checked: deskWidget }, { separator: true }, { id: QUIT_ID, label: 'Quit' }];
}

/** The tray menu with the desk widget off: what every tray spec carries until the adapter sets the
 *  real state (`withDeskWidget`). */
export const TRAY_MENU: TrayMenuItem[] = trayMenu(false);

const spec = (title: string, tooltip: string): TraySpec => ({ title, tooltip, menu: TRAY_MENU, primaryAction: true });

/** The title is the count (empty at 0); the tooltip says it in words. */
export const traySpec = (n: number): TraySpec =>
  n === 0 ? spec('', 'Andon: all clear') : spec(String(n), `Andon: ${n} ${n === 1 ? 'needs' : 'need'} a human`);

/** A tray spec with its menu showing the desk widget's state. */
export const withDeskWidget = (spec: TraySpec, deskWidget: boolean): TraySpec => ({ ...spec, menu: trayMenu(deskWidget) });

/** Before the service answers, or when it never does (`reason` is the one-line failure). */
export const trayNotice = (text: string): TraySpec => spec('', `Andon: ${text}`);
