# Say why a GitHub project can't draft, and space the New exploration title

- Status: ready
- Sources: the explore request of 2026-10-31 (New exploration for Infra on Moya said "No GitHub remote" although Open on GitHub works; the sheet's title runs into the project name); brief `andon-remote-handoff` (job 086, decisions 3 and 5, and its Facts on T3 Code's `RepositoryIdentityResolver`); brief `andon-open-repository` (job 088); `apps/andon/src/handoff.ts` (`primaryRepository`, `draftTarget`), `apps/andon/src/backend.ts` (`deliver`), `apps/andon-ui/src/handoff.ts` (the toasts), `apps/andon-ui/src/NewExplorationSheet.svelte:45`
- Date: 2026-10-31

## Intent
When a hand-off or Start Work can't open a T3 Code draft because T3 Code goes by a different
remote than the project's GitHub one, the toast says that, and how to fix it, instead of the
misleading "No GitHub remote". The New exploration sheet's title gets its missing space before
the project name.

## Facts (2026-10-31)
- Infra on Moya (`6bb1e650df35@moya`) lists remotes `gitea` (`localhost:222`), `github`
  (`github.com`, `mattmccray/infra`), and `origin` (`localhost:222`).
- Open on GitHub (job 088, `projectmenu.ts` `repositoryLink`) picks the first github.com remote
  by name, so it works. Drafts (`handoff.ts` `draftTarget`) pick T3 Code's own primary remote
  (`upstream`, else `origin`, else the first by name), which is `origin` here, not linkable, so
  the outcome is `no-github-remote` and the toast reads "No GitHub remote; copied …".
- That draft rule is right: T3 Code's `repo=` matches only its primary remote (brief
  `andon-remote-handoff`, Facts and decision 3), so drafting with the `github` remote would show
  "You don't have mattmccray/infra". The fix on Matt's side is renaming the remote to
  `upstream`; no code change needed for that.
- `NewExplorationSheet.svelte:45` has `New exploration{#if …} <span class="mono">…`: the space
  is the first thing inside the `{#if}` block, and Svelte trims whitespace at a block's start,
  so the two abut. `CommandSheet.svelte:49` (`{words.title} <span class="mono">{id}</span>`)
  is outside a block and renders its space.

## Decisions
1. Change the draft rule so a GitHub remote is drafted into whatever it's named? → **No. Drafts
   keep following T3 Code's primary remote.** Why: T3 Code matches `repo=` against that remote
   only; any other pick opens a draft T3 Code can't place.
2. Make the toast say why? → **Yes. When the project's T3 Code primary remote isn't linkable but
   another of its listed remotes is (on the T3 Code allowlist, owner and name plain parts), the
   backend answers a new outcome naming the project, the primary remote's name, and the linkable
   remote's name, and the toast says so with the fix, e.g. "T3 Code knows infra by its origin
   remote, not GitHub; make github its upstream remote to draft. Copied <command>". With no
   linkable remote at all, "No GitHub remote; copied …" stays.** Why: "No GitHub remote" is
   false when one exists, and the fix (a remote rename) isn't discoverable otherwise.

## Defaults (not questioned; the spec-writer may refine)
- The new outcome is one more `draftTarget` kind and one more `HandoffOutcome` object shape, used
  by both `handOff` and `startWork` (they share `deliver`), so needs-human hand-offs and Start
  Work get the same toast; send mode for a remote project gets it too, where it falls back to a
  draft today.
- The page validates the new outcome's shape as it does the others (`sameKeys`, non-empty
  strings) and treats a malformed one as unknown, as today. The page copies first, as today; a
  failed copy still shows the copy-failed toast.
- With several linkable non-primary remotes, the toast names the first by remote name.
- Exact toast wording is the spec-writer's, keeping the remote names and the "copied <command>"
  tail.
- The heading fix keeps one plain space between "New exploration" and the monospace project
  name (e.g. `{' '}` or moving the space outside the block's trimming), with no CSS margin
  hack; the picker case (no name shown) gets no trailing space.

## Scope
- In: `apps/andon/src/handoff.ts` (`draftTarget`'s new kind and the outcome type), `backend.ts`
  (`deliver` answering it), `apps/andon-ui/src/handoff.ts` (the outcome's check and its toast),
  `apps/andon-ui/src/NewExplorationSheet.svelte` (the space); `bun:test` coverage for the new
  kind, the outcome check, and the toast text.
- Out: changing which remote a draft uses; Open on GitHub; renaming any remote for Matt (he runs
  `git -C /home/mattm/projects/infra remote rename github upstream` himself); the service, the
  `factory/v1` contract, and the `repositories` feed; the API gate (no new method).

## Acceptance sketch
- For a project whose remotes are like Infra's (`origin` self-hosted, a `github` remote on
  github.com), New exploration, Run next, and a needs-human hand-off in draft mode copy the
  command and show a toast naming `origin` and `github` and saying to make `github` its
  `upstream`; nothing is opened.
- A project with no github.com remote still shows "No GitHub remote; copied …".
- A project whose `upstream` (or `origin`) is on github.com still drafts as today.
- The New exploration sheet's title reads "New exploration infra" with one space; with the
  project picker shown it reads "New exploration" alone.
- The gate passes.

## Contract calls
None.

## Open
None.
