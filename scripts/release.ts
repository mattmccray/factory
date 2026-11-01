// `bun run release [--dry-run]`: cuts a factory release on `main` (docs/decisions.md, decision 14).
// Root tooling run by a human as promotion's first step, never a `factory` command and never run
// inside a job. It reads git history only (never job state), computes the next version from the
// Conventional Commits on `main`'s first-parent history since the newest `v*` tag, writes it into
// every `package.json`, prepends a section to `CHANGELOG.md`, commits `chore(release): vX.Y.Z`,
// and tags `vX.Y.Z` (annotated). It then commits the release bundle (scripts/bundle.ts) onto the
// `release` branch with git plumbing, never moving the checkout, and tags that commit
// `release-vX.Y.Z` (annotated). After the refusals and before any write, it runs the gate from
// `factory/config.json` in the checkout itself (each command from the checkout's root, where every
// job gate runs; the tree is clean, so it is `HEAD`), in order, stopping at the first failing
// command: a red gate refuses with `gate is red: <command>` and writes nothing. `--dry-run` runs
// the gate too, then prints the version and section: it builds no bundle and writes nothing. A real
// run then writes the new versions and `CHANGELOG.md` into the checkout and builds the bundle from
// the checkout into a temp dir, so the bundle carries them. A failed build restores exactly the
// files the release wrote (`git checkout -- <paths>`, and removes a `CHANGELOG.md` it created) and
// exits 1 with a one-line reason: no commit, no tag, no `release` change. With no `gate` in
// `factory/config.json`, it says so and goes on; an unreadable or invalid config refuses. It never
// pushes (`bun run release:push` does) and never runs `factory upgrade`.
//
// Right after the off-`main` and dirty-tree refusals, before anything else (dry run or not, gate or
// no gate), it checks the workspace links in the checkout, whose `node_modules` the gate and the
// bundle build use: every `workspace:*` dependency of the root and each workspace `package.json`
// must be a symlink, in the depending package's own `node_modules` or else the root's, that
// resolves to that workspace package. A missing or misdirected link refuses with `workspace links
// are stale: run `bun install`, then retry` and writes nothing. It never runs an install itself:
// run `bun install` first.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig } from '../packages/contract/src/contract';

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
  return gitWith(repo, args);
}

