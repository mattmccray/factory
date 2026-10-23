<script lang="ts">
  // The job drawer: the job's timing summary under its title, its docs grouped by folder (read
  // from its own project's `/projects/<pid>/jobs/<id>/docs`), and a "timing" view. Docs are
  // re-read when the job's `updated` changes; a failed read keeps what is shown.
  import { untrack } from 'svelte';
  import { fetchDocs } from './api';
  import type { DocFile, Fetcher } from './api';
  import type { BoardJob } from './board';
  import { TIMING, groupsOf, pickFile } from './docs';
  import { markdown } from './markdown';
  import TimingView from './TimingView.svelte';
  import { summary, timingView } from './timing';

  interface Props {
    item: BoardJob | null; // null: closed
    now: number;
    showProject: boolean;
    fetcher: Fetcher;
    onclose: () => void;
  }
  let { item, now, showProject, fetcher, onclose }: Props = $props();

  // The last job shown stays rendered while the drawer slides out.
  let shown = $state<BoardJob | null>(null);
  $effect.pre(() => {
    if (item !== null) shown = item;
  });
  const open = $derived(item !== null);
  const key = $derived(item?.key ?? null);
  const updated = $derived(item?.job.updated ?? null);

  let files = $state<DocFile[]>([]);
  let chosen = $state<string | null>(null);
  let docPane = $state<HTMLDivElement>();
  let closeBtn = $state<HTMLButtonElement>();
  let loadedKey: string | null = null;

  $effect(() => {
    if (key === null) return;
    void updated; // re-read the docs when the job changes
    const target = untrack(() => item);
    if (target === null) return;
    if (key !== loadedKey) {
      loadedKey = key;
      files = [];
      chosen = null;
      if (docPane !== undefined) docPane.scrollTop = 0;
    }
    let live = true;
    fetchDocs(fetcher, target).then(
      (f) => {
        if (live) files = f;
      },
      () => {
        // the agent is unreachable or the job is gone: keep what is shown
      },
    );
    return () => {
      live = false;
    };
  });

  // Focus moves into the drawer on open and back to where it was on close.
  let returnTo: HTMLElement | null = null;
  $effect(() => {
    if (open) {
      untrack(() => {
        returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeBtn?.focus();
      });
    } else if (returnTo !== null) {
      if (returnTo.isConnected) returnTo.focus();
      returnTo = null;
    }
  });

  const job = $derived(shown?.job ?? null);
  const hasTiming = $derived(job !== null && job.timing !== null && job.startedAt !== null);
  const current = $derived(pickFile(chosen, files, hasTiming));
  const groups = $derived(groupsOf(files));
  const sum = $derived(job === null ? null : summary(job, now));
  const view = $derived(job !== null && current === TIMING ? timingView(job, now) : null);
  const html = $derived.by(() => {
    if (current === null || current === TIMING) return null;
    const f = files.find((x) => x.path === current);
    return f === undefined ? null : markdown(f.text);
  });
</script>

<div class="scrim" class:open onclick={onclose} aria-hidden="true"></div>
<div class="drawer" class:open aria-hidden={!open} inert={!open} role="dialog" aria-modal="true" aria-labelledby="drawer-title">
  <div class="dhead">
    <div>
      <div class="label">{#if showProject && shown !== null}{`${shown.project.name} · `}{/if}{job?.id ?? ''} · {job?.stage ?? ''}</div>
      <h2 id="drawer-title">{job?.title ?? ''}</h2>
      {#if sum !== null}<div class="dsum" class:na={!sum.recorded}>{sum.text}</div>{/if}
    </div>
    <button class="close" type="button" bind:this={closeBtn} onclick={onclose} aria-label="Close drawer">esc</button>
  </div>
  <nav class="files" aria-label="Job files">
    {#if files.length === 0 && !hasTiming}
      <div class="empty">no files yet</div>
    {/if}
    {#each groups as g (g.name)}
      {#if g.files.length > 0 || (g.name === 'Job' && hasTiming)}
        <h3 class="label">{g.name}</h3>
        <ul>
          {#if g.name === 'Job' && hasTiming}
            <li><button class="file" class:on={current === TIMING} aria-current={current === TIMING} type="button" onclick={() => (chosen = TIMING)}><span>timing</span></button></li>
          {/if}
          {#each g.files as f (f.path)}
            <li>
              <button class="file" class:on={current === f.path} aria-current={current === f.path} type="button" onclick={() => (chosen = f.path)}>
                <span>{f.label}</span>
                {#if f.verdict !== null}<span class="v {f.verdict}" title={f.verdict}></span><span class="sr-only">{f.verdict}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
  </nav>
  <div class="doc" bind:this={docPane}>
    <div class="md">
      {#if view !== null}
        <TimingView {view} />
      {:else if html !== null}
        {@html html}
      {:else}
        <p class="empty">Nothing written yet.</p>
      {/if}
    </div>
  </div>
</div>
