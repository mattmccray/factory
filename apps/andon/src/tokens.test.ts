// The visual tokens (design §11, AC7): app.css defines them for dark and light under
// `prefers-color-scheme`, and every text token meets WCAG AA (4.5:1) on each background it is used
// on, in both appearances. Translucent tokens are composited over the background first.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties declared in a block's body (`--name: value;`). */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2].trim());
  return out;
}

/** The body of the first `:root { … }` at the top level (dark, the default) and inside the light media query. */
function appearances(): { dark: Map<string, string>; light: Map<string, string> } {
  const root = /^:root\s*\{([^}]*)\}/m.exec(css);
  const media = /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
  if (root?.[1] === undefined || media?.[1] === undefined) throw new Error('app.css needs a top-level :root and a (prefers-color-scheme: light) :root');
  const dark = declarations(root[1]);
  const light = new Map([...dark, ...declarations(media[1])]);
  return { dark, light };
}

type Rgba = [number, number, number, number];

function color(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1] !== undefined) {
    const h = hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgba !== null) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`not a color: ${value}`);
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];

function contrast(fg: string, bg: string): number {
  const back = color(bg);
  const a = luminance(over(color(fg), back));
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const LABELS = ['--label', '--label2', '--label3'];
const STATES = ['--red', '--orange', '--green', '--blue', '--teal', '--indigo', '--purple', '--gray'];
/** Where text sits: the toolbar and status bar, the board, the solid sidebar, cards, and the drawer and dialogs. */
const SURFACES = ['--win', '--canvas', '--side', '--card', '--raised'];
const DESIGN = ['--win', '--canvas', '--raised', '--label', '--label2', '--label3', '--label4', '--sep', '--sep2', '--ctl', '--ctl-h', ...STATES];

describe('the design §11 tokens (AC7)', () => {
  const { dark, light } = appearances();

  test('the design\'s tokens are defined for both appearances, with the design\'s surface and accent values', () => {
    for (const t of DESIGN) {
      expect({ t, dark: dark.has(t) }).toEqual({ t, dark: true });
      expect({ t, light: light.has(t) }).toEqual({ t, light: true });
    }
    expect([dark.get('--win'), dark.get('--canvas'), dark.get('--raised')]).toEqual(['#1e1e20', '#19191b', '#2a2a2d']);
    expect([light.get('--win'), light.get('--canvas'), light.get('--raised')]).toEqual(['#f6f6f6', '#ffffff', '#ffffff']);
    expect(STATES.map((t) => dark.get(t))).toEqual(['#ff453a', '#ff9f0a', '#30d158', '#0a84ff', '#40cbe0', '#6e6cf0', '#bf5af2', '#98989d']);
    expect(STATES.map((t) => light.get(t))).toEqual(['#ff3b30', '#ff9500', '#34c759', '#007aff', '#30b0c7', '#5856d6', '#af52de', '#8e8e93']);
  });

  for (const [name, tokens] of [['dark', dark], ['light', light]] as const) {
    const get = (t: string): string => {
      const v = tokens.get(t);
      if (v === undefined) throw new Error(`${name}: ${t} is not defined`);
      return v;
    };

    test(`${name}: every label text token meets AA (4.5:1) on every surface`, () => {
      for (const fg of LABELS) for (const bg of SURFACES) {
        const ratio = Number(contrast(get(fg), get(bg)).toFixed(2));
        expect({ fg, bg, aa: ratio >= 4.5, ratio }).toEqual({ fg, bg, aa: true, ratio });
      }
    });

    test(`${name}: each state color's text variant (--<state>-ink) meets AA on every surface`, () => {
      for (const state of STATES) for (const bg of SURFACES) {
        const fg = `${state}-ink`;
        const ratio = Number(contrast(get(fg), get(bg)).toFixed(2));
        expect({ fg, bg, aa: ratio >= 4.5, ratio }).toEqual({ fg, bg, aa: true, ratio });
      }
    });

    test(`${name}: white text meets AA on the red badge and the accent fill`, () => {
      for (const bg of ['--badge-red', '--accent-fill']) {
        const ratio = Number(contrast('#ffffff', get(bg)).toFixed(2));
        expect({ bg, aa: ratio >= 4.5, ratio }).toEqual({ bg, aa: true, ratio });
      }
    });
  }

  test('text never uses a raw state color or --label4: a state color as text is its -ink variant', () => {
    const raw = new RegExp(`(?:^|[;{\\s])color\\s*:\\s*var\\((?:${[...STATES, '--label4'].join('|')})\\)`, 'gm');
    expect([...css.matchAll(raw)].map((m) => m[0].trim())).toEqual([]);
  });

  test('the paper palette, serif type, dot grid, and amber stripes are gone', () => {
    for (const gone of ['--paper', '--ink', '--serif', '--andon', 'radial-gradient', 'repeating-linear-gradient(-45deg', 'Palatino']) expect({ gone, found: css.includes(gone) }).toEqual({ gone, found: false });
    expect(css).toContain('-apple-system, BlinkMacSystemFont, "SF Pro Text"');
  });

  test('the contrast math matches known pairs', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('rgba(0, 0, 0, 0)', '#ffffff')).toBeCloseTo(1, 5);
  });
});
