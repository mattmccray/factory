import { expect, test } from 'bun:test';
import { isListed, setProjects, emptyState, toProjects } from './state';

test('AC3: each project keeps its root next to its id and name', () => {
  expect(toProjects({ projects: [{ id: 'a', name: 'one', root: '/r/one' }, { id: 'b', name: 'two', root: '/r/two', extra: 1 }] })).toEqual([
    { id: 'a', name: 'one', root: '/r/one' },
    { id: 'b', name: 'two', root: '/r/two' },
  ]);
});

test('AC3: a missing, empty, or non-string root makes the project menu-less, never drops it', () => {
  const projects = toProjects({
    projects: [{ id: 'a', name: 'one' }, { id: 'b', name: 'two', root: '' }, { id: 'c', name: 'three', root: 42 }, { id: 'd', name: 'four', root: null }, { name: 'no id', root: '/r/x' }],
  });
  expect(projects).toEqual([
    { id: 'a', name: 'one', root: null },
    { id: 'b', name: 'two', root: null },
    { id: 'c', name: 'three', root: null },
    { id: 'd', name: 'four', root: null },
  ]);
  // still listed, so the tray counts its jobs and notifications name it
  const s = setProjects(emptyState(), projects ?? []);
  for (const id of ['a', 'b', 'c', 'd']) expect(isListed(s, id)).toBe(true);
});

test('AC3: a payload that is not a project list is still null', () => {
  for (const v of [null, [], {}, { projects: 'x' }]) expect(toProjects(v)).toBeNull();
});
