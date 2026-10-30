// Factory releases for the Andon service (docs/contract/v1.md "Andon service", `release`):
// - a project's installed release, its `factory/managed.json` `version` (read with the contract's
//   `parseManifest`), and its state against the release the service runs;
// - the clone's release, `packages/templates/package.json`'s `version` (from the release bundle,
//   its root `package.json`: `versionFile` names which);
// - the clone's `CHANGELOG.md`, parsed tolerantly (the strict format the release script writes:
//   `## vX.Y.Z (YYYY-MM-DD)`, `### Breaking/Added/Fixed`, `- <Area>: <text> (<job id>)`).
// Every read is of a fixed path; nothing here writes. The parsers are pure and never throw.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest } from '@factory/contract';

export type ReleaseState = 'current' | 'behind' | 'ahead' | 'unknown';

/** A project's `release` on `GET /projects` entries and the `projects` event. */
export interface ProjectRelease {
  installed: string | null; // its managed.json `version`, or null (missing, unreadable, or invalid)
  state: ReleaseState; // against the service's running release
}

export interface ChangelogEntry {
  area: string | null;
  text: string;
  job: string | null;
}

export interface ChangelogRelease {
  version: string; // the heading's version without its `v`
  date: string; // YYYY-MM-DD
  sections: { breaking: ChangelogEntry[]; added: ChangelogEntry[]; fixed: ChangelogEntry[] };
}

/** The `GET /release` body and the `release` event's data. */
export interface ReleaseInfo {
  running: string | null; // the clone's templates version, read once at startup
  onDisk: string | null; // the same file, read now
  changelog: ChangelogRelease[]; // in file order (newest first)
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const JOB_ID = /^\d{3}-[a-z0-9-]+$/;

/** Exactly `MAJOR.MINOR.PATCH`: non-negative integers with no leading zeros, no suffix. */
export const isSemver = (v: string): boolean => SEMVER.test(v);

// Two digit strings with no leading zeros compare by length, then lexically (exact at any size).
const compareDigits = (a: string, b: string): number => (a.length !== b.length ? Math.sign(a.length - b.length) : a < b ? -1 : a > b ? 1 : 0);

/** -1, 0, or 1, field by field; null when either side is not valid semver. */
export function compareSemver(a: string, b: string): number | null {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (x === null || y === null) return null;
  for (let i = 1; i <= 3; i++) {
    const c = compareDigits(x[i] ?? '', y[i] ?? '');
    if (c !== 0) return c;
  }
  return 0;
}

/** An installed release's state against the running one. */
export function releaseState(installed: string | null, running: string | null): ReleaseState {
  if (installed === null || running === null) return 'unknown';
  const c = compareSemver(installed, running);
  return c === null ? 'unknown' : c < 0 ? 'behind' : c > 0 ? 'ahead' : 'current';
}

/** The project's `factory/managed.json` `version`; null when it is missing, unreadable, or invalid. */
export async function readInstalled(factory: string): Promise<string | null> {
  try {
    return parseManifest(JSON.parse(await readFile(join(factory, 'managed.json'), 'utf8'))).version;
  } catch {
    return null;
  }
}

/** Where the release's version is read, relative to the tree the service runs in: a source clone. */
export const SOURCE_VERSION_FILE = 'packages/templates/package.json';
/** The same, in the release bundle: its root `package.json`, which carries the templates' version. */
export const BUNDLE_VERSION_FILE = 'package.json';

/** The `version` of `versionFile` in the clone (default: `packages/templates/package.json`) when it is a string; else null. */
export async function readTemplatesVersion(cloneRoot: string | undefined, versionFile: string = SOURCE_VERSION_FILE): Promise<string | null> {
  if (cloneRoot === undefined) return null;
  try {
    const pkg: unknown = JSON.parse(await readFile(join(cloneRoot, versionFile), 'utf8'));
    if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg) || !('version' in pkg)) return null;
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

const JOB_SUFFIX = /^(.*?)\s*\(([^()]*)\)$/;
const AREA_PREFIX = /^([^\s:()][^:()]*?):(?:\s+(.*))?$/;

/**
 * One changelog line: a leading `- ` is stripped, and the rest is `<Area>: <text> (<job id>)`,
 * the area and job id each optional. A line that leaves no text is `{ area: null, text: <the line>,
 * job: null }`.
 */
export function parseEntry(raw: string): ChangelogEntry {
  const trimmed = raw.trim();
  const line = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed;
  let rest = line;
  let job: string | null = null;
  const j = JOB_SUFFIX.exec(rest);
  if (j !== null && JOB_ID.test(j[2] ?? '')) {
    rest = j[1] ?? '';
    job = j[2] ?? null;
  }
  let area: string | null = null;
  const a = AREA_PREFIX.exec(rest);
  if (a !== null) {
    area = (a[1] ?? '').trimEnd();
    rest = a[2] ?? '';
  }
  const text = rest.trim();
  if (text === '') return { area: null, text: line, job: null };
  return { area, text, job };
}

const RELEASE = /^## v(\S+) \((\d{4}-\d{2}-\d{2})\)$/;
const HEADING = /^(#{1,6})(?:\s|$)/;
const SECTIONS: Record<string, keyof ChangelogRelease['sections']> = { '### Breaking': 'breaking', '### Added': 'added', '### Fixed': 'fixed' };

/**
 * The releases of a `CHANGELOG.md`, in file order. Only `## vX.Y.Z (YYYY-MM-DD)` starts a release
 * and only `### Breaking/Added/Fixed` a section; any other heading closes them (`##` or above the
 * release, `###` or below the section), and lines outside both are ignored. Never throws.
 */
export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogEntry[] | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const h = HEADING.exec(line);
    if (h !== null) {
      const level = (h[1] ?? '').length;
      const r = RELEASE.exec(line);
      const key = Object.hasOwn(SECTIONS, line) ? SECTIONS[line] : undefined;
      if (r !== null && isSemver(r[1] ?? '')) {
        release = { version: r[1] ?? '', date: r[2] ?? '', sections: { breaking: [], added: [], fixed: [] } };
        releases.push(release);
        section = null;
      } else if (key !== undefined && release !== null) {
        section = release.sections[key];
      } else {
        if (level <= 2) release = null;
        section = null;
      }
      continue;
    }
    if (section !== null) section.push(parseEntry(line));
  }
  return releases;
}

/** The clone's `CHANGELOG.md`, parsed; [] when there is no clone root or the file is unreadable. */
export async function readChangelog(cloneRoot: string | undefined): Promise<ChangelogRelease[]> {
  if (cloneRoot === undefined) return [];
  try {
    return parseChangelog(await readFile(join(cloneRoot, 'CHANGELOG.md'), 'utf8'));
  } catch {
    return [];
  }
}

/** The `GET /release` body: `running` as read at startup, `onDisk` and `changelog` read now. */
export async function readRelease(cloneRoot: string | undefined, running: string | null, versionFile: string = SOURCE_VERSION_FILE): Promise<ReleaseInfo> {
  const [onDisk, changelog] = await Promise.all([readTemplatesVersion(cloneRoot, versionFile), readChangelog(cloneRoot)]);
  return { running, onDisk, changelog };
}
