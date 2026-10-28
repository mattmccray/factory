import { describe, expect, test } from 'bun:test';
import { TIMING, groupsOf, pickFile } from './docs';
import { HOUR, NOW, before, job, tag } from './fixtures';
import {
  AUTO_HIDE_BELOW,
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  abandonCommand,
  approveCommand,
  autoHides,
  clampWidth,
  copiedText,
  currentRound,
  fileModel,
  quoteArg,
  reworkCommand,
  settledRows,
  settledTitle,
  sidebarShown,
  stepFile,
  toggleSidebar,
  verdictTone,
} from './inspector';

describe('the copy-only commands (AC1)', () => {
  const id = '040-tag-migration';
  const messy = '  drop the "tags" column\\after backfill\nthen re-run\r\nthe gate  ';
  const escaped = '"drop the \\"tags\\" column\\\\after backfill then re-run the gate"';

  test('approve is the bare command', () => {
    expect(approveCommand(id)).toBe('/factory approve 040-tag-migration');
  });

  test('a note or reason is trimmed, quoted, backslash-escaped, and newlines become spaces', () => {
    expect(quoteArg(messy)).toBe(escaped);
    expect(reworkCommand(id, messy)).toEqual({ text: `/factory rework 040-tag-migration ${escaped}`, copyable: true });
    expect(abandonCommand(id, messy)).toEqual({ text: `/factory abandon 040-tag-migration ${escaped}`, copyable: true });
    expect(reworkCommand(id, 'plain')).toEqual({ text: '/factory rework 040-tag-migration "plain"', copyable: true });
  });

  test('a blank or whitespace-only note or reason is not copyable', () => {
    for (const blank of ['', '   ', '\n\t \r\n']) {
      expect(reworkCommand(id, blank).copyable).toBe(false);
      expect(abandonCommand(id, blank).copyable).toBe(false);
    }
    expect(reworkCommand(id, '').text).toBe('/factory rework 040-tag-migration ""');
  });

  test('the toast names the copied command', () => {
    expect(copiedText('/factory approve 040-tag-migration')).toBe('Copied /factory approve 040-tag-migration');
  });
});

describe('the inspector width and the sidebar rule (AC2)', () => {
  test('a width is clamped to 320–560, and the default is 392', () => {
    expect([INSPECTOR_MIN, INSPECTOR_DEFAULT, INSPECTOR_MAX]).toEqual([320, 392, 560]);
    expect(clampWidth(100)).toBe(320);
    expect(clampWidth(320)).toBe(320);
    expect(clampWidth(400.6)).toBe(401);
    expect(clampWidth(560)).toBe(560);
    expect(clampWidth(9000)).toBe(560);
    expect(clampWidth(Number.NaN)).toBe(392);
  });

  test('the sidebar auto-hides only while the inspector is open and the window is below 1640px', () => {
    expect(AUTO_HIDE_BELOW).toBe(1640);
    expect(autoHides(1440, true)).toBe(true);
    expect(autoHides(1639, true)).toBe(true);
    expect(autoHides(1640, true)).toBe(false);
    expect(autoHides(1440, false)).toBe(false);
    const user = { user: true, override: false };
    expect(sidebarShown(user, 1440, true)).toBe(false);
    expect(sidebarShown(user, 1800, true)).toBe(true);
    expect(sidebarShown({ user: false, override: false }, 1800, false)).toBe(false);
  });

  test("closing the inspector restores the user's own choice", () => {
    const shown = { user: true, override: false };
    expect(sidebarShown(shown, 1440, true)).toBe(false); // auto-hidden while open
    expect(sidebarShown(shown, 1440, false)).toBe(true); // back on close
    const hidden = { user: false, override: false };
    expect(sidebarShown(hidden, 1440, false)).toBe(false); // a hidden sidebar stays hidden
  });

  test('the toggle always flips what is on screen; showing it over the rule lasts until the inspector closes', () => {
    const auto = toggleSidebar({ user: true, override: false }, 1440, true);
    expect(auto).toEqual({ user: true, override: true });
    expect(sidebarShown(auto, 1440, true)).toBe(true);
    const off = toggleSidebar(auto, 1440, true);
    expect(sidebarShown(off, 1440, true)).toBe(false);
    expect(sidebarShown(off, 1440, false)).toBe(false);
    expect(toggleSidebar({ user: false, override: false }, 1800, false)).toEqual({ user: true, override: false });
  });
});

