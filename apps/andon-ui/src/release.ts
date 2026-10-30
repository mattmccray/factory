// Factory releases, as the Andon service reports them (docs/contract/v1.md "Andon service": the
// `release` on each project entry, `GET /release`, and the `release` event). Andon only displays
// versions (decision 14): a behind project gets a quiet glyph, every state gets a hover line, the
// footer shows the machine's release or a restart note, and the What's New sheet lists the
// changelog, whole or scoped to the releases one project is missing. The two commands it builds are
// only copied (decision 10): Andon never runs `factory upgrade` or restarts the service.
// Pure: nothing here touches the DOM, and it imports no service code. An older service sends none
// of this; every reader here turns a missing or malformed value into none.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null | undefined => (typeof v === 'string' ? v : v === null ? null : undefined);

// ---- a project's release ----

/** How a project's installed release compares with the service's running one. */
export type ReleaseState = 'current' | 'behind' | 'ahead' | 'unknown';
const STATES: readonly ReleaseState[] = ['current', 'behind', 'ahead', 'unknown'];

/** A project entry's `release`: its installed factory release and how it compares. */
export interface ProjectRelease {
  installed: string | null; // the `version` of its factory/managed.json; null: unstamped or unreadable
  state: ReleaseState;
}

/**
 * Narrows a project entry's `release`. Anything but `{ installed: <string | null>, state: <one of
 * the four> }` is none (null), as is a compared state (`current`, `behind`, `ahead`) with no
 * installed version, which the service never sends.
 */
export function toProjectRelease(v: unknown): ProjectRelease | null {
  if (!isObject(v)) return null;
  const installed = strOrNull(v.installed);
  const state = STATES.find((s) => s === v.state);
  if (installed === undefined || state === undefined) return null;
  if (state !== 'unknown' && installed === null) return null;
  return { installed, state };
}

// ---- the service's release and changelog ----

export interface ChangelogEntry {
  area: string | null;
  text: string;
  job: string | null;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  sections: { breaking: ChangelogEntry[]; added: ChangelogEntry[]; fixed: ChangelogEntry[] };
}

/** `GET /release` and the `release` event: the release the service runs, the one on disk, and the changelog. */
export interface ReleaseInfo {
  running: string | null;
  onDisk: string | null;
  changelog: ChangelogRelease[];
}

function entry(v: unknown): ChangelogEntry | null {
  if (!isObject(v) || typeof v.text !== 'string') return null;
  const area = strOrNull(v.area) ?? null;
  const job = strOrNull(v.job) ?? null;
  return { area: area === '' ? null : area, text: v.text, job: job === '' ? null : job };
}

const entries = (v: unknown): ChangelogEntry[] => (Array.isArray(v) ? v.map(entry).filter((e): e is ChangelogEntry => e !== null) : []);

function changelogRelease(v: unknown): ChangelogRelease | null {
  if (!isObject(v) || typeof v.version !== 'string' || v.version === '') return null;
  const s = isObject(v.sections) ? v.sections : {};
  return { version: v.version, date: typeof v.date === 'string' ? v.date : '', sections: { breaking: entries(s.breaking), added: entries(s.added), fixed: entries(s.fixed) } };
}

/**
 * Narrows a `GET /release` body or a `release` event. Anything but an object with a string-or-null
 * `running` and `onDisk` and an array `changelog` is no release data (null); within the changelog,
 * a malformed release or entry is skipped, and a missing section is empty. Releases keep the
 * service's order (newest first).
 */
export function toReleaseInfo(v: unknown): ReleaseInfo | null {
  if (!isObject(v)) return null;
  const running = strOrNull(v.running);
  const onDisk = strOrNull(v.onDisk);
  if (running === undefined || onDisk === undefined || !Array.isArray(v.changelog)) return null;
  return { running, onDisk, changelog: v.changelog.map(changelogRelease).filter((r): r is ChangelogRelease => r !== null) };
}

