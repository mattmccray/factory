import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCHIVE_REF, parseBatch, parseTree, spawnGit, wanted } from './archive';

const enc = new TextEncoder();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('ls-tree parsing (AC6)', () => {
  test('keeps only regular-file blobs under a top-level job-id dir, at paths the service reads', () => {
    const recs = [
      `100644 blob ${A}\t001-first-job/events.jsonl`,
      `100755 blob ${A}\t001-first-job/spec.md`,
      `100644 blob ${A}\t001-first-job/round-1/review-code.md`,
      `100644 blob ${A}\t001-first-job/round-1/code/shot.png`, // a supporting file: not served
      `100644 blob ${A}\t001-first-job/round-1/code/notes.md`, // nested below a round: not served
      `100644 blob ${A}\t001-first-job/notes.txt`,
      `120000 blob ${A}\t001-first-job/build.md`, // a symlink
      `160000 commit ${A}\t001-first-job/decision.md`, // a submodule
      `040000 tree ${A}\t002-tree-job/feature.md`, // not a blob
      `100644 blob ${A}\tREADME.md`, // top level, not in a job dir
      `100644 blob ${A}\tBad_Id/spec.md`,
      `100644 blob ${A}\t1-short/spec.md`,
      `100644 blob ${A}\tnotes/001-first-job/spec.md`,
      `100644 blob nothex\t003-third-job/spec.md`,
      `100644 blob ${B}\t003-third-job/job.json`,
    ];
    expect(parseTree(enc.encode(`${recs.join('\0')}\0`))).toEqual([
      { id: '001-first-job', rel: 'events.jsonl', sha: A },
      { id: '001-first-job', rel: 'spec.md', sha: A },
      { id: '001-first-job', rel: 'round-1/review-code.md', sha: A },
      { id: '003-third-job', rel: 'job.json', sha: B },
    ]);
  });

  test('wanted: the log, a legacy job.json, the top-level docs, and round markdown', () => {
    for (const rel of ['events.jsonl', 'job.json', 'feature.md', 'spec.md', 'build.md', 'decision.md', 'rework-12.md', 'conflict-1.md', 'conflict-12.md', 'round-3/review-ui.md', 'round-1/notes.md']) expect({ rel, w: wanted(rel) }).toEqual({ rel, w: true });
    for (const rel of ['job.json.tmp', 'other.md', 'conflict-x.md', 'conflict-.md', 'round-1/x/y.md', 'round-x/review-ui.md', 'round-1/shot.png', '.events.lock/owner']) expect({ rel, w: wanted(rel) }).toEqual({ rel, w: false });
  });
});

describe('cat-file --batch parsing', () => {
  test('reads each blob by its size, multi-line and non-ASCII text included, and skips missing ids', () => {
    const one = 'line 1\nline 2\n';
    const two = '﻿# Café — ✓\n';
    const bytes = enc.encode(two).length;
    const raw = enc.encode(`${A} blob ${enc.encode(one).length}\n${one}\n${'c'.repeat(40)} missing\n${B} blob ${bytes}\n${two}\n`);
    const out = parseBatch(raw);
    expect(out.get(A)).toBe(one);
    expect(out.get(B)).toBe(two); // the BOM is kept, as readFile(…, 'utf8') keeps it
    expect(out.size).toBe(2);
  });

  test('truncated output throws', () => {
    expect(() => parseBatch(enc.encode(`${A} blob 100\nshort\n`))).toThrow('truncated');
  });
});

describe('the git runner (AC6)', () => {
  test('refuses any command but rev-parse, ls-tree, and cat-file', async () => {
    for (const cmd of ['update-ref', 'fetch', 'push', 'commit-tree', 'hash-object', 'config', '-c']) {
      await expect(spawnGit([cmd, 'x'], { cwd: import.meta.dir })).rejects.toThrow('not a read-only command');
    }
  });

  test('spawns git directly, without a shell, and names only the fixed archive ref', async () => {
    const text = await readFile(join(import.meta.dir, 'archive.ts'), 'utf8');
    expect(text).toContain("Bun.spawn(['git', ...args]");
    expect(text).not.toMatch(/shell:|\/bin\/sh|\bexec(Sync)?\(|spawnSync|\$`|child_process/);
    expect(ARCHIVE_REF).toBe('refs/heads/factory/archive');
  });
});
