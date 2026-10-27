# A project name in config.json

- Status: done
- Job: 028-project-name-config (merged 873915c, 2026-10-27)
- Sources: `packages/andon-agent/src/index.ts` (`name: basename(root)`), `docs/contract/v1.md` ("`config.json`", "Andon agent")
- Date: 2026-10-27

## Intent
Andon labels each project with its folder name, which is often not what the project is called.
A `name` in `factory/config.json` lets the project choose the name Andon shows, and the name
travels with the repo instead of depending on where it's cloned.

## Decisions
1. Where does the name live, and under what key? → **A top-level `name` in `factory/config.json`.**
   Why: a project's name is its identity, not a dashboard view setting, so other readers (the
   CLI, a later tracker) can use it without reaching into `dashboard`.
2. Required, fallback, and validation? → **Optional. Absent → the root's basename, as today. An
   invalid `config.json` → the basename too (the project's error state shows as it does now). When
   present: a string of 1–64 characters, no leading or trailing whitespace, no control characters;
   spaces, punctuation, and non-ASCII are allowed. Anything else makes the config invalid (strict
   parse, like every other key). The project id stays the hash of the root.** Why: existing
   configs keep working; it's a display label, not an identifier; the cap protects the sidebar
   layout, and the other rules stop a stray newline or empty string from passing as a name.
3. When does an edited name reach Andon? → **Live. When a project's resolved name changes
   (config edited, added, removed, or turned invalid), the agent re-sends the `projects` event;
   `GET /projects` resolves the name on every request.** Why: every other `config.json` edit shows
   up live, and a name that doesn't update would look like a bug.
4. Does `factory init` write a default `name`? → **No; its default `config.json` is unchanged.**
   Why: absent already means the folder name, and baking one clone's folder name into a tracked
   file would be wrong for anyone who clones it elsewhere.
5. Does `/factory customize` cover `name`? → **Yes, as the first interview question.** The
   managed skill template (`packages/templates/assets/skill/SKILL.md`) adds `name` to its list of
   allowed keys and its refusal rules (decision 2's validation), and asks about it first, showing
   the current resolved name and recommending leaving it unset when the folder name is right.
   `config.json` is written with `name` first among the keys after `schema`. Why: without it,
   `customize` would refuse or drop a `name`; asking first makes the setting discoverable.

## Scope
- In: `parseConfig` in `@factory/contract` (accepts and validates `name`; `Config` carries it);
  `doctor` (via the same parse); the Andon agent (`GET /projects` and the `projects` event resolve
  the name, live); the Andon UI only as far as it needs to pick the new name up; the skill
  template's `customize` section; `docs/contract/v1.md` ("`config.json`" and "Andon agent"); tests.
- Out: `factory init`'s default config; the project id (still the root's hash); any other reader
  of the name (CLI `show`, the tray); the installed copy (`.claude/`, `factory/`), which gets this
  only through a human-run `factory upgrade` after merge; the vendored `factory/serve.ts` and
  `factory/dashboard.html`.

## Acceptance sketch
- A project whose `config.json` has `"name": "Minerva Admin"` appears in Andon (sidebar, lane
  header, search) as "Minerva Admin"; one without `name` still appears under its folder name.
- Editing, adding, or removing `name` while Andon is open updates the label without a reload; so
  does breaking `config.json` (the label falls back to the folder name and the error shows).
- `parseConfig` and `doctor` reject an empty name, a name over 64 characters, one with leading or
  trailing whitespace, one with a control character, and a non-string, each with a one-line
  reason; they accept a name with spaces, punctuation, and non-ASCII characters.
- A project's id is unchanged by setting or changing its `name`.
- `factory init` still writes the same default `config.json`.
- The rendered skill's `customize` asks about `name` first and refuses an invalid one.
- The contract doc describes `name` under "`config.json`" and says `GET /projects` `name` is the
  config's `name`, else the root's basename.

## Contract calls
- "`config.json` gains an optional top-level `name` (a display name: 1–64 characters, no leading or
  trailing whitespace, no control characters). The Andon agent's `GET /projects` and `projects`
  event report `name` as the config's `name` when it is set and the config is valid, else the
  root's basename, and re-send `projects` when a project's resolved name changes." Approved by the
  user on 2026-10-27. Additive within v1; an older CLI or agent rejects a config that sets `name`,
  so projects upgrade before using it. The job must update `docs/contract/v1.md` ("`config.json`"
  and "Andon agent") to match.

## Open
None.
