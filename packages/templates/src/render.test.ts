import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '@factory/cli';
import { type Config, parseConfig, parseManifest } from '@factory/contract';
import { TEMPLATES, VERSION, cliStampLine, contractStampLine, fill, renderClaudeCode, splitFrontmatter, stamp, stampCli, stampContract } from './index';

const config = (extra: Record<string, unknown> = {}): Config =>
  parseConfig({ schema: 'factory/v1', reviewers: ['alpha', 'beta-2'], maxRound: 2, dashboard: { settleAfterHours: 24 }, ...extra });

const SKILL = '.claude/skills/factory/SKILL.md';
const EXPLORE = '.claude/skills/factory/explore.md';
const agent = (name: string): string => `.claude/agents/factory-${name}.md`;
const ROLE_DOCS: Record<string, string> = {
  [agent('spec-writer')]: 'spec-writer',
  [agent('builder')]: 'builder',
  [agent('approver')]: 'approver',
  [agent('alpha')]: 'alpha',
  [agent('beta-2')]: 'beta-2',
};
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const at = (files: Record<string, string>, path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`not rendered: ${path}`);
  return text;
};
const frontmatterName = (text: string): string | undefined => /^name: (.+)$/m.exec(splitFrontmatter(text).frontmatter)?.[1];

describe('renderClaudeCode (AC1)', () => {
  test('renders exactly the skill, explore, fixed roles, and one agent per reviewer key', () => {
    const { files } = renderClaudeCode({ config: config() });
    expect(Object.keys(files).sort()).toEqual(
      [SKILL, EXPLORE, agent('spec-writer'), agent('builder'), agent('approver'), agent('alpha'), agent('beta-2')].sort(),
    );
  });

  test('each reviewer file is named factory-<key> and names its review and overlay paths', () => {
    const { files } = renderClaudeCode({ config: config() });
    for (const key of ['alpha', 'beta-2']) {
      const text = at(files, agent(key));
      expect(frontmatterName(text)).toBe(`factory-${key}`);
      expect(text).toContain(`round-<N>/review-${key}.md`);
      expect(text).toContain(`factory/roles/${key}.md`);
    }
    expect(frontmatterName(at(files, agent('builder')))).toBe('factory-builder');
  });

  test('is deterministic: the same config gives identical bytes and manifest', () => {
    const a = renderClaudeCode({ config: config() });
    const b = renderClaudeCode({ config: config() });
    expect(b).toEqual(a);
    expect(JSON.stringify(b.manifest)).toBe(JSON.stringify(a.manifest));
  });

  test('does not depend on the gate: gate is read at run time', () => {
    expect(renderClaudeCode({ config: config({ gate: ['make test'] }) })).toEqual(renderClaudeCode({ config: config() }));
  });

  test('refuses a hand-built config with a bad or reserved reviewer key', () => {
    const base = config();
    expect(() => renderClaudeCode({ config: { ...base, reviewers: ['../x'] } })).toThrow(/bad reviewer key/);
    expect(() => renderClaudeCode({ config: { ...base, reviewers: ['builder'] } })).toThrow(/reserved/);
  });
});

describe('neutrality and placeholders (AC2)', () => {
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1', 'theta'], gate: ['x'] })];
  const BANNED = ['Minerva', 'Andon', 'andon', 'packages/', 'apps/', 'bun run test', 'bun run check', 'here:'];
  const FIXED = ['spec-writer', 'builder', 'approver'];

  test('no rendered file carries a project-specific detail', () => {
    for (const c of configs) {
      for (const [path, text] of Object.entries(renderClaudeCode({ config: c }).files)) {
        for (const word of BANNED) expect({ path, word, found: text.includes(word) }).toEqual({ path, word, found: false });
      }
    }
  });

  test('no rendered file names a reviewer key outside the config', () => {
    for (const c of configs) {
      const allowed = [...FIXED, ...c.reviewers];
      for (const [path, text] of Object.entries(renderClaudeCode({ config: c }).files)) {
        const named = [
          ...text.matchAll(/factory-([a-z][a-z0-9-]*)/g),
          ...text.matchAll(/review-([a-z][a-z0-9-]*)\.md/g),
          ...text.matchAll(/factory\/roles\/([a-z][a-z0-9-]*)\.md/g),
          ...text.matchAll(/key=([a-z][a-z0-9-]*)/g),
        ].map((m) => m[1]);
        for (const k of named) expect({ path, key: k, allowed: k !== undefined && allowed.includes(k) }).toEqual({ path, key: k, allowed: true });
      }
    }
  });

  test('no rendered file names the vendored reviewers', () => {
    for (const [path, text] of Object.entries(renderClaudeCode({ config: config() }).files)) {
      for (const k of ['security', 'contract', 'code', 'ui']) {
        expect({ path, k, found: new RegExp(`(factory-|review-|roles/)${k}\\b`).test(text) }).toEqual({ path, k, found: false });
      }
    }
  });

  test('no leftover placeholder in any rendered file', () => {
    for (const text of Object.values(renderClaudeCode({ config: config() }).files)) {
      expect(text).not.toMatch(/\{\{|\}\}/);
    }
  });

  test('an unknown placeholder makes render throw', () => {
    expect(() => renderClaudeCode({ config: config(), templates: { ...TEMPLATES, builder: 'hi {{nope}}' } })).toThrow(/unknown placeholder \{\{nope\}\}/);
    expect(() => renderClaudeCode({ config: config(), templates: { ...TEMPLATES, skill: 'uses {{role}}' } })).toThrow(/unknown placeholder/);
  });

  test('fill throws on leftover or malformed placeholder syntax', () => {
    expect(fill('a {{x}} b', { x: '1' }, 't')).toBe('a 1 b');
    expect(() => fill('a {{x} b', { x: '1' }, 't')).toThrow(/unfilled/);
    expect(() => fill('a {{ {{x}} }}', { x: '1' }, 't')).toThrow(/unfilled/);
    expect(() => fill('{{toString}}', {}, 't')).toThrow(/unknown placeholder/);
  });
});

