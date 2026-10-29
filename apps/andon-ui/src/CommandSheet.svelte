<script lang="ts">
  // The Rework… and Abandon… sheets (design §8), one component: a required note or reason, the
  // command it makes (updated as you type), and Copy and Cancel. Copy is disabled while the text
  // is blank, since the skill requires it. Andon never runs the command itself: Copy puts it on the
  // clipboard and, in the Mac app, hands it to T3 Code as Settings say (`onhandoff`, see handoff.ts),
  // sending the note, never the command; then it closes the sheet. An epic's Abandon… sheet builds
  // `/factory epic abandon <slug> "<reason>"` and only copies it: nothing is handed off for an epic.
  import type { HandoffRequest } from './handoff';
  import { abandonCommand, abandonEpicCommand, reworkCommand } from './inspector';
  import type { SheetKind } from './inspector';
  import Sheet from './Sheet.svelte';

  interface Props {
    kind: SheetKind | null; // null: closed
    id: string; // the job's id, or the epic's slug
    project: string; // the job's (or epic's) project id
    handsOff: boolean; // the Mac app: Copy also hands a job's command to T3 Code
    onhandoff: (req: HandoffRequest, command: string) => void;
    oncopy: (command: string) => void; // an epic's command: copy only
    onclose: () => void;
  }
  let { kind, id, project, handsOff, onhandoff, oncopy, onclose }: Props = $props();

  let text = $state('');
  let field = $state<HTMLTextAreaElement>();
  // Each opening starts blank.
  $effect.pre(() => {
    if (kind !== null) text = '';
  });

  const cmd = $derived(kind === 'abandon' ? abandonCommand(id, text) : kind === 'epic-abandon' ? abandonEpicCommand(id, text) : reworkCommand(id, text));
  const handing = $derived(handsOff && kind !== 'epic-abandon');
  const copy = (): void => {
    if (!cmd.copyable || kind === null) return;
    if (kind === 'epic-abandon') oncopy(cmd.text);
    else onhandoff({ project, job: id, action: kind, note: text }, cmd.text);
    onclose();
  };
  const COPY: Record<SheetKind, { title: string; what: string; label: string; hint: string }> = {
    rework: { title: 'Rework', what: 'Sends the job back to the builder with your note.', label: 'Note for the builder', hint: 'e.g. backfill before the drop' },
    abandon: { title: 'Abandon', what: 'Stops the job for good. The skill asks to confirm, and whether to keep its branch.', label: 'Reason (required)', hint: 'e.g. superseded by 045' },
    'epic-abandon': { title: 'Abandon epic', what: 'Closes the epic for good: nothing of it lands.', label: 'Reason (required)', hint: 'e.g. superseded by the billing epic' },
  };
  const words = $derived(COPY[kind ?? 'rework']);
</script>

<Sheet open={kind !== null} labelledby="cmd-title" {onclose} onopened={() => field?.focus()}>
  <header>
    <h2 id="cmd-title">{words.title} <span class="mono">{id}</span></h2>
    {#if handing}
      <p>{words.what} Andon copies the command and, as chosen in Settings, hands it to T3 Code. You can also run it in your <code>/factory</code> session.</p>
    {:else}
      <p>{words.what} Andon copies the command; run it in your <code>/factory</code> session.</p>
    {/if}
  </header>
  <div class="field">
    <label for="cmd-text">{words.label}</label>
    <textarea id="cmd-text" bind:this={field} bind:value={text} placeholder={words.hint} required aria-describedby="cmd-line"></textarea>
    <div class="cmd" class:blank={!cmd.copyable}><code id="cmd-line">{cmd.text}</code></div>
  </div>
  <footer>
    {#if !cmd.copyable}<span class="l">{kind === 'rework' ? 'A note is required.' : 'A reason is required.'}</span>{/if}
    <button class="btn" type="button" onclick={onclose}>Cancel</button>
    <button class="btn primary" class:danger={kind !== 'rework'} type="button" disabled={!cmd.copyable} onclick={copy}>{handing ? 'Copy and Hand Off' : 'Copy Command'}</button>
  </footer>
</Sheet>
