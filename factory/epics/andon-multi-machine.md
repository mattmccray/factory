# Andon across machines

- Status: ready
- Sources: the explore request of 2026-10-30 ("Add support for monitoring jobs from other machines" and the re-architecture discussion); decision 10 and the Deferred list in `docs/decisions.md`; `docs/contract/v1.md`, "Andon service"
- Date: 2026-10-30

## Intent
Andon shows the factory jobs running on Matt's other machines alongside the local ones: one board,
grouped by machine, with each machine's status, and the tray badge and notifications covering them
all. The local Andon service is the hub: it follows its peers' services and re-serves one merged
board, so the UI stays served by the service (browsers and Linux keep working) and the Mac app stays
thin (decision 10).

## Members
- `andon-peer-access` — a machine's Andon service can be read from Matt's other machines over his tailnet (`tailscale serve`), still on loopback and read-only
- `andon-hub` — the local service follows its configured peers and merges their projects and events into its own, machine-prefixed, with each machine's status after: `andon-peer-access` maxRound: 3
- `andon-machines-ui` — the Andon UI groups projects by machine, shows each machine's status, and handles actions that can't run on a remote project after: `andon-hub`
- `andon-machines-mac` — the Mac app's badge and notifications cover remote jobs, and its native menus are gated for remote projects after: `andon-hub`