// ---- semver ----

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A version as `[major, minor, patch]`, or null unless it is exactly `MAJOR.MINOR.PATCH` (no leading zeros, no suffix). */
export function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a` is lower, 0 when equal, positive when higher; null when either is not valid semver. */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === null || y === null) return null;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The releases a project at `installed` is missing: every release above `installed` and up to and
 * including `running` (no upper bound while `running` is not known), in the changelog's order. A
 * release whose version is not valid semver is never in scope.
 */
export function scopeReleases(changelog: readonly ChangelogRelease[], installed: string, running: string | null): ChangelogRelease[] {
  return changelog.filter((r) => {
    const above = compareSemver(r.version, installed);
    if (above === null || above <= 0) return false;
    if (running === null) return true;
    const upTo = compareSemver(r.version, running);
    return upTo !== null && upTo <= 0;
  });
}

// ---- hover and label text ----

/** A project's release line for its sidebar row's hover text; null when it has no release (an older service). */
export function releaseLine(rel: ProjectRelease | null | undefined, running: string | null): string | null {
  if (rel === null || rel === undefined) return null;
  const at = rel.installed ?? '';
  switch (rel.state) {
    case 'behind':
      return `factory ${at} installed · ${running !== null ? `${running} available` : 'a newer release available'}`;
    case 'current':
      return `factory ${at} installed · up to date`;
    case 'ahead':
      return `factory ${at} installed · newer than this machine's ${running ?? 'release'}`;
    case 'unknown':
      return 'factory version unknown';
  }
}

/** The footer version's hover text. */
export const whatsNewTitle = (version: string): string => `What's new in v${version}`;

// ---- the commands Andon copies (never runs) ----

/** The command that restarts the Andon service (`factory service install` made it an OS service). */
export const RESTART_COMMAND = 'factory service restart';

/** A path as one POSIX shell word: single-quoted, with each `'` written `'\''`. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** The command that upgrades a project's factory install, then checks it. */
export const upgradeCommand = (root: string): string => `cd ${shellQuote(root)} && factory upgrade && bun factory/cli.ts doctor`;

/** The restart note's visible text. */
export const RESTART_NOTE = 'Restart service';

/** The restart note's hover text and accessible name: its visible text, both releases, and the command it copies. */
export const restartText = (running: string | null, onDisk: string): string =>
  `${RESTART_NOTE}: the Andon service runs factory ${running === null ? 'an unknown release' : `v${running}`}, and v${onDisk} is now on disk. Copy the command to restart it: ${RESTART_COMMAND}`;

// ---- the What's New sheet ----

export const WHATS_NEW = "What's New";

export type SectionKey = 'breaking' | 'added' | 'fixed';
const SECTIONS: ReadonlyArray<{ key: SectionKey; title: string }> = [
  { key: 'breaking', title: 'Breaking' },
  { key: 'added', title: 'Added' },
  { key: 'fixed', title: 'Fixed' },
];

export interface SheetEntry {
  area: string | null;
  text: string;
  job: string | null;
}

export interface SheetRelease {
  version: string;
  date: string;
  sections: Array<{ key: SectionKey; title: string; entries: SheetEntry[] }>; // Breaking, Added, Fixed; empty ones omitted
}

export interface WhatsNewModel {
  title: string; // "What's New"
  scope: null | {
    name: string; // the project's name (its id when it isn't registered)
    behind: boolean;
    note: string; // "minerva has factory 0.1.0; these are the releases since." or the not-behind text
    command: string | null; // the upgrade command, only for a behind project
  };
  releases: SheetRelease[];
  empty: string | null; // shown when `releases` is empty
}

/** One release as the sheet lists it: Breaking, Added, then Fixed, each only when it has entries. */
export const sheetRelease = (r: ChangelogRelease): SheetRelease => ({
  version: r.version,
  date: r.date,
  sections: SECTIONS.map((s) => ({ key: s.key, title: s.title, entries: r.sections[s.key] })).filter((s) => s.entries.length > 0),
});

export const NO_RELEASES = 'No releases are available.';

/**
 * The What's New sheet: the whole changelog (`scope` null), or the releases one project is missing.
 * A scoped sheet for a project that is not behind (or isn't registered) lists nothing and says so.
 */
export function whatsNew(
  info: ReleaseInfo | null,
  scope: null | { id: string; project: { name: string; root: string; release?: ProjectRelease | null | undefined } | null },
): WhatsNewModel {
  const changelog = info?.changelog ?? [];
  if (scope === null) {
    const releases = changelog.map(sheetRelease);
    return { title: WHATS_NEW, scope: null, releases, empty: releases.length === 0 ? NO_RELEASES : null };
  }
  const p = scope.project;
  const name = p?.name ?? scope.id;
  const rel = p?.release ?? null;
  if (p === null || rel === null || rel.state !== 'behind' || rel.installed === null) {
    return { title: WHATS_NEW, scope: { name, behind: false, note: `${name} is not behind: it has every release this machine has.`, command: null }, releases: [], empty: null };
  }
  const releases = scopeReleases(changelog, rel.installed, info?.running ?? null).map(sheetRelease);
  return {
    title: WHATS_NEW,
    scope: { name, behind: true, note: `${name} has factory ${rel.installed}. These are the releases since.`, command: upgradeCommand(p.root) },
    releases,
    empty: releases.length === 0 ? NO_RELEASES : null,
  };
}
