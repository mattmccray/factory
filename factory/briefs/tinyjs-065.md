# Move the Andon shell to Tiny JS 0.65

- Status: done
- Job: 021-tinyjs-065-types (merged 7905ffe, 2026-10-24)
- Sources: HANDOFF.md §10 (Andon architecture, the Tiny JS note); Tiny JS CHANGELOG 0.57.8–0.65.0
- Date: 2026-10-24

## Intent
The Andon shell was built against Tiny JS 0.57. The CLI on this machine is now 0.65.0. The
repo should say which Tiny it's built and tested against, without the shell breaking, and the
shell should type-check against Tiny's own declarations instead of hand-copied ones.

## Decisions
1. Who updates Tiny JS? → **The human, outside any job** (`tinyjs update`, then
   `tinyjs update-project` in `apps/andon-shell`). Why: Tiny is a machine-global CLI
   (`~/.tinyjs`), not a package dependency; a job changes only source in its worktree.
2. The agent skill `update-project` added → **keep `apps/andon-shell/.claude/skills/tinyjs`,
   drop `.agents/`, commit it by hand before the job** (done: f741c43). Why: agents working on
   the shell get Tiny's current docs; `.agents/` serves the deferred non-Claude adapters, and
   a nested `.claude/` inside a job's diff could read as touching the installed copy.

3. How is the real app checked? → **The human smoke-tested a 0.65.0 build before the job
   (2026-10-24)**: the window opens at launch, a Dock click brings back the hidden window, a
   tray click brings it to the current Space, and the Dock lantern, tray icon, and needs-human
   badge follow the board's state. Why: the gate runs only the fake `TinyApp`; a seen-working
   build is what justifies pinning 0.65.0.
4. The build's `assets/… isn't used by the build` notes → **leave them; moving the lantern
   images to `resources/` is out of scope**. Why: the shell loads them by absolute repo path on
   purpose (`src/backend.ts`), and they render; a self-contained `.app` is separate work.
5. What the job changes → **raise `minTinyjsVersion` in `apps/andon-shell/tinyjs.json` to
   `0.65.0`, and replace the hand-written Tiny/txiki declarations in `src/backend.ts` with
   Tiny's shipped `tiny.d.ts` and `tjs.d.ts`**; `HANDOFF.md` is left alone. Why: the version
   is what was smoke-tested; Tiny's types are complete since 0.63 and cover every member the
   shell uses (checked: they typecheck beside Bun's types under the root strict `tsc`); the
   HANDOFF note is a dated observation, not a decision, and HANDOFF isn't on the job surface.
6. How Tiny's types are wired in → **committed at `apps/andon-shell/types/tiny.d.ts` and
   `types/tjs.d.ts` (copied unedited from Tiny 0.65.0's template), pulled in by a
   `/// <reference path>` from `src/backend.ts` only (not the root `tsconfig` `include`); the
   shell's boundary test fails if any source other than `backend.ts` names `tjs`, `tiny`, or a
   `Tiny*` type; `backend.ts` exports a narrow `ShellApp` derived from `TinyApp` with `Pick`
   (going a level deeper, e.g. the window handle and tray, where a whole Tiny type would force
   the test fakes to grow), and the adapter and the test fakes use it.** Why: `update-project`
   keeps exactly that path current, so a later Tiny bump is `update-project` + the gate + a
   commit; the ambient globals can't leak into `packages/` unnoticed; the list of what the shell
   depends on stays explicit in one place, keeping the shell easy to swap (HANDOFF §10).

## Scope
- In: `apps/andon-shell/tinyjs.json` `minTinyjsVersion` → `0.65.0`; the two `.d.ts` files
  under `apps/andon-shell/types/`; `src/backend.ts` drops its hand-written `Tjs`, `TinyApp`,
  `TinyWindow`, `TinyWinState`, and `TinyTraySpec` declarations for Tiny's, through `ShellApp`;
  the test fakes typed against `ShellApp`; the boundary test's new rule; a test pinning
  `minTinyjsVersion`.
- Behavior: none. The shell does exactly what it does today.
- Out: running `tinyjs update` or `update-project` from a job; committing `.agents/`; moving
  the lantern images from `assets/` to `resources/`; editing `HANDOFF.md`; editing the vendored
  `.d.ts` files; adding Tiny's types to the root `tsconfig` `include`; any change to the
  contract, `packages/`, `.claude/`, or `factory/`; any new package dependency.

## Acceptance sketch
- `tinyjs.json` says `"minTinyjsVersion": "0.65.0"`, and a `bun:test` test fails if it says
  anything else.
- `apps/andon-shell/types/tiny.d.ts` and `tjs.d.ts` exist and match Tiny 0.65.0's template byte
  for byte (`~/.tinyjs/template/types/`).
- `src/backend.ts` declares no Tiny or txiki interface of its own (no `declare const tjs`, no
  hand-written `TinyApp`/`TinyWindow`/`TinyWinState`/`TjsProcess`); it references the vendored
  types and exports `ShellApp`, built with `Pick` from Tiny's types.
- The boundary test fails when a shell source other than `backend.ts` names `tjs`, `tiny`, or a
  `Tiny*` type (shown by the test itself, e.g. against a fixture string).
- `bun run test && bun run check` pass; `bun run andon:shell:build` still bundles the backend;
  no `any`, `as`, or `@ts-ignore` introduced.
- Manual: a `tinyjs build` of the branch behaves as in the 2026-10-24 smoke test.

## Contract calls
None.

## Open
None.
