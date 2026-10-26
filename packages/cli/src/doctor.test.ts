import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// Layout: <tmp>/outside.txt, <tmp>/repo/{factory/, .claude/...}. The factory root is repo/factory.
let tmp: string;
let repo: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'factory-doctor-'));
  repo = join(tmp, 'repo');
  root = join(repo, 'factory');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify(CONFIG));
  await writeFile(join(tmp, 'outside.txt'), 'secret');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function doctor(): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['doctor'], { root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}
const writeConfig = (v: unknown): Promise<void> => writeFile(join(root, 'config.json'), typeof v === 'string' ? v : JSON.stringify(v));
const writeManifest = (v: unknown): Promise<void> => writeFile(join(root, 'managed.json'), typeof v === 'string' ? v : JSON.stringify(v));
const manifest = (files: Record<string, string>) => ({ schema: 'factory/v1', version: '1.0.0', files });

describe('doctor: config (AC5)', () => {
  test('valid config and no manifest: exit 0, config ok, unstamped', async () => {
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toEqual(['ok    config.json', 'note  unstamped install: no managed.json, hash checks skipped']);
  });

  test('a config with a valid gate is ok', async () => {
    await writeConfig({ ...CONFIG, gate: ['bun test', 'tsc --noEmit'] });
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out).toContain('ok    config.json');
  });

  test('a config with a malformed gate fails with the reason', async () => {
    await writeConfig({ ...CONFIG, gate: [] });
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL  config.json: config: gate must be a non-empty array of command strings');
  });

  test('a config with valid roles is ok', async () => {
    await writeConfig({ ...CONFIG, roles: { builder: { runner: 'claude', model: 'sonnet' }, code: { runner: 'claude' } } });
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out).toContain('ok    config.json');
  });

  test('a config with bad roles fails with the parser\'s reason', async () => {
    await writeConfig({ ...CONFIG, roles: { code: { runner: 'codex' } } });
    let r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL  config.json: config: roles.code: runner must be "claude"');
    await writeConfig({ ...CONFIG, roles: { ux: { runner: 'claude' } } });
    r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out.some((l) => l.startsWith('FAIL  config.json: config: roles.ux: unknown role'))).toBe(true);
  });

  test('a config with a valid merge is ok', async () => {
    for (const merge of [{}, { target: 'current' }, { target: 'develop' }]) {
      await writeConfig({ ...CONFIG, merge });
      const r = await doctor();
      expect(r.code).toBe(0);
      expect(r.out).toContain('ok    config.json');
    }
  });

  test('a config with a bad merge fails with the parser\'s reason', async () => {
    const cases: Array<[unknown, string]> = [
      [{ target: 'main', squash: true }, "FAIL  config.json: config.merge: unknown key 'squash'"],
      ['main', 'FAIL  config.json: config: merge must be an object { target? }'],
      [{ target: '' }, 'FAIL  config.json: config: merge.target must be "current" or a non-empty branch name'],
      [{ target: 7 }, 'FAIL  config.json: config: merge.target must be "current" or a non-empty branch name'],
    ];
    for (const [merge, line] of cases) {
      await writeConfig({ ...CONFIG, merge });
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.out).toContain(line);
    }
  });

  test('missing config.json', async () => {
    await rm(join(root, 'config.json'));
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL  config.json: missing');
    expect(r.out.some((l) => l.includes('unstamped'))).toBe(true); // reports every finding
  });

  test('unparseable config.json', async () => {
    await writeConfig('{ not json');
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL  config.json: not valid JSON');
  });

  test('unknown key', async () => {
    await writeConfig({ ...CONFIG, theme: 'dark' });
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  config.json: config: unknown key 'theme'");
  });

  test('reserved reviewer key', async () => {
    await writeConfig({ ...CONFIG, reviewers: ['security', 'builder'] });
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  config.json: config: reviewer key 'builder' is reserved");
  });
});

