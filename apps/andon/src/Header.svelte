<script lang="ts">
  // The fixed header: the tally, the project switcher (every registered project with its
  // needs-human count, plus All projects), the Settled button, and the agent's status.
  import type { ProjectInfo } from './job';
  import type { Status } from './live';
  import { ALL } from './projects';
  import type { Selection } from './projects';

  interface Props {
    projects: ProjectInfo[];
    counts: { byProject: Record<string, number>; total: number };
    selection: Selection;
    running: number;
    waiting: number;
    shown: number;
    settled: number;
    status: Status;
    statusText: string;
    onselect: (sel: Selection) => void;
    onsettled: () => void;
  }
  let { projects, counts, selection, running, waiting, shown, settled, status, statusText, onselect, onsettled }: Props = $props();

  // Announced to screen readers only when the connection changes, not on every tick of statusText.
  const STATUS: Record<Status, string> = { connecting: 'Connecting to the Andon agent', live: 'Connected to the Andon agent', down: 'The Andon agent is unreachable' };
  const waitingText = (n: number): string => (n > 0 ? ` · ${n} waiting` : '');
  const elsewhere = $derived(selection === ALL ? 0 : counts.total - (counts.byProject[selection] ?? 0));
  const scope = $derived(selection === ALL ? 'All projects' : (projects.find((p) => p.id === selection)?.name ?? 'All projects'));
</script>

<header>
  <div>
    <div class="label">/factory · andon</div>
    <h1>{scope} <em>{#if shown > 0}— {running} running{#if waiting > 0}, {waiting} waiting on you{/if}{/if}</em></h1>
  </div>
  <div class="hright">
    {#if projects.length > 0}
      <label class="switch">
        <span class="label">Project</span>
        <select value={selection} onchange={(e) => onselect(e.currentTarget.value)}>
          <option value={ALL}>All projects{waitingText(counts.total)}</option>
          {#each projects as p (p.id)}
            <option value={p.id} title={p.root}>{p.name}{waitingText(counts.byProject[p.id] ?? 0)}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if elsewhere > 0}
      <button class="elsewhere" type="button" onclick={() => onselect(ALL)}>{elsewhere} waiting elsewhere</button>
    {/if}
    {#if settled > 0}
      <button class="settled-btn" type="button" aria-haspopup="dialog" onclick={onsettled}>Settled · {settled}</button>
    {/if}
    <div class="status">
      <span class="dot" class:down={status === 'down'} class:connecting={status === 'connecting'} aria-hidden="true"></span><span>{statusText}</span>
      <span class="sr-only" role="status">{STATUS[status]}</span>
    </div>
  </div>
</header>
