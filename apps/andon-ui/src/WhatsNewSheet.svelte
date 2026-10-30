<script lang="ts">
  // The What's New sheet (brief andon-version-ui, decisions 1, 2, and 4): the factory changelog the
  // service reports, newest first, each release's entries under Breaking, Added, and Fixed. The
  // footer's version and Help → What's New (the Mac app) open it whole; a behind project's glyph opens
  // it scoped to the releases that project is missing, with "Show all releases" and a copy button for
  // the upgrade command. Andon only copies the command (decision 10): it never runs it. The model
  // comes from release.ts `whatsNew`; this only lays it out.
  import type { WhatsNewModel } from './release';
  import Sheet from './Sheet.svelte';

  interface Props {
    model: WhatsNewModel;
    open: boolean;
    onshowall: () => void; // the scoped sheet's "Show all releases": the whole sheet
    oncopy: (command: string) => void; // copies and toasts (App.svelte `copy`)
    onclose: () => void;
  }
  let { model, open, onshowall, oncopy, onclose }: Props = $props();
</script>

<Sheet {open} labelledby="whatsnew-title" {onclose}>
  <header>
    <h2 id="whatsnew-title">{model.title}</h2>
    {#if model.scope !== null}
      <p>{model.scope.note} <button class="linkbtn" type="button" onclick={onshowall}>Show all releases</button></p>
    {/if}
  </header>
  {#if model.scope !== null && model.scope.command !== null}
    {@const command = model.scope.command}
    <div class="field">
      <span class="lbl" id="upgrade-what">Upgrade {model.scope.name}, then check it. Andon copies the command; run it in a terminal.</span>
      <div class="cmd">
        <code id="upgrade-line">{command}</code>
        <button class="btn" type="button" aria-describedby="upgrade-what upgrade-line" onclick={() => oncopy(command)}>Copy Command</button>
      </div>
    </div>
  {/if}
  <div class="wn">
    {#each model.releases as r, ri (ri)}
      <section class="wnr" aria-labelledby="wn-{ri}">
        <h3 id="wn-{ri}"><span class="mono">v{r.version}</span>{#if r.date !== ''}<span class="date">{r.date}</span>{/if}</h3>
        {#each r.sections as sec (sec.key)}
          <h4 class="sec-{sec.key}">{sec.title}</h4>
          <ul>
            {#each sec.entries as e, i (i)}
              <li>
                {#if e.area !== null}<span class="area">{e.area}</span>{/if}
                <span class="tx">{e.text}</span>
                {#if e.job !== null}<span class="jid mono">{e.job}</span>{/if}
              </li>
            {/each}
          </ul>
        {/each}
      </section>
    {:else}
      {#if model.empty !== null}<p class="empty">{model.empty}</p>{/if}
    {/each}
  </div>
  <footer>
    <button class="btn primary" type="button" onclick={onclose}>Done</button>
  </footer>
</Sheet>
