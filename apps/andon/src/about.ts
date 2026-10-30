// The About window's one backend method, runtime-neutral: its name, the window check it makes first,
// and its answer (the Mac app's version and the repo page Help → Factory on GitHub opens).
// backend.ts answers it only for the About window, with the version build.ts fixes into the bundle
// from apps/andon/package.json.
import { ABOUT_WINDOW_ID, GITHUB_URL } from './appmenu';
import { isRecord } from './state';

/** The one backend method the About window calls (tinyjs.json's `api` gate names it). */
export const GET_ABOUT_METHOD = 'getAbout';

/** What the About window reads: the Mac app's version and the GitHub URL. */
export interface About {
  version: string;
  github: string;
}

/** The answer for the Mac app's version. */
export const aboutAnswer = (version: string): About => ({ version, github: GITHUB_URL });

/** The call came from the About window: Tiny's api meta names its id. Anything else is refused. */
export const fromAboutWindow = (meta: unknown): boolean => isRecord(meta) && meta.window === ABOUT_WINDOW_ID;
