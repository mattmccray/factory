// The backlog parser (job 066): open lines, pointers, briefs' and plans' facts, and explorations.
import { describe, expect, test } from 'bun:test';
import { buildBacklog, docMeta, isBacklogSlug, parseBacklogLines } from './backlog';

const BACKLOG = [
  '# Factory backlog',
  '',
  'Some prose, with a - [ ] inside it.',
  '',
  '- [x] Shipped thing — it shipped — brief: factory/briefs/shipped.md → 012-shipped',
  '- [ ] Queued brief — the brief is done — brief: factory/briefs/queued-brief.md',
  '- [ ] Queued epic — the epic lands — epic: factory/epics/big-epic.md',
  '- [ ] Free text — what done looks like',
  '- [ ] No separator at all',
  '- [ ] Bad slug — done text — brief: factory/briefs/Bad_Slug.md',
  '- [ ] Unknown key — done text — plan: factory/epics/big-epic.md',
  '- [ ] Mismatched dir — done text — brief: factory/epics/big-epic.md',
  '- [ ] Escape — done text — brief: factory/briefs/../../etc.md',
  '- [ ] Missing brief — done — brief: factory/briefs/not-there.md',
  '- [ ] Pointer only — brief: factory/briefs/draft-pointed.md',
  '  - [ ] indented is not a top-level line',
  '* [ ] other bullet',
  '- [X] capital x is not open',
  '',
].join('\n');

const BRIEF_QUEUED = '# The queued brief\n\n- Status: ready\n- Abandoned: 2026-10-01: ran out of rounds\n\n## Intent\nx\n- Abandoned: 2026-10-05: second try\n';
const BRIEF_DRAFT = '# A draft\n\n- Status: draft\n';
const BRIEF_POINTED = '# Pointed draft\n\n- Status: draft\n';
const BRIEF_DONE = '# Done\n\n- Status: done\n';
const BRIEF_NO_STATUS = 'no heading and no status\n';
const PLAN_BIG = '# Big epic\n\n- Status: ready\n\n## Members\n- `one`\n- `two` after: `one`\n- `three`\n';
const PLAN_DRAFT = '# Draft plan\n\n- Status: draft\n- Abandoned: 2026-10-02: replanned\n\n## Members\n- `a`\n- `b`\n';
const PLAN_BROKEN = '# Broken\n\n- Status: draft\n\nno members section\n';

describe('parseBacklogLines', () => {
  test('only open lines, in file order, with kind, slug, title, and done-text; malformed lines are text', () => {
    expect(parseBacklogLines(BACKLOG)).toEqual([
      { kind: 'brief', slug: 'queued-brief', title: 'Queued brief', done: 'the brief is done' },
      { kind: 'epic', slug: 'big-epic', title: 'Queued epic', done: 'the epic lands' },
      { kind: 'text', slug: null, title: 'Free text', done: 'what done looks like' },
      { kind: 'text', slug: null, title: 'No separator at all', done: null },
      { kind: 'text', slug: null, title: 'Bad slug', done: 'done text — brief: factory/briefs/Bad_Slug.md' },
      { kind: 'text', slug: null, title: 'Unknown key', done: 'done text — plan: factory/epics/big-epic.md' },
      { kind: 'text', slug: null, title: 'Mismatched dir', done: 'done text — brief: factory/epics/big-epic.md' },
      { kind: 'text', slug: null, title: 'Escape', done: 'done text — brief: factory/briefs/../../etc.md' },
      { kind: 'brief', slug: 'not-there', title: 'Missing brief', done: 'done' },
      { kind: 'brief', slug: 'draft-pointed', title: 'Pointer only', done: null },
    ]);
  });

  test('empty and odd inputs never throw', () => {
    for (const t of ['', '\n\n', '- [ ] ', '- [ ]  — ', ' — — —', '- [ ] — brief: factory/briefs/x.md', '\u0000\r\n- [ ] a\r']) {
      expect(() => parseBacklogLines(t)).not.toThrow();
    }
    expect(parseBacklogLines('- [ ] a\r\n- [ ] b')).toEqual([
      { kind: 'text', slug: null, title: 'a', done: null },
      { kind: 'text', slug: null, title: 'b', done: null },
    ]);
  });
});

