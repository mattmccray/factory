<script lang="ts">
  // The status bar (design §3, 28px): the state legend (a swatch per card edge), the selection's
  // settle setting, and a live clock.
  import { LEGEND } from './sidebar';

  interface Props {
    settle: string;
    now: number;
  }
  let { settle, now }: Props = $props();

  const clock = $derived(new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
  const iso = $derived(new Date(now).toISOString());
</script>

<footer class="statusbar">
  <ul class="legend" aria-label="Card edge colors">
    {#each LEGEND as l (l.key)}
      <li class="key"><span class="sw k-{l.key}" aria-hidden="true"></span>{l.label}</li>
    {/each}
  </ul>
  <span class="rt"><span>{settle}</span><time datetime={iso}>{clock}</time></span>
</footer>
