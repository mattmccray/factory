import { describe, expect, test } from 'bun:test';
import { DEFAULT_PORT } from './autostart';
import { INSTALL_COMMAND, NO_SERVICE_CSP, NO_SERVICE_TITLE, START_COMMAND, noServicePage, windowLoad } from './noservice';
import type { ProbeStep } from './noservice';

const html = noServicePage();
/** The page's text, tags dropped. */
const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');

describe('071 AC1: the no-service page is one complete document naming both commands', () => {
  test('it is one complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const tag of ['<html', '<head>', '</head>', '<body>', '</body>', '</html>']) {
      expect({ tag, count: html.split(tag).length - 1 }).toEqual({ tag, count: 1 });
    }
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('<body>'));
  });

  test('its text says no service is answering and names both commands, each in <code>', () => {
    expect(NO_SERVICE_TITLE).toBe('No Andon service is answering');
    expect(INSTALL_COMMAND).toBe('factory service install');
    expect(START_COMMAND).toBe('factory service start');
    expect(text).toContain('No Andon service is answering');
    expect(html).toContain('<code>factory service install</code>');
    expect(html).toContain('<code>factory service start</code>');
    // labeled: install it, or, if it's already installed, start it
    expect(text).toMatch(/Install the service/);
    expect(text).toMatch(/already installed, start it/);
  });

  test('it is the same string every call', () => {
    expect(noServicePage()).toBe(html);
  });
});

describe('071 AC2: the page runs nothing and loads nothing, in light and dark', () => {
  test('no script, event handler, src, link, import, url(), or http(s) URL', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  test('a CSP meta allows no scripts and no network, inline styles only', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${NO_SERVICE_CSP}">`);
    const directives = NO_SERVICE_CSP.split(';').map((d) => d.trim());
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("style-src 'unsafe-inline'");
    expect(NO_SERVICE_CSP).not.toMatch(/script-src|connect-src|img-src|font-src|\*/);
  });

  test('it declares light and dark: color-scheme and a prefers-color-scheme: dark rule', () => {
    expect(html).toContain('color-scheme: light dark');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });

  test('its text is en-US', () => {
    expect(html).toContain('lang="en-US"');
  });
});

describe('071: when the main window switches', () => {
  const done = (answered: boolean, waited: boolean, port = DEFAULT_PORT): ProbeStep => ({ kind: 'done', found: { answered, waited }, port });

  test('the first miss shows the page', () => {
    expect(windowLoad({ kind: 'miss' }, true)).toBe('page');
  });

  test('the service answering after a miss loads the board, at any port', () => {
    expect(windowLoad(done(true, true), true)).toBe('board');
    expect(windowLoad(done(true, true, 9123), true)).toBe('board');
  });

  test('a service answering at once on a non-default port loads the board; at the default port, nothing', () => {
    expect(windowLoad(done(true, false, 9123), true)).toBe('board');
    expect(windowLoad(done(true, false), true)).toBe('none');
  });

  test('a wait cancelled before the service answers loads nothing', () => {
    expect(windowLoad(done(false, true), true)).toBe('none');
    expect(windowLoad(done(false, true, 9123), true)).toBe('none');
  });

  test('after Quit or a newer lifecycle, nothing loads', () => {
    expect(windowLoad({ kind: 'miss' }, false)).toBe('none');
    expect(windowLoad(done(true, true), false)).toBe('none');
    expect(windowLoad(done(true, false, 9123), false)).toBe('none');
  });
});
