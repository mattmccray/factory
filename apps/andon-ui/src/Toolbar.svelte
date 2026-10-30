<script lang="ts">
  // The toolbar (design §3, 52px): the sidebar toggle, the title with its subtitle, the Settled
  // button, and the inspector toggle. A focused project (§7) adds a "‹" back button to All
  // Projects, and the subtitle's "N waiting elsewhere". In the Mac app it is a drag region (its
  // buttons are not). The inspector toggle names the open job, or "Nothing selected". Search and
  // the Needs Me toggle (§10) sit before Settled; `/` focuses the field and `n` flips the toggle.
  // The Backlog button (brief andon-backlog-ui) opens the whole Backlog sheet; under a search, the
  // queued and exploring items whose titles match are listed below the field, each opening its page.
  import type { BacklogHit, DocRef } from './backlog';
  import type { Subtitle } from './sidebar';

  interface Props {
    title: string;
    sub: Subtitle;
    focused: boolean;
    settled: number;
    backlog: number; // queued plus exploring items across the shown projects
    hits: BacklogHit[]; // the search's Backlog results
    sidebarOpen: boolean;
    inspectorOpen: boolean;
    selected: string | null; // the open job ("project / id"), or null: nothing selected
    drag: boolean;
    query: string;
    searchEl?: HTMLInputElement;
    searchFocused: boolean;
    needs: boolean;
    ontoggleneeds: () => void;
    ontogglesidebar: () => void;
    onback: () => void;
    ontoggleinspector: () => void;
    onsettled: () => void;
    onbacklog: () => void;
    onopenpage: (ref: DocRef) => void;
  }
  let {
    title,
    sub,
    focused,
    settled,
    backlog,
    hits,
    sidebarOpen,
    inspectorOpen,
    selected,
    drag,
    query = $bindable(),
    searchEl = $bindable(),
    searchFocused = $bindable(),
    needs,
    ontoggleneeds,
    ontogglesidebar,
    onback,
    ontoggleinspector,
    onsettled,
    onbacklog,
    onopenpage,
  }: Props = $props();

  // The results list shows while focus is in the search (its field or the list itself).
  let within = $state(false);
  const showHits = $derived(within && query.trim() !== '' && hits.length > 0);
  const leave = (e: FocusEvent): void => {
    within = e.currentTarget instanceof HTMLElement && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget);
  };
</script>

<header class="toolbar" data-tiny-drag={drag ? '' : undefined}>
  <button class="tb icon" type="button" aria-controls="sidebar" aria-expanded={sidebarOpen} aria-label="Sidebar" title={sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'} onclick={ontogglesidebar}>
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6 3v10" /></svg>
  </button>
  {#if focused}
    <button class="tb icon back" type="button" aria-label="Back to All Projects" title="All Projects" onclick={onback}>
      <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
    </button>
  {/if}
  <div class="ttl">
    <h1 class="t">{title}</h1>
    <span class="s">{sub.scope} — {sub.running}{#if sub.waiting !== null}, <span class="hot">{sub.waiting}</span>{/if}{#if sub.elsewhere !== null}, <span class="hot">{sub.elsewhere}</span>{/if}</span>
  </div>
  <div class="search" role="search" onfocusin={() => (within = true)} onfocusout={leave}>
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
    <input
      type="text"
      bind:this={searchEl}
      bind:value={query}
      placeholder="Search"
      aria-label="Search jobs by id, title, or project"
      aria-keyshortcuts="/"
      spellcheck="false"
      autocomplete="off"
      onfocus={() => (searchFocused = true)}
      onblur={() => (searchFocused = false)}
    />
    {#if showHits}
      <div class="bhits" aria-label="Backlog results">
        <h3>Backlog</h3>
        <ul>
          {#each hits as h (h.key)}
            <li>
              <button type="button" aria-haspopup="dialog" onclick={() => onopenpage(h.page)}>
                <span class="etag">{h.kindLabel}</span><span class="bt">{h.title}</span><span class="bp">{h.project} · {h.group === 'Queued' ? 'queued' : 'exploring'}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
  <button class="tb needs" type="button" aria-pressed={needs} aria-keyshortcuts="n" title="Show only what needs you (n)" onclick={ontoggleneeds}>
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8" /></svg>
    Needs Me
  </button>
  {#if settled > 0}
    <button class="tb" type="button" aria-haspopup="dialog" aria-label="Settled, {settled} {settled === 1 ? 'job' : 'jobs'}" onclick={onsettled}>
      <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6.5h9V6M6.5 9h3" /></svg>
      Settled <span class="badge" aria-hidden="true">{settled}</span>
    </button>
  {/if}
  {#if backlog > 0}
    <button class="tb" type="button" aria-haspopup="dialog" aria-label="Backlog, {backlog} {backlog === 1 ? 'item' : 'items'}" title="Show the backlog" onclick={onbacklog}>
      <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
      Backlog <span class="badge" aria-hidden="true">{backlog}</span>
    </button>
  {/if}
  <button class="tb icon ins" type="button" aria-controls="inspector" aria-expanded={inspectorOpen} aria-label="Inspector: {selected ?? 'Nothing selected'}" title={`${inspectorOpen ? 'Hide' : 'Show'} the inspector — ${selected ?? 'Nothing selected'}`} onclick={ontoggleinspector}>
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
  </button>
</header>
