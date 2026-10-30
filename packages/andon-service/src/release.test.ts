import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver, isSemver, parseChangelog, parseEntry, readChangelog, readInstalled, readTemplatesVersion, releaseState } from './release';

const SHA = 'a'.repeat(64);

let tmp: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-release-')));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('semver (AC1)', () => {
  test('only plain MAJOR.MINOR.PATCH with no leading zeros is valid', () => {
    for (const v of ['0.0.0', '0.1.0', '1.2.3', '10.20.30', '123456789012345678901234567890.0.0']) expect({ v, ok: isSemver(v) }).toEqual({ v, ok: true });
    for (const v of ['', 'next', 'v0.1.0', '0.1', '0.1.0.0', '01.0.0', '0.01.0', '0.0.01', '0.1.0-rc.1', '0.1.0+build', ' 0.1.0', '0.1.0 ', '-1.0.0', '1.0.x']) {
      expect({ v, ok: isSemver(v) }).toEqual({ v, ok: false });
    }
  });

  test('compares numerically field by field', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.3.0', '0.2.0')).toBe(1);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.0.2', '0.0.10')).toBe(-1);
    expect(compareSemver('99999999999999999999.0.0', '99999999999999999998.0.0')).toBe(1);
    expect(compareSemver('next', '0.1.0')).toBeNull();
    expect(compareSemver('0.1.0', '0.1.0-rc.1')).toBeNull();
  });

  test('the state of an installed release against the running one', () => {
    expect(releaseState('0.1.0', '0.2.0')).toBe('behind');
    expect(releaseState('0.2.0', '0.2.0')).toBe('current');
    expect(releaseState('0.3.0', '0.2.0')).toBe('ahead');
    expect(releaseState(null, '0.2.0')).toBe('unknown');
    expect(releaseState('next', '0.2.0')).toBe('unknown');
    expect(releaseState('0.2.0', null)).toBe('unknown');
    expect(releaseState('0.2.0', 'next')).toBe('unknown');
  });
});

describe('reading versions (AC1, AC3)', () => {
  test('a project\'s installed release is its managed.json version, else null', async () => {
    const factory = join(tmp, 'factory');
    await mkdir(factory);
    const path = join(factory, 'managed.json');
    expect(await readInstalled(factory)).toBeNull(); // missing
    await writeFile(path, '{ not json');
    expect(await readInstalled(factory)).toBeNull();
    await writeFile(path, JSON.stringify({ schema: 'factory/v1', version: '0.1.0', files: { 'a.md': 'nope' } }));
    expect(await readInstalled(factory)).toBeNull(); // parseManifest rejects it
    await writeFile(path, JSON.stringify({ schema: 'factory/v1', version: '', files: {} }));
    expect(await readInstalled(factory)).toBeNull();
    await writeFile(path, JSON.stringify({ schema: 'factory/v1', version: 'next', files: {} }));
    expect(await readInstalled(factory)).toBe('next');
    await writeFile(path, JSON.stringify({ schema: 'factory/v1', version: '0.1.0', files: { 'a.md': SHA } }));
    expect(await readInstalled(factory)).toBe('0.1.0');
    await rm(path);
    await mkdir(path); // a directory: unreadable
    expect(await readInstalled(factory)).toBeNull();
  });

  test('the templates version is packages/templates/package.json\'s string version, else null', async () => {
    expect(await readTemplatesVersion(undefined)).toBeNull();
    expect(await readTemplatesVersion(tmp)).toBeNull(); // missing
    const path = join(tmp, 'packages', 'templates', 'package.json');
    await mkdir(join(tmp, 'packages', 'templates'), { recursive: true });
    await writeFile(path, '{');
    expect(await readTemplatesVersion(tmp)).toBeNull();
    await writeFile(path, JSON.stringify({ name: '@factory/templates', version: 2 }));
    expect(await readTemplatesVersion(tmp)).toBeNull();
    await writeFile(path, JSON.stringify(['0.2.0']));
    expect(await readTemplatesVersion(tmp)).toBeNull();
    await writeFile(path, JSON.stringify({ name: '@factory/templates', version: '0.2.0' }));
    expect(await readTemplatesVersion(tmp)).toBe('0.2.0');
  });
});

