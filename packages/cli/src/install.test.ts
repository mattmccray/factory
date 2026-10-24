import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Config, parseConfig, parseManifest } from '@factory/contract';
import { VERSION, cliStampLine, contractStampLine, renderClaudeCode } from '@factory/templates';
import { initRepo } from './gitrepo';
import { DEFAULT_CONFIG, GITIGNORE_LINES, withRuntimeIgnores } from './install';
import { run } from './index';
import { protectedReason } from './paths';

const REPO = join(import.meta.dir, '..', '..', '..');
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

let tmp: string;
let dir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'factory-install-'));
  dir = join(tmp, 'project');
  await mkdir(dir);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string[];
  err: string[];
}
async function cli(project: string, ...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { root: join(project, 'factory'), stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}
const doctorCode = async (project: string): Promise<number> => (await cli(project, 'doctor')).code;

// Every file and directory under `root`, with each file's hash and each symlink's target, so a
// refusal can be checked as a byte-for-byte no-op.
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    const abs = join(e.parentPath, e.name);
    const rel = abs.slice(root.length + 1);
    if (e.isDirectory()) out[`${rel}/`] = '';
    else if (e.isSymbolicLink()) out[rel] = `-> link`;
    else out[rel] = sha(await readFile(abs));
  }
  return out;
}

const writeAt = async (root: string, rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text);
};
const text = (root: string, rel: string): Promise<string> => readFile(join(root, rel), 'utf8');
const manifestOf = async (root: string) => parseManifest(JSON.parse(await text(root, 'factory/managed.json')));
const configWith = (reviewers: string[]): string => `${JSON.stringify({ ...DEFAULT_CONFIG, reviewers })}\n`;
const agent = (k: string): string => `.claude/agents/factory-${k}.md`;

describe('init on an empty project (AC1)', () => {
  test('writes the render, CLI, contract, default config, and a manifest of exactly those files', async () => {
    const r = await cli(dir, 'init');
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);

    const config: Config = parseConfig(JSON.parse(await text(dir, 'factory/config.json')));
    expect(config).toEqual(parseConfig(DEFAULT_CONFIG));
    expect(JSON.parse(await text(dir, 'factory/config.json'))).toEqual({
      schema: 'factory/v1',
      reviewers: ['code'],
      maxRound: 2,
      dashboard: { settleAfterHours: 24 },
    });

    const { files } = renderClaudeCode({ config });
    for (const [path, want] of Object.entries(files)) expect({ path, text: await text(dir, path) }).toEqual({ path, text: want });

    const contract = await text(dir, 'factory/CONTRACT.md');
    expect(contract).toBe(`${contractStampLine()}\n${await text(REPO, 'docs/contract/v1.md')}`);

    const manifest = await manifestOf(dir);
    expect(manifest.version).toBe(VERSION);
    expect(Object.keys(manifest.files).sort()).toEqual([...Object.keys(files), 'factory/CONTRACT.md', 'factory/cli.ts'].sort());
    for (const [path, hash] of Object.entries(manifest.files)) expect({ path, hash }).toEqual({ path, hash: sha(await readFile(join(dir, path))) });

    const ignore = (await text(dir, '.gitignore')).split('\n');
    for (const line of GITIGNORE_LINES) expect(ignore).toContain(line);

    expect(await cli(dir, 'doctor')).toMatchObject({ code: 0, err: [] });
  });

  test('a second empty project gets a byte-identical managed.json', async () => {
    const other = join(tmp, 'other');
    await mkdir(other);
    expect((await cli(dir, 'init')).code).toBe(0);
    expect((await cli(other, 'init')).code).toBe(0);
    expect(await text(other, 'factory/managed.json')).toBe(await text(dir, 'factory/managed.json'));
  });

  test('.gitignore lines are appended once, keeping existing content', async () => {
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n/factory/jobs\n');
    expect((await cli(dir, 'init')).code).toBe(0);
    const ignore = await text(dir, '.gitignore');
    expect(ignore).toStartWith('node_modules/\n/factory/jobs\n');
    expect(ignore.split('\n').filter((l) => l.includes('factory/jobs'))).toHaveLength(1);
    expect(ignore).toContain('factory/.lock/\n');
    expect(ignore).toContain('factory/.worktrees/\n');
    expect(withRuntimeIgnores(ignore)).toBeNull();
    expect(withRuntimeIgnores('a')).toBe(`a\n\n# Factory runtime state\n${GITIGNORE_LINES.map((l) => `${l}\n`).join('')}`);
  });
});

