// Text selection (034 AC2): off by default on the root and inherited, so a right-click or a drag
// never selects the board's words; on only in the inspector's rendered document (`.doc`), the
// command boxes (`.cmd code`, whole-command), text fields, and the About window's text
// (`.about .about-text`, 073: its art band is the drag area, the text below stays selectable). Each rule sets both the WebKit-
// prefixed and the unprefixed property, so the Mac app and a plain browser behave the same.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost `selector { body }` rule, including those inside `@media` blocks. */
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) =>
  m[1] === undefined || m[2] === undefined ? [] : [{ selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }],
);

/** The value a body gives a property (the last declaration wins), or null. */
function value(body: string, prop: string): string | null {
  let out: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|[;\\s])${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`, 'g'))) if (m[1] !== undefined) out = m[1].trim();
  return out;
}

/** The selection a selector's rules set: both properties, from the rules that list the selector. */
function selection(selector: string): { webkit: string | null; plain: string | null } {
  let webkit: string | null = null;
  let plain: string | null = null;
  for (const r of rules.filter((x) => x.selectors.includes(selector))) {
    webkit = value(r.body, '-webkit-user-select') ?? webkit;
    plain = value(r.body, 'user-select') ?? plain;
  }
  return { webkit, plain };
}

describe('text selection (034 AC2)', () => {
  test('the root turns selection off, with and without the WebKit prefix', () => {
    const root = rules.filter((r) => r.selectors.includes('html') || r.selectors.includes('body'));
    expect(root.some((r) => value(r.body, '-webkit-user-select') === 'none' && value(r.body, 'user-select') === 'none')).toBe(true);
  });

  test('the rendered document and text fields turn it back on', () => {
    for (const selector of ['.doc', 'input', 'textarea', '.about .about-text']) expect({ selector, ...selection(selector) }).toEqual({ selector, webkit: 'text', plain: 'text' });
  });

  test('a command box selects the whole command on click', () => {
    expect(selection('.cmd code')).toEqual({ webkit: 'all', plain: 'all' });
  });

  test('no other rule turns selection back on', () => {
    const allowed = new Set(['.doc', 'input', 'textarea', '.cmd code', '.about .about-text']);
    const on = rules
      .filter((r) => [value(r.body, '-webkit-user-select'), value(r.body, 'user-select')].some((v) => v !== null && v !== 'none'))
      .map((r) => r.selectors.filter((s) => !allowed.has(s)))
      .filter((extra) => extra.length > 0);
    expect(on).toEqual([]);
  });
});
