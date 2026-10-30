import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitIn } from '../packages/cli/src/gitrepo';
import { type BuildBundle, type Entry, areaOf, buildWithScript, bump, collect, formatSection, parseSubject, prependChangelog, RELEASE_BRANCH, type RunGate, readGate, release, setVersion } from './release';

const TODAY = '2026-10-29';

let root: string;
let repo: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'factory-release-')));
  repo = join(root, 'repo');
  await mkdir(repo);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A throwaway repo on `main` with a fixed identity and no signing, set in its own config so the
// release script's plain `git commit` and `git tag -a` use it too.
function initMain(): void {
  gitIn(repo, 'init', '--quiet', '--initial-branch=main');
  const config: [string, string][] = [
    ['user.name', 'factory-test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['tag.forcesignannotated', 'false'],
  ];
  for (const [k, v] of config) gitIn(repo, 'config', k, v);
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
}
const read = (path: string): Promise<string> => readFile(join(repo, path), 'utf8');
const versionOf = async (path: string): Promise<unknown> => {
  const json: unknown = JSON.parse(await read(path));
  return typeof json === 'object' && json !== null && 'version' in json ? json.version : undefined;
};

let n = 0;
/** A direct commit on the current branch, touching one file so it is never empty. */
async function commit(subject: string, body?: string): Promise<void> {
  n += 1;
  await put(`notes/${n}.txt`, `${n}\n`);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '--quiet', '-m', subject, ...(body === undefined ? [] : ['-m', body]));
}

/** A job merge as the skill makes it: a branch with one commit, merged --no-ff with the job line. */
async function jobMerge(subject: string, id: string, into = 'main'): Promise<void> {
  gitIn(repo, 'checkout', '--quiet', '-b', `factory/${id}`, into);
  await commit(`feat: work for ${id}`);
  gitIn(repo, 'checkout', '--quiet', into);
  gitIn(repo, 'merge', '--quiet', '--no-ff', `factory/${id}`, '-m', subject, '-m', `Factory job ${id}.`, '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>');
  gitIn(repo, 'branch', '-D', `factory/${id}`);
}

const PACKAGES: Record<string, string> = {
  'package.json': '{\n  "name": "factory",\n  "version": "0.0.0",\n  "private": true,\n  "workspaces": [\n    "packages/*",\n    "apps/*"\n  ]\n}\n',
  'packages/templates/package.json':
    '{\n  "name": "@factory/templates",\n  "version": "0.1.0",\n  "private": true,\n  "dependencies": {\n    "@factory/contract": "workspace:*"\n  }\n}\n',
  'packages/cli/package.json': '{\n  "name": "@factory/cli",\n  "version": "0.0.0",\n  "bin": { "factory": "src/main.ts" }\n}\n',
  'apps/andon/package.json': '{\n  "name": "@factory/andon",\n  "version": "0.0.0",\n  "nested": {\n    "version": "9.9.9"\n  }\n}\n',
};