describe('docMeta', () => {
  test('title, status, abandoned attempts in file order, and members', () => {
    expect(docMeta('queued-brief', BRIEF_QUEUED)).toEqual({
      title: 'The queued brief',
      status: 'ready',
      abandoned: ['2026-10-01: ran out of rounds', '2026-10-05: second try'],
      members: 0,
    });
    expect(docMeta('big-epic', PLAN_BIG)).toEqual({ title: 'Big epic', status: 'ready', abandoned: [], members: 3 });
  });

  test('no heading is the slug; no Status line is null; no Members is 0', () => {
    expect(docMeta('loose', BRIEF_NO_STATUS)).toEqual({ title: 'loose', status: null, abandoned: [], members: 0 });
    expect(docMeta('broken', PLAN_BROKEN).members).toBe(0);
    expect(() => docMeta('x', '\u0000## Members\n- `Bad`\n- nope')).not.toThrow();
  });
});

describe('buildBacklog', () => {
  const briefs = new Map([
    ['queued-brief', BRIEF_QUEUED],
    ['a-draft', BRIEF_DRAFT],
    ['draft-pointed', BRIEF_POINTED],
    ['done-brief', BRIEF_DONE],
    ['loose', BRIEF_NO_STATUS],
  ]);
  const plans = new Map([
    ['big-epic', PLAN_BIG],
    ['draft-plan', PLAN_DRAFT],
    ['broken', PLAN_BROKEN],
  ]);

  test('queued items take status, members, and abandoned from the file they point at', () => {
    const { queued } = buildBacklog({ backlog: BACKLOG, briefs, plans });
    expect(queued.map((q) => q.title)).toEqual(['Queued brief', 'Queued epic', 'Free text', 'No separator at all', 'Bad slug', 'Unknown key', 'Mismatched dir', 'Escape', 'Missing brief', 'Pointer only']);
    expect(queued[0]).toEqual({ kind: 'brief', slug: 'queued-brief', title: 'Queued brief', done: 'the brief is done', status: 'ready', members: null, abandoned: ['2026-10-01: ran out of rounds', '2026-10-05: second try'] });
    expect(queued[1]).toEqual({ kind: 'epic', slug: 'big-epic', title: 'Queued epic', done: 'the epic lands', status: 'ready', members: 3, abandoned: [] });
    expect(queued[2]).toEqual({ kind: 'text', slug: null, title: 'Free text', done: 'what done looks like', status: null, members: null, abandoned: [] });
    expect(queued[8]).toEqual({ kind: 'brief', slug: 'not-there', title: 'Missing brief', done: 'done', status: null, members: null, abandoned: [] });
    expect(queued[9]).toEqual({ kind: 'brief', slug: 'draft-pointed', title: 'Pointer only', done: null, status: 'draft', members: null, abandoned: [] });
  });

  test('exploring: unreferenced drafts, briefs before plans, each in slug order', () => {
    const { exploring } = buildBacklog({ backlog: BACKLOG, briefs, plans });
    expect(exploring).toEqual([
      { kind: 'brief', slug: 'a-draft', title: 'A draft', done: null, status: 'draft', members: null, abandoned: [] },
      { kind: 'epic', slug: 'broken', title: 'Broken', done: null, status: 'draft', members: 0, abandoned: [] },
      { kind: 'epic', slug: 'draft-plan', title: 'Draft plan', done: null, status: 'draft', members: 2, abandoned: ['2026-10-02: replanned'] },
    ]);
  });

  test('a missing epic plan keeps the kind and slug with members 0', () => {
    const { queued } = buildBacklog({ backlog: '- [ ] E — d — epic: factory/epics/gone.md\n', briefs: new Map(), plans: new Map() });
    expect(queued).toEqual([{ kind: 'epic', slug: 'gone', title: 'E', done: 'd', status: null, members: 0, abandoned: [] }]);
  });

  test('nothing at all is empty', () => {
    expect(buildBacklog({ backlog: null, briefs: new Map(), plans: new Map() })).toEqual({ queued: [], exploring: [] });
  });
});

test('isBacklogSlug is the slug rule', () => {
  for (const ok of ['a', 'a-b', 'a1-2b', '066-x']) expect(isBacklogSlug(ok)).toBe(true);
  for (const bad of ['', '..', 'A', 'a--b', '-a', 'a-', 'a/b', 'a%2Fb', '%2e%2e', 'a.md']) expect(isBacklogSlug(bad)).toBe(false);
});
