import { expect, test } from 'bun:test';
import { needsHumanCount, traySpec } from './badge';
import { badgeText, dockLook, trayRunning } from './lantern';
import type { AppJob, AppState } from './state';

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const job = (id: string, stage: string): AppJob => ({ id, title: id, stage, note: '' });
const board = (...jobs: AppJob[]) => ({ jobs, error: null, rev: 1 });
/** Project A listed with the given jobs; project B has a board but isn't listed. */
const listed = (jobs: AppJob[], unlisted: AppJob[] = []): AppState => ({
  projects: [{ id: A, name: 'one' }],
  boards: { [A]: board(...jobs), [B]: board(...unlisted) },
});

test('AC1: idle for no projects, no jobs, or only merged jobs', () => {
  expect(dockLook({ projects: [], boards: {} })).toBe('idle');
  expect(dockLook(listed([]))).toBe('idle');
  expect(dockLook({ projects: [{ id: A, name: 'one' }], boards: {} })).toBe('idle'); // listed, no board yet
  expect(dockLook(listed([job('001-a', 'merged'), job('002-b', 'merged')]))).toBe('idle');
  for (const s of [listed([]), listed([job('001-a', 'merged')])]) expect(trayRunning(s)).toBe(false);
});

test('AC1: running when any listed project has a job in a running stage', () => {
  for (const stage of ['claimed', 'spec', 'build', 'review', 'approve']) {
    const s = listed([job('001-a', 'merged'), job('002-b', stage)]);
    expect({ stage, look: dockLook(s), tray: trayRunning(s) }).toEqual({ stage, look: 'running', tray: true });
  }
});

test('AC1: escalated when any job needs a human, even with others running; the tray still shows running', () => {
  const both = listed([job('001-a', 'build'), job('002-b', 'needs-human')]);
  expect(dockLook(both)).toBe('escalated');
  expect(trayRunning(both)).toBe(true);
  const alone = listed([job('001-a', 'needs-human'), job('002-b', 'merged')]);
  expect(dockLook(alone)).toBe('escalated');
  expect(trayRunning(alone)).toBe(false);
});

test('AC1: jobs of unlisted projects and unknown stages are ignored', () => {
  const s = listed([job('001-a', 'approved'), job('002-b', 'mystery')], [job('001-a', 'needs-human'), job('002-b', 'build')]);
  expect(dockLook(s)).toBe('idle');
  expect(trayRunning(s)).toBe(false);
  // across several listed projects: any one of them counts
  const two: AppState = {
    projects: [
      { id: A, name: 'one' },
      { id: B, name: 'two' },
    ],
    boards: { [A]: board(job('001-a', 'merged')), [B]: board(job('001-a', 'review')) },
  };
  expect(dockLook(two)).toBe('running');
  expect(trayRunning(two)).toBe(true);
});

test("AC2: the badge text is '' at 0 and the decimal count otherwise, matching the tray title", () => {
  expect(badgeText(0)).toBe('');
  expect(badgeText(1)).toBe('1');
  expect(badgeText(12)).toBe('12');
  for (const n of [0, 1, 2, 12, 100]) expect(badgeText(n)).toBe(traySpec(n).title);
  const s = listed([job('001-a', 'needs-human'), job('002-b', 'needs-human')], [job('003-c', 'needs-human')]);
  expect(badgeText(needsHumanCount(s))).toBe('2');
});
