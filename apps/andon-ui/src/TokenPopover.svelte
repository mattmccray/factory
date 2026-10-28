<script lang="ts">
  // The token hover popover (design §6), shown after 350ms of hover or focus: the title, project ·
  // id, stage, time in stage, round, each round's verdicts, and the note. It sits beside the
  // token, on the right unless that would leave the window. The model comes from `popoverOf`.
  import type { Popover } from './lanes';

  interface Props {
    model: Popover;
    anchor: { top: number; left: number; right: number };
    tone: 'red' | 'none';
  }
  let { model, anchor, tone }: Props = $props();

  const WIDTH = 268;
  const GAP = 10;
  let height = $state(0);
  const side = $derived(anchor.right + GAP + WIDTH > window.innerWidth - GAP ? 'left' : 'right');
  const left = $derived(side === 'right' ? anchor.right + GAP : Math.max(GAP, anchor.left - WIDTH - GAP));
  const top = $derived(Math.max(GAP, Math.min(anchor.top - 6, window.innerHeight - height - GAP)));
  const arrow = $derived(Math.min(Math.max(10, anchor.top + 10 - top), Math.max(10, height - 20)));
</script>

<div class="pop {side}" role="tooltip" id="token-popover" bind:offsetHeight={height} style:left="{left}px" style:top="{top}px">
  <span class="arrow" style:top="{arrow}px" aria-hidden="true"></span>
  <div class="pid">{model.where}</div>
  <div class="pt">{model.title}</div>
  <dl>
    <dt>Stage</dt><dd>{model.stage}</dd>
    {#if model.time !== null}<dt>{model.timeLabel}</dt><dd>{model.time}</dd>{/if}
    <dt>Round</dt><dd>{model.round}</dd>
    {#if model.rounds.length > 0}
      <dt>Reviews</dt>
      <dd>
        {#each model.rounds as r (r.round)}
          <div class="rr">
            <span class="rn">R{r.round}</span>
            {#each r.chips as c (c.key)}<span class="chip {c.verdict}" aria-hidden="true">{c.label}</span>{/each}
            <span class="sr-only">{r.chips.map((c) => `${c.key} ${c.verdict}`).join(', ')}</span>
          </div>
        {/each}
      </dd>
    {/if}
  </dl>
  {#if model.note !== null}<div class="pnote" class:red={tone === 'red'}>{model.note}</div>{/if}
  <div class="hint">Click to open</div>
</div>
