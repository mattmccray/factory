<script lang="ts">
  // The inspector's "timing" view: claim and merge times, a stage bar with its legend, a stage
  // table, and an agent table. The numbers come from timing.ts and tick with `now`.
  import type { TimingView } from './timing';

  let { view }: { view: TimingView } = $props();
</script>

<h1>Timing</h1>
<p>{view.line}</p>
{#if view.bar.length > 0}
  <div class="tbar" role="img" aria-label="Time per stage: {view.bar.map((s) => s.title).join(', ')}">
    {#each view.bar as seg, i (i)}<span class="seg {seg.stage}" style:flex-grow={seg.grow} title={seg.title}></span>{/each}
  </div>
  <div class="tlegend" aria-hidden="true">
    {#each view.legend as l (l.stage)}<span><i class="seg {l.stage}"></i>{l.label}</span>{/each}
  </div>
{/if}
<h2>Stages</h2>
{#if view.stages.length > 0}
  <table class="tt">
    <thead><tr><th>Stage</th><th>Round</th><th>Entered</th><th class="n">Duration</th></tr></thead>
    <tbody>
      {#each view.stages as s, i (i)}
        <tr><td>{s.stage}</td><td>{s.round}</td><td>{s.entered}</td><td class="n">{s.duration}</td></tr>
      {/each}
    </tbody>
  </table>
{:else}
  <p class="empty">No stages yet.</p>
{/if}
<h2>Agents</h2>
{#if view.agents.length > 0}
  <table class="tt">
    <thead><tr><th>Agent</th><th>Round</th><th>Result</th><th>Started</th><th class="n">Duration</th></tr></thead>
    <tbody>
      {#each view.agents as a, i (i)}
        <tr>
          <td>{a.who}</td>
          <td>{a.round}</td>
          <td class:na={a.muted}>{#if a.verdict !== null}<span class="v {a.verdict}" aria-hidden="true"></span>{/if}{a.result}</td>
          <td>{a.started}</td>
          <td class="n">{a.duration}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else}
  <p class="empty">No agents have run yet.</p>
{/if}
