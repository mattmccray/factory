// Test fixtures: jobs as the agent sends them (plain JSON), narrowed the way the UI narrows them.
import type { BoardJob } from './board';
import { toJob } from './job';
import type { Job } from './job';

export const NOW = Date.parse('2026-10-22T12:00:00.000Z');
export const HOUR = 3_600_000;
/** An ISO time `ms` before `NOW`. */
export const before = (ms: number): string => new Date(NOW - ms).toISOString();

/** A job.json value (unknown fields allowed), narrowed. */
export function job(fields: Record<string, unknown>): Job {
  const j = toJob({ title: 'A job', branch: 'factory/x', stage: 'spec', round: 0, ...fields });
  if (j === null) throw new Error('fixture has no id');
  return j;
}

export function tag(j: Job, project = { id: 'p1', name: 'one' }, settleAfterHours = 24, reviewers: string[] = []): BoardJob {
  return { key: `${project.id}/${j.id}`, project, settleAfterHours, reviewers, job: j };
}
