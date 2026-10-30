# Factory versioning

- Status: draft
- Sources: the explore request of 2026-10-29 (versioning, a stale-version indicator in Andon, an automated changelog shown in Andon)
- Date: 2026-10-29

## Intent
The factory gets one real release version, cut at promotion with a generated, user-facing
changelog, and Andon quietly shows which projects run an older release than their machine,
what they're missing, and when the Andon service needs a restart. Together because the service
and UI only mean something once releases and the changelog exist, and the whole set lands as
one change.

## Members
- `factory-release` — the `bun run release` script, `CHANGELOG.md` and its baseline, the versioning decision, and the promotion docs
- `andon-version-service` — the service reports its running and on-disk release, each project's installed version and state, and the parsed changelog
- `andon-version-ui` — the sidebar's quiet stale glyph, the footer's release and restart note, the "What's New" sheet, and Help → What's New after: `andon-version-service`
