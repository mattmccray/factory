// The sidebar footer and the status bar share one height, so their top dividers meet on one line,
// and the status bar's legend rests dimmed until the bar is hovered (042, design §3).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGEND } from './sidebar';

const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the top-level rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? '';
}

/** The value of `property` in a rule body, or undefined. */
function prop(body: string, property: string): string | undefined {
  const m = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`).exec(body);
  return m?.[1]?.trim();
}

/** The custom properties set in the top-level `:root` with the value `value`. */
function rootPropsWith(value: string): string[] {
  const root = /^:root\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
  const out: string[] = [];
  for (const m of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (m[1] !== undefined && m[2]?.trim() === value) out.push(m[1]);
  return out;
}

describe('the footer and the status bar share one height (042 AC1)', () => {
  test('one top-level :root property is 28px, and both rules take their height from it', () => {
    const shared = rootPropsWith('28px');
    expect(shared).toHaveLength(1);
    const name = shared[0] ?? '';
    for (const selector of ['.statusbar', '.service']) {
      const body = rule(selector);
      expect(body).not.toBe('');
      expect(prop(body, 'height')).toBe(`var(${name})`);
      expect(body).not.toMatch(/(?:^|[;\s])height:\s*\d/);
    }
  });
});

describe('the footer row (042 AC2)', () => {
  test('no vertical padding, a centered flex row, and the status bar\'s top divider', () => {
    const service = rule('.service');
    const padding = prop(service, 'padding');
    expect(padding).toBeDefined();
    const parts = (padding ?? '').split(/\s+/);
    expect(parts[0]).toBe('0');
    expect(parts.length === 1 || parts.length === 2 || parts[2] === '0').toBe(true);
    expect(service).not.toMatch(/padding-(?:top|bottom)\s*:/);
    expect(prop(service, 'display')).toBe('flex');
    expect(prop(service, 'align-items')).toBe('center');
    expect(prop(service, 'border-top')).toBe('.5px solid var(--sep)');
    expect(prop(rule('.statusbar'), 'border-top')).toBe(prop(service, 'border-top'));
  });
});

describe('the legend fades (042 AC3)', () => {
  test('the legend rests at .45 with a 150ms opacity transition, and is full while the bar is hovered', () => {
    const legend = rule('.legend');
    expect(prop(legend, 'opacity')).toMatch(/^0?\.45$/);
    expect(prop(legend, 'transition')).toMatch(/^opacity\s+(?:\.15s|0\.15s|150ms)$/);
    expect(prop(rule('.statusbar:hover .legend'), 'opacity')).toBe('1');
  });

  test('the settle text and clock never dim', () => {
    expect(rule('.statusbar .rt')).not.toBe('');
    expect(prop(rule('.statusbar .rt'), 'opacity')).toBeUndefined();
  });
});

describe('the legend under reduced motion, and its markup (042 AC4)', () => {
  test('reduced motion removes every transition, so the legend changes instantly', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*([^{]*)\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect((block?.[1] ?? '').split(',').map((s) => s.trim())).toContain('*');
    expect(block?.[2] ?? '').toMatch(/transition:\s*none\s*!important/);
  });

  test('the status bar still renders the labeled legend from LEGEND', () => {
    const bar = readFileSync(join(import.meta.dir, 'StatusBar.svelte'), 'utf8');
    expect(bar).toContain('<ul class="legend" aria-label="Card edge colors">');
    expect(bar).toContain('{#each LEGEND as l (l.key)}');
    expect(LEGEND.map((l) => l.key)).toEqual(['needs-human', 'claimed', 'spec', 'build', 'review', 'failed', 'approve', 'merged']);
  });
});

describe('the design doc (042 AC7)', () => {
  test('§3 says the footer is 28px and aligned with the status bar, and the legend is dimmed until hovered', () => {
    // Wrapped lines read as one line of prose.
    const doc = readFileSync(join(import.meta.dir, '../../../docs/design/andon-overview/design.md'), 'utf8').replace(/\n {2,}/g, ' ');
    const footer = /^- \*\*Footer\*\*[\s\S]*?(?=\n- |\n\n)/m.exec(doc)?.[0] ?? '';
    expect(footer).toContain('28px');
    expect(footer).toMatch(/aligned with the status bar/);
    const status = /^\*\*Status bar\*\*[\s\S]*?(?=\n\n)/m.exec(doc)?.[0] ?? '';
    expect(status).toMatch(/dimmed until the status bar is hovered/);
  });
});