describe('the installed CLI is self-contained (AC2)', () => {
  test('runs doctor and event with bun alone, rooted at its own directory', async () => {
    initRepo(dir, 'trunk');
    expect((await cli(dir, 'init')).code).toBe(0);
    const entries = await readdir(dir);
    expect(entries).not.toContain('node_modules');
    expect(entries).not.toContain('package.json');

    const spawn = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, 'factory/cli.ts', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const doc = await spawn('doctor');
    expect(doc.err).toBe('');
    expect(doc.code).toBe(0);
    const ev = await spawn('event', '001-smoke-test', 'job.claimed');
    expect(ev).toEqual({ out: 'claimed\n', err: '', code: 0 });
    const job = await readdir(join(dir, 'factory', 'jobs', '001-smoke-test'));
    expect(job).toContain('events.jsonl');
    expect(job).toContain('job.json');
    expect(JSON.parse(await text(dir, 'factory/jobs/001-smoke-test/job.json'))).toMatchObject({ target: 'trunk' });

    const unknown = await spawn('init');
    expect(unknown.code).toBe(1);

    expect((await text(dir, 'factory/cli.ts')).split('\n')[0]).toBe(cliStampLine());
    expect(cliStampLine()).toStartWith(`// factory ${VERSION} `);
    expect((await text(dir, 'factory/CONTRACT.md')).split('\n')[0]).toBe(contractStampLine());
    expect(contractStampLine()).toStartWith(`<!-- factory ${VERSION} `);
  });
});

describe('init refusals (AC3)', () => {
  const refuses = async (want: RegExp): Promise<string> => {
    const before = await snapshot(dir);
    const r = await cli(dir, 'init');
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(want);
    expect(await snapshot(dir)).toEqual(before);
    return r.err[0] ?? '';
  };

  test('(a) managed.json exists: says to use upgrade', async () => {
    await writeAt(dir, 'factory/managed.json', '{}');
    await refuses(/factory\/managed\.json exists.*upgrade/);
  });

  test('(b) a different file at a managed path is named; --force overwrites it', async () => {
    await writeAt(dir, agent('builder'), 'hand-written\n');
    await writeAt(dir, '.claude/skills/factory/SKILL.md', 'mine\n');
    const reason = await refuses(/--force/);
    expect(reason).toContain(agent('builder'));
    expect(reason).toContain('.claude/skills/factory/SKILL.md');

    expect((await cli(dir, 'init', '--force')).code).toBe(0);
    expect(await text(dir, agent('builder'))).toBe(renderClaudeCode({ config: parseConfig(DEFAULT_CONFIG) }).files[agent('builder')] ?? '');
    expect(await doctorCode(dir)).toBe(0);
  });

  test('a file with identical bytes at a managed path is not a conflict', async () => {
    const files = renderClaudeCode({ config: parseConfig(DEFAULT_CONFIG) }).files;
    await writeAt(dir, agent('builder'), files[agent('builder')] ?? '');
    expect((await cli(dir, 'init')).code).toBe(0);
  });

  test('(c) an invalid config.json (unknown key)', async () => {
    await writeAt(dir, 'factory/config.json', JSON.stringify({ ...DEFAULT_CONFIG, extra: 1 }));
    await refuses(/^init: factory\/config\.json: unknown key 'extra'$/);
  });

  test('(c) a config.json that is not JSON', async () => {
    await writeAt(dir, 'factory/config.json', '{');
    await refuses(/^init: factory\/config\.json: not valid JSON$/);
  });

  test('an existing valid config is kept byte-identical and drives the render', async () => {
    const cfg = `{ "schema": "factory/v1", "reviewers": ["alpha"], "maxRound": 3, "dashboard": { "settleAfterHours": 1 } }`;
    await writeAt(dir, 'factory/config.json', cfg);
    expect((await cli(dir, 'init')).code).toBe(0);
    expect(await text(dir, 'factory/config.json')).toBe(cfg);
    expect(await text(dir, agent('alpha'))).toContain('factory-alpha');
    expect(Object.keys((await manifestOf(dir)).files)).toContain(agent('alpha'));
    expect(Object.keys((await manifestOf(dir)).files)).not.toContain(agent('code'));
  });

  test('a managed path whose directory links outside the project is refused, --force or not', async () => {
    await mkdir(join(tmp, 'elsewhere'));
    await mkdir(join(dir, '.claude'));
    await symlink(join(tmp, 'elsewhere'), join(dir, '.claude', 'agents'));
    for (const argv of [['init'], ['init', '--force']]) {
      const r = await cli(dir, ...argv);
      expect(r.code).toBe(1);
      expect(r.err[0]).toMatch(/^init: refusing \.claude\/agents\/factory-[a-z-]+\.md: resolves outside the repo$/);
    }
    expect(await readdir(join(tmp, 'elsewhere'))).toEqual([]);
    expect(await readdir(join(dir, '.claude'))).toEqual(['agents']);
  });
});

