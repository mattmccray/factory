<script lang="ts">
  // One project's lane (design §5): the 148px gutter (the name, which focuses the project, its
  // status dot, "N active · <oldest claim>", "N at Andon" or "N sent back", and the "N settled"
  // link), then six cells of tokens, newest first, with "+N more" past the cap and the dashed
  // ghosts of needs-human jobs. An idle lane collapses to one row in All Projects. A token that
  // changes column slides there in 250ms (a crossfade between the cells), then highlights. Under a
  // search, a lane with no match dims to 25% whole; in a lit lane, each token that misses dims.
  // The gutter carries the project's id for the Mac app's right-click menu (projectmenu.ts), and each
  // board token its job's ids for the job menu (jobmenu.ts); the ghosts carry neither.
  import { cubicOut } from 'svelte/easing';
  import { crossfade } from 'svelte/transition';
  import type { Find } from './find';
  import type { Lane } from './lanes';
  import { motionMs } from './motion';
  import Token from './Token.svelte';

  interface Props {
    lane: Lane;
    focused: boolean;
    found: Find;
    selectedKey: string | null;
    fresh: ReadonlySet<string>;
    moved: ReadonlySet<string>;
    onopen: (key: string) => void;
    onfocus: (pid: string) => void;
    onsettled: (pid: string) => void;
    onhover: (key: string | null, el: HTMLElement | null) => void;
  }
  let { lane, focused, found, selectedKey, fresh, moved, onopen, onfocus, onsettled, onhover }: Props = $props();

  // Only a token that moves between two cells animates; one that appears or leaves has no partner and doesn't.
  const [send, receive] = crossfade({ duration: () => motionMs(250), easing: cubicOut, fallback: () => ({ duration: 0 }) });
  const name = $derived(lane.project.name);
  const laneMiss = $derived(found.dimLanes.has(lane.project.id));
  const miss = (key: string): boolean => found.active && !laneMiss && !found.keys.has(key);
</script>

{#if lane.idle && !focused}
  <div class="row lane idle" class:miss={laneMiss} role="row" aria-label="{name}, idle">
    <div class="gut" role="rowheader" data-project-menu={lane.project.id}>
      <button class="pn" type="button" title="Focus {name}" onclick={() => onfocus(lane.project.id)}><span class="dot gray" aria-hidden="true"></span><span class="pname">{name}</span></button>
    </div>
    <div class="span" role="cell">
      <span>{lane.idleText}</span>
      {#if lane.meta.settled > 0}
        <button class="settled-pill" type="button" aria-haspopup="dialog" onclick={() => onsettled(lane.project.id)}>Settled <b>{lane.meta.settled}</b></button>
      {/if}
    </div>
  </div>
{:else}
  <div class="row lane" class:miss={laneMiss} role="row" data-rows={lane.rows}>
    <div class="gut" role="rowheader" data-project-menu={lane.project.id}>
      <button class="pn" type="button" title={focused ? name : `Focus ${name}`} onclick={() => onfocus(lane.project.id)}>
        <span class="dot {lane.dot}" aria-hidden="true"></span><span class="pname">{name}</span>
      </button>
      <span class="meta" title="active jobs · oldest claim">{lane.meta.active}</span>
      {#if lane.meta.trouble !== null || (lane.meta.settled > 0 && !focused)}
        <span class="meta">
          {#if lane.meta.trouble !== null}<span class="t-{lane.meta.trouble.tone}">{lane.meta.trouble.text}</span>{/if}
          {#if lane.meta.trouble !== null && lane.meta.settled > 0 && !focused}<span aria-hidden="true"> · </span>{/if}
          {#if lane.meta.settled > 0 && !focused}<button class="slink" type="button" aria-haspopup="dialog" onclick={() => onsettled(lane.project.id)}>{lane.meta.settled} settled</button>{/if}
        </span>
      {/if}
    </div>
    {#each lane.cells as cell (cell.column)}
      <div class="cell c-{cell.column}" role="cell">
        {#each cell.tokens as t (t.key)}
          <div class="slot" in:receive={{ key: t.key }} out:send={{ key: t.key }}>
            <Token token={t} project={lane.project.id} miss={miss(t.key)} selected={selectedKey === t.key} fresh={fresh.has(t.key)} moved={moved.has(t.key)} {onopen} {onhover} />
          </div>
        {/each}
        {#if cell.more > 0}
          <button class="more" type="button" onclick={() => onfocus(lane.project.id)}>+{cell.more} more</button>
        {/if}
        {#each cell.ghosts as g (g.key)}
          <button class="ghost" class:miss={miss(g.key)} type="button" aria-haspopup="dialog" aria-label={g.label} onclick={() => onopen(g.key)}><span class="num">{g.num}</span>{g.text}</button>
        {/each}
        {#if cell.tokens.length === 0 && cell.more === 0 && cell.ghosts.length === 0}<span class="none" aria-hidden="true">—</span>{/if}
      </div>
    {/each}
  </div>
{/if}
