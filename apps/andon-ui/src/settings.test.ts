import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET_SETTINGS_METHOD, HANDOFF_CHOICES, SET_SETTING_METHOD, narrowSettings, settingsCaller, showsMerged, showsStatusBar } from './settings';

const S = { statusBarHidden: false, t3Handoff: 'draft', mergedHidden: false, t3Found: true } as const;
import { appView, pushSubscriber, shellMode } from './sidebar';

describe('035 AC6: which view a URL gets', () => {
  test('only shell=mac together with view=settings is the settings view', () => {
    for (const q of ['?shell=mac&view=settings', '?view=settings&shell=mac', 'shell=mac&view=settings', '?shell=mac&view=settings&x=1']) expect({ q, v: appView(q) }).toEqual({ q, v: 'settings' });
  });

  test('every other URL is the board, including a plain browser with view=settings', () => {
    for (const q of ['', '?', '?shell=mac', '?view=settings', '?shell=browser&view=settings', '?shell=mac&view=board', '?shell=mac&view=Settings', '?shell=mac&view=', '?shell=MAC&view=settings', '?shell=mac&view=settingsx']) {
      expect({ q, v: appView(q) }).toEqual({ q, v: 'board' });
    }
  });

  test('a plain browser never hears the status bar event, so its status bar always shows', () => {
    const host = { api: { on: () => () => undefined, call: async () => ({ statusBarHidden: true }) } };
    expect(pushSubscriber(shellMode('?view=settings'), host)).toBeNull();
    expect(pushSubscriber(shellMode(''), host)).toBeNull();
  });
});

describe('035 AC6: the settings caller', () => {
  test('null outside the Mac app, or when Tiny or its api.call is missing', () => {
    const host = { api: { call: async () => ({ statusBarHidden: false }) } };
    expect(settingsCaller('browser', host)).toBeNull();
    expect(settingsCaller(shellMode('?view=settings'), host)).toBeNull();
    for (const h of [undefined, null, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect(settingsCaller('mac', h)).toBeNull();
  });

  test('get and set call the two fixed methods, with only the status bar change', async () => {
    const calls: unknown[][] = [];
    let hidden = false;
    const host = {
      api: {
        call: async (method: string, params: unknown) => {
          calls.push([method, params]);
          if (method === SET_SETTING_METHOD) hidden = true;
          return { ...S, statusBarHidden: hidden };
        },
      },
    };
    const api = settingsCaller('mac', host);
    if (api === null) throw new Error('no caller');
    expect(await api.get()).toEqual({ ...S, statusBarHidden: false });
    expect(await api.setStatusBarHidden(true)).toEqual({ ...S, statusBarHidden: true });
    expect(await api.setT3Handoff('send')).toEqual({ ...S, statusBarHidden: true });
    expect(calls).toEqual([
      ['getSettings', null],
      ['setSetting', { key: 'statusBarHidden', value: true }],
      ['setSetting', { key: 't3Handoff', value: 'send' }],
    ]);
    expect([GET_SETTINGS_METHOD, SET_SETTING_METHOD]).toEqual(['getSettings', 'setSetting']);
  });

  test('a refused, failed, or malformed answer is null', async () => {
    const answers: (() => unknown)[] = [
      () => null,
      () => undefined,
      () => ({ statusBarHidden: 'yes' }),
      () => ({}),
      () => Promise.reject(new Error('denied')),
      () => {
        throw new Error('gone');
      },
    ];
    for (const a of answers) {
      const api = settingsCaller('mac', { api: { call: a } });
      expect(await api?.get()).toBeNull();
      expect(await api?.setStatusBarHidden(false)).toBeNull();
      expect(await api?.setT3Handoff('copy')).toBeNull();
    }
  });
});

describe('035: the settings payload', () => {
  test('narrowed to a boolean statusBarHidden; the checkbox is checked when it is false', () => {
    expect(narrowSettings({ ...S, statusBarHidden: true })).toEqual({ ...S, statusBarHidden: true });
    expect(narrowSettings({ ...S, other: 1 })).toEqual(S);
    for (const d of [null, undefined, 'x', [], { ...S, statusBarHidden: 1 }, { hidden: true }]) expect(narrowSettings(d)).toBeNull();
    expect(showsStatusBar({ ...S, statusBarHidden: false })).toBe(true);
    expect(showsStatusBar({ ...S, statusBarHidden: true })).toBe(false);
  });

  test('036 AC7: narrowed with the T3 Code choice (one of three) and whether t3 was found', () => {
    for (const t3Handoff of ['draft', 'send', 'copy'] as const) for (const t3Found of [true, false]) expect(narrowSettings({ statusBarHidden: false, t3Handoff, mergedHidden: false, t3Found })).toEqual({ statusBarHidden: false, t3Handoff, mergedHidden: false, t3Found });
    for (const d of [{ statusBarHidden: false }, { ...S, t3Handoff: 'auto' }, { ...S, t3Handoff: null }, { ...S, t3Found: 'yes' }, { statusBarHidden: false, t3Handoff: 'draft' }, { statusBarHidden: false, t3Found: true }]) expect({ d, s: narrowSettings(d) }).toEqual({ d, s: null });
    expect(HANDOFF_CHOICES).toEqual([
      { mode: 'draft', label: 'Open a draft in T3 Code' },
      { mode: 'send', label: 'Send in T3 Code right away' },
      { mode: 'copy', label: 'Copy only' },
    ]);
  });
});

describe('063 AC2: the Merged column setting in the page', () => {
  test('narrowSettings requires mergedHidden to be a boolean', () => {
    expect(narrowSettings({ ...S, mergedHidden: true })).toEqual({ ...S, mergedHidden: true });
    const { mergedHidden: _drop, ...without } = S;
    for (const d of [without, { ...S, mergedHidden: 'true' }, { ...S, mergedHidden: 1 }, { ...S, mergedHidden: null }, { ...S, mergedHidden: undefined }]) expect({ d, s: narrowSettings(d) }).toEqual({ d, s: null });
  });

  test('"Show Merged column" is checked when the column is shown', () => {
    expect(showsMerged({ ...S, mergedHidden: false })).toBe(true);
    expect(showsMerged({ ...S, mergedHidden: true })).toBe(false);
  });

  test('the caller sets it with the one fixed method and only the Merged change; refused or malformed answers are null', async () => {
    const calls: unknown[][] = [];
    const api = settingsCaller('mac', {
      api: {
        call: async (method: string, params: unknown) => {
          calls.push([method, params]);
          return { ...S, mergedHidden: true };
        },
      },
    });
    expect(await api?.setMergedHidden(true)).toEqual({ ...S, mergedHidden: true });
    expect(calls).toEqual([['setSetting', { key: 'mergedHidden', value: true }]]);
    for (const a of [() => null, () => ({ ...S, mergedHidden: 'yes' }), () => Promise.reject(new Error('denied'))]) expect(await settingsCaller('mac', { api: { call: a } })?.setMergedHidden(false)).toBeNull();
    expect(settingsCaller('browser', { api: { call: async () => S } })).toBeNull();
  });

  test('Settings.svelte has the checkbox, follows the pushed Merged event, and sets through the caller', () => {
    const src = readFileSync(join(import.meta.dir, 'Settings.svelte'), 'utf8');
    expect(src).toContain('<input type="checkbox" checked={settings !== null && showsMerged(settings)} disabled={settings === null} onchange={onmerged} />');
    expect(src).toContain('<span>Show Merged column</span>');
    expect(src).toContain('subscribe?.(MERGED_EVENT,');
    expect(src).toContain('await api?.setMergedHidden(!show)');
  });
});
