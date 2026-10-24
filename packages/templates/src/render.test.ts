import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '@factory/cli';
import { type Config, MODEL_PATTERN, parseConfig, parseManifest } from '@factory/contract';
import { TEMPLATES, type Templates, VERSION, cliStampLine, contractStampLine, fill, renderClaudeCode, splitFrontmatter, stamp, stampCli, stampContract } from './index';

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
  // Andon is the factory's own dashboard name (HANDOFF Decision 7): only the skill may name it.
  const ALLOWED_IN: Record<string, string[]> = { Andon: [SKILL], andon: [SKILL] };
  const FIXED = ['spec-writer', 'builder', 'approver'];

  test('no rendered file carries a project-specific detail', () => {
    for (const c of configs) {
      for (const [path, text] of Object.entries(renderClaudeCode({ config: c }).files)) {
        for (const word of BANNED) {
          if (ALLOWED_IN[word]?.includes(path)) continue;
          expect({ path, word, found: text.includes(word) }).toEqual({ path, word, found: false });
        }
      }
    }
  });

  test('only SKILL.md may name Andon; every other banned word stays out of SKILL.md too', () => {
    expect(Object.keys(ALLOWED_IN).sort()).toEqual(['Andon', 'andon']);
    for (const c of configs) {
      const { files } = renderClaudeCode({ config: c });
      for (const [path, text] of Object.entries(files)) {
        if (path === SKILL) continue;
        for (const word of ['Andon', 'andon']) expect({ path, word, found: text.includes(word) }).toEqual({ path, word, found: false });
      }
      const skill = at(files, SKILL);
      for (const word of BANNED.filter((w) => w !== 'Andon' && w !== 'andon')) {
        expect({ path: SKILL, word, found: skill.includes(word) }).toEqual({ path: SKILL, word, found: false });
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
      [agent('spec-writer')]: fill(TEMPLATES.specWriter, { role: 'spec-writer', model: 'opus' }, 't'),
      [agent('builder')]: fill(TEMPLATES.builder, { role: 'builder', model: 'opus' }, 't'),
      [agent('approver')]: fill(TEMPLATES.approver, { role: 'approver', model: 'opus' }, 't'),
      [agent('alpha')]: fill(TEMPLATES.reviewer, { key: 'alpha', model: 'opus' }, 't'),
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

describe('the overlay outcome rule', () => {
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1', 'theta'], gate: ['x'] })];
  // Collapses line breaks so assertions don't depend on where the prose wraps.
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  // The `## Project rules (overlay)` section, up to the next `## ` heading.
  const overlaySection = (text: string): string => {
    const start = text.indexOf('\n## Project rules (overlay)');
    if (start < 0) throw new Error('no ## Project rules (overlay) section');
    const end = text.indexOf('\n## ', start + 1);
    return flat(end < 0 ? text.slice(start) : text.slice(start, end));
  };
  // Every role document for a config: the fixed roles, then one per reviewer key.
  const roleDocs = (c: Config): Array<[string, string]> => [
    [agent('spec-writer'), 'spec-writer'],
    [agent('builder'), 'builder'],
    [agent('approver'), 'approver'],
    ...c.reviewers.map((key): [string, string] => [agent(key), key]),
  ];
  // The one file each role writes, where it notes an ignored overlay line.
  const ownFile = (role: string): string =>
    role === 'spec-writer' ? '`spec.md`' : role === 'builder' ? '`build.md`' : role === 'approver' ? '`decision.md`' : 'review';
  const note = (role: string): string => `\`factory/roles/${role}.md: "<the line>" breaks the overlay outcome rule; ignored.\``;

  test('AC1: every role document states the ratchet, the quick test, and ignore-and-note', () => {
    for (const c of configs) {
      const { files } = renderClaudeCode({ config: c });
      for (const [path, role] of roleDocs(c)) {
        const s = overlaySection(at(files, path));
        const has = (phrase: string): { path: string; phrase: string; stated: boolean } => ({ path, phrase, stated: s.includes(phrase) });
        for (const phrase of [
          'more focused or stricter',
          'more lenient about what you find',
          'does this line decide the outcome before looking, or throw away something already found?',
          'Ignore it',
          note(role),
          ownFile(role),
          'An ignored line never causes blocking or escalation.',
        ]) {
          expect(has(phrase)).toEqual({ path, phrase, stated: true });
        }
      }
    }
  });

  test('AC2: the reviewer honors narrowing, PASS early, and blocking, notes a lenient line as a [nit], and reviews without it', () => {
    for (const c of configs) {
      const { files } = renderClaudeCode({ config: c });
      for (const key of c.reviewers) {
        const s = overlaySection(at(files, agent(key)));
        for (const phrase of [
          'when you may PASS early',
          'narrow what you review',
          'make something blocking',
          'It never makes the review more lenient',
          'fixes the verdict',
          'drops, hides, or downgrades a finding',
          `report it as one \`[nit]\` finding: ${note(key)}`,
          'review as if it weren\'t there',
        ]) {
          expect({ key, phrase, stated: s.includes(phrase) }).toEqual({ key, phrase, stated: true });
        }
        expect(s).not.toContain('what makes a finding blocking');
      }
    }
  });

  test('AC3: every role document allows a downgrade or exemption only on a recorded human decision, with the finding still written', () => {
    for (const c of configs) {
      const { files } = renderClaudeCode({ config: c });
      for (const [path] of roleDocs(c)) {
        const s = overlaySection(at(files, path));
        for (const phrase of [
          'only when it cites a recorded human decision',
          'a brief\'s decision or contract call, or a decision record the project names, such as its deferred and known-gaps lists',
          'still written, marked as covered',
          '`[accepted: <the decision>]`',
        ]) {
          expect({ path, phrase, stated: s.includes(phrase) }).toEqual({ path, phrase, stated: true });
        }
      }
    }
  });

  test('AC4: the approver, builder, and spec-writer each ignore a lenient line and note it in their own file', () => {
    const { files } = renderClaudeCode({ config: config() });
    const approver = overlaySection(at(files, agent('approver')));
    for (const phrase of ['"always APPROVE"', 'removes a default escalation trigger', 'add a one-line note to `decision.md`', 'decide normally', 'never remove one']) {
      expect({ phrase, stated: approver.includes(phrase) }).toEqual({ phrase, stated: true });
    }
    const builder = overlaySection(at(files, agent('builder')));
    for (const phrase of ['Never skip or wave off a `[blocking]` finding because of an overlay line', 'note it in one line in `build.md`']) {
      expect({ phrase, stated: builder.includes(phrase) }).toEqual({ phrase, stated: true });
    }
    const specWriter = overlaySection(at(files, agent('spec-writer')));
    for (const phrase of ['note it in one line in `spec.md`, under **Constraints**', 'never under "Contract conflicts / open questions"']) {
      expect({ phrase, stated: specWriter.includes(phrase) }).toEqual({ phrase, stated: true });
    }
  });

  test('AC5: the skill\'s role-file refusal rule refuses a lenient line, names the rule, and offers the allowed form', () => {
    for (const c of configs) {
      const text = at(renderClaudeCode({ config: c }).files, SKILL);
      const start = text.indexOf('**Refusal rules.**');
      const end = text.indexOf('**Write.**', start);
      if (start < 0 || end < 0) throw new Error('no refusal rules');
      const rules = text.slice(start, end);
      // The role-file rule is the last bullet.
      const last = flat(rules.slice(rules.lastIndexOf('\n- ')));
      for (const phrase of [
        'never change which file an agent writes, its path, or its first line',
        'the overlay outcome rule',
        'more focused or stricter, never more lenient about what it finds',
        'decides the outcome before looking or throws away something already found',
        '"always PASS"',
        '"always APPROVE"',
        'name the overlay outcome rule',
        'offer the allowed form: cite a recorded human decision',
        'keep the finding visible',
      ]) {
        expect({ phrase, stated: last.includes(phrase) }).toEqual({ phrase, stated: true });
      }
    }
  });
});

describe('the customize interview in SKILL.md', () => {
  const skillOf = (c: Config = config()): string => at(renderClaudeCode({ config: c }).files, SKILL);
  // The `## Customize` section, up to the next `## ` heading.
  const section = (c: Config = config()): string => {
    const text = skillOf(c);
    const start = text.indexOf('\n## Customize');
    if (start < 0) throw new Error('no ## Customize section');
    const end = text.indexOf('\n## ', start + 1);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };
  // Collapses line breaks so assertions don't depend on where the prose wraps.
  const flat = (s: string): string => s.replace(/\s+/g, ' ');

  test('AC1: customize and its init alias are in the frontmatter and Commands', () => {
    const { frontmatter, body } = splitFrontmatter(skillOf());
    const hint = /^argument-hint: (.+)$/m.exec(frontmatter)?.[1] ?? '';
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? '';
    for (const word of ['customize', 'init']) {
      expect({ word, hint: hint.includes(word) }).toEqual({ word, hint: true });
      expect({ word, description: description.includes(word) }).toEqual({ word, description: true });
    }
    const commands = body.slice(body.indexOf('\n## Commands'), body.indexOf('\n## ', body.indexOf('\n## Commands') + 1));
    const entry = /\*\*`\/factory customize`\*\*[^\n]*(\n(?!\*\*`\/factory)[^\n]*)*/.exec(commands)?.[0] ?? '';
    expect(entry).not.toBe('');
    expect(flat(entry)).toContain('`/factory init`');
    expect(flat(entry)).toContain('alias');
  });

  test('AC1: the set of rendered paths is unchanged', () => {
    for (const reviewers of [['alpha', 'beta-2'], ['q'], ['zeta', 'eta-1', 'theta']]) {
      const { files } = renderClaudeCode({ config: config({ reviewers }) });
      const want = [SKILL, EXPLORE, agent('spec-writer'), agent('builder'), agent('approver'), ...reviewers.map(agent)];
      expect(Object.keys(files).sort()).toEqual(want.sort());
    }
  });

  test('AC2: it writes only the overlay and never managed files or runtime state', () => {
    const s = flat(section());
    expect(s).toContain('writes only `factory/config.json` and `factory/roles/<role>.md`');
    for (const path of ['`.claude/**`', '`factory/cli.ts`', '`factory/CONTRACT.md`', '`factory/managed.json`']) {
      expect({ path, named: s.includes(path) }).toEqual({ path, named: true });
    }
    for (const path of ['`factory/jobs/`', '`factory/.lock/`', '`factory/.worktrees/`']) {
      expect({ path, named: s.includes(path) }).toEqual({ path, named: true });
    }
    expect(s).toContain('never edits managed files');
    expect(s).toContain('runtime state');
  });

  test('AC2: it follows the explore discipline: homework, one question at a time, a recommended answer', () => {
    const s = flat(section());
    expect(s).toContain('homework');
    expect(s).toContain('one question at a time');
    expect(s).toContain('recommended answer');
    expect(s).toContain('Facts are yours to find; decisions are the user');
    for (const key of ['`reviewers`', '`maxRound`', '`dashboard.settleAfterHours`', '`gate`']) {
      expect({ key, covered: s.includes(key) }).toEqual({ key, covered: true });
    }
  });

  test('AC3: it states every refusal rule, checked before any write', () => {
    const s = flat(section());
    const rules = [
      'before anything is written',
      'No key outside v1',
      '`^[a-z][a-z0-9-]*$`',
      'unique',
      'at least one reviewer',
      'never a fixed role name (`spec-writer`, `builder`, `approver`)',
      '`maxRound` is a positive integer',
      '`dashboard.settleAfterHours` is a positive number',
      '`gate`, when present, is a non-empty array of non-empty command strings',
      'A role file exists only for a fixed role or a configured reviewer key',
      'never change which file an agent writes, its path, or its first line',
      'never tell an agent to write job state or edit managed files',
    ];
    for (const rule of rules) expect({ rule, stated: s.includes(rule) }).toEqual({ rule, stated: true });
  });

  test('AC4: it ends with doctor, restores config.json on FAIL, and leaves upgrade to the user', () => {
    const raw = section();
    const s = flat(raw);
    expect(s).toContain('`bun factory/cli.ts doctor`');
    expect(s).toContain('`FAIL` on `config.json`');
    expect(s).toContain('restore the bytes `config.json` had before the interview');
    expect(s).toContain('`factory upgrade` before the next job');
    expect(s).toContain('never run it yourself');
    expect(s).toContain('`round.started`');
    expect(s).toContain('chore(factory): customize overlay');
    expect(s).toContain('Co-Authored-By');
    expect(s).toContain('Never push');
    // doctor comes after the refusal rules and the writes
    expect(raw.lastIndexOf('bun factory/cli.ts doctor')).toBeGreaterThan(raw.indexOf('No key outside v1'));
    expect(raw.lastIndexOf('bun factory/cli.ts doctor')).toBeGreaterThan(raw.indexOf('**Write.**'));
  });

  test('roles: an interview step, refusal rules matching the parser, and no "not in v1" for models or runners', () => {
    const raw = section();
    const s = flat(raw);
    expect(raw).toMatch(/\n\d\. `roles` — /);
    expect(s).toContain('`dashboard` (only `settleAfterHours`), `gate`, `merge` (only `target`), and `roles`');
    expect(s).toContain('`roles`, when present, is an object');
    expect(s).toContain('a fixed role (`spec-writer`, `builder`, `approver`) or a configured reviewer key');
    expect(s).toContain('holds only `runner` and `model`');
    expect(s).toContain('`runner` is required and is `claude`');
    expect(s).toContain(`matching \`${MODEL_PATTERN.source}\``);
    expect(s).toContain('default model (`opus`)');
    expect(s).toContain('**When `reviewers` or `roles` changed.**');
    expect(s).not.toContain('per-role models or runners');
    expect(s).not.toMatch(/models? or runners?[^.]*not in v1/);
    expect(flat(skillOf())).toContain("Don't pass `model`");
  });

  test('AC5: the customize section stays neutral for several configs', () => {
    const BANNED = ['Minerva', 'Andon', 'andon', 'packages/', 'apps/', 'bun run test', 'bun run check', 'here:'];
    for (const reviewers of [['alpha', 'beta-2'], ['q'], ['zeta', 'eta-1', 'theta']]) {
      const s = section(config({ reviewers }));
      for (const word of BANNED) expect({ word, found: s.includes(word) }).toEqual({ word, found: false });
    }
  });

  test('AC5: every file except SKILL.md renders byte-identical to before this job', () => {
    // sha256 of each file rendered from config() on the base this job started from. Job 014
    // (configurable target branch) updated the builder, approver, and reviewer hashes: those
    // agents now diff against the card's `<base>` instead of a literal `main`. Job 015 (brief
    // done status) updated the EXPLORE hash: the brief format gains `done` and the `- Job:` line.
    // Job 020 (overlay outcome rule) updated every agent hash: each "Project rules (overlay)"
    // section gains the outcome rule.
    const before: Record<string, string> = {
      [EXPLORE]: 'f963a37517018fd21bfec5dd62c829fa0cc92d8edcd502b34bf4789cab97e528',
      [agent('spec-writer')]: 'e8595a8b596b936e369373677acac3c37e233de10fc6b7035b12fb5b5c29a0b1',
      [agent('builder')]: 'c89ce77e6e090651f57959b4e2a98a034176156c11d19b09a0f6e8106c56740f',
      [agent('approver')]: '4874e89a848fb9434b9379e6f0165d4b3c47d86943c9b9ed82d4293435e7edd3',
      [agent('alpha')]: 'dfe1cd9b59957007a63f3f4474d145d1ecc8e6a616db0236196fd065ef6c053d',
      [agent('beta-2')]: '8c6e2ba134bb732ef87f579b5822350108bb6553b4257674fb30a4f5a3618840',
    };
    const { files } = renderClaudeCode({ config: config() });
    const now: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) if (path !== SKILL) now[path] = sha(text);
    expect(now).toEqual(before);
  });
});

describe('the dashboard pointer in SKILL.md', () => {
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1', 'theta'], gate: ['x'] })];
  const OLD = ['serve.ts', 'dashboard.html', '8765', 'localhost:8765'];
  const OLD_LINE = 'Dashboard: `bun factory/serve.ts` → http://localhost:8765/dashboard.html';
  // The old v0 dashboard text a rendered skill still carries; empty when the pointer is current.
  const staleIn = (text: string): string[] => OLD.filter((word) => text.includes(word));
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const skillOf = (c: Config, templates = TEMPLATES): string => at(renderClaudeCode({ config: c, templates }).files, SKILL);

  test('AC1: the skill points to Andon: `bun run andon` in the factory clone, at http://127.0.0.1:8766/', () => {
    for (const c of configs) {
      const text = skillOf(c);
      expect(text).toContain('`bun run andon`');
      expect(text).toContain('http://127.0.0.1:8766/');
      expect(text).toContain('Andon');
      const pointer = text.split('\n').find((line) => line.includes('bun run andon')) ?? '';
      expect(flat(pointer)).toContain('in the factory clone');
      expect(pointer).toContain('http://127.0.0.1:8766/');
    }
  });

  test('AC2: the skill carries none of the old v0 dashboard text', () => {
    for (const c of configs) expect(staleIn(skillOf(c))).toEqual([]);
  });

  test('AC3: the check reports the old pointer when a template regresses to it', () => {
    const lines = TEMPLATES.skill.split('\n');
    const index = lines.findIndex((line) => line.includes('bun run andon'));
    expect(index).toBeGreaterThanOrEqual(0);
    const regressed = [...lines.slice(0, index), OLD_LINE, ...lines.slice(index + 1)].join('\n');
    expect(regressed).not.toBe(TEMPLATES.skill);
    expect(staleIn(skillOf(config(), { ...TEMPLATES, skill: regressed }))).toEqual(OLD);
  });
});

describe('per-role model from config.roles', () => {
  const modelOf = (text: string): string | undefined => /^model: (.+)$/m.exec(splitFrontmatter(text).frontmatter)?.[1];
  const AGENTS = [agent('spec-writer'), agent('builder'), agent('approver'), agent('alpha'), agent('beta-2')];

  test('AC3: without roles, every agent and explore renders byte-identical to before, still on model: opus', () => {
    // sha256 of each file rendered from config() on the base this job started from. SKILL.md is
    // excluded: its template text changes in this job (the customize interview covers roles).
    // Job 014 updated the builder, approver, and reviewer hashes (`<base>` instead of `main`).
    // Job 015 updated the EXPLORE hash (the brief format gains `done` and the `- Job:` line).
    // Job 020 updated every agent hash (the overlay outcome rule in "Project rules (overlay)").
    const before: Record<string, string> = {
      [EXPLORE]: 'f963a37517018fd21bfec5dd62c829fa0cc92d8edcd502b34bf4789cab97e528',
      [agent('spec-writer')]: 'e8595a8b596b936e369373677acac3c37e233de10fc6b7035b12fb5b5c29a0b1',
      [agent('builder')]: 'c89ce77e6e090651f57959b4e2a98a034176156c11d19b09a0f6e8106c56740f',
      [agent('approver')]: '4874e89a848fb9434b9379e6f0165d4b3c47d86943c9b9ed82d4293435e7edd3',
      [agent('alpha')]: 'dfe1cd9b59957007a63f3f4474d145d1ecc8e6a616db0236196fd065ef6c053d',
      [agent('beta-2')]: '8c6e2ba134bb732ef87f579b5822350108bb6553b4257674fb30a4f5a3618840',
    };
    for (const c of [config(), config({ roles: {} }), config({ roles: { builder: { runner: 'claude' } } })]) {
      const { files } = renderClaudeCode({ config: c });
      const now: Record<string, string> = {};
      for (const [path, text] of Object.entries(files)) if (path !== SKILL) now[path] = sha(text);
      expect(now).toEqual(before);
      for (const path of AGENTS) expect({ path, model: modelOf(at(files, path)) }).toEqual({ path, model: 'opus' });
    }
  });

  test('AC3: a configured model changes only that agent\'s frontmatter and manifest hash', () => {
    const plain = renderClaudeCode({ config: config() });
    const tuned = renderClaudeCode({
      config: config({ roles: { builder: { runner: 'claude', model: 'sonnet' }, 'beta-2': { runner: 'claude', model: 'sonnet' } } }),
    });
    const changed = [agent('builder'), agent('beta-2')];
    for (const path of Object.keys(plain.files)) {
      const a = at(plain.files, path);
      const b = at(tuned.files, path);
      if (changed.includes(path)) {
        expect(modelOf(b)).toBe('sonnet');
        expect(b).toBe(a.replace(/^model: opus$/m, 'model: sonnet'));
        expect(tuned.manifest.files[path]).not.toBe(plain.manifest.files[path]);
      } else {
        expect({ path, same: b === a }).toEqual({ path, same: true });
        expect(tuned.manifest.files[path]).toBe(plain.manifest.files[path]);
      }
      expect(tuned.manifest.files[path]).toBe(sha(b));
    }
  });

  test('refuses a hand-built config whose model would break the frontmatter', () => {
    const base = config();
    expect(() => renderClaudeCode({ config: { ...base, roles: { builder: { runner: 'claude', model: 'a\nb' } } } })).toThrow(/model/);
  });
});

describe('the target branch: no literal main', () => {
  const OVERLAY_ROLES = join(import.meta.dir, '..', 'overlays', 'factory', 'roles');
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  // `main` used as a branch name. "the main checkout" (the user's working tree) is not one.
  const BRANCH_MAIN: RegExp[] = [
    /\bmain\.\.\.HEAD\b/,
    /\bmain\.\.HEAD\b/,
    /\bshow main:/,
    /\bbase main\b/,
    /worktree add\b[^\n`]*\smain\b/,
    /merged? into `main`/,
    /`main`/,
  ];
  const mainsIn = (text: string): string[] => BRANCH_MAIN.filter((re) => re.test(text)).map((re) => re.source);
  const skillOf = (templates = TEMPLATES): string => at(renderClaudeCode({ config: config(), templates }).files, SKILL);

  test('AC6: no rendered file uses main as a branch', () => {
    for (const c of [config(), config({ reviewers: ['q'] }), config({ merge: { target: 'develop' } })]) {
      for (const [path, text] of Object.entries(renderClaudeCode({ config: c }).files)) {
        expect({ path, mains: mainsIn(text) }).toEqual({ path, mains: [] });
      }
    }
  });

  test('AC6: the default overlay role files diff and show against <base>, never main', async () => {
    for (const role of ['ui', 'contract']) {
      const text = await readFile(join(OVERLAY_ROLES, `${role}.md`), 'utf8');
      expect({ role, mains: mainsIn(text) }).toEqual({ role, mains: [] });
      expect(text).toContain('<base>');
    }
    const ui = await readFile(join(OVERLAY_ROLES, 'ui.md'), 'utf8');
    expect(ui).toContain('git -C <worktree> diff <base>...HEAD --stat');
    const contract = await readFile(join(OVERLAY_ROLES, 'contract.md'), 'utf8');
    expect(contract).toContain('git -C <worktree> show <base>:<path>');
  });

  test('AC6: the agents read <base> from the card', () => {
    const { files } = renderClaudeCode({ config: config() });
    for (const path of [agent('approver'), agent('alpha'), agent('beta-2')]) {
      const text = at(files, path);
      expect(text).toContain('git -C <worktree> diff <base>...HEAD');
      expect(text).toContain('<base>..HEAD');
      expect(text).toContain('`base:` line on your card');
    }
    const builder = flat(at(files, agent('builder')));
    expect(builder).toContain('`base:` line on your card');
    expect(builder).toContain('never check out or commit to `<base>`');
  });

  test('AC6: the spawn card carries base: <target>, and the worktree is added from <target>', () => {
    const text = skillOf();
    expect(text).toMatch(/^base: +<target>$/m);
    expect(text).toContain('worktree: <R>/factory/.worktrees/<id>   (branch factory/<id>)\n');
    expect(text).toContain("`git worktree add -b factory/<id> factory/.worktrees/<id> '<target>'`");
  });

  test('AC6: the merge step states the precondition, the merge.failed record, no checkout, and the null fallback', () => {
    const text = skillOf();
    const start = text.indexOf('\n## Merge');
    const merge = flat(text.slice(start, text.indexOf('\n## ', start + 1)));
    expect(merge).toContain("must be on the job's `<target>`");
    expect(merge).toContain('`git symbolic-ref --short HEAD`');
    expect(merge).toContain("`merge.failed reason='checkout is on <x>, job targets <target>'`");
    expect(merge).toContain('Never run `git checkout`');
    expect(merge).toContain('/factory approve <id>');
    expect(merge).toContain("merge conflict with <target>");
    expect(merge).toContain('If `<target>` had moved past the branch');
    expect(merge).toContain('every job leaves `<target>` clean');
    // the precondition comes before the git merge
    expect(merge.indexOf('checkout is on <x>')).toBeLessThan(merge.indexOf('git merge --no-ff'));

    const s = flat(text);
    expect(s).toContain('`target` in its `job.json`');
    expect(s).toContain('If `target` is `null`');
    expect(s).toContain('resolve it whenever you need it from the current config');
    expect(s).toContain('`git symbolic-ref --short HEAD` in `<R>`');
  });

  test('AC6: the customize interview and its refusal rules cover merge.target', () => {
    const s = flat(skillOf());
    expect(s).toContain('`merge.target` — the branch jobs are based on and merge into');
    expect(s).toContain('`merge` (only `target`)');
    expect(s).toContain('`merge`, when present, is an object holding only `target`');
    expect(s).toContain('A branch literally named `current` can\'t be targeted');
    expect(s).toContain('a branch matching `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, with no `..` and no `.lock` suffix');
    expect(s).toContain('accepts only a plain branch name');
  });

  test('AC6: the check fails on the old text', () => {
    const OLD: Array<[keyof Templates, string]> = [
      ['skill', 'worktree: <R>/factory/.worktrees/<id>   (branch factory/<id>, base main)'],
      ['skill', '`git worktree add -b factory/<id> factory/.worktrees/<id> main`'],
      ['skill', 'Each job is merged into `main`.'],
      ['reviewer', '- The diff: `git -C <worktree> diff main...HEAD` (and `--stat`), `git -C <worktree> log main..HEAD --oneline`,'],
      ['approver', 'You are the **approver** in the factory: the last gate before `main`.'],
      ['builder', '  check out or commit to `main`, never merge, never push.'],
    ];
    for (const [name, line] of OLD) {
      const regressed: Templates = { ...TEMPLATES, [name]: `${TEMPLATES[name]}\n${line}\n` };
      const files = Object.values(renderClaudeCode({ config: config(), templates: regressed }).files);
      expect({ name, line, caught: files.some((t) => mainsIn(t).length > 0) }).toEqual({ name, line, caught: true });
    }
    expect(mainsIn('`git -C <worktree> show main:docs/x.md`')).not.toEqual([]);
    expect(mainsIn('the main checkout stays put')).toEqual([]);
  });
});

describe('marking a brief done when its job merges (job 015)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1', 'theta'], merge: { target: 'develop' } })];
  const render = (c: Config = config(), templates: Readonly<Templates> = TEMPLATES): Record<string, string> =>
    renderClaudeCode({ config: c, templates }).files;
  // The `## <name>` section of a rendered file, up to the next `## ` heading, flattened.
  const sectionOf = (text: string, name: string): string => {
    const start = text.indexOf(`\n## ${name}`);
    if (start < 0) throw new Error(`no ## ${name} section`);
    const end = text.indexOf('\n## ', start + 1);
    return flat(end < 0 ? text.slice(start) : text.slice(start, end));
  };
  const mergeOf = (files: Record<string, string>): string => sectionOf(at(files, SKILL), 'Merge');
  // The `/factory <feature>` entry in Commands, flattened.
  const claimOf = (files: Record<string, string>): string => {
    const commands = sectionOf(at(files, SKILL), 'Commands');
    const start = commands.indexOf('**`/factory <feature>`**');
    if (start < 0) throw new Error('no /factory <feature> entry');
    const end = commands.indexOf('**`/factory ', start + 1);
    return end < 0 ? commands.slice(start) : commands.slice(start, end);
  };
  const JOB_LINE = '- Job: <id> (merged <short sha>, <YYYY-MM-DD>)';
  const BOTH_PATHS = '-- factory/backlog.md factory/briefs/<slug>.md';
  // What the Merge bookkeeping must say; returns what's missing (empty when the text is current).
  const bookkeepingGaps = (merge: string): string[] =>
    [
      'When `job.json` has a non-null `brief`',
      "set that brief's `Status:` line to `done`",
      `add \`${JOB_LINE}\` right below it`,
      '"chore(factory): record job <id>"',
      BOTH_PATHS,
      'With no brief, commit the backlog only',
      'nothing changed → skip',
    ].filter((want) => !merge.includes(want));
  // The bookkeeping bullet as it read on the base this job started from.
  const OLD_BOOKKEEPING = [
    '- Then **bookkeeping**, so every job leaves `<target>` clean: commit just the backlog tick, by',
    '  pathspec, so nothing else of the user\'s gets swept in: `git commit -m "chore(factory): record',
    '  job <id>" -m "Co-Authored-By: Claude <noreply@anthropic.com>" -- factory/backlog.md`',
    '  (nothing changed → skip).',
  ].join('\n');

  test('AC1: the Merge bookkeeping marks the brief done and commits it with the backlog', () => {
    for (const c of configs) {
      const merge = mergeOf(render(c));
      expect(bookkeepingGaps(merge)).toEqual([]);
      expect(merge).toContain(`-- factory/backlog.md\``);
      // the brief is marked after job.merged is logged, and before the lock is released
      expect(merge.indexOf('`job.merged sha=<short sha>`')).toBeLessThan(merge.indexOf(JOB_LINE));
      expect(merge.indexOf(BOTH_PATHS)).toBeLessThan(merge.indexOf('Release the lock'));
      expect(merge).toContain('the `<short sha>` you passed to `job.merged`');
    }
  });

  test('AC2: the check fails on the base text (backlog-only pathspec) and passes on the new', () => {
    const lines = TEMPLATES.skill.split('\n');
    const first = lines.findIndex((line) => line.startsWith('- Then **bookkeeping**'));
    expect(first).toBeGreaterThanOrEqual(0);
    const last = lines.findIndex((line, i) => i > first && line.startsWith('- '));
    expect(last).toBeGreaterThan(first);
    const regressed = [...lines.slice(0, first), OLD_BOOKKEEPING, ...lines.slice(last)].join('\n');
    expect(regressed).not.toBe(TEMPLATES.skill);
    const old = mergeOf(render(config(), { ...TEMPLATES, skill: regressed }));
    expect(old).toContain('-- factory/backlog.md` (nothing changed → skip)');
    expect(bookkeepingGaps(old)).toContain(BOTH_PATHS);
    expect(bookkeepingGaps(mergeOf(render()))).toEqual([]);
  });

  test('AC3: claim refuses a done brief with its own message, and the draft refusal stays separate', () => {
    for (const c of configs) {
      const claim = claimOf(render(c));
      expect(claim).toContain('`brief <slug> is done (job <id>)`');
      expect(claim).toContain('a draft brief means the interview isn\'t done, so stop before claiming and say so');
      const done = claim.indexOf('is `done`');
      expect(done).toBeGreaterThanOrEqual(0);
      expect(claim.slice(done)).toContain('stop before claiming');
      // separate rules: the done refusal and the draft refusal are different sentences
      const sentences = claim.split(/(?<=\.) /);
      const doneRule = sentences.find((s) => s.includes('is done (job <id>)')) ?? '';
      const draftRule = sentences.find((s) => s.includes('a draft brief')) ?? '';
      expect(doneRule).not.toBe('');
      expect(draftRule).not.toBe('');
      expect(doneRule).not.toBe(draftRule);
      expect(draftRule).not.toContain('done (job');
    }
  });

  test('AC4: the brief format shows draft | ready | done and the Job: line only the merge writes', () => {
    for (const c of configs) {
      const text = at(render(c), EXPLORE);
      expect(text).toContain('- Status: draft | ready | done\n');
      expect(text).toContain(`${JOB_LINE}`);
      const format = text.slice(text.indexOf('```\n# <Title>'), text.indexOf('```', text.indexOf('```\n# <Title>') + 3));
      expect(format).toContain('- Status: draft | ready | done');
      expect(format).toContain(JOB_LINE);
      expect(format.indexOf('- Status:')).toBeLessThan(format.indexOf('- Job:'));
      expect(flat(text)).toContain('Only the factory\'s Merge step writes the `- Job:` line');
    }
  });

  test('AC5: an existing done brief is not reopened: name the job, offer a new brief citing it', () => {
    for (const c of configs) {
      const start = sectionOf(at(render(c), EXPLORE), 'Start');
      expect(start).toContain('If its `Status:` is `done`, don\'t reopen it');
      expect(start).toContain('name the job that carried it out');
      expect(start).toContain('offer a new brief that lists the old one under `Sources:`');
    }
  });

  test('AC6: SKILL.md and explore.md stay neutral and fully filled for several configs', () => {
    const BANNED = ['Minerva', 'Andon', 'andon', 'packages/', 'apps/', 'bun run test', 'bun run check'];
    for (const c of configs) {
      const files = render(c);
      const touched = [mergeOf(files), claimOf(files), flat(at(files, EXPLORE))];
      for (const s of touched) {
        for (const word of BANNED) expect({ word, found: s.includes(word) }).toEqual({ word, found: false });
        expect(s).not.toMatch(/\{\{[^}]*\}\}/);
      }
    }
  });
});
