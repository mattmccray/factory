// The inspector's pure model (design §8, §9): the needs-human commands, the verdict tones, the
// inspector's width, the sidebar's auto-hide rule, the file list (today's groupsOf() and pickFile()
// with a timing row and the current round), and the Settled sheet's rows. Andon never runs a
// command itself: these strings go on the clipboard for the person to run and, in the Mac app, can
// be handed to T3 Code (handoff.ts; the Mac app builds the same string itself, and a test pins that
// they agree). Nothing here touches the DOM; Inspector.svelte, CommandSheet.svelte, and SettledSheet.svelte lay it out.
import type { DocFile } from './api';
import { mergedAt } from './board';
import type { BoardJob } from './board';
import { TIMING, groupsOf, pickFile } from './docs';
import type { FileGroup } from './docs';
import { fmt, time } from './time';

// ---- the commands ----

/** A free-text argument for the skill: trimmed, newlines as spaces, `"` and `\` escaped, in double quotes. */
export function quoteArg(text: string): string {
  const flat = text.trim().replace(/\r\n|\r|\n/g, ' ');
  return `"${flat.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** A command line, and whether it may be copied (the skill requires a note or reason). */
export interface Command {
  text: string;
  copyable: boolean;
}

export const approveCommand = (id: string): string => `/factory approve ${id}`;

export const reworkCommand = (id: string, note: string): Command => ({ text: `/factory rework ${id} ${quoteArg(note)}`, copyable: note.trim() !== '' });

export const abandonCommand = (id: string, reason: string): Command => ({ text: `/factory abandon ${id} ${quoteArg(reason)}`, copyable: reason.trim() !== '' });

/** The sheets that build a command from free text. */
export type SheetKind = 'rework' | 'abandon';

/** The HUD toast after a copy. */
export const copiedText = (command: string): string => `Copied ${command}`;

/** How long the toast shows. */
export const TOAST_MS = 1600;

// ---- verdicts ----

export type Tone = 'green' | 'orange' | 'red';

/** A verdict's color: PASS and APPROVE green, CHANGES orange, ESCALATE red. */
export function verdictTone(verdict: string | null): Tone | null {
  switch (verdict) {
    case 'PASS':
    case 'APPROVE':
      return 'green';
    case 'CHANGES':
      return 'orange';
    case 'ESCALATE':
      return 'red';
    default:
      return null;
  }
}

// ---- the inspector's width and the sidebar ----

export const INSPECTOR_MIN = 320;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 392;

/** A requested width, whole pixels within 320–560; anything not a number is the default. */
export const clampWidth = (w: number): number => (Number.isFinite(w) ? Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(w))) : INSPECTOR_DEFAULT);

/** Below this window width an open inspector hides the sidebar. */
export const AUTO_HIDE_BELOW = 1640;

export const autoHides = (windowWidth: number, inspectorOpen: boolean): boolean => inspectorOpen && windowWidth < AUTO_HIDE_BELOW;

/**
 * The sidebar's state: the user's own choice, and whether the user showed it over the auto-hide
 * rule while the inspector was open (cleared when the inspector closes).
 */
export interface SidebarChoice {
  user: boolean;
  override: boolean;
}

/** Whether the sidebar is on screen. Closing the inspector leaves only the user's choice. */
export const sidebarShown = (c: SidebarChoice, windowWidth: number, inspectorOpen: boolean): boolean =>
  c.user && (c.override || !autoHides(windowWidth, inspectorOpen));

/** The toolbar's sidebar toggle: always flips what is on screen. */
export function toggleSidebar(c: SidebarChoice, windowWidth: number, inspectorOpen: boolean): SidebarChoice {
  if (sidebarShown(c, windowWidth, inspectorOpen)) return { user: false, override: false };
  return { user: true, override: autoHides(windowWidth, inspectorOpen) };
}

// ---- the file list ----

/** The highest "Round N" group's name, or null when there is no round yet. */
export function currentRound(groups: readonly FileGroup[]): string | null {
  let best: { name: string; n: number } | null = null;
  for (const g of groups) {
    const m = /^Round (\d+)$/.exec(g.name);
    const n = m === null ? NaN : Number(m[1]);
    if (!Number.isNaN(n) && (best === null || n > best.n)) best = { name: g.name, n };
  }
  return best?.name ?? null;
}

export interface FileRow {
  path: string; // a doc's path, or TIMING
  label: string;
  verdict: string | null;
  tone: Tone | null;
}

export interface FileModel {
  groups: Array<{ name: string; current: boolean; rows: FileRow[] }>;
  order: string[]; // every row's path, top to bottom, for ↑ and ↓
  selected: string | null;
}

/**
 * The inspector's Files list: groupsOf()'s groups (Job, then each Round N), with a timing row first
 * in Job when the job has timing, the highest round marked current, and pickFile()'s selection.
 * An empty group is left out.
 */
export function fileModel(files: readonly DocFile[], hasTiming: boolean, chosen: string | null): FileModel {
  const raw = groupsOf(files);
  const current = currentRound(raw);
  const groups = raw
    .map((g) => {
      const rows: FileRow[] = g.files.map((f) => ({ ...f, tone: verdictTone(f.verdict) }));
      if (g.name === 'Job' && hasTiming) rows.unshift({ path: TIMING, label: 'timing', verdict: null, tone: null });
      return { name: g.name, current: g.name === current, rows };
    })
    .filter((g) => g.rows.length > 0);
  return { groups, order: groups.flatMap((g) => g.rows.map((r) => r.path)), selected: pickFile(chosen, files, hasTiming) };
}

/** The row `delta` steps from `current`, stopping at either end; from nothing, the first row. */
export function stepFile(order: readonly string[], current: string | null, delta: number): string | null {
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return order[0] ?? null;
  return order[Math.min(order.length - 1, Math.max(0, i + delta))] ?? null;
}

// ---- the Settled sheet ----

export interface SettledRow {
  key: string;
  id: string;
  title: string;
  project: string; // the project's name
  end: number; // the merge or abandon time, ms
  total: string; // claim to end, or "—"
  rounds: string; // "2 rounds", or "—"
  tag: 'Abandoned' | null;
  reason: string | null; // an abandoned job's `note`
}

const rounds = (n: number): string => (n > 0 ? `${n} round${n > 1 ? 's' : ''}` : '—');

/** The Settled sheet's rows, newest end first, optionally one project's only. */
export function settledRows(settled: readonly BoardJob[], project: string | null): SettledRow[] {
  return settled
    .filter((b) => project === null || b.project.id === project)
    .map((b): SettledRow => {
      const j = b.job;
      const abandoned = j.stage === 'abandoned';
      return {
        key: b.key,
        id: j.id,
        title: j.title,
        project: b.project.name,
        end: mergedAt(j),
        total: j.startedAt !== null && j.endedAt !== null ? fmt(time(j.endedAt) - time(j.startedAt)) : '—',
        rounds: rounds(j.round),
        tag: abandoned ? 'Abandoned' : null,
        reason: abandoned ? j.note : null,
      };
    })
    .sort((x, y) => y.end - x.end);
}

/** "Settled · merged more than 24h ago", with each distinct setting among the jobs shown. */
export function settledTitle(settled: readonly BoardJob[]): string {
  const hours = [...new Set(settled.map((b) => b.settleAfterHours))].sort((a, b) => a - b);
  return `Settled · merged more than ${(hours.length > 0 ? hours : [24]).map((h) => `${h}h`).join(' / ')} ago`;
}
