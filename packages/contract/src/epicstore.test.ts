import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './contract';
import { parseEpicEventInput } from './epic';
import { appendEpicEvent, epicSlugs, readEpicJobs, rebuildEpic, startEpic } from './epicstore';
import { appendEvent, claimJob, rebuildAll } from './store';

const config = parseConfig({ schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } });
const started = parseEpicEventInput('epic.started', {}, { slug: 'auth', target: 'main' });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'factory-epicstore-'));
  await mkdir(join(root, 'epics'));
  await mkdir(join(root, 'briefs'));
  await writeFile(join(root, 'epics', 'auth.md'), '- Status: ready\n\n## Members\n- `a`\n- `b` after: `a`\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('startEpic', () => {
  test('a failing setup leaves no epic dir (nor the jobs/epics/ it made); a failing start runs the undo', async () => {
    await expect(startEpic(root, 'auth', started, undefined, async () => {
      throw new Error('git said no');
    })).rejects.toThrow('git said no');
    expect((await readdir(root)).sort()).toEqual(['briefs', 'epics']);

    let undone = false;
    // A torn-tail log can't exist on a fresh dir, so make the append itself fail: a log path that is a directory.
    await expect(startEpic(root, 'auth', started, undefined, async () => {
      await mkdir(join(root, 'jobs', 'epics', 'auth', 'events.jsonl'));
      return async () => {
        undone = true;
      };
    })).rejects.toThrow();
    expect(undone).toBe(true);
    expect((await readdir(root)).sort()).toEqual(['briefs', 'epics']);
  });

  test('a second start is refused before setup runs', async () => {
    await startEpic(root, 'auth', started);
    let ran = false;
    await expect(startEpic(root, 'auth', started, undefined, async () => {
      ran = true;
      return async () => undefined;
    })).rejects.toThrow('epic auth has already started: one run per plan');
    expect(ran).toBe(false);
    expect(await epicSlugs(root)).toEqual(['auth']);
  });

  test('a bad slug is refused before any path is built', async () => {
    await expect(startEpic(root, '../x', started)).rejects.toThrow(/must match/);
    expect((await readdir(root)).sort()).toEqual(['briefs', 'epics']);
  });
});

describe('epic.json refresh', () => {
  const epicJson = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(root, 'jobs', 'epics', 'auth', 'epic.json'), 'utf8'));

  test('every job event rewrites epic.json; a torn epic log never fails the job event', async () => {
    await startEpic(root, 'auth', started);
    const { id } = await claimJob(root, 'a', { fields: { epic: 'auth', brief: 'factory/briefs/a.md' }, config, target: 'factory/epic/auth' });
    expect(await readEpicJobs(root, 'auth')).toEqual([{ id, stage: 'claimed', kind: 'member', brief: 'factory/briefs/a.md', updated: expect.any(String) }]);
    await appendEvent(root, id, { type: 'stage.entered', stage: 'spec' });
    expect(await epicJson()).toMatchObject({ members: [{ slug: 'a', state: 'running', stage: 'spec' }, { slug: 'b', state: 'blocked' }] });

    await appendFile(join(root, 'jobs', 'epics', 'auth', 'events.jsonl'), '{"ts":');
    const before = await epicJson();
    expect((await appendEvent(root, id, { type: 'stage.entered', stage: 'build' })).stage).toBe('build');
    expect(await epicJson()).toEqual(before);
    await expect(appendEpicEvent(root, 'auth', { type: 'epic.waiting', reason: 'x' })).rejects.toThrow(/corrupt tail/);
    await expect(rebuildEpic(root, 'auth')).rejects.toThrow(/not valid JSON/);
  });

  test('a missing plan is a planError, not a failure; rebuildAll covers every epic', async () => {
    await startEpic(root, 'auth', started);
    await rm(join(root, 'epics', 'auth.md'));
    const snap = await rebuildEpic(root, 'auth');
    expect(snap).toMatchObject({ planError: 'plan factory/epics/auth.md is missing', members: [] });
    expect(await rebuildAll(root)).toEqual({ jobs: [], epics: ['auth'] });
  });
});
