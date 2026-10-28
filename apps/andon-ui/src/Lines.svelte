<script lang="ts">
  // The Assembly Lines matrix (design §3, §5–§7): a 148px project gutter and six station columns,
  // under a sticky, blurred header (each column's square, name, count badge, and role, and the
  // gutter's "N active · M idle"). One lane per project, in the order lanes.ts gives; a lane that
  // changes place slides there in 250ms. A focused project adds its Recent activity list. The
  // hover popover is shared by every token. Search (`found`, find.ts) dims what doesn't match.
  import { flip } from 'svelte/animate';
  import type { BoardJob } from './board';
  import type { Find } from './find';
  import Lane from './Lane.svelte';
  import { age, isHuman, kindOf, popoverOf } from './lanes';
  import type { ActivityItem, Header, Lane as LaneModel } from './lanes';
  import { motionMs } from './motion';
  import { when } from './time';
  import TokenPopover from './TokenPopover.svelte';

  interface Props {
    lanes: LaneModel[];
    header: Header;
    jobs: BoardJob[]; // the jobs on show, for the popover
    focused: boolean;
    recent: ActivityItem[]; // a focused project's recent activity
    now: number;
    found: Find;
    selectedKey: string | null;
    fresh: ReadonlySet<string>;
    moved: ReadonlySet<string>;
    onopen: (key: string) => void;
    onfocus: (pid: string) => void;
    onsettled: (pid: string) => void;
  }
  let { lanes, header, jobs, focused, recent, now, found, selectedKey, fresh, moved, onopen, onfocus, onsettled }: Props = $props();

  // The popover opens after 350ms over (or focused on) a token, and closes when it leaves.
  const HOVER_MS = 350;
  let hovered = $state<{ key: string; anchor: { top: number; left: number; right: number } } | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function onhover(key: string | null, el: HTMLElement | null): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (key === null || el === null) {
      hovered = null;
      return;
    }
    timer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      hovered = { key, anchor: { top: r.top, left: r.left, right: r.right } };
    }, HOVER_MS);
  }
  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
  });
  const hoverJob = $derived(hovered === null ? null : (jobs.find((b) => b.key === hovered?.key) ?? null));
  const pop = $derived(hoverJob === null ? null : popoverOf(hoverJob, now));
  const popTone = $derived(hoverJob !== null && (isHuman(kindOf(hoverJob, now)) || kindOf(hoverJob, now) === 'review-failed') ? 'red' : 'none');
  const open = (key: string): void => {
    onhover(null, null);
    onopen(key);
  };
  const projectName = $derived(lanes[0]?.project.name ?? '');
</script>

<div class="lines" class:focus={focused} onscroll={() => onhover(null, null)}>
  <div class="matrix" role="table" aria-label={focused ? `${projectName}, by station` : 'Projects by station'}>
    <div class="row head" role="row">
      <div class="corner" role="columnheader">{header.corner}</div>
      {#each header.columns as c (c.key)}
        <div class="hc c-{c.key}" role="columnheader">
          <span class="h">
            {#if c.key === 'andon'}<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8" /></svg>{:else}<i aria-hidden="true"></i>{/if}
            {c.name}
            <span class="badge" class:red={c.key === 'andon' && c.count > 0}>{c.count}<span class="sr-only"> {c.count === 1 ? 'job' : 'jobs'}</span></span>
          </span>
          <span class="w">{c.who}</span>
        </div>
      {/each}
    </div>
    {#each lanes as lane (lane.project.id)}
      <div class="lane-slot" animate:flip={{ duration: motionMs(250) }}>
        <Lane {lane} {focused} {found} {selectedKey} {fresh} {moved} onopen={open} {onfocus} {onsettled} {onhover} />
      </div>
    {/each}
  </div>
  {#if focused}
    <section class="hist" aria-labelledby="hist-title">
      <h3 id="hist-title">Recent activity in {projectName}</h3>
      {#if recent.length === 0}
        <p class="none">Nothing yet.</p>
      {:else}
        <ul>
          {#each recent as a, i (`${a.key}-${a.at}-${i}`)}
            <li>
              <button type="button" aria-haspopup="dialog" onclick={() => open(a.key)}>
                <span class="w">{when(a.at)}</span>
                <span class="id">{a.num}</span>
                <span class="e t-{a.tone ?? 'none'}">{a.text}</span>
                <span class="w">{age(now - a.at)} ago</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
{#if pop !== null && hovered !== null}
  <TokenPopover model={pop} anchor={hovered.anchor} tone={popTone} />
{/if}
