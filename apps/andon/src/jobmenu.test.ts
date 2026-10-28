import { describe, expect, test } from 'bun:test';
import { JOB_MENU_METHOD, boardJob, copyFailureText, isJobId, isJobItemId, isSession, jobItemId, jobMenuItems, jobMenuRequest, jobSession, openFailureText, parseJobItemId, threadLink } from './jobmenu';

const PID = 'aaaaaaaaaaaa';
const JOB = '040-job-context-menu';
const SESSION = { app: 't3code', environment: 'env-1', thread: 'thread-A' };

describe('AC1: the menu and its ids', () => {
  test('the method is jobMenu', () => {
    expect(JOB_MENU_METHOD).toBe('jobMenu');
  });

  test('Open in T3 Code, a separator, then Copy Job ID', () => {
    expect(jobMenuItems(PID, JOB, true)).toEqual([
      { id: `job-menu:t3:${PID}:${JOB}`, label: 'Open in T3 Code', enabled: true },
      { separator: true },
      { id: `job-menu:copy:${PID}:${JOB}`, label: 'Copy Job ID' },
    ]);
  });

  test('item ids round-trip, and only well-formed ones of ours parse', () => {
    expect(parseJobItemId(jobItemId('t3', PID, JOB))).toEqual({ item: 't3', pid: PID, job: JOB });
    expect(parseJobItemId(jobItemId('copy', PID, JOB))).toEqual({ item: 'copy', pid: PID, job: JOB });
    for (const id of [null, 7, '', 'job-menu', `job-menu:t3:${PID}`, `job-menu:rm:${PID}:${JOB}`, `job-menu:t3::${JOB}`, `job-menu:t3:${PID}:Bad`, `job-menu:t3:${PID}:${JOB}:x`, `project-menu:t3:${PID}`, `job-menu:t3:${PID}:../x`]) {
      expect({ id, parsed: parseJobItemId(id) }).toEqual({ id, parsed: null });
    }
    expect(isJobItemId(jobItemId('copy', PID, JOB))).toBe(true);
    expect(isJobItemId(`project-menu:copy:${PID}`)).toBe(false);
  });

  test('the link is t3code://threads/<environment>/<thread>', () => {
    expect(threadLink({ app: 't3code', environment: 'env-1', thread: 'thread-A' })).toBe('t3code://threads/env-1/thread-A');
  });
});

describe('AC2: the session check', () => {
  test('a well-formed session passes, and its ids are kept exactly', () => {
    expect(isSession(SESSION)).toBe(true);
    expect(isSession({ app: 't3code', environment: 'a'.repeat(64), thread: 'Z-9' })).toBe(true);
    expect(jobSession({ id: JOB, session: SESSION })).toEqual({ app: 't3code', environment: 'env-1', thread: 'thread-A' });
  });

  test('a missing, null, or malformed session is ignored', () => {
    const bad: unknown[] = [
      undefined,
      null,
      't3code:env-1/thread-A',
      [],
      { ...SESSION, app: 'codex' },
      { app: 't3code', environment: 'env-1' },
      { app: 't3code', thread: 'thread-A' },
      { ...SESSION, environment: '' },
      { ...SESSION, thread: '' },
      { ...SESSION, thread: 'a'.repeat(65) },
      { ...SESSION, environment: 'env/1' },
      { ...SESSION, thread: 'thread:A' },
      { ...SESSION, thread: 'thread A' },
      { ...SESSION, thread: 7 },
      { ...SESSION, url: 't3code://threads/x/y' },
    ];
    for (const session of bad) {
      expect({ session, ok: isSession(session) }).toEqual({ session, ok: false });
      expect({ session, s: jobSession({ id: JOB, session }) }).toEqual({ session, s: null });
    }
    expect(jobSession({ id: JOB })).toBeNull();
  });

  test('grayed out when it cannot open; Copy Job ID stays enabled', () => {
    const items = jobMenuItems(PID, JOB, false);
    expect(items[0]).toEqual({ id: `job-menu:t3:${PID}:${JOB}`, label: 'Open in T3 Code', enabled: false });
    expect(items[2]?.enabled).toBeUndefined();
  });
});

describe('AC3: the request and the job lookup', () => {
  test('a request is exactly a project id and a job id of the factory form', () => {
    expect(jobMenuRequest({ project: PID, job: JOB })).toEqual({ project: PID, job: JOB });
    expect(jobMenuRequest({ job: JOB, project: PID })).toEqual({ project: PID, job: JOB });
  });

  test('anything else is refused, including extra page-supplied fields', () => {
    for (const params of [
      undefined,
      null,
      PID,
      [],
      { project: PID },
      { job: JOB },
      { project: '', job: JOB },
      { project: 7, job: JOB },
      { project: PID, job: 'job-context-menu' },
      { project: PID, job: '40-x' },
      { project: PID, job: '040-Job' },
      { project: PID, job: '040-x/../y' },
      { project: PID, job: JOB, thread: 'thread-B' },
      { project: PID, job: JOB, url: 't3code://threads/e/t' },
      { project: PID, job: JOB, session: SESSION },
    ]) {
      expect({ params, req: jobMenuRequest(params) }).toEqual({ params, req: null });
    }
  });

  test('the job id form is three digits and a slug', () => {
    for (const id of [JOB, '001-a', '123-a-b-9']) expect(isJobId(id)).toBe(true);
    for (const id of ['', '01-a', '0001-a', '001-', '001_a', '001-A', 'abc-def', 7, null]) expect({ id, ok: isJobId(id) }).toEqual({ id, ok: false });
  });

  test("the job is found by id on the board's jobs, else null", () => {
    const board = { jobs: [{ id: '039-other' }, { id: JOB, session: SESSION }, 'junk'] };
    expect(boardJob(board, JOB)).toEqual({ id: JOB, session: SESSION });
    expect(boardJob(board, '041-missing')).toBeNull();
    for (const b of [null, [], {}, { jobs: {} }, { jobs: null }]) expect(boardJob(b, JOB)).toBeNull();
  });
});

describe('AC4: the failure text', () => {
  test('open and copy failures name the job and the reason', () => {
    expect(openFailureText(JOB, 'no app')).toBe(`Couldn't open ${JOB} in T3 Code: no app`);
    expect(copyFailureText(JOB, 'refused')).toBe(`Couldn't copy the job ID ${JOB}: refused`);
  });
});
