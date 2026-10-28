<script lang="ts">
  // Andon: every registered project's board, live from the service's `GET /events`, inside the
  // Mac-app frame (design §3): sidebar, toolbar, the Assembly Lines matrix (§5–§7), the inspector
  // (§8) with its Rework and Abandon sheets, the Settled sheet (§9), and the status bar. Selecting a project (in the sidebar, or by its gutter name) focuses it. Search,
  // Needs Me, the keyboard map, and deep links (§10) come from find.ts, keys.ts, and route.ts. This
  // wires the browser (EventSource, fetch, localStorage, the URL and its history, a 1 s clock) to
  // the plain modules that hold the logic; the components below only lay out what those modules return.
  import { onMount, untrack } from 'svelte';
  import type { Fetcher } from './api';
  import { buildBoard, movement } from './board';
  import CommandSheet from './CommandSheet.svelte';
  import Inspector from './Inspector.svelte';
  import { INSPECTOR_DEFAULT, TOAST_MS, copiedText, sidebarShown, toggleSidebar } from './inspector';
  import type { SheetKind, SidebarChoice } from './inspector';
  import { find, needsFilter } from './find';
  import { initialKeys, reduceKey } from './keys';
  import type { KeyAction } from './keys';
  import { activity, buildLanes, headerOf, orderLanes } from './lanes';
  import type { LaneOrder } from './lanes';
  import Lines from './Lines.svelte';
  import { entryOf, formatHash, historyStep, initialView, jobKey, readEntry, viewKey, viewOf } from './route';
  import type { JobRef, View } from './route';
  import { startLive } from './live';
  import type { Status } from './live';
  import { ALL, boardJobs, loadSelection, projectErrors, resolveSelection, reviewersFor, saveSelection } from './projects';
  import type { Selection } from './projects';
  import SettledSheet from './SettledSheet.svelte';
  import ShortcutSheet from './ShortcutSheet.svelte';
  import Sidebar from './Sidebar.svelte';
  import { footer, frame, settleHours, settleText, shellMode, sidebarModel, subtitle, title } from './sidebar';
  import StatusBar from './StatusBar.svelte';
  import Toolbar from './Toolbar.svelte';
  import { emptyState } from './state';
  import type { UiState } from './state';

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
  let openFile = $state<string | null>(start.file); // the inspector's chosen file; null: it picks
  let settledOpen = $state(start.settled !== null);
  let settledProject = $state<string | null>(start.settled?.project ?? null); // a lane's "N settled" link filters the sheet
  let sidebar = $state<SidebarChoice>({ user: true, override: false });
  let inspectorOpen = $state(start.inspector); // open with no job: "Nothing selected"
  let inspectorWidth = $state(INSPECTOR_DEFAULT); // not kept across reloads
  let sheet = $state<SheetKind | null>(start.sheet === 'rework' || start.sheet === 'abandon' ? start.sheet : null); // the open Rework… or Abandon… sheet
  let keysOpen = $state(start.sheet === 'keys'); // the shortcut sheet
  let needs = $state(start.needs); // Needs Me
  let query = $state(''); // search; not kept in the hash
  let searchEl = $state<HTMLInputElement>();
  let searchFocused = $state(false);
  const openKey = $derived(openRef === null ? null : jobKey(openRef));
  let innerWidth = $state(window.innerWidth);
  const mode = shellMode(window.location.search);

  onMount(() => {
    const live = startLive({ connect: () => new EventSource('/events'), fetcher, onState: (s) => (ui = s), onStatus: (s) => (status = s) });
    // Timers tick once a second; a hidden tab (where timers are throttled) catches up on return.
    const timer = setInterval(() => (now = Date.now()), 1000);
    const visible = (): void => {
      if (!document.hidden) now = Date.now();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('popstate', onpopstate);
    return () => {
      live.stop();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('popstate', onpopstate);
    };
  });

  const sel = $derived(ui.projects.length > 0 ? resolveSelection(ui, selection) : selection);
  const allJobs = $derived(boardJobs(ui, sel));
  // Needs Me keeps only the jobs that need a human, and the lanes that have any (find.ts).
  const needed = $derived(needs ? needsFilter(ui.projects, allJobs) : null);
  const jobs = $derived(needed?.jobs ?? allJobs);
  const board = $derived(buildBoard(allJobs, now, reviewersFor(ui, sel)));
  const errors = $derived(projectErrors(ui, sel));
  const loaded = $derived(ui.projects.length > 0 && ui.projects.every((p) => ui.boards[p.id]?.loaded === true));

  // The lanes: every registered project in All Projects, or the focused one (uncapped, with its
  // settled merges and recent activity). Lane order is sorted once every board has loaded, then a
  // lane moves only when its tier changes (lanes.ts `orderLanes`).
  const focused = $derived(sel !== ALL);
  const shownProjects = $derived((needed?.projects ?? ui.projects).filter((p) => !focused || p.id === sel));
  let laneOrder: LaneOrder | null = null;
  const lines = $derived(orderLanes(buildLanes(shownProjects, jobs, now, focused), loaded && !focused && !needs ? laneOrder : null));
  $effect(() => {
    if (loaded && !focused && !needs) laneOrder = lines.order;
  });
  // Search dims the tokens and lanes that don't match; it hides nothing.
  const found = $derived(find(shownProjects, jobs, query, now, focused));
  const header = $derived(headerOf(lines.lanes, settleHours(ui, sel)));
  const recent = $derived(focused ? activity(jobs) : []);

  // Tokens new to the board fade in, and tokens that changed stage slide to their new cell and highlight.
  let seen = new Map<string, string>();
  const marks = $derived(movement(seen, jobs));
  $effect(() => {
    seen = marks.stages;
  });

  // An open inspector hides the sidebar below 1640px; closing it restores the user's own choice.
  const sidebarOpen = $derived(sidebarShown(sidebar, innerWidth, inspectorOpen));
  const win = $derived(frame(mode, sidebarOpen));
  const side = $derived(sidebarModel(ui, sel));
  const foot = $derived(footer(status, ui.projects.length));
  const sub = $derived(subtitle(ui, sel, board.running, board.waiting));
  const settle = $derived(settleText(settleHours(ui, sel)));

  // The inspector finds its job on every board, so it stays open across a switch and after settling.
  const openItem = $derived(openRef === null ? null : (boardJobs(ui, ALL).find((b) => b.project.id === openRef?.project && b.job.id === openRef.id) ?? null));
  // A job that was shown and is gone leaves "Nothing selected"; one a link named that never
  // existed closes the inspector.
  let shownKey: string | null = null;
  $effect(() => {
    if (openItem !== null) shownKey = openItem.key;
    else if (openRef !== null && loaded) {
      if (shownKey === jobKey(openRef)) {
        openRef = null;
        openFile = null;
      } else closeInspector();
    }
  });
  $effect(() => {
    if (sheet !== null && loaded && openItem?.job.stage !== 'needs-human') sheet = null; // the job moved on
  });
  $effect(() => {
    if (settledOpen && loaded && !board.settled.some((b) => settledProject === null || b.project.id === settledProject)) settledOpen = false;
  });

  function select(next: Selection): void {
    selection = next;
    saveSelection(storage(), next);
  }
  function openSettled(pid: string | null): void {
    settledProject = pid;
    settledOpen = true;
  }
  function openJob(key: string): void {
    const b = boardJobs(ui, ALL).find((x) => x.key === key);
    if (b === undefined) return;
    settledOpen = false;
    if (openKey !== key) openFile = null;
    openRef = { project: b.project.id, id: b.job.id };
    inspectorOpen = true;
  }
  function closeInspector(): void {
    inspectorOpen = false;
    openRef = null;
    openFile = null;
    sheet = null;
    sidebar = { user: sidebar.user, override: false };
  }
  function toggleInspector(): void {
    if (inspectorOpen) closeInspector();
    else inspectorOpen = true;
  }

  // Copying shows a HUD toast for 1.6s. A failed write says so; the command stays on screen to select.
  let toast = $state<{ text: string; ok: boolean } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function show(text: string, ok: boolean): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toast = { text, ok };
    toastTimer = setTimeout(() => (toast = null), TOAST_MS);
  }
  function copy(command: string): void {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(
        () => show(copiedText(command), true),
        () => show("Couldn't copy: select the command and copy it yourself", false),
      );
  }
  $effect(() => () => {
    if (toastTimer !== null) clearTimeout(toastTimer);
  });

  // ---- the URL: the view in the hash, and its history (route.ts) ----

  const view = $derived<View>({
    project: sel === ALL ? null : sel,
    inspector: inspectorOpen,
    job: openRef,
    file: openRef === null ? null : openFile,
    settled: settledOpen ? { project: settledProject } : null,
    sheet: keysOpen ? 'keys' : sheet,
    needs,
  });

  function applyView(v: View): void {
    if ((v.project ?? ALL) !== selection) select(v.project ?? ALL);
    openRef = v.job;
    openFile = v.file;
    inspectorOpen = v.inspector;
    if (!v.inspector) sidebar = { user: sidebar.user, override: false };
    settledOpen = v.settled !== null;
    settledProject = v.settled?.project ?? null;
    sheet = v.sheet === 'rework' || v.sheet === 'abandon' ? v.sheet : null;
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
    const layers = { sheet: settledOpen || sheet !== null || keysOpen, inspector: inspectorOpen, searchText: query !== '', searchFocused };
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
        // the topmost first: a command sheet or the shortcuts open over the Settled sheet's place
        if (keysOpen) keysOpen = false;
        else if (sheet !== null) sheet = null;
        else settledOpen = false;
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

<div class="window" class:mac={mode === 'mac'} class:nosb={!sidebarOpen} style:--inset="{win.inset}px" style:--toolbar-inset="{win.toolbarInset}px">
  <Sidebar model={side} {foot} {status} drag={win.drag} onselect={select} />
  <div class="main">
    <Toolbar
      title={title(ui, sel)}
      {sub}
      {focused}
      settled={board.settled.length}
      {sidebarOpen}
      {inspectorOpen}
      selected={openItem === null ? null : `${openItem.project.name} / ${openItem.job.id}`}
      drag={win.drag}
      bind:query
      bind:searchEl
      bind:searchFocused
      {needs}
      ontoggleneeds={() => (needs = !needs)}
      ontogglesidebar={() => (sidebar = toggleSidebar(sidebar, innerWidth, inspectorOpen))}
      onback={() => select(ALL)}
      ontoggleinspector={toggleInspector}
      onsettled={() => openSettled(null)}
    />
    <main>
      {#if errors.length > 0}
        <div class="perrs">
          {#each errors as e (e.id)}<div class="perr"><b>{e.name}</b> · {e.reason} <span class="na">(showing its last board)</span></div>{/each}
        </div>
      {/if}
      {#if ui.projects.length === 0}
        {#if status === 'down'}
          <div class="nothing">The Andon service isn't answering.<br /><br />Start it from the factory repo: <code>bun run andon:service</code></div>
        {:else if status === 'live'}
          <div class="nothing">No projects are registered.<br /><br />Run <code>factory init</code> in a repo to add it.</div>
        {:else}
          <div class="nothing">Connecting to the Andon service…</div>
        {/if}
      {:else}
        <Lines lanes={lines.lanes} {header} {jobs} {focused} {recent} {now} {found} selectedKey={openKey} fresh={marks.fresh} moved={marks.moved} onopen={openJob} onfocus={select} onsettled={openSettled} />
        {#if needs && lines.lanes.length === 0}
          <div class="quiet">Nothing needs you{focused ? ' in this project' : ''}. Press <kbd>n</kbd> to show everything.</div>
        {:else if board.shown === 0 && !focused}
          <div class="quiet">The line is quiet. Start a job with <code>/factory &lt;feature&gt;</code> or <code>/factory next</code>.</div>
        {/if}
      {/if}
    </main>
    <StatusBar {settle} {now} />
  </div>
  <Inspector
    item={openItem}
    open={inspectorOpen}
    width={inspectorWidth}
    {now}
    {fetcher}
    file={openFile}
    onfile={(f) => (openFile = f)}
    onclose={closeInspector}
    onresize={(w) => (inspectorWidth = w)}
    oncopy={copy}
    onsheet={(k) => (sheet = k)}
  />
</div>
<SettledSheet
  settled={board.settled}
  open={settledOpen}
  project={settledProject === null ? null : (ui.projects.find((p) => p.id === settledProject) ?? null)}
  onclearfilter={() => (settledProject = null)}
  onclose={() => (settledOpen = false)}
  onopen={openJob}
/>
<CommandSheet kind={sheet} id={openItem?.job.id ?? ''} oncopy={copy} onclose={() => (sheet = null)} />
<ShortcutSheet open={keysOpen} onclose={() => (keysOpen = false)} />
<div class="hud" class:on={toast !== null} class:fail={toast !== null && !toast.ok} role="status" aria-live="polite">
  {#if toast !== null}
    {#if toast.ok}<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{/if}
    <span>{toast.text}</span>
  {/if}
</div>
