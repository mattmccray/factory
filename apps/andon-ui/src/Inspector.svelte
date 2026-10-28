<script lang="ts">
  // The inspector (design §8): a push panel at the window's right, resizable from its left edge.
  // Top to bottom: the bar (project / id, close), the header (project · id, a stage pill, the
  // title, branch → target, the timing summary), the needs-human box with its copy-only commands,
  // the Files list, and the selected document or the timing view. Docs are re-read when the job's
  // `updated` changes; a failed read keeps what is shown. ↑ and ↓ move between files while focus
  // is in the inspector. The chosen file is the caller's (`file`, from the URL), reported by `onfile`. Andon never runs a command; the buttons only copy it.
  import { tick, untrack } from 'svelte';
  import { fetchDocs } from './api';
  import type { DocFile, Fetcher } from './api';
  import type { BoardJob } from './board';
  import { TIMING } from './docs';
  import { INSPECTOR_MAX, INSPECTOR_MIN, approveCommand, clampWidth, fileModel, stepFile } from './inspector';
  import type { SheetKind } from './inspector';
  import { landing } from './job';
  import { KIND_LABELS, kindOf } from './lanes';
  import { markdown } from './markdown';
  import TimingView from './TimingView.svelte';
  import { summary, timingView } from './timing';

  interface Props {
    item: BoardJob | null; // the open job; null: "Nothing selected"
    open: boolean;
    width: number;
    now: number;
    fetcher: Fetcher;
    file: string | null; // the chosen file; null: the latest
    onfile: (path: string) => void;
    onclose: () => void;
    onresize: (width: number) => void;
    oncopy: (command: string) => void;
    onsheet: (kind: SheetKind) => void;
  }
  let { item, open, width, now, fetcher, file, onfile, onclose, onresize, oncopy, onsheet }: Props = $props();

  const key = $derived(item?.key ?? null);
  const updated = $derived(item?.job.updated ?? null);

  let files = $state<DocFile[]>([]);
  let aside = $state<HTMLElement>();
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
      if (docPane !== undefined) docPane.scrollTop = 0;
    }
    let live = true;
    fetchDocs(fetcher, target).then(
      (f) => {
        if (live) files = f;
      },
      () => {
        // the service is unreachable or the job is gone: keep what is shown
      },
    );
    return () => {
      live = false;
    };
  });

  // Opening a job moves focus into the inspector (so ↑ and ↓ work at once); closing it returns
  // focus to where it was.
  let returnTo: HTMLElement | null = null;
  $effect(() => {
    const k = key;
    const shown = open;
    untrack(() => {
      if (shown && k !== null) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && aside !== undefined && !aside.contains(active)) returnTo = active;
        void tick().then(() => closeBtn?.focus());
      } else if (!shown && returnTo !== null) {
        if (returnTo.isConnected) returnTo.focus();
        returnTo = null;
      }
    });
  });

  const job = $derived(item?.job ?? null);
  const kind = $derived(item === null ? null : kindOf(item, now));
  const hasTiming = $derived(job !== null && job.timing !== null && job.startedAt !== null);
  const model = $derived(fileModel(files, hasTiming, file));
  const current = $derived(model.selected);
  const sum = $derived(job === null ? null : summary(job, now));
  const lands = $derived(job === null ? null : landing(job));
  const view = $derived(job !== null && current === TIMING ? timingView(job, now) : null);
  const html = $derived.by(() => {
    if (current === null || current === TIMING) return null;
    const f = files.find((x) => x.path === current);
    return f === undefined ? null : markdown(f.text);
  });
  const human = $derived(job !== null && job.stage === 'needs-human');
  const approve = $derived(job === null ? '' : approveCommand(job.id));

  async function choose(path: string | null, focus: boolean): Promise<void> {
    if (path === null) return;
    onfile(path);
    if (docPane !== undefined) docPane.scrollTop = 0;
    if (!focus) return;
    await tick();
    const row = aside?.querySelector<HTMLButtonElement>('.file.on');
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }

  // ↑ and ↓ move between files while focus is in the inspector (not in a field or the grip).
  function onkeydown(e: KeyboardEvent): void {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (!open || item === null || aside === undefined) return;
    const at = document.activeElement;
    if (!(at instanceof HTMLElement) || !aside.contains(at) || at.matches('input, textarea, select, [role="separator"]')) return;
    e.preventDefault();
    void choose(stepFile(model.order, current, e.key === 'ArrowDown' ? 1 : -1), true);
  }

  // The grip on the left edge: drag it, or focus it and use ← and →.
  let dragging = $state(false);
  let start = { x: 0, w: 0 };
  function grab(e: PointerEvent): void {
    if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start = { x: e.clientX, w: width };
    dragging = true;
  }
  function drag(e: PointerEvent): void {
    if (dragging) onresize(clampWidth(start.w + start.x - e.clientX));
  }
  function drop(): void {
    dragging = false;
  }
  function nudge(e: KeyboardEvent): void {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') onresize(clampWidth(width + step));
    else if (e.key === 'ArrowRight') onresize(clampWidth(width - step));
    else if (e.key === 'Home') onresize(INSPECTOR_MAX);
    else if (e.key === 'End') onresize(INSPECTOR_MIN);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window {onkeydown} />

<aside class="inspector" class:open class:dragging id="inspector" aria-label="Inspector" inert={!open} bind:this={aside} style:--insw="{width}px">
  <!-- A focusable separator with a value is the ARIA window-splitter pattern (an interactive widget); Svelte's lint treats every separator as static. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="grip"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the inspector"
    aria-valuemin={INSPECTOR_MIN}
    aria-valuemax={INSPECTOR_MAX}
    aria-valuenow={width}
    tabindex="0"
    onpointerdown={grab}
    onpointermove={drag}
    onpointerup={drop}
    onpointercancel={drop}
    onkeydown={nudge}
  ></div>
  <div class="ins-body">
    {#if item === null || job === null}
      <div class="ins-bar"><span class="lbl">Inspector</span><button class="xbtn" type="button" onclick={onclose} aria-label="Close the inspector" title="Close (esc)"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button></div>
      <div class="nosel">Nothing selected<small>Click a job to see its files and timing.</small></div>
    {:else}
      <div class="ins-bar">
        <span class="lbl">{item.project.name} / {job.id}</span>
        <button class="xbtn" type="button" bind:this={closeBtn} onclick={onclose} aria-label="Close the inspector" title="Close (esc)"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button>
      </div>
      <div class="ins-head">
        <div class="crumbs"><span>{item.project.name}</span><span aria-hidden="true">·</span><span>{job.id}</span>{#if kind !== null}<span class="stage-pill sp-{kind}">{KIND_LABELS[kind]}</span>{/if}</div>
        <h2 id="ins-title">{job.title}</h2>
        {#if lands !== null}<div class="branch" title="branch → target">{lands}</div>{/if}
        {#if sum !== null}<div class="tsum" class:na={!sum.recorded}>{sum.text}</div>{/if}
      </div>
      {#if human}
        <section class="callout" aria-label="Needs a human">
          <div class="why">
            <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2.5M4 3h7.5l-1.5 3 1.5 3H4" /></svg>
            <span>{job.note || 'No note recorded.'}</span>
          </div>
          <div class="acts">
            <button class="btn primary" type="button" onclick={() => oncopy(approve)}>Approve</button>
            <button class="btn" type="button" aria-haspopup="dialog" onclick={() => onsheet('rework')}>Rework…</button>
            <button class="btn destructive" type="button" aria-haspopup="dialog" onclick={() => onsheet('abandon')}>Abandon…</button>
          </div>
          <div class="cmd">
            <code>{approve}</code>
            <button class="copy" type="button" onclick={() => oncopy(approve)} aria-label="Copy {approve}" title="Copy">
              <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
            </button>
          </div>
        </section>
      {:else if job.stage === 'abandoned'}
        <section class="callout gray" aria-label="Abandoned"><div class="why"><span>Abandoned: {job.note || 'no reason recorded.'}</span></div></section>
      {/if}
      <nav class="files" aria-label="Job files">
        {#if model.groups.length === 0}<div class="empty">No files yet.</div>{/if}
        {#each model.groups as g (g.name)}
          <h3><span>{g.name}</span>{#if g.current}<span>current</span>{/if}</h3>
          <ul>
            {#each g.rows as f (f.path)}
              <li>
                <button class="file" class:on={current === f.path} aria-current={current === f.path} type="button" onclick={() => choose(f.path, false)}>
                  {#if f.path === TIMING}
                    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>
                  {:else}
                    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></svg>
                  {/if}
                  <span class="fl">{f.label}</span>
                  {#if f.verdict !== null}<span class="vd {f.tone ?? ''}" title={f.verdict}></span><span class="sr-only">{f.verdict}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/each}
      </nav>
      <div class="doc" bind:this={docPane}>
        <div class="md">
          {#if view !== null}
            <div class="timing"><TimingView {view} /></div>
          {:else if html !== null}
            {@html html}
          {:else}
            <p class="empty">Nothing written yet.</p>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</aside>
