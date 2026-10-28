<script lang="ts">
  // A sheet (design §8, §9): a modal panel that drops from under the toolbar, over a veil. It is a
  // native <dialog>, so it traps focus, closes on Escape before anything else does, and returns
  // focus to what opened it. A click on the veil closes it too.
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    labelledby: string;
    onclose: () => void;
    onopened?: () => void; // after it shows: e.g. focus its field
    children: Snippet;
  }
  let { open, labelledby, onclose, onopened, children }: Props = $props();

  let dialog = $state<HTMLDialogElement>();
  $effect(() => {
    if (dialog === undefined) return;
    if (open && !dialog.open) {
      dialog.showModal();
      onopened?.();
    }
    if (!open && dialog.open) dialog.close();
  });
</script>

<!-- A click on the veil closes the sheet; the keyboard path is Escape (native) or its Cancel / Done button. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="sheet" bind:this={dialog} aria-labelledby={labelledby} {onclose} onclick={(e) => e.target === dialog && onclose()}>
  {#if open}{@render children()}{/if}
</dialog>