describe('the file model (AC3)', () => {
  // Today's drawer fixture, plus build.md and a second round.
  const files = [
    { path: 'briefs/x.md', text: 'brief' },
    { path: 'jobs/001-a/feature.md', text: 'feature' },
    { path: 'jobs/001-a/spec.md', text: '# Spec' },
    { path: 'jobs/001-a/build.md', text: '# Build' },
    { path: 'jobs/001-a/round-1/review-code.md', text: 'VERDICT: CHANGES\n…' },
    { path: 'jobs/001-a/round-1/review-security.md', text: 'PASS' },
    { path: 'jobs/001-a/round-2/review-code.md', text: 'VERDICT: PASS\n' },
    { path: 'jobs/001-a/round-2/review-security.md', text: 'VERDICT: PASS\n' },
    { path: 'jobs/001-a/decision.md', text: 'ESCALATE\nwhy' },
  ];

  test("every group and per-file verdict from groupsOf() is present, in order", () => {
    const model = fileModel(files, true, null);
    const fromDocs = groupsOf(files).map((g) => [g.name, g.files.map((f) => [f.path, f.label, f.verdict])]);
    const shown = model.groups.map((g) => [g.name, g.rows.filter((r) => r.path !== TIMING).map((r) => [r.path, r.label, r.verdict])]);
    expect(shown).toEqual(fromDocs);
    expect(model.groups.map((g) => g.name)).toEqual(['Job', 'Round 1', 'Round 2']);
  });

  test('the highest round is current', () => {
    expect(currentRound(groupsOf(files))).toBe('Round 2');
    expect(fileModel(files, false, null).groups.map((g) => g.current)).toEqual([false, false, true]);
    expect(currentRound(groupsOf(files.slice(0, 4)))).toBeNull();
    const out = groupsOf([{ path: 'jobs/x/round-10/review-a.md', text: '' }, { path: 'jobs/x/round-9/review-a.md', text: '' }]);
    expect(currentRound(out)).toBe('Round 10');
  });

  test('PASS and APPROVE are green, CHANGES orange, ESCALATE red', () => {
    expect(verdictTone('PASS')).toBe('green');
    expect(verdictTone('APPROVE')).toBe('green');
    expect(verdictTone('CHANGES')).toBe('orange');
    expect(verdictTone('ESCALATE')).toBe('red');
    expect(verdictTone(null)).toBeNull();
    const rows = fileModel(files, false, null).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.path === 'jobs/001-a/decision.md')?.tone).toBe('red');
    expect(rows.find((r) => r.path === 'jobs/001-a/round-1/review-code.md')?.tone).toBe('orange');
    expect(rows.find((r) => r.path === 'jobs/001-a/round-1/review-security.md')?.tone).toBe('green');
    const approved = fileModel([{ path: 'jobs/001-a/decision.md', text: 'APPROVE\n' }], false, null);
    expect(approved.groups[0]?.rows[0]?.tone).toBe('green');
  });

  test('the timing row is present exactly when the job has timing, first in Job', () => {
    expect(fileModel(files, true, null).groups[0]?.rows[0]).toEqual({ path: TIMING, label: 'timing', verdict: null, tone: null });
    expect(fileModel(files, false, null).groups.flatMap((g) => g.rows).some((r) => r.path === TIMING)).toBe(false);
    expect(fileModel([], true, null).groups.map((g) => g.rows.length)).toEqual([1]);
    expect(fileModel([], false, null).groups).toEqual([]);
  });

  test("the default file is pickFile()'s, and a chosen file stays while it exists", () => {
    expect(fileModel(files, true, null).selected).toBe(pickFile(null, files, true));
    expect(fileModel(files, true, TIMING).selected).toBe(TIMING);
    expect(fileModel(files, false, TIMING).selected).toBe(pickFile(TIMING, files, false));
    expect(fileModel(files, true, 'jobs/001-a/spec.md').selected).toBe('jobs/001-a/spec.md');
  });

  test('↑ and ↓ step through the rows in order, stopping at the ends', () => {
    const order = fileModel(files, true, null).order;
    expect(order[0]).toBe(TIMING);
    expect(order).toHaveLength(files.length + 1);
    expect(stepFile(order, TIMING, 1)).toBe('briefs/x.md');
    expect(stepFile(order, TIMING, -1)).toBe(TIMING);
    expect(stepFile(order, 'jobs/001-a/round-2/review-security.md', 1)).toBe('jobs/001-a/round-2/review-security.md');
    expect(stepFile(order, null, 1)).toBe(TIMING);
    expect(stepFile([], null, 1)).toBeNull();
  });
});

