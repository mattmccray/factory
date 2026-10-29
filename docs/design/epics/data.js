// Shared fixture for every Andon overview mock-up: one frozen moment across 12 projects.
// Stages follow factory/v1: claimed → spec → build → review → approve → merged, plus
// needs-human (escalated or merge failed). A merged job older than 24h is *settled*.
// Times are minutes before NOW. Verdicts: PASS | CHANGES | pending.
//
// Epics (design mock-up): an epic runs a set of member briefs, ordered by `after:` edges, on an
// integration branch `factory/epic/<slug>`. Member jobs are ordinary jobs whose target is the epic
// branch (`epic: <slug>`); generated helper jobs carry `helper: 'sync' | 'fix'`. A member merged
// into the epic branch is not on the project's target yet, so it never settles: it stays in
// Merged, marked "in epic", until the epic lands with one merge. Members with no job yet are
// derived as queued (deps unmet or parallel cap) or blocked on <job> (a dependency escalated).
(function () {
  const NOW = Date.parse('2026-10-25T16:30:00Z');
  const ago = (m) => NOW - m * 60000;

  const projects = [
    { id: 'factory', name: 'factory', reviewers: ['security', 'contract', 'code', 'ui'] },
    { id: 'minerva', name: 'minerva', reviewers: ['security', 'ux', 'ui', 'code'] },
    { id: 'aegis', name: 'aegis-v5', reviewers: ['security', 'code', 'ui'] },
    { id: 'brain', name: 'brain-cli', reviewers: ['code'] },
    { id: 'tinyjs', name: 'tinyjs', reviewers: ['code', 'ui'] },
    { id: 'ledger', name: 'ledgerline', reviewers: ['security', 'code'] },
    { id: 'harbor', name: 'harbor', reviewers: ['security', 'code'] },
    { id: 'quill', name: 'quill', reviewers: ['ux', 'code'] },
    { id: 'orchard', name: 'orchard', reviewers: ['security', 'ux', 'code'] },
    { id: 'beacon', name: 'beacon', reviewers: ['code'] },
    { id: 'carto', name: 'cartograph', reviewers: ['code', 'ui'] },
    { id: 'sundial', name: 'sundial', reviewers: ['code'] },
  ];

  // history: [stage, minutesAgo] in order. rounds: { round, at, reviews: { key: [verdict, finishedMinutesAgo|null] } }
  // kind (derived for convenience): settled | merged | needs-human | review-failed | reviewing | approve | build | spec | claimed
  const J = (o) => o;
  const jobs = [
    // ── factory ──
    J({ project: 'factory', id: '022-board-timeline', title: 'Timeline view for the Andon overview', stage: 'build', round: 0, maxRound: 2,
      history: [['claimed', 52], ['spec', 50], ['build', 31]], rounds: [], decision: null, note: '' }),
    J({ project: 'factory', id: '023-upgrade-dry-run', title: 'factory upgrade --dry-run prints the plan', stage: 'review', round: 1, maxRound: 2,
      history: [['claimed', 140], ['spec', 138], ['build', 121], ['review', 64]],
      rounds: [{ round: 1, at: 64, reviews: { security: ['PASS', 41], contract: ['pending', null], code: ['pending', null], ui: ['PASS', 58] } }], decision: null, note: '' }),
    J({ project: 'factory', id: '021-tinyjs-065-types', title: 'Move the shell to Tiny JS 0.65 types', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 410], ['spec', 405], ['build', 380], ['review', 300], ['approve', 230], ['merged', 214]],
      rounds: [{ round: 1, at: 300, reviews: { security: ['PASS', 270], contract: ['PASS', 262], code: ['PASS', 241], ui: ['PASS', 255] } }], decision: 'APPROVE', note: 'merged 7905ffe' }),
    J({ project: 'factory', id: '020-overlay-outcome', title: 'Overlay outcome rule in role templates', stage: 'merged', round: 2, maxRound: 2,
      history: [['claimed', 2900], ['spec', 2890], ['build', 2860], ['review', 2790], ['build', 2740], ['review', 2690], ['approve', 2640], ['merged', 2620]],
      rounds: [{ round: 1, at: 2790, reviews: { security: ['PASS', 2770], contract: ['CHANGES', 2750], code: ['PASS', 2760], ui: ['PASS', 2775] } },
               { round: 2, at: 2690, reviews: { security: ['PASS', 2670], contract: ['PASS', 2655], code: ['PASS', 2660], ui: ['PASS', 2680] } }], decision: 'APPROVE', note: 'merged a1edc16' }),
    // factory · epic archive-record (target factory/epic/archive-record)
    J({ project: 'factory', epic: 'archive-record', id: '024-backlog-open-only', title: 'Backlog lists open jobs only', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 698], ['spec', 694], ['build', 668], ['review', 610], ['approve', 575], ['merged', 566]],
      rounds: [{ round: 1, at: 610, reviews: { security: ['PASS', 596], contract: ['PASS', 588], code: ['PASS', 580], ui: ['PASS', 600] } }], decision: 'APPROVE', note: 'merged 4c81d0a' }),
    J({ project: 'factory', epic: 'archive-record', id: '025-job-archive', title: 'Move settled jobs to an archive record', stage: 'merged', round: 2, maxRound: 2,
      history: [['claimed', 565], ['spec', 561], ['build', 530], ['review', 455], ['build', 420], ['review', 372], ['approve', 340], ['merged', 331]],
      rounds: [{ round: 1, at: 455, reviews: { security: ['PASS', 440], contract: ['CHANGES', 424], code: ['PASS', 432], ui: ['PASS', 446] } },
               { round: 2, at: 372, reviews: { security: ['PASS', 360], contract: ['PASS', 349], code: ['PASS', 352], ui: ['PASS', 364] } }], decision: 'APPROVE', note: 'merged b0e7f52' }),
    J({ project: 'factory', epic: 'archive-record', id: '026-andon-reads-archive', title: 'Andon reads settled jobs from the archive', stage: 'review', round: 1, maxRound: 2,
      history: [['claimed', 330], ['spec', 326], ['build', 298], ['review', 41]],
      rounds: [{ round: 1, at: 41, reviews: { security: ['PASS', 19], contract: ['pending', null], code: ['pending', null], ui: ['PASS', 27] } }], decision: null, note: '' }),
    J({ project: 'factory', epic: 'archive-record', id: '027-job-prune', title: 'factory prune drops archived worktrees', stage: 'build', round: 0, maxRound: 2,
      history: [['claimed', 329], ['spec', 325], ['build', 26]], rounds: [], decision: null, note: '' }),
    J({ project: 'factory', epic: 'archive-record', helper: 'sync', id: '028-sync-archive-record', title: 'Sync main into the epic branch', stage: 'approve', round: 1, maxRound: 2,
      history: [['claimed', 208], ['build', 206], ['review', 170], ['approve', 9]],
      rounds: [{ round: 1, at: 170, reviews: { security: ['PASS', 150], contract: ['PASS', 141], code: ['PASS', 12], ui: ['PASS', 155] } }], decision: null,
      note: 'conflict in apps/andon/src/settled.ts after 021 landed on main' }),

    // ── minerva ──
    J({ project: 'minerva', id: '041-notes-search', title: 'Full-text search across notes', stage: 'review', round: 2, maxRound: 2,
      history: [['claimed', 300], ['spec', 296], ['build', 270], ['review', 200], ['build', 160], ['review', 38]],
      rounds: [{ round: 1, at: 200, reviews: { security: ['PASS', 180], ux: ['PASS', 175], ui: ['PASS', 178], code: ['CHANGES', 162] } },
               { round: 2, at: 38, reviews: { security: ['PASS', 22], ux: ['pending', null], ui: ['PASS', 19], code: ['pending', null] } }], decision: null, note: '' }),
    J({ project: 'minerva', id: '040-tag-migration', title: 'Migrate tags to a join table', stage: 'needs-human', round: 1, maxRound: 2,
      history: [['claimed', 520], ['spec', 515], ['build', 490], ['review', 430], ['approve', 380], ['needs-human', 366]],
      rounds: [{ round: 1, at: 430, reviews: { security: ['PASS', 410], ux: ['PASS', 405], ui: ['PASS', 400], code: ['PASS', 392] } }],
      decision: 'ESCALATE', note: 'approver: migration drops notes.tags without a backfill' }),
    J({ project: 'minerva', id: '039-daily-digest', title: 'Daily digest email', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 240], ['spec', 236], ['build', 210], ['review', 150], ['approve', 90], ['merged', 64]],
      rounds: [{ round: 1, at: 150, reviews: { security: ['PASS', 130], ux: ['PASS', 120], ui: ['PASS', 125], code: ['PASS', 100] } }], decision: 'APPROVE', note: 'merged 3c9e01a' }),
    J({ project: 'minerva', id: '038-keyboard-nav', title: 'Keyboard navigation in the sidebar', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 3100], ['spec', 3095], ['build', 3070], ['review', 3010], ['approve', 2960], ['merged', 2950]],
      rounds: [{ round: 1, at: 3010, reviews: { security: ['PASS', 2990], ux: ['PASS', 2980], ui: ['PASS', 2985], code: ['PASS', 2970] } }], decision: 'APPROVE', note: 'merged 77ad2b0' }),
    // minerva · epic tags-v2 (target factory/epic/tags-v2)
    J({ project: 'minerva', epic: 'tags-v2', id: '042-tag-colors', title: 'Tag colors', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 548], ['spec', 544], ['build', 520], ['review', 470], ['approve', 432], ['merged', 424]],
      rounds: [{ round: 1, at: 470, reviews: { security: ['PASS', 455], ux: ['PASS', 450], ui: ['PASS', 446], code: ['PASS', 440] } }], decision: 'APPROVE', note: 'merged 9a2c4e1' }),
    J({ project: 'minerva', epic: 'tags-v2', id: '043-tag-rename', title: 'Rename a tag everywhere', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 547], ['spec', 543], ['build', 515], ['review', 452], ['approve', 410], ['merged', 401]],
      rounds: [{ round: 1, at: 452, reviews: { security: ['PASS', 438], ux: ['PASS', 433], ui: ['PASS', 429], code: ['PASS', 418] } }], decision: 'APPROVE', note: 'merged 1f7b3d8' }),
    J({ project: 'minerva', epic: 'tags-v2', id: '044-tag-hierarchy', title: 'Nested tags', stage: 'needs-human', round: 1, maxRound: 2,
      history: [['claimed', 423], ['spec', 419], ['build', 392], ['review', 318], ['approve', 262], ['needs-human', 248]],
      rounds: [{ round: 1, at: 318, reviews: { security: ['PASS', 300], ux: ['PASS', 294], ui: ['PASS', 290], code: ['PASS', 276] } }],
      decision: 'ESCALATE', note: 'approver: a tag can be made its own ancestor; the tree query never ends' }),

    // ── aegis ──
    J({ project: 'aegis', id: '112-admin-roles', title: 'Admin role editor', stage: 'approve', round: 1, maxRound: 2,
      history: [['claimed', 180], ['spec', 176], ['build', 150], ['review', 70], ['approve', 6]],
      rounds: [{ round: 1, at: 70, reviews: { security: ['PASS', 30], code: ['PASS', 12], ui: ['PASS', 44] } }], decision: null, note: '' }),
    J({ project: 'aegis', id: '113-audit-log', title: 'Audit log for project changes', stage: 'spec', round: 0, maxRound: 2,
      history: [['claimed', 9], ['spec', 7]], rounds: [], decision: null, note: '' }),
    J({ project: 'aegis', id: '111-session-timeout', title: 'Configurable session timeout', stage: 'needs-human', round: 1, maxRound: 2,
      history: [['claimed', 400], ['spec', 396], ['build', 370], ['review', 310], ['approve', 250], ['needs-human', 232]],
      rounds: [{ round: 1, at: 310, reviews: { security: ['PASS', 290], code: ['PASS', 270], ui: ['PASS', 280] } }],
      decision: 'APPROVE', note: 'merge failed: conflict in src/routes/(admin)/+layout.svelte' }),
    J({ project: 'aegis', id: '110-project-archive', title: 'Archive projects', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 4300], ['spec', 4295], ['build', 4270], ['review', 4200], ['approve', 4150], ['merged', 4140]],
      rounds: [{ round: 1, at: 4200, reviews: { security: ['PASS', 4180], code: ['PASS', 4170], ui: ['PASS', 4175] } }], decision: 'APPROVE', note: 'merged e01f9c2' }),
    // aegis-v5 · epic admin-console (target factory/epic/admin-console); every member merged in epic
    J({ project: 'aegis', epic: 'admin-console', id: '114-admin-shell', title: 'Admin console shell and nav', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 843], ['spec', 839], ['build', 810], ['review', 740], ['approve', 702], ['merged', 694]],
      rounds: [{ round: 1, at: 740, reviews: { security: ['PASS', 722], code: ['PASS', 712], ui: ['PASS', 728] } }], decision: 'APPROVE', note: 'merged 3e90b6f' }),
    J({ project: 'aegis', epic: 'admin-console', id: '115-admin-users', title: 'User management page', stage: 'merged', round: 2, maxRound: 2,
      history: [['claimed', 690], ['spec', 686], ['build', 655], ['review', 560], ['build', 520], ['review', 430], ['approve', 396], ['merged', 388]],
      rounds: [{ round: 1, at: 560, reviews: { security: ['CHANGES', 532], code: ['PASS', 540], ui: ['PASS', 548] } },
               { round: 2, at: 430, reviews: { security: ['PASS', 410], code: ['PASS', 404], ui: ['PASS', 418] } }], decision: 'APPROVE', note: 'merged c51a7e0' }),
    J({ project: 'aegis', epic: 'admin-console', id: '116-admin-settings', title: 'Workspace settings page', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 689], ['spec', 685], ['build', 640], ['review', 120], ['approve', 44], ['merged', 31]],
      rounds: [{ round: 1, at: 120, reviews: { security: ['PASS', 92], code: ['PASS', 78], ui: ['PASS', 101] } }], decision: 'APPROVE', note: 'merged 07dd5a2' }),

    // ── brain-cli ──
    J({ project: 'brain', id: '017-stage-diff', title: '017-stage-diff', stage: 'claimed', round: 0, maxRound: 2,
      history: [['claimed', 1]], rounds: [], decision: null, note: '' }),
    J({ project: 'brain', id: '016-milestone-close', title: 'Close a milestone from the CLI', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 470], ['spec', 466], ['build', 440], ['review', 400], ['approve', 380], ['merged', 372]],
      rounds: [{ round: 1, at: 400, reviews: { code: ['PASS', 385] } }], decision: 'APPROVE', note: 'merged 5b2d7e4' }),

    // ── tinyjs ──
    J({ project: 'tinyjs', id: '066-tray-menu', title: 'Tray menu API', stage: 'build', round: 1, maxRound: 2,
      history: [['claimed', 220], ['spec', 216], ['build', 190], ['review', 120], ['build', 17]],
      rounds: [{ round: 1, at: 120, reviews: { code: ['PASS', 90], ui: ['CHANGES', 20] } }], decision: null, note: 'R1 ui: menu items ignore the disabled flag' }),
    J({ project: 'tinyjs', id: '065-window-types', title: 'Ship window types in the package', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 1900], ['spec', 1896], ['build', 1870], ['review', 1820], ['approve', 1790], ['merged', 1780]],
      rounds: [{ round: 1, at: 1820, reviews: { code: ['PASS', 1800], ui: ['PASS', 1805] } }], decision: 'APPROVE', note: 'merged 0ac41de' }),

    // ── ledgerline ──
    J({ project: 'ledger', id: '008-csv-import', title: 'Import transactions from CSV', stage: 'review', round: 1, maxRound: 2,
      history: [['claimed', 160], ['spec', 156], ['build', 130], ['review', 55]],
      rounds: [{ round: 1, at: 55, reviews: { security: ['CHANGES', 3], code: ['PASS', 26] } }], decision: null, note: 'R1 security: CSV formulas not escaped on export' }),
    J({ project: 'ledger', id: '007-oauth-banks', title: 'OAuth bank connections', stage: 'needs-human', round: 2, maxRound: 2,
      history: [['claimed', 700], ['spec', 695], ['build', 660], ['review', 590], ['build', 560], ['review', 470], ['needs-human', 440]],
      rounds: [{ round: 1, at: 590, reviews: { security: ['CHANGES', 565], code: ['PASS', 575] } },
               { round: 2, at: 470, reviews: { security: ['CHANGES', 442], code: ['PASS', 455] } }],
      decision: null, note: 'review budget spent: security CHANGES in R2 (tokens logged)' }),
    J({ project: 'ledger', id: '006-currency-format', title: 'Locale-aware currency format', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 2300], ['spec', 2296], ['build', 2270], ['review', 2220], ['approve', 2190], ['merged', 2185]],
      rounds: [{ round: 1, at: 2220, reviews: { security: ['PASS', 2200], code: ['PASS', 2205] } }], decision: 'APPROVE', note: 'merged 91be3f0' }),

    // ── harbor (idle) ──
    J({ project: 'harbor', id: '014-health-checks', title: 'Container health checks', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 5200], ['spec', 5195], ['build', 5160], ['review', 5100], ['approve', 5070], ['merged', 5060]],
      rounds: [{ round: 1, at: 5100, reviews: { security: ['PASS', 5080], code: ['PASS', 5085] } }], decision: 'APPROVE', note: 'merged 4d0c8aa' }),
    J({ project: 'harbor', id: '013-port-ranges', title: 'Port range validation', stage: 'merged', round: 2, maxRound: 2,
      history: [['claimed', 6100], ['spec', 6095], ['build', 6070], ['review', 6000], ['build', 5970], ['review', 5900], ['approve', 5870], ['merged', 5860]],
      rounds: [{ round: 1, at: 6000, reviews: { security: ['PASS', 5980], code: ['CHANGES', 5975] } },
               { round: 2, at: 5900, reviews: { security: ['PASS', 5885], code: ['PASS', 5880] } }], decision: 'APPROVE', note: 'merged 2e7b11c' }),

    // ── quill ──
    J({ project: 'quill', id: '003-export-pdf', title: 'Export a draft to PDF', stage: 'build', round: 0, maxRound: 2,
      history: [['claimed', 75], ['spec', 72], ['build', 48]], rounds: [], decision: null, note: '' }),
    J({ project: 'quill', id: '002-word-count', title: 'Live word count', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 1300], ['spec', 1296], ['build', 1270], ['review', 1230], ['approve', 1210], ['merged', 1200]],
      rounds: [{ round: 1, at: 1230, reviews: { ux: ['PASS', 1215], code: ['PASS', 1218] } }], decision: 'APPROVE', note: 'merged c3f0b19' }),

    // ── orchard ──
    J({ project: 'orchard', id: '019-sync-retry', title: 'Retry failed syncs with backoff', stage: 'review', round: 1, maxRound: 2,
      history: [['claimed', 95], ['spec', 92], ['build', 70], ['review', 12]],
      rounds: [{ round: 1, at: 12, reviews: { security: ['pending', null], ux: ['pending', null], code: ['pending', null] } }], decision: null, note: '' }),
    J({ project: 'orchard', id: '018-offline-queue', title: 'Offline write queue', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 3600], ['spec', 3595], ['build', 3560], ['review', 3500], ['approve', 3470], ['merged', 3460]],
      rounds: [{ round: 1, at: 3500, reviews: { security: ['PASS', 3480], ux: ['PASS', 3485], code: ['PASS', 3478] } }], decision: 'APPROVE', note: 'merged 6a5e2d9' }),

    // ── beacon (idle) ──
    J({ project: 'beacon', id: '005-status-page', title: 'Public status page', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 8000], ['spec', 7995], ['build', 7960], ['review', 7900], ['approve', 7880], ['merged', 7870]],
      rounds: [{ round: 1, at: 7900, reviews: { code: ['PASS', 7885] } }], decision: 'APPROVE', note: 'merged b77e0f3' }),

    // ── cartograph ──
    J({ project: 'carto', id: '031-tile-cache', title: 'Disk cache for map tiles', stage: 'approve', round: 2, maxRound: 2,
      history: [['claimed', 260], ['spec', 256], ['build', 230], ['review', 170], ['build', 140], ['review', 60], ['approve', 14]],
      rounds: [{ round: 1, at: 170, reviews: { code: ['CHANGES', 145], ui: ['PASS', 150] } },
               { round: 2, at: 60, reviews: { code: ['PASS', 15], ui: ['PASS', 40] } }], decision: null, note: '' }),
    J({ project: 'carto', id: '030-geojson-layers', title: 'GeoJSON overlay layers', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 330], ['spec', 326], ['build', 300], ['review', 230], ['approve', 140], ['merged', 128]],
      rounds: [{ round: 1, at: 230, reviews: { code: ['PASS', 160], ui: ['PASS', 190] } }], decision: 'APPROVE', note: 'merged 8f13ac7' }),

    // ── sundial ──
    J({ project: 'sundial', id: '005-cron-parse', title: 'Parse cron expressions', stage: 'spec', round: 0, maxRound: 2,
      history: [['claimed', 22], ['spec', 20]], rounds: [], decision: null, note: '' }),
    J({ project: 'sundial', id: '004-tz-support', title: 'Time zone support', stage: 'merged', round: 1, maxRound: 2,
      history: [['claimed', 2600], ['spec', 2596], ['build', 2570], ['review', 2520], ['approve', 2500], ['merged', 2490]],
      rounds: [{ round: 1, at: 2520, reviews: { code: ['PASS', 2505] } }], decision: 'APPROVE', note: 'merged 1d4e6b8' }),
  ];

  // Epics. members are in plan order; `job` is null until the member is claimed.
  // blocked: an epic-level stop (landing blocked), which is one more needs-human item.
  const epics = [
    { project: 'factory', slug: 'archive-record', title: 'Archive the job record', target: 'main', started: 700, blocked: null,
      members: [
        { slug: 'backlog-open-only', title: 'Backlog lists open jobs only', after: [], job: '024-backlog-open-only' },
        { slug: 'job-archive', title: 'Move settled jobs to an archive record', after: ['backlog-open-only'], job: '025-job-archive' },
        { slug: 'andon-reads-archive', title: 'Andon reads settled jobs from the archive', after: ['job-archive'], job: '026-andon-reads-archive' },
        { slug: 'job-prune', title: 'factory prune drops archived worktrees', after: ['job-archive'], job: '027-job-prune' },
        { slug: 'settled-on-demand', title: 'Fetch settled jobs on demand', after: ['andon-reads-archive'], job: null },
      ] },
    { project: 'minerva', slug: 'tags-v2', title: 'Tags v2', target: 'main', started: 550, blocked: null,
      members: [
        { slug: 'tag-colors', title: 'Tag colors', after: [], job: '042-tag-colors' },
        { slug: 'tag-rename', title: 'Rename a tag everywhere', after: [], job: '043-tag-rename' },
        { slug: 'tag-hierarchy', title: 'Nested tags', after: ['tag-colors'], job: '044-tag-hierarchy' },
        { slug: 'tag-filter-ui', title: 'Filter notes by tag subtree', after: ['tag-hierarchy'], job: null },
        { slug: 'tag-suggestions', title: 'Suggest tags while typing', after: ['tag-rename', 'tag-filter-ui'], job: null },
      ] },
    { project: 'aegis', slug: 'admin-console', title: 'Admin console', target: 'main', started: 845,
      blocked: { at: 29, reason: 'checkout is on feature-x',
        note: 'Landing blocked: the aegis-v5 checkout is on feature-x, not main. Every member is merged into the epic branch and its gate is green; the epic lands on main with one merge once the checkout is back on main.' },
      members: [
        { slug: 'admin-shell', title: 'Admin console shell and nav', after: [], job: '114-admin-shell' },
        { slug: 'admin-users', title: 'User management page', after: ['admin-shell'], job: '115-admin-users' },
        { slug: 'admin-settings', title: 'Workspace settings page', after: ['admin-shell'], job: '116-admin-settings' },
      ] },
  ];

  const SETTLE_MIN = 24 * 60;
  for (const j of jobs) {
    j.key = `${j.project}/${j.id}`;
    j.branch = `factory/${j.id}`;
    j.epic = j.epic ?? null; j.helper = j.helper ?? null;
    j.target = j.epic ? `factory/epic/${j.epic}` : 'main';
    j.history = j.history.map(([stage, m]) => ({ stage, at: ago(m) }));
    j.rounds = j.rounds.map((r) => ({ round: r.round, at: ago(r.at),
      reviews: Object.fromEntries(Object.entries(r.reviews).map(([k, [v, f]]) => [k, { verdict: v, finishedAt: f === null ? null : ago(f) }])) }));
    j.enteredAt = j.history[j.history.length - 1].at; // when it entered its current stage
    j.claimedAt = j.history[0].at;
    const cur = j.rounds[j.rounds.length - 1];
    const failed = cur !== undefined && Object.values(cur.reviews).some((r) => r.verdict === 'CHANGES');
    // merged into an epic branch: not on the target yet, so it never settles
    if (j.stage === 'merged') j.kind = !j.epic && NOW - j.enteredAt > SETTLE_MIN * 60000 ? 'settled' : 'merged';
    else if (j.stage === 'review') j.kind = failed ? 'review-failed' : 'reviewing';
    else j.kind = j.stage; // needs-human | approve | build | spec | claimed
  }

  // Derive each epic's live view from its member jobs.
  for (const e of epics) {
    e.key = `${e.project}/${e.slug}`;
    e.branch = `factory/epic/${e.slug}`;
    e.startedAt = ago(e.started);
    if (e.blocked) e.blocked.at = ago(e.blocked.at);
    const jobOf = (m) => (m.job ? jobs.find((j) => j.project === e.project && j.id === m.job) : null);
    const bySlug = Object.fromEntries(e.members.map((m) => [m.slug, m]));
    for (const m of e.members) m.jobKey = m.job ? `${e.project}/${m.job}` : null;
    // queued (deps unmet or parallel cap) or blocked on <job> (a direct dependency escalated)
    for (const m of e.members) {
      const j = jobOf(m);
      if (j) { m.state = j.kind === 'merged' ? 'merged' : j.kind === 'needs-human' ? 'needs-human' : 'running'; continue; }
      const esc = m.after.map((s) => jobOf(bySlug[s])).find((dj) => dj && dj.kind === 'needs-human');
      m.state = esc ? 'blocked' : 'queued';
      m.blockedOn = esc ? esc.key : null;
    }
    e.helpers = jobs.filter((j) => j.project === e.project && j.epic === e.slug && j.helper).map((j) => j.key);
    const memberJobs = e.members.map(jobOf).filter(Boolean);
    const all = [...memberJobs, ...e.helpers.map((k) => jobs.find((j) => j.key === k))];
    e.merged = e.members.filter((m) => m.state === 'merged').length;
    e.running = all.filter((j) => !['merged', 'needs-human'].includes(j.kind)).length;
    e.escalated = all.filter((j) => j.kind === 'needs-human').length;
    e.queued = e.members.filter((m) => m.state === 'queued').length;
    e.blockedMembers = e.members.filter((m) => m.state === 'blocked');
    // running | waiting (epic-level: landing blocked) | stalled (a member needs you and nothing else can run) | landing | landed
    e.state = e.blocked ? 'waiting' : e.merged === e.members.length ? 'landing' : e.escalated && !e.running ? 'stalled' : 'running';
  }

  window.FACTORY = {
    NOW, projects, jobs, epics,
    stages: ['claimed', 'spec', 'build', 'review', 'approve', 'merged'],
    // The five working stations as the current board names them.
    stations: [
      { key: 'spec', name: 'Spec', who: 'spec-writer' },
      { key: 'build', name: 'Build', who: 'builder' },
      { key: 'review', name: 'Review', who: 'reviewers' },
      { key: 'approve', name: 'Approve', who: 'approver' },
      { key: 'merged', name: 'Merged', who: 'the line' },
    ],
    kinds: {
      'needs-human': 'Escalated: needs a human',
      'review-failed': 'Review failed (CHANGES)',
      reviewing: 'In review',
      approve: 'Awaiting approver',
      build: 'Building',
      spec: 'Writing spec',
      claimed: 'Claimed',
      merged: 'Merged (last 24h)',
      settled: 'Settled (> 24h)',
    },
    ago: (t) => { const m = Math.round((NOW - t) / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`; },
  };
})();
