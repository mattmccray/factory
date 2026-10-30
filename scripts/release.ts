// `bun run release [--dry-run]`: cuts a factory release on `main` (docs/decisions.md, decision 14).
// Root tooling run by a human as promotion's first step, never a `factory` command and never run
// inside a job. It reads git history only (never job state), computes the next version from the
// Conventional Commits on `main`'s first-parent history since the newest `v*` tag, writes it into
// every `package.json`, prepends a section to `CHANGELOG.md`, commits `chore(release): vX.Y.Z`,
// and tags `vX.Y.Z` (annotated). It never pushes and never runs `factory upgrade`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = 'breaking' | 'added' | 'fixed';

/** One changelog line: `- <Area>: <text> (<job id>)`, with `area` and `job` null when absent. */
export interface Entry {
  kind: Kind;
  type: string; // the Conventional type, e.g. `feat`
  area: string | null;
  text: string;
  job: string | null;
}

export interface Subject {
  type: string;
  scope: string | null;
  breaking: boolean;
  text: string;
}

const CONVENTIONAL = /^([a-z]+)(?:\(([^()\s]+)\))?(!)?: (\S.*)$/;
const JOB_LINE = /^Factory job (\d{3}-[a-z0-9-]+)\.[ \t]*$/m;
const LAND_EPIC = /^Land epic [^\s:]+: \S/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const TAG = /^v(\d+\.\d+\.\d+)$/;
const SECTIONS: [Kind, string][] = [
  ['breaking', 'Breaking'],
  ['added', 'Added'],
  ['fixed', 'Fixed'],
];
const AREAS: Record<string, string> = {
  andon: 'Andon',
  'andon-ui': 'Andon',
  'andon-service': 'Andon',
  'andon-shell': 'Andon',
  'andon-agent': 'Andon',
  templates: 'Skill',
  cli: 'CLI',
  contract: 'Contract',
};

/** Parses a Conventional Commits subject, `type(scope)!: text`; null when it isn't one. */
export function parseSubject(subject: string): Subject | null {
  const m = CONVENTIONAL.exec(subject.trimEnd());
  if (!m || m[1] === undefined || m[4] === undefined) return null;
  return { type: m[1], scope: m[2] ?? null, breaking: m[3] === '!', text: m[4] };
}

/** The friendly area for a scope: the map above, else the scope with its first letter uppercased. */
export function areaOf(scope: string | null): string | null {
  if (scope === null) return null;
  return AREAS[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1);
}

/** The entry a subject gives, or null when its type isn't user-facing (feat, fix, perf, or `!`). */
function entryOf(s: Subject, job: string | null): Entry | null {
  const kind: Kind | null = s.breaking ? 'breaking' : s.type === 'feat' ? 'added' : s.type === 'fix' || s.type === 'perf' ? 'fixed' : null;
  return kind === null ? null : { kind, type: s.type, area: areaOf(s.scope), text: s.text, job };
}

