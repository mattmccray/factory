import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, parseRegistry, readRegistry, registryPath, removeRoot } from './registry';

let home: string;
let file: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'andon-home-'));
  file = registryPath(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

describe('registry (AC1)', () => {
  test('registryPath uses ANDON_HOME, defaulting to ~/.andon', () => {
    expect(registryPath('/x/y')).toBe('/x/y/projects.json');
    expect(registryPath(undefined)).toBe(join(homedir(), '.andon', 'projects.json'));
    expect(registryPath('')).toBe(join(homedir(), '.andon', 'projects.json'));
  });

  test('adding the same root twice lists it once; removing it leaves none', async () => {
    await addRoot(file, '/srv/project-a');
    await addRoot(file, '/srv/project-a');
    expect(await onDisk()).toEqual({ schema: 'factory/v1', projects: [{ root: '/srv/project-a' }] });
    await removeRoot(file, '/srv/project-a');
    expect(await onDisk()).toEqual({ schema: 'factory/v1', projects: [] });
    // no temp files left behind
    expect(await readdir(home)).toEqual(['projects.json']);
  });

  test('add normalizes the root and creates ANDON_HOME when missing', async () => {
    const nested = registryPath(join(home, 'a', 'b'));
    await addRoot(nested, '/srv/p/');
    await addRoot(nested, '/srv/./p');
    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({ schema: 'factory/v1', projects: [{ root: '/srv/p' }] });
  });

  test('a missing registry reads as empty', async () => {
    expect(await readRegistry(file)).toEqual({ schema: 'factory/v1', projects: [] });
  });

  test('a relative root is rejected with a one-line reason and nothing is written', async () => {
    const err = await addRoot(file, 'relative/root').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('\n');
    expect(String(err)).toContain('absolute');
    expect(await readdir(home)).toEqual([]);
    await expect(removeRoot(file, 'rel')).rejects.toThrow('absolute');
  });

  const badFiles: Array<[string, unknown, string]> = [
    ['unknown top-level key', { schema: 'factory/v1', projects: [], extra: 1 }, "unknown key 'extra'"],
    ['wrong schema', { schema: 'factory/v2', projects: [] }, 'schema must be "factory/v1"'],
    ['missing schema', { projects: [] }, 'schema must be'],
    ['unknown project key', { schema: 'factory/v1', projects: [{ root: '/a', name: 'x' }] }, "unknown key 'name'"],
    ['relative root in file', { schema: 'factory/v1', projects: [{ root: 'a' }] }, 'absolute'],
    ['non-normalized root', { schema: 'factory/v1', projects: [{ root: '/a/' }] }, 'must be normalized'],
    ['duplicate root', { schema: 'factory/v1', projects: [{ root: '/a' }, { root: '/a' }] }, 'listed twice'],
    ['projects not an array', { schema: 'factory/v1', projects: {} }, 'must be an array'],
  ];
  for (const [name, raw, reason] of badFiles) {
    test(`a registry file with ${name} is rejected and left untouched`, async () => {
      expect(() => parseRegistry(raw)).toThrow(reason);
      const text = JSON.stringify(raw);
      await writeFile(file, text);
      const err = await addRoot(file, '/srv/new').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain(reason);
      expect(String(err)).not.toContain('\n');
      expect(await readFile(file, 'utf8')).toBe(text);
      expect(await readdir(home)).toEqual(['projects.json']);
    });
  }

  test('invalid JSON is rejected with a one-line reason', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(file, '{nope');
    await expect(readRegistry(file)).rejects.toThrow('registry: not valid JSON');
  });
});
