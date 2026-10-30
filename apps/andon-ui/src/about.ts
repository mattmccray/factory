// The Mac app's About window: its page is this UI's about view (`?shell=mac&view=about`, see
// sidebar.ts `appView`). The view asks the Mac app for its version and the GitHub URL through
// `getAbout`, and closes its window on Escape through `closeAbout` (the backend answers both only
// for the About window; they are the two methods it may call), and
// reads the service's release from `GET /release`. The model here is pure and never throws: a
// missing or malformed answer leaves out the version line (and the link, whose URL only the Mac
// app's answer carries: it is the Mac app's one GITHUB_URL constant, never repeated here), and a
// missing or malformed release leaves out the service line. In a browser there is no About window and nothing here runs.
// Nothing here touches the DOM; About.svelte lays it out.
import { isRecord } from './job';
import { toReleaseInfo } from './release';
import type { ShellMode } from './sidebar';

/** The Mac app backend method the about view reads its lines with (tinyjs.json's `api` gate enables it by name). */
export const GET_ABOUT_METHOD = 'getAbout';
/** The Mac app backend method the about view closes its window with, on Escape (enabled by name, too). */
export const CLOSE_ABOUT_METHOD = 'closeAbout';

/** The art, served same-origin from the UI build (public/about.png, a copy of apps/andon/assets/about.png). */
export const ART_PATH = '/about.png';
export const APP_NAME = 'Andon';
export const GITHUB_LABEL = 'Factory on GitHub';
export const COPYRIGHT = '© 2026 Matt McCray';
export const RESTART_NEEDED = 'restart needed';

/** The Mac app's answer: its version and the GitHub URL. */
export interface AppAbout {
  version: string;
  github: string;
}

/** The answer, narrowed: a plain object with a non-empty string `version` and an https `github`;
 *  null for anything else (or a refused call's null). */
export function narrowAbout(data: unknown): AppAbout | null {
  if (!isRecord(data)) return null;
  const { version, github } = data;
  if (typeof version !== 'string' || version === '' || typeof github !== 'string' || !github.startsWith('https://')) return null;
  return { version, github };
}

/** What the about view shows, line by line; a null line is left out. */
export interface AboutModel {
  art: string;
  name: string;
  version: string | null; // "Version 0.2.0"
  service: string | null; // "Service 0.1.0", or "Service 0.1.0 · restart needed"
  github: { href: string; label: string } | null; // from the Mac app's answer
  copyright: string;
}

/** The about view's lines, from the Mac app's answer and the `GET /release` body (each raw, or null when it couldn't be read). */
export function aboutModel(app: unknown, release: unknown): AboutModel {
  const a = narrowAbout(app);
  const r = toReleaseInfo(release);
  let service: string | null = null;
  if (r !== null && r.running !== null && r.running !== a?.version) {
    const restart = r.onDisk !== null && r.onDisk !== r.running; // the footer's own condition (sidebar.ts footerRelease)
    service = `Service ${r.running}${restart ? ` · ${RESTART_NEEDED}` : ''}`;
  }
  return {
    art: ART_PATH,
    name: APP_NAME,
    version: a === null ? null : `Version ${a.version}`,
    service,
    github: a === null ? null : { href: a.github, label: GITHUB_LABEL },
    copyright: COPYRIGHT,
  };
}

/** Tiny's backend call and the object it belongs to, narrowed from the page's `window.tiny` (passed
 *  in as `unknown`); null in a browser, or when it isn't there. */
function tinyCall(mode: ShellMode, host: unknown): { api: Record<string, unknown>; call: Function } | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  return { api, call };
}

/**
 * How the about view asks the Mac app: Tiny's backend call, only ever with the one fixed method
 * name and no params. Resolves the raw answer, or null when it throws or rejects. Null in a
 * browser, or when it isn't there.
 */
export function aboutCaller(mode: ShellMode, host: unknown): (() => Promise<unknown>) | null {
  const t = tinyCall(mode, host);
  if (t === null) return null;
  const { api, call } = t;
  return async () => {
    try {
      const r: unknown = await Reflect.apply(call, api, [GET_ABOUT_METHOD, null]);
      return r;
    } catch {
      return null;
    }
  };
}

/**
 * How the about view closes its window on Escape: Tiny's backend call, only ever with the one fixed
 * method name and no params. A throw or rejection is swallowed (the window just stays open). Null
 * in a browser, or when it isn't there: Escape then does nothing.
 */
export function closeAboutCaller(mode: ShellMode, host: unknown): (() => Promise<void>) | null {
  const t = tinyCall(mode, host);
  if (t === null) return null;
  const { api, call } = t;
  return async () => {
    try {
      await Reflect.apply(call, api, [CLOSE_ABOUT_METHOD, null]);
    } catch {
      // the window stays open
    }
  };
}

/** The key that closes the About window: a bare Escape (no modifier, not mid-composition, not a repeat). */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}

export const isCloseKey = (e: KeyLike): boolean => e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !e.repeat;
