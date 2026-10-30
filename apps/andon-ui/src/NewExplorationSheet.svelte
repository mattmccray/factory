<script lang="ts">
  // The New exploration sheet (brief t3-start-work), built like the Rework… sheet: an idea field, the
  // command it makes (updated as you type), and Copy and Cancel. Copy is disabled, and says why, for
  // a blank idea or a command over T3 Code's 8,000-character limit. Andon never runs the command
  // itself: Copy puts it on the clipboard and, in the Mac app, starts it in T3 Code as Settings say
  // (`onstart`, see startwork.ts), sending the idea, never the command; then it closes the sheet.
  import { newExploration, newExplorationStart } from './startwork';
  import type { StartItem } from './startwork';
  import Sheet from './Sheet.svelte';

  interface Props {
    project: { id: string; name: string } | null; // null: closed
    handsOff: boolean; // the Mac app: Copy also starts the exploration in T3 Code
    onstart: (item: StartItem) => void;
    onclose: () => void;
  }
  let { project, handsOff, onstart, onclose }: Props = $props();

  let idea = $state('');
  let field = $state<HTMLTextAreaElement>();
  // Each opening starts blank.
  $effect.pre(() => {
    if (project !== null) idea = '';
  });

  const cmd = $derived(newExploration(idea));
  const copy = (): void => {
    if (cmd.blocked !== null || project === null) return;
    onstart(newExplorationStart(project.id, idea));
    onclose();
  };
</script>

<Sheet open={project !== null} labelledby="explore-title" {onclose} onopened={() => field?.focus()}>
  <header>
    <h2 id="explore-title">New exploration{#if project !== null} <span class="mono">{project.name}</span>{/if}</h2>
    {#if handsOff}
      <p>Starts an interview that turns your idea into a brief. Andon copies the command and, as chosen in Settings, hands it to T3 Code. You can also run it in your <code>/factory</code> session.</p>
    {:else}
      <p>Starts an interview that turns your idea into a brief. Andon copies the command; run it in your <code>/factory</code> session.</p>
    {/if}
  </header>
  <div class="field">
    <label for="explore-text">Idea</label>
    <textarea id="explore-text" bind:this={field} bind:value={idea} placeholder="e.g. a tag cloud on the notes page" required aria-describedby="explore-line"></textarea>
    <div class="cmd" class:blank={cmd.blocked !== null}><code id="explore-line">{cmd.text}</code></div>
  </div>
  <footer>
    {#if cmd.blocked !== null}<span class="l">{cmd.blocked}</span>{/if}
    <button class="btn" type="button" onclick={onclose}>Cancel</button>
    <button class="btn primary" type="button" disabled={cmd.blocked !== null} onclick={copy}>{handsOff ? 'Copy and Hand Off' : 'Copy Command'}</button>
  </footer>
</Sheet>
