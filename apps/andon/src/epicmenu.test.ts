import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EPIC_MENU_METHOD, boardEpic, epicCopyFailureText, epicItemId, epicMenuItems, epicMenuRequest, epicOpenFailureText, epicSession, isEpicItemId, isEpicSlug, parseEpicItemId } from './epicmenu';
import type { Session } from './jobmenu';

const PID = 'aaaaaaaaaaaa';
const EPIC = 'andon-window-polish';
const SESSION: Session = { app: 't3code', environment: 'env-1', thread: 'thread-E' };

describe('076 AC1: the menu and its ids', () => {
  test('the method is epicMenu', () => {
    expect(EPIC_MENU_METHOD).toBe('epicMenu');
  });

  test('Open in T3 Code, a separator, then Copy Epic Name', () => {
    expect(epicMenuItems(PID, EPIC, true)).toEqual([
      { id: `epic-menu:t3:${PID}:${EPIC}`, label: 'Open in T3 Code', enabled: true },
      { separator: true },
      { id: `epic-menu:copy:${PID}:${EPIC}`, label: 'Copy Epic Name' },
    ]);
    const grayed = epicMenuItems(PID, EPIC, false);
    expect(grayed[0]).toEqual({ id: `epic-menu:t3:${PID}:${EPIC}`, label: 'Open in T3 Code', enabled: false });
    expect(grayed[2]?.enabled).toBeUndefined();
  });

  test('a well-formed session passes the job menu check; a missing, null, or malformed one does not', () => {
    expect(epicSession({ slug: EPIC, session: SESSION })).toEqual(SESSION);
    for (const session of [undefined, null, 'x', [], { ...SESSION, app: 'codex' }, { ...SESSION, thread: 'a/b' }, { ...SESSION, environment: '' }, { ...SESSION, url: 't3code://threads/x/y' }, { app: 't3code', thread: 'x' }]) {
      expect({ session, s: epicSession({ slug: EPIC, session }) }).toEqual({ session, s: null });
    }
    expect(epicSession({ slug: EPIC })).toBeNull();
  });
});

describe('076 AC3: the request, the slug, the ids, and the epic lookup', () => {
  test('a request is exactly a project id and an epic slug', () => {
    expect(epicMenuRequest({ project: PID, epic: EPIC })).toEqual({ project: PID, epic: EPIC });
    expect(epicMenuRequest({ epic: EPIC, project: PID })).toEqual({ project: PID, epic: EPIC });
  });

  test('anything else is refused', () => {
    for (const params of [
      undefined,
      null,
      PID,
      [],
      { project: PID },
      { epic: EPIC },
      { project: '', epic: EPIC },
      { project: 7, epic: EPIC },
      { project: PID, epic: 'Bad_Slug' },
      { project: PID, epic: 'a'.repeat(41) },
      { project: PID, epic: '../x' },
      { project: PID, epic: '001-job-like' },
      { project: PID, epic: EPIC, thread: 'thread-B' },
      { project: PID, epic: EPIC, session: SESSION },
      { project: PID, job: EPIC },
    ]) {
      expect({ params, req: epicMenuRequest(params) }).toEqual({ params, req: null });
    }
  });

  test("the epic slug is the contract's form: the slug rule, at most 40 characters, not a job id", () => {
    for (const s of [EPIC, 'a', 'a-1', 'a'.repeat(40)]) expect(isEpicSlug(s)).toBe(true);
    for (const s of ['', 'a'.repeat(41), 'A', 'a--b', '-a', 'a-', 'a_b', 'a/b', '040-x', 7, null]) expect({ s, ok: isEpicSlug(s) }).toEqual({ s, ok: false });
  });

  test('item ids round-trip, and only well-formed ones of ours parse', () => {
    expect(parseEpicItemId(epicItemId('t3', PID, EPIC))).toEqual({ item: 't3', pid: PID, epic: EPIC });
    expect(parseEpicItemId(epicItemId('copy', PID, EPIC))).toEqual({ item: 'copy', pid: PID, epic: EPIC });
    for (const id of [null, 7, '', 'epic-menu', `epic-menu:t3:${PID}`, `epic-menu:rm:${PID}:${EPIC}`, `epic-menu:t3::${EPIC}`, `epic-menu:t3:${PID}:Bad`, `epic-menu:t3:${PID}:${EPIC}:x`, `job-menu:t3:${PID}:${EPIC}`, `epic-menu:t3:${PID}:${'a'.repeat(41)}`]) {
      expect({ id, parsed: parseEpicItemId(id) }).toEqual({ id, parsed: null });
    }
    expect(isEpicItemId(epicItemId('copy', PID, EPIC))).toBe(true);
    expect(isEpicItemId(`job-menu:copy:${PID}:040-x`)).toBe(false);
  });

  test("the epic is found by slug in the board's epics, else null", () => {
    const board = { jobs: [{ id: EPIC }], epics: [{ slug: 'other' }, { slug: EPIC, session: SESSION }, 'junk'] };
    expect(boardEpic(board, EPIC)).toEqual({ slug: EPIC, session: SESSION });
    expect(boardEpic(board, 'missing')).toBeNull();
    for (const b of [null, [], {}, { epics: {} }, { epics: null }, { jobs: [{ slug: EPIC }] }]) expect(boardEpic(b, EPIC)).toBeNull();
  });
});

describe('076 AC2: the failure text', () => {
  test('open and copy failures name the epic and the reason', () => {
    expect(epicOpenFailureText(EPIC, 'no app')).toBe(`Couldn't open the epic ${EPIC} in T3 Code: no app`);
    expect(epicCopyFailureText(EPIC, 'refused')).toBe(`Couldn't copy the epic name ${EPIC}: refused`);
  });
});

describe('076 AC4: the session check is the job menu\'s, imported', () => {
  test('epicmenu.ts imports isSession from jobmenu.ts and defines neither isSession nor threadLink', () => {
    const src = readFileSync(join(import.meta.dir, 'epicmenu.ts'), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bisSession\b[^}]*\} from '\.\/jobmenu';/);
    expect(src).not.toMatch(/function isSession|const isSession|const threadLink|function threadLink|t3code:\/\//);
    const backend = readFileSync(join(import.meta.dir, 'backend.ts'), 'utf8');
    expect(backend).toMatch(/import \{[^}]*\bthreadLink\b[^}]*\} from '\.\/jobmenu';/);
    expect(backend.match(/t3code:\/\//g)).toBeNull();
  });
});
