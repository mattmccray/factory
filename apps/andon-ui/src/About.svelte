<script lang="ts">
  // The Mac app's About window: the art across the top (paper lanterns over a river at dusk), then
  // "Andon", "Version X.Y.Z", the service's release when it differs ("Service X.Y.Z", with
  // "· restart needed" when its clone has moved on), the "Factory on GitHub" link (target=_blank:
  // Tiny hands it to the default browser), and the copyright. about.ts holds the logic; this only
  // lays it out. The window has a standard title bar, so the board's frame doesn't apply here.
  import { onMount } from 'svelte';
  import { aboutCaller, aboutModel } from './about';
  import { fetchRelease } from './api';
  import type { Fetcher } from './api';
  import { shellMode } from './sidebar';

  const api = aboutCaller(shellMode(window.location.search), Reflect.get(window, 'tiny'));
  const fetcher: Fetcher = (path) => fetch(path, { cache: 'no-store' });
  let app = $state<unknown>(null);
  let release = $state<unknown>(null);
  const m = $derived(aboutModel(app, release));

  onMount(() => {
    void api?.().then((a) => (app = a));
    void fetchRelease(fetcher).then((r) => {
      if (r.ok) release = r.data;
    });
  });
</script>

<svelte:head><title>About Andon</title></svelte:head>

<main class="about">
  <img class="about-art" src={m.art} alt="Paper lanterns rising over a river at dusk" />
  <div class="about-text">
    <h1>{m.name}</h1>
    {#if m.version !== null}<p class="about-ver">{m.version}</p>{/if}
    {#if m.service !== null}<p class="about-ver">{m.service}</p>{/if}
    {#if m.github !== null}<p class="about-link"><a href={m.github.href} target="_blank" rel="noopener noreferrer">{m.github.label}</a></p>{/if}
    <p class="about-copy">{m.copyright}</p>
  </div>
</main>