describe('upgrade (AC4)', () => {
  const OVERLAY = ['factory/config.json', 'factory/roles/alpha.md', 'factory/backlog.md', 'factory/briefs/x.md', 'factory/jobs/001-a-b/events.jsonl'];

  beforeEach(async () => {
    await writeAt(dir, 'factory/config.json', configWith(['alpha']));
    expect((await cli(dir, 'init')).code).toBe(0);
    await writeAt(dir, 'factory/roles/alpha.md', 'alpha rules\n');
    await writeAt(dir, 'factory/backlog.md', '# Backlog\n');
    await writeAt(dir, 'factory/briefs/x.md', 'brief\n');
    await writeAt(dir, 'factory/jobs/001-a-b/events.jsonl', '{"ts":"x","type":"job.claimed"}\n');
  });

  test('a reviewer swap writes the new agent, deletes the old, and leaves the overlay alone', async () => {
    await writeAt(dir, 'factory/config.json', configWith(['beta']));
    const before = await snapshot(dir);
    const r = await cli(dir, 'upgrade');
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);

    const config = parseConfig(JSON.parse(await text(dir, 'factory/config.json')));
    const { files } = renderClaudeCode({ config });
    expect(await text(dir, agent('beta'))).toBe(files[agent('beta')] ?? '');
    expect(await Bun.file(join(dir, agent('alpha'))).exists()).toBe(false);
    expect(Object.keys((await manifestOf(dir)).files).sort()).toEqual([...Object.keys(files), 'factory/CONTRACT.md', 'factory/cli.ts'].sort());
    const after = await snapshot(dir);
    for (const rel of OVERLAY) expect({ rel, hash: after[rel] }).toEqual({ rel, hash: before[rel] });
    expect(await doctorCode(dir)).toBe(0);

    const settled = await snapshot(dir);
    expect((await cli(dir, 'upgrade')).code).toBe(0);
    expect(await snapshot(dir)).toEqual(settled);
  });

  test('a roles change rewrites only the affected agents, and managed.json matches them', async () => {
    const roles = { builder: { runner: 'claude', model: 'sonnet' }, alpha: { runner: 'claude', model: 'sonnet' } };
    await writeAt(dir, 'factory/config.json', `${JSON.stringify({ ...DEFAULT_CONFIG, reviewers: ['alpha'], roles })}\n`);
    const before = await snapshot(dir);
    const oldManifest = await manifestOf(dir);
    const r = await cli(dir, 'upgrade');
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);

    const after = await snapshot(dir);
    const changed = Object.keys(after).filter((rel) => after[rel] !== before[rel]).sort();
    expect(changed).toEqual([agent('alpha'), agent('builder'), 'factory/managed.json'].sort());
    expect(await text(dir, agent('builder'))).toContain('\nmodel: sonnet\n');
    expect(await text(dir, agent('alpha'))).toContain('\nmodel: sonnet\n');
    expect(await text(dir, agent('approver'))).toContain('\nmodel: opus\n');

    const newManifest = await manifestOf(dir);
    for (const [rel, hash] of Object.entries(newManifest.files)) {
      expect({ rel, hash }).toEqual({ rel, hash: sha(await readFile(join(dir, rel))) });
      if (rel !== agent('alpha') && rel !== agent('builder')) expect({ rel, hash }).toEqual({ rel, hash: oldManifest.files[rel] ?? '' });
    }
    expect(Object.keys(newManifest.files).sort()).toEqual(Object.keys(oldManifest.files).sort());
    expect(await doctorCode(dir)).toBe(0);
  });

  const crafted = async (extra: Record<string, string>): Promise<void> => {
    const m = await manifestOf(dir);
    await writeFile(join(dir, 'factory/managed.json'), JSON.stringify({ ...m, files: { ...m.files, ...extra } }));
  };

  test('an old manifest listing a path with .. is refused and nothing is deleted', async () => {
    await writeFile(join(tmp, 'victim.txt'), 'keep');
    await crafted({ '../victim.txt': sha('keep') });
    const before = await snapshot(tmp);
    const r = await cli(dir, 'upgrade');
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain('../victim.txt');
    expect(await snapshot(tmp)).toEqual(before);
  });

  test('an old manifest listing a path that resolves outside is refused, even with --force', async () => {
    await writeFile(join(tmp, 'victim.txt'), 'keep');
    await symlink(join(tmp, 'victim.txt'), join(dir, '.claude', 'agents', 'factory-gone.md'));
    await crafted({ '.claude/agents/factory-gone.md': sha('keep') });
    const before = await snapshot(tmp);
    for (const argv of [['upgrade'], ['upgrade', '--force']]) {
      const r = await cli(dir, ...argv);
      expect(r.code).toBe(1);
      expect(r.err).toEqual(['upgrade: refusing .claude/agents/factory-gone.md: resolves outside the repo']);
    }
    expect(await snapshot(tmp)).toEqual(before);
    expect(await text(tmp, 'victim.txt')).toBe('keep');
  });

  test('a managed path routed into the overlay by an in-repo directory symlink is refused', async () => {
    await mkdir(join(dir, 'factory', 'roles', 'sub'), { recursive: true });
    await writeAt(dir, 'factory/roles/sub/factory-gone.md', 'overlay\n');
    await symlink(join(dir, 'factory', 'roles', 'sub'), join(dir, '.claude', 'linked'));
    await crafted({ '.claude/linked/factory-gone.md': sha('overlay\n') });
    const before = await snapshot(dir);
    const r = await cli(dir, 'upgrade', '--force');
    expect(r.code).toBe(1);
    expect(r.err[0]).toStartWith('upgrade: refusing .claude/linked/factory-gone.md: resolves to a path that is overlay');
    expect(await snapshot(dir)).toEqual(before);
  });

  test('an old manifest listing overlay or runtime state is refused, even with --force', async () => {
    for (const rel of ['factory/config.json', 'factory/roles/alpha.md', 'factory/./Backlog.md', 'factory/jobs/001-a-b/events.jsonl', '.git/HEAD']) {
      await writeFile(join(dir, 'factory/managed.json'), JSON.stringify({ ...(await manifestOf(dir)), files: { [rel]: sha('x') } }));
      const before = await snapshot(dir);
      const r = await cli(dir, 'upgrade', '--force');
      expect(r.code).toBe(1);
      expect(r.err[0]).toStartWith(`upgrade: refusing ${rel}: is overlay`);
      expect(await snapshot(dir)).toEqual(before);
    }
  });
});

