// The drawer's file list, ported from the vendored dashboard: the job's own files (and its brief)
// first, then one group per review round, each file marked with its verdict.
import type { DocFile } from './api';

export const TIMING = '#timing';

export interface FileGroup {
  name: string; // "Job" or "Round <n>"
  files: Array<{ path: string; label: string; verdict: string | null }>;
}

/** The verdict a review or decision opens with, if any. */
export function verdictOf(text: string): string | null {
  const first = text.split('\n', 1)[0] ?? '';
  return first.match(/^(?:VERDICT:\s*)?(PASS|CHANGES|APPROVE|ESCALATE)\b/)?.[1] ?? null;
}

const labelOf = (path: string): string => (path.startsWith('briefs/') ? 'brief' : (path.split('/').pop() ?? path).replace('review-', ''));

export function groupsOf(files: readonly DocFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>([['Job', { name: 'Job', files: [] }]]);
  for (const f of files) {
    const round = f.path.match(/\/round-(\d+)\//);
    const name = round !== null ? `Round ${round[1]}` : 'Job';
    let g = groups.get(name);
    if (g === undefined) {
      g = { name, files: [] };
      groups.set(name, g);
    }
    g.files.push({ path: f.path, label: labelOf(f.path), verdict: verdictOf(f.text) });
  }
  return [...groups.values()];
}

/**
 * The file the drawer shows: the current one while it still exists, else the latest file that
 * isn't feature.md, else the first. `TIMING` stays selected only while the job has timing.
 */
export function pickFile(current: string | null, files: readonly DocFile[], hasTiming: boolean): string | null {
  if (current === TIMING && hasTiming) return TIMING;
  if (current !== null && current !== TIMING && files.some((f) => f.path === current)) return current;
  const notFeature = files.filter((f) => !f.path.endsWith('feature.md'));
  return notFeature[notFeature.length - 1]?.path ?? files[0]?.path ?? null;
}
