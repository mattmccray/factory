## v0.2.0 (2026-10-30)

### Added

- CLI: add factory projects to list, prune, and remove registry roots (061-registry-prune)
- CLI: install the factory globally from GitHub via a release bundle (060-cli-global-install)
- CLI: add factory service to install and run the Andon service (062-andon-service-install)

## v0.1.0 (2026-10-29)

### Breaking

- CLI: rename the job archive branch to factory/archive (046-archive-branch-rename)

### Added

- Contract: copy the factory/v1 contract into packages/contract (001-contract-package)
- CLI: add the source CLI with event, rebuild, show, and doctor (002-cli-package)
- Skill: render stamped, project-neutral managed templates (003-managed-templates)
- CLI: add factory init and upgrade with a self-contained installed CLI (004-factory-init-upgrade)
- Skill: add the /factory customize overlay interview to the skill (005-factory-customize)
- Contract: add per-role runner config and the role I/O protocol (006-role-runner-config)
- Andon: add the Andon agent daemon, machine registry, and init registration (007-andon-agent)
- Andon: add the Svelte board with a project switcher, served by the agent (008-andon-ui)
- Andon: fix the timing line, check UI types against the contract, add a UI CSP (009-andon-ui-followups)
- Andon: add the Tiny JS shell with tray badge, notifications, auto-start (010-andon-shell)
- Factory: make the job's target branch configurable via merge.target (014-configurable-target-branch)
- update target branch references and add merge target configuration
- Skill: mark a brief done when its job merges (015-brief-done-status)
- Andon: show the main window on a tray left click (016-tray-click-toggle)
- Andon: show board state as a lantern in the Dock and tray, with a badge (019-lantern-icons-badge)
- Skill: add the overlay outcome rule to every role (020-overlay-outcome-rule)
- Andon: move the shell to Tiny JS 0.65 and its shipped types (021-tinyjs-065-types)
- Contract: record why a job stopped and add job.abandoned with abandon (022-needs-human-exits)
- Andon: add the Mac-app frame, project sidebar, and visual tokens (023-andon-mac-frame)
- CLI: add claim, the only way to create a job and pick its number (024-cli-owned-job-ids)
- add job abandonment feature with cleanup options
- Andon: replace the Kanban board with the Assembly Lines matrix (025-andon-assembly-lines)
- Andon: add the inspector, the command sheets, and the Settled sheet (026-andon-inspector)
- Andon: add search, Needs Me, the keyboard map, and deep links (027-andon-find-keys)
- Contract: add an optional project name to config.json, shown by Andon (028-project-name-config)
- Config: add optional project name to config and update related documentation
- Andon: give the Mac app its menu bar and a remembered status bar toggle (032-andon-app-menu)
- Andon: add a native right-click menu on the sidebar's projects (033-project-context-menu)
- Andon: add the native Settings window with the status bar setting (035-andon-settings-window)
- Andon: hand needs-human commands to T3 Code (036-t3-handoff)
- Andon: show only close on Settings, as a child of the main window (037-settings-window-chrome)
- Andon: show merged tokens on one line with a largest-unit time (038-compact-merged-tokens)
- Contract: record the orchestrator's T3 Code thread as session (039-job-session-link)
- Contract: add optional session field for job events and update CLI usage
- Andon: open a job's orchestrator thread in T3 Code from its menu (040-job-context-menu)
- Andon: keep the sidebar connection footer on one line (041-sidebar-footer-oneline)
- Andon: align the sidebar footer with the status bar and fade the legend (042-footer-statusbar-align)
- Andon: show each app's own icon in the Open in submenu (043-open-in-app-icons)
- Skill: keep only open work in the backlog and commit each edit (044-backlog-open-only)
- CLI: archive terminal jobs on the factory/jobs orphan branch (045-job-archive)
- Andon: serve jobs found only on factory/archive (047-andon-reads-archive)
- CLI: add factory prune for archived, settled job dirs (048-job-prune)
- Andon: serve settled jobs on demand (049-settled-on-demand)
- Andon: fetch settled jobs on demand (050-settled-on-demand-ui)
- Contract: send merge conflicts back to the builder via merge.conflicted (051-merge-conflict-rework)
- Contract: add epics to factory/v1 and the CLI (052-epic-cli)
- Skill: drive epics from the skill and write plans in explore (053-epic-skill)
- Andon: serve epics and apply the epic-aware settle rule (054-andon-epics-service)
- Andon: show epics as sub-lanes, epic page, and epic-level waits (056-andon-epics-ui)
- Release: add bun run release to cut a version and CHANGELOG.md section (057-factory-release)
- Andon: report releases and the changelog (058-andon-version-service)
- Andon: show stale installs and What's New (059-andon-version-ui)

### Fixed

- Factory: narrow the merged event in a vendored test so strict tsc passes
- Skill: point the skill's dashboard line at Andon (012-skill-dashboard-pointer)
- Andon: reset all-Spaces pin on failure and show when state fails (018-shell-click-hardening)
- Andon: order the legend by workflow and limit text selection (034-andon-polish)
- Contract: settle abandoned jobs at once whatever their epic's state (055-abandoned-settles-at-once)
