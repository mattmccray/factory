<script lang="ts">
  // Andon: every registered project's board, live from the agent's `GET /events`. This wires the
  // browser (EventSource, fetch, localStorage, a 1 s clock) to the plain modules that hold the
  // board logic; the components below only lay out what those modules return.
  import { onMount } from 'svelte';
  import type { Fetcher } from './api';
  import { buildBoard, movement } from './board';
  import Board from './Board.svelte';
  import Drawer from './Drawer.svelte';
  import Header from './Header.svelte';
  import { startLive } from './live';
  import type { Status } from './live';
  import { ALL, boardJobs, loadSelection, needsHuman, projectErrors, resolveSelection, reviewersFor, saveSelection } from './projects';
  import type { Selection } from './projects';
  import SettledDialog from './SettledDialog.svelte';
  import { emptyState } from './state';
  import type { UiState } from './state';
  import { ago, time } from './time';

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
  const showProject = $derived(sel === ALL && ui.projects.length > 1);
  const jobs = $derived(boardJobs(ui, sel));
  const board = $derived(buildBoard(jobs, now, reviewersFor(ui, sel)));
  const counts = $derived(needsHuman(ui));
  const errors = $derived(projectErrors(ui, sel));
  const loaded = $derived(ui.projects.length > 0 && ui.projects.every((p) => ui.boards[p.id]?.loaded === true));

  // Cards new to the board play a settle-in animation, and cards that changed stage flash.
  let seen = new Map<string, string>();
  const marks = $derived(movement(seen, jobs));
  $effect(() => {
    seen = marks.stages;
  });

  const lastChange = $derived(jobs.reduce<string | null>((m, b) => (b.job.updated !== null && time(b.job.updated) > time(m) ? b.job.updated : m), null));
  const statusText = $derived(
    status === 'down' ? 'agent unreachable — retrying' : status === 'connecting' ? 'connecting…' : lastChange !== null ? `last change ${ago(lastChange, now)}` : 'idle',
  );

  // The drawer finds its job on every board, so it stays open across a switch and after settling.
  const openItem = $derived(openKey === null ? null : (boardJobs(ui, ALL).find((b) => b.key === openKey) ?? null));
  $effect(() => {
    if (openKey !== null && openItem === null && loaded) openKey = null; // the job is gone
  });
  $effect(() => {
    if (settledOpen && board.settled.length === 0) settledOpen = false;
  });

  function select(next: Selection): void {
    selection = next;
    saveSelection(storage(), next);
  }
  function openJob(key: string): void {
    settledOpen = false;
    openKey = key;
  }
  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // An open <dialog> handles its own Escape. Otherwise Escape closes the drawer, and its default
    // is suppressed: Chromium's Escape default ("stop loading") also aborts the event stream.
    if (document.querySelector('dialog[open]') !== null) return;
    e.preventDefault();
    openKey = null;
  }
</script>

<svelte:window {onkeydown} />

<Header
  projects={ui.projects}
  {counts}
  selection={sel}
  running={board.running}
  waiting={board.waiting}
  shown={board.shown}
  settled={board.settled.length}
  {status}
  {statusText}
  onselect={select}
  onsettled={() => (settledOpen = true)}
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
  {:else if board.shown === 0}
    <div class="nothing">The line is quiet.<br /><br />Start a job with <code>/factory &lt;feature&gt;</code> or <code>/factory next</code>.</div>
  {:else}
    <Board {board} {now} {showProject} fresh={marks.fresh} moved={marks.moved} onopen={openJob} />
  {/if}
</main>
<SettledDialog settled={board.settled} {showProject} open={settledOpen} onclose={() => (settledOpen = false)} onopen={openJob} />
<Drawer item={openItem} {now} showProject={showProject || (sel !== ALL && openItem !== null && openItem.project.id !== sel)} {fetcher} onclose={() => (openKey = null)} />
