import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archivedIds } from './archive';
import { CONFIG, Fixture, plan } from './epicfixture';

const ON = { ...CONFIG, archive: { enabled: true } };
const HOUR = 3_600_000;
const REF = 'refs/heads/factory/archive';

const f = new Fixture();
beforeEach(() => f.setUp(ON));
afterEach(() => f.tearDown());

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const tip = (): string | null => {
  try {
    return f.git('rev-parse', '--verify', '--quiet', REF);
  } catch {
    return null;
  }
};
const later = (hours: number): (() => Date) => {
  const at = new Date(Date.now() + hours * HOUR);
  return () => at;
};

// Starts `auth` over member `a`, merges it, and lands the epic; returns the member's job id.
async function landed(): Promise<string> {
  await f.start('auth', ['a']);
  const a = await f.claimMember('auth', 'a');
  await f.merge(a);
  await f.ok('epic', 'event', 'auth', 'epic.landing');
  await f.ok('epic', 'event', 'auth', 'epic.landed', 'sha=0123456');
  return a;
}

describe('archive: epics (AC7)', () => {
  test('a landed epic goes under epics/<slug>/ with events.jsonl and plan.md, Factory-Epic and Landed-As', async () => {
    await landed();
    const r = await f.cli('archive', 'auth');
    expect(r.err).toEqual([]);
    const commit = tip() ?? '';
    expect(r.out).toEqual([`archived epic auth ${commit.slice(0, 7)}`]);
    expect(f.git('ls-tree', '--name-only', commit)).toBe('epics');
    expect(f.git('ls-tree', '--name-only', `${commit}:epics/auth`).split('\n')).toEqual(['events.jsonl', 'plan.md']);
    expect(f.git('show', `${commit}:epics/auth/plan.md`)).toBe((await readFile(join(f.root, 'epics', 'auth.md'), 'utf8')).trimEnd());
    expect(f.git('show', `${commit}:epics/auth/events.jsonl`)).toBe((await readFile(join(f.root, 'jobs', 'epics', 'auth', 'events.jsonl'), 'utf8')).trimEnd());
    expect(f.git('log', '-1', '--format=%B', commit)).toBe('chore(factory): archive epic auth\n\nFactory-Epic: auth\nLanded-As: 0123456');
    expect(f.git('rev-parse', 'HEAD')).toBe(f.git('rev-parse', 'main'));

    expect(await f.cli('archive', 'auth')).toEqual({ code: 0, out: ['epic auth: already archived (unchanged)'], err: [] });
    await writeFile(join(f.root, 'epics', 'auth.md'), plan('done', ['- `a`']));
    expect((await f.cli('archive', 'auth')).err).toEqual(['epic auth: changed since it was archived on factory/archive; run archive auth --force to add a new commit']);
    expect(tip()).toBe(commit);
    const forced = await f.cli('archive', 'auth', '--force');
    expect(forced.code).toBe(0);
    expect(f.git('rev-parse', `${tip() ?? ''}^`)).toBe(commit);
  });

  test('an abandoned epic has no Landed-As; a running epic and a missing plan are refused, writing nothing', async () => {
    await f.start('auth', ['a']);
    expect(await f.cli('archive', 'auth')).toEqual({ code: 1, out: [], err: ['epic auth is running: only landed or abandoned epics are archived'] });
    await f.ok('epic', 'abandon', 'auth', 'dropped');
    await rm(join(f.root, 'epics', 'auth.md'));
    expect((await f.cli('archive', 'auth')).err).toEqual(['epic auth: plan factory/epics/auth.md is missing; not archived']);
    expect(tip()).toBeNull();
    await f.writePlan('auth', plan('abandoned', ['- `a`']));
    expect((await f.cli('archive', 'auth')).code).toBe(0);
    expect(f.git('log', '-1', '--format=%B', REF)).toBe('chore(factory): archive epic auth\n\nFactory-Epic: auth');
  });

  test('a different epic at the same slug is refused, even with --force', async () => {
    await f.start('auth', ['a']);
    await f.ok('epic', 'abandon', 'auth', 'first', '--delete-branch');
    await f.ok('archive', 'auth');
    const first = tip();
    await rm(join(f.root, 'jobs', 'epics', 'auth'), { recursive: true });
    await f.ok('epic', 'start', 'auth');
    await f.ok('epic', 'abandon', 'auth', 'second');
    const r = await f.cli('archive', 'auth', '--force');
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/^epic auth: factory\/archive already holds a different epic at epics\/auth\/ \(archived: epic\.started slug=auth ts=.*; local: epic\.started slug=auth ts=.*\); nothing written$/);
    expect(tip()).toBe(first);
  });

  test('archive --all includes terminal epics and skips running ones; archived epics never count toward job numbers', async () => {
    const a = await landed();
    await f.briefs('ready', 'b');
    await f.writePlan('other', plan('ready', ['- `b`']));
    await f.ok('epic', 'start', 'other');
    const r = await f.cli('archive', '--all');
    expect(r.err).toEqual([]);
    expect(r.out[0]).toMatch(new RegExp(`^archived ${a} [0-9a-f]{7}$`));
    expect(r.out[1]).toMatch(/^archived epic auth [0-9a-f]{7}$/);
    expect(r.out[2]).toBe('archive --all: archived 2, unchanged 0, skipped 1 (not merged or abandoned), failed 0');
    expect(await archivedIds(f.repo)).toEqual([a]);
    expect(await f.ok('claim', 'next')).toEqual(['002-next']);
  });
});

