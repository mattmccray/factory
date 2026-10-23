import { describe, expect, test } from 'bun:test';
import { checkManifestPath, parseManifest } from './manifest';
import type { Manifest } from './manifest';

const HASH = 'a'.repeat(64);
const good: Manifest = { schema: 'factory/v1', version: '0.1.0', files: { 'factory/cli.ts': HASH, '.claude/agents/x.md': HASH } };

describe('checkManifestPath', () => {
  test('accepts repo-relative paths', () => {
    expect(checkManifestPath('factory/cli.ts')).toBeNull();
    expect(checkManifestPath('.claude/skills/factory/SKILL.md')).toBeNull();
  });
  test.each(['', '/etc/passwd', 'C:/x', '..', '../x', 'a/../b', 'a\\b', 'a\0b'])('rejects %p', (p) => {
    expect(checkManifestPath(p)).not.toBeNull();
  });
});

describe('parseManifest', () => {
  test('returns a typed manifest', () => {
    expect(parseManifest(good)).toEqual(good);
  });
  test('allows an empty files map', () => {
    expect(parseManifest({ ...good, files: {} }).files).toEqual({});
  });
  const bad: [string, unknown, string][] = [
    ['not an object', [], 'must be a JSON object'],
    ['unknown key', { ...good, extra: 1 }, "unknown key 'extra'"],
    ['wrong schema', { ...good, schema: 'factory/v2' }, 'schema must be "factory/v1"'],
    ['empty version', { ...good, version: '' }, 'version must be a non-empty string'],
    ['files not an object', { ...good, files: [] }, 'files must be an object'],
    ['non-hex hash', { ...good, files: { a: 'z'.repeat(64) } }, 'hash must be 64 lowercase hex'],
    ['uppercase hash', { ...good, files: { a: 'A'.repeat(64) } }, 'hash must be 64 lowercase hex'],
    ['absolute path', { ...good, files: { '/etc/passwd': HASH } }, 'not absolute'],
    ['dot-dot path', { ...good, files: { '../x': HASH } }, "must not contain '..'"],
  ];
  for (const [name, raw, msg] of bad) test(`rejects ${name}`, () => expect(() => parseManifest(raw)).toThrow(msg));
});
