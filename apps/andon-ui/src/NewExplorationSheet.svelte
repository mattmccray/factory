<script lang="ts">
  // The New exploration sheet (brief t3-start-work), built like the Rework… sheet: an idea field, the
  // command it makes (updated as you type), and Copy and Cancel. Copy is disabled, and says why, for
  // a blank idea or a command over T3 Code's 8,000-character limit. Andon never runs the command
  // itself: Copy puts it on the clipboard and, in the Mac app, starts it in T3 Code as Settings say
  // (`onstart`, see startwork.ts), sending the idea, never the command; then it closes the sheet.
  // From the Mac app's File → New Exploration… under All Projects with several projects, a project
  // picker sits above the idea field (`picker`: the choices; `project`: where it starts), and the
  // exploration starts in the picked project.
  import { newExploration, newExplorationStart } from './startwork';
  import type { ExploreProject, StartItem } from './startwork';
  import Sheet from './Sheet.svelte';

  interface Props {
    project: { id: string; name: string } | null; // null: closed
    picker?: readonly ExploreProject[] | null; // the project picker's choices; null or absent: no picker
    handsOff: boolean; // the Mac app: Copy also starts the exploration in T3 Code
    onstart: (item: StartItem) => void;
    onclose: () => void;
  }
  let { project, picker = null, handsOff, onstart, onclose }: Props = $props();

  let idea = $state('');
  let chosen = $state(''); // the picked project's id (the picker's value)
  let field = $state<HTMLTextAreaElement>();
  // Each opening starts blank, on its project.
  $effect.pre(() => {
    if (project === null) return;
    idea = '';
    chosen = project.id;
  });

  // The project the exploration starts in: the picked one, when there is a picker.
  const target = $derived(picker === null || project === null ? project : (picker.find((p) => p.id === chosen) ?? project));
  const cmd = $derived(newExploration(idea));
  const copy = (): void => {
    if (cmd.blocked !== null || target === null) return;
    onstart(newExplorationStart(target.id, idea));
    onclose();
  };
</script>

<Sheet open={project !== null} labelledby="explore-title" {onclose} onopened={() => field?.focus()}>
  <header>
    <h2 id="explore-title">New exploration{#if target !== null && picker === null} <span class="mono">{target.name}</span>{/if}</h2>
    {#if handsOff}
      <p>Starts an interview that turns your idea into a brief. Andon copies the command and, as chosen in Settings, hands it to T3 Code. You can also run it in your <code>/factory</code> session.</p>
    {:else}
      <p>Starts an interview that turns your idea into a brief. Andon copies the command; run it in your <code>/factory</code> session.</p>
    {/if}
  </header>
  <div class="field">
    {#if picker !== null}
      <label for="explore-project">Project</label>
      <select id="explore-project" class="pick" bind:value={chosen}>
        {#each picker as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
    {/if}
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
