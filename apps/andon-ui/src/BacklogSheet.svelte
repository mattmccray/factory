<script lang="ts">
  // The Backlog sheet (brief andon-backlog-ui), built like the Settled sheet: per project, a Queued
  // group (the open backlog lines in the order `/factory next` takes them: title, done-text, kind,
  // an epic's member count, and earlier abandoned attempts) and an In exploration group (draft
  // briefs, then draft plans). A lane's "N queued" link opens it filtered to one project, shown as
  // a removable chip. Read-only: a brief or epic row opens its page in the inspector and closes the
  // sheet; a free-text line has no page. Its lists are fetched while it is open (App.svelte, live.ts),
  // and re-fetched on each project's `backlog` event; a failed fetch shows that project's reason.
  import { backlogCountText } from './backlog';
  import type { BacklogRow, BacklogSheet, DocRef } from './backlog';
  import Sheet from './Sheet.svelte';

  interface Props {
    model: BacklogSheet;
    open: boolean;
    project: { id: string; name: string } | null; // the filter chip
    onclearfilter: () => void;
    onclose: () => void;
    onopenpage: (ref: DocRef) => void;
  }
  let { model, open, project, onclearfilter, onclose, onopenpage }: Props = $props();

  const rows = $derived(model.queued + model.exploring);
</script>

<Sheet {open} labelledby="backlog-title" {onclose}>
  <header>
    <h2 id="backlog-title">Backlog · queued, then in exploration</h2>
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
  <ul class="slist blist" aria-busy={model.loading}>
    {#each model.projects as p (p.id)}
      {#if project === null || model.projects.length > 1}<li class="bproj">{p.name}</li>{/if}
      {#if p.reason !== null}
        <li class="empty fail" role="alert">{project === null ? `${p.name}: ` : ''}{p.reason}</li>
      {/if}
      {#each p.groups as g (g.name)}
        <li class="bgroup">{g.name}</li>
        {#each g.rows as r (r.key)}
          {@const page = r.page}
          <li>
            {#if page !== null}
              <button class="srow" type="button" aria-haspopup="dialog" title="Open the {page.kind} {page.slug}" onclick={() => onopenpage(page)}>
                {@render rowBody(r)}
              </button>
            {:else}
              <div class="srow btext">{@render rowBody(r)}</div>
            {/if}
          </li>
        {/each}
      {/each}
      {#if p.loading && p.groups.length === 0 && p.reason === null}
        <li class="empty" role="status">Loading the backlog…</li>
      {/if}
    {:else}
      {#if model.loading}
        <li class="empty" role="status">Loading the backlog…</li>
      {:else}
        <li class="empty">Nothing is queued or in exploration.</li>
      {/if}
    {/each}
  </ul>
  <footer>
    <span class="l">{model.loading && rows === 0 ? '' : backlogCountText(model)}</span>
    <button class="btn primary" type="button" onclick={onclose}>Done</button>
  </footer>
</Sheet>

{#snippet rowBody(r: BacklogRow)}
  <span class="st"><span class="etag">{r.kindLabel}</span>{r.title}{#if r.status !== null}<span class="atag">{r.status}</span>{/if}</span>
  <span class="sm">{r.members ?? ''}</span>
  <span class="si">{r.done ?? (r.page !== null ? r.page.slug : '')}</span>
  <span class="sm">{r.page !== null && r.done !== null ? r.page.slug : ''}</span>
  {#each r.abandoned as a, i (i)}<span class="why">Abandoned before: {a}</span>{/each}
{/snippet}
