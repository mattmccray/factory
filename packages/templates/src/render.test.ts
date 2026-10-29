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
// Whether `text` mentions a banned word. Andon (the dashboard's name) counts only as a word of its
// own, never inside another word: "abandon" (the `/factory abandon` command, a brief's
// `- Abandoned:` line) is not a mention of Andon. Every other word is a plain substring.
const mentions = (text: string, word: string): boolean =>
  word === 'Andon' || word === 'andon' ? new RegExp(`(?<![A-Za-z])${word}`).test(text) : text.includes(word);
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
  // Andon is the factory's own dashboard name (decision 7 of `docs/decisions.md`): only the skill may name it.
  const ALLOWED_IN: Record<string, string[]> = { Andon: [SKILL], andon: [SKILL] };
  const FIXED = ['spec-writer', 'builder', 'approver'];

  test('no rendered file carries a project-specific detail', () => {
    for (const c of configs) {
      for (const [path, text] of Object.entries(renderClaudeCode({ config: c }).files)) {
        for (const word of BANNED) {
          if (ALLOWED_IN[word]?.includes(path)) continue;
          expect({ path, word, found: mentions(text, word) }).toEqual({ path, word, found: false });
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
        for (const word of ['Andon', 'andon']) expect({ path, word, found: mentions(text, word) }).toEqual({ path, word, found: false });
      }
      const skill = at(files, SKILL);
      for (const word of BANNED.filter((w) => w !== 'Andon' && w !== 'andon')) {
        expect({ path: SKILL, word, found: skill.includes(word) }).toEqual({ path: SKILL, word, found: false });
      }
    }
  });

  test('the Andon check still catches the dashboard name, and not the word abandon', () => {
    for (const hit of ['open Andon', 'bun run andon:service', '~/.andon', 'Andon.']) {
      expect({ hit, found: mentions(hit, 'Andon') || mentions(hit, 'andon') }).toEqual({ hit, found: true });
    }
    for (const miss of ['/factory abandon', '- Abandoned: 004-x (2026-10-28): why', 'abandoned']) {
      expect({ miss, found: mentions(miss, 'Andon') || mentions(miss, 'andon') }).toEqual({ miss, found: false });
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
    expect(s).toContain('`dashboard` (only `settleAfterHours`), `gate`, `merge` (only `target`), `archive` (only `enabled`), and `roles`');
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

  test('name: the first interview question, a refusal rule matching the parser, written first after schema', () => {
    const raw = section();
    const s = flat(raw);
    const questions = [...raw.matchAll(/\n(\d)\. `([^`]+)` — /g)].map((m) => `${m[1]}:${m[2]}`);
    expect(questions[0]).toBe('1:name');
    expect(questions.slice(1, 3)).toEqual(['2:reviewers', '3:maxRound']);
    const first = flat(raw.slice(raw.indexOf('\n1. `name`'), raw.indexOf('\n2. ')));
    expect(first).toContain('current resolved name');
    expect(first).toContain('Recommend leaving it unset when the folder name is right');
    expect(s).toContain('holds only `schema` (`"factory/v1"`), `name`, `reviewers`,');
    expect(s).toContain(
      '`name`, when present, is a string of 1–64 characters (Unicode code points) with no leading or trailing whitespace and no control characters',
    );
    const write = flat(raw.slice(raw.indexOf('**Write.**'), raw.indexOf('**Doctor last.**')));
    expect(write).toContain('`schema` first, then `name` first among the keys after `schema`');
  });

  test('AC5: the customize section stays neutral for several configs', () => {
    const BANNED = ['Minerva', 'Andon', 'andon', 'packages/', 'apps/', 'bun run test', 'bun run check', 'here:'];
    for (const reviewers of [['alpha', 'beta-2'], ['q'], ['zeta', 'eta-1', 'theta']]) {
      const s = section(config({ reviewers }));
      for (const word of BANNED) expect({ word, found: mentions(s, word) }).toEqual({ word, found: false });
    }
  });

  test('AC5: every file except SKILL.md renders byte-identical to before this job', () => {
    // sha256 of each file rendered from config() on the base this job started from. Job 014
    // (configurable target branch) updated the builder, approver, and reviewer hashes: those
    // agents now diff against the card's `<base>` instead of a literal `main`. Job 015 (brief
    // done status) updated the EXPLORE hash: the brief format gains `done` and the `- Job:` line.
    // Job 020 (overlay outcome rule) updated every agent hash: each "Project rules (overlay)"
    // section gains the outcome rule. Job 044 (backlog holds only open work) updated the EXPLORE
    // hash: Finish takes the lock, resume shows abandoned attempts, the format gains `- Abandoned:`.
    // Job 051 (merge conflicts go back to the builder) updated the builder and approver hashes: the
    // builder gains "A conflict note", and both read any `conflict-*.md`.
    const before: Record<string, string> = {
      [EXPLORE]: '2d992ad3faa61e1b5225005e61fd0ce648580491942c468a2f260d9f4afa6625',
      [agent('spec-writer')]: 'e8595a8b596b936e369373677acac3c37e233de10fc6b7035b12fb5b5c29a0b1',
      [agent('builder')]: '44767f8cd0a0d6893403c8375fb0b4301590df53fea4aa02e6281e612802833f',
      [agent('approver')]: '14d08440888b6d077f6a429def65cfd0cd9d5d964392feca3fea44d5cf2421f9',
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

  test('AC1: the skill points to the Andon service: `bun run andon:service` in the factory clone, at http://127.0.0.1:8766/', () => {
    for (const c of configs) {
      const text = skillOf(c);
      expect(text).toContain('`bun run andon:service`');
      expect(text).toContain('http://127.0.0.1:8766/');
      expect(text).toContain('Andon');
      const pointer = text.split('\n').find((line) => line.includes('bun run andon:service')) ?? '';
      expect(flat(pointer)).toContain('one service per machine');
      expect(flat(pointer)).toContain('in the factory clone');
      expect(flat(pointer)).toContain('(not in this project)');
      expect(pointer).toContain('http://127.0.0.1:8766/');
      expect(pointer).not.toMatch(/\bagent\b/);
    }
  });

  test('AC2: the skill carries none of the old v0 dashboard text', () => {
    for (const c of configs) expect(staleIn(skillOf(c))).toEqual([]);
  });

  test('AC3: the check reports the old pointer when a template regresses to it', () => {
    const lines = TEMPLATES.skill.split('\n');
    const index = lines.findIndex((line) => line.includes('bun run andon:service'));
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
    // Job 044 updated the EXPLORE hash (Finish under the lock, abandoned attempts, `- Abandoned:`).
    // Job 051 updated the builder and approver hashes (a conflict note, and `conflict-*.md` reads).
    const before: Record<string, string> = {
      [EXPLORE]: '2d992ad3faa61e1b5225005e61fd0ce648580491942c468a2f260d9f4afa6625',
      [agent('spec-writer')]: 'e8595a8b596b936e369373677acac3c37e233de10fc6b7035b12fb5b5c29a0b1',
      [agent('builder')]: '44767f8cd0a0d6893403c8375fb0b4301590df53fea4aa02e6281e612802833f',
      [agent('approver')]: '14d08440888b6d077f6a429def65cfd0cd9d5d964392feca3fea44d5cf2421f9',
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
    expect(ui).not.toContain('dashboard.html');
    expect(ui).not.toContain('v0 dashboard');
    expect(flat(ui)).toContain('current Andon UI (`apps/andon-ui/`) on `<base>`');
    const contract = await readFile(join(OVERLAY_ROLES, 'contract.md'), 'utf8');
    expect(contract).toContain('git -C <worktree> show <base>:<path>');
  });

  // The retired handoff file's name, built so `git grep` over packages/ finds no stale citation.
  const RETIRED = ['HAND', 'OFF'].join('');

  test('the default overlay role drafts cite docs/decisions.md, never the retired handoff file', async () => {
    for (const role of ['approver', 'spec-writer', 'contract', 'ui']) {
      const text = await readFile(join(OVERLAY_ROLES, `${role}.md`), 'utf8');
      expect({ role, handoff: text.includes(RETIRED) }).toEqual({ role, handoff: false });
      expect({ role, cites: text.includes('`docs/decisions.md`') }).toEqual({ role, cites: true });
    }
    const approver = flat(await readFile(join(OVERLAY_ROLES, 'approver.md'), 'utf8'));
    expect(approver).toContain('the **Decisions** and **Deferred** sections of `docs/decisions.md`');
    expect(approver).toContain('contradicts a `docs/decisions.md` decision');
    expect(approver).toContain("a runtime dependency `docs/decisions.md` doesn't already name (Svelte, Tiny JS)");
    const specWriter = flat(await readFile(join(OVERLAY_ROLES, 'spec-writer.md'), 'utf8'));
    expect(specWriter).toContain('its **Decisions** are binding; its **Deferred** list is out of scope');
    const contract = flat(await readFile(join(OVERLAY_ROLES, 'contract.md'), 'utf8'));
    expect(contract).toContain('the contract\'s principles and the **Invariants** of `docs/decisions.md`');
    const ui = flat(await readFile(join(OVERLAY_ROLES, 'ui.md'), 'utf8'));
    expect(ui).toContain('decision 5 of `docs/decisions.md`');
    expect(ui).toContain('`docs/design/andon-overview/design.md`');
    const overlays = join(import.meta.dir, '..', 'overlays');
    for (const path of await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: overlays, dot: true }))) {
      const text = await readFile(join(overlays, path), 'utf8');
      expect({ path, handoff: text.includes(RETIRED) }).toEqual({ path, handoff: false });
    }
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
        for (const word of BANNED) expect({ word, found: mentions(s, word) }).toEqual({ word, found: false });
        expect(s).not.toMatch(/\{\{[^}]*\}\}/);
      }
    }
  });
});

describe('the abandon command in SKILL.md', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1', 'theta'], gate: ['x'] })];
  const entryOf = (text: string): string => {
    const start = text.indexOf('**`/factory abandon <id> <reason>`**');
    if (start < 0) throw new Error('no abandon entry');
    const end = text.indexOf('\n## ', start);
    return flat(end < 0 ? text.slice(start) : text.slice(start, end));
  };

  test('AC6: abandon is in the frontmatter and in Commands', () => {
    const { frontmatter, body } = splitFrontmatter(at(renderClaudeCode({ config: config() }).files, SKILL));
    expect(/^argument-hint: (.+)$/m.exec(frontmatter)?.[1] ?? '').toContain('abandon <job-id> <reason>');
    expect(/^description: (.+)$/m.exec(frontmatter)?.[1] ?? '').toContain('abandon <job-id> <reason>');
    const commands = body.slice(body.indexOf('\n## Commands'), body.indexOf('\n## ', body.indexOf('\n## Commands') + 1));
    expect(commands).toContain('**`/factory abandon <id> <reason>`**');
  });

  test('AC6: the confirm question, with the session-stopped check from a working stage', () => {
    const entry = entryOf(at(renderClaudeCode({ config: config() }).files, SKILL));
    expect(entry).toContain('**Confirm.**');
    expect(entry).toContain('From a working stage (`claimed`, `spec`, `build`, `review`, `approve`), also ask them to confirm that the session driving the job is stopped');
    expect(entry).toContain('Refuse `merged` and `abandoned`');
  });

  test('AC6: the keep-or-delete-branch question, with keep as the default', () => {
    const entry = entryOf(at(renderClaudeCode({ config: config() }).files, SKILL));
    expect(entry).toContain('**The branch.**');
    expect(entry).toContain('Keep the branch `factory/<id>`, or delete it?');
    expect(entry).toContain('The default is **keep**');
  });

  test('AC6: the exact CLI call, with --force from a working stage and --delete-branch only on delete', () => {
    const entry = entryOf(at(renderClaudeCode({ config: config() }).files, SKILL));
    expect(entry).toContain("bun factory/cli.ts abandon <id> '<reason>'");
    expect(entry).toContain('adding `--force` only when the job is in a working stage (never from `needs-human`)');
    expect(entry).toContain('`--delete-branch` only when the user chose delete');
  });

  test('AC6: rendering stays deterministic', () => {
    for (const c of configs) {
      const one = renderClaudeCode({ config: c });
      const two = renderClaudeCode({ config: c });
      expect(two.files).toEqual(one.files);
      expect(two.manifest).toEqual(one.manifest);
      expect(one.manifest.files[SKILL]).toBe(sha(at(one.files, SKILL)));
    }
  });
});

describe('CLI-owned job ids in SKILL.md (job 024, AC7)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1'], gate: ['x'], merge: { target: 'develop' } })];
  const skill = (c: Config = config()): string => flat(at(renderClaudeCode({ config: c }).files, SKILL));
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`no section ${heading}`);
    const end = text.indexOf(' ## ', start + 3);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };

  test('never tells the orchestrator to compute or pick a job id, or to log job.claimed itself', () => {
    for (const c of configs) {
      const text = skill(c);
      expect(text).not.toContain('next three-digit number');
      expect(text).not.toContain('NNN-*');
      expect(text).not.toContain('take the next id');
      expect(text).not.toMatch(/event <id> job\.claimed/);
      expect(text).not.toMatch(/Board: `job\.claimed`/);
      expect(text).not.toContain('run `job.claimed`');
    }
  });

  test('the board section shows the claim command and says to use the printed id', () => {
    const board = section(skill(), 'The board');
    expect(board).toContain('bun factory/cli.ts claim <slug> [brief=…] [issue=…] [maxRound=…]');
    expect(board).toContain('prints the full id (e.g. `004-export-csv-report`) as its only output');
    expect(board).toContain('That printed id is `<id>` everywhere from then on; never compute, guess, or pick an id yourself.');
    expect(board).toContain('`slug <slug> is live as <id>`');
  });

  test('the claim step runs claim under factory/.lock and uses the printed id after it', () => {
    const side = section(skill(), 'Running jobs side by side');
    expect(side).toContain('The job-id sequence is the CLI\'s: `claim` hands out each number under its own lock');
    expect(side).toContain('under `factory/.lock`');
    // Job 044: the claim runs the backlog check first, and commits the tick it makes.
    expect(side).toContain('- **Claim:** run **the backlog check**, pick the work, run the overlap check, run `bun factory/cli.ts claim <slug> …` (it picks the number, creates the job dir, and prints the id), then, with that printed id, write `feature.md`, tick the backlog line as `- [x] … → <id>`, and commit the tick at once by pathspec, still under the lock:');
  });

  test('/factory <feature>: brief refusals come before claim, which runs under the lock and prints the id', () => {
    const commands = section(skill(), 'Commands');
    const entry = commands.slice(commands.indexOf('**`/factory <feature>`**'), commands.indexOf('**`/factory queue <text>`**'));
    expect(entry).toContain('run `bun factory/cli.ts claim <slug>` with `brief=factory/briefs/<slug>.md` when it applies');
    expect(entry).toContain('The CLI picks the number and prints the job\'s id, e.g. `004-export-csv-report`; use that id from then on.');
    expect(entry.indexOf('stop before claiming')).toBeGreaterThan(-1);
    expect(entry.indexOf('stop before claiming')).toBeLessThan(entry.indexOf('claim <slug>'));
    expect(entry).toContain('under the lock (backlog check and overlap check first)');
  });

  test('the files table lists the CLI-owned .claim.lock', () => {
    expect(skill()).toContain('| `factory/jobs/.claim.lock/` — the CLI\'s mutex for handing out job ids | the factory CLI (never by hand) |');
  });
});

describe('the thread lookup in SKILL.md (job 039, AC5)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const skill = (c: Config = config()): string => flat(at(renderClaudeCode({ config: c }).files, SKILL));
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`no section ${heading}`);
    const end = text.indexOf(' ## ', start + 3);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };
  const entry = (commands: string, from: string, to: string): string => commands.slice(commands.indexOf(from), commands.indexOf(to));

  test('runs only when both T3 Code tools are present, before claim, job.reworked, and job.human-approved', () => {
    const lookup = section(skill(), 'The thread lookup (T3 Code)');
    expect(lookup).toContain('Run this **thread lookup** right before `claim` (before taking `factory/.lock`), before `job.reworked` (`/factory rework`), and before `job.human-approved` (`/factory approve`), and only when T3 Code\'s tools `t3_environment_read` and `t3_thread_search` are both present in this session. Without them, skip it and run the command without `session`.');
  });

  test('writes a unique phrase, searches, retries once, and passes session only on exactly one match', () => {
    const lookup = section(skill(), 'The thread lookup (T3 Code)');
    expect(lookup).toContain('Write a unique phrase in your reply to the user: `factory session <random>`');
    expect(lookup).toContain('then `t3_thread_search` for the phrase. If no thread comes back, wait a couple of seconds (`sleep 2`) and search once more.');
    expect(lookup).toContain('Only if exactly one thread matches, add `session=t3code:<environmentId>/<threadId>` to the command');
    expect(lookup).toContain('Otherwise (no match after the retry, several matches, or a tool error), run the command without `session` and tell the user in one line: "couldn\'t find this T3 Code thread; the job won\'t link to it".');
    expect(lookup).toContain('It is best effort: never stop the job');
  });

  test('the board, claim, approve, and rework steps point at it', () => {
    const text = skill();
    expect(section(text, 'The board')).toContain('bun factory/cli.ts claim <slug> [brief=…] [issue=…] [maxRound=…] [session=…]');
    expect(section(text, 'Running jobs side by side')).toContain('Run **the thread lookup** before taking the lock.');
    const commands = section(text, 'Commands');
    const feature = entry(commands, '**`/factory <feature>`**', '**`/factory queue <text>`**');
    expect(feature).toContain('`session=…` from **the thread lookup**, run first');
    const approve = entry(commands, '**`/factory approve <id>`**', '**`/factory rework <id> <note>`**');
    expect(approve).toContain('run **the thread lookup**, board: `job.human-approved [session=…]`');
    const rework = entry(commands, '**`/factory rework <id> <note>`**', '**`/factory abandon <id> <reason>`**');
    expect(rework).toContain('run **the thread lookup**, board: `job.reworked k=<k> maxRound=<round + 2> [session=…]`');
  });
});

describe('the backlog holds only open work, every edit committed at once (job 044)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const configs = [config(), config({ reviewers: ['q'] }), config({ reviewers: ['zeta', 'eta-1', 'theta'], gate: ['x'], merge: { target: 'develop' } })];
  const render = (c: Config = config()): Record<string, string> => renderClaudeCode({ config: c }).files;
  const skill = (c: Config = config()): string => flat(at(render(c), SKILL));
  const explore = (c: Config = config()): string => flat(at(render(c), EXPLORE));
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`no section ${heading}`);
    const end = text.indexOf(' ## ', start + 3);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };
  // A slice of `text` from `from` up to `to` (or the end), throwing when `from` is missing.
  const between = (text: string, from: string, to?: string): string => {
    const start = text.indexOf(from);
    if (start < 0) throw new Error(`missing: ${from}`);
    const end = to === undefined ? -1 : text.indexOf(to, start + from.length);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };
  const claimBullet = (text: string): string => between(section(text, 'Running jobs side by side'), '- **Claim:**', '- **Merge:**');
  const commands = (text: string): string => section(text, 'Commands');
  const feature = (text: string): string => between(commands(text), '**`/factory <feature>`**', '**`/factory queue <text>`**');
  const queue = (text: string): string => between(commands(text), '**`/factory queue <text>`**', '**`/factory explore');
  const next = (text: string): string => between(commands(text), '**`/factory next [words]`**', '**`/factory approve <id>`**');
  const abandon = (text: string): string => between(commands(text), '**`/factory abandon <id> <reason>`**');
  const bookkeeping = (text: string): string => between(section(text, 'Merge'), '- Then **bookkeeping**', '- Release the lock');
  const STOP = '"commit or discard your backlog edits first"';
  const TRAILER = '-m "Co-Authored-By: Claude <noreply@anthropic.com>"';
  const BOTH = '-- factory/backlog.md factory/briefs/<slug>.md';
  const ABANDONED = '- Abandoned: <id> (<YYYY-MM-DD>): <reason>';
  const QUESTION = "*\"Brief `<slug>` was abandoned as job `<id>`: '<reason>'. Start it again, or revise it first with `/factory explore <slug>`?\"*";

  test('AC1: the claim ticks the line and commits it by pathspec under the lock, before release and before the branch', () => {
    for (const c of configs) {
      const text = skill(c);
      const claim = claimBullet(text);
      const commit = `git commit -m "chore(factory): claim job <id>" ${TRAILER} -- factory/backlog.md`;
      expect(claim).toContain('tick the backlog line as `- [x] … → <id>`');
      expect(claim).toContain(commit);
      expect(claim).toContain('still under the lock');
      expect(claim.indexOf('bun factory/cli.ts claim <slug> …')).toBeLessThan(claim.indexOf(commit));
      expect(claim).toContain('Release the lock only after that commit; the job\'s branch is created later (step 2 of the loop).');
      expect(claim).toContain('The ticked line stays in the backlog while the job runs');
      // the branch really is created in step 2, after the claim
      expect(section(text, 'The loop')).toContain('**2 · Worktree.** `git worktree add -b factory/<id>');
      // /factory next and /factory <feature> both commit the tick as Claim says
      expect(next(text)).toContain('tick it as `- [x] … → <id>` and commit it (`chore(factory): claim job <id>`) in the same step');
      expect(feature(text)).toContain('If the work has a backlog line, tick and commit it as **Claim** under **Running jobs side by side** says; free text with no backlog line makes no backlog commit. Then release the lock');
    }
  });

  test('AC2: Merge bookkeeping removes the line and commits it with the brief in one record commit', () => {
    for (const c of configs) {
      const book = bookkeeping(skill(c));
      expect(book).toContain('remove the job\'s line (`- [x] … → <id>`) from `factory/backlog.md`; don\'t tick it, the line goes');
      expect(book).not.toContain('backlog tick');
      expect(book).toContain("set that brief's `Status:` line to `done` and add `- Job: <id> (merged <short sha>, <YYYY-MM-DD>)` right below it");
      expect(book).toContain(`git commit -m "chore(factory): record job <id>" ${TRAILER} ${BOTH}`);
      expect(book).toContain('With no brief, commit the backlog only, ending the same command with `-- factory/backlog.md` (nothing changed → skip)');
      expect(book.indexOf('remove the job\'s line')).toBeLessThan(book.indexOf(BOTH));
    }
  });

  test('AC3: abandon removes the line, notes the attempt in the brief, and commits both under the lock', () => {
    for (const c of configs) {
      const entry = abandon(skill(c));
      const after = entry.slice(entry.indexOf('Once the job is abandoned (the CLI printed `abandoned`'));
      expect(after).not.toBe('');
      expect(after).toContain('take `factory/.lock`');
      expect(after).toContain('Remove the job\'s line (`- [x] … → <id>`) from `factory/backlog.md`');
      expect(after).toContain(`add \`${ABANDONED}\` right below that brief's \`Status:\` line`);
      expect(after).toContain('one line per attempt');
      expect(after).toContain('`Status:` stays `ready`');
      expect(after).toContain(`git commit -m "chore(factory): abandon job <id>" ${TRAILER} ${BOTH}`);
      expect(after).toContain('With no brief, commit the backlog only, ending the same command with `-- factory/backlog.md` (nothing changed → skip)');
      expect(after.indexOf(BOTH)).toBeLessThan(after.indexOf('Release the lock (`rmdir factory/.lock`)'));
      expect(after.indexOf('take `factory/.lock`')).toBeLessThan(after.indexOf('Remove the job\'s line'));
    }
  });

  test('AC4: queue and explore\'s Finish take the lock around the edit and commit, and release it before asking', () => {
    for (const c of configs) {
      const q = queue(skill(c));
      expect(q).toContain('take `factory/.lock`');
      expect(q).toContain('`chore(factory): queue <title>` (+ the Co-Authored-By trailer) `-- factory/backlog.md`');
      expect(q.indexOf('take `factory/.lock`')).toBeLessThan(q.indexOf('-- factory/backlog.md'));
      expect(q.indexOf('-- factory/backlog.md')).toBeLessThan(q.indexOf('Release the lock, then show the user the lines you added'));
      expect(q).toContain('never hold the lock while you ask the user anything');
      const finish = section(explore(c), 'Finish');
      const lock = finish.indexOf('Take `factory/.lock`');
      const commit = finish.indexOf(`\`-- factory/backlog.md factory/briefs/<slug>.md\``);
      const release = finish.indexOf('Then release the lock (`rmdir factory/.lock`)');
      const ask = finish.indexOf('Only after the release, ask whether to run it now');
      for (const i of [lock, commit, release, ask]) expect(i).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(commit);
      expect(commit).toBeLessThan(release);
      expect(release).toBeLessThan(ask);
      expect(finish).toContain('`git add -- factory/backlog.md factory/briefs/<slug>.md`');
      expect(finish).toContain('`git commit -m "specs(factory): add brief <slug>"`');
    }
  });

  test('AC5: every backlog step stops on uncommitted backlog edits, with what the stop means for it', () => {
    for (const c of configs) {
      const text = skill(c);
      const check = between(section(text, 'Running jobs side by side'), '**The backlog check**', '**Live jobs**');
      expect(check).toContain('`git status --porcelain -- factory/backlog.md`');
      expect(check).toContain(`stop with the one line ${STOP}`);
      expect(check).toContain('never sweep them into your commit');
      // claim (both entry points): the check comes first, and nothing is claimed
      expect(claimBullet(text)).toContain('- **Claim:** run **the backlog check**, pick the work');
      expect(feature(text)).toContain('If **the backlog check** stops the claim, nothing is claimed');
      expect(next(text)).toContain('run **the backlog check** (if it stops you, nothing is claimed)');
      expect(next(text).indexOf('**the backlog check**')).toBeLessThan(next(text).indexOf('re-read `factory/backlog.md`'));
      // merge: the merge stands, only the bookkeeping waits, and the skipped steps are named
      const book = bookkeeping(text);
      expect(book).toContain('First run **the backlog check**');
      expect(book).toContain('the merge stands (`job.merged` is logged) and only the bookkeeping waits');
      expect(book).toContain(STOP);
      expect(book).toContain('which bookkeeping you skipped (removing the job\'s backlog line, marking the brief `done` with its `- Job:` line, and the `record job <id>` commit)');
      expect(book.indexOf('First run **the backlog check**')).toBeLessThan(book.indexOf('remove the job\'s line'));
      // abandon: checked after the answers and before the CLI, so a stop changes nothing
      const entry = abandon(text);
      expect(entry).toContain(`Before running the CLI (after both answers), run **the backlog check**: if \`factory/backlog.md\` already has uncommitted changes, stop with ${STOP}; nothing is abandoned and nothing changes.`);
      // queue
      expect(queue(text)).toContain('run **the backlog check** (if it stops you, nothing is queued)');
      // explore's Finish
      const finish = section(explore(c), 'Finish');
      expect(finish).toContain('**backlog check**');
      expect(finish).toContain(`stop with the one line ${STOP}`);
      expect(finish.indexOf('**backlog check**')).toBeLessThan(finish.indexOf('Set `Status: ready`'));
    }
  });

  test('AC6: a brief with an Abandoned: line asks once before claiming; explore shows attempts and lists the line', () => {
    for (const c of configs) {
      const text = skill(c);
      const f = feature(text);
      expect(f).toContain('If the brief has `- Abandoned:` lines');
      expect(f).toContain('ask once, before claiming and before taking the lock');
      expect(f).toContain(QUESTION);
      expect(f.indexOf(QUESTION)).toBeLessThan(f.indexOf('bun factory/cli.ts claim <slug>'));
      expect(next(text)).toContain('If its brief has `- Abandoned:` lines, release the lock and ask the abandoned-brief question from `/factory <feature>` first');
      const ex = at(render(c), EXPLORE);
      expect(section(flat(ex), 'Start')).toContain('If it has `- Abandoned:` lines, show its abandoned attempts in that summary');
      const open = ex.indexOf('```\n# <Title>');
      const format = ex.slice(open, ex.indexOf('```', open + 3));
      expect(format).toContain(`${ABANDONED}   (optional; written only by /factory abandon, one per attempt)`);
      expect(format.indexOf('- Status:')).toBeLessThan(format.indexOf('- Abandoned:'));
      expect(format).toContain('- Status: draft | ready | done');
      expect(flat(ex)).toContain('Only `/factory abandon` writes an `- Abandoned:` line');
    }
  });

  test('AC7: next reports finished work from done briefs\' Job: lines, and a ticked line as a running job', () => {
    for (const c of configs) {
      const n = next(skill(c));
      expect(n).toContain('When the words match no open line but describe finished work, say it already ran and which job: find it by the done briefs\' `- Job:` lines');
      expect(n).toContain('never by ticked lines');
      expect(n).not.toContain('a ticked line means it already ran');
      expect(n).toContain('A ticked `- [x] … → <id>` line is a running job: never pick it; if the words describe it, report it as running job `<id>`.');
    }
  });

  test('the files table and ground rules describe the backlog as open work with committed edits', () => {
    const text = skill();
    expect(text).not.toContain('human (you tick items off)');
    expect(text).toContain('| `factory/backlog.md` — open and running work only, the queue for `/factory next` |');
    expect(section(text, 'Ground rules')).toContain('backlog edits (each committed at once)');
    expect(section(text, 'Ground rules')).not.toContain('backlog ticks');
  });

  test('AC8: SKILL.md and explore.md stay neutral and fully filled for several configs', () => {
    const BANNED = ['Minerva', 'Andon', 'andon', 'packages/', 'apps/', 'bun run test', 'bun run check'];
    for (const c of configs) {
      const text = skill(c);
      const touched = [claimBullet(text), feature(text), queue(text), next(text), abandon(text), bookkeeping(text), explore(c)];
      for (const s of touched) {
        for (const word of BANNED) expect({ word, found: mentions(s, word) }).toEqual({ word, found: false });
        expect(s).not.toMatch(/\{\{[^}]*\}\}/);
      }
    }
  });
});

describe('the job archive in SKILL.md (job 045, AC8)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const configs = [config(), config({ reviewers: ['q'] }), config({ merge: { target: 'develop' }, archive: { enabled: true } })];
  const skill = (c: Config = config()): string => flat(at(renderClaudeCode({ config: c }).files, SKILL));
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`no section ${heading}`);
    const end = text.indexOf(' ## ', start + 3);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };
  const ARCHIVE = '`bun factory/cli.ts archive <id>`';

  test('Merge archives after job.merged and before bookkeeping, carries on after a failure, and never pushes', () => {
    for (const c of configs) {
      const merge = section(skill(c), 'Merge');
      const merged = merge.indexOf('board: `job.merged sha=<short sha>` **immediately**');
      const archive = merge.indexOf(`- Then **archive** the job, before bookkeeping: run ${ARCHIVE} from \`<R>\`.`);
      const bookkeeping = merge.indexOf('- Then **bookkeeping**');
      for (const i of [merged, archive, bookkeeping]) expect(i).toBeGreaterThanOrEqual(0);
      expect(merged).toBeLessThan(archive);
      expect(archive).toBeLessThan(bookkeeping);
      const step = merge.slice(archive, bookkeeping);
      expect(step).toContain('If it fails, or says archiving is disabled, report its line to the user in one line and carry on: a failed or disabled archive never fails or undoes the merge');
      expect(step).toContain('It copies the job\'s record to the `factory/archive` branch with git plumbing');
      expect(step).toContain('Never push `factory/archive`.');
      expect(step).toContain('never touches the checkout');
    }
  });

  test('/factory abandon archives after the CLI abandons the job, carries on after a failure, and never pushes', () => {
    for (const c of configs) {
      const commands = section(skill(c), 'Commands');
      const entry = commands.slice(commands.indexOf('**`/factory abandon <id> <reason>`**'));
      const cli = entry.indexOf("bun factory/cli.ts abandon <id> '<reason>'");
      const done = entry.indexOf('Once the job is abandoned (the CLI printed `abandoned`, or named what it left behind), run `bun factory/cli.ts archive <id>` from `<R>`');
      const lock = entry.indexOf('Then take `factory/.lock`');
      for (const i of [cli, done, lock]) expect(i).toBeGreaterThanOrEqual(0);
      expect(cli).toBeLessThan(done);
      expect(done).toBeLessThan(lock);
      const step = entry.slice(done, lock);
      expect(step).toContain('If it fails, or says archiving is disabled, report its line in one line and carry on: a failed or disabled archive never fails the abandon.');
      expect(step).toContain('to copy its record to the `factory/archive` branch.');
      expect(step).toContain('Never push `factory/archive`.');
    }
  });

  test('job 046 AC5: no rendered file names factory/jobs as a branch; the job record names factory/archive', () => {
    // A branch mention: `factory/jobs` with no path after it, "the factory/jobs branch", or its ref.
    const asBranch = /`factory\/jobs`|factory\/jobs branch|refs\/heads\/factory\/jobs/;
    for (const c of configs) {
      for (const [path, text] of Object.entries(renderClaudeCode({ config: c }).files)) {
        expect({ path, found: asBranch.test(flat(text)) }).toEqual({ path, found: false });
      }
      expect(skill(c)).toContain('`factory/archive` branch by `factory archive`');
    }
  });

  test('Customize asks about archive right after merge.target and its refusal rules know the key', () => {
    const custom = section(skill(), 'Customize');
    const target = custom.indexOf('6. `merge.target` —');
    const archive = custom.indexOf('7. `archive.enabled` —');
    const roles = custom.indexOf('8. `roles` —');
    for (const i of [target, archive, roles]) expect(i).toBeGreaterThanOrEqual(0);
    expect(target).toBeLessThan(archive);
    expect(archive).toBeLessThan(roles);
    expect(custom).toContain('No `archive` key keeps it off.');
    expect(custom).toContain('`merge` (only `target`), `archive` (only `enabled`), and `roles`');
    expect(custom).toContain('- `archive`, when present, is an object holding only `enabled`, which is required and is `true` or `false`.');
    expect(custom).toContain('**When `archive` changed.** No re-render is needed');
  });

  test('the archive step is not in the skill before this job (the pins fail on the old text)', () => {
    const old = TEMPLATES.skill.replace(/- Then \*\*archive\*\* the job[\s\S]*?Never push `factory\/archive`\.\n/, '');
    expect(old).not.toBe(TEMPLATES.skill);
    const text = flat(at(renderClaudeCode({ config: config(), templates: { ...TEMPLATES, skill: old } }).files, SKILL));
    expect(section(text, 'Merge')).not.toContain(ARCHIVE);
  });
});

