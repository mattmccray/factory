<script lang="ts">
  // One job's token (design §6): a 3px state edge, line 1 the mono number and the title, line 2
  // the tag, the current round's chips, R<n>/<max>, and the time in stage; the note on line 3 for
  // needs-human and merge-failed, and the branch when the project is focused. A merged or settled
  // token is one line: the number, the title, and the time since the merge, with no line 2 and no
  // branch (the sha, round, and full time are in the popover and the drawer). The model comes
  // from lanes.ts (`tokenOf`); each kind's shape class draws its non-color mark. A board token
  // carries its job id and project id for the Mac app's right-click job menu (jobmenu.ts).
  import { tokenJobId } from './jobmenu';
  import type { TokenModel } from './lanes';

  interface Props {
    token: TokenModel;
    project: string; // the lane's project id, for the job menu marker
    miss?: boolean; // dimmed by a search it doesn't match
    selected: boolean;
    fresh: boolean;
    moved: boolean;
    onopen: (key: string) => void;
    onhover: (key: string | null, el: HTMLElement | null) => void;
  }
  let { token: t, project, miss = false, selected, fresh, moved, onopen, onhover }: Props = $props();

  let el = $state<HTMLButtonElement>();
  const show = (): void => onhover(t.key, el ?? null);
  const hide = (): void => onhover(null, null);
  const oneLine = $derived(t.kind === 'merged' || t.kind === 'settled');
  const jobId = $derived(tokenJobId(t.key, project));
</script>

<button
  bind:this={el}
  class="tok k-{t.kind} s-{t.shape}"
  class:sel={selected}
  class:miss
  class:new={fresh}
  class:moved
  type="button"
  aria-haspopup="dialog"
  aria-current={selected ? 'true' : undefined}
  data-key={t.key}
  data-job-menu={jobId === '' ? undefined : jobId}
  data-job-menu-project={jobId === '' ? undefined : project}
  onclick={() => onopen(t.key)}
  onpointerenter={show}
  onpointerleave={hide}
  onfocus={show}
  onblur={hide}
>
  <span class="sr-only">{t.label}: </span>
  <span class="l1"><span class="num">{t.num}</span><span class="sl">{t.title}</span>{#if oneLine && t.time !== null}<span class="age">{t.time}</span>{/if}</span>
  {#if !oneLine}
    <span class="l2">
      {#if t.tag !== null}
        <span class="tag">
          {#if t.shape === 'flag'}<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8" /></svg>
          {:else if t.shape === 'merge-hatch'}<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="8" r="1.5" /><path d="M4.5 5v6M4.5 6c0 2 2 2 5.5 2" /></svg>{/if}
          {t.tag}
        </span>
      {/if}
      {#if t.chips.length > 0}
        <span class="chips" aria-hidden="true">
          {#each t.chips as c (c.key)}<span class="chip {c.verdict}" class:pulse={c.pulse} title="{c.key}: {c.verdict}">{c.label}</span>{/each}
        </span>
        <span class="sr-only">{t.chips.map((c) => `${c.key} ${c.verdict}`).join(', ')}</span>
      {/if}
      {#if t.round !== null}<span class="rd">{t.round}</span>{/if}
      {#if t.time !== null}<span class="age">{t.time}</span>{/if}
    </span>
  {/if}
  {#if t.note !== null}<span class="why">{t.note}</span>{/if}
  {#if !oneLine}<span class="br">{t.branch}</span>{/if}
  {#if t.shape === 'seal'}
    <span class="seal" aria-hidden="true"><svg class="i" viewBox="0 0 16 16"><path d="m8 1.8 1.6 1.2 2-.1.6 1.9 1.6 1.2-.6 1.9.6 1.9-1.6 1.2-.6 1.9-2-.1L8 14.2l-1.6-1.2-2 .1-.6-1.9L2.2 10l.6-1.9-.6-1.9 1.6-1.2.6-1.9 2 .1z" /><path d="m5.8 8 1.5 1.5 3-3" /></svg></span>
  {/if}
  {#if t.shape === 'progress'}<span class="prog" aria-hidden="true"></span>{/if}
</button>
