import { describe, expect, test } from 'bun:test';
import { HUB, LOCAL_FACTORY, STUDIO_FACTORY, localAt, machineEntry, machinesBody } from './fixtures';
import { asOfText, hasPeers, hubName, machineAsOf, machineOrder, nowFor, placed, projectLabel, remoteOf, remoteOfId } from './machines';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';
import type { ProjectInfo } from './job';

const iso = (t: number): string => new Date(t).toISOString();
const listed = (): UiState => applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
const withMachines = (...entries: Array<Record<string, unknown>>): UiState => applyEvent(listed(), 'machines', machinesBody(...entries));

describe('remote and local (brief andon-machines-ui)', () => {
  test('the hub is the first listed machine; a project is remote when its machine differs from it', () => {
    const s = withMachines(machineEntry(HUB), machineEntry('studio'));
    expect(hubName(s)).toBe(HUB);
    expect(hasPeers(s)).toBe(true);
    expect([remoteOfId(s, LOCAL_FACTORY.id), remoteOfId(s, STUDIO_FACTORY.id), remoteOfId(s, 'unlisted')]).toEqual([null, 'studio', null]);
  });

  test('never guessed from the root: a project with no machine is local, whatever its root or id', () => {
    const s = withMachines(machineEntry(HUB), machineEntry('studio'));
    const p: ProjectInfo = { id: 'dddddddddddd', name: 'factory', root: '/Volumes/studio/factory' };
    expect(remoteOf(s, p)).toBeNull();
  });

  test('no machines data, or only the hub listed: every project is local', () => {
    for (const s of [listed(), withMachines(machineEntry(HUB))]) {
      expect(hasPeers(s)).toBe(false);
      expect(s.projects.map((p) => remoteOfId(s, p.id))).toEqual([null, null]);
      expect(placed(s, s.projects).map((p) => p.remote)).toEqual([undefined, undefined]);
    }
  });

  test('the label: "<name> · <machine>" for a remote project, the name for a local one', () => {
    expect(projectLabel({ name: 'factory', remote: 'studio' })).toBe('factory · studio');
    expect(projectLabel({ name: 'factory' })).toBe('factory');
  });

  test('machines in sidebar order: the hub first, then the peers by name', () => {
    const s = withMachines(machineEntry(HUB), machineEntry('studio'), machineEntry('Agentbox'), machineEntry('beta'));
    expect(machineOrder(s.machines.list).map((m) => m.name)).toEqual([HUB, 'Agentbox', 'beta', 'studio']);
    expect(machineOrder([])).toEqual([]);
  });
});

describe('stale machines and their as-of time (AC5)', () => {
  test("down: stale at its since; the connecting after it: still at the down's since; live: not stale", () => {
    let s = withMachines(machineEntry(HUB), machineEntry('studio', 'down', iso(localAt(14, 2))));
    expect(machineAsOf(s, 'studio')).toBe(localAt(14, 2));
    expect(placed(s, s.projects)[1]).toMatchObject({ remote: 'studio', asOf: localAt(14, 2) });
    expect(nowFor(s, STUDIO_FACTORY.id, localAt(17, 0))).toBe(localAt(14, 2));
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'connecting', iso(localAt(16, 0)))));
    expect(machineAsOf(s, 'studio')).toBe(localAt(14, 2));
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'live', iso(localAt(16, 1)))));
    expect(machineAsOf(s, 'studio')).toBeNull();
    expect(nowFor(s, STUDIO_FACTORY.id, localAt(17, 0))).toBe(localAt(17, 0));
    expect(placed(s, s.projects)[1]).toEqual({ ...STUDIO_FACTORY, remote: 'studio' });
  });

  test('connecting with no down seen (the page opened then): stale at its current since; error is never stale', () => {
    expect(machineAsOf(withMachines(machineEntry(HUB), machineEntry('studio', 'connecting', iso(localAt(14, 20)))), 'studio')).toBe(localAt(14, 20));
    expect(machineAsOf(withMachines(machineEntry(HUB), machineEntry('studio', 'error', iso(localAt(14, 20)))), 'studio')).toBeNull();
    expect(machineAsOf(withMachines(machineEntry(HUB)), 'studio')).toBeNull();
  });

  test('the hub is always live: its projects count from the clock', () => {
    const s = withMachines(machineEntry(HUB), machineEntry('studio', 'down', iso(localAt(14, 2))));
    expect(nowFor(s, LOCAL_FACTORY.id, localAt(17, 0))).toBe(localAt(17, 0));
  });

  test('"as of 14:02", with a short date when not today', () => {
    expect(asOfText(localAt(14, 2), localAt(16, 0))).toBe('as of 14:02');
    expect(asOfText(localAt(14, 2, 21), localAt(16, 0))).toBe('as of Oct 21 14:02');
  });
});