describe('prune: epics and their jobs (AC7)', () => {
  test('a merged, archived member of a running epic is never pruned, past the window included', async () => {
    await f.start('auth', ['a', 'b']);
    const a = await f.claimMember('auth', 'a');
    await f.merge(a);
    await f.ok('archive', a);
    f.now = later(48);
    const r = await f.cli('prune');
    expect(r.out).toEqual([`kept ${a}: its epic auth is not landed or abandoned (running)`, 'kept epic auth: not landed or abandoned (running)', 'prune: removed 0, kept 2, failed 0']);
    expect(await exists(join(f.root, 'jobs', a))).toBe(true);
  });

  test('once the epic lands, members settle by its endedAt; the epic dir goes once archived, settled, and unchanged', async () => {
    const a = await landed();
    await f.ok('archive', '--all');
    f.now = later(1);
    expect((await f.cli('prune')).out).toEqual([`kept ${a}: not settled`, 'kept epic auth: not settled', 'prune: removed 0, kept 2, failed 0']);
    f.now = later(48);
    await writeFile(join(f.root, 'epics', 'auth.md'), plan('done', ['- `a`']));
    expect((await f.cli('prune')).out).toEqual([`pruned ${a}`, 'kept epic auth: differs from its archived tree', 'prune: removed 1, kept 1, failed 0']);
    await f.ok('archive', 'auth', '--force');
    expect((await f.cli('prune')).out).toEqual(['pruned epic auth', 'prune: removed 1, kept 0, failed 0']);
    expect(await exists(join(f.root, 'jobs', 'epics', 'auth'))).toBe(false);
    expect(await exists(join(f.root, 'epics', 'auth.md'))).toBe(true);
  });

  test('an abandoned epic settles at once; an unarchived one is kept; a pruned epic still settles its members from the archive', async () => {
    await f.start('auth', ['a']);
    const a = await f.claimMember('auth', 'a');
    await f.merge(a);
    await f.ok('epic', 'abandon', 'auth', 'dropped');
    expect((await f.cli('prune')).out).toEqual([`kept ${a}: not archived`, 'kept epic auth: not archived', 'prune: removed 0, kept 2, failed 0']);
    await f.ok('archive', 'auth');
    expect((await f.cli('prune')).out).toEqual([`kept ${a}: not archived`, 'pruned epic auth', 'prune: removed 1, kept 1, failed 0']);
    // rebuilding a job whose epic dir was pruned rebuilds the job and skips the epic
    expect(await f.cli('rebuild', a)).toEqual({ code: 0, out: [`rebuilt 1: ${a}`], err: [] });
    await f.ok('archive', a);
    expect((await f.cli('prune')).out).toEqual([`pruned ${a}`, 'prune: removed 1, kept 0, failed 0']);
  });

  test('an epic with an event in flight is kept', async () => {
    await f.start('auth', ['a']);
    await f.ok('epic', 'abandon', 'auth', 'dropped');
    await f.ok('archive', 'auth');
    await Bun.write(join(f.root, 'jobs', 'epics', 'auth', '.events.lock', 'x'), '');
    expect((await f.cli('prune')).out).toEqual(['kept epic auth: an event is in flight (.events.lock)', 'prune: removed 0, kept 1, failed 0']);
  });
});
