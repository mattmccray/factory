// The adapter's tray hook against a fake Tiny app: no Tiny or txiki globals are touched by onTray.
import { expect, test } from 'bun:test';
import { onTray } from './backend';
import type { TinyApp, TinyWinState } from './backend';

function fakeApp(state: TinyWinState | null): { app: TinyApp; calls: string[] } {
  const calls: string[] = [];
  const app: TinyApp = {
    tray: { set: () => calls.push('tray.set') },
    notify: async () => {
      calls.push('notify');
      return true;
    },
    window: (id) => ({
      getState: async () => {
        calls.push(`${id}.getState`);
        return state;
      },
      hide: (opts) => calls.push(`${id}.hide(${JSON.stringify(opts)})`),
      restore: () => calls.push(`${id}.restore`),
      show: () => calls.push(`${id}.show`),
      eval: () => calls.push(`${id}.eval`),
    }),
    setHideOnClose: () => calls.push('setHideOnClose'),
    quit: () => calls.push('quit'),
  };
  return { app, calls };
}

const st = (visible: boolean, minimized: boolean, focused: boolean): TinyWinState => ({ visible, minimized, focused });

test('AC4: a left click on a visible, focused window hides that window only', async () => {
  const { app, calls } = fakeApp(st(true, false, true));
  await onTray(null, app);
  expect(calls).toEqual(['main.getState', 'main.hide({"app":false})']);
});

test('AC4: a left click on a hidden window, or with no state, shows it', async () => {
  for (const s of [st(false, false, false), null]) {
    const { app, calls } = fakeApp(s);
    await onTray(null, app);
    expect(calls).toEqual(['main.getState', 'main.show']);
  }
});

test('AC4: a left click on a window behind others brings it to the front', async () => {
  const { app, calls } = fakeApp(st(true, false, false));
  await onTray(null, app);
  expect(calls).toEqual(['main.getState', 'main.show']);
});

test('AC4: a left click on a minimized window restores it, then shows it', async () => {
  const { app, calls } = fakeApp(st(true, true, true));
  await onTray(null, app);
  expect(calls).toEqual(['main.getState', 'main.restore', 'main.show']);
});

test('AC4: the menu items behave as before', async () => {
  const show = fakeApp(st(true, false, true));
  await onTray('show', show.app);
  expect(show.calls).toEqual(['main.show']);
  const quit = fakeApp(st(true, false, true));
  await onTray('quit', quit.app);
  expect(quit.calls).toEqual(['quit']);
});
