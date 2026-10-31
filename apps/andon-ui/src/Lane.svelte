<script lang="ts">
  // One project's lane (design §5): the 148px gutter (the name, which focuses the project, its
  // status dot, "N active · <oldest claim>", "N at Andon" or "N sent back", and the "N settled"
  // link, shown when focused too, and beside it the "N queued" link to the Backlog sheet when the
  // project has queued work), then six cells of tokens, newest first, with "+N more" past the cap and the dashed
  // ghosts of needs-human jobs. An idle lane collapses to one row in All Projects. A token that
  // changes column slides there in 250ms (a crossfade between the cells), then highlights. Under a
  // search, a lane with no match dims to 25% whole; in a lit lane, each token that misses dims.
  // The gutter carries the project's id for the Mac app's right-click menu (projectmenu.ts), and each
  // board token its job's ids for the job menu (jobmenu.ts), and each epic's name its slug and project
  // id for the epic menu (epicmenu.ts); the ghosts carry none.
  // Its epics (docs/design/epics/design.md decision 9) follow as sub-lanes, oldest start first, and
  // move with it: an indented gutter with an elbow from the project and a faint tint, whose name
  // opens the epic page, then the same six cells holding only the epic's jobs ("+N more" focuses the
  // project). An epic waiting on you turns its gutter red. Under Needs Me, a lane shown only for its
  // sub-lanes collapses to a one-line header. A landed epic's sub-lane (brief andon-landed-epic-row) is
  // one 28px row, focused or not, under a full lane or an idle one: the elbow, the green dot, and
  // the name, then its green-toned "Landed <sha> · N members · took … · … ago" across the columns.
  // Machines (brief andon-machines-ui): a remote project's gutter names its machine ("factory · studio",
  // `lane.label`), and a stale machine's lane (and its sub-lanes) is dimmed, with "as of 14:02" in the
  // gutter; its times were computed at that as-of time (lanes.ts). It keeps its tier position.
  import { cubicOut } from 'svelte/easing';
  import { crossfade } from 'svelte/transition';
  import type { Find } from './find';
  import type { Cell, Lane, SubLane } from './lanes';
  import { motionMs } from './motion';
  import Token from './Token.svelte';

  interface Props {
    lane: Lane;
    focused: boolean;
    found: Find;
    selectedKey: string | null;
    selectedEpic: string | null;
    fresh: ReadonlySet<string>;
    moved: ReadonlySet<string>;
    onopen: (key: string) => void;
    onopenepic: (key: string) => void;
    onfocus: (pid: string) => void;
    onsettled: (pid: string) => void;
    onbacklog: (pid: string) => void;
    onhover: (key: string | null, el: HTMLElement | null) => void;
  }
  let { lane, focused, found, selectedKey, selectedEpic, fresh, moved, onopen, onopenepic, onfocus, onsettled, onbacklog, onhover }: Props = $props();

  // Only a token that moves between two cells animates; one that appears or leaves has no partner and doesn't.
  const [send, receive] = crossfade({ duration: () => motionMs(250), easing: cubicOut, fallback: () => ({ duration: 0 }) });
  const name = $derived(lane.label);
  const laneMiss = $derived(found.dimLanes.has(lane.project.id));
  const subMiss = (key: string): boolean => laneMiss || found.dimSubs.has(key);
  const miss = (key: string): boolean => found.active && !laneMiss && !found.keys.has(key);
  const missIn = (sub: string, key: string): boolean => found.active && !subMiss(sub) && !found.keys.has(key);
  const headerText = $derived(lane.subs.length === 1 ? 'Its epic needs you' : 'Its epics need you');
</script>