describe('overlay hook and gate (AC3)', () => {
  const { files } = renderClaudeCode({ config: config() });

  test('every role document reads its overlay when present, and a missing one is fine', () => {
    for (const [path, role] of Object.entries(ROLE_DOCS)) {
      const text = at(files, path);
      expect({ path, hook: text.includes(`Read \`<repo>/factory/roles/${role}.md\` if it exists`) }).toEqual({ path, hook: true });
      expect({ path, binding: text.includes('binding rules') }).toEqual({ path, binding: true });
      expect({ path, missingOk: text.includes('A missing file is normal, not an error') }).toEqual({ path, missingOk: true });
    }
  });

  test('a reviewer with no overlay reviews against spec.md for correctness and test coverage', () => {
    expect(at(files, agent('alpha'))).toContain('review the diff against `spec.md` for\ncorrectness and test coverage');
  });

  test('builder, approver, reviewers, and the post-merge check use the gate in factory/config.json', () => {
    for (const path of [agent('builder'), agent('approver'), agent('alpha'), agent('beta-2'), SKILL]) {
      const text = at(files, path);
      expect({ path, gate: text.includes('`gate` in `<R>/factory/config.json`') || text.includes('`gate` in `<repo>/factory/config.json`') }).toEqual({ path, gate: true });
      expect({ path, none: text.includes('no gate is configured') }).toEqual({ path, none: true });
      expect({ path, noInvent: text.includes('never invent') }).toEqual({ path, noInvent: true });
    }
    expect(at(files, SKILL)).toContain('**Post-merge check.**');
  });

  test('the skill defers reviewer keys to config and keeps the delivery and verdict rules', () => {
    const text = at(files, SKILL);
    expect(text).toContain('`reviewers` in `<R>/factory/config.json`');
    expect(text).toContain('deliver:  create the write: file with the Write tool.');
    for (const line of ['VERDICT: PASS', 'VERDICT: CHANGES', '`APPROVE`', '`ESCALATE`']) expect(text).toContain(line);
    expect(text).toContain('name=builder-<id>');
  });
});

