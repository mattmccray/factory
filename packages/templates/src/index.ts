// The managed core's templates (docs/contract/v1.md "Managed files"): the project-neutral
// `/factory` skill and role agents, and the Claude Code render adapter that turns them into
// stamped files plus a `managed.json` manifest. Rendering is pure: no I/O, and the same config
// always gives the same bytes. The overlay (`factory/roles/<role>.md`) is read by each agent at
// run time and never inlined here, so a managed file's bytes never depend on it.
import { createHash } from 'node:crypto';
import type { Config, Manifest } from '@factory/contract';
import pkg from '../package.json';
import approver from '../assets/agents/approver.md' with { type: 'text' };
import builder from '../assets/agents/builder.md' with { type: 'text' };
import reviewer from '../assets/agents/reviewer.md' with { type: 'text' };
import specWriter from '../assets/agents/spec-writer.md' with { type: 'text' };
import skill from '../assets/skill/SKILL.md' with { type: 'text' };
import explore from '../assets/skill/explore.md' with { type: 'text' };

/** The managed release these templates render as; always `package.json`'s `version`. */
export const VERSION: string = pkg.version;

export interface Templates {
  skill: string;
  explore: string;
  specWriter: string;
  builder: string;
  approver: string;
  reviewer: string; // rendered once per configured reviewer key
}

export const TEMPLATES: Readonly<Templates> = { skill, explore, specWriter, builder, approver, reviewer };

export interface RenderResult {
  files: Record<string, string>; // repo-relative path -> rendered text
  manifest: Manifest;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const REVIEWER_KEY = /^[a-z][a-z0-9-]*$/;
const FIXED_ROLES = ['spec-writer', 'builder', 'approver'];
const SKILL_DIR = '.claude/skills/factory';
const AGENT_DIR = '.claude/agents';

/**
 * Fills every `{{name}}` in `template` from `vars`. Throws when a placeholder names no variable
 * (unknown) or when placeholder syntax is left over after filling (unfilled or malformed).
 */
export function fill(template: string, vars: Readonly<Record<string, string>>, what: string): string {
  const out = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined) throw new Error(`${what}: unknown placeholder {{${name}}}`);
    return value;
  });
  if (out.includes('{{') || out.includes('}}')) throw new Error(`${what}: unfilled placeholder syntax left after render`);
  return out;
}

/** Splits leading YAML frontmatter (`---` … `---`, newline included) from the body. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---\n')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) throw new Error('frontmatter: no closing ---');
  const cut = end + '\n---\n'.length;
  return { frontmatter: text.slice(0, cut), body: text.slice(cut) };
}

/** The one-line in-file stamp: version, managed, do not edit, and where project rules go. */
export function stampLine(overlay: string): string {
  return `<!-- factory ${VERSION} · managed file, do not edit: it is replaced on upgrade. Project rules go in the overlay: ${overlay} -->`;
}

/** Inserts the stamp right after the frontmatter, or first when there is none. */
export function stamp(text: string, overlay: string): string {
  const { frontmatter, body } = splitFrontmatter(text);
  return `${frontmatter}${stampLine(overlay)}\n${body}`;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function checkReviewerKey(key: string): void {
  if (!REVIEWER_KEY.test(key)) throw new Error(`render: bad reviewer key ${JSON.stringify(key)} (want ^[a-z][a-z0-9-]*$)`);
  if (FIXED_ROLES.includes(key)) throw new Error(`render: reviewer key '${key}' is reserved`);
}

/**
 * Renders the managed skill and agents in the Claude Code layout for one project's config.
 * Returns each file's text by repo-relative path, and the manifest of their SHA-256 hashes.
 */
export function renderClaudeCode(input: { config: Config; templates?: Readonly<Templates> }): RenderResult {
  const t = input.templates ?? TEMPLATES;
  const files: Record<string, string> = {};
  const add = (path: string, template: string, vars: Record<string, string>, overlay: string): void => {
    if (Object.hasOwn(files, path)) throw new Error(`render: duplicate path ${path}`);
    files[path] = stamp(fill(template, vars, path), overlay);
  };
  const skillOverlay = 'factory/config.json and factory/roles/<role>.md';
  add(`${SKILL_DIR}/SKILL.md`, t.skill, {}, skillOverlay);
  add(`${SKILL_DIR}/explore.md`, t.explore, {}, skillOverlay);
  const fixed: ReadonlyArray<readonly [string, string]> = [
    ['spec-writer', t.specWriter],
    ['builder', t.builder],
    ['approver', t.approver],
  ];
  for (const [role, template] of fixed) {
    add(`${AGENT_DIR}/factory-${role}.md`, template, { role }, `factory/roles/${role}.md`);
  }
  for (const key of input.config.reviewers) {
    checkReviewerKey(key);
    add(`${AGENT_DIR}/factory-${key}.md`, t.reviewer, { key }, `factory/roles/${key}.md`);
  }
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) hashes[path] = sha256(text);
  return { files, manifest: { schema: 'factory/v1', version: VERSION, files: hashes } };
}
