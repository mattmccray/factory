<script lang="ts">
  // The Settled sheet (design §9): merged jobs older than their project's settleAfterHours, and
  // every abandoned job, newest end first. A lane's "N settled" link opens it filtered to one
  // project, shown as a removable chip. Settled is only a view; a row opens the job in the
  // inspector and closes the sheet.
  import type { BoardJob } from './board';
  import { settledRows, settledTitle } from './inspector';
  import Sheet from './Sheet.svelte';
  import { when } from './time';

  interface Props {
    settled: BoardJob[];
    open: boolean;
    project: { id: string; name: string } | null; // the filter chip
    onclearfilter: () => void;
    onclose: () => void;
    onopen: (key: string) => void;
  }
  let { settled, open, project, onclearfilter, onclose, onopen }: Props = $props();

  const rows = $derived(settledRows(settled, project?.id ?? null));
  const heading = $derived(settledTitle(project === null ? settled : settled.filter((b) => b.project.id === project.id)));
</script>

<Sheet {open} labelledby="settled-title" {onclose}>
  <header>
    <h2 id="settled-title">{heading}</h2>
    {#if project !== null}
      <p>
        <span class="filter-chip">
          {project.name}
          <button type="button" onclick={onclearfilter} aria-label="Remove the {project.name} filter: show every project" title="Show every project">
            <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </span>
      </p>
    {/if}
  </header>
  <ul class="slist">
    {#each rows as r (r.key)}
      <li>
        <button class="srow" type="button" onclick={() => onopen(r.key)}>
          <span class="st">{r.title}{#if r.tag !== null}<span class="atag">{r.tag}</span>{/if}</span>
          <span class="sm">{when(r.end)}</span>
          <span class="si">{r.project} · {r.id}</span>
          <span class="sm">total {r.total} · {r.rounds}</span>
          {#if r.reason !== null}<span class="why">{r.reason || 'No reason recorded.'}</span>{/if}
        </button>
      </li>
    {:else}
      <li class="empty">Nothing has settled.</li>
    {/each}
  </ul>
  <footer>
    <span class="l">{rows.length} {rows.length === 1 ? 'job' : 'jobs'}</span>
    <button class="btn primary" type="button" onclick={onclose}>Done</button>
  </footer>
</Sheet>
