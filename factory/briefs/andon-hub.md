# The Andon service as a hub for Matt's other machines

- Status: ready
- Sources: the explore request of 2026-10-30; epic plan `factory/epics/andon-multi-machine.md`; brief `andon-peer-access`; decision 10 in `docs/decisions.md`; `docs/contract/v1.md`, "Andon registry" and "Andon service"
- Date: 2026-10-30

## Intent
A machine's Andon service follows the services on Matt's other machines and serves their projects
alongside its own: one `/projects`, one `/events`, every board and doc, with each machine's status.
The UI and the Mac app keep their one connection to the local service and see every machine.

## Facts (2026-10-30)
- A project's id is the first 12 hex characters of `sha256(root)` (`projectId`,
  `packages/andon-service/src/index.ts`): unique only within one machine.
- The UI and the Mac app address everything as `/projects/<pid>/…` and fetch with relative paths.
- The registry (`$ANDON_HOME/projects.json`, contract "Andon registry") is one file per machine,
  written by the CLI (temp file plus rename), watched by the service, and only read by Andon.
- Peers are reached as brief `andon-peer-access` decides: `https://<machine>.manticore-hue.ts.net:<port>/`.

## Decisions
1. Where is a hub's list of peers, and how does a machine get onto it? → **A peers file beside the
   registry, `$ANDON_HOME/peers.json` (`{ "schema": "factory/v1", "peers": [{ "url": "https://studio.manticore-hue.ts.net:8766" }] }`),
   written only by a new `factory peers add <machine|url> | remove <machine|url> | list`. `add`
   resolves a short machine name through `tailscale status --json`, checks the peer answers
   `GET /projects`, and writes the entry (temp file plus rename, as the registry is). The service
   watches the file, as it watches the registry, so a change applies with no restart. Andon never
   edits it.** Why: it mirrors the registry Matt already uses; the service stays read-only; it
   works the same on the Macs, the Linux boxes, and for the iPad's browser; tailnet discovery would
   pull in every device (agent boxes, the phone).
2. What does a hub re-serve? → **One hop: only each peer's own projects. A hub asks its peers for
   their local projects only (e.g. `GET /projects?scope=local` and the same narrowing on
   `/events`), and never passes on what it follows.** Why: every machine can list every other and
   be a full hub with no cycles or duplicates, so the iPad can point at any of them; the cost is a
   peer list per hub, a few `factory peers add` runs.
3. Machine names and remote ids → **Each service has a machine name: the first label of its
   recorded tailnet host (`studio`) when `--tailnet` is on, else the first label of the OS
   hostname, lowercased. Every `/projects` entry gains `machine` (the hub's own name for local
   projects). Local projects keep their bare 12-hex ids; a peer's project is served as
   `<pid>@<machine>` (e.g. `1a2b3c4d5e6f@studio`) on the same `/projects/<id>/…` routes, and the
   hub strips the suffix when it forwards to the peer. Two peers reporting the same name, or a peer
   reporting the hub's own name: `factory peers add` refuses it, and at runtime the later one is
   shown in error and not merged.** Why: routes, the UI, and the Mac app keep addressing projects
   as today, and nothing stored changes; `@` never appears in a hex id, so the split is never
   ambiguous; machine-scoped routes would rewrite every path builder for nothing.
