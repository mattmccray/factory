<script lang="ts">
  // The Backlog sheet (brief andon-backlog-ui), built like the Settled sheet: per project, a Queued
  // group (the open backlog lines in the order `/factory next` takes them: title, done-text, kind,
  // an epic's member count, and earlier abandoned attempts) and an In exploration group (draft
  // briefs, then draft plans). A lane's "N queued" link opens it filtered to one project, shown as
  // a removable chip. A brief or epic row opens its page in the inspector and closes the
  // sheet; a free-text line has no page. Its lists are fetched while it is open (App.svelte, live.ts),
  // and re-fetched on each project's `backlog` event; a failed fetch shows that project's reason.
  // Starting work (brief t3-start-work): each queued brief or free-text row offers Run, each queued
  // epic Start epic, each exploration Continue exploring, and each project Run next and New
  // exploration…. An action closes the sheet, copies its command, and (in the Mac app) starts it in
  // T3 Code as Settings say (`onstart`, see startwork.ts); New exploration… opens its own sheet.
  import { backlogCountText } from './backlog';
  import type { BacklogRow, BacklogSheet, DocRef } from './backlog';
  import { nextStart } from './startwork';
  import type { StartItem } from './startwork';
  import Sheet from './Sheet.svelte';

  interface Props {
    model: BacklogSheet;
    open: boolean;
    project: { id: string; name: string } | null; // the filter chip
    onclearfilter: () => void;
    onclose: () => void;
    onopenpage: (ref: DocRef) => void;
    onstart: (item: StartItem) => void; // a row's or project's action: copy, then start in T3 Code
    onnewexploration: (project: { id: string; name: string }) => void; // opens the New exploration sheet
  }
  let { model, open, project, onclearfilter, onclose, onopenpage, onstart, onnewexploration }: Props = $props();

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
      {@const next = nextStart(p.id)}
      <li class="bproj">
        <span class="bpname">{project === null || model.projects.length > 1 ? p.name : ''}</span>
        <span class="bacts">
          <button class="btn bstart" type="button" title="Copy {next.command}" onclick={() => onstart(next)}>{next.label}</button>
          <button class="btn bstart" type="button" aria-haspopup="dialog" onclick={() => onnewexploration({ id: p.id, name: p.name })}>New exploration…</button>
        </span>
      </li>
      {#if p.reason !== null}
        <li class="empty fail" role="alert">{project === null ? `${p.name}: ` : ''}{p.reason}</li>
      {/if}
      {#each p.groups as g (g.name)}
        <li class="bgroup">{g.name}</li>
        {#each g.rows as r (r.key)}
          {@const page = r.page}
          {@const start = r.start}
          <li class="brow">
            {#if page !== null}
              <button class="srow" type="button" aria-haspopup="dialog" title="Open the {page.kind} {page.slug}" onclick={() => onopenpage(page)}>
                {@render rowBody(r)}
              </button>
            {:else}
              <div class="srow btext">{@render rowBody(r)}</div>
            {/if}
            {#if start !== null}
              <button class="btn bstart" type="button" title="Copy {start.command}" aria-label="{start.label}: {r.title}" onclick={() => onstart(start)}>{start.label}</button>
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
