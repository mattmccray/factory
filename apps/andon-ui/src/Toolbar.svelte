<script lang="ts">
  // The toolbar (design §3, 52px): the sidebar toggle, the title with its subtitle, the Settled
  // button, and the inspector toggle. A focused project (§7) adds a "‹" back button to All
  // Projects, and the subtitle's "N waiting elsewhere". In the Mac app it is a drag region (its
  // buttons are not). The inspector toggle names the open job, or "Nothing selected". Search and
  // the Needs Me toggle (§10) sit before Settled; `/` focuses the field and `n` flips the toggle.
  import type { Subtitle } from './sidebar';

  interface Props {
    title: string;
    sub: Subtitle;
    focused: boolean;
    settled: number;
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
  }
  let {
    title,
    sub,
    focused,
    settled,
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
  }: Props = $props();
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
  <div class="search" role="search">
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
  <button class="tb icon ins" type="button" aria-controls="inspector" aria-expanded={inspectorOpen} aria-label="Inspector: {selected ?? 'Nothing selected'}" title={`${inspectorOpen ? 'Hide' : 'Show'} the inspector — ${selected ?? 'Nothing selected'}`} onclick={ontoggleinspector}>
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
  </button>
</header>
