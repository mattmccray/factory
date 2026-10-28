<script lang="ts">
  // The Mac app's Settings window: one General section with "Show status bar". The settings are the
  // Mac app's: the view reads them (getSettings), asks for each change at once with no Save button
  // (setSetting), and follows changes made elsewhere (the View menu, ⌘/) through the pushed status
  // bar event. settings.ts and sidebar.ts hold the logic; this only lays it out. The board's window
  // frame (sidebar, toolbar, drag regions) doesn't apply here: the window has a standard title bar.
  import { onMount } from 'svelte';
  import { settingsCaller, showsStatusBar } from './settings';
  import type { Settings } from './settings';
  import { STATUS_BAR_EVENT, pushSubscriber, shellMode, statusBarHidden } from './sidebar';

  const mode = shellMode(window.location.search);
  const host: unknown = Reflect.get(window, 'tiny');
  const api = settingsCaller(mode, host);
  // null until the Mac app answers: the checkbox stays disabled rather than guess.
  let settings = $state<Settings | null>(null);

  onMount(() => {
    // Subscribe first, so a change pushed while the first answer is on its way isn't lost.
    const off = pushSubscriber(mode, host)?.(STATUS_BAR_EVENT, (data) => {
      const hidden = statusBarHidden(data);
      if (hidden !== null) settings = { statusBarHidden: hidden };
    });
    void api?.get().then((s) => {
      if (s !== null) settings = s;
    });
    return () => off?.();
  });

  async function onchange(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const show = e.currentTarget.checked;
    settings = { statusBarHidden: !show };
    const after = await api?.setStatusBarHidden(!show);
    if (after !== undefined && after !== null) settings = after;
  }
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
</main>
