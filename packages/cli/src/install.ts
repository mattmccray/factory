// `factory init` and `factory upgrade` (docs/contract/v1.md "CLI", "Managed files"): install the
// managed core into a project, or replace it with a new render. Each command plans first, checking
// every path and refusal before anything is written, so a refusal writes nothing. Writes go to a
// temp file and are renamed into place; `managed.json` is written last.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { addRoot, parseConfig, parseManifest } from '@factory/contract';
import type { Config, Manifest } from '@factory/contract';
import { VERSION } from '@factory/templates';
import { buildRelease } from './bundle';
import type { ReleaseFiles } from './bundle';
import { commitBlocker, commitPaths } from './git';
import { isNotFound, locate, protectedReason } from './paths';

export interface InstallOptions {
  force: boolean;
  /** `upgrade --commit`: commit exactly what upgrade wrote or deleted, plus `managed.json`. */
  commit?: boolean;
  stdout: (line: string) => void;
  /** The Andon registry file (`$ANDON_HOME/projects.json`) `init` registers the project in. Absent: no registration. */
  registry?: string;
  /** Where the installed CLI and contract come from: this source tree (the default) or the release bundle's baked files. */
  from?: ReleaseFiles;
  /** How `upgrade` runs the installed doctor once its writes are done. Absent: the real subprocess (`runInstalledDoctor`). */
  doctor?: DoctorRunner;
}

/**
 * Runs the installed doctor in the project at `repo`, passing each line it prints to `line` as it
 * prints; resolves to its exit code, and throws when it can't start.
 */
export type DoctorRunner = (repo: string, line: (text: string) => void) => Promise<number>;

// Passes each line of `stream` to `line` as soon as it is complete; a last line with no newline is passed at the end.
async function eachLine(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      line(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf !== '') line(buf);
}

/**
 * `bun factory/cli.ts doctor` from the project root, with the Bun running this CLI
 * (`process.execPath`): the freshly written installed CLI, so a bundle that doesn't load fails
 * here. Its stdout and stderr lines are both passed through.
 */
