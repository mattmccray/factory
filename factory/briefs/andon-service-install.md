# `factory service` installs and runs the Andon service

- Status: ready
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "`factory service install`", "Can the CLI be responsible for installing the andon service? … platform-aware … start/stop/restart"); brief `cli-global-install`; `docs/decisions.md` decision 10; `apps/andon/src/autostart.ts`; epic `factory/epics/factory-distribution.md`
- Date: 2026-10-30

## Intent
On any of Matt's machines, `factory service install` makes the Andon service a proper per-user
service that starts at login and survives crashes, on macOS and Linux alike, and `factory
service` starts, stops, restarts, and reports on it. The Mac app stops running the service
itself and becomes only a client of it.

## Decisions
1. Who owns the service process? → **The OS service manager, only: a launchd LaunchAgent on
   macOS, a systemd `--user` unit on Linux, both per-user with no `sudo`, started at login and
   restarted on a crash. The unit runs `factory service run` (the service in the foreground) by
   the absolute path of the `factory` that installed it, so a reinstall of the factory keeps it
   valid (and on a machine where `cli:link` owns `factory`, it runs the clone's source). The Mac
   app no longer spawns the service: when its probe finds none, it shows a notice naming
   `factory service install`.** Why: one owner, so the app's child and a launchd copy never
   race for the port; the service outlives the app, and a Linux box with no Mac app works the
   same way. The cost, accepted: a fresh Mac needs the one install command before the app shows
   a board.
2. The commands? → **`factory service install | uninstall | start | stop | restart | status |
   run`, on macOS and Linux:**
   - `install` writes the unit, enables it, and starts it; run again, it rewrites the unit and
     restarts (also how the service is re-pointed after switching between the global install and
     `cli:link`). If the port is held by a process that isn't the unit's service (an old
     app-spawned or terminal service), it refuses with that process's pid and writes nothing.
   - `uninstall` stops and disables it and removes the unit; the registry
     (`~/.andon/projects.json`) stays.
   - `start`, `stop`, `restart` pass through to `launchctl` / `systemctl --user`; `restart` is the
     answer to Andon's "restart needed".
   - `status` prints a short block: installed or not, running or not (pid), the URL, the running
     against the on-disk release, and where the logs are; it exits 0 only when running.
   - `run` is the service in the foreground: what the unit runs, and it replaces
     `bun run andon:service`.
   - `ANDON_PORT` and `ANDON_HOME`, when set at `install`, are recorded in the unit; else the
     defaults apply. Logs: launchd writes `~/.andon/service.log`; on Linux the journal, and
     `status` prints the `journalctl --user -u <unit>` line.
   - On Linux, `install` checks lingering and, when it's off, prints the one-line
     `loginctl enable-linger` hint (a headless box's user services stop at logout without it);
     it never changes that itself.
   - Any other platform, or Linux without systemd: a one-line refusal, nothing written. No
     command ever uses `sudo`.
   - The unit's label is `dev.factory.andon` (launchd) and its name `andon.service` (systemd).
   Why: Matt's set; idempotent install keeps re-pointing simple, and lingering is a system
   setting the CLI shouldn't flip.

## Facts (2026-10-30)
- The service serves the UI from `apps/andon-ui/dist` and reports its release and
  `CHANGELOG.md` from the tree it runs in (`packages/andon-service/src/main.ts`); `GET /release`
  `onDisk` differing from `running` already means "restart needed" in Andon.
- The Mac app has its clone's path built in (`__ANDON_REPO__`) and spawns
  `bun <repo>/packages/andon-service/src/main.ts` when `GET /projects` doesn't answer, stopping on
  quit only a service it started (`apps/andon/src/autostart.ts`).
- The service listens on `127.0.0.1` only. Reaching a Linux box's board from elsewhere is the
  multi-machine work, not this brief.

## Scope
- In: `factory service …` in the CLI (`packages/cli`), with the launchd plist and systemd unit
  rendering and the platform's command lines in a pure, `bun:test`-covered module (the
  `launchctl`/`systemctl`/`loginctl` calls injected); the service's entry callable as `service
  run` from both the source tree and the release bundle; `apps/andon` dropping its spawn and
  stop-on-quit (`autostart.ts`) for a probe and a "run `factory service install`" notice, with its
  tests; `docs/contract/v1.md` "CLI" gaining the commands (additive); README "Andon" and
  `docs/upgrade.md` updated (`bun run andon:service` gives way to `factory service run`).
- Out: multi-machine access; installing the Mac app; pruning the registry (brief
  `registry-prune`)

## Acceptance sketch
- On macOS, `factory service install` leaves a LaunchAgent `dev.factory.andon` that runs the
  installing `factory`'s `service run`, starts at login, and restarts after a kill; the board
  answers on `127.0.0.1:8766` (or the recorded `ANDON_PORT`).
- On Linux with systemd, the same through a `--user` unit `andon.service`, and the lingering hint
  when lingering is off.
- Running `install` again rewrites and restarts; `uninstall` removes the unit and leaves the
  registry; `start`/`stop`/`restart` do what they say; `status` reports as decided and exits 0
  only when running.
- `install` with the port held by another process refuses with its pid and writes nothing.
- An unsupported platform refuses in one line and writes nothing; nothing uses `sudo`.
- The Mac app, with no service answering, shows the "run `factory service install`" notice and
  spawns nothing; quitting it never stops the service.
- The rendering and command building are unit-tested for both platforms on any machine.

## Contract calls
"`docs/contract/v1.md` "CLI" gains `factory service install | uninstall | start | stop |
restart | status | run`, an additive change within v1", approved by Matt on 2026-10-30. The job
updates the contract doc and its dated changes list to match.

## Open
None.
