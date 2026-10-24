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
      restore: () => calls.push(`${id}.restore`),
      setAllSpaces: (on) => calls.push(`${id}.allSpaces(${on})`),
      show: () => calls.push(`${id}.show`),
      eval: () => calls.push(`${id}.eval`),
    }),
    setHideOnClose: () => calls.push('setHideOnClose'),
    quit: () => calls.push('quit'),
  };
  return { app, calls };
}

// The adapter reads only `minimized`, `fullscreen`, and `allSpaces`; Tiny's `visible` and `focused`
// play no part (rework 2), so a window in front and one hidden look the same to it.
const st = (minimized: boolean, fullscreen = false): TinyWinState => ({ minimized, fullscreen, allSpaces: false });
/** Show on the Space the user is on: join every Space, show, then pin it back to one. */
const showHere = (...mid: string[]): string[] => ['main.getState', 'main.allSpaces(true)', ...mid, 'main.show', 'main.allSpaces(false)'];

test('AC4 (rework 2): a left click shows the window on this Space and never hides it: hidden, behind, or in front', async () => {
  for (const s of [st(false), null]) {
    const { app, calls } = fakeApp(s);
    await onTray(null, app);
    expect(calls).toEqual(showHere());
  }
});

test('AC4: a left click on a minimized window restores it, then shows it', async () => {
  const { app, calls } = fakeApp(st(true));
  await onTray(null, app);
  expect(calls).toEqual(showHere('main.restore'));
});

test('rework 1: a fullscreen window is shown where it is, without joining every Space', async () => {
  const { app, calls } = fakeApp(st(false, true));
  await onTray(null, app);
  expect(calls).toEqual(['main.getState', 'main.show']);
});

test('rework 1: a second left click while the first is still showing the window is dropped', async () => {
  const { app, calls } = fakeApp(st(false));
  await Promise.all([onTray(null, app), onTray(null, app)]);
  expect(calls).toEqual(showHere());
});

test('AC4: the menu items behave as before', async () => {
  const show = fakeApp(st(false));
  await onTray('show', show.app);
  expect(show.calls).toEqual(['main.show']);
  const quit = fakeApp(st(false));
  await onTray('quit', quit.app);
  expect(quit.calls).toEqual(['quit']);
});
