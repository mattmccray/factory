import { expect, test } from 'bun:test';
import { needsHumanCount, TRAY_MENU, trayNotice, traySpec } from './badge';
import type { TrayMenuItem } from './badge';
import type { ShellJob, ShellState } from './state';

const job = (id: string, stage: string): ShellJob => ({ id, title: id, stage, note: '' });

test('AC1: the count is every needs-human job across the listed projects, and nothing else', () => {
  const s: ShellState = {
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'one' },
      { id: 'bbbbbbbbbbbb', name: 'two' },
      { id: 'cccccccccccc', name: 'three' }, // listed, no board yet
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
  for (const spec of [traySpec(0), traySpec(1), traySpec(7), trayNotice('starting the agent'), trayNotice('the agent exited before answering')]) {
    expect(spec.primaryAction).toBe(true);
    expect(spec.menu).toEqual(menu);
  }
});
