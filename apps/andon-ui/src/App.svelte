<script lang="ts">
  // Andon: every registered project's board, live from the service's `GET /events`, inside the
  // Mac-app frame (design §3): sidebar, toolbar, the Assembly Lines matrix (§5–§7), the inspector
  // (§8) with its Rework and Abandon sheets, the Settled sheet (§9), and the status bar. Selecting a project (in the sidebar, or by its gutter name) focuses it. Search,
  // Needs Me, the keyboard map, and deep links (§10) come from find.ts, keys.ts, and route.ts. This
  // wires the browser (EventSource, fetch, localStorage, the URL and its history, a 1 s clock) to
  // the plain modules that hold the logic; the components below only lay out what those modules return.
  // Boards are narrow (unsettled jobs and a settled summary); a project's settled jobs are fetched
  // only while a view needs them: the Settled sheet, a settled job or epic in the inspector, or a focused project.
  // Epics (docs/design/epics/design.md decision 9) ride on the boards: each gets a sub-lane under its
  // project's lane, its name opens the epic page, and an epic waiting on you counts as needs-human.
  // Factory releases (brief andon-version-ui) are quiet: a behind project's sidebar glyph opens the
  // What's New sheet scoped to it, the footer's version (or Help → What's New in the Mac app) opens it
  // whole, and the footer's restart note copies the restart command. Andon runs neither command.
  // The Mac app's View menu (063) asks the page to toggle Needs Me, open the Settled sheet, or toggle
  // the sidebar or inspector, and hides or shows the Merged column; the page reports its Needs Me,
  // sidebar, and inspector state back so the menu's labels follow it. A browser has none of this.
  // The backlog (brief andon-backlog-ui) is read-only and on demand: a lane's "N queued" link, the
  // toolbar's Backlog button, View → Show Backlog… (the `backlog` page event), and the hash open the
  // Backlog sheet; its projects' backlogs are fetched while it is open (or while a search needs
  // them) and re-fetched on their `backlog` events. A queued or exploring brief or epic opens its
  // brief's or plan's page in the inspector. Starting work (brief t3-start-work): the Backlog sheet's
  // rows and projects and the brief and plan pages offer Run, Start epic, Run next, Continue
  // exploring, and New exploration… (its own sheet); each copies its command first, then, in the Mac
  // app, asks it to start the work in T3 Code (startwork.ts), and the toast is the hand-off's.
  // The Mac app's File → New Exploration… (⌘N) and a project's right-click New Exploration… and Run
  // Next push `startwork`, a request the page checks (`startWorkPush`): Run next goes through the
  // same copyAndStart, and New exploration opens the sheet, with a project picker from the File menu
  // under All Projects (`exploreOpen`). The sheet remembers the project an exploration is started in.
  import { onMount, untrack } from 'svelte';
  import type { Fetcher } from './api';
  import { backlogProjects, backlogSheet } from './backlog';
  import type { BacklogCounts, DocRef } from './backlog';
  import BacklogSheet from './BacklogSheet.svelte';
  import { buildBoard, movement } from './board';
  import CommandSheet from './CommandSheet.svelte';
  import Inspector from './Inspector.svelte';
  import { FILES_KEY, INSPECTOR_KEY, SIDEBAR_KEY, loadFilesHeight, loadInspectorWidth, loadSidebarWidth, savePane } from './panes';
  import { TOAST_MS, copiedText, sidebarShown, toggleSidebar } from './inspector';
  import type { SheetKind, SidebarChoice } from './inspector';
  import { backlogHits, find, needsFilter } from './find';
  import { COPY_FAILED, handOffCaller, handoffToast } from './handoff';
  import type { HandoffRequest } from './handoff';
  import { initialKeys, reduceKey, topSheet } from './keys';
  import type { KeyAction } from './keys';
  import { activity, buildLanes, headerOf, orderLanes } from './lanes';
  import type { LaneOrder } from './lanes';
  import Lines from './Lines.svelte';
  import NewExplorationSheet from './NewExplorationSheet.svelte';
  import { copyThenStart, exploreOpen, loadLastExplored, nextStart, saveLastExplored, startWorkCaller, startWorkPush } from './startwork';
  import type { ExploreProject, StartItem } from './startwork';
  import { epicMenuCaller } from './epicmenu';
  import { jobMenuCaller } from './jobmenu';
  import { menuArmer, projectMenuCaller, swallowsClick } from './projectmenu';
  import { entryOf, epicKey, formatHash, historyStep, initialView, jobKey, readEntry, viewKey, viewOf } from './route';
  import type { EpicRef, JobRef, View } from './route';
  import { startLive } from './live';
  import type { Live, Status } from './live';
  import {
    ALL,
    boardEpics,
    boardJobs,
    epicJobs,
    fetchedSettled,
    fetchedSettledEpics,
    isEpicHeld,
    isHeld,
    hotEpics,
    lookupEpic,
    loadSelection,
    lookupJob,
    projectErrors,
    resolveSelection,
    reviewersFor,
    saveSelection,
    settledEpicsFor,
    settledFor,
    settledStatus,
    settledTotal,
    sheetProjects,
    withSettled,
  } from './projects';
  import type { BoardEpic, BoardJob } from './board';
  import { epicName } from './job';
  import { whatsNew } from './release';
  import type { Selection } from './projects';
  import SettledSheet from './SettledSheet.svelte';
  import ShortcutSheet from './ShortcutSheet.svelte';
  import WhatsNewSheet from './WhatsNewSheet.svelte';
  import Sidebar from './Sidebar.svelte';
  import {
    BACKLOG_EVENT,
    INSPECTOR_EVENT,
    MERGED_EVENT,
    START_WORK_EVENT,
    NEEDS_ME_EVENT,
    SETTLED_EVENT,
    SIDEBAR_EVENT,
    STATUS_BAR_EVENT,
    WHATS_NEW_EVENT,
    footer,
    frame,
    menuEventAction,
    mergedHidden,
    pushSubscriber,
    settleHours,
    settleText,
    shellMode,
    sidebarModel,
    statusBarHidden,
    subtitle,
    title,
    viewStateCaller,
  } from './sidebar';
  import StatusBar from './StatusBar.svelte';
  import Toolbar from './Toolbar.svelte';
  import { NO_SETTLED, emptyState } from './state';
  import { NO_BACKLOG } from './backlog';
  import type { SettledSummary, UiState } from './state';

  const storage = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  const fetcher: Fetcher = (path) => fetch(path, { cache: 'no-store' });

  let ui = $state.raw<UiState>(emptyState());
  let status = $state<Status>('connecting');
  let now = $state(Date.now());
  // The view on load: a present hash wins over the stored selection (route.ts `initialView`); a
  // hash's project is saved as a click would save it.
  const start = initialView(window.location.hash, loadSelection(storage()), ALL, window.history.state);
  if (window.location.hash.replace(/^#/, '') !== '') saveSelection(storage(), start.project ?? ALL);
  let selection = $state<Selection>(start.project ?? ALL);
  let openRef = $state<JobRef | null>(start.job);
  let openEpic = $state<EpicRef | null>(start.epic ?? null); // the epic page, instead of a job
  let openFile = $state<string | null>(start.file); // the inspector's chosen file; null: it picks
  let settledOpen = $state(start.settled !== null);
  let settledProject = $state<string | null>(start.settled?.project ?? null); // a lane's "N settled" link filters the sheet
  let backlogOpen = $state(start.backlog !== null && start.settled === null); // the Backlog sheet (never with the Settled sheet)
  let backlogProject = $state<string | null>(start.backlog?.project ?? null); // a lane's "N queued" link filters it
  let openDoc = $state<DocRef | null>(start.page ?? null); // a brief's or plan's page, instead of a job or an epic
  let sidebar = $state<SidebarChoice>({ user: true, override: false });
  let inspectorOpen = $state(start.inspector); // open with no job: "Nothing selected"
  // The three pane sizes, kept in localStorage (panes.ts): the inspector's width, the sidebar's
  // width (kept while it is hidden), and the job inspector's Files height (null: fits its files).
  let inspectorWidth = $state(loadInspectorWidth(storage()));
  let sidebarWidth = $state(loadSidebarWidth(storage()));
  let filesHeight = $state<number | null>(loadFilesHeight(storage()));
  let sidebarDragging = $state(false);
  function resizeInspector(w: number): void {
    inspectorWidth = w;
    savePane(storage(), INSPECTOR_KEY, w);
  }
  function resizeSidebar(w: number): void {
    sidebarWidth = w;
    savePane(storage(), SIDEBAR_KEY, w);
  }
  function resizeFiles(h: number | null): void {
    filesHeight = h;
    savePane(storage(), FILES_KEY, h);
  }
  let sheet = $state<SheetKind | null>(start.sheet === 'rework' || start.sheet === 'abandon' || start.sheet === 'epic-abandon' ? start.sheet : null); // the open Rework… or Abandon… sheet (a job's or an epic's)
  let keysOpen = $state(start.sheet === 'keys'); // the shortcut sheet
  let exploreProject = $state<{ id: string; name: string } | null>(null); // the New exploration sheet's project (null: closed)
  let explorePicker = $state<ExploreProject[] | null>(null); // its project picker (the File menu under All Projects), or null
  let whatsNewOpen = $state(start.whatsNew !== null); // the What's New sheet
  let whatsNewProject = $state<string | null>(start.whatsNew?.project ?? null); // its scope: a project id, or null for every release
  let needs = $state(start.needs); // Needs Me
  let query = $state(''); // search; not kept in the hash
  let searchEl = $state<HTMLInputElement>();
  let searchFocused = $state(false);
  const openKey = $derived(openRef === null ? null : jobKey(openRef));
  const openEpicKey = $derived(openEpic === null ? null : epicKey(openEpic));
  let innerWidth = $state(window.innerWidth);
  const mode = shellMode(window.location.search);
  // The Mac app's View menu hides the status bar and tells the page; a browser always shows it.
  let statusBarOff = $state(false);
  // The Mac app's "Show Merged column" setting (Settings or the View menu); a browser always shows it.
  let mergedOff = $state(false);

  let live: Live | null = null;
  onMount(() => {
    const started = startLive({ connect: (path) => new EventSource(path), fetcher, onState: (s) => (ui = s), onStatus: (s) => (status = s) });
    live = started;
    started.watch(untrack(() => watched));
    started.watchBacklog(untrack(() => backlogPids));
    // Timers tick once a second; a hidden tab (where timers are throttled) catches up on return.
    const timer = setInterval(() => (now = Date.now()), 1000);
    const visible = (): void => {
      if (!document.hidden) now = Date.now();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('popstate', onpopstate);
    const subscribe = pushSubscriber(mode, Reflect.get(window, 'tiny'));
    const offStatusBar = subscribe?.(STATUS_BAR_EVENT, (data) => {
      const hidden = statusBarHidden(data);
      if (hidden !== null) statusBarOff = hidden;
    });
    // Help → What's New: the Mac app shows this window and asks for the whole sheet; the focus stays.
    const offWhatsNew = subscribe?.(WHATS_NEW_EVENT, () => openWhatsNew(null));
    const offMerged = subscribe?.(MERGED_EVENT, (data) => {
      const hidden = mergedHidden(data);
      if (hidden !== null) mergedOff = hidden;
    });
    // The View menu's page actions: the payload is ignored, the page acts on its own state.
    const offNeedsMe = subscribe?.(NEEDS_ME_EVENT, () => onmenu(NEEDS_ME_EVENT));
    const offSettled = subscribe?.(SETTLED_EVENT, () => onmenu(SETTLED_EVENT));
    const offBacklog = subscribe?.(BACKLOG_EVENT, () => onmenu(BACKLOG_EVENT));
    const offSidebar = subscribe?.(SIDEBAR_EVENT, () => onmenu(SIDEBAR_EVENT));
    const offInspector = subscribe?.(INSPECTOR_EVENT, () => onmenu(INSPECTOR_EVENT));
    // File → New Exploration… and a project's right-click New Exploration… and Run Next: a request,
    // checked against the listed projects; anything else does nothing.
    const offStartWork = subscribe?.(START_WORK_EVENT, (data) => onstartwork(data));
    // The Mac app's right-click menu on a project row or gutter, a board job token, or an epic's name
    // in its sub-lane: armed for the project, job, or epic under the pointer, and a control-click
    // there doesn't click through (projectmenu.ts, jobmenu.ts, epicmenu.ts). A browser: nothing.
    const ask = projectMenuCaller(mode, Reflect.get(window, 'tiny'));
    const arm = ask === null ? null : menuArmer(mode, ask, jobMenuCaller(mode, Reflect.get(window, 'tiny')), epicMenuCaller(mode, Reflect.get(window, 'tiny')));
    const onpointerover = (e: PointerEvent): void => arm?.point(e.target);
    const onpointerout = (e: PointerEvent): void => {
      if (e.relatedTarget === null) arm?.leave();
    };
    const onmousedown = (e: MouseEvent): void => arm?.press(e.target, e);
    const onclickcapture = (e: MouseEvent): void => {
      if (arm === null || !swallowsClick(mode, e.target, e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    if (arm !== null) {
      window.addEventListener('pointerover', onpointerover);
      window.addEventListener('pointerout', onpointerout);
      window.addEventListener('mousedown', onmousedown, true);
      window.addEventListener('click', onclickcapture, true);
    }
    return () => {
      if (arm !== null) {
        window.removeEventListener('pointerover', onpointerover);
        window.removeEventListener('pointerout', onpointerout);
        window.removeEventListener('mousedown', onmousedown, true);
        window.removeEventListener('click', onclickcapture, true);
      }
      offStatusBar?.();
      offWhatsNew?.();
      offMerged?.();
      offNeedsMe?.();
      offSettled?.();
      offBacklog?.();
      offSidebar?.();
      offInspector?.();
      offStartWork?.();
      started.stop();
      live = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('popstate', onpopstate);
    };
  });

  const sel = $derived(ui.projects.length > 0 ? resolveSelection(ui, selection) : selection);
  const allJobs = $derived(boardJobs(ui, sel));
  const allEpics = $derived(boardEpics(ui, sel));
  // Needs Me keeps only the jobs that need a human, the epics waiting on you or with such a job, and
  // the lanes that have any (find.ts).
  const needed = $derived(needs ? needsFilter(ui.projects, allJobs, allEpics) : null);
  const jobs = $derived(needed?.jobs ?? allJobs);
  const epics = $derived(needed?.epics ?? allEpics);
  const board = $derived(buildBoard(allJobs, now, reviewersFor(ui, sel)));
  const errors = $derived(projectErrors(ui, sel));
  const loaded = $derived(ui.projects.length > 0 && ui.projects.every((p) => ui.boards[p.id]?.loaded === true));

  // The lanes: every registered project in All Projects, or the focused one (uncapped, with its
  // settled merges and recent activity). Lane order is sorted once every board has loaded, then a
  // lane moves only when its tier changes (lanes.ts `orderLanes`).
  const focused = $derived(sel !== ALL);
  const shownProjects = $derived((needed?.projects ?? ui.projects).filter((p) => !focused || p.id === sel));
  let laneOrder: LaneOrder | null = null;
  const summaries = $derived(Object.fromEntries(ui.projects.map((p): [string, SettledSummary] => [p.id, ui.boards[p.id]?.settled ?? NO_SETTLED])));
  const backlogCounts = $derived(Object.fromEntries(ui.projects.map((p): [string, BacklogCounts] => [p.id, ui.boards[p.id]?.backlog ?? NO_BACKLOG])));
  const lines = $derived(orderLanes(buildLanes(shownProjects, jobs, now, focused, summaries, epics, needs, mergedOff, backlogCounts), loaded && !focused && !needs ? laneOrder : null));
  $effect(() => {
    if (loaded && !focused && !needs) laneOrder = lines.order;
  });
  // Search dims the tokens and lanes that don't match; it hides nothing. It also lists the matching
  // backlog items of the projects in view (never dimming or lighting the board).
  const found = $derived(find(shownProjects, jobs, query, now, epics));
  const inView = $derived(ui.projects.filter((p) => !focused || p.id === sel));
  const hits = $derived(backlogHits(inView, ui.backlogs, query));
  const backlogTotal = $derived(inView.reduce((n, p) => n + (ui.boards[p.id]?.backlog.queued ?? 0) + (ui.boards[p.id]?.backlog.exploring ?? 0), 0));
  // Backlogs on demand: the open sheet's projects, or, while a search is typed, the projects in view.
  const backlogPids = $derived(backlogOpen ? backlogProjects(ui.projects, backlogProject) : query.trim() !== '' ? inView.map((p) => p.id) : []);
  $effect(() => {
    live?.watchBacklog(backlogPids);
  });
  const backlogModel = $derived(backlogSheet(ui.projects, ui.backlogs, backlogProject));
  const header = $derived(headerOf(lines.lanes, settleHours(ui, sel), mergedOff));
  // Recent activity draws on the focused project's settled jobs too, once its list has loaded.
  const recent = $derived(focused ? activity(needs ? jobs : withSettled(ui, sel)) : []);

  // Tokens new to the board fade in, and tokens that changed stage slide to their new cell and highlight.
  let seen = new Map<string, string>();
  const marks = $derived(movement(seen, jobs));
  $effect(() => {
    seen = marks.stages;
  });

  // An open inspector hides the sidebar below 1640px; closing it restores the user's own choice.
  const sidebarOpen = $derived(sidebarShown(sidebar, innerWidth, inspectorOpen));
  // The Mac app's View menu labels follow the page: report Needs Me, the effective sidebar, and the
  // inspector whenever one changes, for any reason (the menu, `n`, closing the inspector, a narrow
  // window hiding the sidebar). A browser has no caller.
  const reportView = viewStateCaller(mode, Reflect.get(window, 'tiny'));
  $effect(() => {
    reportView?.({ needsMe: needs, sidebarShown: sidebarOpen, inspectorOpen });
  });
  const win = $derived(frame(mode, sidebarOpen));
  const side = $derived(sidebarModel(ui, sel));
  const foot = $derived(footer(status, ui.projects.length, ui.release.info));
  // The What's New sheet's model: every release, or the ones its project is missing (live: a
  // `projects` or `release` event updates it while it is open).
  const whatsNewModel = $derived(
    whatsNew(ui.release.info, whatsNewProject === null ? null : { id: whatsNewProject, project: ui.projects.find((p) => p.id === whatsNewProject) ?? null }),
  );
  // "M waiting on you" counts each epic waiting on you too.
  const sub = $derived(subtitle(ui, sel, board.running, board.waiting + hotEpics(ui, sel)));
  const settle = $derived(settleText(settleHours(ui, sel)));

  // The inspector finds its job on every board and in every cached settled list, so it stays open
  // across a switch and after settling. While the job's settled list is (re)fetching, it keeps
  // showing the job as last found.
  const lookup = $derived(openRef === null ? null : lookupJob(ui, openRef));
  let lastItem = $state.raw<BoardJob | null>(null);
  const openItem = $derived(lookup?.state === 'found' ? lookup.item : lookup?.state === 'waiting' && lastItem !== null && lastItem.key === openKey ? lastItem : null);
  // A job that was shown and is gone leaves "Nothing selected"; one a link named that never
  // existed closes the inspector. Either holds only once the job's board and its settled list have
  // both loaded and neither has it.
  let shownKey: string | null = null;
  $effect(() => {
    if (lookup?.state === 'found') {
      shownKey = lookup.item.key;
      lastItem = lookup.item;
    } else if (lookup?.state === 'missing' && openRef !== null) {
      if (shownKey === jobKey(openRef)) {
        openRef = null;
        openFile = null;
      } else closeInspector();
    }
  });

  // The epic page finds its epic on its board or in its cached settled list, as the job page does.
  const epicLookup = $derived(openEpic === null ? null : lookupEpic(ui, openEpic));
  let lastEpic = $state.raw<BoardEpic | null>(null);
  const openEpicItem = $derived(
    epicLookup?.state === 'found' ? epicLookup.item : epicLookup?.state === 'waiting' && lastEpic !== null && lastEpic.key === openEpicKey ? lastEpic : null,
  );
  const openEpicJobs = $derived(openEpic === null ? [] : epicJobs(ui, openEpic));
  let shownEpicKey: string | null = null;
  $effect(() => {
    if (epicLookup?.state === 'found') {
      shownEpicKey = epicLookup.item.key;
      lastEpic = epicLookup.item;
    } else if (epicLookup?.state === 'missing' && openEpic !== null) {
      if (shownEpicKey === epicKey(openEpic)) {
        openEpic = null;
        openFile = null;
      } else closeInspector();
    }
  });

  // Settled lists on demand: the open sheet's projects, an open job or epic that isn't on its board,
  // and a focused project. Only these are fetched, and refetched when their summaries change (live.ts).
  // An open epic's settled list also brings its members' settled jobs.
  const sheetPids = $derived(settledOpen ? sheetProjects(ui, settledProject) : []);
  const watched = $derived([
    ...new Set([
      ...sheetPids,
      ...(openRef !== null && !isHeld(ui, openRef) ? [openRef.project] : []),
      ...(openEpic !== null ? [openEpic.project] : []),
      ...(focused ? [sel] : []),
    ]),
  ]);
  $effect(() => {
    live?.watch(watched);
  });
  const settledJobs = $derived(settledOpen ? settledFor(ui, ALL, now) : []);
  const settledEpics = $derived(settledOpen ? settledEpicsFor(ui, ALL, now) : []);
  const settledState = $derived(settledStatus(ui, sheetPids));
  $effect(() => {
    if (sheet === 'epic-abandon') {
      if (loaded && (openEpicItem === null || openEpicItem.epic.state === 'landed' || openEpicItem.epic.state === 'abandoned')) sheet = null; // the epic closed
    } else if (sheet !== null && loaded && openItem?.job.stage !== 'needs-human') sheet = null; // the job moved on
  });
  // An empty Settled sheet closes itself, but only once its lists are loaded and current: never
  // while they load, and never over a failed fetch's reason.
  $effect(() => {
    const shown = (b: { project: { id: string } }): boolean => settledProject === null || b.project.id === settledProject;
    if (settledOpen && loaded && settledState.current && settledState.failures.length === 0 && !settledJobs.some(shown) && !settledEpics.some(shown)) settledOpen = false;
  });

  const projectName = (pid: string): string => ui.projects.find((p) => p.id === pid)?.name ?? pid;
  function select(next: Selection): void {
    selection = next;
    saveSelection(storage(), next);
  }
  function openSettled(pid: string | null): void {
    settledProject = pid;
    backlogOpen = false;
    settledOpen = true;
  }
  function openBacklog(pid: string | null): void {
    backlogProject = pid;
    settledOpen = false;
    backlogOpen = true;
  }
  /** A brief's or plan's page in the inspector: from the Backlog sheet (which closes), a search result, or a plan's member. */
  function openPage(ref: DocRef): void {
    backlogOpen = false;
    settledOpen = false;
    openRef = null;
    openEpic = null;
    openFile = null;
    sheet = null;
    openDoc = ref;
    inspectorOpen = true;
  }
  function openWhatsNew(pid: string | null): void {
    whatsNewProject = pid;
    whatsNewOpen = true;
  }
  function openJob(key: string): void {
    const b = boardJobs(ui, ALL).find((x) => x.key === key) ?? fetchedSettled(ui, ALL).find((x) => x.key === key);
    if (b === undefined) return;
    settledOpen = false;
    if (openKey !== key) openFile = null;
    openEpic = null;
    openDoc = null;
    if (sheet === 'epic-abandon') sheet = null;
    openRef = { project: b.project.id, id: b.job.id };
    inspectorOpen = true;
  }
  function openEpicPage(key: string): void {
    const e = boardEpics(ui, ALL).find((x) => x.key === key) ?? fetchedSettledEpics(ui, ALL).find((x) => x.key === key);
    if (e === undefined) return;
    settledOpen = false;
    if (openEpicKey !== key) openFile = null;
    openRef = null;
    openDoc = null;
    sheet = null;
    openEpic = { project: e.project.id, slug: e.epic.slug };
    inspectorOpen = true;
  }
  function closeInspector(): void {
    inspectorOpen = false;
    openRef = null;
    openEpic = null;
    openDoc = null;
    openFile = null;
    sheet = null;
    sidebar = { user: sidebar.user, override: false };
  }
  function toggleInspector(): void {
    if (inspectorOpen) closeInspector();
    else inspectorOpen = true;
  }
  function toggleSide(): void {
    sidebar = toggleSidebar(sidebar, innerWidth, inspectorOpen);
  }
  /** A View menu page event from the Mac app (sidebar.ts `menuEventAction`). */
  function onmenu(event: string): void {
    switch (menuEventAction(event)) {
      case 'toggle-needs':
        needs = !needs;
        return;
      case 'open-settled':
        openSettled(null);
        return;
      case 'open-backlog':
        openBacklog(null);
        return;
      case 'toggle-sidebar':
        toggleSide();
        return;
      case 'toggle-inspector':
        toggleInspector();
        return;
      case null:
        return;
    }
  }

  // Copying shows a HUD toast for 1.6s. A failed write says so; the command stays on screen to select.
  let toast = $state<{ text: string; ok: boolean } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function show(text: string, ok: boolean): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toast = { text, ok };
    toastTimer = setTimeout(() => (toast = null), TOAST_MS);
  }
  /** Puts the command on the clipboard; whether it worked. */
  const write = (command: string): Promise<boolean> =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(
        () => true,
        () => false,
      );
  // The small copy icon beside the command: copy only, always.
  function copy(command: string): void {
    void write(command).then((ok) => show(ok ? copiedText(command) : COPY_FAILED, ok));
  }
  // The needs-human box's Approve and the sheets' button: copy first, so the clipboard always holds
  // the command, then (in the Mac app) ask it to hand the command to T3 Code as its Settings say; the
  // toast says what happened (handoff.ts). A browser has no caller: copy only, as before.
  const handOff = handOffCaller(mode, Reflect.get(window, 'tiny'));
  async function copyAndHandOff(req: HandoffRequest, command: string): Promise<void> {
    const copied = await write(command);
    const outcome = handOff === null ? null : await handOff(req);
    const t = handoffToast(copied, outcome, command);
    show(t.text, t.ok);
  }
  // Starting work (t3-start-work): copy first, then (in the Mac app) ask it to start the work in T3
  // Code as its Settings say; the toast is the hand-off's. A browser has no caller: copy only. An
  // action from the Backlog sheet closes it, so the toast shows.
  const startWork = startWorkCaller(mode, Reflect.get(window, 'tiny'));
  async function copyAndStart(item: StartItem): Promise<void> {
    backlogOpen = false;
    const t = await copyThenStart(write, startWork, item.req, item.command);
    show(t.text, t.ok);
  }
  function openNewExploration(project: { id: string; name: string }, picker: ExploreProject[] | null = null): void {
    backlogOpen = false;
    explorePicker = picker;
    exploreProject = project;
  }
  // Starting a New exploration from the sheet (any path) remembers its project for the picker.
  function startExploration(item: StartItem): void {
    saveLastExplored(storage(), item.req.project);
    void copyAndStart(item);
  }
  function closeExploration(): void {
    exploreProject = null;
    explorePicker = null;
  }
  // The Mac app's startwork event: Run next as the Backlog sheet's, or the New exploration sheet.
  function onstartwork(data: unknown): void {
    const push = startWorkPush(data, ui.projects);
    if (push === null) return;
    if (push.action === 'next') {
      void copyAndStart(nextStart(push.project));
      return;
    }
    const open = exploreOpen(push.project, sel === ALL ? null : sel, ui.projects, loadLastExplored(storage()));
    if (open !== null) openNewExploration(open.project, open.picker);
  }
  $effect(() => () => {
    if (toastTimer !== null) clearTimeout(toastTimer);
  });

  // ---- the URL: the view in the hash, and its history (route.ts) ----

  const view = $derived<View>({
    project: sel === ALL ? null : sel,
    inspector: inspectorOpen,
    job: openEpic === null && openDoc === null ? openRef : null,
    epic: openDoc === null ? (openEpic ?? undefined) : undefined,
    page: openDoc ?? undefined,
    file: (openRef === null && openEpic === null) || openDoc !== null ? null : openFile,
    settled: settledOpen ? { project: settledProject } : null,
    backlog: backlogOpen ? { project: backlogProject } : null,
    whatsNew: whatsNewOpen ? { project: whatsNewProject } : null,
    sheet: keysOpen ? 'keys' : sheet,
    needs,
  });

  function applyView(v: View): void {
    if ((v.project ?? ALL) !== selection) select(v.project ?? ALL);
    openRef = v.job;
    openEpic = v.epic ?? null;
    openDoc = v.page ?? null;
    openFile = v.file;
    inspectorOpen = v.inspector;
    if (!v.inspector) sidebar = { user: sidebar.user, override: false };
    settledOpen = v.settled !== null;
    settledProject = v.settled?.project ?? null;
    backlogOpen = v.backlog !== null && v.settled === null;
    backlogProject = v.backlog?.project ?? null;
    whatsNewOpen = v.whatsNew !== null;
    whatsNewProject = v.whatsNew?.project ?? null;
    sheet = v.sheet === 'rework' || v.sheet === 'abandon' || v.sheet === 'epic-abandon' ? v.sheet : null;
    keysOpen = v.sheet === 'keys';
    needs = v.needs;
  }

  // Each change of the view pushes, replaces, or goes back (route.ts `historyStep`). `shown` is the
  // view the current history entry holds; Back and Forward set it before applying theirs, so they
  // never write the history themselves.
  let shown: View | null = null;
  const url = (v: View): string => `${window.location.pathname}${window.location.search}${formatHash(v)}`;
  $effect(() => {
    const next = view;
    untrack(() => {
      const under = readEntry(window.history.state).under;
      if (shown === null) {
        window.history.replaceState(entryOf(next, under), '', url(next));
      } else {
        const step = historyStep(shown, next, under);
        if (step === 'push') window.history.pushState(entryOf(next, viewKey(shown)), '', url(next));
        else if (step === 'replace') window.history.replaceState(entryOf(next, under), '', url(next));
        else if (step === 'back') window.history.back();
      }
      shown = next;
    });
  });
  function onpopstate(e: PopStateEvent): void {
    const v = viewOf(window.location.hash, e.state);
    shown = v;
    applyView(v);
  }

  // ---- the keyboard (keys.ts) ----

  let keyState = initialKeys();
  const inField = (el: Element | null): boolean => el instanceof HTMLElement && (el.isContentEditable || el.matches('input, textarea, select'));
  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const layers = { sheet: settledOpen || backlogOpen || whatsNewOpen || sheet !== null || keysOpen || exploreProject !== null, inspector: inspectorOpen, searchText: query !== '', searchFocused };
    const r = reduceKey(keyState, { key: e.key, mod: e.ctrlKey || e.metaKey || e.altKey, inField: inField(document.activeElement) }, layers);
    keyState = r.state;
    // Escape's default is always suppressed: Chromium's ("stop loading") also aborts the event stream.
    if (e.key === 'Escape') e.preventDefault();
    if (r.action === null) return;
    e.preventDefault();
    act(r.action);
  }
  function act(a: KeyAction): void {
    switch (a) {
      case 'focus-search':
        searchEl?.focus();
        searchEl?.select();
        return;
      case 'toggle-needs':
        needs = !needs;
        return;
      case 'open-keys':
        keysOpen = true;
        return;
      case 'all-projects':
        select(ALL);
        return;
      case 'close-sheet':
        // the topmost first (keys.ts `topSheet`): What's New, then a command sheet or the shortcuts
        // (which open over the Settled sheet's place), then the Settled sheet, then the Backlog sheet;
        // the New exploration sheet opens alone (the Backlog sheet closes for it), so it goes first
        if (exploreProject !== null) {
          closeExploration();
          return;
        }
        switch (topSheet({ whatsNew: whatsNewOpen, keys: keysOpen, command: sheet !== null, settled: settledOpen, backlog: backlogOpen })) {
          case 'whatsNew':
            whatsNewOpen = false;
            return;
          case 'keys':
            keysOpen = false;
            return;
          case 'command':
            sheet = null;
            return;
          case 'settled':
            settledOpen = false;
            return;
          case 'backlog':
            backlogOpen = false;
            return;
          case null:
            return;
        }
        return;
      case 'close-inspector':
        closeInspector();
        return;
      case 'clear-search':
        query = '';
        return;
      case 'leave-search':
        searchEl?.blur();
        return;
    }
  }
</script>

<svelte:window {onkeydown} bind:innerWidth />

<div class="window" class:mac={mode === 'mac'} class:nosb={!sidebarOpen} class:sbdrag={sidebarDragging} style:--sbset="{sidebarWidth}px" style:--inset="{win.inset}px" style:--toolbar-inset="{win.toolbarInset}px">
  <Sidebar model={side} {foot} {status} drag={win.drag} onselect={select} onwhatsnew={openWhatsNew} oncopy={copy} width={sidebarWidth} onresize={resizeSidebar} ondragging={(d) => (sidebarDragging = d)} />
  <div class="main">
    <Toolbar
      title={title(ui, sel)}
      {sub}
      {focused}
      settled={settledTotal(ui, sel, now)}
      backlog={backlogTotal}
      {hits}
      {sidebarOpen}
      {inspectorOpen}
      selected={openDoc !== null ? `${projectName(openDoc.project)} / ${openDoc.kind} ${openDoc.slug}` : openItem !== null ? `${openItem.project.name} / ${openItem.job.id}` : openEpicItem !== null ? `${openEpicItem.project.name} / epic ${epicName(openEpicItem.epic)}` : null}
      drag={win.drag}
      bind:query
      bind:searchEl
      bind:searchFocused
      {needs}
      ontoggleneeds={() => (needs = !needs)}
      ontogglesidebar={toggleSide}
      onback={() => select(ALL)}
      ontoggleinspector={toggleInspector}
      onsettled={() => openSettled(null)}
      onbacklog={() => openBacklog(null)}
      onopenpage={openPage}
    />
    <main>
      {#if errors.length > 0}
        <div class="perrs">
          {#each errors as e (e.id)}<div class="perr"><b>{e.name}</b> · {e.reason} <span class="na">(showing its last board)</span></div>{/each}
        </div>
      {/if}
      {#if ui.projects.length === 0}
        {#if status === 'down'}
          <div class="nothing">The Andon service isn't answering.<br /><br />Install it once per machine with <code>factory service install</code>, or start it with <code>factory service start</code>.</div>
        {:else if status === 'live'}
          <div class="nothing">No projects are registered.<br /><br />Run <code>factory init</code> in a repo to add it.</div>
        {:else}
          <div class="nothing">Connecting to the Andon service…</div>
        {/if}
      {:else}
        <Lines
          lanes={lines.lanes}
          {header}
          {jobs}
          {focused}
          {recent}
          {now}
          {found}
          selectedKey={openKey}
          selectedEpic={openEpicKey}
          fresh={marks.fresh}
          moved={marks.moved}
          onopen={openJob}
          onopenepic={openEpicPage}
          onfocus={select}
          onsettled={openSettled}
          onbacklog={openBacklog}
        />
        {#if needs && lines.lanes.length === 0}
          <div class="quiet">Nothing needs you{focused ? ' in this project' : ''}. Press <kbd>n</kbd> to show everything.</div>
        {:else if board.shown === 0 && !focused}
          <div class="quiet">The line is quiet. Start a job with <code>/factory &lt;feature&gt;</code> or <code>/factory next</code>.</div>
        {/if}
      {/if}
    </main>
    {#if !statusBarOff}<StatusBar {settle} {now} />{/if}
  </div>
  <Inspector
    item={openEpic === null && openDoc === null ? openItem : null}
    epic={openDoc === null ? openEpicItem : null}
    epicJobs={openEpicJobs}
    page={openDoc}
    pageProject={openDoc === null ? '' : projectName(openDoc.project)}
    onopenpage={openPage}
    onstart={copyAndStart}
    open={inspectorOpen}
    width={inspectorWidth}
    {filesHeight}
    {now}
    {fetcher}
    file={openFile}
    onfile={(f) => (openFile = f)}
    onclose={closeInspector}
    onresize={resizeInspector}
    onfilesresize={resizeFiles}
    oncopy={copy}
    onhandoff={copyAndHandOff}
    onsheet={(k) => (sheet = k)}
    onopenjob={openJob}
    onopenepic={openEpicPage}
  />
</div>
<SettledSheet
  settled={settledJobs}
  epics={settledEpics}
  status={settledState}
  open={settledOpen}
  project={settledProject === null ? null : (ui.projects.find((p) => p.id === settledProject) ?? null)}
  onclearfilter={() => (settledProject = null)}
  onclose={() => (settledOpen = false)}
  onopen={openJob}
  onopenepic={openEpicPage}
/>
<BacklogSheet
  model={backlogModel}
  open={backlogOpen}
  project={backlogProject === null ? null : (ui.projects.find((p) => p.id === backlogProject) ?? null)}
  onclearfilter={() => (backlogProject = null)}
  onclose={() => (backlogOpen = false)}
  onopenpage={openPage}
  onstart={copyAndStart}
  onnewexploration={openNewExploration}
/>
<NewExplorationSheet project={exploreProject} picker={explorePicker} handsOff={startWork !== null} onstart={startExploration} onclose={closeExploration} />
<CommandSheet
  kind={sheet}
  id={sheet === 'epic-abandon' ? (openEpicItem?.epic.slug ?? '') : (openItem?.job.id ?? '')}
  project={sheet === 'epic-abandon' ? (openEpicItem?.project.id ?? '') : (openItem?.project.id ?? '')}
  handsOff={handOff !== null}
  onhandoff={copyAndHandOff}
  oncopy={copy}
  onclose={() => (sheet = null)}
/>
<ShortcutSheet open={keysOpen} mac={mode === 'mac'} onclose={() => (keysOpen = false)} />
<WhatsNewSheet model={whatsNewModel} open={whatsNewOpen} onshowall={() => (whatsNewProject = null)} oncopy={copy} onclose={() => (whatsNewOpen = false)} />
<div class="hud" class:on={toast !== null} class:fail={toast !== null && !toast.ok} role="status" aria-live="polite">
  {#if toast !== null}
    {#if toast.ok}<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{/if}
    <span>{toast.text}</span>
  {/if}
</div>