describe('stamp (AC6)', () => {
  const { files } = renderClaudeCode({ config: config() });

  test('frontmatter files keep their frontmatter; the stamp follows it once', () => {
    const originals: Record<string, string> = {
      [SKILL]: TEMPLATES.skill,
      [agent('spec-writer')]: fill(TEMPLATES.specWriter, { role: 'spec-writer' }, 't'),
      [agent('builder')]: fill(TEMPLATES.builder, { role: 'builder' }, 't'),
      [agent('approver')]: fill(TEMPLATES.approver, { role: 'approver' }, 't'),
      [agent('alpha')]: fill(TEMPLATES.reviewer, { key: 'alpha' }, 't'),
    };
    for (const [path, original] of Object.entries(originals)) {
      const text = at(files, path);
      expect(text.startsWith('---\n')).toBe(true);
      const want = splitFrontmatter(original);
      const got = splitFrontmatter(text);
      expect(got.frontmatter).toBe(want.frontmatter);
      expect(got.frontmatter.length).toBeGreaterThan(0);
      const [first, ...rest] = got.body.split('\n');
      expect(first).toMatch(/^<!-- .* -->$/);
      expect(rest.join('\n')).toBe(want.body);
    }
  });

  test('a file without frontmatter starts with the stamp', () => {
    const text = at(files, EXPLORE);
    expect(text.split('\n')[0]).toMatch(/^<!-- .* -->$/);
    expect(text.slice(text.indexOf('\n') + 1)).toBe(TEMPLATES.explore);
  });

  test('the stamp appears once and names the version, managed, do not edit, and the overlay', () => {
    for (const [path, text] of Object.entries(files)) {
      const stamps = text.match(/<!-- factory .* -->/g) ?? [];
      expect({ path, count: stamps.length }).toEqual({ path, count: 1 });
      const line = stamps[0] ?? '';
      expect(line).toContain(VERSION);
      expect(line).toContain('managed');
      expect(line).toContain('do not edit');
      const role = ROLE_DOCS[path];
      expect(line).toContain(role === undefined ? 'factory/roles/' : `factory/roles/${role}.md`);
    }
  });

  test('stamp places the comment after frontmatter, or first', () => {
    expect(stamp('---\na: 1\n---\nbody\n', 'o').split('\n').slice(0, 4)).toEqual(['---', 'a: 1', '---', expect.stringMatching(/^<!-- .*o -->$/)]);
    expect(stamp('# Title\n', 'o')).toMatch(/^<!-- .* -->\n# Title\n$/);
    expect(() => stamp('---\nunterminated\n', 'o')).toThrow(/closing/);
  });
});

describe('version and manifest (AC5)', () => {
  test('VERSION is package.json version, 0.1.0', async () => {
    const pkg: unknown = JSON.parse(await readFile(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined).toBe(VERSION);
    expect(VERSION).toBe('0.1.0');
  });

  test('the manifest parses and hashes each file\'s UTF-8 bytes', () => {
    const { files, manifest } = renderClaudeCode({ config: config() });
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.schema).toBe('factory/v1');
    expect(parsed.version).toBe(VERSION);
    expect(Object.keys(parsed.files)).toEqual(Object.keys(files));
    for (const [path, text] of Object.entries(files)) {
      expect(parsed.files[path]).toBe(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
      expect(parsed.files[path]).toBe(sha(text));
    }
  });

  describe('doctor on a rendered install', () => {
    let repo: string;
    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'factory-templates-'));
    });
    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    async function doctor(): Promise<{ code: number; out: string[] }> {
      const out: string[] = [];
      const code = await run(['doctor'], { root: join(repo, 'factory'), stdout: (l) => out.push(l), stderr: (l) => out.push(l) });
      return { code, out };
    }

    test('exits 0 when pristine, and 1 naming the path when a rendered file is edited', async () => {
      const raw = { schema: 'factory/v1', reviewers: ['alpha', 'beta-2'], maxRound: 2, dashboard: { settleAfterHours: 24 }, gate: ['bun test'] };
      const { files, manifest } = renderClaudeCode({ config: parseConfig(raw) });
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), text);
      }
      await mkdir(join(repo, 'factory'), { recursive: true });
      await writeFile(join(repo, 'factory', 'config.json'), JSON.stringify(raw));
      await writeFile(join(repo, 'factory', 'managed.json'), JSON.stringify(manifest, null, 2));

      const clean = await doctor();
      expect(clean.code).toBe(0);
      expect(clean.out).toContain('ok    config.json');
      expect(clean.out).toContain(`ok    managed.json (version ${VERSION})`);
      for (const path of Object.keys(files)) expect(clean.out).toContain(`ok    ${path}`);

      const edited = agent('builder');
      await writeFile(join(repo, edited), `${at(files, edited)}\nlocal tweak\n`);
      const dirty = await doctor();
      expect(dirty.code).toBe(1);
      expect(dirty.out).toContain(`FAIL  ${edited}: changed (sha256 mismatch)`);
      expect(dirty.out.filter((l) => l.startsWith('FAIL'))).toEqual([`FAIL  ${edited}: changed (sha256 mismatch)`]);
    });
  });
});

describe('CLI and contract stamps', () => {
  test('the CLI stamp is a first-line // comment naming VERSION, and drops the @bun pragma', () => {
    const out = stampCli('// @bun\nconsole.log(1);\n');
    expect(out.split('\n')[0]).toBe(cliStampLine());
    expect(cliStampLine()).toStartWith(`// factory ${VERSION} `);
    expect(out).toBe(`${cliStampLine()}\nconsole.log(1);\n`);
    expect(stampCli('x\n')).toBe(`${cliStampLine()}\nx\n`);
  });

  test('the contract stamp is a first-line HTML comment naming VERSION', () => {
    const out = stampContract('# Contract\n');
    expect(out).toBe(`${contractStampLine()}\n# Contract\n`);
    expect(contractStampLine()).toMatch(new RegExp(`^<!-- factory ${VERSION.replaceAll('.', '\\.')} .* -->$`));
    expect(contractStampLine()).toContain('do not edit');
  });
});
