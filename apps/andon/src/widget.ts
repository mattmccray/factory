// The desk widget's three backend methods (092), runtime-neutral: their names, the window check each
// makes first, and the checks on what the widget page sends. The page names a project id and a job id
// (a pill's click: `openJob`), nothing (a click elsewhere on the glass: `showAndon`), or its glass's
// height (`fitWidget`, after a render that changed it and after a drag), and nothing else. backend.ts
// answers each only for the widget window, shows the main window and asks its page to select the job
// (the `openjob` event, a request the page checks), sizes the window, and remembers where it sits.
// The id checks are reimplemented here, on purpose: contract code must not run in the Mac app
// (boundary.test.ts).
import { WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT, WIDGET_WINDOW_ID } from './appmenu';
import { JOB_ID_PATTERN } from './jobmenu';
import { isRecord } from './state';

/** The widget page's three backend methods (tinyjs.json's `api` gate names each). */
export const OPEN_JOB_METHOD = 'openJob';
export const SHOW_ANDON_METHOD = 'showAndon';
export const FIT_WIDGET_METHOD = 'fitWidget';

/** The call came from the desk widget window: Tiny's api meta names its id. Anything else is refused. */
export const fromWidgetWindow = (meta: unknown): boolean => isRecord(meta) && meta.window === WIDGET_WINDOW_ID;

/** A project id as the service lists it: 12 hex digits (the hash of its root), and, for a project on
 *  another machine, `@` and that machine's name (lowercase letters, digits, and inner hyphens). */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{12}(?:@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$/;
export const isProjectId = (v: unknown): v is string => typeof v === 'string' && PROJECT_ID_PATTERN.test(v);

/** A pill's click: the job's project id and its id. */
export interface OpenJobRequest {
  project: string;
  job: string;
}

/** The page's open-job request: exactly a well-formed project id and a job id of the factory form.
 *  Null for anything else, including a request that carries any other field. */
export function openJobRequest(params: unknown): OpenJobRequest | null {
  if (!isRecord(params)) return null;
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== 'job' || keys[1] !== 'project') return null;
  const { project, job } = params;
  if (!isProjectId(project) || typeof job !== 'string' || !JOB_ID_PATTERN.test(job)) return null;
  return { project, job };
}

/** The payload of the open-job event to the main window's page: the job's route ref (`{ project, id }`), nothing else. */
export const openJobPayload = (req: OpenJobRequest): { project: string; id: string } => ({ project: req.project, id: req.job });

/** The page's fit request: exactly a whole-point `height` within the widget's bounds. Null for anything else. */
export function fitRequest(params: unknown): { height: number } | null {
  if (!isRecord(params)) return null;
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== 'height') return null;
  const { height } = params;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < WIDGET_MIN_HEIGHT || height > WIDGET_MAX_HEIGHT) return null;
  return { height };
}