describe('upgrade refusals and usage (AC5)', () => {
  beforeEach(async () => {
    expect((await cli(dir, 'init')).code).toBe(0);
  });
  const refuses = async (argv: string[], want: RegExp): Promise<void> => {
    const before = await snapshot(dir);
    const r = await cli(dir, ...argv);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(want);
    expect(await snapshot(dir)).toEqual(before);
  };

  test('an edited managed file is named; --force restores the rendered bytes', async () => {
    const pristine = await text(dir, agent('builder'));
    await writeFile(join(dir, agent('builder')), `${pristine}local edit\n`);
    await refuses(['upgrade'], /factory-builder\.md \(changed\).*--force/);
    expect((await cli(dir, 'upgrade', '--force')).code).toBe(0);
    expect(await text(dir, agent('builder'))).toBe(pristine);
    expect(await doctorCode(dir)).toBe(0);
  });

  test('a deleted managed file is named', async () => {
    await unlink(join(dir, 'factory/CONTRACT.md'));
    await refuses(['upgrade'], /factory\/CONTRACT\.md \(missing\)/);
  });

  test('a new render path holding an unmanaged file is named', async () => {
    await writeAt(dir, agent('beta'), 'mine\n');
    await writeFile(join(dir, 'factory/config.json'), configWith(['code', 'beta']));
    await refuses(['upgrade'], /factory-beta\.md \(unmanaged\)/);
  });

  test('no managed.json says to run init', async () => {
    await unlink(join(dir, 'factory/managed.json'));
    await refuses(['upgrade'], /^upgrade: no factory\/managed\.json: .*use init$/);
  });

  test('an invalid config is refused', async () => {
    await writeFile(join(dir, 'factory/config.json'), JSON.stringify({ ...DEFAULT_CONFIG, extra: 1 }));
    await refuses(['upgrade'], /^upgrade: factory\/config\.json: unknown key 'extra'$/);
  });

  for (const argv of [['init', '--forse'], ['init', 'x'], ['init', '--force', '--force'], ['upgrade', '-f'], ['upgrade', '--force', 'x']]) {
    test(`usage error: ${argv.join(' ')}`, async () => {
      const cmd = argv[0] ?? '';
      await refuses(argv, new RegExp(`^usage: ${cmd} \\[--force\\]$`));
    });
  }
});