describe('merge conflicts go back to the builder (job 051)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const configs = [config(), config({ reviewers: ['q'] }), config({ merge: { target: 'develop' }, archive: { enabled: true } })];
  const files = (c: Config = config()): Record<string, string> => renderClaudeCode({ config: c }).files;
  const skill = (c: Config = config()): string => flat(at(files(c), SKILL));
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`no section ${heading}`);
    const end = text.indexOf(' ## ', start + 3);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  };
  // Every needle is present, and each one comes after the one before it.
  const inOrder = (text: string, needles: readonly string[]): void => {
    let last = -1;
    for (const needle of needles) {
      const i = text.indexOf(needle, last + 1);
      expect({ needle, found: i >= 0 }).toEqual({ needle, found: true });
      expect({ needle, after: i > last }).toEqual({ needle, after: true });
      last = i;
    }
  };

  test('AC5: Merge separates a conflict from a refusal, and the conflict path runs in order', () => {
    for (const c of configs) {
      const merge = section(skill(c), 'Merge');
      const conflict = merge.slice(merge.indexOf('- **Conflict**'), merge.indexOf('- **Refusal**'));
      expect(merge.indexOf('- **Conflict**')).toBeGreaterThanOrEqual(0);
      expect(merge.indexOf('- **Refusal**')).toBeGreaterThan(merge.indexOf('- **Conflict**'));
      expect(conflict).toContain('`git diff --name-only --diff-filter=U` lists at least one path');
      inOrder(conflict, [
        'list the conflicting paths (`git diff --name-only --diff-filter=U`) and the sha of `<target>` (`git rev-parse --short <target>`)',
        '`git merge --abort`',
        'Then release the lock (`rmdir factory/.lock`).',
        'If `conflicts` in job.json is already 2 (a missing key counts as 0)',
        'board: `merge.failed reason=',
        'Otherwise write `jobs/<id>/conflict-<c>.md` (`c` = `conflicts` + 1)',
        'Board: `merge.conflicted reason=',
        'Resume `builder-<id>` (span `role=builder name=builder-<id> round=<round>`)',
        "If that builder isn't alive in this session, spawn a fresh `factory-builder`",
        'Continue at step 4 with round `<round> + 1`',
      ]);
      expect(conflict).toContain('facts only: the target branch and its sha, the conflicting paths, and `git merge`\'s one-line summary');
      expect(conflict).toContain('with the card plus the note path');
      expect(conflict).toContain('<R>/factory/jobs/<id>/conflict-<c>.md');
      expect(conflict).toContain('If the CLI refuses `merge.conflicted`, board: `merge.failed');
      inOrder(conflict, ['Continue at step 4', 'the approver', '**Merge**']);
      const refusal = merge.slice(merge.indexOf('- **Refusal**'), merge.indexOf('- Success →'));
      expect(refusal).toContain('board: `merge.failed reason=');
      expect(refusal).toContain('index.lock');
      expect(merge).not.toMatch(/rebase/i);
    }
  });

  test('AC5: /factory approve says a conflict enters the same loop and an approver ESCALATE comes back to the human', () => {
    const commands = section(skill(), 'Commands');
    const entry = commands.slice(commands.indexOf('**`/factory approve <id>`**'), commands.indexOf('**`/factory rework <id> <note>`**'));
    expect(entry).toContain('If **Merge** finds a conflict, the job enters the same loop as any conflict');
    expect(entry).toContain('an approver `ESCALATE` there comes back to the human');
    expect(entry).toContain('clears the human approval');
  });

  test('AC5: Ground rules and the Files table list conflict notes among what the orchestrator writes', () => {
    const s = skill();
    expect(section(s, 'Ground rules')).toContain("you write only your job's feature.md, rework notes, and conflict notes");
    expect(s).toContain('| `factory/jobs/<id>/conflict-<c>.md` — the facts of a merge conflict with `<target>` | you |');
  });

  test('AC6: the builder has a conflict-note section: merge <base> as a merge commit, keep both sides, gate, ## Conflict <c>', () => {
    for (const c of configs) {
      const builder = flat(at(files(c), agent('builder')));
      const sec = section(builder, 'A conflict note');
      expect(sec).toContain('`<job dir>/conflict-<c>.md`');
      expect(sec).toContain('Merge `<base>` into the job branch, in the job worktree, as a merge commit');
      expect(sec).toContain('Never rebase, never force-push, and never rewrite history');
      expect(sec).toContain("keeping both sides' intent");
      expect(sec).toContain('Run the gate');
      expect(sec).toContain('Add a `## Conflict <c>` section to `build.md`');
      expect(sec).toContain('how each path was resolved and what it kept from each side');
      inOrder(sec, ['as a merge commit', "both sides' intent", 'Run the gate', '`## Conflict <c>`']);
      // The one merge the builder makes is carved out of "never merge".
      expect(section(builder, 'Where you work')).toContain('never merge (except `<base>` into the job branch for a conflict note, below), never push');
    }
  });

  test('AC6: the builder and approver read any conflict-*.md next to rework-*.md', () => {
    const f = files();
    const builder = section(flat(at(f, agent('builder'))), 'Read');
    expect(builder).toContain('any `<job dir>/rework-*.md` (human feedback), any `<job dir>/conflict-*.md` (merge conflicts with `<base>`)');
    const approver = section(flat(at(f, agent('approver'))), 'Read');
    expect(approver).toContain('any `rework-*.md`, any `conflict-*.md`');
  });

  test('the pins fail on the old text', () => {
    const old = TEMPLATES.skill.replace(/- \*\*Conflict\*\*[\s\S]*?(?=- \*\*Refusal\*\*)/, '');
    expect(old).not.toBe(TEMPLATES.skill);
    const text = flat(at(renderClaudeCode({ config: config(), templates: { ...TEMPLATES, skill: old } }).files, SKILL));
    expect(section(text, 'Merge')).not.toContain('merge.conflicted');
  });
});
