# Token spend per job and phase

- Status: done
- Landed: 78b2f84 (2026-11-02)
- Sources: `/factory explore` on token visibility (2026-11-02); Claude Code transcripts
- Date: 2026-11-02

## Intent
See how many tokens each job spends, broken down by lifecycle phase (spec, build per round, each
reviewer per round, approver, and the orchestrator), kept in the job's record so it outlives
Claude Code's transcript cleanup. The CLI records it and `factory show` prints it; Andon then
shows it next to the timing.

## Members
- `token-spend-record` — the contract change, the CLI reading transcripts at span close, the `job.json` and `epic.json` rollups, the skill passing `agentId`, and a usage table in `factory show`
- `token-spend-andon` — Andon shows token spend next to timing in the inspector, with job and epic totals after: `token-spend-record`