describe('changelog entries (AC4)', () => {
  test('area, text, and job id, each optional', () => {
    expect(parseEntry('- Andon: show epics as sub-lanes (056-andon-epics-ui)')).toEqual({ area: 'Andon', text: 'show epics as sub-lanes', job: '056-andon-epics-ui' });
    expect(parseEntry('- Andon: show epics as sub-lanes')).toEqual({ area: 'Andon', text: 'show epics as sub-lanes', job: null });
    expect(parseEntry('- show epics as sub-lanes (056-andon-epics-ui)')).toEqual({ area: null, text: 'show epics as sub-lanes', job: '056-andon-epics-ui' });
    expect(parseEntry('- show epics as sub-lanes')).toEqual({ area: null, text: 'show epics as sub-lanes', job: null });
    expect(parseEntry('Skill: no leading dash (012-x)')).toEqual({ area: 'Skill', text: 'no leading dash', job: '012-x' });
    expect(parseEntry('- Mac app: reads two: colons (001-a-b)')).toEqual({ area: 'Mac app', text: 'reads two: colons', job: '001-a-b' });
  });

  test('a job id must match the job id rule, else it stays in the text', () => {
    expect(parseEntry('- Andon: fix it (see notes)')).toEqual({ area: 'Andon', text: 'fix it (see notes)', job: null });
    expect(parseEntry('- Andon: fix it (56-short)')).toEqual({ area: 'Andon', text: 'fix it (56-short)', job: null });
    expect(parseEntry('- Andon: fix it (056-Upper)')).toEqual({ area: 'Andon', text: 'fix it (056-Upper)', job: null });
  });

  test('an area holds no colon or parenthesis', () => {
    expect(parseEntry('- see (this): then that')).toEqual({ area: null, text: 'see (this): then that', job: null });
    expect(parseEntry('- url http://example.com')).toEqual({ area: null, text: 'url http://example.com', job: null });
  });

  test('a line matching neither shape is its own text', () => {
    expect(parseEntry('- Andon: (056-andon-epics-ui)')).toEqual({ area: null, text: 'Andon: (056-andon-epics-ui)', job: null });
    expect(parseEntry('- (056-andon-epics-ui)')).toEqual({ area: null, text: '(056-andon-epics-ui)', job: null });
    expect(parseEntry('- Andon:')).toEqual({ area: null, text: 'Andon:', job: null });
    expect(parseEntry('*bold* stray text')).toEqual({ area: null, text: '*bold* stray text', job: null });
  });
});

const SAMPLE = [
  '# Changelog',
  '',
  'Intro text, ignored.',
  '- an entry outside any release, ignored',
  '',
  '## v0.2.0 (2026-10-29)',
  '- outside a section, ignored',
  '',
  '### Breaking',
  '- CLI: drop the old flag (050-drop-flag)',
  '',
  '### Added',
  '- Andon: show epics as sub-lanes (056-andon-epics-ui)',
  '- Skill: a direct commit',
  '- no area here (057-no-area)',
  '',
  '### Notes',
  '- an unknown section, ignored',
  '',
  '## v0.1.0 (2026-10-01)',
  '',
  '### Fixed',
  '- Andon: a fix (040-a-fix)',
  '',
  '## Unreleased',
  '### Added',
  '- not a release heading, ignored',
  '',
  '## v0.0.1 (someday)',
  '### Added',
  '- bad date, ignored',
  '',
].join('\n');

describe('the changelog (AC3, AC4)', () => {
  test('releases in file order, a section absent from the file is []', () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      {
        version: '0.2.0',
        date: '2026-10-29',
        sections: {
          breaking: [{ area: 'CLI', text: 'drop the old flag', job: '050-drop-flag' }],
          added: [
            { area: 'Andon', text: 'show epics as sub-lanes', job: '056-andon-epics-ui' },
            { area: 'Skill', text: 'a direct commit', job: null },
            { area: null, text: 'no area here', job: '057-no-area' },
          ],
          fixed: [],
        },
      },
      { version: '0.1.0', date: '2026-10-01', sections: { breaking: [], added: [], fixed: [{ area: 'Andon', text: 'a fix', job: '040-a-fix' }] } },
    ]);
  });

  test('CRLF line endings and trailing spaces are tolerated', () => {
    const text = '## v1.0.0 (2026-01-02)  \r\n### Added \r\n- Andon: x (001-a)\r\n';
    expect(parseChangelog(text)).toEqual([{ version: '1.0.0', date: '2026-01-02', sections: { breaking: [], added: [{ area: 'Andon', text: 'x', job: '001-a' }], fixed: [] } }]);
  });

  test('a heading with a non-semver version is not a release', () => {
    expect(parseChangelog('## v01.0.0 (2026-01-02)\n### Added\n- x\n## v1.0.0-rc.1 (2026-01-02)\n### Added\n- y\n')).toEqual([]);
  });

  test('no input makes the parser throw', () => {
    const inputs = ['', '\n\n', '###', '## v', '## v1.0.0 (', '### Added\n- orphan', '- \n-\n- -', '\0 ￿', '#'.repeat(10000), '## v0.1.0 (2026-10-29)\n### Added\n' + '- ('.repeat(5000), 'x'.repeat(100000)];
    for (const text of inputs) expect(() => parseChangelog(text)).not.toThrow();
    let seed = 7;
    const chars = ['#', ' ', '-', ':', '(', ')', 'v', '0', '1', '.', '\n', 'A', '2', '6'];
    for (let n = 0; n < 200; n++) {
      let s = '';
      for (let i = 0; i < 200; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s += chars[seed % chars.length] ?? '';
      }
      expect(() => parseChangelog(s)).not.toThrow();
    }
  });

  test('a missing CHANGELOG.md is [], and so is no clone root', async () => {
    expect(await readChangelog(tmp)).toEqual([]);
    expect(await readChangelog(undefined)).toEqual([]);
    await writeFile(join(tmp, 'CHANGELOG.md'), SAMPLE);
    expect((await readChangelog(tmp)).map((r) => r.version)).toEqual(['0.2.0', '0.1.0']);
  });
});
