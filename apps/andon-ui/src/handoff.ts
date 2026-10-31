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

/** What the Mac app did: a draft opened, a thread sent, copy only, or no GitHub remote for a draft. */
export type HandoffOutcome = 'drafted' | 'sent' | 'copy-only' | 'no-github-remote';
const OUTCOMES: readonly HandoffOutcome[] = ['drafted', 'sent', 'copy-only', 'no-github-remote'];

/** The outcome in a backend answer, or null for anything else (a refused call's null, or junk). */
export const narrowOutcome = (data: unknown): HandoffOutcome | null => OUTCOMES.find((o) => o === data) ?? null;

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

/**
 * The toast after a copy and a hand-off: "Opened a draft in T3 Code" or "Sent to T3 Code" when the
 * Mac app did that; "No GitHub remote; copied …" when a draft had no GitHub origin; otherwise (copy
 * only, no `t3`, a refused call, a browser's null) "Copied …" as before, or, for a remote project
 * (`machine`, the machine it is on; brief andon-machines-ui), "Copied. Run it on <machine>". A
 * failed copy says so, unless T3 Code got the command anyway.
 */
export function handoffToast(copied: boolean, outcome: HandoffOutcome | null, command: string, machine: string | null = null): Toast {
  if (outcome === 'drafted') return { text: 'Opened a draft in T3 Code', ok: true };
  if (outcome === 'sent') return { text: 'Sent to T3 Code', ok: true };
  if (!copied) return { text: COPY_FAILED, ok: false };
  if (outcome === 'no-github-remote') return { text: `No GitHub remote; copied ${command}`, ok: true };
  if (machine !== null) return { text: remoteCopiedText(machine), ok: true };
  return { text: copiedText(command), ok: true };
}
