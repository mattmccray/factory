import { describe, expect, test } from 'bun:test';
import { WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT } from './appmenu';
import { FIT_WIDGET_METHOD, OPEN_JOB_METHOD, SHOW_ANDON_METHOD, fitRequest, fromWidgetWindow, isProjectId, openJobPayload, openJobRequest } from './widget';

describe('092 AC7: the desk widget methods answer only the widget window', () => {
  test('the method names', () => {
    expect([OPEN_JOB_METHOD, SHOW_ANDON_METHOD, FIT_WIDGET_METHOD]).toEqual(['openJob', 'showAndon', 'fitWidget']);
  });

  test("meta.window must be the widget window's id", () => {
    expect(fromWidgetWindow({ window: 'widget' })).toBe(true);
    expect(fromWidgetWindow({ window: 'widget', origin: 'http://127.0.0.1:8766' })).toBe(true);
    for (const meta of [{ window: 'main' }, { window: 'settings' }, { window: 'Widget' }, { window: '' }, {}, null, undefined, 'widget', { window: ['widget'] }]) {
      expect({ meta, ok: fromWidgetWindow(meta) }).toEqual({ meta, ok: false });
    }
  });
});

describe('092 AC7: the open-job request', () => {
  test('a project id is 12 hex digits, with @<machine> for a remote one', () => {
    for (const ok of ['aaaaaaaaaaaa', '0123456789ab', '1a2b3c4d5e6f@studio', '1a2b3c4d5e6f@mac-mini-2']) expect({ ok, valid: isProjectId(ok) }).toEqual({ ok, valid: true });
    for (const bad of ['', 'factory', 'AAAAAAAAAAAA', 'aaaaaaaaaaa', 'aaaaaaaaaaaaa', 'aaaaaaaaaaaa@', 'aaaaaaaaaaaa@-x', 'aaaaaaaaaaaa@x-', 'aaaaaaaaaaaa@Studio', 'aaaaaaaaaaaa@a/b', '../aaaaaaaaaa', 1, null]) {
      expect({ bad, valid: isProjectId(bad) }).toEqual({ bad, valid: false });
    }
  });

  test('exactly a well-formed project id and job id; anything else is refused', () => {
    expect(openJobRequest({ project: 'aaaaaaaaaaaa', job: '092-andon-desk-widget' })).toEqual({ project: 'aaaaaaaaaaaa', job: '092-andon-desk-widget' });
    expect(openJobRequest({ job: '001-a', project: '1a2b3c4d5e6f@studio' })).toEqual({ project: '1a2b3c4d5e6f@studio', job: '001-a' });
    const bad: unknown[] = [
      null,
      undefined,
      'aaaaaaaaaaaa/001-a',
      [],
      {},
      { project: 'aaaaaaaaaaaa' },
      { job: '001-a' },
      { project: 'aaaaaaaaaaaa', job: 'a-001' },
      { project: 'aaaaaaaaaaaa', job: '001-A' },
      { project: 'aaaaaaaaaaaa', job: '001-a/../x' },
      { project: 'factory', job: '001-a' },
      { project: 'aaaaaaaaaaaa', job: '001-a', extra: true },
      { project: 'aaaaaaaaaaaa', job: 1 },
    ];
    for (const p of bad) expect({ p, req: openJobRequest(p) }).toEqual({ p, req: null });
  });

  test("the main window's event carries the job's route ref and nothing else", () => {
    expect(openJobPayload({ project: 'aaaaaaaaaaaa', job: '001-a' })).toEqual({ project: 'aaaaaaaaaaaa', id: '001-a' });
  });
});

describe('092: the fit request', () => {
  test('exactly a whole height within the bounds', () => {
    expect(fitRequest({ height: WIDGET_MIN_HEIGHT })).toEqual({ height: WIDGET_MIN_HEIGHT });
    expect(fitRequest({ height: WIDGET_MAX_HEIGHT })).toEqual({ height: WIDGET_MAX_HEIGHT });
    expect(fitRequest({ height: 158 })).toEqual({ height: 158 });
    for (const p of [null, {}, { height: WIDGET_MIN_HEIGHT - 1 }, { height: WIDGET_MAX_HEIGHT + 1 }, { height: 100.5 }, { height: '100' }, { height: Number.NaN }, { height: 100, x: 0 }, [100]]) {
      expect({ p, req: fitRequest(p) }).toEqual({ p, req: null });
    }
  });
});