describe('doctor: managed hashes (AC6)', () => {
  beforeEach(async () => {
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
    await writeFile(join(repo, '.claude', 'agents', 'builder.md'), 'builder');
    await writeFile(join(root, 'CONTRACT.md'), 'contract');
    await writeFile(join(root, 'cli.ts'), 'cli');
  });
  const files = () => ({
    '.claude/agents/builder.md': sha('builder'),
    'factory/CONTRACT.md': sha('contract'),
    'factory/cli.ts': sha('cli'),
  });

  test('all hashes match: exit 0, each file ok', async () => {
    await writeManifest(manifest(files()));
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      'ok    config.json',
      'ok    managed.json (version 1.0.0)',
      'ok    .claude/agents/builder.md',
      'ok    factory/CONTRACT.md',
      'ok    factory/cli.ts',
    ]);
  });

  test('one edited and one deleted: exit 1, both reported by path', async () => {
    await writeManifest(manifest(files()));
    await writeFile(join(root, 'CONTRACT.md'), 'contract, edited');
    await rm(join(root, 'cli.ts'));
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('ok    .claude/agents/builder.md');
    expect(r.out).toContain('FAIL  factory/CONTRACT.md: changed (sha256 mismatch)');
    expect(r.out).toContain('FAIL  factory/cli.ts: missing');
  });

  test('a bad config and a bad file are both reported', async () => {
    await writeManifest(manifest(files()));
    await rm(join(root, 'cli.ts'));
    await writeConfig({ ...CONFIG, maxRound: 0 });
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out.filter((l) => l.startsWith('FAIL')).length).toBe(2);
  });

  const malformed: [string, () => unknown][] = [
    ['not JSON', () => '{'],
    ['wrong schema', () => ({ ...manifest(files()), schema: 'factory/v2' })],
    ['missing version', () => ({ schema: 'factory/v1', files: files() })],
    ['unknown key', () => ({ ...manifest(files()), extra: true })],
    ['files not an object', () => ({ ...manifest({}), files: [] })],
    ['non-hex hash', () => manifest({ 'factory/cli.ts': 'z'.repeat(64) })],
    ['short hash', () => manifest({ 'factory/cli.ts': sha('cli').slice(1) })],
    ['uppercase hash', () => manifest({ 'factory/cli.ts': sha('cli').toUpperCase() })],
    ['absolute path', () => manifest({ [join(tmp, 'outside.txt')]: sha('secret') })],
    ['dot-dot path', () => manifest({ '../outside.txt': sha('secret') })],
    ['inner dot-dot path', () => manifest({ 'factory/../../outside.txt': sha('secret') })],
    ['backslash path', () => manifest({ '..\\outside.txt': sha('secret') })],
  ];
  for (const [name, m] of malformed) {
    test(`malformed manifest (${name}): exit 1, no file checks`, async () => {
      await writeManifest(m());
      const r = await doctor();
      expect(r.code).toBe(1);
      const fails = r.out.filter((l) => l.startsWith('FAIL'));
      expect(fails.length).toBe(1);
      expect(fails[0]).toStartWith('FAIL  managed.json: ');
      expect(r.out.filter((l) => l.startsWith('ok ')).length).toBe(1); // only config.json
    });
  }

  test('the absolute-path case would otherwise match, so the refusal is real', async () => {
    // Guard against a vacuous test: the outside file's hash is the one listed.
    await writeManifest(manifest({ [join(tmp, 'outside.txt')]: sha('secret') }));
    const r = await doctor();
    expect(r.out).toContain(`FAIL  managed.json: ${JSON.stringify(join(tmp, 'outside.txt'))}: path must be repo-relative, not absolute`);
  });

  test('a symlink that escapes the repo is refused', async () => {
    await symlink(join(tmp, 'outside.txt'), join(repo, 'escape.txt'));
    await writeManifest(manifest({ 'escape.txt': sha('secret') }));
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL  escape.txt: resolves outside the repo');
  });
});

describe('doctor: duplicate job numbers (AC6)', () => {
  const seed = async (...ids: string[]): Promise<void> => {
    for (const id of ids) await mkdir(join(root, 'jobs', id), { recursive: true });
  };

  test('a number held by two dirs is a note naming both, sorted, and doctor still exits 0', async () => {
    await seed('005-b', '005-a', '004-c');
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out).toContain('note: job number 005 is used by 005-a, 005-b');
    expect(r.out.filter((l) => l.includes('job number'))).toEqual(['note: job number 005 is used by 005-a, 005-b']);
  });

  test('each duplicated number gets its own note, in number order', async () => {
    await seed('007-z', '007-y', '007-x', '002-q', '002-p');
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.includes('job number'))).toEqual([
      'note: job number 002 is used by 002-p, 002-q',
      'note: job number 007 is used by 007-x, 007-y, 007-z',
    ]);
  });

  test('no duplicates, no jobs/, or stray entries: no such note', async () => {
    expect((await doctor()).out.some((l) => l.includes('job number'))).toBe(false);
    await seed('001-a', '002-b', '.claim.lock', 'notes');
    await writeFile(join(root, 'jobs', '001-file'), 'x');
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['ok    config.json', 'note  unstamped install: no managed.json, hash checks skipped']);
  });
});
