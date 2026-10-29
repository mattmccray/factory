import { describe, expect, test } from 'bun:test';
import { TIMING } from './docs';
import { defaultView, entryOf, epicKey, formatHash, historyStep, initialView, jobKey, parseHash, readEntry, viewKey, viewOf } from './route';
import type { View } from './route';

const v = (fields: Partial<View>): View => {
  const out = { ...defaultView(), ...fields };
  return { ...out, inspector: fields.inspector ?? out.job !== null };
};

describe('the hash round-trips (AC1)', () => {
  const forms: Array<[string, View]> = [
    ['default', v({})],
    ['project=', v({ project: 'p1' })],
    ['job=', v({ job: { project: 'p1', id: '001-a' } })],
    ['job= file=', v({ job: { project: 'p1', id: '001-a' }, file: 'rounds/round-1/review-code.md' })],
    ['file=timing', v({ job: { project: 'p1', id: '001-a' }, file: TIMING })],
    ['settled', v({ settled: { project: null } })],
    ['settled=', v({ settled: { project: 'p2' } })],
    ['needs', v({ needs: true })],
    ['project + needs', v({ project: 'p1', needs: true })],
    ['everything', v({ project: 'p1', job: { project: 'p2', id: '002-b' }, file: 'spec.md', settled: { project: 'p3' }, needs: true })],
    ['job + settled', v({ job: { project: 'p2', id: '002-b' }, settled: { project: null } })],
  ];
  for (const [name, view] of forms) {
    test(name, () => {
      expect(parseHash(formatHash(view))).toEqual(view);
    });
  }

  test('the forms §10 names', () => {
    expect(formatHash(v({ project: 'p1' }))).toBe('#project=p1');
    expect(formatHash(v({ job: { project: 'p1', id: '001-a' }, file: TIMING }))).toBe('#job=p1/001-a&file=timing');
    expect(formatHash(v({ settled: { project: null } }))).toBe('#settled');
    expect(formatHash(v({ settled: { project: 'p1' } }))).toBe('#settled=p1');
    expect(formatHash(v({ needs: true }))).toBe('#needs');
    expect(formatHash(v({}))).toBe('');
  });

  test('ids with &, =, /, #, %, and spaces survive', () => {
    const odd = 'a&b=c/d#e f%g';
    const view = v({ project: odd, job: { project: odd, id: `${odd}-job` }, file: `${odd}.md`, settled: { project: odd }, needs: true });
    const hash = formatHash(view);
    expect(hash.slice(1).split('&')).toHaveLength(5);
    expect(parseHash(hash)).toEqual(view);
  });

  test('a doc literally named "timing" is not the timing view', () => {
    // documents have paths ending in .md; only TIMING formats as `timing`
    expect(formatHash(v({ job: { project: 'p', id: 'j' }, file: 'timing.md' }))).toBe('#job=p/j&file=timing.md');
  });

  test('order does not matter, and the leading # is optional', () => {
    expect(parseHash('needs&project=p1')).toEqual(v({ project: 'p1', needs: true }));
  });

  test('an empty, malformed, or unknown hash is the default view, without throwing', () => {
    for (const h of ['', '#', '#&&', '#foo=bar', '#zoom', '#project=', '#project=%E0%A4%A', '#job=', '#job=p1', '#job=/x', '#job=p1/', '#job=%E0/x', '#file=spec.md', '#needs=1', '#===', '#%']) {
      expect({ h, view: parseHash(h) }).toEqual({ h, view: defaultView() });
    }
  });

  test('unknown keys beside known ones are ignored', () => {
    expect(parseHash('#project=p1&zoom=2&q=x')).toEqual(v({ project: 'p1' }));
  });

  test('jobKey is the board key', () => {
    expect(jobKey({ project: 'p1', id: '001-a' })).toBe('p1/001-a');
  });
});

describe('restoring a view (AC5)', () => {
  test('a hash wins over the stored selection', () => {
    expect(initialView('#project=p2', 'p1', 'all', null).project).toBe('p2');
    expect(initialView('#needs', 'p1', 'all', null)).toEqual(v({ needs: true }));
  });

  test('no hash: the stored selection, nothing open', () => {
    expect(initialView('', 'p1', 'all', null)).toEqual(v({ project: 'p1' }));
    expect(initialView('#', 'all', 'all', null)).toEqual(defaultView());
  });

  test('each hash form maps to its view state', () => {
    const view = initialView('#project=p1&job=p2/002-b&file=timing&settled=p3&needs', 'all', 'all', null);
    expect(view).toEqual({ project: 'p1', inspector: true, job: { project: 'p2', id: '002-b' }, file: TIMING, settled: { project: 'p3' }, sheet: null, needs: true });
  });

  test('history.state carries the sheets and an empty inspector', () => {
    const open = v({ inspector: true, sheet: 'keys' });
    expect(viewOf(formatHash(open), entryOf(open, null))).toEqual(open);
    expect(readEntry({ andon: { sheet: 'rework', inspector: true, under: '|x|' } })).toEqual({ sheet: 'rework', inspector: true, under: '|x|' });
    for (const junk of [null, 3, 'x', { andon: 1 }, { andon: { sheet: 'nope', inspector: 'yes', under: 4 } }]) {
      expect(readEntry(junk)).toEqual({ sheet: null, inspector: false, under: null });
    }
  });
});