{#if lane.header || (lane.idle && !focused)}
  <div class="row lane idle" class:has-sub={lane.subs.length > 0} class:miss={laneMiss} class:stale={lane.stale !== null} role="row" aria-label="{name}, {lane.header ? headerText : 'idle'}{lane.stale !== null ? `, ${lane.stale.text}` : ''}">
    <div class="gut" role="rowheader" data-project-menu={lane.project.id}>
      <button class="pn" type="button" title="Focus {name}" onclick={() => onfocus(lane.project.id)}><span class="dot {lane.header ? lane.dot : 'gray'}" aria-hidden="true"></span><span class="pname">{name}</span></button>
    </div>
    <div class="span" role="cell">
      <span>{lane.header ? headerText : lane.idleText}</span>
      {#if lane.stale !== null}<span class="asof">{lane.stale.text}</span>{/if}
      {#if lane.meta.settled > 0}
        <button class="settled-pill" type="button" aria-haspopup="dialog" onclick={() => onsettled(lane.project.id)}>Settled <b>{lane.meta.settled}</b></button>
      {/if}
      {#if lane.meta.queued > 0}
        <button class="settled-pill" type="button" aria-haspopup="dialog" onclick={() => onbacklog(lane.project.id)}>Queued <b>{lane.meta.queued}</b></button>
      {/if}
    </div>
  </div>
  {@render subRows()}
{:else}
  <div class="row lane" class:has-sub={lane.subs.length > 0} class:miss={laneMiss} class:stale={lane.stale !== null} role="row" data-rows={lane.rows}>
    <div class="gut" role="rowheader" data-project-menu={lane.project.id}>
      <button class="pn" type="button" title={focused ? name : `Focus ${name}`} onclick={() => onfocus(lane.project.id)}>
        <span class="dot {lane.dot}" aria-hidden="true"></span><span class="pname">{name}</span>
      </button>
      {#if lane.stale !== null}<span class="meta asof" title="its machine isn't reachable: the last data it sent">{lane.stale.text}</span>{/if}
      <span class="meta" title="active jobs · oldest claim">{lane.meta.active}</span>
      {#if lane.meta.trouble !== null || lane.meta.settled > 0 || lane.meta.queued > 0}
        <span class="meta">
          {#if lane.meta.trouble !== null}<span class="t-{lane.meta.trouble.tone}">{lane.meta.trouble.text}</span>{/if}
          {#if lane.meta.trouble !== null && lane.meta.settled > 0}<span aria-hidden="true"> · </span>{/if}
          {#if lane.meta.settled > 0}<button class="slink" type="button" aria-haspopup="dialog" onclick={() => onsettled(lane.project.id)}>{lane.meta.settled} settled</button>{/if}
          {#if lane.meta.queued > 0}{#if lane.meta.trouble !== null || lane.meta.settled > 0}<span aria-hidden="true"> · </span>{/if}<button class="slink" type="button" aria-haspopup="dialog" onclick={() => onbacklog(lane.project.id)}>{lane.meta.queued} queued</button>{/if}
        </span>
      {/if}
    </div>
    {#each lane.cells as cell (cell.column)}
      {@render cellOf(cell, miss)}
    {/each}
  </div>
  {@render subRows()}
{/if}

{#snippet cellOf(cell: Cell, dim: (key: string) => boolean)}
  <div class="cell c-{cell.column}" role="cell">
    {#each cell.tokens as t (t.key)}
      <div class="slot" in:receive={{ key: t.key }} out:send={{ key: t.key }}>
        <Token token={t} project={lane.project.id} miss={dim(t.key)} selected={selectedKey === t.key} fresh={fresh.has(t.key)} moved={moved.has(t.key)} {onopen} {onhover} />
      </div>
    {/each}
    {#if cell.more > 0}
      <button class="more" type="button" onclick={() => onfocus(lane.project.id)}>+{cell.more} more</button>
    {/if}
    {#each cell.ghosts as g (g.key)}
      <button class="ghost" class:miss={dim(g.key)} type="button" aria-haspopup="dialog" aria-label={g.label} onclick={() => onopen(g.key)}><span class="num">{g.num}</span>{g.text}</button>
    {/each}
    {#if cell.tokens.length === 0 && cell.more === 0 && cell.ghosts.length === 0}<span class="none" aria-hidden="true">—</span>{/if}
  </div>
{/snippet}

{#snippet subRows()}
  {#each lane.subs as sub, i (sub.key)}
    {#if sub.landed !== null}
    <div class="row lane sub landed" class:last={i === lane.subs.length - 1} class:miss={subMiss(sub.key)} class:stale={lane.stale !== null} role="row" aria-label="{sub.gutter.name}, an epic in {name}, {sub.landed}">
      <div class="gut egut" role="rowheader">
        {@render epicButton(sub)}
      </div>
      <div class="span" role="cell"><span class="ltext">{@render parts(sub.landed)}</span></div>
    </div>
    {:else}
    <div class="row lane sub" class:last={i === lane.subs.length - 1} class:hotgut={sub.hot} class:miss={subMiss(sub.key)} class:stale={lane.stale !== null} role="row" data-rows={sub.rows} aria-label="{sub.gutter.name}, an epic in {name}">
      <div class="gut egut" role="rowheader">
        {@render epicButton(sub)}
        <span class="meta wrap" title="members merged into the epic branch · running · since the epic started">{@render parts(sub.gutter.progress)}</span>
        {#if sub.gutter.waiting !== null}
          <span class="meta wrap">
            {#if sub.gutter.waiting.tone === null}{@render parts(sub.gutter.waiting.text)}{:else}<span class="t-{sub.gutter.waiting.tone}">{sub.gutter.waiting.text}</span>{/if}
          </span>
        {/if}
      </div>
      {#each sub.cells as cell (cell.column)}
        {@render cellOf(cell, (key) => missIn(sub.key, key))}
      {/each}
    </div>
    {/if}
  {/each}
{/snippet}

<!-- An epic's name in its sub-lane gutter: its dot, and it opens the epic page (and carries the epic menu's ids). -->
{#snippet epicButton(sub: SubLane)}
  <button class="en" class:sel={selectedEpic === sub.key} class:hit={found.epics.has(sub.key)} type="button" data-epic-menu={sub.slug} data-epic-menu-project={lane.project.id} aria-haspopup="dialog" title="Open epic {sub.gutter.name} · {sub.gutter.state}" onclick={() => onopenepic(sub.key)}>
    <span class="edot {sub.gutter.dot}" aria-hidden="true"></span><span class="ename">{sub.gutter.name}</span><span class="sr-only">, epic, {sub.gutter.state}</span>
  </button>
{/snippet}

<!-- A gutter line's " · "-separated parts, each kept whole when the line wraps. -->
{#snippet parts(text: string)}
  {#each text.split(' · ') as part, i (i)}{#if i > 0}{' · '}{/if}<span class="nw">{part}</span>{/each}
{/snippet}
