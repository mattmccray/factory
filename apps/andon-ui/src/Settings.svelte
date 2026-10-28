<script lang="ts">
  // The Mac app's Settings window: a General section with "Show status bar", and a T3 Code section
  // (036) with what the needs-human box's Approve and the sheets' Copy do besides copying: "Open a
  // draft in T3 Code", "Send in T3 Code right away", or "Copy only". Without `t3` the choices are
  // grayed out and a line says T3 Code wasn't found. The settings are the Mac app's: the view reads
  // them (getSettings), asks for each change at once with no Save button (setSetting), and follows
  // status bar changes made elsewhere (the View menu, ⌘/) through the pushed status bar event.
  // settings.ts and sidebar.ts hold the logic; this only lays it out. The board's window frame
  // (sidebar, toolbar, drag regions) doesn't apply here: the window has a standard title bar.
  import { onMount } from 'svelte';
  import { HANDOFF_CHOICES, settingsCaller, showsStatusBar } from './settings';
  import type { HandoffMode, Settings } from './settings';
  import { STATUS_BAR_EVENT, pushSubscriber, shellMode, statusBarHidden } from './sidebar';

  const mode = shellMode(window.location.search);
  const host: unknown = Reflect.get(window, 'tiny');
  const api = settingsCaller(mode, host);
  // null until the Mac app answers: the controls stay disabled rather than guess.
  let settings = $state<Settings | null>(null);

  onMount(() => {
    // Subscribe first, so a change pushed while the first answer is on its way isn't lost.
    const off = pushSubscriber(mode, host)?.(STATUS_BAR_EVENT, (data) => {
      const hidden = statusBarHidden(data);
      if (hidden !== null && settings !== null) settings = { ...settings, statusBarHidden: hidden };
    });
    void api?.get().then((s) => {
      if (s !== null) settings = s;
    });
    return () => off?.();
  });

  async function onchange(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const show = e.currentTarget.checked;
    if (settings !== null) settings = { ...settings, statusBarHidden: !show };
    const after = await api?.setStatusBarHidden(!show);
    if (after !== undefined && after !== null) settings = after;
  }

  async function choose(choice: HandoffMode): Promise<void> {
    if (settings === null) return;
    settings = { ...settings, t3Handoff: choice };
    const after = await api?.setT3Handoff(choice);
    if (after !== undefined && after !== null) settings = after;
  }

  const t3Off = $derived(settings === null || !settings.t3Found);
</script>

<svelte:head><title>Settings</title></svelte:head>

<main class="settings">
  <section class="set-group" aria-labelledby="set-general">
    <h2 id="set-general">General</h2>
    <div class="set-box">
      <label class="set-row">
        <input type="checkbox" checked={settings !== null && showsStatusBar(settings)} disabled={settings === null} {onchange} />
        <span>Show status bar</span>
      </label>
    </div>
  </section>
  <section class="set-group" aria-labelledby="set-t3">
    <h2 id="set-t3">T3 Code</h2>
    <div class="set-box">
      <div class="set-choices" role="radiogroup" aria-labelledby="set-t3-what" aria-describedby={settings !== null && !settings.t3Found ? 'set-t3-missing' : undefined}>
        <p class="set-what" id="set-t3-what">What Approve, Rework, and Abandon do. The command is always copied too.</p>
        {#each HANDOFF_CHOICES as c (c.mode)}
          <label class="set-row">
            <input type="radio" name="t3Handoff" value={c.mode} checked={settings !== null && settings.t3Handoff === c.mode} disabled={t3Off} onchange={() => choose(c.mode)} />
            <span>{c.label}</span>
          </label>
        {/each}
      </div>
      {#if settings !== null && !settings.t3Found}<p class="set-note" id="set-t3-missing">T3 Code wasn't found.</p>{/if}
    </div>
  </section>
</main>
