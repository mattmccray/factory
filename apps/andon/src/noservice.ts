// What the main window shows while no Andon service answers, and when it switches. The window first
// loads tinyjs.json's `url`; with no service there, it would stay blank. So on the first miss the
// adapter loads this page in its place, and once the service answers it loads the board. The page
// is one plain string: self-contained (inline CSS, no scripts, no network), light and dark, and
// quiet like the board (system font, its neutral colors). The app never starts the service
// (decision 10): the page names the two commands that do. Runtime-neutral, no host calls.
import type { Found } from './autostart';
import { DEFAULT_PORT } from './autostart';

/** The page's heading, the words the user reads first. */
export const NO_SERVICE_TITLE = 'No Andon service is answering';
/** The command that installs (and starts) the service. */
export const INSTALL_COMMAND = 'factory service install';
/** The command that starts an installed service that is stopped. */
export const START_COMMAND = 'factory service start';

/** No scripts, no network: inline styles only. */
export const NO_SERVICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

// Light first, dark in the media rule: the board's tokens (apps/andon-ui's app.css), by value.
const STYLE = [
  ':root { color-scheme: light dark; --win: #f6f6f6; --label: rgba(0, 0, 0, .85); --label2: rgba(0, 0, 0, .62); --sep: rgba(0, 0, 0, .1); --ctl: rgba(0, 0, 0, .05);',
  '  --sys: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; }',
  '@media (prefers-color-scheme: dark) {',
  '  :root { --win: #1e1e20; --label: rgba(255, 255, 255, .88); --label2: rgba(255, 255, 255, .62); --sep: rgba(255, 255, 255, .09); --ctl: rgba(255, 255, 255, .08); }',
  '}',
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; height: 100%; }',
  // the top padding clears the traffic lights (tinyjs.json's windowControlsPos, y 20) at any window size
  'body { display: flex; align-items: center; justify-content: center; padding: 64px 32px 32px; background: var(--win); color: var(--label);',
  '  font: 13px/1.45 var(--sys); -webkit-font-smoothing: antialiased; }',
  'main { max-width: 440px; }',
  'h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }',
  'p { margin: 0 0 14px; color: var(--label2); }',
  'ol { margin: 0; padding: 0; list-style: none; }',
  'li { margin: 0 0 12px; color: var(--label2); }',
  'code { display: block; margin-top: 5px; padding: 6px 10px; border: .5px solid var(--sep); border-radius: 6px; background: var(--ctl);',
  '  color: var(--label); font: 12px/1.4 var(--mono); -webkit-user-select: text; user-select: text; }',
].join('\n');

/** The no-service page: one complete HTML document, with no scripts and nothing loaded over the network. */
export function noServicePage(): string {
  return [
    '<!doctype html>',
    '<html lang="en-US">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${NO_SERVICE_CSP}">`,
    '<meta name="color-scheme" content="light dark">',
    `<title>${NO_SERVICE_TITLE}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${NO_SERVICE_TITLE}</h1>`,
    '<p>Andon shows the board once its service is running. Run one of these in a terminal, and this window switches to the board.</p>',
    '<ol>',
    `<li>Install the service:<code>${INSTALL_COMMAND}</code></li>`,
    `<li>Or, if it's already installed, start it:<code>${START_COMMAND}</code></li>`,
    '</ol>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A step of the launch-time probe loop: its first miss, or its end (`waitForService`'s outcome). */
export type ProbeStep = { kind: 'miss' } | { kind: 'done'; found: Found; port: number };

/** What the main window loads at a step: the no-service page, the board, or nothing. */
export type WindowLoad = 'page' | 'board' | 'none';

/**
 * When the main window switches. `current` is false once the app is quitting or a newer lifecycle
 * began: then nothing loads. On the first miss, the page. When the service answers after a miss, or
 * on a port other than tinyjs.json's, the board; at the default port with no miss, the window
 * already shows it.
 */
export function windowLoad(step: ProbeStep, current: boolean): WindowLoad {
  if (!current) return 'none';
  if (step.kind === 'miss') return 'page';
  if (!step.found.answered) return 'none';
  return step.found.waited || step.port !== DEFAULT_PORT ? 'board' : 'none';
}
