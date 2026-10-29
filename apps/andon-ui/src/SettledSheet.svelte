<script lang="ts">
  // The Settled sheet (design §9): merged jobs older than their project's settleAfterHours, and
  // every abandoned job, newest end first. A lane's "N settled" link opens it filtered to one
  // project, shown as a removable chip. Settled is only a view; a row opens the job in the
  // inspector and closes the sheet. Its lists are fetched when it opens (App.svelte): until the
  // first ones arrive it says it is loading, and a failed fetch shows its reason. A settled epic is
  // one row (its name, landed or abandoned, the landing's short sha, and its member count) that opens
  // the epic page, with its jobs grouped under it rather than loose.
  import type { BoardEpic, BoardJob } from './board';
  import { settledItems, settledTitle } from './inspector';
  import type { SettledStatus } from './projects';
  import Sheet from './Sheet.svelte';
  import { when } from './time';

  interface Props {
    settled: BoardJob[];
    epics: BoardEpic[]; // the settled epics
    status: SettledStatus; // the fetches behind the listed projects
    open: boolean;
    project: { id: string; name: string } | null; // the filter chip
    onclearfilter: () => void;
    onclose: () => void;
    onopen: (key: string) => void;
    onopenepic: (key: string) => void;
  }
  let { settled, epics, status, open, project, onclearfilter, onclose, onopen, onopenepic }: Props = $props();

  const rows = $derived(settledItems(settled, epics, project?.id ?? null));
  const jobCount = $derived(rows.reduce((n, r) => n + (r.kind === 'job' ? 1 : r.row.jobs.length), 0));
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
  <ul class="slist" aria-busy={status.loading}>
    {#each status.failures as f (f.id)}
      <li class="empty fail" role="alert">{status.failures.length > 1 || project === null ? `${f.name}: ` : ''}{f.reason}</li>
    {/each}
    {#each rows as item (item.row.key)}
      {#if item.kind === 'epic'}
        {@const e = item.row}
        <li class="sepic">
          <button class="srow" type="button" aria-haspopup="dialog" onclick={() => onopenepic(e.key)}>
            <span class="st"><span class="etag">Epic</span>{e.name}<span class="atag" class:landed={e.outcome === 'Landed'}>{e.outcome}</span></span>
            <span class="sm">{when(e.end)}</span>
            <span class="si">{e.project} · {e.slug}{#if e.sha !== null}{' · '}<span class="mono">{e.sha}</span>{/if}</span>
            <span class="sm">{e.members}</span>
            {#if e.reason !== null}<span class="why">{e.reason || 'No reason recorded.'}</span>{/if}
          </button>
          {#if e.jobs.length > 0}
            <ul class="sjobs" aria-label="{e.name}: its jobs">
              {#each e.jobs as r (r.key)}
                <li>
                  <button class="srow" type="button" onclick={() => onopen(r.key)}>
                    <span class="st">{r.title}{#if r.tag !== null}<span class="atag">{r.tag}</span>{/if}</span>
                    <span class="sm">{when(r.end)}</span>
                    <span class="si">{r.id}</span>
                    <span class="sm">total {r.total} · {r.rounds}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {:else}
        {@const r = item.row}
        <li>
          <button class="srow" type="button" onclick={() => onopen(r.key)}>
            <span class="st">{r.title}{#if r.tag !== null}<span class="atag">{r.tag}</span>{/if}</span>
            <span class="sm">{when(r.end)}</span>
            <span class="si">{r.project} · {r.id}</span>
            <span class="sm">total {r.total} · {r.rounds}</span>
            {#if r.reason !== null}<span class="why">{r.reason || 'No reason recorded.'}</span>{/if}
          </button>
        </li>
      {/if}
    {:else}
      {#if status.loading}
        <li class="empty" role="status">Loading settled jobs…</li>
      {:else if status.failures.length === 0}
        <li class="empty">Nothing has settled.</li>
      {/if}
    {/each}
  </ul>
  <footer>
    <span class="l">{status.loading && rows.length === 0 ? '' : `${jobCount} ${jobCount === 1 ? 'job' : 'jobs'}`}</span>
    <button class="btn primary" type="button" onclick={onclose}>Done</button>
  </footer>
</Sheet>