// The overlay's config the release reads its gate from: no `gate` here, so no gate is configured.
const CONFIG = 'factory/config.json';
const configText = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 }, ...extra }, null, 2)}\n`;

/** Writes the package.json files and the gate-less config, and commits them as the first commit. */
async function seed(subject = 'chore: seed'): Promise<void> {
  initMain();
  for (const [path, text] of Object.entries(PACKAGES)) await put(path, text);
  await put(CONFIG, configText());
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '--quiet', '-m', subject);
}

/** Everything the release could change: HEAD, tags, status, and each file's bytes. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of [...Object.keys(PACKAGES), 'CHANGELOG.md', CONFIG]) files[path] = existsSync(join(repo, path)) ? await read(path) : '<absent>';
  return {
    ...files,
    head: gitIn(repo, 'rev-parse', 'HEAD'),
    branch: gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    tags: gitIn(repo, 'tag', '--list'),
    release: gitIn(repo, 'branch', '--list', '--format=%(refname) %(objectname)', RELEASE_BRANCH),
    status: gitIn(repo, 'status', '--porcelain'),
  };
}

// A stand-in bundle builder for these synthetic repos (scripts/bundle.test.ts builds the real one):
// a package.json with bin.factory at the staged tree's templates version, and the bin itself.
const fakeBuild: BuildBundle = (tree, out) => {
  const pkg: unknown = JSON.parse(readFileSync(join(tree, 'packages', 'templates', 'package.json'), 'utf8'));
  const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
  mkdirSync(join(out, 'bin'), { recursive: true });
  writeFileSync(join(out, 'bin', 'factory.js'), `#!/usr/bin/env bun\nconsole.log('factory ${String(version)} (release)');\n`);
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'factory', version, bin: { factory: 'bin/factory.js' } }, null, 2)}\n`);
  if (existsSync(join(tree, 'CHANGELOG.md'))) writeFileSync(join(out, 'CHANGELOG.md'), readFileSync(join(tree, 'CHANGELOG.md')));
};

const run = (dryRun = false, build: BuildBundle = fakeBuild) => release(repo, { dryRun, today: TODAY, build });
const lines = (entries: Entry[]): string[] => entries.map((e) => `${e.kind} ${e.area ?? '-'} ${e.text} ${e.job ?? '-'}`);

describe('parseSubject and areaOf', () => {
  test('splits type, scope, and breaking, and leaves the text', () => {
    expect(parseSubject('feat(andon-ui): show X')).toEqual({ type: 'feat', scope: 'andon-ui', breaking: false, text: 'show X' });
    expect(parseSubject('feat(cli)!: drop Z')).toEqual({ type: 'feat', scope: 'cli', breaking: true, text: 'drop Z' });
    expect(parseSubject('fix: repair Y')).toEqual({ type: 'fix', scope: null, breaking: false, text: 'repair Y' });
    expect(parseSubject('refactor!: drop the old flag')).toEqual({ type: 'refactor', scope: null, breaking: true, text: 'drop the old flag' });
  });

  test('a non-Conventional subject is null', () => {
    for (const s of ['Initial import', 'Merge branch main into x', 'feat:no space', 'feat(): empty scope', 'Feat: capital type', 'feat: ']) expect(parseSubject(s)).toBeNull();
  });

  test('maps scopes to areas; other scopes are capitalized; no scope, no area', () => {
    for (const s of ['andon', 'andon-ui', 'andon-service', 'andon-shell', 'andon-agent']) expect(areaOf(s)).toBe('Andon');
    expect(areaOf('templates')).toBe('Skill');
    expect(areaOf('cli')).toBe('CLI');
    expect(areaOf('contract')).toBe('Contract');
    expect(areaOf('readme')).toBe('Readme');
    expect(areaOf(null)).toBeNull();
  });
});

describe('bump (AC1)', () => {
  const entry = (kind: Entry['kind'], type: string): Entry => ({ kind, type, area: null, text: 't', job: null });
  test('pre-1.0: breaking and feat bump the minor, fix and perf the patch', () => {
    expect(bump('0.3.1', [entry('fixed', 'fix')])).toBe('0.3.2');
    expect(bump('0.3.1', [entry('fixed', 'perf')])).toBe('0.3.2');
    expect(bump('0.3.1', [entry('fixed', 'fix'), entry('added', 'feat')])).toBe('0.4.0');
    expect(bump('0.3.1', [entry('breaking', 'feat')])).toBe('0.4.0');
  });
  test('from 1.0.0 on, breaking bumps the major', () => {
    expect(bump('1.2.3', [entry('breaking', 'fix')])).toBe('2.0.0');
    expect(bump('1.2.3', [entry('added', 'feat')])).toBe('1.3.0');
    expect(bump('1.2.3', [entry('fixed', 'fix')])).toBe('1.2.4');
  });
});

describe('the next version from history (AC1)', () => {
  async function tagged(): Promise<void> {
    await seed();
    gitIn(repo, 'tag', '-a', 'v0.3.1', '-m', 'factory v0.3.1');
    await commit('chore(factory): record job 059-old');
  }

  test('a fix or perf job merge bumps the patch', async () => {
    await tagged();
    await jobMerge('fix(cli): repair a', '060-a');
    expect(run(true).out).toContain('v0.3.2');
  });

  test('a perf job merge bumps the patch', async () => {
    await tagged();
    await jobMerge('perf(andon-service): faster b', '060-b');
    const r = run(true);
    expect(r.code).toBe(0);
    expect(r.out).toContain('v0.3.2');
  });

  test('a feat bumps the minor', async () => {
    await tagged();
    await jobMerge('fix(cli): repair a', '060-a');
    await commit('feat(cli): add c');
    expect(run(true).out).toContain('v0.4.0');
  });

  test('a feat! bumps the minor before 1.0', async () => {
    await tagged();
    await jobMerge('feat(cli)!: drop d', '060-d');
    expect(run(true).out).toContain('v0.4.0');
  });

  test('the newest reachable v* tag is the base; non-v tags and unreachable tags are ignored', async () => {
    await seed();
    gitIn(repo, 'tag', '-a', 'v0.2.0', '-m', 'factory v0.2.0');
    await commit('chore: between');
    gitIn(repo, 'tag', '-a', 'v0.3.1', '-m', 'factory v0.3.1');
    await commit('fix: after');
    gitIn(repo, 'tag', 'pre-epic-support');
    gitIn(repo, 'checkout', '--quiet', '-b', 'side');
    await commit('chore: side');
    gitIn(repo, 'tag', 'v9.0.0');
    gitIn(repo, 'checkout', '--quiet', 'main');
    const r = run(true);
    expect(r.out).toContain('v0.3.2');
    expect(r.out).not.toContain('between');
  });

  test('only non-user-facing commits and job merges: "nothing to release", non-zero, nothing written', async () => {
    await tagged();
    for (const type of ['chore', 'specs', 'docs', 'test', 'refactor']) {
      await commit(`${type}(cli): direct ${type}`);
      await jobMerge(`${type}(cli): merged ${type}`, `06${type.length}-${type}`);
    }
    for (const dryRun of [true, false]) {
      const before = await snapshot();
      const r = run(dryRun);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('nothing to release');
      expect(await snapshot()).toEqual(before);
    }
  });
});

describe('entry selection and formatting (AC2)', () => {
  test('job merges, direct commits, breaking, the type filter, and skipped subjects', async () => {
    initMain();
    await commit('Initial import');
    await jobMerge('feat(andon-ui): show X', '060-x');
    await commit('fix: repair Y');
    await commit('feat(cli)!: drop Z');
    await commit('chore(factory): record job 060-x');
    const { entries, skipped } = collect(repo, null);
    expect(lines(entries)).toEqual(['added Andon show X 060-x', 'fixed - repair Y -', 'breaking CLI drop Z -']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('Initial import');

    expect(formatSection('0.1.0', TODAY, entries)).toBe(
      ['## v0.1.0 (2026-10-29)', '', '### Breaking', '', '- CLI: drop Z', '', '### Added', '', '- Andon: show X (060-x)', '', '### Fixed', '', '- repair Y', ''].join('\n'),
    );

    // Through the script: the skipped subject is named in the output, the chore is absent. The dry
    // run stages the tree it would commit, so it needs the package.json files and the config.
    await put('package.json', PACKAGES['package.json'] ?? '');
    await put('packages/templates/package.json', PACKAGES['packages/templates/package.json'] ?? '');
    await put(CONFIG, configText());
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore: add templates');
    const r = run(true);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Initial import');
    expect(r.out).toMatch(/skipped/);
    expect(r.out).not.toContain('record job');
  });

  test('a section with no entries is left out; entries keep history order', () => {
    const e = (kind: Entry['kind'], text: string): Entry => ({ kind, type: 'feat', area: null, text, job: null });
    expect(formatSection('0.2.0', TODAY, [e('added', 'first'), e('added', 'second')])).toBe('## v0.2.0 (2026-10-29)\n\n### Added\n\n- first\n- second\n');
  });

  test('a merge without a job line is a direct commit, and a job line on a plain commit is ignored', async () => {
    initMain();
    await commit('feat(cli): plain', 'Factory job 070-not-a-merge.');
    gitIn(repo, 'checkout', '--quiet', '-b', 'topic');
    await commit('chore: topic work');
    gitIn(repo, 'checkout', '--quiet', 'main');
    gitIn(repo, 'merge', '--quiet', '--no-ff', 'topic', '-m', 'fix(templates): merged without a job line');
    gitIn(repo, 'checkout', '--quiet', '-b', 'other');
    await commit('chore: other work');
    gitIn(repo, 'checkout', '--quiet', 'main');
    gitIn(repo, 'merge', '--quiet', '--no-ff', 'other', '-m', "Merge branch 'other'");
    const { entries, skipped } = collect(repo, null);
    expect(lines(entries)).toEqual(['added CLI plain -', 'fixed Skill merged without a job line -']);
    expect(skipped.join('\n')).toContain("Merge branch 'other'");
  });
});

describe('Land epic expansion (AC3)', () => {
  test('a Land epic merge gives its members\' job merges, not an entry of its own', async () => {
    initMain();
    await commit('chore: seed');
    gitIn(repo, 'checkout', '--quiet', '-b', 'factory/epic/demo');
    await commit('chore(factory): start epic demo');
    await jobMerge('feat(cli): a', '061-a', 'factory/epic/demo');
    // main moves, and the epic catches up with it (the skill's Catch-up merge)
    gitIn(repo, 'checkout', '--quiet', 'main');
    await commit('fix: on main');
    gitIn(repo, 'checkout', '--quiet', 'factory/epic/demo');
    gitIn(repo, 'merge', '--quiet', '--no-ff', 'main', '-m', 'Merge main into factory/epic/demo');
    await jobMerge('fix(templates): b', '062-b', 'factory/epic/demo');
    gitIn(repo, 'checkout', '--quiet', 'main');
    await jobMerge('feat(andon): before landing', '063-c');
    gitIn(repo, 'merge', '--quiet', '--no-ff', 'factory/epic/demo', '-m', 'Land epic demo: Demo', '-m', 'Jobs: 061-a, 062-b.');
    await jobMerge('fix(contract): after landing', '064-d');

    const { entries, skipped } = collect(repo, null);
    expect(lines(entries)).toEqual([
      'fixed - on main -',
      'added Andon before landing 063-c',
      'added CLI a 061-a',
      'fixed Skill b 062-b',
      'fixed Contract after landing 064-d',
    ]);
    expect(skipped).toEqual([]);
    const section = formatSection('0.2.0', TODAY, entries);
    expect(section).toContain('### Added\n\n- Andon: before landing (063-c)\n- CLI: a (061-a)\n');
    expect(section).toContain('- Skill: b (062-b)');
    expect(section).not.toContain('Demo');
    expect(section).not.toContain('start epic');
  });

  test('an epic landed before the tag contributes nothing after it', async () => {
    initMain();
    await commit('chore: seed');
    gitIn(repo, 'checkout', '--quiet', '-b', 'factory/epic/demo');
    await jobMerge('feat(cli): a', '061-a', 'factory/epic/demo');
    gitIn(repo, 'checkout', '--quiet', 'main');
    gitIn(repo, 'merge', '--quiet', '--no-ff', 'factory/epic/demo', '-m', 'Land epic demo: Demo', '-m', 'Jobs: 061-a.');
    gitIn(repo, 'tag', '-a', 'v0.2.0', '-m', 'factory v0.2.0');
    await jobMerge('fix(cli): later', '065-e');
    expect(lines(collect(repo, 'v0.2.0').entries)).toEqual(['fixed CLI later 065-e']);
  });
});

describe('a real run (AC4)', () => {
  test('writes every package.json version, prepends CHANGELOG.md, commits, and tags; pushes nothing, upgrades nothing', async () => {
    await seed();
    await put('factory/managed.json', '{ "schema": "factory/v1", "version": "0.1.0", "files": {} }\n');
    await put('.claude/agents/factory-builder.md', 'managed\n');
    await put('CHANGELOG.md', '## v0.1.0 (2026-10-01)\n\n### Added\n\n- CLI: first (001-first)\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore: installed copy and the old changelog');
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    await jobMerge('feat(andon-ui): show X', '060-x');

    const remote = join(root, 'remote.git');
    gitIn(root, 'init', '--quiet', '--bare', remote);
    gitIn(repo, 'remote', 'add', 'origin', remote);
    gitIn(repo, 'push', '--quiet', 'origin', 'main');
    const remoteBefore = gitIn(remote, 'show-ref');
    const managed = await read('factory/managed.json');
    const agent = await read('.claude/agents/factory-builder.md');
    const before = gitIn(repo, 'rev-parse', 'HEAD');

    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('v0.2.0');

    for (const [path, text] of Object.entries(PACKAGES)) {
      const want = text.replace(/^( {2}"version": ")[^"]*"/m, '$10.2.0"');
      expect(await read(path)).toBe(want);
    }
    expect(await read('apps/andon/package.json')).toContain('"version": "9.9.9"');
    expect(await read('CHANGELOG.md')).toBe(
      '## v0.2.0 (2026-10-29)\n\n### Added\n\n- Andon: show X (060-x)\n\n## v0.1.0 (2026-10-01)\n\n### Added\n\n- CLI: first (001-first)\n',
    );

    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore(release): v0.2.0');
    expect(gitIn(repo, 'rev-parse', 'HEAD~1')).toBe(before);
    expect(gitIn(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort()).toEqual([...Object.keys(PACKAGES), 'CHANGELOG.md'].sort());
    expect(gitIn(repo, 'cat-file', '-t', 'v0.2.0')).toBe('tag');
    expect(gitIn(repo, 'rev-parse', 'v0.2.0^{commit}')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    expect(gitIn(repo, 'tag', '-l', '--format=%(contents)', 'v0.2.0')).toBe('factory v0.2.0');
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');

    expect(gitIn(remote, 'show-ref')).toBe(remoteBefore);
    expect(await read('factory/managed.json')).toBe(managed);
    expect(await read('.claude/agents/factory-builder.md')).toBe(agent);
  });

  test('creates CHANGELOG.md when it is absent', async () => {
    await seed();
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    await jobMerge('fix: repair Y', '060-y');
    expect(run().code).toBe(0);
    expect(await read('CHANGELOG.md')).toBe('## v0.1.1 (2026-10-29)\n\n### Fixed\n\n- repair Y (060-y)\n');
    expect(gitIn(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD')).toContain('CHANGELOG.md');
  });

  test('refuses, writing nothing, when the tag already exists', async () => {
    await seed();
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    gitIn(repo, 'checkout', '--quiet', '-b', 'side');
    await commit('chore: side');
    gitIn(repo, 'tag', 'v0.1.1'); // not reachable from main, so not the base
    gitIn(repo, 'checkout', '--quiet', 'main');
    await jobMerge('fix: repair Y', '060-y');
    const before = await snapshot();
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('v0.1.1 already exists');
    expect(await snapshot()).toEqual(before);
  });
});

describe('baseline and dry run (AC5)', () => {
  async function history(): Promise<void> {
    await seed('Initial import');
    await jobMerge('feat(andon-ui): show X', '060-x');
    await jobMerge('docs(readme): explain X', '061-docs');
    await commit('fix: repair Y');
    gitIn(repo, 'tag', 'pre-epic-support');
    await commit('chore(factory): record job 061-docs');
  }

  test('--dry-run prints v0.1.0 and the whole history\'s section, and changes nothing', async () => {
    await history();
    const before = await snapshot();
    const r = run(true);
    expect(r.code).toBe(0);
    expect(r.out).toContain('v0.1.0');
    expect(r.out).toContain('## v0.1.0 (2026-10-29)\n\n### Added\n\n- Andon: show X (060-x)\n\n### Fixed\n\n- repair Y\n');
    expect(r.out).not.toContain('explain X');
    expect(await snapshot()).toEqual(before);
  });

  test('the real run then tags v0.1.0 on that commit with no bump', async () => {
    await history();
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    expect(run(true).code).toBe(0);
    const r = run();
    expect(r.code).toBe(0);
    expect(gitIn(repo, 'rev-parse', 'HEAD~1')).toBe(head);
    expect(gitIn(repo, 'rev-parse', 'v0.1.0^{commit}')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore(release): v0.1.0');
    expect(await versionOf('packages/templates/package.json')).toBe('0.1.0');
    expect(await versionOf('package.json')).toBe('0.1.0');
    expect(await read('CHANGELOG.md')).toStartWith('## v0.1.0 (2026-10-29)\n');
  });

  test('the script runs from the command line with --dry-run', async () => {
    await history();
    const before = await snapshot();
    const p = Bun.spawnSync(['bun', join(import.meta.dir, 'release.ts'), '--dry-run'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('- Andon: show X (060-x)');
    expect(await snapshot()).toEqual(before);
    const bad = Bun.spawnSync(['bun', join(import.meta.dir, 'release.ts'), '--dryrun'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    expect(bad.exitCode).not.toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});

describe('refusals (AC6)', () => {
  async function releasable(): Promise<void> {
    await seed();
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    await jobMerge('feat(cli): add c', '060-c');
  }
  async function refuses(dryRun: boolean, reason: RegExp): Promise<void> {
    const before = await snapshot();
    const r = run(dryRun);
    expect(r.code).not.toBe(0);
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    expect(r.out).toMatch(reason);
    expect(await snapshot()).toEqual(before);
  }

  test('(a) on a branch other than main', async () => {
    await releasable();
    gitIn(repo, 'checkout', '--quiet', '-b', 'feature');
    for (const dryRun of [false, true]) await refuses(dryRun, /not on main.*feature/);
  });

  test('(b) on a detached HEAD', async () => {
    await releasable();
    gitIn(repo, 'checkout', '--quiet', '--detach', 'HEAD');
    for (const dryRun of [false, true]) await refuses(dryRun, /not on main.*detached HEAD/);
  });

  test('(c) on main with a modified tracked file', async () => {
    await releasable();
    await put('package.json', `${PACKAGES['package.json'] ?? ''} `);
    for (const dryRun of [false, true]) await refuses(dryRun, /working tree is dirty/);
  });

  test('(c) on main with an untracked file; gitignored files don\'t count', async () => {
    await releasable();
    await put('.gitignore', 'state/\n');
    gitIn(repo, 'add', '.gitignore');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore: ignore state');
    await put('state/x.json', '{}\n');
    await put('stray.txt', 'x\n');
    await refuses(false, /working tree is dirty/);
    await rm(join(repo, 'stray.txt'));
    expect(run(true).code).toBe(0);
  });
});

describe('setVersion and prependChangelog', () => {
  test('changes only the top-level version value', () => {
    const text = '{\n  "name": "x",\n  "version": "0.0.0",\n  "deps": {\n    "version": "1.0.0"\n  }\n}\n';
    expect(setVersion(text, '0.2.0')).toBe(text.replace('"0.0.0"', '"0.2.0"'));
    expect(() => setVersion('{\n  "name": "x"\n}\n', '0.2.0')).toThrow(/version/);
  });

  test('prepends above the first section and keeps anything before it', () => {
    expect(prependChangelog(null, '## v0.2.0 (d)\n\n- a\n')).toBe('## v0.2.0 (d)\n\n- a\n');
    expect(prependChangelog('## v0.1.0 (d)\n\n- b\n', '## v0.2.0 (d)\n\n- a\n')).toBe('## v0.2.0 (d)\n\n- a\n\n## v0.1.0 (d)\n\n- b\n');
    expect(prependChangelog('# Changelog\n\n## v0.1.0 (d)\n', '## v0.2.0 (d)\n')).toBe('# Changelog\n\n## v0.2.0 (d)\n\n## v0.1.0 (d)\n');
  });
});

const refOf = (ref: string): string | null => {
  const p = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref], { stdout: 'pipe', stderr: 'pipe' });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

describe('the release bundle on the release branch (060 AC4)', () => {
  async function releasable(): Promise<void> {
    await seed();
    await put('CHANGELOG.md', '## v0.1.0 (2026-10-01)\n\n### Added\n\n- CLI: first (001-first)\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore: the old changelog');
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    await jobMerge('feat(cli): add c', '060-c');
  }

  test('commits the bundle onto release, tagged release-vX.Y.Z, naming the main commit; the checkout does not move; no remote is contacted', async () => {
    await releasable();
    // An origin that can't be reached: any contact would fail the release.
    gitIn(repo, 'remote', 'add', 'origin', join(root, 'no-such-remote.git'));
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('tagged release-v0.2.0');
    expect(r.out).toContain('Nothing was pushed');

    const main = gitIn(repo, 'rev-parse', 'HEAD');
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore(release): v0.2.0');
    expect(gitIn(repo, 'rev-parse', 'v0.2.0^{commit}')).toBe(main);
    expect(gitIn(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(existsSync(join(repo, 'bin'))).toBe(false);

    const bundle = refOf('refs/heads/release');
    expect(bundle).not.toBeNull();
    expect(gitIn(repo, 'log', '-1', '--format=%B', 'release')).toContain(main);
    expect(gitIn(repo, 'rev-list', '--parents', '-n', '1', 'release').split(' ')).toHaveLength(1); // the first is a root commit
    expect(gitIn(repo, 'ls-tree', '-r', '--name-only', 'release').split('\n')).toEqual(['CHANGELOG.md', 'bin/factory.js', 'package.json']);
    expect(gitIn(repo, 'ls-tree', 'release', 'bin/factory.js')).toStartWith('100755 blob');
    const pkg: unknown = JSON.parse(gitIn(repo, 'show', 'release:package.json'));
    expect(pkg).toMatchObject({ version: '0.2.0', bin: { factory: 'bin/factory.js' } });
    expect(gitIn(repo, 'show', 'release:CHANGELOG.md')).toStartWith('## v0.2.0 (2026-10-29)');
    expect(gitIn(repo, 'cat-file', '-t', 'release-v0.2.0')).toBe('tag');
    expect(gitIn(repo, 'rev-parse', 'release-v0.2.0^{commit}')).toBe(bundle ?? '');
    expect(gitIn(repo, 'branch', '--list', '--format=%(refname)')).not.toContain('factory/');

    // A second release stacks a new release commit on the first.
    await jobMerge('fix(cli): repair d', '061-d');
    const again = run();
    expect(again.code).toBe(0);
    expect(gitIn(repo, 'rev-parse', 'release^')).toBe(bundle ?? '');
    expect(JSON.parse(gitIn(repo, 'show', 'release:package.json'))).toMatchObject({ version: '0.2.1' });
    expect(gitIn(repo, 'log', '-1', '--format=%B', 'release')).toContain(gitIn(repo, 'rev-parse', 'HEAD'));
    expect(gitIn(repo, 'rev-parse', 'release-v0.2.1^{commit}')).toBe(gitIn(repo, 'rev-parse', 'release'));
    expect(gitIn(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  test('--dry-run builds no bundle and writes nothing', async () => {
    await releasable();
    const before = await snapshot();
    let built = false;
    const r = run(true, () => {
      built = true;
    });
    expect(r.code).toBe(0);
    expect(built).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(refOf('refs/heads/release')).toBeNull();
  });

  test('refuses, writing nothing, when release-vX.Y.Z already exists', async () => {
    await releasable();
    gitIn(repo, 'tag', 'release-v0.2.0', 'HEAD~1');
    const before = await snapshot();
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('release-v0.2.0 already exists');
    expect(await snapshot()).toEqual(before);
  });
});

describe('a failed bundle build writes nothing (060 AC5)', () => {
  async function releasable(): Promise<void> {
    await seed();
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    await jobMerge('feat(cli): add c', '060-c');
  }
  const failing: Record<string, BuildBundle> = {
    'a builder that throws': () => {
      throw new Error('vite build failed: boom\nmore detail');
    },
    'a bundle with no bin': (_tree, out) => writeFileSync(join(out, 'package.json'), '{"name":"factory"}\n'),
    'the default builder, with no scripts/bundle.ts in the tree': buildWithScript,
  };
  for (const [name, build] of Object.entries(failing)) {
    test(name, async () => {
      await releasable();
      const before = await snapshot();
      const r = run(false, build);
      expect(r.code).not.toBe(0);
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
      expect(r.out).toStartWith('release failed: bundle build: ');
      expect(await snapshot()).toEqual(before);
      expect(refOf('refs/heads/release')).toBeNull();
      expect(gitIn(repo, 'tag', '--list')).toBe('v0.1.0');
    });
  }
});

describe('the gate on the staged release tree (064)', () => {
  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const logPath = (): string => join(root, 'gate.log');
  const logged = async (): Promise<string[]> => (existsSync(logPath()) ? (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean) : []);
  const say = (word: string): string => `echo ${word} >> ${sq(logPath())}`;

  /** v0.1.0, then a releasable feat, with `extra` merged into the config (committed as a chore). */
  async function releasable(extra: Record<string, unknown> = {}, raw?: string): Promise<void> {
    await seed();
    await put('CHANGELOG.md', '## v0.1.0 (2026-10-01)\n\n### Added\n\n- CLI: first (001-first)\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore: the old changelog');
    gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
    await jobMerge('feat(cli): add c', '060-c');
    await put(CONFIG, raw ?? configText(extra));
    gitIn(repo, 'add', '-A');
    if (gitIn(repo, 'status', '--porcelain') !== '') gitIn(repo, 'commit', '--quiet', '-m', 'chore(factory): the gate');
  }
  // A build that logs when it runs, then builds as fakeBuild does.
  let built = 0;
  const loggingBuild: BuildBundle = (tree, out) => {
    built += 1;
    writeFileSync(logPath(), 'build\n', { flag: 'a' });
    fakeBuild(tree, out);
  };
  beforeEach(() => {
    built = 0;
  });
  const go = (dryRun: boolean, gate?: RunGate) => release(repo, { dryRun, today: TODAY, build: loggingBuild, ...(gate === undefined ? {} : { gate }) });

  test('AC3: a green gate runs in order on the staged tree (new versions and CHANGELOG.md) before the build and any write', async () => {
    const seen = join(root, 'seen');
    await mkdir(seen);
    const look = [
      `pwd -P > ${sq(join(seen, 'cwd'))}`,
      `cp packages/templates/package.json ${sq(join(seen, 'staged-templates.json'))}`,
      `cp CHANGELOG.md ${sq(join(seen, 'staged-changelog.md'))}`,
      `cp ${sq(join(repo, 'packages/templates/package.json'))} ${sq(join(seen, 'repo-templates.json'))}`,
      `git -C ${sq(repo)} rev-parse HEAD > ${sq(join(seen, 'repo-head'))}`,
      `git -C ${sq(repo)} tag --list > ${sq(join(seen, 'repo-tags'))}`,
    ].join(' && ');
    await releasable({ gate: [say('one'), look, say('two')] });
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const r = go(false);
    expect(r.code).toBe(0);
    expect(await logged()).toEqual(['one', 'two', 'build']);
    expect(r.out).toContain('gate: green (');
    expect(r.out).toContain('tagged release-v0.2.0');

    const cwd = (await readFile(join(seen, 'cwd'), 'utf8')).trim();
    expect(cwd).not.toBe(repo);
    expect(cwd.endsWith('/tree')).toBe(true);
    expect(await readFile(join(seen, 'staged-templates.json'), 'utf8')).toContain('"version": "0.2.0"');
    expect(await readFile(join(seen, 'staged-changelog.md'), 'utf8')).toStartWith('## v0.2.0 (2026-10-29)\n\n### Added\n\n- CLI: add c (060-c)\n');
    // The repo was untouched while the gate ran: the old version, the old HEAD, only v0.1.0.
    expect(await readFile(join(seen, 'repo-templates.json'), 'utf8')).toContain('"version": "0.1.0"');
    expect((await readFile(join(seen, 'repo-head'), 'utf8')).trim()).toBe(head);
    expect((await readFile(join(seen, 'repo-tags'), 'utf8')).trim()).toBe('v0.1.0');
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('chore(release): v0.2.0');
    expect(gitIn(repo, 'rev-parse', 'HEAD~1')).toBe(head);
  });

  test('AC3: the gate runner gets the staged tree and each command in order', async () => {
    await releasable({ gate: ['first', 'second', 'third'] });
    const calls: string[] = [];
    let trees = new Set<string>();
    const r = go(false, (tree, command) => {
      trees.add(tree);
      calls.push(`${command} ${String(built)}`);
      return 0;
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual(['first 0', 'second 0', 'third 0']);
    expect(built).toBe(1);
    expect(trees.size).toBe(1);
    trees = new Set([...trees].map((t) => (t.startsWith(repo) ? 'inside the repo' : 'outside')));
    expect([...trees]).toEqual(['outside']);
  });

  for (const dryRun of [false, true]) {
    test(`AC${dryRun ? 5 : 4}: a red gate${dryRun ? ' on --dry-run' : ''} exits 1 naming the command; no later command runs; nothing is written`, async () => {
      await releasable({ gate: [say('first'), 'exit 1', say('third')] });
      const before = await snapshot();
      const r = go(dryRun);
      expect(r.code).toBe(1);
      expect(r.out).toContain('gate is red: exit 1');
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
      expect(await logged()).toEqual(['first']);
      expect(built).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(await read('packages/templates/package.json')).toBe(PACKAGES['packages/templates/package.json'] ?? '');
      expect(await read('CHANGELOG.md')).toStartWith('## v0.1.0 ');
      expect(gitIn(repo, 'tag', '--list')).toBe('v0.1.0');
      expect(refOf('refs/heads/release')).toBeNull();
    });
  }

  test('AC4: a red gate leaves an existing release branch where it was', async () => {
    await releasable({ gate: [say('ok')] });
    expect(go(false).code).toBe(0);
    const tip = refOf('refs/heads/release');
    expect(tip).not.toBeNull();
    await jobMerge('fix(cli): repair d', '061-d');
    await put(CONFIG, configText({ gate: ['false'] }));
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore(factory): a red gate');
    const before = await snapshot();
    const r = go(false);
    expect(r.code).toBe(1);
    expect(r.out).toContain('gate is red: false');
    expect(await snapshot()).toEqual(before);
    expect(refOf('refs/heads/release')).toBe(tip);
    expect(gitIn(repo, 'tag', '--list', 'v0.2.1', 'release-v0.2.1')).toBe('');
  });

  test('AC5: a green --dry-run runs the gate, prints the version and section, writes nothing, and builds no bundle', async () => {
    await releasable({ gate: [say('one'), say('two')] });
    const before = await snapshot();
    const r = go(true);
    expect(r.code).toBe(0);
    expect(r.out).toContain('v0.2.0 (from v0.1.0)');
    expect(r.out).toContain('## v0.2.0 (2026-10-29)\n\n### Added\n\n- CLI: add c (060-c)\n');
    expect(r.out).toContain('dry run: nothing written');
    expect(await logged()).toEqual(['one', 'two']);
    expect(built).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(refOf('refs/heads/release')).toBeNull();
  });

  test('AC5: the script from the command line: a red gate on --dry-run exits 1 with gate is red', async () => {
    await releasable({ gate: [say('first'), 'exit 7'] });
    const before = await snapshot();
    const p = Bun.spawnSync(['bun', join(import.meta.dir, 'release.ts'), '--dry-run'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain('gate is red: exit 7');
    expect(await snapshot()).toEqual(before);
  });

  test('AC6: no gate in factory/config.json: it says no gate is configured and goes on (real and dry run)', async () => {
    await releasable();
    const dry = go(true);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('no gate configured');
    expect(built).toBe(0);
    const r = go(false);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no gate configured');
    expect(r.out).toContain('tagged release-v0.2.0');
    expect(built).toBe(1);
  });

  const invalid: Record<string, string | null> = {
    'not JSON': '{ "schema": "factory/v1",\n',
    'an empty gate': configText({ gate: [] }),
    'a gate that is a string': configText({ gate: 'bun run test' }),
    'a blank gate command': configText({ gate: ['echo ok', ' '] }),
    'a wrong schema': configText({ schema: 'factory/v0' }),
    'no factory/config.json': null,
  };
  for (const [name, raw] of Object.entries(invalid)) {
    test(`AC6: refuses, writing nothing, on an invalid config: ${name}`, async () => {
      await releasable({}, raw ?? '');
      if (raw === null) {
        gitIn(repo, 'rm', '--quiet', CONFIG);
        gitIn(repo, 'commit', '--quiet', '-m', 'chore(factory): no config');
      }
      for (const dryRun of [false, true]) {
        const before = await snapshot();
        const r = go(dryRun);
        expect(r.code).toBe(1);
        expect(r.out.trimEnd().split('\n')).toHaveLength(1);
        expect(r.out).toMatch(/^release refused: factory\/config\.json is (invalid|unreadable): /);
        expect(built).toBe(0);
        expect(await snapshot()).toEqual(before);
        expect(refOf('refs/heads/release')).toBeNull();
      }
    });
  }

  test('the earlier refusals still come first, before the gate runs', async () => {
    await releasable({ gate: [say('ran'), 'exit 1'] });
    await put('stray.txt', 'x\n');
    const r = go(false);
    expect(r.out).toMatch(/working tree is dirty/);
    await rm(join(repo, 'stray.txt'));
    gitIn(repo, 'checkout', '--quiet', '-b', 'feature');
    expect(go(true).out).toMatch(/not on main/);
    gitIn(repo, 'checkout', '--quiet', 'main');
    gitIn(repo, 'tag', 'release-v0.2.0', 'HEAD~1');
    expect(go(false).out).toContain('release-v0.2.0 already exists');
    expect(await logged()).toEqual([]);
  });

  test('readGate reads the commands in order, or null when no gate is configured', async () => {
    await releasable({ gate: ['a', 'b c'] });
    expect(readGate(repo)).toEqual(['a', 'b c']);
    await put(CONFIG, configText());
    expect(readGate(repo)).toBeNull();
  });
});

/**
 * This source's files: git's tracked and untracked-but-not-ignored files in a checkout, or, in the
 * staged release tree the gate runs in (a `git archive` with no `.git`), every file but the
 * mirrored `node_modules`.
 */
function sourceFiles(source: string): string[] {
  const listed = Bun.spawnSync(['git', '-C', source, 'rev-parse', '--show-prefix'], { stdout: 'pipe', stderr: 'pipe' });
  if (listed.exitCode === 0 && listed.stdout.toString().trim() === '') {
    const p = Bun.spawnSync(['git', '-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { stdout: 'pipe' });
    return p.stdout.toString().split('\0').filter(Boolean);
  }
  const walk = (rel: string): string[] =>
    readdirSync(join(source, rel), { withFileTypes: true }).flatMap((e) => {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.name === 'node_modules' || e.name === '.git') return [];
      return e.isDirectory() ? walk(path) : e.isFile() ? [path] : [];
    });
  return walk('');
}

describe('the real bundle, built from the tree about to be committed (060 AC4)', () => {
  test('a test repo holding this source: the release tree runs as factory <new version> (release)', async () => {
    const source = join(import.meta.dir, '..');
    initMain();
    for (const rel of sourceFiles(source)) {
      if (!existsSync(join(source, rel))) continue;
      await mkdir(dirname(join(repo, rel)), { recursive: true });
      await writeFile(join(repo, rel), await readFile(join(source, rel)));
    }
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore: import');
    const pkg: unknown = JSON.parse(await read('packages/templates/package.json'));
    const current = typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : '';
    gitIn(repo, 'tag', '-a', `v${current}`, '-m', `factory v${current}`);
    await commit('feat(cli): something new');

    // This source's own gate (`bun run test`, ...) would run this suite again: a stand-in passes it.
    const ran: string[] = [];
    const r = release(repo, { dryRun: false, today: TODAY, modules: source, gate: (_tree, command) => {
      ran.push(command);
      return 0;
    } });
    expect(ran).toEqual(readGate(repo) ?? []);
    expect(r.out).toContain('tagged release-v');
    expect(r.code).toBe(0);
    const next = gitIn(repo, 'describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD').slice(1);
    expect(next).not.toBe(current);

    const out = join(root, 'checked-out');
    await mkdir(out);
    const tar = join(root, 'release.tar');
    gitIn(repo, 'archive', '--format=tar', '-o', tar, 'release');
    expect(Bun.spawnSync(['tar', '-xf', tar, '-C', out]).exitCode).toBe(0);
    const v = Bun.spawnSync([process.execPath, join(out, 'bin', 'factory.js'), '--version'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(v.stdout.toString()).toBe(`factory ${next} (release)\n`);
    expect(await readFile(join(out, 'managed', 'cli.ts'), 'utf8')).toStartWith(`// factory ${next} ·`);
    expect(JSON.parse(await readFile(join(out, 'package.json'), 'utf8'))).toMatchObject({ version: next, bin: { factory: 'bin/factory.js' } });
    expect(await readFile(join(out, 'CHANGELOG.md'), 'utf8')).toStartWith(`## v${next} (${TODAY})`);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
  }, 120_000);
});