function parseVersion(v: string): [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a version (X.Y.Z): ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The next version after `version` for these entries. Pre-1.0 a breaking change bumps the minor. */
export function bump(version: string, entries: Entry[]): string {
  const [major, minor, patch] = parseVersion(version);
  const breaking = entries.some((e) => e.kind === 'breaking');
  const feat = entries.some((e) => e.kind === 'added');
  if (breaking && major >= 1) return `${major + 1}.0.0`;
  if (breaking || feat) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const entryLine = (e: Entry): string => `- ${e.area === null ? '' : `${e.area}: `}${e.text}${e.job === null ? '' : ` (${e.job})`}`;

/** The `CHANGELOG.md` section: `## vX.Y.Z (YYYY-MM-DD)`, then Breaking / Added / Fixed, empty ones left out. */
export function formatSection(version: string, date: string, entries: Entry[]): string {
  const parts = [`## v${version} (${date})\n`];
  for (const [kind, title] of SECTIONS) {
    const mine = entries.filter((e) => e.kind === kind);
    if (mine.length > 0) parts.push(`### ${title}\n\n${mine.map(entryLine).join('\n')}\n`);
  }
  return parts.join('\n');
}

/** Puts `section` above the first `## ` section of `existing` (keeping anything before it), or alone. */
export function prependChangelog(existing: string | null, section: string): string {
  if (existing === null || existing.trim() === '') return section;
  const newline = existing.indexOf('\n## ');
  const at = existing.startsWith('## ') ? 0 : newline === -1 ? -1 : newline + 1;
  if (at === -1) return `${existing.trimEnd()}\n\n${section}`; // no section yet: after the preamble
  return `${existing.slice(0, at)}${section}\n${existing.slice(at)}`;
}

/** Rewrites only the top-level `"version"` value of a 2-space-indented `package.json`. */
export function setVersion(text: string, version: string): string {
  const field = /^( {2}"version": ")[^"]*(")/m;
  if (!field.test(text)) throw new Error('no top-level "version" field');
  const next = text.replace(field, `$1${version}$2`);
  const json: unknown = JSON.parse(next);
  if (typeof json !== 'object' || json === null || !('version' in json) || json.version !== version) throw new Error('the "version" field is not top-level');
  return next;
}

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
}

/**
 * The first-parent chain from `tip`, newest first, minus every commit reachable from `stop`. For
 * an epic branch, `stop` is the landing's first parent: everything the epic brought in from its
 * target (its start point and any catch-up merges) is reachable from there, so only the epic's
 * own first-parent commits remain.
 */
function firstParent(repo: string, tip: string, stop: string | null): Commit[] {
  const seen = stop === null ? new Set<string>() : new Set(git(repo, 'rev-list', stop).split('\n').filter(Boolean));
  const out: Commit[] = [];
  for (const record of git(repo, 'log', '--first-parent', '-z', '--format=%H%x1f%P%x1f%s%x1f%b', tip).split('\0')) {
    if (record.trim() === '') continue;
    const [sha = '', parents = '', subject = '', ...body] = record.replace(/^\n/, '').split('\x1f');
    if (seen.has(sha)) continue;
    out.push({ sha, parents: parents.split(' ').filter(Boolean), subject, body: body.join('\x1f') });
  }
  return out;
}

const short = (c: Commit): string => `${c.sha.slice(0, 7)} ${c.subject}`;

/**
 * The entries for `main`'s first-parent history from `HEAD`, back to `since` (exclusive; null for
 * the whole history), oldest first, and the non-Conventional subjects it skipped.
 */
export function collect(repo: string, since: string | null): { entries: Entry[]; skipped: string[] } {
  const entries: Entry[] = [];
  const skipped: string[] = [];
  const take = (c: Commit, job: string | null): void => {
    const s = parseSubject(c.subject);
    if (s === null) {
      skipped.push(short(c));
      return;
    }
    const e = entryOf(s, job);
    if (e) entries.push(e);
  };
  for (const c of firstParent(repo, 'HEAD', since).reverse()) {
    const [first, second] = c.parents;
    const job = second === undefined ? null : (JOB_LINE.exec(c.body)?.[1] ?? null);
    if (second !== undefined && first !== undefined && job === null && LAND_EPIC.test(c.subject)) {
      for (const m of firstParent(repo, second, first).reverse()) {
        const memberJob = m.parents.length > 1 ? (JOB_LINE.exec(m.body)?.[1] ?? null) : null;
        if (memberJob !== null) take(m, memberJob);
      }
      continue;
    }
    take(c, job);
  }
  return { entries, skipped };
}

/** The newest `v*` release tag reachable from HEAD, or null. Non-`v*` tags are ignored. */
function baseTag(repo: string): { tag: string; version: string } | null {
  let best: { tag: string; version: string; key: [number, number, number] } | null = null;
  for (const tag of git(repo, 'tag', '--merged', 'HEAD', '--list', 'v*').split('\n')) {
    const version = TAG.exec(tag.trim())?.[1];
    if (version === undefined) continue;
    const key = parseVersion(version);
    if (best === null || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])))) best = { tag: tag.trim(), version, key };
  }
  return best === null ? null : { tag: best.tag, version: best.version };
}

