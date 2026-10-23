<script lang="ts">
  // The Settled dialog: merged jobs older than their project's settleAfterHours, newest merge
  // first. Settled is only a view; opening a row shows the job (and its timing) in the drawer.
  import { mergedAt } from './board';
  import type { BoardJob } from './board';
  import { fmt, time, when } from './time';

  interface Props {
    settled: BoardJob[];
    showProject: boolean;
    open: boolean;
    onclose: () => void;
    onopen: (key: string) => void;
  }
  let { settled, showProject, open, onclose, onopen }: Props = $props();

  let dialog = $state<HTMLDialogElement>();
  const hours = $derived([...new Set(settled.map((b) => b.settleAfterHours))].sort((a, b) => a - b).map((h) => `${h}h`).join(' / '));

  $effect(() => {
    if (dialog === undefined) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  const total = (b: BoardJob): string => (b.job.startedAt !== null && b.job.endedAt !== null ? fmt(time(b.job.endedAt) - time(b.job.startedAt)) : '—');
  const rounds = (n: number): string => (n > 0 ? `${n} round${n > 1 ? 's' : ''}` : '—');
</script>

<!-- A click on the backdrop closes the dialog; the keyboard path is Escape (native) or the esc button. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} aria-labelledby="settled-title" onclose={onclose} onclick={(e) => e.target === dialog && onclose()}>
  <div class="dlg-head">
    <div><div class="label">Merged more than {hours} ago</div><h2 id="settled-title">Settled</h2></div>
    <button class="close" type="button" onclick={onclose} aria-label="Close Settled">esc</button>
  </div>
  <ul class="dlg-list">
    {#each settled as b (b.key)}
      <li>
        <button class="srow" type="button" onclick={() => onopen(b.key)}>
          <span class="st">{b.job.title}</span>
          <span class="sm">{when(mergedAt(b.job))}</span>
          <span class="si">{#if showProject}<span class="proj">{b.project.name}</span>{/if}{b.job.id}</span>
          <span class="sm">total {total(b)} · {rounds(b.job.round)}</span>
        </button>
      </li>
    {/each}
  </ul>
</dialog>
