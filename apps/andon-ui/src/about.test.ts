import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UI_CSP, startService } from '../../../packages/andon-service/src/index';
import config from '../vite.config';
import { ART_PATH, CLOSE_ABOUT_METHOD, GET_ABOUT_METHOD, aboutCaller, aboutModel, closeAboutCaller, isCloseKey, narrowAbout } from './about';
import type { KeyLike } from './about';
import { isRecord } from './job';
import { appView, shellMode } from './sidebar';

const app = join(import.meta.dir, '..');
const repo = join(app, '..', '..');
const GITHUB = 'https://github.com/mattmccray/factory';
const APP = { version: '0.2.0', github: GITHUB };
const rel = (running: string | null, onDisk: string | null): unknown => ({ running, onDisk, changelog: [] });

describe('065 AC4: which view a URL gets', () => {
  test('only shell=mac together with view=about is the about view', () => {
    for (const q of ['?shell=mac&view=about', '?view=about&shell=mac', 'shell=mac&view=about', '?shell=mac&view=about&x=1']) expect({ q, v: appView(q) }).toEqual({ q, v: 'about' });
  });

  test('a plain browser with view=about, and shell=mac alone, are the board; settings is still settings', () => {
    for (const q of ['?view=about', '?shell=mac', '?shell=browser&view=about', '?shell=mac&view=About', '?shell=mac&view=aboutx', '?shell=MAC&view=about', '']) {
      expect({ q, v: appView(q) }).toEqual({ q, v: 'board' });
    }
    expect(appView('?shell=mac&view=settings')).toBe('settings');
  });

  test('main.ts mounts the about view for it', () => {
    const main = readFileSync(join(app, 'main.ts'), 'utf8');
    expect(main).toContain("import About from './src/About.svelte';");
    expect(main).toContain("view === 'about' ? About");
  });

  test('a plain browser has no about caller', () => {
    const host = { api: { call: async () => APP } };
    expect(aboutCaller(shellMode('?view=about'), host)).toBeNull();
    expect(aboutCaller('browser', host)).toBeNull();
    expect(aboutCaller('mac', {})).toBeNull();
    expect(aboutCaller('mac', { api: {} })).toBeNull();
  });
});

describe('065: the about caller', () => {
  test('calls the one method with no params and resolves the answer; null when the call throws or rejects', async () => {
    const calls: unknown[][] = [];
    const host = {
      api: {
        call: async (...args: unknown[]) => {
          calls.push(args);
          return APP;
        },
      },
    };
    const ask = aboutCaller('mac', host);
    expect(await ask?.()).toEqual(APP);
    expect(calls).toEqual([[GET_ABOUT_METHOD, null]]);
    expect(GET_ABOUT_METHOD).toBe('getAbout');
    const rejects = aboutCaller('mac', { api: { call: async () => Promise.reject(new Error('no')) } });
    expect(await rejects?.()).toBeNull();
    const throws = aboutCaller('mac', {
      api: {
        call: () => {
          throw new Error('no');
        },
      },
    });
    expect(await throws?.()).toBeNull();
  });
});

describe('073 AC6: Escape closes the About window', () => {
  const key = (over: Partial<KeyLike> = {}): KeyLike => ({ key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, ...over });

  test('the close caller calls only closeAbout, with no params; a throw or rejection is swallowed', async () => {
    const calls: unknown[][] = [];
    const host = {
      api: {
        call: async (...args: unknown[]) => {
          calls.push(args);
          return true;
        },
      },
    };
    const close = closeAboutCaller('mac', host);
    expect(close).not.toBeNull();
    await close?.();
    expect(calls).toEqual([[CLOSE_ABOUT_METHOD, null]]);
    expect(CLOSE_ABOUT_METHOD).toBe('closeAbout');
    const rejects = closeAboutCaller('mac', { api: { call: async () => Promise.reject(new Error('no')) } });
    expect(await rejects?.()).toBeUndefined();
    const throws = closeAboutCaller('mac', {
      api: {
        call: () => {
          throw new Error('no');
        },
      },
    });
    expect(await throws?.()).toBeUndefined();
  });

  test('a plain browser (no ?shell=mac, or no window.tiny) has no close caller: Escape does nothing', () => {
    const host = { api: { call: async () => true } };
    expect(closeAboutCaller(shellMode('?view=about'), host)).toBeNull();
    expect(closeAboutCaller(shellMode(''), host)).toBeNull();
    expect(closeAboutCaller('browser', host)).toBeNull();
    for (const h of [undefined, null, {}, { api: {} }, { api: { call: 'x' } }, 'tiny']) expect({ h, c: closeAboutCaller('mac', h) }).toEqual({ h, c: null });
  });

  test('only a bare Escape is the close key', () => {
    expect(isCloseKey(key())).toBe(true);
    for (const k of [key({ key: 'Esc' }), key({ key: 'escape' }), key({ key: 'w' }), key({ key: 'Enter' }), key({ metaKey: true }), key({ ctrlKey: true }), key({ altKey: true }), key({ shiftKey: true }), key({ isComposing: true }), key({ repeat: true })]) {
      expect({ k, close: isCloseKey(k) }).toEqual({ k, close: false });
    }
  });

  test('About.svelte calls the close caller on the close key only, and marks the art band as the drag area', () => {
    const view = readFileSync(join(import.meta.dir, 'About.svelte'), 'utf8');
    expect(view).toContain('closeAboutCaller(shellMode(window.location.search), Reflect.get(window, \'tiny\'))');
    expect(view).toContain('if (isCloseKey(e)) void close?.();');
    expect(view).toContain('<svelte:window {onkeydown} />');
    expect(view).toMatch(/<div class="about-band" data-tiny-drag>/);
    expect(view).not.toContain('standard title bar');
  });
});