export const runInstalledDoctor: DoctorRunner = async (repo, line) => {
  const proc = Bun.spawn([process.execPath, 'factory/cli.ts', 'doctor'], { cwd: repo, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [, , code] = await Promise.all([eachLine(proc.stdout, line), eachLine(proc.stderr, line), proc.exited]);
  return code;
};

// Runs the installed doctor, its lines going to `stdout`. Returns null when it passed, or why it
// failed: any `FAIL` line, a non-zero exit, or a doctor that didn't start. `note` lines never fail.
async function doctorFailure(repo: string, opts: InstallOptions): Promise<string | null> {
  let fails = 0;
  let code: number;
  try {
    code = await (opts.doctor ?? runInstalledDoctor)(repo, (text) => {
      if (/^FAIL\b/.test(text)) fails += 1;
      opts.stdout(text);
    });
  } catch (e) {
    return `it did not start: ${message(e)}`;
  }
  if (fails > 0) return `${fails} FAIL line${fails === 1 ? '' : 's'}, exit ${code}`;
  if (code !== 0) return `exit ${code}`;
  return null;
}

/** The config `init` writes when the project has none. `/factory customize` will own this later. */
export const DEFAULT_CONFIG = {
  schema: 'factory/v1',
  reviewers: ['code'],
  maxRound: 2,
  dashboard: { settleAfterHours: 24 },
};

/** The runtime-state lines `init` makes sure the project's `.gitignore` carries. */
export const GITIGNORE_LINES = ['factory/jobs/', 'factory/.lock/', 'factory/.worktrees/'];

const MANIFEST = 'factory/managed.json';
const CONFIG = 'factory/config.json';
const GITIGNORE = '.gitignore';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

/** The manifest for a release: every path, sorted, with the SHA-256 of its UTF-8 bytes. */
export function manifestFor(files: Readonly<Record<string, string>>): Manifest {
  const hashes: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) hashes[path] = sha256(files[path] ?? '');
  return { schema: 'factory/v1', version: VERSION, files: hashes };
}

export const manifestText = (m: Manifest): string => `${JSON.stringify(m, null, 2)}\n`;

async function readOrNull(at: string): Promise<Buffer | null> {
  try {
    return await readFile(at);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

// Locates a path the installer will touch, turning any containment failure into a refusal that
// names the path. `managed` paths must also not be overlay or runtime state.
// The deny-list is checked on the lexical path and again on where it resolves, so an in-repo
// directory symlink can't route a managed write or delete into the overlay or runtime state.
async function place(repo: string, rel: string, cmd: string, managed: boolean): Promise<string> {
  const deny = managed ? protectedReason(rel) : null;
  if (deny !== null) throw new Error(`${cmd}: refusing ${rel}: ${deny}`);
  let at: string;
  try {
    at = await locate(repo, rel);
  } catch (e) {
    throw new Error(`${cmd}: refusing ${rel}: ${message(e)}`);
  }
  const resolvedDeny = managed ? protectedReason(relative(await realpath(repo), at).split(sep).join('/')) : null;
  if (resolvedDeny !== null) throw new Error(`${cmd}: refusing ${rel}: resolves to a path that ${resolvedDeny}`);
  return at;
}

// Writes to a fresh temp file beside the target (`wx`: never through an existing file or link),
// then renames it over the target, so a reader never sees a partial file.
async function writeAtomic(at: string, text: string): Promise<void> {
  await mkdir(dirname(at), { recursive: true });
  const tmp = join(dirname(at), `.${basename(at)}.${process.pid}.${Date.now()}.factory-tmp`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, at);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function readConfig(cmd: string, at: string): Promise<{ config: Config; text: string | null }> {
  const data = await readOrNull(at);
  if (data === null) {
    if (cmd === 'upgrade') throw new Error(`upgrade: ${CONFIG}: missing`);
    return { config: parseConfig(DEFAULT_CONFIG), text: `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error(`${cmd}: ${CONFIG}: not valid JSON`);
  }
  try {
    return { config: parseConfig(raw), text: null };
  } catch (e) {
    throw new Error(`${cmd}: ${CONFIG}: ${message(e).replace(/^config: /, '')}`);
  }
}

const IGNORE_FORMS = (line: string): string[] => {
  const bare = line.replace(/\/$/, '');
  return [line, bare, `/${line}`, `/${bare}`];
};

/** `.gitignore`'s text with any missing runtime line appended, or null when nothing is missing. */
export function withRuntimeIgnores(current: string): string | null {
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !IGNORE_FORMS(line).some((f) => have.has(f)));
  if (missing.length === 0) return null;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  const gap = current === '' ? '' : '\n';
  return `${current}${sep}${gap}# Factory runtime state\n${missing.map((l) => `${l}\n`).join('')}`;
}

// Paths that already hold a file whose bytes differ from the release's.
const differing = (existing: ReadonlyMap<string, Buffer | null>, files: Readonly<Record<string, string>>): string[] =>
  [...existing].filter(([rel, cur]) => cur !== null && !cur.equals(Buffer.from(files[rel] ?? '', 'utf8'))).map(([rel]) => rel);

const listPaths = (paths: readonly string[]): string => paths.join(', ');

interface Write {
  rel: string;
  at: string;
  text: string;
}

// Plans the managed writes: each release file whose bytes differ from what is on disk.
async function planWrites(repo: string, files: Readonly<Record<string, string>>, cmd: string): Promise<{ writes: Write[]; existing: Map<string, Buffer | null> }> {
  const writes: Write[] = [];
  const existing = new Map<string, Buffer | null>();
  for (const rel of Object.keys(files).sort()) {
    const text = files[rel] ?? '';
    const at = await place(repo, rel, cmd, true);
    const cur = await readOrNull(at).catch((e: unknown) => {
      throw new Error(`${cmd}: refusing ${rel}: ${message(e)}`);
    });
    existing.set(rel, cur);
    if (cur === null || !cur.equals(Buffer.from(text, 'utf8'))) writes.push({ rel, at, text });
  }
  return { writes, existing };
}

/** `factory init [--force]`. `root` is the project's `factory/` directory. */
export async function init(root: string, opts: InstallOptions): Promise<void> {
  const repo = dirname(resolve(root));
  const manifestAt = await place(repo, MANIFEST, 'init', false);
  if ((await readOrNull(manifestAt)) !== null) throw new Error(`init: ${MANIFEST} exists: this project is installed, use upgrade`);
  const configAt = await place(repo, CONFIG, 'init', false);
  const { config, text: configText } = await readConfig('init', configAt);
  const files = await buildRelease(config, opts.from);
  const { writes, existing } = await planWrites(repo, files, 'init');
  const conflicts = differing(existing, files);
  if (conflicts.length > 0 && !opts.force) {
    throw new Error(`init: refusing, a different file already sits at ${listPaths(conflicts)} (use --force to overwrite)`);
  }
  const ignoreAt = await place(repo, GITIGNORE, 'init', false);
  const ignore = withRuntimeIgnores((await readOrNull(ignoreAt))?.toString('utf8') ?? '');

  for (const w of writes) await writeAtomic(w.at, w.text);
  if (configText !== null) await writeAtomic(configAt, configText);
  if (ignore !== null) await writeAtomic(ignoreAt, ignore);
  await writeAtomic(manifestAt, manifestText(manifestFor(files)));
  opts.stdout(`installed factory ${VERSION}: ${Object.keys(files).length} managed files${conflicts.length > 0 ? `, ${conflicts.length} overwritten` : ''}`);
  if (opts.registry !== undefined) await register(opts.registry, repo, opts.stdout);
}

// The last step of a successful `init`: list the project in the Andon registry. A failure here
// never fails `init`; it prints one `note:` line naming the reason.
async function register(registry: string, repo: string, stdout: (line: string) => void): Promise<void> {
  try {
    await addRoot(registry, await realpath(repo));
  } catch (e) {
    stdout(`note: not registered with Andon (${registry}): ${message(e)}`);
  }
}

/**
 * `factory upgrade [--force] [--commit]`. `root` is the project's `factory/` directory. With
 * `commit`, the repo's git state is checked before anything is planned, and after the writes one
 * commit holds exactly the written and deleted paths and `managed.json` (when rewritten). After
 * the writes it prints its summary, then runs the installed doctor (`opts.doctor`), whose lines
 * follow; a failing doctor exits 1 with the files left written and, with `commit`, no commit.
 */
export async function upgrade(root: string, opts: InstallOptions): Promise<void> {
  const repo = dirname(resolve(root));
  if (opts.commit === true) {
    const blocker = await commitBlocker(repo);
    if (blocker !== null) throw new Error(`upgrade --commit: refusing, ${blocker}`);
  }
  const manifestAt = await place(repo, MANIFEST, 'upgrade', false);
  const manifestData = await readOrNull(manifestAt);
  if (manifestData === null) throw new Error(`upgrade: no ${MANIFEST}: this project is not installed, use init`);
  let old: Manifest;
  try {
    old = parseManifest(JSON.parse(manifestData.toString('utf8')));
  } catch (e) {
    throw new Error(`upgrade: ${MANIFEST}: ${e instanceof SyntaxError ? 'not valid JSON' : message(e)}`);
  }
  const configAt = await place(repo, CONFIG, 'upgrade', false);
  const { config } = await readConfig('upgrade', configAt);

  // Every file the old manifest lists must be inside the repo, never overlay or state, and
  // pristine (present, matching its hash) unless --force.
  const deletes: Array<{ rel: string; at: string }> = [];
  const edited: string[] = [];
  const files = await buildRelease(config, opts.from);
  for (const [rel, want] of Object.entries(old.files)) {
    const at = await place(repo, rel, 'upgrade', true);
    const cur = await readOrNull(at).catch((e: unknown) => {
      throw new Error(`upgrade: refusing ${rel}: ${message(e)}`);
    });
    if (cur === null) edited.push(`${rel} (missing)`);
    else if (sha256(cur) !== want) edited.push(`${rel} (changed)`);
    if (!Object.hasOwn(files, rel)) deletes.push({ rel, at });
  }
  const { writes, existing } = await planWrites(repo, files, 'upgrade');
  // A path the new render introduces must not clobber a file nobody manages.
  const clobbers = differing(existing, files)
    .filter((rel) => !Object.hasOwn(old.files, rel))
    .map((rel) => `${rel} (unmanaged)`);
  const refused = [...edited, ...clobbers];
  if (refused.length > 0 && !opts.force) {
    throw new Error(`upgrade: refusing, managed files were edited or would be overwritten: ${listPaths(refused)} (use --force to replace them)`);
  }

  for (const w of writes) await writeAtomic(w.at, w.text);
  for (const d of deletes) {
    try {
      await unlink(d.at);
    } catch (e) {
      if (!isNotFound(e)) throw new Error(`upgrade: ${d.rel}: ${message(e)}`);
    }
  }
  const next = manifestText(manifestFor(files));
  const rewritten = !manifestData.equals(Buffer.from(next, 'utf8'));
  if (rewritten) await writeAtomic(manifestAt, next);
  const summary = `upgraded factory ${old.version} -> ${VERSION}: ${writes.length} written, ${deletes.length} removed`;
  opts.stdout(summary);

  // Doctor, after every upgrade that completed its writes (none written included): the installed
  // CLI that was just written checks the install. A failure exits 1 with no rollback, and no commit.
  const failed = await doctorFailure(repo, opts);
  if (failed !== null) {
    const byHand = opts.commit === true ? '; commit the upgraded files by hand once doctor passes' : '';
    throw new Error(`upgrade: ${summary}, but doctor failed (${failed})${byHand}`);
  }
  if (opts.commit !== true) return;

  // The commit: no rollback on failure. The written install is consistent and passed doctor.
  const written = writes.map((w) => w.rel);
  const changed = rewritten ? [...written, MANIFEST] : written;
  let sha: string | null;
  try {
    sha = await commitPaths(repo, changed, deletes.map((d) => d.rel), `chore(factory): upgrade factory ${old.version} -> ${VERSION}`);
  } catch (e) {
    throw new Error(`upgrade: ${summary}, but the commit failed: ${message(e)}; commit the upgraded files by hand`);
  }
  opts.stdout(sha === null ? 'nothing to commit' : `committed ${sha}`);
}