/** Root and workspace `package.json` paths (`packages/*`, `apps/*`), repo-relative. */
function packageFiles(repo: string): string[] {
  const out = ['package.json'];
  for (const dir of ['packages', 'apps']) {
    if (!existsSync(join(repo, dir))) continue;
    for (const name of readdirSync(join(repo, dir)).sort()) if (existsSync(join(repo, dir, name, 'package.json'))) out.push(`${dir}/${name}/package.json`);
  }
  return out;
}

function templatesVersion(repo: string): string {
  const json: unknown = JSON.parse(readFileSync(join(repo, 'packages/templates/package.json'), 'utf8'));
  const v = typeof json === 'object' && json !== null && 'version' in json ? json.version : undefined;
  if (typeof v !== 'string') throw new Error('packages/templates/package.json has no string "version"');
  parseVersion(v);
  return v;
}

function localDate(d: Date): string {
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ReleaseOptions {
  dryRun: boolean;
  today?: string; // YYYY-MM-DD; defaults to the local date
}

/** Runs a release in `repo`. `out` is what to print; a non-zero `code` means nothing was written. */
export function release(repo: string, opts: ReleaseOptions): { code: number; out: string } {
  const refuse = (reason: string): { code: number; out: string } => ({ code: 1, out: `release refused: ${reason}\n` });
  try {
    const branch = Bun.spawnSync(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    const on = branch.exitCode === 0 ? branch.stdout.toString().trim() : 'detached HEAD';
    if (on !== 'main') return refuse(`not on main (on ${on})`);
    if (git(repo, 'status', '--porcelain').trim() !== '') return refuse('working tree is dirty (git status --porcelain is not empty)');

    const base = baseTag(repo);
    const { entries, skipped } = collect(repo, base === null ? null : base.tag);
    const notes = skipped.map((s) => `skipped (not Conventional): ${s}\n`).join('');
    if (entries.length === 0) return { code: 1, out: `${notes}nothing to release since ${base === null ? 'the first commit' : base.tag}\n` };

    const version = base === null ? templatesVersion(repo) : bump(base.version, entries);
    const tag = `v${version}`;
    if (git(repo, 'tag', '--list', tag).trim() !== '') return { code: 1, out: `${notes}release refused: tag ${tag} already exists\n` };
    const section = formatSection(version, opts.today ?? localDate(new Date()), entries);
    const head = `${tag}${base === null ? ' (baseline: no v* tag yet, no bump)' : ` (from ${base.tag})`}\n`;
    if (opts.dryRun) return { code: 0, out: `${head}${notes}dry run: nothing written\n\n${section}` };

    // Everything is computed and validated before the first write.
    const writes: [string, string][] = packageFiles(repo).map((path) => {
      try {
        return [path, setVersion(readFileSync(join(repo, path), 'utf8'), version)];
      } catch (e) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    const changelog = join(repo, 'CHANGELOG.md');
    writes.push(['CHANGELOG.md', prependChangelog(existsSync(changelog) ? readFileSync(changelog, 'utf8') : null, section)]);
    for (const [path, text] of writes) writeFileSync(join(repo, path), text);
    git(repo, 'add', '--', ...writes.map(([path]) => path));
    git(repo, 'commit', '--quiet', '-m', `chore(release): ${tag}`);
    git(repo, 'tag', '-a', tag, '-m', `factory ${tag}`);
    return {
      code: 0,
      out: `${head}${notes}\n${section}\ncommitted chore(release): ${tag} and tagged ${tag}. Nothing was pushed.\nNext: factory upgrade, bun factory/cli.ts doctor, then commit chore(factory): promote …\n`,
    };
  } catch (e) {
    return { code: 1, out: `release failed: ${e instanceof Error ? e.message : String(e)}\n` };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    process.stderr.write(`usage: bun run release [--dry-run] (unknown: ${unknown.join(' ')})\n`);
    process.exit(2);
  }
  const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'pipe' });
  if (top.exitCode !== 0) {
    process.stderr.write('release refused: not in a git repository\n');
    process.exit(1);
  }
  const r = release(top.stdout.toString().trim(), { dryRun: args.includes('--dry-run') });
  (r.code === 0 ? process.stdout : process.stderr).write(r.out);
  process.exit(r.code);
}
