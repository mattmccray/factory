# An Andon service reachable from Matt's other machines

- Status: done
- Job: 078-andon-peer-access (merged e9f988b via epic andon-multi-machine, 2026-10-30)
- Sources: the explore request of 2026-10-30; epic plan `factory/epics/andon-multi-machine.md`; decision 10 and the Deferred list in `docs/decisions.md`; `docs/contract/v1.md`, "Andon service"
- Date: 2026-10-30

## Intent
A machine's Andon service can be read from Matt's other machines over his tailnet, so another
machine's service (the hub, brief `andon-hub`) or a browser can follow its projects. It stays
read-only, and nothing reaches it from outside the tailnet.

## Facts (2026-10-30)
- The service listens on `127.0.0.1` only (`$ANDON_PORT`, default 8766) and 403s any request whose
  `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, or whose `Origin` isn't `http://` plus one
  of those (the DNS-rebinding guard; contract "Andon service").
- Machines: Rocinante (this MacBook Pro), Studio (a Mac Studio), agentbox (Ubuntu Server), and maybe
  goliath (Omarchy Linux). All are on Matt's tailnet, `manticore-hue.ts.net` (one user plus tagged
  devices; agentbox is tagged `tag:agent-box`); Tailscale 1.104 is installed on Rocinante, with no
  `tailscale serve` config yet.
- `tailscale serve` forwards `Tailscale-User-*` identity headers only for user-owned devices, never
  for tagged ones.
- A later wish, not in this epic's scope yet: an iPad on the tailnet showing the board in a
  browser as a dashboard.

## Decisions
1. How does one machine reach another? → **Over the tailnet only: each service stays bound to
   loopback and is published with `tailscale serve` (`https://<machine>.<tailnet>.ts.net` →
   `127.0.0.1:<port>`).** Why: every machine is on the tailnet; it gives HTTPS with real
   certificates, tailnet-only reach, and a per-request identity for free, and the service never
   binds a non-loopback address.
2. Who may read? → **Any device on the tailnet; no identity check in the service.** Why: Matt's
   single-user tailnet and a read-only service; checking `Tailscale-User-Login` would refuse
   tagged devices (agentbox is `tag:agent-box`), and an allowlist would duplicate Tailscale ACLs,
   which are where to narrow it if ever wanted.
3. Who sets it up, and how does the service know its name? → **An opt-in
   `factory service install --tailnet`: it finds the `tailscale` CLI, reads the machine's own
   MagicDNS name from `tailscale status --json` (e.g. `studio.manticore-hue.ts.net`), records it in
   the unit beside `ANDON_PORT` (e.g. `ANDON_TAILNET_HOST`), and runs
   `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`. The service then also accepts
   exactly that `Host` (with the HTTPS port) and the matching `https://` `Origin`; never any other
   `*.ts.net` name. `uninstall` removes that serve entry; `status` adds the tailnet URL; `install`
   without the flag leaves tailnet access off (and turns it off when it was on). On Linux, when
   `tailscale serve` needs an operator, `install --tailnet` prints the one-time
   `sudo tailscale set --operator=$USER` line and stops, never running `sudo`.** Why: one command
   per machine, and the guard and the serve entry can't drift; the HTTPS port mirrors the service
   port (8766) so other `tailscale serve` setups on 443 are untouched; an exact name keeps the
   DNS-rebinding guard tight (a Funnel name resolves publicly).
4. What may a tailnet reader read? → **Everything a loopback client may, behind the same guards
   (`GET` only, `cache-control: no-store`): `/projects`, boards, settled, docs, backlog, briefs,
   plans, `/release`, `/events`, and the built UI at `/`.** Why: the hub must serve remote jobs'
   docs to the inspector, and serving the UI lets any tailnet browser (the iPad) open a machine's
   board with no more work. Briefs and docs can hold pasted material; Matt accepted that every
   tailnet device can read it.

## Scope
- In: `packages/cli` (`service install --tailnet`, `uninstall`, `status`, and the unit's
  recorded name), `packages/andon-service` (the guard accepting the recorded tailnet host), the
  contract doc, `docs/decisions.md` (the amendment below), and tests (the `tailscale` CLI and the
  service manager faked, as `service`'s tests already fake launchd and systemd).
- Out: a public or LAN listen address; a hub or any merging (brief `andon-hub`); UI and Mac app
  changes.

## Acceptance sketch
- On a machine with Tailscale, `factory service install --tailnet` leaves the service on loopback,
  publishes it with `tailscale serve` on HTTPS port `<port>`, and records the machine's MagicDNS
  name in the unit; from another tailnet machine, `curl https://<machine>.<tailnet>.ts.net:<port>/projects`
  returns the projects, and a browser there loads the board at `/`.
- A request naming any other host (another `*.ts.net` name, a LAN IP, a rebinding domain), or an
  `Origin` other than the loopback ones or `https://<recorded name>:<port>`, is still a 403; a
  non-`GET` is still refused.
- Without `--tailnet`, the unit, the guard, and `tailscale serve` are as before; re-running
  `install` without it removes the serve entry and the recorded name.
- `install --tailnet` with no `tailscale` CLI, Tailscale logged out, HTTPS certificates not
  enabled on the tailnet, or (Linux) no operator permission refuses with one line naming the cause
  (for the operator, the `sudo tailscale set --operator=$USER` line to run), and leaves nothing
  half-done: no recorded name without a serve entry, nor the reverse.
- `uninstall` removes the serve entry it made; `status` prints the tailnet URL when it's on.
- No command runs `sudo`; the service never binds a non-loopback address.

## Contract calls
- "Andon service": the `Host`/`Origin` guard also accepts the unit's recorded tailnet host
  (`<name>:<port>`, `Origin` `https://<name>:<port>`) when one is recorded; additive within v1.
  Approved by Matt on 2026-10-30. The job updates `docs/contract/v1.md`, "Andon service".
- "`service`": `install --tailnet`, the recorded tailnet host in the unit, `uninstall` removing
  its serve entry, and `status`'s tailnet URL; additive within v1. Approved by Matt on 2026-10-30.
  The job updates `docs/contract/v1.md`, "`service`".
- Decision 10 is amended: a machine's Andon service may be read from Matt's other machines over
  his tailnet through `tailscale serve`, still bound to loopback and read-only, opted into with
  `factory service install --tailnet`; and "Andon across multiple machines" leaves the Deferred
  list (epic `andon-multi-machine` builds it). Approved by Matt on 2026-10-30. The job updates
  `docs/decisions.md`.

## Open
None.