describe('push or replace (AC6)', () => {
  const board = v({ project: 'p1' });
  const ins = v({ project: 'p1', job: { project: 'p1', id: '001-a' } });
  const insFile = v({ project: 'p1', job: { project: 'p1', id: '001-a' }, file: 'spec.md' });

  test('opening a layer pushes', () => {
    expect(historyStep(board, ins, null)).toBe('push');
    expect(historyStep(board, v({ project: 'p1', inspector: true }), null)).toBe('push');
    expect(historyStep(board, v({ project: 'p1', settled: { project: null } }), null)).toBe('push');
    expect(historyStep(board, v({ project: 'p1', settled: { project: 'p1' } }), null)).toBe('push');
    expect(historyStep(ins, { ...ins, sheet: 'rework' }, null)).toBe('push');
    expect(historyStep(ins, { ...ins, sheet: 'abandon' }, null)).toBe('push');
    expect(historyStep(board, { ...board, sheet: 'keys' }, null)).toBe('push');
  });

  test('opening a job from the Settled sheet pushes the inspector', () => {
    expect(historyStep(v({ settled: { project: null } }), v({ job: { project: 'p1', id: '001-a' } }), viewKey(v({})))).toBe('push');
  });

  test('changing files, focus, or Needs Me replaces', () => {
    expect(historyStep(ins, insFile, viewKey(board))).toBe('replace');
    expect(historyStep(insFile, { ...insFile, file: TIMING }, viewKey(board))).toBe('replace');
    expect(historyStep(board, v({ project: 'p2' }), null)).toBe('replace');
    expect(historyStep(board, v({}), null)).toBe('replace');
    expect(historyStep(board, { ...board, needs: true }, null)).toBe('replace');
    expect(historyStep(ins, { ...ins, needs: true }, viewKey(board))).toBe('replace');
    expect(historyStep(v({ settled: { project: 'p1' } }), v({ settled: { project: null } }), null)).toBe('replace');
  });

  test('switching jobs in an open inspector replaces', () => {
    expect(historyStep(ins, v({ project: 'p1', job: { project: 'p1', id: '002-b' } }), viewKey(board))).toBe('replace');
  });

  test('closing a layer onto the view it was pushed over goes back; else it replaces', () => {
    expect(historyStep(insFile, board, viewKey(board))).toBe('back');
    expect(historyStep({ ...ins, sheet: 'rework' }, ins, viewKey(ins))).toBe('back');
    expect(historyStep(ins, board, null)).toBe('replace'); // loaded from a link: nothing under it
    expect(historyStep(ins, v({}), viewKey(board))).toBe('replace'); // the focus changed meanwhile
  });

  test('no change, no step', () => {
    expect(historyStep(ins, { ...ins }, null)).toBe('none');
  });
});

describe('the epic= hash form (056 AC6)', () => {
  const E = { project: 'p1', slug: 'auth' };
  const ev = (fields: Partial<View>): View => ({ ...v(fields), inspector: true });

  test('round-trips through formatHash and parseHash, with a file and with the other forms', () => {
    for (const view of [
      ev({ epic: E }),
      ev({ epic: E, file: 'epics/auth.md' }),
      ev({ epic: { project: 'a/b c', slug: 'x&y' }, file: 'briefs/a b.md' }),
      ev({ project: 'p1', epic: E, settled: { project: null }, needs: true }),
    ]) {
      expect(parseHash(formatHash(view))).toEqual(view);
    }
    expect(formatHash(ev({ epic: E, file: 'epics/auth.md' }))).toBe('#epic=p1/auth&file=epics%2Fauth.md');
    expect(epicKey(E)).toBe('p1/auth');
  });

  test('malformed forms are ignored, and an epic wins over a job', () => {
    for (const h of ['#epic=', '#epic', '#epic=p1', '#epic=p1/', '#epic=/auth', '#epic=%E0%A4%A/auth', '#epic=p1/%zz']) {
      expect({ h, view: parseHash(h) }).toEqual({ h, view: defaultView() });
    }
    expect(parseHash('#epic=p1/auth&job=p1/001-a')).toEqual(ev({ epic: E }));
    expect(parseHash('#job=p1/001-a&epic=p1/auth&file=x.md')).toEqual(ev({ epic: E, file: 'x.md' }));
    expect(parseHash('#file=x.md')).toEqual(defaultView()); // a file needs a job or an epic
  });

  test('an open epic is a layer: opening it pushes, and its Abandon… sheet rides in history.state', () => {
    const board = v({});
    const page = ev({ epic: E });
    expect(historyStep(board, page, null)).toBe('push');
    expect(entryOf(page, null)).toEqual({ andon: { inspector: false, sheet: null, under: null } });
    const sheet = { ...page, sheet: 'epic-abandon' as const };
    expect(historyStep(page, sheet, null)).toBe('push');
    expect(viewOf(formatHash(sheet), entryOf(sheet, viewKey(page)))).toEqual(sheet);
    expect(readEntry({ andon: { sheet: 'epic-abandon' } }).sheet).toBe('epic-abandon');
    expect(viewKey(page)).not.toBe(viewKey({ ...board, inspector: true }));
  });
});
