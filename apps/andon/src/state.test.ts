import { expect, test } from 'bun:test';
import { emptyState, isListed, isRemote, machineOf, setBoard, setProjects, toEpics, toJobs, toProjects } from './state';

test('AC3: each project keeps its root next to its id and name', () => {
  expect(toProjects({ projects: [{ id: 'a', name: 'one', root: '/r/one' }, { id: 'b', name: 'two', root: '/r/two', extra: 1 }] })).toEqual([
    { id: 'a', name: 'one', root: '/r/one', machine: null },
    { id: 'b', name: 'two', root: '/r/two', machine: null },
  ]);
});

test('AC3: a missing, empty, or non-string root makes the project menu-less, never drops it', () => {
  const projects = toProjects({
    projects: [{ id: 'a', name: 'one' }, { id: 'b', name: 'two', root: '' }, { id: 'c', name: 'three', root: 42 }, { id: 'd', name: 'four', root: null }, { name: 'no id', root: '/r/x' }],
  });
  expect(projects).toEqual([
    { id: 'a', name: 'one', root: null, machine: null },
    { id: 'b', name: 'two', root: null, machine: null },
    { id: 'c', name: 'three', root: null, machine: null },
    { id: 'd', name: 'four', root: null, machine: null },
  ]);
  // still listed, so the tray counts its jobs and notifications name it
  const s = setProjects(emptyState(), projects ?? []);
  for (const id of ['a', 'b', 'c', 'd']) expect(isListed(s, id)).toBe(true);
});

test('AC3: a payload that is not a project list is still null', () => {
  for (const v of [null, [], {}, { projects: 'x' }]) expect(toProjects(v)).toBeNull();
});

test("056 AC8: each job's epic and each board's epics are read tolerantly, without the contract code", () => {
  expect(toJobs([{ id: '001-a', stage: 'merged', epic: 'auth', kind: 'member' }, { id: '002-b', stage: 'build', epic: '' }, { id: '003-c', stage: 'build', epic: 7 }])).toEqual([
    { id: '001-a', title: '', stage: 'merged', note: '', epic: 'auth' },
    { id: '002-b', title: '', stage: 'build', note: '' },
    { id: '003-c', title: '', stage: 'build', note: '' },
  ]);
  expect(
    toEpics([
      { slug: 'auth', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev', members: [{ slug: 'a' }, { slug: 'b' }], extra: true },
      { slug: 'billing', title: '  Billing rewrite ', state: 'landed', waitingOn: null, members: 'x' },
      { slug: '' },
      { state: 'running' },
      'junk',
    ]),
  ).toEqual([
    { slug: 'auth', name: 'auth', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev', members: 2 },
    { slug: 'billing', name: 'Billing rewrite', state: 'landed', waitingOn: null, note: '', members: 0 },
  ]);
  for (const v of [undefined, null, {}, 'x']) expect(toEpics(v)).toEqual([]);
  const s = setBoard(setProjects(emptyState(), [{ id: 'a', name: 'one', root: null, machine: null }]), 'a', [], toEpics([{ slug: 'auth', waitingOn: 'you' }]));
  expect(s.boards.a?.epics?.map((e) => e.slug)).toEqual(['auth']);
  expect(setBoard(s, 'a', []).boards.a?.epics).toEqual([]);
});

// ---- machines (081) ----

test('081 AC1: a bare id is local and `<pid>@<machine>` is remote on that machine, whatever `machine` or `root` says', () => {
  const projects = toProjects({
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'factory', root: '/Users/me/code/factory', machine: 'rocinante' },
      { id: '1a2b3c4d5e6f@studio', name: 'factory', root: '/Users/me/code/factory', machine: 'studio' },
    ],
  });
  expect(projects).toEqual([
    { id: 'aaaaaaaaaaaa', name: 'factory', root: '/Users/me/code/factory', machine: null },
    { id: '1a2b3c4d5e6f@studio', name: 'factory', root: '/Users/me/code/factory', machine: 'studio' },
  ]);
  expect((projects ?? []).map(isRemote)).toEqual([false, true]);
});

test("081 AC1: a bare-id entry's `machine` field never makes it remote, nor does its root; the id's suffix alone does", () => {
  const projects = toProjects({
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'a', root: '/Volumes/studio/code', machine: 'studio' },
      { id: 'bbbbbbbbbbbb', name: 'b', root: null, machine: 42 },
      { id: 'cccccccccccc', name: 'c', root: '/r/c' },
      { id: 'dddddddddddd@studio', name: 'd', root: '/r/d', machine: 'rocinante' },
      { id: 'eeeeeeeeeeee@studio', name: 'e' },
    ],
  });
  expect((projects ?? []).map((p) => [p.id, p.machine])).toEqual([
    ['aaaaaaaaaaaa', null],
    ['bbbbbbbbbbbb', null],
    ['cccccccccccc', null],
    ['dddddddddddd@studio', 'studio'],
    ['eeeeeeeeeeee@studio', 'studio'],
  ]);
});

test('081 AC1: machineOf splits at the first @; an id with an empty pid or machine is neither, and is skipped', () => {
  expect(machineOf('aaaaaaaaaaaa')).toEqual({ machine: null });
  expect(machineOf('1a2b3c4d5e6f@studio')).toEqual({ machine: 'studio' });
  expect(machineOf('1a2b3c4d5e6f@mac-mini-2')).toEqual({ machine: 'mac-mini-2' });
  for (const id of ['@studio', 'aaaaaaaaaaaa@', '@']) expect({ id, at: machineOf(id) }).toEqual({ id, at: null });
  expect(toProjects({ projects: [{ id: '@studio', name: 'x' }, { id: 'aaaaaaaaaaaa@', name: 'y' }, { id: 'bbbbbbbbbbbb', name: 'z' }] })?.map((p) => p.id)).toEqual(['bbbbbbbbbbbb']);
});
