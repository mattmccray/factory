// Handing a needs-human command to T3 Code (036), in the Mac app only. The needs-human box's Approve
// and the Rework… and Abandon… sheets' button copy the command first, as before, so the clipboard
// always holds it; then they ask the Mac app to hand it off, through the one backend method the main
// window may call (HAND_OFF_METHOD), naming the project, the job, the action, and the person's note
// and nothing else: never a command or a prompt. The Mac app checks the request, builds the command
// itself, and, as its T3 Code setting says, opens a draft in T3 Code, sends it to a new thread, or
// does nothing more; it answers what it did, and the toast says so. Andon still writes no job state.
// In a browser there is no caller: the buttons only copy, as before. The small copy icon beside the
// command never hands off. Nothing here touches the DOM; App.svelte wires it.
import { copiedText } from './inspector';
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The one Mac app backend method the hand-off calls (tinyjs.json's `api` gate enables it by name). */
export const HAND_OFF_METHOD = 'handOff';

/** What the page names for a hand-off: approve takes no note; rework and abandon carry the typed one. */
export type HandoffRequest = { project: string; job: string; action: 'approve' } | { project: string; job: string; action: 'rework' | 'abandon'; note: string };

/** Send mode for a remote project: the Mac app opened a draft instead (`machine`: where the project is). */
export interface DraftedNotSent {
  outcome: 'drafted-not-sent';
  machine: string;
}

/** The project's repository is on several machines: nothing opened, copy only. */
export interface SeveralMachines {
  outcome: 'several-machines';
  project: string;
  machines: string[];
}

/** The project's GitHub remote isn't T3 Code's primary one: nothing opened, copy only (`primary`:
 *  the primary remote's name; `github`: the GitHub remote to make `upstream`). */
export interface GithubNotPrimary {
  outcome: 'github-not-primary';
  project: string;
  primary: string;
  github: string;
}

/** What the Mac app did: a draft opened, a thread sent, copy only, no GitHub remote for a draft, a
 *  draft opened in place of a send (a remote project), a repository on several machines, or a
 *  GitHub remote that isn't the primary one. */
export type HandoffOutcome = 'drafted' | 'sent' | 'copy-only' | 'no-github-remote' | DraftedNotSent | SeveralMachines | GithubNotPrimary;
type PlainOutcome = Extract<HandoffOutcome, string>;
const OUTCOMES: readonly PlainOutcome[] = ['drafted', 'sent', 'copy-only', 'no-github-remote'];

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const sameKeys = (r: Record<string, unknown>, want: readonly string[]): boolean => {
  const keys = Object.keys(r).sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i]);
};

/** The outcome in a backend answer, or null for anything else (a refused call's null, or junk): one
 *  of the four strings, `{ outcome: 'drafted-not-sent', machine }`, `{ outcome: 'several-machines',
 *  project, machines }` (a non-empty list), or `{ outcome: 'github-not-primary', project, primary,
 *  github }`, each with exactly those fields of non-empty strings. */
export function narrowOutcome(data: unknown): HandoffOutcome | null {
  const plain = OUTCOMES.find((o) => o === data);
  if (plain !== undefined) return plain;
  if (!isRecord(data)) return null;
  if (data.outcome === 'drafted-not-sent' && sameKeys(data, ['machine', 'outcome']) && nonEmpty(data.machine)) return { outcome: 'drafted-not-sent', machine: data.machine };
  if (data.outcome === 'several-machines' && sameKeys(data, ['machines', 'outcome', 'project']) && nonEmpty(data.project)) {
    const { machines } = data;
    if (!Array.isArray(machines) || machines.length === 0) return null;
    const names: string[] = [];
    for (const m of machines) {
      if (!nonEmpty(m)) return null;
      names.push(m);
    }
    return { outcome: 'several-machines', project: data.project, machines: names };
  }
  if (data.outcome === 'github-not-primary' && sameKeys(data, ['github', 'outcome', 'primary', 'project'])) {
    const { project, primary, github } = data;
    if (!nonEmpty(project) || !nonEmpty(primary) || !nonEmpty(github)) return null;
    return { outcome: 'github-not-primary', project, primary, github };
  }
  return null;
}

/** Ask the Mac app to hand a command off; resolves with what it did, or null. */
export type HandOff = (req: HandoffRequest) => Promise<HandoffOutcome | null>;

/**
 * How the page hands off: Tiny's backend call, found by narrowing the page's `window.tiny` (passed
 * in as `unknown`), and only ever with HAND_OFF_METHOD and the request. Null in a browser, or when it
 * isn't there.
 */
export function handOffCaller(mode: ShellMode, host: unknown): HandOff | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  return async (req) => {
    try {
      const r: unknown = await Reflect.apply(call, api, [HAND_OFF_METHOD, req]);
      return narrowOutcome(r);
    } catch {
      return null;
    }
  };
}

/** A toast: its text, and whether it reads as a success. */
export interface Toast {
  text: string;
  ok: boolean;
}

/** The toast when the clipboard write failed and nothing else took the command. */
export const COPY_FAILED = "Couldn't copy: select the command and copy it yourself";

/** The copy-only toast for a remote project's action: the command is on the clipboard, to run on that machine. */
export const remoteCopiedText = (machine: string): string => `Copied. Run it on ${machine}`;

/** Names joined for a sentence: "a", "a and b", "a, b, and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1] ?? ''}`;
}

/**
 * The toast after a copy and a hand-off: "Opened a draft in T3 Code" or "Sent to T3 Code" when the
 * Mac app did that; "Opened a draft in T3 Code (sending can't reach <machine>)" when send mode opened
 * a remote project's draft instead; "No GitHub remote; copied …" when a draft had no GitHub
 * primary remote; "<project> is on <m1> and <m2>; copied …" when its repository is on several
 * machines (so no draft could pick the right one); "T3 Code knows <project> by its <primary> remote,
 * not GitHub; make <github> its upstream remote to draft. Copied …" when its GitHub remote isn't
 * T3 Code's primary one; otherwise (copy
 * only, no `t3`, a refused call, a browser's null) "Copied …" as before, or, for a remote project
 * (`machine`, the machine it is on; brief andon-machines-ui), "Copied. Run it on <machine>". A
 * failed copy says so, unless T3 Code got the command anyway.
 */
export function handoffToast(copied: boolean, outcome: HandoffOutcome | null, command: string, machine: string | null = null): Toast {
  if (outcome === 'drafted') return { text: 'Opened a draft in T3 Code', ok: true };
  if (outcome === 'sent') return { text: 'Sent to T3 Code', ok: true };
  if (typeof outcome === 'object' && outcome?.outcome === 'drafted-not-sent') return { text: `Opened a draft in T3 Code (sending can't reach ${outcome.machine})`, ok: true };
  if (!copied) return { text: COPY_FAILED, ok: false };
  if (outcome === 'no-github-remote') return { text: `No GitHub remote; copied ${command}`, ok: true };
  if (typeof outcome === 'object' && outcome?.outcome === 'github-not-primary')
    return { text: `T3 Code knows ${outcome.project} by its ${outcome.primary} remote, not GitHub; make ${outcome.github} its upstream remote to draft. Copied ${command}`, ok: true };
  if (typeof outcome === 'object' && outcome?.outcome === 'several-machines') return { text: `${outcome.project} is on ${joinNames(outcome.machines)}; copied ${command}`, ok: true };
  if (machine !== null) return { text: remoteCopiedText(machine), ok: true };
  return { text: copiedText(command), ok: true };
}
