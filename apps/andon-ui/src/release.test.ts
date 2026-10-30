import { describe, expect, test } from 'bun:test';
import { CHANGELOG, changeEntry, releaseBody } from './fixtures';
import {
  NO_RELEASES,
  RESTART_COMMAND,
  WHATS_NEW,
  compareSemver,
  parseSemver,
  releaseLine,
  restartText,
  scopeReleases,
  sheetRelease,
  shellQuote,
  toProjectRelease,
  toReleaseInfo,
  upgradeCommand,
  whatsNew,
  whatsNewTitle,
} from './release';
import type { ChangelogRelease, ReleaseInfo } from './release';

const info = (running: string | null, onDisk: string | null = running): ReleaseInfo => {
  const i = toReleaseInfo(releaseBody(running, onDisk));
  if (i === null) throw new Error('fixture did not narrow');
  return i;
};

describe('narrowing the service release data (AC7)', () => {
  test("a project's release: installed and one of the four states", () => {
    expect(toProjectRelease({ installed: '0.1.0', state: 'behind' })).toEqual({ installed: '0.1.0', state: 'behind' });
    expect(toProjectRelease({ installed: '0.2.0', state: 'current' })).toEqual({ installed: '0.2.0', state: 'current' });
    expect(toProjectRelease({ installed: '0.3.0', state: 'ahead' })).toEqual({ installed: '0.3.0', state: 'ahead' });
    expect(toProjectRelease({ installed: null, state: 'unknown' })).toEqual({ installed: null, state: 'unknown' });
    expect(toProjectRelease({ installed: 'next', state: 'unknown' })).toEqual({ installed: 'next', state: 'unknown' });
  });

  test('a missing or malformed release is none', () => {
    for (const v of [undefined, null, 'behind', 3, [], {}, { installed: '0.1.0' }, { state: 'behind' }, { installed: 1, state: 'behind' }, { installed: '0.1.0', state: 'stale' }, { installed: null, state: 'behind' }, { installed: null, state: 'current' }]) {
      expect({ v, r: toProjectRelease(v) }).toEqual({ v, r: null });
    }
  });

  test('GET /release: running, onDisk, and the changelog in the service order', () => {
    const i = toReleaseInfo(releaseBody('0.3.0', '0.3.0'));
    expect(i?.running).toBe('0.3.0');
    expect(i?.onDisk).toBe('0.3.0');
    expect(i?.changelog.map((r) => r.version)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(i?.changelog[0]?.sections.breaking).toEqual([{ area: 'CLI', text: 'the overlay moves to factory/roles', job: '057-roles' }]);
    expect(toReleaseInfo({ running: null, onDisk: null, changelog: [] })).toEqual({ running: null, onDisk: null, changelog: [] });
  });

  test('a malformed body is no release data; a malformed release or entry inside one is skipped', () => {
    for (const v of [undefined, null, 'x', [], {}, { running: '0.1.0' }, { running: 1, onDisk: null, changelog: [] }, { running: null, onDisk: null, changelog: {} }, { running: null, changelog: [] }]) {
      expect({ v, r: toReleaseInfo(v) }).toEqual({ v, r: null });
    }
    const i = toReleaseInfo({
      running: '0.2.0',
      onDisk: '0.2.0',
      changelog: [null, { date: '2026-10-01' }, { version: '0.2.0', date: '2026-10-20', sections: { added: [{ text: 'ok', area: 'Andon', job: null }, { area: 'x' }, 'loose'] } }],
    });
    expect(i?.changelog).toEqual([{ version: '0.2.0', date: '2026-10-20', sections: { breaking: [], added: [{ area: 'Andon', text: 'ok', job: null }], fixed: [] } }]);
  });
});

describe('semver and the scope filter (AC4)', () => {
  test('valid semver is exactly MAJOR.MINOR.PATCH with no leading zeros', () => {
    expect(parseSemver('0.1.0')).toEqual([0, 1, 0]);
    expect(parseSemver('10.20.30')).toEqual([10, 20, 30]);
    for (const v of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-rc.1', '1.2.3+build', 'next', ' 1.2.3', '1.2.x']) expect({ v, p: parseSemver(v) }).toEqual({ v, p: null });
  });

  test('compares numerically, field by field; null when either is invalid', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.2.1', '0.2.0')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('next', '0.2.0')).toBeNull();
    expect(compareSemver('0.2.0', '0.2.0-rc.1')).toBeNull();
  });

  const rel = (version: string): ChangelogRelease => ({ version, date: '2026-10-29', sections: { breaking: [], added: [], fixed: [] } });
  const log = ['0.4.0', '0.3.0', 'bogus', '0.2.1', '0.2.0', '0.1.0', '0.0.9'].map(rel);

  test('above installed and up to and including running, newest first', () => {
    expect(scopeReleases(log, '0.1.0', '0.3.0').map((r) => r.version)).toEqual(['0.3.0', '0.2.1', '0.2.0']);
    expect(scopeReleases(log, '0.2.0', '0.2.1').map((r) => r.version)).toEqual(['0.2.1']);
    expect(scopeReleases(log, '0.3.0', '0.3.0')).toEqual([]);
  });

  test('with running unknown, everything above installed; an invalid installed version scopes nothing', () => {
    expect(scopeReleases(log, '0.2.1', null).map((r) => r.version)).toEqual(['0.4.0', '0.3.0']);
    expect(scopeReleases(log, 'next', '0.4.0')).toEqual([]);
  });
});

describe('hover text and labels (AC1, AC2)', () => {
  test('each state has its own release line', () => {
    expect(releaseLine({ installed: '0.1.0', state: 'behind' }, '0.2.0')).toBe('factory 0.1.0 installed · 0.2.0 available');
    expect(releaseLine({ installed: '0.1.0', state: 'behind' }, null)).toBe('factory 0.1.0 installed · a newer release available');
    expect(releaseLine({ installed: '0.2.0', state: 'current' }, '0.2.0')).toBe('factory 0.2.0 installed · up to date');
    expect(releaseLine({ installed: '0.3.0', state: 'ahead' }, '0.2.0')).toBe("factory 0.3.0 installed · newer than this machine's 0.2.0");
    expect(releaseLine({ installed: null, state: 'unknown' }, '0.2.0')).toBe('factory version unknown');
    expect(releaseLine({ installed: 'next', state: 'unknown' }, '0.2.0')).toBe('factory version unknown');
  });

  test('no release, no line', () => {
    expect(releaseLine(null, '0.2.0')).toBeNull();
    expect(releaseLine(undefined, '0.2.0')).toBeNull();
  });

  test("the footer version's hover text, and the restart note naming both releases and the command", () => {
    expect(whatsNewTitle('0.2.0')).toBe("What's new in v0.2.0");
    expect(RESTART_COMMAND).toBe('factory service restart');
    const t = restartText('0.2.0', '0.3.0');
    expect(t).toStartWith('Restart service');
    for (const part of ['v0.2.0', 'v0.3.0', 'factory service restart']) expect(t).toContain(part);
    expect(t).not.toContain('andon:service');
    expect(restartText(null, '0.3.0')).toContain('an unknown release');
  });
});

describe('the upgrade command (AC4)', () => {
  test('cd to the single-quoted root, then factory upgrade and doctor', () => {
    expect(upgradeCommand('/Users/m/minerva')).toBe("cd '/Users/m/minerva' && factory upgrade && bun factory/cli.ts doctor");
  });

  test("a ' in the root is written '\\''; spaces and $ stay inside the quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(upgradeCommand("/r/Matt's repo $HOME")).toBe("cd '/r/Matt'\\''s repo $HOME' && factory upgrade && bun factory/cli.ts doctor");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });
});

describe("the What's New sheet model (AC3, AC4)", () => {
  test('whole: titled What\'s New, every release newest first with its version and date', () => {
    const m = whatsNew(info('0.3.0'), null);
    expect(m.title).toBe(WHATS_NEW);
    expect(m.title).toBe("What's New");
    expect(m.scope).toBeNull();
    expect(m.releases.map((r) => [r.version, r.date])).toEqual([
      ['0.3.0', '2026-10-29'],
      ['0.2.0', '2026-10-20'],
      ['0.1.0', '2026-10-01'],
    ]);
    expect(m.empty).toBeNull();
  });

  test('entries group under Breaking, Added, and Fixed, empty sections omitted, each with its area and job id when present', () => {
    const [r3, r2, r1] = whatsNew(info('0.3.0'), null).releases;
    expect(r3?.sections.map((s) => s.title)).toEqual(['Breaking', 'Added', 'Fixed']);
    expect(r3?.sections[1]?.entries).toEqual([
      { area: 'Andon', text: "What's New in the sidebar", job: '059-andon-version-ui' },
      { area: null, text: 'a release script', job: null },
    ]);
    expect(r2?.sections.map((s) => s.title)).toEqual(['Added']);
    expect(r1?.sections.map((s) => s.title)).toEqual(['Fixed']);
    expect(sheetRelease({ version: '9.9.9', date: '', sections: { breaking: [], added: [], fixed: [] } }).sections).toEqual([]);
  });

  test('no release data, or an empty changelog: no releases are available', () => {
    expect(whatsNew(null, null)).toEqual({ title: "What's New", scope: null, releases: [], empty: NO_RELEASES });
    expect(whatsNew({ running: '0.2.0', onDisk: '0.2.0', changelog: [] }, null).empty).toBe('No releases are available.');
  });

  const minerva = (release: unknown) => ({ name: 'minerva', root: "/r/it's", release: release === undefined ? undefined : toProjectRelease(release) });

  test('scoped to a behind project: only the releases above installed up to running, with the upgrade command', () => {
    const changelog = [
      { version: '0.4.0', date: '2026-11-01', sections: { breaking: [], added: [changeEntry('later')], fixed: [] } },
      ...CHANGELOG,
    ];
    const i = toReleaseInfo(releaseBody('0.3.0', '0.3.0', changelog));
    const m = whatsNew(i, { id: 'p1', project: minerva({ installed: '0.1.0', state: 'behind' }) });
    expect(m.releases.map((r) => r.version)).toEqual(['0.3.0', '0.2.0']);
    expect(m.scope).toEqual({ name: 'minerva', behind: true, note: 'minerva has factory 0.1.0. These are the releases since.', command: "cd '/r/it'\\''s' && factory upgrade && bun factory/cli.ts doctor" });
    expect(m.empty).toBeNull();
  });

  test('scoped to a project that is not behind, or unknown: the not-behind text, no command, no releases', () => {
    for (const p of [
      minerva({ installed: '0.3.0', state: 'current' }),
      minerva({ installed: '0.4.0', state: 'ahead' }),
      minerva({ installed: null, state: 'unknown' }),
      minerva(undefined),
    ]) {
      const m = whatsNew(info('0.3.0'), { id: 'p1', project: p });
      expect(m.scope).toEqual({ name: 'minerva', behind: false, note: 'minerva is not behind: it has every release this machine has.', command: null });
      expect(m.releases).toEqual([]);
      expect(m.empty).toBeNull();
    }
    const gone = whatsNew(info('0.3.0'), { id: 'gone-id', project: null });
    expect(gone.scope?.name).toBe('gone-id');
    expect(gone.scope?.behind).toBe(false);
    expect(gone.scope?.command).toBeNull();
  });

  test('scoped and behind, but no release data: the command still shows, and no releases are available', () => {
    const m = whatsNew(null, { id: 'p1', project: minerva({ installed: '0.1.0', state: 'behind' }) });
    expect(m.scope?.command).toBe("cd '/r/it'\\''s' && factory upgrade && bun factory/cli.ts doctor");
    expect(m.releases).toEqual([]);
    expect(m.empty).toBe(NO_RELEASES);
  });
});
