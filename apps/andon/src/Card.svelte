<script lang="ts">
  // One job card: id (tagged with its project on the All projects board), title, branch, live
  // timers, one row of reviewer chips per round, the decision, and the note.
  import { chipRounds, roundKeys } from './board';
  import type { BoardJob } from './board';
  import { reviewFailed } from './sidebar';
  import { abbr, chipTime, clock, reviewerSpan } from './time';

  interface Props {
    item: BoardJob;
    now: number;
    showProject: boolean;
    fresh: boolean;
    moved: boolean;
    onopen: (key: string) => void;
  }
  let { item, now, showProject, fresh, moved, onopen }: Props = $props();

  const job = $derived(item.job);
  const timers = $derived(clock(job, now));
  const rounds = $derived(chipRounds(job));
  const reviewing = $derived(job.stage === 'review');
</script>

<button class="card {job.stage}" class:failed={reviewFailed(job)} class:new={fresh} class:moved type="button" aria-haspopup="dialog" onclick={() => onopen(item.key)}>
  <span class="top">
    <span class="id">{#if showProject}<span class="proj" title={item.project.name}>{item.project.name}</span>{/if}{job.id}</span>
    <span class="rnd">{job.round > 0 ? `round ${job.round}/${job.maxRound ?? 2}` : ''}</span>
  </span>
  <span class="title">{job.title}</span>
  <span class="branch">{job.branch}</span>
  {#if timers !== null}
    <span class="clock"><span>{timers.main}</span>{#if timers.total !== null}<span class="tot">{timers.total}</span>{/if}</span>
  {/if}
  {#if rounds.length > 0}
    <span class="rounds">
      {#each rounds as r (`${r.round}-${r.past}`)}
        <span class="round" class:past={r.past}>
          <span class="r" aria-hidden="true">R{r.round}</span>
          {#each roundKeys(r.reviews, item.reviewers) as k (k)}
            {@const verdict = r.reviews[k] ?? 'pending'}
            {@const t = chipTime(k, verdict, reviewerSpan(job, k, r.round), now)}
            <span class="cw">
              <span class="chip {verdict}" class:live={reviewing && !r.past} title={t.title} aria-hidden="true">{abbr(k)}</span>
              <span class="cd" aria-hidden="true">{t.short}</span>
              <span class="sr-only">R{r.round} {t.title}</span>
            </span>
          {/each}
        </span>
      {/each}
    </span>
  {/if}
  {#if job.decision !== null}<span class="decision {job.decision.split(' ')[0]}">{job.decision}</span>{/if}
  {#if job.note !== ''}<span class="note">{job.note}</span>{/if}
</button>
