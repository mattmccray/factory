<script lang="ts">
  // The status bar (design §3, 28px): the state legend (a swatch per card edge, then the marks a
  // token can carry: the branch-merge icon of a member merged into its epic), the selection's settle
  // setting, and a live clock.
  import { LEGEND, MARK_LEGEND } from './sidebar';

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
    {#each MARK_LEGEND as l (l.key)}
      <li class="key" title="Merged into its epic's branch; lands with the epic">
        <span class="sw ie" aria-hidden="true"></span><span class="iem" aria-hidden="true"><svg class="i" viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="8" r="1.5" /><path d="M4.5 5v6M4.5 6c0 2 2 2 5.5 2" /></svg></span>{l.label}
      </li>
    {/each}
  </ul>
  <span class="rt"><span>{settle}</span><time datetime={iso}>{clock}</time></span>
</footer>
