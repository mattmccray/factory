<script lang="ts">
  // Andon: every registered project's board, live from the agent's `GET /events`, inside the
  // Mac-app frame (design §3): sidebar, toolbar, the Assembly Lines matrix (§5–§7), the inspector
  // (§8) with its Rework and Abandon sheets, the Settled sheet (§9), and the status bar. Selecting a project (in the sidebar, or by its gutter name) focuses it. This wires
  // the browser (EventSource, fetch, localStorage, the URL, a 1 s clock) to the plain modules that
  // hold the logic; the components below only lay out what those modules return.
  import { onMount } from 'svelte';
  import type { Fetcher } from './api';
  import { buildBoard, movement } from './board';
  import CommandSheet from './CommandSheet.svelte';
  import Inspector from './Inspector.svelte';
  import { INSPECTOR_DEFAULT, TOAST_MS, copiedText, sidebarShown, toggleSidebar } from './inspector';
  import type { SheetKind, SidebarChoice } from './inspector';
  import { activity, buildLanes, headerOf, orderLanes } from './lanes';
  import type { LaneOrder } from './lanes';
  import Lines from './Lines.svelte';
  import { startLive } from './live';
  import type { Status } from './live';
  import { ALL, boardJobs, loadSelection, projectErrors, resolveSelection, reviewersFor, saveSelection } from './projects';
  import type { Selection } from './projects';
  import SettledSheet from './SettledSheet.svelte';
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
  let selection = $state<Selection>(loadSelection(storage()));
  let openKey = $state<string | null>(null);
  let settledOpen = $state(false);
  let settledProject = $state<string | null>(null); // a lane's "N settled" link filters the sheet
  let sidebar = $state<SidebarChoice>({ user: true, override: false });
  let inspectorOpen = $state(false); // open with no job: "Nothing selected"
  let inspectorWidth = $state(INSPECTOR_DEFAULT); // not kept across reloads
  let sheet = $state<SheetKind | null>(null); // the open Rework… or Abandon… sheet
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
    return () => {
      live.stop();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  });

  const sel = $derived(ui.projects.length > 0 ? resolveSelection(ui, selection) : selection);
  const jobs = $derived(boardJobs(ui, sel));
  const board = $derived(buildBoard(jobs, now, reviewersFor(ui, sel)));
  const errors = $derived(projectErrors(ui, sel));
  const loaded = $derived(ui.projects.length > 0 && ui.projects.every((p) => ui.boards[p.id]?.loaded === true));

  // The lanes: every registered project in All Projects, or the focused one (uncapped, with its
  // settled merges and recent activity). Lane order is sorted once every board has loaded, then a
  // lane moves only when its tier changes (lanes.ts `orderLanes`).
  const focused = $derived(sel !== ALL);
  const shownProjects = $derived(ui.projects.filter((p) => !focused || p.id === sel));
  let laneOrder: LaneOrder | null = null;
  const lines = $derived(orderLanes(buildLanes(shownProjects, jobs, now, focused), loaded && !focused ? laneOrder : null));
  $effect(() => {
    if (loaded && !focused) laneOrder = lines.order;
  });
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
  const openItem = $derived(openKey === null ? null : (boardJobs(ui, ALL).find((b) => b.key === openKey) ?? null));
  $effect(() => {
    if (openKey !== null && openItem === null && loaded) openKey = null; // the job is gone
  });
  $effect(() => {
    if (sheet !== null && openItem?.job.stage !== 'needs-human') sheet = null; // the job moved on
  });
  $effect(() => {
    if (settledOpen && !board.settled.some((b) => settledProject === null || b.project.id === settledProject)) settledOpen = false;
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
    settledOpen = false;
    openKey = key;
    inspectorOpen = true;
  }
  function closeInspector(): void {
    inspectorOpen = false;
    openKey = null;
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

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // An open sheet (a <dialog>) handles its own Escape first. Otherwise Escape closes the
    // inspector, and its default is suppressed: Chromium's Escape default ("stop loading") also
    // aborts the event stream.
    if (document.querySelector('dialog[open]') !== null) return;
    e.preventDefault();
    if (inspectorOpen) closeInspector();
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
          <div class="nothing">The Andon agent isn't answering.<br /><br />Start it from the factory repo: <code>bun run andon</code></div>
        {:else if status === 'live'}
          <div class="nothing">No projects are registered.<br /><br />Run <code>factory init</code> in a repo to add it.</div>
        {:else}
          <div class="nothing">Connecting to the Andon agent…</div>
        {/if}
      {:else}
        <Lines lanes={lines.lanes} {header} {jobs} {focused} {recent} {now} selectedKey={openKey} fresh={marks.fresh} moved={marks.moved} onopen={openJob} onfocus={select} onsettled={openSettled} />
        {#if board.shown === 0 && !focused}
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
<div class="hud" class:on={toast !== null} class:fail={toast !== null && !toast.ok} role="status" aria-live="polite">
  {#if toast !== null}
    {#if toast.ok}<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{/if}
    <span>{toast.text}</span>
  {/if}
</div>
