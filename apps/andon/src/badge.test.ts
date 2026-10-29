import { expect, test } from 'bun:test';
import { needsHumanCount, TRAY_MENU, trayNotice, traySpec } from './badge';
import type { TrayMenuItem } from './badge';
import { dockLook } from './lantern';
import type { AppJob, AppState } from './state';

const job = (id: string, stage: string): AppJob => ({ id, title: id, stage, note: '' });

test('AC1: the count is every needs-human job across the listed projects, and nothing else', () => {
  const s: AppState = {
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'one', root: null },
      { id: 'bbbbbbbbbbbb', name: 'two', root: null },
      { id: 'cccccccccccc', name: 'three', root: null }, // listed, no board yet
    ],
    boards: {
      aaaaaaaaaaaa: { jobs: [job('001-a', 'needs-human'), job('002-b', 'review'), job('003-c', 'needs-human')], error: null, rev: 1 },
      bbbbbbbbbbbb: { jobs: [job('001-a', 'needs-human'), job('004-d', 'merged'), job('005-e', 'approved')], error: 'config.json: bad', rev: 2 },
      dddddddddddd: { jobs: [job('001-a', 'needs-human'), job('002-b', 'needs-human')], error: null, rev: 1 }, // not listed
    },
  };
  expect(needsHumanCount(s)).toBe(3);
  expect(needsHumanCount({ projects: [], boards: s.boards })).toBe(0);
});

test('AC1: the tray spec has an empty title at 0 and the count otherwise, with the tooltip in words', () => {
  expect(traySpec(0)).toEqual({ title: '', tooltip: 'Andon: all clear', menu: TRAY_MENU, primaryAction: true });
  expect(traySpec(1)).toEqual({ title: '1', tooltip: 'Andon: 1 needs a human', menu: TRAY_MENU, primaryAction: true });
  expect(traySpec(3)).toEqual({ title: '3', tooltip: 'Andon: 3 need a human', menu: TRAY_MENU, primaryAction: true });
});

test('the tray menu has "Show Andon" and "Quit"', () => {
  const labels = TRAY_MENU.flatMap((m) => ('label' in m ? [m.label] : []));
  expect(labels).toEqual(['Show Andon', 'Quit']);
});

test('AC3: every tray spec is a toggle (primaryAction) and keeps the unchanged menu', () => {
  const menu: TrayMenuItem[] = [{ id: 'show', label: 'Show Andon' }, { separator: true }, { id: 'quit', label: 'Quit' }];
  for (const spec of [traySpec(0), traySpec(1), traySpec(7), trayNotice('starting the service'), trayNotice('the service exited before answering')]) {
    expect(spec.primaryAction).toBe(true);
    expect(spec.menu).toEqual(menu);
  }
});

test('056 AC8: the tray badge counts needs-human jobs plus epics waiting on you, as the sidebar does', () => {
  const epic = (slug: string, waitingOn: string | null) => ({ slug, name: slug, state: waitingOn === null ? 'running' : 'waiting', waitingOn, note: '', members: 1 });
  const s: AppState = {
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'one', root: null },
      { id: 'bbbbbbbbbbbb', name: 'two', root: null },
    ],
    boards: {
      aaaaaaaaaaaa: { jobs: [job('001-a', 'needs-human'), job('002-b', 'build')], epics: [epic('auth', 'you'), epic('calm', null), epic('stuck', 'members')], error: null, rev: 1 },
      bbbbbbbbbbbb: { jobs: [], epics: [epic('billing', 'you')], error: null, rev: 1 },
      cccccccccccc: { jobs: [], epics: [epic('unlisted', 'you')], error: null, rev: 1 },
    },
  };
  expect(needsHumanCount(s)).toBe(3);
  expect(traySpec(needsHumanCount(s)).tooltip).toBe('Andon: 3 need a human');
  // the Dock lantern agrees: an epic waiting on you alone is escalated
  const only: AppState = { projects: [{ id: 'bbbbbbbbbbbb', name: 'two', root: null }], boards: { bbbbbbbbbbbb: { jobs: [], epics: [epic('billing', 'you')], error: null, rev: 1 } } };
  expect([needsHumanCount(only), dockLook(only)]).toEqual([1, 'escalated']);
});
