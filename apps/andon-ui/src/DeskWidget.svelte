<script lang="ts">
  // The Mac app's desk widget (092; design A2): a small glass panel on the desktop, one row per
  // project with live work, each job a 4-segment pill, epics' members in a bracket, a footer with the
  // needs-you, live, and merged counts. It follows the service's live stream as the board does
  // (live.ts) and keeps watching merges (widget.ts `watchMerges`), so a pill changes color in place,
  // a new one grows in, a just-merged one goes green and then shrinks away, and the rows reflow. A
  // hovered (or focused) pill shows its tooltip inside the glass. Clicking a pill opens the board on
  // that job; clicking anywhere else on the glass brings Andon forward; pressing on the glass and
  // moving drags the window. After every change in height (and after a drag) the page tells the Mac
  // app its glass's height, so the window fits it and its place is remembered. widget.ts holds the
  // logic; this only lays it out. In a browser it renders, and clicks do nothing.
  import { onMount } from 'svelte';
  import { flip } from 'svelte/animate';
  import { fade, scale } from 'svelte/transition';
  import type { Fetcher } from './api';
  import { startLive } from './live';
  import { motionMs } from './motion';
  import { ALL, boardJobs } from './projects';
  import { shellMode } from './sidebar';
  import { emptyState } from './state';
  import type { UiState } from './state';
  import { fitHeight, footerText, pillLabel, pressClick, pressMove, pressStart, tipPlace, watchMerges, watchStart, widgetCaller, widgetView } from './widget';
  import type { Pill, Press, RowItem } from './widget';

  const mac = widgetCaller(shellMode(window.location.search), Reflect.get(window, 'tiny'));
  const fetcher: Fetcher = (path) => fetch(path, { cache: 'no-store' });

  let ui = $state.raw<UiState>(emptyState());
  let watch = $state.raw(watchStart());
  const view = $derived(widgetView(ui, watch));
  const foot = $derived(footerText(view.footer));
  const itemKey = (item: RowItem): string => (item.kind === 'pill' ? item.pill.key : `epic:${item.epic.key}`);

  const step = (s: UiState): void => {
    watch = watchMerges(watch, boardJobs(s, ALL), Date.now());
  };

  let glass = $state<HTMLElement>();
  let reported = 0;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tells the Mac app the glass's height (when it changed, or `always`), after the layout settles. */
  function report(always = false): void {
    if (fitTimer !== null) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (glass === undefined) return;
      const h = fitHeight(glass.getBoundingClientRect().height);
      if (!always && h === reported) return;
      reported = h;
      mac?.fit(h);
    }, 120);
  }

  onMount(() => {
    const live = startLive({
      connect: (path) => new EventSource(path),
      fetcher,
      onState: (s) => {
        ui = s;
        step(s);
      },
      onStatus: () => undefined, // a dropped stream keeps the last view; live.ts reconnects
    });
    // A just-merged pill leaves on time even when no event arrives.
    const timer = setInterval(() => step(ui), 400);
    const ro = typeof ResizeObserver === 'undefined' || glass === undefined ? null : new ResizeObserver(() => report());
    if (glass !== undefined) ro?.observe(glass);
    report(true);
    return () => {
      live.stop();
      clearInterval(timer);
      ro?.disconnect();
      if (fitTimer !== null) clearTimeout(fitTimer);
    };
  });

  // ---- the glass: a click brings Andon forward, a press and move drags the window ----
  let press: Press | null = null;
  const onPill = (t: EventTarget | null): boolean => t instanceof Element && t.closest('button') !== null;
  function onmousedown(e: MouseEvent): void {
    if (e.button !== 0 || onPill(e.target)) return;
    press = pressStart(e.screenX, e.screenY);
  }
  function onmousemove(e: MouseEvent): void {
    if (press === null) return;
    if ((e.buttons & 1) === 0) {
      // the button came up somewhere we didn't hear (the native drag took the mouse-up)
      if (press.dragging) report(true);
      press = null;
      return;
    }
    const r = pressMove(press, e.screenX, e.screenY);
    press = r.press;
    if (r.drag) void mac?.drag().then(() => report(true));
  }
  function onmouseup(e: MouseEvent): void {
    if (press === null || e.button !== 0) return;
    const click = pressClick(press);
    press = null;
    if (click) mac?.showAndon();
    else report(true);
  }

  // ---- the tooltip ----
  let hover = $state<{ pill: Pill; anchor: { x: number; y: number; width: number; height: number } } | null>(null);
  let tipW = $state(0);
  let tipH = $state(0);
  function onhover(p: Pill | null, el: HTMLElement | null): void {
    if (p === null || el === null || glass === undefined) {
      hover = null;
      return;
    }
    const g = glass.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hover = { pill: p, anchor: { x: r.left - g.left, y: r.top - g.top, width: r.width, height: r.height } };
  }
  // The hovered pill's latest tooltip (it may change while shown); gone when the pill leaves the view.
  const hoverPill = $derived.by(() => {
    const h = hover;
    if (h === null) return null;
    for (const row of view.rows) for (const item of row.items) for (const p of item.kind === 'pill' ? [item.pill] : item.epic.pills) if (p.key === h.pill.key) return p;
    return null;
  });
  const tipAt = $derived(hover === null || glass === undefined ? null : tipPlace(hover.anchor, { width: glass.clientWidth, height: glass.clientHeight }, { width: tipW, height: tipH }));
