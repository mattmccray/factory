import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPeer, isMachineName, machineName, normalizePeerUrl, parsePeers, peerLabel, peersPath, peersText, readPeers, removePeer } from '@factory/contract';

const STUDIO = 'https://studio.manticore-hue.ts.net:8766';
const AGENT = 'https://agentbox.manticore-hue.ts.net:8766';

let home: string;
let file: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'andon-peers-'));
  file = peersPath(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

describe('peers.json (AC1)', () => {
  test('peersPath uses ANDON_HOME, defaulting to ~/.andon, beside the registry', () => {
    expect(peersPath('/x/y')).toBe('/x/y/peers.json');
    expect(peersPath(undefined)).toBe(join(homedir(), '.andon', 'peers.json'));
    expect(peersPath('')).toBe(join(homedir(), '.andon', 'peers.json'));
  });

  test('a missing file is an empty list, and reading writes nothing', async () => {
    expect(await readPeers(file)).toEqual({ schema: 'factory/v1', peers: [] });
    expect(await readdir(home)).toEqual([]);
  });

  test('add appends a normalized URL in order; adding it again writes nothing', async () => {
    await addPeer(file, 'HTTPS://Studio.Manticore-Hue.TS.net:8766/');
    await addPeer(file, AGENT);
    expect(await onDisk()).toEqual({ schema: 'factory/v1', peers: [{ url: STUDIO }, { url: AGENT }] });
    const before = await readFile(file, 'utf8');
    expect(before).toBe(peersText({ schema: 'factory/v1', peers: [{ url: STUDIO }, { url: AGENT }] }));
    await rm(file);
    await writeFile(file, before);
    const stat1 = (await Bun.file(file).stat()).mtimeMs;
    await Bun.sleep(5);
    await addPeer(file, STUDIO);
    expect((await Bun.file(file).stat()).mtimeMs).toBe(stat1);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(home)).toEqual(['peers.json']); // no temp file left behind
  });

  test('remove drops a URL; removing an unlisted one writes nothing', async () => {
    await addPeer(file, STUDIO);
    await addPeer(file, AGENT);
    await removePeer(file, STUDIO);
    expect(await onDisk()).toEqual({ schema: 'factory/v1', peers: [{ url: AGENT }] });
    const before = await readFile(file, 'utf8');
    const m = (await Bun.file(file).stat()).mtimeMs;
    await Bun.sleep(5);
    await removePeer(file, STUDIO);
    expect((await Bun.file(file).stat()).mtimeMs).toBe(m);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  test('remove of a missing file writes nothing', async () => {
    await removePeer(file, STUDIO);
    expect(await readdir(home)).toEqual([]);
  });

  test('the default https port is dropped; another port is kept', () => {
    expect(normalizePeerUrl('https://studio.manticore-hue.ts.net:443')).toBe('https://studio.manticore-hue.ts.net');
    expect(normalizePeerUrl('https://studio.manticore-hue.ts.net:9000')).toBe('https://studio.manticore-hue.ts.net:9000');
  });

  const badUrls: Array<[string, string]> = [
    ['http://studio.manticore-hue.ts.net:8766', 'must be an https:// URL'],
    ['studio', 'is not a URL'],
    ['https://me@studio.manticore-hue.ts.net:8766', 'user or password'],
    ['https://studio.manticore-hue.ts.net:8766/projects', 'no path'],
    ['https://studio.manticore-hue.ts.net:8766/?x=1', 'no query'],
    ['https://studio.manticore-hue.ts.net:8766/?', 'no query'],
    ['https://studio.manticore-hue.ts.net:8766/#x', 'no fragment'],
    ['https://studio .ts.net', 'whitespace'],
  ];
  for (const [url, reason] of badUrls) {
    test(`add refuses ${url} with a one-line reason and writes nothing`, async () => {
      expect(() => normalizePeerUrl(url)).toThrow(reason);
      const err = await addPeer(file, url).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain('peers: ');
      expect(String(err)).not.toContain('\n');
      expect(await readdir(home)).toEqual([]);
    });
  }

  const badFiles: Array<[string, unknown, string]> = [
    ['not an object', [], 'must be a JSON object'],
    ['unknown top-level key', { schema: 'factory/v1', peers: [], extra: 1 }, "unknown key 'extra'"],
    ['wrong schema', { schema: 'factory/v2', peers: [] }, 'schema must be "factory/v1"'],
    ['missing schema', { peers: [] }, 'schema must be'],
    ['peers not an array', { schema: 'factory/v1', peers: {} }, 'must be an array'],
    ['a peer not an object', { schema: 'factory/v1', peers: ['x'] }, 'peers[0] must be an object'],
    ['unknown peer key', { schema: 'factory/v1', peers: [{ url: STUDIO, name: 'studio' }] }, "unknown key 'name'"],
    ['url not a string', { schema: 'factory/v1', peers: [{ url: 1 }] }, 'url must be a string'],
    ['an http url', { schema: 'factory/v1', peers: [{ url: 'http://studio.manticore-hue.ts.net:8766' }] }, 'must be an https:// URL'],
    ['a non-normalized url', { schema: 'factory/v1', peers: [{ url: `${STUDIO}/` }] }, 'must be normalized'],
    ['an uppercase url', { schema: 'factory/v1', peers: [{ url: 'https://Studio.manticore-hue.ts.net:8766' }] }, 'must be normalized'],
    ['a url with a path', { schema: 'factory/v1', peers: [{ url: `${STUDIO}/x` }] }, 'no path'],
    ['a duplicate url', { schema: 'factory/v1', peers: [{ url: STUDIO }, { url: STUDIO }] }, 'listed twice'],
  ];
  for (const [name, raw, reason] of badFiles) {
    test(`a peers file with ${name} is rejected with one peers: line and left untouched`, async () => {
      expect(() => parsePeers(raw)).toThrow(reason);
      const text = JSON.stringify(raw);
      await writeFile(file, text);
      for (const op of [() => addPeer(file, AGENT), () => removePeer(file, STUDIO), () => readPeers(file)]) {
        const err = await op().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(String(err)).toContain(`peers: `);
        expect(String(err)).toContain(reason);
        expect(String(err)).not.toContain('\n');
      }
      expect(await readFile(file, 'utf8')).toBe(text);
      expect(await readdir(home)).toEqual(['peers.json']);
    });
  }

  test('an unreadable file is a one-line peers: reason', async () => {
    await mkdir(file, { recursive: true }); // a directory where the file should be
    const err = await readPeers(file).catch((e: unknown) => e);
    expect(String(err)).toContain('peers: cannot read');
    expect(String(err)).not.toContain('\n');
  });

  test('invalid JSON is rejected with a one-line reason', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(file, '{nope');
    await expect(readPeers(file)).rejects.toThrow('peers: not valid JSON');
  });
});

describe('the machine name (AC3)', () => {
  test('a tailnet host gives its first label; a hostname its sanitized first label', () => {
    expect(machineName('studio.manticore-hue.ts.net')).toBe('studio');
    expect(machineName('Rocinante.local')).toBe('rocinante');
    expect(machineName("Matt's MacBook_Pro.local")).toBe('matt-s-macbook-pro');
    expect(machineName('--box--')).toBe('box');
    expect(machineName('a@b')).toBe('a-b');
    expect(machineName('')).toBe('local');
    expect(machineName('___')).toBe('local');
    expect(machineName('.local')).toBe('local');
    for (const h of ['studio.x', 'Rocinante.local', 'a@b', '', '!!', 'Ünïcode']) {
      const n = machineName(h);
      expect(n).not.toContain('@');
      expect(isMachineName(n)).toBe(true);
    }
  });

  test('a peer URL\'s label is its host\'s first label', () => {
    expect(peerLabel(STUDIO)).toBe('studio');
    expect(peerLabel('nope')).toBe('');
  });
});
