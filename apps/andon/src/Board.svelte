<script lang="ts">
  // The board: the capped andon (needs-human) row, then five station columns, each scrolling on
  // its own. The model comes from board.ts; this only lays it out.
  import type { BoardModel } from './board';
  import Card from './Card.svelte';

  interface Props {
    board: BoardModel;
    now: number;
    showProject: boolean;
    fresh: ReadonlySet<string>;
    moved: ReadonlySet<string>;
    onopen: (key: string) => void;
  }
  let { board, now, showProject, fresh, moved, onopen }: Props = $props();
</script>

{#if board.andon.length > 0}
  <section class="andon" aria-labelledby="andon-label">
    <h2 class="label" id="andon-label">Needs a human · /factory approve | rework</h2>
    <div class="row">
      {#each board.andon as item (item.key)}
        <Card {item} {now} {showProject} fresh={fresh.has(item.key)} moved={moved.has(item.key)} {onopen} />
      {/each}
    </div>
  </section>
{/if}
<section class="line" aria-label="The line">
  {#each board.columns as station, i (station.key)}
    <div class="station" class:live={station.jobs.length > 0 && station.key !== 'merged'}>
      <div class="station-head">
        <div class="num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
        <h2 class="name">{station.name}<span class="count">{#if station.jobs.length > 0}{station.jobs.length}<span class="sr-only"> jobs</span>{/if}</span></h2>
        <div class="who" title={station.who}>{station.who}</div>
        <span class="tick" aria-hidden="true"></span>
      </div>
      <ul class="stack" aria-label="{station.name} jobs">
        {#each station.jobs as item (item.key)}
          <li><Card {item} {now} {showProject} fresh={fresh.has(item.key)} moved={moved.has(item.key)} {onopen} /></li>
        {:else}
          <li class="empty">—</li>
        {/each}
      </ul>
    </div>
  {/each}
</section>
