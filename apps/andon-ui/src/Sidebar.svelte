<script lang="ts">
  // The sidebar (design §3): All Projects with its needs-human badge, every registered project with
  // its status dot and badge, and the service's connection in the footer. In the Mac app its top
  // strip leaves room for the traffic lights and drags the window. The rows come from sidebar.ts.
  // Each project row carries its id for the Mac app's right-click menu (projectmenu.ts).
  // A project's factory release is quiet (brief andon-version-ui, decision 1): its line joins the
  // row's hover text and is the row's description for screen readers, and a behind project gets a
  // muted "update available" glyph, its own button beside the row's (never inside it), that opens
  // What's New scoped to it. The footer adds the machine's release (opening What's New), or a
  // restart note that copies the restart command when the service's clone has moved.
  import type { Status } from './live';
  import { ALL } from './projects';
  import type { Selection } from './projects';
  import { STATE_LABELS } from './sidebar';
  import type { Badge, Footer, SidebarModel } from './sidebar';

  interface Props {
    model: SidebarModel;
    foot: Footer;
    status: Status;
    drag: boolean;
    onselect: (sel: Selection) => void;
    onwhatsnew: (project: string | null) => void; // the What's New sheet: whole (null), or scoped to a project
    oncopy: (command: string) => void; // the restart note: copy and toast
  }
  let { model, foot, status, drag, onselect, onwhatsnew, oncopy }: Props = $props();

  // A row's accessible name: the name, then what its dot and badge show ("minerva, needs a human, 1 needs a human").
  const label = (name: string, state: string | null, badge: Badge | null): string => [name, state, badge?.label].filter((x) => x !== null && x !== undefined).join(', ');
  // Announced to screen readers only when the connection changes, not when the project count does;
  // also the footer's hover tooltip, so one wording names the service for both.
  const ANNOUNCE: Record<Status, string> = { connecting: 'Connecting to the Andon service', live: 'Connected to the Andon service', down: 'The Andon service is unreachable' };
</script>

<aside class="sidebar" id="sidebar" aria-label="Sidebar">
  <div class="sb-top" data-tiny-drag={drag ? '' : undefined}></div>
  <nav class="srclist" aria-label="Projects">
    <h2>Overview</h2>
    <ul>
      <li>
        <button class="sbi" class:on={model.all.selected} type="button" aria-label={label('All Projects', null, model.all.badge)} aria-current={model.all.selected ? 'true' : undefined} onclick={() => onselect(ALL)}>
          <svg class="i ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 13.5 5 8 7.5 2.5 5z" /><path d="m2.5 8 5.5 2.5L13.5 8M2.5 11l5.5 2.5 5.5-2.5" /></svg>
          <span class="nm">All Projects</span>
          {#if model.all.badge !== null}<span class="badge red" aria-hidden="true">{model.all.badge.count}</span>{/if}
        </button>
      </li>
    </ul>
    {#if model.projects.length > 0}
      <h2>Projects</h2>
      <ul>
        {#each model.projects as p (p.id)}
          <li class="sbrow" class:upd={p.release !== null && p.release.glyph !== null}>
            <button
              class="sbi"
              class:on={p.selected}
              type="button"
              title={p.title}
              data-project-menu={p.id}
              aria-label={label(p.name, STATE_LABELS[p.state], p.badge)}
              aria-describedby={p.release !== null ? `rel-${p.id}` : undefined}
              aria-current={p.selected ? 'true' : undefined}
              onclick={() => onselect(p.id)}
            >
              <span class="dot {p.dot}" aria-hidden="true"></span>
              <span class="nm">{p.name}</span>
              {#if p.badge !== null}<span class="badge" class:red={p.badge.tone === 'red'} aria-hidden="true">{p.badge.count}</span>{/if}
              {#if p.release !== null}<span class="sr-only" id="rel-{p.id}">{p.release.line}</span>{/if}
            </button>
            {#if p.release?.glyph}
              <button class="relglyph" type="button" title={p.release.glyph.label} aria-label={p.release.glyph.label} aria-haspopup="dialog" onclick={() => onwhatsnew(p.id)}>
                <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75" /><path d="M8 10.75v-5.5M5.75 7.5 8 5.25l2.25 2.25" /></svg>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </nav>
  <div class="service" title={ANNOUNCE[status]}>
    <span class="dot {foot.dot}" aria-hidden="true"></span><span class="txt">{foot.text}</span>
    {#if foot.release !== null}
      {@const rel = foot.release}
      <span class="sep" aria-hidden="true">·</span>
      {#if rel.kind === 'version'}
        <button class="ver" type="button" title={rel.title} aria-label={rel.title} aria-haspopup="dialog" onclick={() => onwhatsnew(null)}>{rel.text}</button>
      {:else}
        <button class="ver restart" type="button" title={rel.title} aria-label={rel.title} onclick={() => oncopy(rel.command)}>
          <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 8a4.5 4.5 0 1 1-1.32-3.18" /><path d="M12.75 2.75v2.5h-2.5" /></svg>{rel.text}
        </button>
      {/if}
    {/if}
    <span class="sr-only" role="status">{ANNOUNCE[status]}</span>
  </div>
</aside>
