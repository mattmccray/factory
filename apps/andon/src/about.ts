// The About window's two backend methods, runtime-neutral: their names, the window check each makes
// first, and `getAbout`'s answer (the Mac app's version and the repo page Help → Factory on GitHub
// opens). backend.ts answers `getAbout` only for the About window, with the version build.ts fixes
// into the bundle from apps/andon/package.json, and carries out `closeAbout` (Escape on the about
// view) only for the About window, with no params.
import { ABOUT_WINDOW_ID, GITHUB_URL } from './appmenu';
import { isRecord } from './state';

/** The backend method the About window calls for its lines (tinyjs.json's `api` gate names it). */
export const GET_ABOUT_METHOD = 'getAbout';
/** The backend method the About window calls on Escape: it closes the About window and nothing else
 *  (tinyjs.json's `api` gate names it; `win.close` stays disabled, since on main it quits the app). */
export const CLOSE_ABOUT_METHOD = 'closeAbout';

/** What the About window reads: the Mac app's version and the GitHub URL. */
export interface About {
  version: string;
  github: string;
}

/** The answer for the Mac app's version. */
export const aboutAnswer = (version: string): About => ({ version, github: GITHUB_URL });

/** The call came from the About window: Tiny's api meta names its id. Anything else is refused. */
export const fromAboutWindow = (meta: unknown): boolean => isRecord(meta) && meta.window === ABOUT_WINDOW_ID;

/** `closeAbout` takes no params: only a missing or null one is accepted. */
export const noParams = (params: unknown): boolean => params === null || params === undefined;