</script>

<svelte:head><title>Andon Desk Widget</title></svelte:head>
<svelte:window {onmousemove} {onmouseup} />

{#snippet pill(p: Pill)}
  <button
    type="button"
    class="dw-pill t-{p.tone}"
    aria-label={pillLabel(p)}
    onclick={() => mac?.openJob(p.project, p.id)}
    onmouseenter={(e) => onhover(p, e.currentTarget)}
    onmouseleave={() => onhover(null, null)}
    onfocus={(e) => onhover(p, e.currentTarget)}
    onblur={() => onhover(null, null)}
  >
    {#each p.fills as f, i (i)}<i class="f-{f}"></i>{/each}
  </button>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dw" class:empty={view.empty} bind:this={glass} {onmousedown}>
  <div class="dw-rows" aria-hidden={view.empty}>
    {#each view.rows as row (row.key)}
      <div class="dw-row" animate:flip={{ duration: motionMs(450) }} in:fade={{ duration: motionMs(300) }} out:fade={{ duration: motionMs(300) }}>
        <div class="dw-label">{row.label}</div>
        <div class="dw-pills">
          {#each row.items as item (itemKey(item))}
            <span class="dw-item" animate:flip={{ duration: motionMs(450) }} in:scale={{ duration: motionMs(420), start: 0.4 }} out:scale={{ duration: motionMs(420), start: 0.6 }}>
              {#if item.kind === 'pill'}
                {@render pill(item.pill)}
              {:else}
                <span class="dw-epic" role="group" aria-label={item.epic.tip.replace('\n', ', ')}>
                  {#each item.epic.pills as p (p.key)}
                    <span class="dw-item" animate:flip={{ duration: motionMs(450) }} in:scale={{ duration: motionMs(420), start: 0.4 }} out:scale={{ duration: motionMs(420), start: 0.6 }}>
                      {@render pill(p)}
                    </span>
                  {/each}
                </span>
              {/if}
            </span>
          {/each}
        </div>
      </div>
    {/each}
  </div>
  <footer class="dw-foot" aria-hidden={view.empty}>
    <span><b class:zero={view.footer.needsYou === 0}>{view.footer.needsYou}</b> needs you</span>
    <span>{foot.counts}</span>
  </footer>
  <p class="dw-empty" aria-hidden={!view.empty}>Nothing running</p>
  {#if hoverPill !== null && tipAt !== null}
    <div class="dw-tip" role="tooltip" style:left="{tipAt.x}px" style:top="{tipAt.y}px" bind:clientWidth={tipW} bind:clientHeight={tipH}>{hoverPill.tip}</div>
  {/if}
</div>
