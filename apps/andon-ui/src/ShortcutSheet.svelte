<script lang="ts">
  // The shortcut sheet (design §10): `?` opens it, and it lists the keyboard map from keys.ts, and,
  // in the Mac app, the View menu's shortcuts (063).
  import { shortcutsFor } from './keys';
  import Sheet from './Sheet.svelte';

  interface Props {
    open: boolean;
    mac: boolean; // the Mac app: its View menu shortcuts are listed too
    onclose: () => void;
  }
  let { open, mac, onclose }: Props = $props();
  const rows = $derived(shortcutsFor(mac));
</script>

<Sheet {open} labelledby="keys-title" {onclose}>
  <header>
    <h2 id="keys-title">Keyboard Shortcuts</h2>
    <p>Single keys work when focus isn't in a text field.</p>
  </header>
  <dl class="keys">
    {#each rows as s (s.text)}
      <div>
        <dt>{#each s.keys as k, i (k)}{#if i > 0}<span class="then">{s.join ?? 'then'}</span>{/if}<kbd>{k}</kbd>{/each}</dt>
        <dd>{s.text}</dd>
      </div>
    {/each}
  </dl>
  <footer>
    <button class="btn primary" type="button" onclick={onclose}>Done</button>
  </footer>
</Sheet>
