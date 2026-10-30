# Factory distribution

- Status: done
- Landed: 8e7ec65 (2026-10-30)
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Prepare for publishing", "an easy/polished way to install the service", "Can the CLI be responsible for installing the andon service?"); `docs/decisions.md` decisions 6 and 10, and the Deferred list
- Date: 2026-10-30

## Intent
Getting the factory onto one of Matt's machines (the Mac Studio, the Linux boxes) stops meaning
"clone the repo and run scripts from it": the CLI installs globally from GitHub, and it installs,
starts, stops, and restarts the Andon service on macOS and Linux, and prunes registered projects
whose paths are gone. Together because the service commands need the globally installed CLI to
live in, and the set is what "installable on my own machines" means.

## Members
- `cli-global-install` — the factory CLI installs globally from GitHub, and `init` and `upgrade` work from that install
- `andon-service-install` — `factory service install | start | stop | restart | status` on macOS (launchd) and Linux (systemd `--user`); the Mac app stops spawning the service from a clone after: `cli-global-install`
- `registry-prune` — `factory projects` lists registered projects with their state, `projects prune` removes dead ones, and `projects remove <path>` removes one by hand
