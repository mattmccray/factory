<script lang="ts">
  // The inspector (design §8): a push panel at the window's right, resizable from its left edge.
  // Top to bottom: the bar (project / id, close), the header (project · id, a stage pill, the
  // title, branch → target, the timing summary), the needs-human box with its commands,
  // the Files list, and the selected document or the timing view. Docs are re-read when the job's
  // `updated` changes; a failed read keeps what is shown. ↑ and ↓ move between files while focus
  // is in the inspector. The chosen file is the caller's (`file`, from the URL), reported by `onfile`. Andon never runs a command itself: Approve copies it and, in the Mac app,
  // hands it to T3 Code as Settings say (`onhandoff`, see handoff.ts); the copy icon only copies.
  // A job in an epic links back to its epic. The epic page (docs/design/epics/design.md decision 9;
  // `epic` instead of `item`) shows its state pill, `factory/epic/<slug> → <target>`, timing, a
  // progress bar by member state, the Members in plan order and the Generated sync and fix jobs
  // (each linking to its job), the red box with `/factory epic <slug>` to copy when it waits on you,
  // an Abandon… sheet, and the plan and member briefs as documents (the epic docs endpoint).
  // A brief's or plan's page (brief andon-backlog-ui; `page` instead of `item` and `epic`) shows its
  // text from `GET …/briefs/<slug>` or `GET …/plans/<slug>`, rendered as job files are; a plan's
  // page lists its `## Members` with each member brief's `- Status:` (a member row opens its brief).
  // Its action (brief t3-start-work) is the one its item has in the project's live backlog, read when
  // the page opens: Run, Start epic, or Continue exploring; none when the item is in neither group.
  // It copies the command and, in the Mac app, starts it in T3 Code as Settings say (`onstart`).
  // In the job view a grip between the Files list and the document sets the list's height
  // (`filesHeight`, reported by `onfilesresize`; brief andon-resizable-panes): drag it, or focus it
  // and use ↑ and ↓; double-click returns the list to fitting its files. Limits are in panes.ts.
  import { tick, untrack } from 'svelte';
  import { fetchBacklog, fetchBrief, fetchDocs, fetchEpicDocs, fetchPage } from './api';
  import { docKey, docPage, planMembers, toBacklog } from './backlog';
  import type { Backlog, DocRef, DocText } from './backlog';
  import { pageStart } from './startwork';
  import type { StartItem } from './startwork';
  import type { DocFile, Fetcher } from './api';
  import { isEpicTerminal } from './board';
  import type { BoardEpic, BoardJob } from './board';
  import type { HandoffRequest } from './handoff';
  import { TIMING } from './docs';
  import { INSPECTOR_MAX, INSPECTOR_MIN, approveCommand, clampWidth, epicFileModel, epicLinkOf, epicPage, fileModel, jobHeader, stepFile } from './inspector';
  import type { SheetKind } from './inspector';
  import { landing } from './job';
  import { FILES_FIT, clampFiles, filesKey, filesShown, paneStep } from './panes';
  import { KIND_LABELS, kindOf } from './lanes';
  import { markdown } from './markdown';
  import TimingView from './TimingView.svelte';
  import { summary, timingView } from './timing';

  interface Props {
    item: BoardJob | null; // the open job; null: an epic, or "Nothing selected"
    epic: BoardEpic | null; // the open epic (when `item` is null)
    epicJobs: BoardJob[]; // the open epic's jobs, for its Members and Generated rows
    page: DocRef | null; // a brief's or plan's page (when `item` and `epic` are null)
    pageProject: string; // its project's name
    open: boolean;
    width: number;
    filesHeight: number | null; // the job view's Files list height; null: it fits its files (up to 38%)
    now: number;
    fetcher: Fetcher;
    file: string | null; // the chosen file; null: the latest
    onfile: (path: string) => void;
    onclose: () => void;
    onresize: (width: number) => void;
    onfilesresize: (height: number | null) => void; // null: back to fitting its files
    oncopy: (command: string) => void; // the copy icon: copy only
    onhandoff: (req: HandoffRequest, command: string) => void; // Approve: copy, then hand off
    onsheet: (kind: SheetKind) => void;
    onopenjob: (key: string) => void; // a member's job link
    onopenepic: (key: string) => void; // a job's link to its epic
    onopenpage: (ref: DocRef) => void; // a plan member's brief
    onstart: (item: StartItem) => void; // a brief's or plan's action: copy, then start in T3 Code
  }
  let { item, epic, epicJobs, page: docRef, pageProject, onopenpage, onstart, open, width, filesHeight, now, fetcher, file, onfile, onclose, onresize, onfilesresize, oncopy, onhandoff, onsheet, onopenjob, onopenepic }: Props = $props();

  const key = $derived(item !== null ? item.key : epic !== null ? `epic:${epic.key}` : docRef !== null ? docKey(docRef) : null);
  const updated = $derived(item !== null ? item.job.updated : (epic?.epic.updated ?? null));

  let files = $state<DocFile[]>([]);
  let aside = $state<HTMLElement>();
  let docPane = $state<HTMLDivElement | null>(null); // bind:this sets null when its element unmounts
  let closeBtn = $state<HTMLButtonElement>();
  let loadedKey: string | null = null;

  $effect(() => {
    if (key === null) return;
    void updated; // re-read the docs when the job or epic changes
    const job = untrack(() => item);
    const ep = untrack(() => epic);
    if (job === null && ep === null) return;
    if (key !== loadedKey) {
      loadedKey = key;
      files = [];
      if (docPane instanceof HTMLElement) docPane.scrollTop = 0;
    }
    let live = true;
    const read = job !== null ? fetchDocs(fetcher, job) : ep !== null ? fetchEpicDocs(fetcher, ep.project.id, ep.epic.slug) : Promise.resolve([]);
    read.then(
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

  // A brief's or plan's page: its text, then (a plan) each member's brief, read once per page opened.
  let docText = $state.raw<DocText | null>(null);
  let memberBriefs = $state.raw<ReadonlyMap<string, DocText>>(new Map());
  let pageBacklog = $state.raw<Backlog | null>(null);
  $effect(() => {
    const ref = docRef;
    docText = null;
    memberBriefs = new Map();
    pageBacklog = null;
    if (ref === null) return;
    let live = true;
    void fetchBacklog(fetcher, ref.project).then((b) => {
      if (live && b.ok) pageBacklog = toBacklog(b.data);
    });
    void fetchPage(fetcher, ref).then((d) => {
      if (!live) return;
      docText = d;
      if (ref.kind !== 'plan' || d.state !== 'ok') return;
      for (const slug of planMembers(d.text)) {
        void fetchBrief(fetcher, ref.project, slug).then((b) => {
          if (live) memberBriefs = new Map([...memberBriefs, [slug, b]]);
        });
      }
    });
    return () => {
      live = false;
    };
  });
  const doc = $derived(item === null && epic === null && docRef !== null ? docPage(docRef, pageProject, docText, memberBriefs) : null);
  const docStart = $derived(doc === null ? null : pageStart(doc.ref, pageBacklog));

  // Opening a job or an epic moves focus into the inspector (so ↑ and ↓ work at once); closing it
  // returns focus to where it was.
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
  const page = $derived(item === null && epic !== null ? epicPage(epic, epicJobs, now) : null);
  const model = $derived(page !== null ? epicFileModel(files, file) : fileModel(files, hasTiming, file));
  const current = $derived(model.selected);
  const sum = $derived(job === null ? null : summary(job, now));
  const lands = $derived(job === null ? null : landing(job));
  const link = $derived(item === null ? null : epicLinkOf(item));
  const view = $derived(job !== null && current === TIMING ? timingView(job, now) : null);
  const html = $derived.by(() => {
    if (current === null || current === TIMING) return null;
    const f = files.find((x) => x.path === current);
    return f === undefined ? null : markdown(f.text);
  });
  const human = $derived(job !== null && job.stage === 'needs-human');
  const approve = $derived(job === null ? '' : approveCommand(job.id));
  const abandonable = $derived(epic !== null && !isEpicTerminal(epic.epic));

  async function choose(path: string | null, focus: boolean): Promise<void> {
    if (path === null) return;
    onfile(path);
    if (docPane instanceof HTMLElement && page === null) docPane.scrollTop = 0;
    if (!focus) return;
    await tick();
    const row = aside?.querySelector<HTMLButtonElement>('.file.on');
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }

  // ↑ and ↓ move between files while focus is in the inspector (not in a field or the grip).
  function onkeydown(e: KeyboardEvent): void {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (!open || key === null || aside === undefined) return;
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
    const step = paneStep(e.shiftKey);
    if (e.key === 'ArrowLeft') onresize(clampWidth(width + step));
    else if (e.key === 'ArrowRight') onresize(clampWidth(width - step));
    else if (e.key === 'Home') onresize(INSPECTOR_MAX);
    else if (e.key === 'End') onresize(INSPECTOR_MIN);
    else return;
    e.preventDefault();
  }

  // The grip between the Files list and the document (the job view only). `room` is the height
  // the two share; the list's height is clamped against it, so a kept height that no longer fits
  // is shown smaller and kept as is.
  let filesEl = $state<HTMLElement | null>(null); // bind:this sets null when the job view unmounts
  let room = $state(0);
  let filesPx = $state(0); // the list's height as rendered
  const measure = (): number => (filesEl instanceof HTMLElement && docPane instanceof HTMLElement ? filesEl.offsetHeight + docPane.offsetHeight : 0);
  $effect(() => {
    const f = filesEl;
    const d = docPane;
    if (!(f instanceof HTMLElement) || !(d instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      room = measure();
      filesPx = f.offsetHeight;
    });
    ro.observe(f);
    ro.observe(d);
    return () => ro.disconnect();
  });
  const filesShownPx = $derived(filesShown(filesHeight, room));
  let fdragging = $state(false);
  let fstart = { y: 0, h: 0, room: 0 };
  function fgrab(e: PointerEvent): void {
    if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement) || !(filesEl instanceof HTMLElement)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    fstart = { y: e.clientY, h: filesEl.offsetHeight, room: measure() };
    fdragging = true;
  }
  function fdrag(e: PointerEvent): void {
    if (fdragging) onfilesresize(clampFiles(fstart.h + e.clientY - fstart.y, fstart.room));
  }
  function fdrop(): void {
    fdragging = false;
  }
  function fnudge(e: KeyboardEvent): void {
    if (!(filesEl instanceof HTMLElement)) return;
    const next = filesKey(filesEl.offsetHeight, e.key, e.shiftKey, measure());
    if (next === null) return;
    e.preventDefault();
    onfilesresize(next);
  }
</script>

<svelte:window {onkeydown} />

<aside class="inspector" class:open class:dragging class:fdragging id="inspector" aria-label="Inspector" inert={!open} bind:this={aside} style:--insw="{width}px">
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
    {#if page !== null && epic !== null}
      <div class="ins-bar">
        <span class="lbl">{page.project} / epic / {page.slug}</span>
        <button class="xbtn" type="button" bind:this={closeBtn} onclick={onclose} aria-label="Close the inspector" title="Close (esc)"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button>
      </div>
      <div class="ins-scroll" bind:this={docPane}>
        <div class="ins-head">
          <div class="crumbs"><span>{page.project}</span><span aria-hidden="true">·</span><span class="stage-pill sp-epic">Epic</span><span class="stage-pill sp-e-{page.state}">{page.stateLabel}</span></div>
          <h2 id="ins-title">{page.name}</h2>
          <div class="branch" title="epic branch → target">{page.lands}</div>
          <div class="tsum">{page.timing} · {page.merged}</div>
          <div class="eprog" role="img" aria-label="Members by state: {page.progress.map((s) => s.title).join(', ')}">
            {#each page.progress as seg, i (i)}<i class={seg.cls} title={seg.title}></i>{/each}
          </div>
          {#if page.planError !== null}<div class="tsum na">Plan: {page.planError}</div>{/if}
          {#if abandonable && page.waiting === null}
            <div class="acts eacts"><button class="btn destructive" type="button" aria-haspopup="dialog" onclick={() => onsheet('epic-abandon')}>Abandon…</button></div>
          {/if}
        </div>
        {#if page.waiting !== null}
          <section class="callout" aria-label="Waiting on you">
            <div class="why">
              <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2.5M4 3h7.5l-1.5 3 1.5 3H4" /></svg>
              <span><b>Waiting on you:</b> {page.waiting.note || 'no reason recorded.'}</span>
            </div>
            <div class="sub">Fix what it waits on, then resume the epic in its session.</div>
            <div class="acts">
              <button class="btn primary" type="button" onclick={() => oncopy(page.waiting?.command ?? '')}>Copy Resume</button>
              <button class="btn destructive" type="button" aria-haspopup="dialog" onclick={() => onsheet('epic-abandon')}>Abandon…</button>
            </div>
            <div class="cmd">
              <code>{page.waiting.command}</code>
              <button class="copy" type="button" onclick={() => oncopy(page.waiting?.command ?? '')} aria-label="Copy {page.waiting.command}" title="Copy">
                <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
              </button>
            </div>
          </section>
        {:else if page.abandoned !== null}
          <section class="callout gray" aria-label="Abandoned"><div class="why"><span>Abandoned: {page.abandoned || 'no reason recorded.'}</span></div></section>
        {/if}
        <section class="members" aria-label="Members">
          <h3><span>Members</span><span>plan order</span></h3>
          <ul>
            {#each page.members as m (m.slug)}
              <li class="mem">
                <span class="mi">{m.n}</span>
                <span class="mt" title={m.title}>{m.title}</span>
                <span class="mr"><span class="mst {m.tone}">{#if m.tone === 'running'}<i class="mk-{m.kind ?? 'build'}" aria-hidden="true"></i>{/if}{m.text}</span></span>
                <span></span>
                <span class="ms"><b>{m.slug}</b> · {m.after}</span>
                <span class="mr">
                  {#if m.job !== null}
                    <button class="jid" type="button" title="Open {m.job.id}" onclick={() => onopenjob(m.job?.key ?? '')}>job <b>{m.job.num}</b></button>
                  {:else}
                    <span class="jid none">not claimed</span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
          {#if page.generated.length > 0}
            <h3><span>Generated</span><span>sync · fix</span></h3>
            <ul>
              {#each page.generated as g (g.job.id)}
                <li class="mem">
                  <span class="mi"></span>
                  <span class="mt" title={g.title}><span class="htag">{g.kind}</span> {g.title}</span>
                  <span class="mr"><span class="mst {g.tone}">{g.text}</span></span>
                  <span></span>
                  <span class="ms">{g.job.id}</span>
                  <span class="mr"><button class="jid" type="button" title="Open {g.job.id}" onclick={() => onopenjob(g.job.key)}>job <b>{g.job.num}</b></button></span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
        {@render fileList('Epic documents')}
        <div class="doc">{@render documentView()}</div>
      </div>
    {:else if doc !== null}
      <div class="ins-bar">
        <span class="lbl">{doc.project} / {doc.ref.kind} / {doc.ref.slug}</span>
        <button class="xbtn" type="button" bind:this={closeBtn} onclick={onclose} aria-label="Close the inspector" title="Close (esc)"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button>
      </div>
      <div class="ins-scroll">
        <div class="ins-head">
          <div class="crumbs"><span>{doc.project}</span><span aria-hidden="true">·</span><span class="stage-pill sp-doc">{doc.kindLabel}</span>{#if doc.status !== null}<span class="stage-pill sp-doc-status">{doc.status}</span>{/if}</div>
          <h2 id="ins-title">{doc.title}</h2>
          <div class="branch" title="relative to factory/">{doc.path}</div>
          {#if docStart !== null}
            {@const start = docStart}
            <div class="acts dacts"><button class="btn primary" type="button" title="Copy {start.command}" onclick={() => onstart(start)}>{start.label}</button></div>
          {/if}
        </div>
        {#if doc.members !== null}
          <section class="members" aria-label="Members">
            <h3><span>Members</span><span>plan order</span></h3>
            {#if doc.members.length === 0}<div class="empty">No members parse.</div>{/if}
            <ul>
              {#each doc.members as m (m.slug)}
                <li>
                  <button class="mem pmem" type="button" aria-haspopup="dialog" title="Open the brief {m.slug}" onclick={() => onopenpage(m.page)}>
                    <span class="mi">{m.n}</span>
                    <span class="mt">{m.slug}</span>
                    <span class="mr"><span class="mst bs-{m.tone}">{m.status}</span></span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <div class="doc">
          <div class="md">
            {#if doc.html !== null}
              {@html doc.html}
            {:else}
              <p class="empty" class:fail={doc.note !== 'Loading…'}>{doc.note}</p>
            {/if}
          </div>
        </div>
      </div>
    {:else if item === null || job === null}
      <div class="ins-bar"><span class="lbl">Inspector</span><button class="xbtn" type="button" onclick={onclose} aria-label="Close the inspector" title="Close (esc)"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button></div>
      <div class="nosel">Nothing selected<small>Click a job, or an epic's name, to see its files.</small></div>
    {:else}
      <div class="ins-bar">
        <span class="lbl">{jobHeader(item).bar}</span>
        <button class="xbtn" type="button" bind:this={closeBtn} onclick={onclose} aria-label="Close the inspector" title="Close (esc)"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button>
      </div>
      <div class="ins-head">
        <div class="crumbs"><span>{jobHeader(item).project}</span><span aria-hidden="true">·</span><span>{job.id}</span>{#if kind !== null}<span class="stage-pill sp-{kind}">{KIND_LABELS[kind]}</span>{/if}</div>
        <h2 id="ins-title">{job.title}</h2>
        {#if lands !== null}<div class="branch" title="branch → target">{lands}</div>{/if}
        {#if sum !== null}<div class="tsum" class:na={!sum.recorded}>{sum.text}</div>{/if}
        {#if link !== null}
          <button class="elink" type="button" aria-haspopup="dialog" onclick={() => onopenepic(link.key)}>
            <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="8" r="1.5" /><path d="M4 4.5v7M5.3 3.8C8.5 5 10.6 5.6 11 6.6M5.3 12.2C8.5 11 10.6 10.4 11 9.4" /></svg>
            <span>{link.text}</span><b>{link.name}</b>
          </button>
        {/if}
      </div>
      {#if human}
        <section class="callout" aria-label="Needs a human">
          <div class="why">
            <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2.5M4 3h7.5l-1.5 3 1.5 3H4" /></svg>
            <span>{job.note || 'No note recorded.'}</span>
          </div>
          <div class="acts">
            <button class="btn primary" type="button" onclick={() => onhandoff({ project: item.project.id, job: job.id, action: 'approve' }, approve)}>Approve</button>
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
      {@render fileList('Job files', true)}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="fgrip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the Files list"
        aria-valuemin={room > 0 ? clampFiles(0, room) : undefined}
        aria-valuemax={room > 0 ? clampFiles(room, room) : undefined}
        aria-valuenow={filesPx > 0 ? filesPx : undefined}
        title="Drag to resize; double-click to fit the files"
        tabindex="0"
        onpointerdown={fgrab}
        onpointermove={fdrag}
        onpointerup={fdrop}
        onpointercancel={fdrop}
        onkeydown={fnudge}
        ondblclick={() => onfilesresize(FILES_FIT)}
      ></div>
      <div class="doc" bind:this={docPane}>
        {@render documentView()}
      </div>
    {/if}
  </div>
</aside>

{#snippet fileList(label: string, sized: boolean = false)}
  <!-- Only the job view's list is measured and sized by the Files grip. -->
  <nav class="files" class:sized={sized && filesShownPx !== null} aria-label={label} bind:this={() => (sized ? filesEl : null), (el) => { if (sized) filesEl = el; }} style:height={sized && filesShownPx !== null ? `${filesShownPx}px` : undefined}>
    {@render fileRows()}
  </nav>
{/snippet}

{#snippet fileRows()}
    {#if model.groups.length === 0}<div class="empty">No files yet.</div>{/if}
    {#each model.groups as g (g.name)}
      <h3><span>{g.name}</span>{#if g.current}<span>current</span>{/if}</h3>
      <ul>
        {#each g.rows as f (f.path)}
          <li>
            <button class="file" class:on={current === f.path} aria-current={current === f.path} type="button" title={f.path === TIMING ? undefined : f.path} onclick={() => choose(f.path, false)}>
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
{/snippet}

{#snippet documentView()}
  <div class="md">
    {#if view !== null}
      <div class="timing"><TimingView {view} /></div>
    {:else if html !== null}
      {@html html}
    {:else}
      <p class="empty">Nothing written yet.</p>
    {/if}
  </div>
{/snippet}
