import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  checkTransition,
  formatShow,
  parseConfig,
  parseEventInput,
  parseFields,
  project,
  readLog,
  readVerdict,
  rebuild,
} from '@factory/contract';
import type { Config, EventInput, FactoryEvent, JobSnapshot } from '@factory/contract';

describe('@factory/contract index', () => {
  test('exports every public function', () => {
    const fns: unknown[] = [parseConfig, parseEventInput, checkTransition, project, readLog, readVerdict, appendEvent, rebuild, parseFields, formatShow];
    expect(fns).toHaveLength(10);
    for (const fn of fns) expect(typeof fn).toBe('function');
  });

  test('parses the fixture config and projects job.claimed -> stage.entered spec', async () => {
    const raw: unknown = await Bun.file(new URL('./fixtures/config.json', import.meta.url)).json();
    const config: Config = parseConfig(raw);
    const inputs: EventInput[] = [
      parseEventInput('job.claimed', {}, { id: '001-smoke', config }),
      parseEventInput('stage.entered', { stage: 'spec' }),
    ];
    const log: FactoryEvent[] = [];
    inputs.forEach((input, i) => {
      checkTransition(log, input);
      log.push({ ...input, ts: new Date(Date.UTC(2026, 9, 22, 14, i)).toISOString() });
    });
    const snap: JobSnapshot = project(log);
    expect(snap.id).toBe('001-smoke');
    expect(snap.stage).toBe('spec');
    expect(snap.maxRound).toBe(config.maxRound);
  });

  test('a reader ignores unknown event fields and unknown event types (docs/contract/v1.md Versioning)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-index-'));
    try {
      await mkdir(join(root, 'jobs', '001-smoke'), { recursive: true });
      const lines = [
        { ts: '2026-10-22T14:00:00.000Z', type: 'job.claimed', schema: 'factory/v1', id: '001-smoke', maxRound: 2, brief: null, issue: null },
        { ts: '2026-10-22T14:01:00.000Z', type: 'stage.entered', stage: 'spec', futureField: 1 },
        { ts: '2026-10-22T14:02:00.000Z', type: 'job.future-event', whatever: true },
      ];
      await writeFile(join(root, 'jobs', '001-smoke', 'events.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
      const snap = project(await readLog(root, '001-smoke'));
      expect(snap.stage).toBe('spec');
      expect(snap.stageEnteredAt).toBe('2026-10-22T14:01:00.000Z');
      expect(snap.timing.stages).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