function gitWith(repo: string, args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}): string {
  const p = Bun.spawnSync(['git', '-C', repo, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
    ...(opts.stdin === undefined ? {} : { stdin: Buffer.from(opts.stdin) }),
  });
  if (p.exitCode !== 0) throw new Error(`git ${args[0] ?? ''}: ${p.stderr.toString().trim().split('\n')[0] ?? ''}`);
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
export function baseTag(repo: string): { tag: string; version: string } | null {
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

/** One stale workspace link: the depending package, the dependency, and why. */
export interface StaleLink {
  pkg: string;
  dep: string;
  why: 'missing' | 'points elsewhere' | 'no workspace package has that name';
}

const DEP_FIELDS: readonly string[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${firstLine(e instanceof Error ? e.message : String(e))}`);
  }
}

/** The `workspace:*` dependency names of a parsed `package.json`, across its dependency fields. */
function workspaceDeps(json: unknown): string[] {
  const out = new Set<string>();
  if (typeof json !== 'object' || json === null) return [];
  for (const field of DEP_FIELDS) {
    const deps: unknown = field in json ? Reflect.get(json, field) : undefined;
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [name, spec] of Object.entries(deps)) if (spec === 'workspace:*') out.add(name);
  }
  return [...out].sort();
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const lexists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * The stale `workspace:*` links of the checkout `repo`'s root and workspace packages, as installed
 * in its `node_modules`. A dependency is linked when
 * `<its package>/node_modules/<name>`, or failing that the root's `node_modules/<name>`, is a
 * symlink whose real path is the directory of the workspace package named `<name>`. Reads only.
 */
export function staleLinks(repo: string): StaleLink[] {
  const files = packageFiles(repo);
  const dirOf = new Map<string, string>(); // workspace package name -> repo-relative directory
  const parsed = files.map((path): [string, unknown] => [path, readJson(join(repo, path))]);
  for (const [path, json] of parsed) {
    if (path === 'package.json') continue;
    const name: unknown = typeof json === 'object' && json !== null && 'name' in json ? json.name : undefined;
    if (typeof name === 'string' && !dirOf.has(name)) dirOf.set(name, dirname(path));
  }
  const out: StaleLink[] = [];
  for (const [path, json] of parsed) {
    const own = dirname(path);
    const name: unknown = typeof json === 'object' && json !== null && 'name' in json ? json.name : undefined;
    const pkg = typeof name === 'string' ? name : path;
    for (const dep of workspaceDeps(json)) {
      const target = dirOf.get(dep);
      if (target === undefined) {
        out.push({ pkg, dep, why: 'no workspace package has that name' });
        continue;
      }
      const link = [join(repo, own, 'node_modules', dep), join(repo, 'node_modules', dep)].find(lexists);
      if (link === undefined) {
        out.push({ pkg, dep, why: 'missing' });
        continue;
      }
      const want = realOrNull(join(repo, target));
      const got = lstatSync(link).isSymbolicLink() ? realOrNull(link) : null;
      if (want === null || got !== want) out.push({ pkg, dep, why: 'points elsewhere' });
    }
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

/** Builds the release bundle of the checkout at `tree` into the empty directory `out`; throws a one-line reason. */
export type BuildBundle = (tree: string, out: string) => void;

/** Runs one gate command from the checkout's root and returns its exit code. */
export type RunGate = (tree: string, command: string) => number;

export interface ReleaseOptions {
  dryRun: boolean;
  today?: string; // YYYY-MM-DD; defaults to the local date
  build?: BuildBundle; // defaults to the checkout's own `scripts/bundle.ts`
  gate?: RunGate; // defaults to running each command through `sh -c`
}

/** The release branch and its tags (brief decision 4): outside the `factory/` namespace, no `/` in a tag. */
export const RELEASE_BRANCH = 'release';
export const RELEASE_REF = `refs/heads/${RELEASE_BRANCH}`;
export const releaseTag = (version: string): string => `release-v${version}`;
/** The bundle's executable, which gets the executable mode in the `release` tree. */
const BUNDLE_BIN = 'bin/factory.js';

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** The default build: the checkout's own builder, `bun scripts/bundle.ts <out>`. */
export const buildWithScript: BuildBundle = (tree, out) => {
  const script = join(tree, 'scripts', 'bundle.ts');
  if (!existsSync(script)) throw new Error('scripts/bundle.ts is missing from the tree');
  const p = Bun.spawnSync([process.execPath, script, out], { cwd: tree, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(firstLine(p.stderr.toString()) || firstLine(p.stdout.toString()) || `exit ${p.exitCode}`);
};

/** The default gate runner: the command through a shell (`sh -c`), from the tree's root, its output shown. */
export const runWithShell: RunGate = (tree, command) => {
  const p = Bun.spawnSync(['sh', '-c', command], { cwd: tree, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  return p.exitCode ?? 1;
};

/**
 * The gate from `<repo>/factory/config.json`, validated by the contract's rules: its commands in
 * order, or null when `gate` is absent (no gate configured). Throws a one-line reason when the
 * config is missing, unreadable, or invalid.
 */
export function readGate(repo: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repo, 'factory', 'config.json'), 'utf8'));
  } catch (e) {
    throw new Error(`factory/config.json is unreadable: ${firstLine(e instanceof Error ? e.message : String(e))}`);
  }
  try {
    return parseConfig(raw).gate ?? null;
  } catch (e) {
    throw new Error(`factory/config.json is invalid: ${firstLine(e instanceof Error ? e.message : String(e))}`);
  }
}

/** Runs `commands` in order from `tree`, stopping at the first non-zero exit; returns that command, or null when all pass. */
function redCommand(tree: string, commands: readonly string[], run: RunGate): string | null {
  for (const command of commands) if (run(tree, command) !== 0) return command;
  return null;
}

/** Checks the built bundle is a package `bun add -g` can link: its `package.json` has `bin.factory`. */
function checkBundle(out: string): void {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  } catch {
    throw new Error('the bundle has no readable package.json');
  }
  const bin = typeof pkg === 'object' && pkg !== null && 'bin' in pkg ? pkg.bin : undefined;
  const factory = typeof bin === 'object' && bin !== null && 'factory' in bin ? bin.factory : undefined;
  if (typeof factory !== 'string') throw new Error('the bundle\'s package.json has no bin.factory');
}

/** Every file under `dir`, `/`-separated and sorted. */
function filesUnder(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...filesUnder(dir, path));
    else if (e.isFile()) out.push(path);
  }
  return out.sort();
}

/**
 * Commits the bundle in `out` onto `release` with plumbing: its blobs, a tree built in a temp index
 * (exactly the bundle), and a commit whose parent is the previous `release` commit (none for the
 * first). The ref moves by a compare-and-swap `update-ref`; the checkout, `HEAD`, and the repo's
 * index are never touched. Returns the new commit.
 */
function commitBundle(repo: string, out: string, index: string, message: string): string {
  const files = filesUnder(out);
  const shas = git(repo, 'hash-object', '-w', '--no-filters', '--', ...files.map((f) => join(out, f))).trim().split('\n');
  if (shas.length !== files.length) throw new Error(`git hash-object returned ${shas.length} ids for ${files.length} files`);
  const info = files.map((f, i) => `${f === BUNDLE_BIN ? '100755' : '100644'} ${shas[i] ?? ''}\t${f}\n`).join('');
  const env = { GIT_INDEX_FILE: index };
  gitWith(repo, ['update-index', '--add', '--index-info'], { env, stdin: info });
  const tree = gitWith(repo, ['write-tree'], { env }).trim();
  const parent = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', `${RELEASE_REF}^{commit}`], { stdout: 'pipe', stderr: 'pipe' });
  const tip = parent.exitCode === 0 ? parent.stdout.toString().trim() : null;
  const commit = git(repo, 'commit-tree', tree, ...(tip === null ? [] : ['-p', tip]), '-m', message).trim();
  git(repo, 'update-ref', '-m', message.split('\n')[0] ?? 'release', RELEASE_REF, commit, tip ?? '');
  return commit;
}

/**
 * Undoes the release's own writes to the clean checkout: each of `paths` that `HEAD` tracks is
 * restored with `git checkout --`, and any other (a `CHANGELOG.md` the first release created) is
 * removed. Touches nothing else.
 */
function restoreWrites(repo: string, paths: readonly string[], tracked: ReadonlySet<string>): void {
  const known = paths.filter((p) => tracked.has(p));
  if (known.length > 0) git(repo, 'checkout', '--', ...known);
  for (const path of paths) if (!tracked.has(path)) rmSync(join(repo, path), { force: true });
}

/** Runs a release in `repo`. `out` is what to print; a non-zero `code` means nothing was written. */
export function release(repo: string, opts: ReleaseOptions): { code: number; out: string } {
  const refuse = (reason: string): { code: number; out: string } => ({ code: 1, out: `release refused: ${reason}\n` });
  try {
    const branch = Bun.spawnSync(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    const on = branch.exitCode === 0 ? branch.stdout.toString().trim() : 'detached HEAD';
    if (on !== 'main') return refuse(`not on main (on ${on})`);
    if (git(repo, 'status', '--porcelain').trim() !== '') return refuse('working tree is dirty (git status --porcelain is not empty)');
    const stale = staleLinks(repo);
    if (stale.length > 0) return { code: 1, out: `release refused: workspace links are stale: run \`bun install\`, then retry\n${stale.map((l) => `  ${l.pkg} -> ${l.dep}: ${l.why}\n`).join('')}` };

    const base = baseTag(repo);
    const { entries, skipped } = collect(repo, base === null ? null : base.tag);
    const notes = skipped.map((s) => `skipped (not Conventional): ${s}\n`).join('');
    if (entries.length === 0) return { code: 1, out: `${notes}nothing to release since ${base === null ? 'the first commit' : base.tag}\n` };

    const version = base === null ? templatesVersion(repo) : bump(base.version, entries);
    const tag = `v${version}`;
    if (git(repo, 'tag', '--list', tag).trim() !== '') return { code: 1, out: `${notes}release refused: tag ${tag} already exists\n` };
    const bundleTag = releaseTag(version);
    if (git(repo, 'tag', '--list', bundleTag).trim() !== '') return { code: 1, out: `${notes}release refused: tag ${bundleTag} already exists\n` };
    const section = formatSection(version, opts.today ?? localDate(new Date()), entries);
    const head = `${tag}${base === null ? ' (baseline: no v* tag yet, no bump)' : ` (from ${base.tag})`}\n`;

    let gate: string[] | null;
    try {
      gate = readGate(repo);
    } catch (e) {
      return { code: 1, out: `${notes}release refused: ${e instanceof Error ? e.message : String(e)}\n` };
    }
    const gateLine = gate === null ? 'no gate configured: factory/config.json has no gate\n' : `gate: green (${gate.join(', ')})\n`;

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

    // The gate runs in the checkout, from its root, before the first write. A dry run stops after it.
    if (gate !== null) {
      const red = redCommand(repo, gate, opts.gate ?? runWithShell);
      if (red !== null) return { code: 1, out: `${notes}release refused: gate is red: ${red}\n` };
    }
    if (opts.dryRun) return { code: 0, out: `${head}${notes}${gateLine}dry run: nothing written\n\n${section}` };

    // The versions and CHANGELOG.md are written into the checkout, then the bundle is built from it
    // into a temp dir, so it carries them. A failed build restores exactly those writes.
    const paths = writes.map(([path]) => path);
    const tracked = new Set(git(repo, 'ls-files', '-z', '--', ...paths).split('\0').filter(Boolean));
    const work = mkdtempSync(join(tmpdir(), 'factory-release-'));
    try {
      const out = join(work, 'bundle');
      try {
        for (const [path, text] of writes) writeFileSync(join(repo, path), text);
        mkdirSync(out);
        (opts.build ?? buildWithScript)(repo, out);
        checkBundle(out);
      } catch (e) {
        const reason = `release failed: bundle build: ${firstLine(e instanceof Error ? e.message : String(e))}`;
        try {
          restoreWrites(repo, paths, tracked);
        } catch (r) {
          return { code: 1, out: `${reason}; restoring the version and CHANGELOG.md writes failed: ${firstLine(r instanceof Error ? r.message : String(r))}\n` };
        }
        return { code: 1, out: `${reason}\n` };
      }

      git(repo, 'add', '--', ...paths);
      git(repo, 'commit', '--quiet', '-m', `chore(release): ${tag}`);
      git(repo, 'tag', '-a', tag, '-m', `factory ${tag}`);
      const main = git(repo, 'rev-parse', 'HEAD').trim();
      const recover = `; ${tag} is cut on main without its bundle: to retry, delete tag ${tag}, reset main to HEAD~1 (and release to its previous commit, if it moved), then rerun`;
      let bundleCommit: string;
      try {
        bundleCommit = commitBundle(repo, out, join(work, 'index'), `chore(release): bundle ${tag} from main ${main}\n\nThe release bundle (scripts/bundle.ts) built from main at ${main}, chore(release): ${tag}.`);
        git(repo, 'tag', '-a', bundleTag, bundleCommit, '-m', `factory ${tag} bundle`);
      } catch (e) {
        return { code: 1, out: `release failed: ${firstLine(e instanceof Error ? e.message : String(e))}${recover}\n` };
      }
      return {
        code: 0,
        out: `${head}${notes}${gateLine}\n${section}\ncommitted chore(release): ${tag} and tagged ${tag}.\ncommitted the bundle onto ${RELEASE_BRANCH} (${bundleCommit.slice(0, 7)}) and tagged ${bundleTag}. Nothing was pushed.\nNext: factory upgrade, bun factory/cli.ts doctor, commit chore(factory): promote …, then bun run release:push\n`,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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