describe('065 AC5: the about model', () => {
  test('the name, the version, the GitHub URL, and the copyright', () => {
    const m = aboutModel(APP, rel('0.2.0', '0.2.0'));
    expect(m).toEqual({
      art: '/about.png',
      name: 'Andon',
      version: 'Version 0.2.0',
      service: null,
      github: { href: 'https://github.com/mattmccray/factory', label: 'Factory on GitHub' },
      copyright: '© 2026 Matt McCray',
    });
  });

  test('a service line only when running is non-null and differs from the app version', () => {
    expect(aboutModel(APP, rel('0.1.0', '0.1.0')).service).toBe('Service 0.1.0');
    expect(aboutModel(APP, rel('0.3.0', null)).service).toBe('Service 0.3.0');
    expect(aboutModel(APP, rel('0.2.0', null)).service).toBeNull();
    expect(aboutModel(APP, rel(null, null)).service).toBeNull();
    expect(aboutModel(APP, rel(null, '0.3.0')).service).toBeNull();
  });

  test('"· restart needed" only when onDisk is non-null and differs from running', () => {
    expect(aboutModel(APP, rel('0.1.0', '0.2.0')).service).toBe('Service 0.1.0 · restart needed');
    expect(aboutModel(APP, rel('0.1.0', '0.1.0')).service).toBe('Service 0.1.0');
    expect(aboutModel(APP, rel('0.1.0', null)).service).toBe('Service 0.1.0');
    // the service runs the app's release: no service line, so no restart note either
    expect(aboutModel(APP, rel('0.2.0', '0.3.0')).service).toBeNull();
  });

  test('a missing or malformed release gives no service line', () => {
    for (const r of [null, undefined, {}, 'x', [], { running: '0.1.0' }, { running: 1, onDisk: null, changelog: [] }, { running: '0.1.0', onDisk: null }]) {
      expect({ r, s: aboutModel(APP, r).service }).toEqual({ r, s: null });
    }
  });

  test('a missing or malformed app answer leaves out the version line (and the link it carries), and never throws', () => {
    for (const a of [null, undefined, {}, 'x', [], { version: 1, github: GITHUB }, { version: '', github: GITHUB }, { version: '0.2.0' }, { version: '0.2.0', github: 'javascript:alert(1)' }]) {
      const m = aboutModel(a, rel('0.2.0', null));
      expect({ a, v: m.version, link: m.github }).toEqual({ a, v: null, link: null });
      expect(m.name).toBe('Andon');
      expect(m.copyright).toBe('© 2026 Matt McCray');
    }
    // with no app version, the service's release still shows (it differs from nothing known)
    expect(aboutModel(null, rel('0.2.0', null)).service).toBe('Service 0.2.0');
    expect(narrowAbout(APP)).toEqual(APP);
  });

  test("the link is the Mac app's answer: the URL is the Mac app's one GITHUB_URL, never repeated in the UI", () => {
    expect(aboutModel(APP, null).github).toEqual({ href: GITHUB, label: 'Factory on GitHub' });
    const appmenu = readFileSync(join(repo, 'apps', 'andon', 'src', 'appmenu.ts'), 'utf8');
    expect(appmenu).toContain(`export const GITHUB_URL = '${GITHUB}';`);
    expect(readFileSync(join(import.meta.dir, 'about.ts'), 'utf8')).not.toContain('github.com');
  });
});

describe('065 AC6: the art in the UI build', () => {
  const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  const source = join(repo, 'apps', 'andon', 'assets', 'about.png');
  const copy = join(app, 'public', 'about.png');

  test('public/about.png is a byte-identical copy of apps/andon/assets/about.png, and Vite copies public/ into dist/', () => {
    expect(sha(copy)).toBe(sha(source));
    expect(ART_PATH).toBe('/about.png');
    const c = isRecord(config) ? config : {};
    expect(c.publicDir).toBeUndefined(); // Vite's default: <root>/public, copied unchanged into dist/
    expect(isRecord(c.build) ? c.build.outDir : undefined).toBe('dist');
  });

  test("the service's uiFile serves it same-origin as image/png under img-src 'self'", async () => {
    expect(UI_CSP).toContain("img-src 'self'");
    const home = mkdtempSync(join(tmpdir(), 'andon-about-'));
    const service = await startService({ port: 0, registryPath: join(home, 'projects.json'), log: () => undefined, uiDir: join(app, 'public') });
    try {
      const res = await fetch(`${service.url}${ART_PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-security-policy')).toBe(UI_CSP);
      expect(createHash('sha256').update(new Uint8Array(await res.arrayBuffer())).digest('hex')).toBe(sha(source));
    } finally {
      await service.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the source image and its prompt are unchanged since they were supplied (5ec8c3b): the job never edits the art', () => {
    expect(sha(source)).toBe('85e20cbb7cdcf28718b7bdee4d499e87b6cad04db68de57cd60e6c6aa09f20b8');
    expect(sha(join(repo, 'apps', 'andon', 'assets', 'source', 'about-prompt.md'))).toBe('7ea680b1c90f4f2bfc8e9b4805aa64c73a5b5612cd7c2a7f4b948ebb25627b00');
  });
});
