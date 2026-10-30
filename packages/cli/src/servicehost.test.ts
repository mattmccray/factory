import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { unitTempPath, writeUnitFile } from './servicehost';

let tmp: string;
let units: string;
let unit: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'factory-servicehost-'));
  units = join(tmp, 'LaunchAgents');
  unit = join(units, 'dev.factory.andon.plist');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
};

describe('the unit write: an exclusive temp file, renamed into place', () => {
  test('AC1: a symlink planted at the temp path is never followed; the sentinel, the link, and the unit are unchanged', async () => {
    await mkdir(units);
    const sentinel = join(tmp, 'sentinel');
    await writeFile(sentinel, 'sentinel\n');
    const at = unitTempPath(unit);
    await symlink(sentinel, at);
    await expect(writeUnitFile(unit, 'new unit\n', at)).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('sentinel\n');
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await readlink(at)).toBe(sentinel);
    expect(await exists(unit)).toBe(false);
  });

  test('AC1: a dangling symlink at the temp path is not followed to create its target', async () => {
    await mkdir(units);
    const target = join(tmp, 'created-through-link');
    const at = unitTempPath(unit);
    await symlink(target, at);
    await expect(writeUnitFile(unit, 'new unit\n', at)).rejects.toThrow();
    expect(await exists(target)).toBe(false);
    expect(await readlink(at)).toBe(target);
    expect(await exists(unit)).toBe(false);
  });

  test('AC2: a regular file at the temp path rejects; it and the existing unit are unchanged', async () => {
    await mkdir(units);
    await writeFile(unit, 'old unit\n');
    const at = unitTempPath(unit);
    await writeFile(at, 'squatter\n');
    await expect(writeUnitFile(unit, 'new unit\n', at)).rejects.toThrow();
    expect(await readFile(at, 'utf8')).toBe('squatter\n');
    expect(await readFile(unit, 'utf8')).toBe('old unit\n');
  });

  test('AC3: over an existing unit, the unit holds exactly the new text, mode 0644, and no temp file is left', async () => {
    await mkdir(units);
    await writeFile(unit, 'old unit\n', { mode: 0o600 });
    await writeUnitFile(unit, 'new unit\n');
    expect(await readFile(unit, 'utf8')).toBe('new unit\n');
    expect((await stat(unit)).mode & 0o777).toBe(0o644);
    expect(await readdir(units)).toEqual([basename(unit)]);
  });

  test('AC3: the parent directory is created when missing', async () => {
    const deep = join(tmp, 'a', 'b', 'andon.service');
    await writeUnitFile(deep, 'unit\n');
    expect(await readFile(deep, 'utf8')).toBe('unit\n');
    expect((await stat(deep)).mode & 0o777).toBe(0o644);
    expect(await readdir(dirname(deep))).toEqual(['andon.service']);
  });

  test('AC4: a failed rename (the unit path is a non-empty directory) rejects and leaves no temp file', async () => {
    await mkdir(join(unit, 'inside'), { recursive: true });
    await expect(writeUnitFile(unit, 'new unit\n')).rejects.toThrow();
    expect(await readdir(units)).toEqual([basename(unit)]);
    expect(await readdir(unit)).toEqual(['inside']);
  });

  test('AC5: default temp names are fresh each time, beside the unit, and not <unit>.<pid>.tmp', () => {
    const a = unitTempPath(unit);
    const b = unitTempPath(unit);
    expect(a).not.toBe(b);
    for (const p of [a, b]) {
      expect(p).not.toBe(`${unit}.${process.pid}.tmp`);
      expect(dirname(p)).toBe(units);
      expect(basename(p)).toContain(basename(unit));
    }
  });
});