4. A peer that's down → **The hub adds machines as their own data: `GET /machines` and a `machines`
   event, each entry `{ name, url, state: live | connecting | down, since, reason }`, the hub's own
   machine always listed and `live`. A peer that drops keeps its projects listed with their last
   boards (stale, as its machine's state says), never removed; a doc request for one is a 502
   naming the machine. Reconnects back off from 3 s to about 60 s. A hub that restarts while a peer
   is down lists that machine `down` with no projects; nothing about peers is persisted.** Why: a
   Wi-Fi blip or a sleeping Studio shouldn't make a needs-human job vanish and reappear as new; the
   last known state, clearly marked, is more honest than an empty lane; persisting it adds state
   to manage for a rare case.
5. A peer on another release → **Pass its boards, docs, and events through unchanged; the machine
   entry gains `release` (the peer's running version, from its `GET /release`). Only a peer too old
   to be one (its `/projects` has no `machine`, or it ignores `scope=local`) is marked `error` with a
   reason naming `factory upgrade` and `factory service restart` on that machine, and nothing of it
   is merged.** Why: machines will drift as Matt promotes one before the others; v1 is additive
   only and the UI ignores unknown fields, so the only real incompatibility is a pre-epic peer, and
   it gets a clear message.

## Defaults (not questioned; the spec-writer may refine)
- Every stream the service serves today (plain `/events` and `/events?settled=summary`) carries
  peer projects in its own shape, so the Mac app's follower and the UI both see them; a hub follows
  each peer with as few streams as that needs, and never polls.
- On-demand reads of a peer's project (settled, docs, backlog, briefs, plans) are forwarded to the
  peer when asked, not cached ahead.
- `/release` and its `release` event stay the hub's own (its clone, its "restart needed"); a peer's
  release shows only on its machine entry.
- The hub reaches peers only at the URLs in `peers.json`, over HTTPS; it follows no redirect to
  another host.

## Scope
- In: `packages/contract` (the `peers.json` parse, add, and remove helpers, beside `registry.ts`),
  `packages/cli` (`factory peers add | remove | list`), `packages/andon-service` (the machine name,
  `machine` on `/projects`, `scope=local`, following peers, the merged projects, boards, events,
  and forwarded reads, `/machines` and its event), the contract doc, and tests (peers faked as
  local HTTP servers; `tailscale` faked).
- Out: UI and Mac app changes (briefs `andon-machines-ui`, `andon-machines-mac`); editing peers
  from Andon.

## Acceptance sketch
- `factory peers add studio` resolves `studio` through Tailscale, checks the peer answers, and
  writes `peers.json`; `add` of an unreachable, non-Andon, too-old, or same-named peer refuses with
  one line and writes nothing; `remove` and `list` work by name or URL; a bad `peers.json` is a
  one-line reason, as a bad registry is.
- With Studio listed, Rocinante's `/projects` lists its own projects (bare ids, `machine:
  "rocinante"`) and Studio's (`<pid>@studio`, `machine: "studio"`); Studio's boards, settled jobs,
  docs, backlog, briefs, and plans are readable through Rocinante at the usual routes, and a change
  on Studio reaches Rocinante's `/events` clients with no polling.
- Rocinante and Studio listing each other show each project exactly once on each (one hop).
- `/machines` and the `machines` event list every machine with its state and release; stopping
  Studio's service marks it `down` within a reconnect, keeps its last boards listed, and makes its
  doc reads a 502 naming it; starting it again brings it back `live` with fresh boards.
- A peer from before this epic shows `error` with the upgrade reason, and none of it is merged.
- With no `peers.json`, the service behaves exactly as before, apart from `machine` on `/projects`
  and a `/machines` listing only itself.

## Contract calls
- A new "Andon peers" section: `$ANDON_HOME/peers.json` (its schema, written only by the CLI, temp
  file plus rename, read and watched by the service), and a new "`peers`" command section
  (`factory peers add | remove | list`); additive within v1. Approved by Matt on 2026-10-30.
- "Andon service": the machine name; `machine` on each `/projects` entry; `scope=local` on
  `/projects` and `/events`; peer projects as `<pid>@<machine>` on every endpoint and event; the
  forwarded reads (a 502 naming the machine when it's down); `GET /machines` and the `machines`
  event; additive within v1. Approved by Matt on 2026-10-30.
- The job updates `docs/contract/v1.md` for both, and decision 10 in `docs/decisions.md` (a service
  may follow its peers' services, one hop, still read-only).

## Open
None.