describe('the Settled sheet (AC4)', () => {
  const a = { id: 'pa', name: 'alpha' };
  const b = { id: 'pb', name: 'beta' };
  const settled = [
    tag(job({ id: '001-old', title: 'Old merge', stage: 'merged', round: 2, startedAt: before(80 * HOUR), endedAt: before(70 * HOUR), note: 'merged abc1234' }), a),
    tag(job({ id: '002-gave-up', title: 'Gave up', stage: 'abandoned', round: 1, startedAt: before(10 * HOUR), endedAt: before(2 * HOUR), note: 'superseded by 005' }), b),
    tag(job({ id: '003-mid', title: 'Mid merge', stage: 'merged', round: 1, startedAt: before(50 * HOUR), endedAt: before(30 * HOUR) }), b),
    tag(job({ id: '004-dropped', title: 'Dropped', stage: 'abandoned', round: 0, startedAt: before(40 * HOUR), endedAt: before(40 * HOUR), note: 'not needed' }), a),
  ];

  test('rows are newest end first', () => {
    expect(settledRows(settled, null).map((r) => r.id)).toEqual(['002-gave-up', '003-mid', '004-dropped', '001-old']);
  });

  test('a project filter keeps only that project', () => {
    expect(settledRows(settled, 'pa').map((r) => r.id)).toEqual(['004-dropped', '001-old']);
    expect(settledRows(settled, 'pb').map((r) => r.project)).toEqual(['beta', 'beta']);
  });

  test('abandoned rows carry the Abandoned tag and their note as the reason; merged rows carry no tag', () => {
    const rows = settledRows(settled, null);
    const by = (id: string) => rows.find((r) => r.id === id);
    expect(by('002-gave-up')).toMatchObject({ tag: 'Abandoned', reason: 'superseded by 005', end: NOW - 2 * HOUR });
    expect(by('004-dropped')).toMatchObject({ tag: 'Abandoned', reason: 'not needed' });
    expect(by('001-old')).toMatchObject({ tag: null, reason: null, total: '10h 00m', rounds: '2 rounds', key: 'pa/001-old', title: 'Old merge' });
    expect(by('003-mid')).toMatchObject({ tag: null, reason: null, rounds: '1 round' });
  });

  test('the title names the settle window', () => {
    expect(settledTitle(settled)).toBe('Settled · merged more than 24h ago');
    expect(settledTitle([...settled, tag(job({ id: '9', stage: 'merged' }), a, 2)])).toBe('Settled · merged more than 2h / 24h ago');
    expect(settledTitle([])).toBe('Settled · merged more than 24h ago');
  });
});