describe('self-upgrade of a copy of this repo (AC6)', () => {
  test('init --force adopts the vendored v0; overlay, orphans, and jobs are untouched; upgrade is a no-op', async () => {
    const copy = join(tmp, 'factory-repo');
    await mkdir(copy);
    await cp(join(REPO, '.claude', 'skills', 'factory'), join(copy, '.claude', 'skills', 'factory'), { recursive: true });
    for (const f of await readdir(join(REPO, '.claude', 'agents'))) {
      if (f.startsWith('factory-')) await cp(join(REPO, '.claude', 'agents', f), join(copy, '.claude', 'agents', f));
    }
    for (const f of ['cli.ts', 'serve.ts', 'dashboard.html', 'config.json', 'CONTRACT.md']) await cp(join(REPO, 'factory', f), join(copy, 'factory', f));
    await cp(join(REPO, 'factory', 'lib'), join(copy, 'factory', 'lib'), { recursive: true });
    await writeAt(copy, 'factory/jobs/001-old-job/events.jsonl', '{"ts":"x","type":"job.claimed"}\n');
    await writeAt(copy, 'factory/jobs/001-old-job/job.json', '{}\n');
    await writeFile(join(copy, '.gitignore'), await text(REPO, '.gitignore'));
    expect(JSON.parse(await text(copy, 'factory/config.json')).reviewers).toEqual(['security', 'code', 'contract', 'ui']);

    const kept = (s: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(s).filter(([rel]) => ['factory/config.json', 'factory/serve.ts', 'factory/dashboard.html', '.gitignore'].includes(rel) || rel.startsWith('factory/lib') || rel.startsWith('factory/jobs')),
      );
    const before = kept(await snapshot(copy));
    expect(Object.keys(before).length).toBeGreaterThan(8);

    // Make the copy stale on purpose, so the refusal never depends on whether this repo's installed
    // copy has been upgraded to the current templates.
    await writeFile(join(copy, agent('code')), `${await text(copy, agent('code'))}\nedited by the AC6 test\n`);
    const refused = await cli(copy, 'init');
    expect(refused.code).toBe(1); // a managed file differs, so init alone refuses
    expect(refused.err.join('\n')).toContain(agent('code'));
    const r = await cli(copy, 'init', '--force');
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(await doctorCode(copy)).toBe(0);
    expect(kept(await snapshot(copy))).toEqual(before);
    expect(Object.keys((await manifestOf(copy)).files)).toContain(agent('contract'));

    const settled = await snapshot(copy);
    const up = await cli(copy, 'upgrade');
    expect(up.err).toEqual([]);
    expect(up.code).toBe(0);
    expect(await snapshot(copy)).toEqual(settled);
  });
});

describe('protectedReason', () => {
  test('refuses overlay, runtime, and VCS paths in any spelling; allows managed paths', () => {
    for (const p of ['factory/config.json', 'factory/managed.json', 'factory/roles/x.md', 'factory//jobs/1', 'FACTORY/Briefs/x.md', 'factory/.lock', '.git/config', 'a/../factory/backlog.md'])
      expect({ p, refused: protectedReason(p) !== null }).toEqual({ p, refused: true });
    for (const p of ['factory/cli.ts', 'factory/CONTRACT.md', '.claude/agents/factory-x.md', 'factory/rolesx.md'])
      expect({ p, why: protectedReason(p) }).toEqual({ p, why: null });
  });
});
