// factory 0.1.0 · managed file, do not edit: it is replaced on upgrade. Project settings go in the overlay: factory/config.json
// packages/cli/src/core.ts
import { readFile as readFile3 } from "fs/promises";
import { join as join4 } from "path";

// packages/contract/src/contract.ts
var MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
var RUNNERS = ["claude"];
var SCHEMA = "factory/v1";
var JOB_ID = /^\d{3}-[a-z0-9-]+$/;
var REVIEWER_KEY = /^[a-z][a-z0-9-]*$/;
var RESERVED_KEYS = ["spec-writer", "builder", "approver"];
var ROLES = ["spec-writer", "builder", "reviewer", "approver"];
var ENTERED = ["spec", "build", "approve"];
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isPosInt = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
function noExtraKeys(obj, allowed, what) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length)
    throw new Error(`${what}: unknown key ${extra.map((k) => `'${k}'`).join(", ")}`);
}
function parseConfig(raw) {
  if (!isRecord(raw))
    throw new Error("config: must be a JSON object");
  noExtraKeys(raw, ["schema", "reviewers", "maxRound", "dashboard", "gate", "roles"], "config");
  if (raw.schema !== SCHEMA)
    throw new Error(`config: schema must be "${SCHEMA}"`);
  const { reviewers, maxRound, dashboard } = raw;
  if (!Array.isArray(reviewers) || reviewers.length === 0)
    throw new Error("config: reviewers must be a non-empty array");
  const keys = [];
  for (const k of reviewers) {
    if (typeof k !== "string" || !REVIEWER_KEY.test(k))
      throw new Error(`config: bad reviewer key ${JSON.stringify(k)} (want ^[a-z][a-z0-9-]*$)`);
    if (RESERVED_KEYS.includes(k))
      throw new Error(`config: reviewer key '${k}' is reserved`);
    if (keys.includes(k))
      throw new Error(`config: duplicate reviewer key '${k}'`);
    keys.push(k);
  }
  if (!isPosInt(maxRound))
    throw new Error("config: maxRound must be a positive integer");
  if (!isRecord(dashboard))
    throw new Error("config: dashboard must be an object");
  noExtraKeys(dashboard, ["settleAfterHours"], "config.dashboard");
  const settle = dashboard.settleAfterHours;
  if (typeof settle !== "number" || !(settle > 0))
    throw new Error("config: dashboard.settleAfterHours must be a positive number");
  const config = { schema: SCHEMA, reviewers: keys, maxRound, dashboard: { settleAfterHours: settle } };
  if (raw.gate !== undefined)
    config.gate = parseGate(raw.gate);
  if (raw.roles !== undefined)
    config.roles = parseRoles(raw.roles, keys);
  return config;
}
function parseRoles(roles, reviewers) {
  if (!isRecord(roles))
    throw new Error("config: roles must be an object mapping a role name to { runner, model? }");
  const out = {};
  for (const [name, entry] of Object.entries(roles)) {
    const what = `config: roles.${REVIEWER_KEY.test(name) ? name : JSON.stringify(name)}`;
    if (!RESERVED_KEYS.includes(name) && !reviewers.includes(name)) {
      throw new Error(`${what}: unknown role (want ${[...RESERVED_KEYS, ...reviewers].join(", ")})`);
    }
    if (!isRecord(entry))
      throw new Error(`${what}: must be an object { runner, model? }`);
    noExtraKeys(entry, ["runner", "model"], what);
    if (entry.runner === undefined)
      throw new Error(`${what}: runner is required`);
    const runner = RUNNERS.find((r) => r === entry.runner);
    if (runner === undefined)
      throw new Error(`${what}: runner must be ${RUNNERS.map((r) => `"${r}"`).join(" or ")}`);
    const parsed = { runner };
    if (entry.model !== undefined) {
      const model = entry.model;
      if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
        throw new Error(`${what}: model must be a non-empty string matching ${MODEL_PATTERN.source}`);
      }
      parsed.model = model;
    }
    out[name] = parsed;
  }
  return out;
}
function parseGate(gate) {
  if (!Array.isArray(gate) || gate.length === 0)
    throw new Error("config: gate must be a non-empty array of command strings");
  const commands = [];
  for (const [i, c] of gate.entries()) {
    if (typeof c !== "string" || c.trim() === "")
      throw new Error(`config: gate[${i}] must be a non-empty command string`);
    commands.push(c);
  }
  return commands;
}
function str(f, k) {
  const v = f[k];
  if (typeof v !== "string" || v === "")
    throw new Error(`missing or non-string field '${k}'`);
  return v;
}
function optStr(f, k) {
  return f[k] === undefined ? undefined : str(f, k);
}
function nullableStr(f, k) {
  return f[k] === undefined || f[k] === null ? null : str(f, k);
}
function posInt(f, k) {
  const v = f[k];
  if (!isPosInt(v))
    throw new Error(`field '${k}' must be a positive integer`);
  return v;
}
function oneOf(f, k, allowed) {
  const v = str(f, k);
  const hit = allowed.find((a) => a === v);
  if (hit === undefined)
    throw new Error(`field '${k}' must be one of ${allowed.join("|")}`);
  return hit;
}
function reviewerKey(f, k) {
  const v = str(f, k);
  if (!REVIEWER_KEY.test(v))
    throw new Error(`bad reviewer key '${v}'`);
  return v;
}
function agentIdentity(f) {
  const role = oneOf(f, "role", ROLES);
  const name = optStr(f, "name");
  const id = { role };
  if (role === "reviewer") {
    id.key = reviewerKey(f, "key");
    id.round = posInt(f, "round");
  } else if (f.key !== undefined)
    throw new Error(`field 'key' is only for role 'reviewer'`);
  else if (f.round !== undefined)
    id.round = posInt(f, "round");
  if (name !== undefined)
    id.name = name;
  return id;
}
function parseEventInput(type, fields, ctx) {
  const allow = (...keys) => noExtraKeys(fields, keys, `${type}: extra field`);
  switch (type) {
    case "job.claimed": {
      allow("brief", "issue", "maxRound");
      if (!ctx)
        throw new Error("job.claimed: needs the job id and config from the CLI");
      const maxRound = fields.maxRound === undefined ? ctx.config.maxRound : posInt(fields, "maxRound");
      return { type, schema: SCHEMA, id: ctx.id, maxRound, brief: nullableStr(fields, "brief"), issue: nullableStr(fields, "issue") };
    }
    case "job.titled":
      allow("title");
      return { type, title: str(fields, "title") };
    case "stage.entered":
      allow("stage");
      return { type, stage: oneOf(fields, "stage", ENTERED) };
    case "round.started": {
      allow("round", "reviewers");
      if (fields.reviewers === undefined && !ctx)
        throw new Error(`round.started: field 'reviewers' needs the config from the CLI`);
      const list = fields.reviewers === undefined && ctx ? ctx.config.reviewers : fields.reviewers;
      if (!Array.isArray(list) || list.length === 0)
        throw new Error(`field 'reviewers' must be a non-empty array`);
      const reviewers = list.map((r) => reviewerKey({ r }, "r"));
      if (new Set(reviewers).size !== reviewers.length)
        throw new Error(`field 'reviewers' has duplicates`);
      return { type, round: posInt(fields, "round"), reviewers };
    }
    case "agent.started":
      allow("role", "key", "round", "name");
      return { type, ...agentIdentity(fields) };
    case "agent.finished":
      allow("role", "key", "round", "name");
      return { type, ...agentIdentity(fields) };
    case "job.noted":
      allow("note");
      return { type, note: str(fields, "note") };
    case "job.escalated":
      allow("reason");
      return { type, reason: str(fields, "reason") };
    case "job.reworked":
      allow("k", "maxRound");
      return { type, k: posInt(fields, "k"), maxRound: posInt(fields, "maxRound") };
    case "job.human-approved":
      allow();
      return { type };
    case "merge.failed":
      allow("reason");
      return { type, reason: str(fields, "reason") };
    case "job.merged":
      allow("sha");
      return { type, sha: str(fields, "sha") };
    default:
      throw new Error(`unknown event type '${type}'`);
  }
}
function derive(prior) {
  const s = { stage: null, round: 0, maxRound: 0, reviewers: [], finished: new Set, humanApproved: false };
  for (const e of prior) {
    switch (e.type) {
      case "job.claimed":
        s.stage = "claimed";
        s.maxRound = e.maxRound;
        break;
      case "stage.entered":
        s.stage = e.stage;
        break;
      case "round.started":
        s.stage = "review";
        s.round = e.round;
        s.reviewers = e.reviewers;
        s.finished = new Set;
        break;
      case "agent.finished":
        if (e.role === "reviewer" && e.key !== undefined && e.verdict !== undefined && e.round === s.round)
          s.finished.add(e.key);
        break;
      case "job.escalated":
        s.stage = "needs-human";
        s.humanApproved = false;
        break;
      case "job.reworked":
        s.stage = "build";
        s.maxRound = e.maxRound;
        s.humanApproved = false;
        break;
      case "job.human-approved":
        s.humanApproved = true;
        break;
      case "merge.failed":
        s.stage = "needs-human";
        s.humanApproved = false;
        break;
      case "job.merged":
        s.stage = "merged";
        break;
      default:
        break;
    }
  }
  return s;
}
function fail(msg) {
  throw new Error(msg);
}
function checkTransition(prior, next) {
  const s = derive(prior);
  const { stage } = s;
  if (stage === null) {
    if (next.type !== "job.claimed")
      fail(`no log yet: only job.claimed is allowed, got ${next.type}`);
    if (!JOB_ID.test(next.id))
      fail(`job id '${next.id}' must match ^\\d{3}-[a-z0-9-]+$`);
    if (next.schema !== SCHEMA)
      fail(`schema must be "${SCHEMA}"`);
    if (!isPosInt(next.maxRound))
      fail("maxRound must be a positive integer");
    return;
  }
  if (stage === "merged")
    fail(`job is merged (terminal): ${next.type} not allowed`);
  const bad = () => fail(`${next.type} not allowed from stage '${stage}'`);
  switch (next.type) {
    case "job.claimed":
      return bad();
    case "job.noted":
    case "job.titled":
    case "agent.started":
    case "agent.finished":
      return;
    case "stage.entered": {
      if (next.stage === "spec")
        return stage === "claimed" ? undefined : bad();
      if (next.stage === "build") {
        if (stage === "spec")
          return;
        if (stage !== "review")
          return bad();
        requireComplete(s);
        if (s.round >= s.maxRound)
          fail(`round ${s.round} has reached maxRound ${s.maxRound}: cannot enter build again`);
        return;
      }
      if (stage !== "review")
        return bad();
      return requireComplete(s);
    }
    case "round.started":
      if (stage !== "build")
        return bad();
      if (next.round !== s.round + 1)
        fail(`round must be previous + 1 (${s.round + 1}), got ${next.round}`);
      return;
    case "job.escalated":
      return stage === "needs-human" ? bad() : undefined;
    case "merge.failed":
      if (stage === "approve")
        return;
      if (stage === "needs-human" && s.humanApproved)
        return;
      return bad();
    case "job.merged":
      if (stage === "approve" || stage === "needs-human" && s.humanApproved)
        return;
      return stage === "needs-human" ? fail("job.merged from needs-human requires job.human-approved first") : bad();
    case "job.reworked":
      return stage === "needs-human" ? undefined : bad();
    case "job.human-approved":
      return stage === "needs-human" ? undefined : bad();
  }
}
function requireComplete(s) {
  const waiting = s.reviewers.filter((r) => !s.finished.has(r));
  if (waiting.length)
    fail(`round ${s.round} is not complete, waiting on: ${waiting.join(", ")}`);
}
// packages/contract/src/project.ts
var ms = (from, to) => Date.parse(to) - Date.parse(from);
function enterStage(s, stage, ts) {
  if (s.stage === stage && s.timing.stages.length > 0)
    return;
  const open = s.timing.stages[s.timing.stages.length - 1];
  if (open && open.exitedAt === null) {
    open.exitedAt = ts;
    open.ms = ms(open.enteredAt, ts);
  }
  s.stage = stage;
  s.stageEnteredAt = ts;
  s.timing.stages.push({ stage, round: s.round, enteredAt: ts, exitedAt: null, ms: null });
}
function sameAgent(a, role, key, round, name) {
  return a.role === role && a.key === key && a.round === round && a.name === name;
}
function apply(s, e) {
  s.updated = e.ts;
  switch (e.type) {
    case "job.claimed":
      return;
    case "job.titled":
      s.title = e.title;
      return;
    case "stage.entered":
      enterStage(s, e.stage, e.ts);
      return;
    case "round.started": {
      if (s.round > 0)
        s.history.push({ round: s.round, reviews: s.reviews });
      s.round = e.round;
      s.reviews = Object.fromEntries(e.reviewers.map((k) => [k, "pending"]));
      enterStage(s, "review", e.ts);
      return;
    }
    case "agent.started": {
      const name = e.name ?? null;
      if (e.role === "builder" && name !== null)
        s.builder = name;
      s.timing.agents.push({
        role: e.role,
        key: e.key ?? null,
        round: e.round ?? null,
        name,
        startedAt: e.ts,
        finishedAt: null,
        ms: null,
        verdict: null
      });
      return;
    }
    case "agent.finished": {
      const key = e.key ?? null;
      const round = e.round ?? null;
      const name = e.name ?? null;
      const verdict = e.verdict ?? null;
      let span;
      for (let i = s.timing.agents.length - 1;i >= 0; i--) {
        const a = s.timing.agents[i];
        if (a && a.finishedAt === null && sameAgent(a, e.role, key, round, name)) {
          span = a;
          break;
        }
      }
      if (!span) {
        span = { role: e.role, key, round, name, startedAt: e.ts, finishedAt: null, ms: null, verdict: null };
        s.timing.agents.push(span);
      }
      span.finishedAt = e.ts;
      span.ms = ms(span.startedAt, e.ts);
      span.verdict = verdict;
      if (e.role === "reviewer" && key !== null && (verdict === "PASS" || verdict === "CHANGES")) {
        if (round === s.round && Object.hasOwn(s.reviews, key))
          s.reviews[key] = verdict;
      } else if (e.role === "approver" && (verdict === "APPROVE" || verdict === "ESCALATE")) {
        s.decision = verdict;
      }
      return;
    }
    case "job.noted":
      s.note = e.note;
      return;
    case "job.escalated":
      for (const a of s.timing.agents) {
        if (a.finishedAt === null) {
          a.finishedAt = e.ts;
          a.ms = ms(a.startedAt, e.ts);
        }
      }
      s.note = e.reason;
      enterStage(s, "needs-human", e.ts);
      return;
    case "merge.failed":
      s.note = e.reason;
      enterStage(s, "needs-human", e.ts);
      return;
    case "job.reworked":
      s.reworks = e.k;
      s.maxRound = e.maxRound;
      s.decision = null;
      s.note = "";
      enterStage(s, "build", e.ts);
      return;
    case "job.human-approved":
      s.decision = "APPROVE (human)";
      return;
    case "job.merged":
      s.endedAt = e.ts;
      s.note = `merged ${e.sha}`;
      enterStage(s, "merged", e.ts);
      return;
  }
}
function project(events) {
  const first = events[0];
  if (!first || first.type !== "job.claimed")
    throw new Error("event log must start with job.claimed");
  const snapshot = {
    schema: first.schema,
    id: first.id,
    title: first.id,
    branch: `factory/${first.id}`,
    builder: null,
    stage: "claimed",
    round: 0,
    maxRound: first.maxRound,
    reviews: {},
    history: [],
    reworks: 0,
    decision: null,
    note: "",
    brief: first.brief,
    issue: first.issue,
    startedAt: first.ts,
    stageEnteredAt: first.ts,
    endedAt: null,
    updated: first.ts,
    timing: { stages: [{ stage: "claimed", round: 0, enteredAt: first.ts, exitedAt: null, ms: null }], agents: [] }
  };
  for (const e of events.slice(1))
    apply(snapshot, e);
  return snapshot;
}
// packages/contract/src/store.ts
import { appendFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "fs/promises";
import { join } from "path";
var LOCK_STALE_MS = 30000;
var LOCK_RETRY_MS = 25;
var JOB_ID2 = /^\d{3}-[a-z0-9-]+$/;
function jobDir(root, id) {
  if (!JOB_ID2.test(id))
    throw new Error(`job id '${id}' must match ^\\d{3}-[a-z0-9-]+$`);
  return join(root, "jobs", id);
}
var logPath = (root, id) => join(jobDir(root, id), "events.jsonl");
var isNotFound = (e) => typeof e === "object" && e !== null && ("code" in e) && e.code === "ENOENT";
var isExists = (e) => typeof e === "object" && e !== null && ("code" in e) && e.code === "EEXIST";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseLine(line, n) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`events.jsonl line ${n} is not valid JSON`);
  }
  if (!isEvent(raw))
    throw new Error(`events.jsonl line ${n} is not a factory event`);
  return raw;
}
function isEvent(v) {
  return typeof v === "object" && v !== null && "ts" in v && typeof v.ts === "string" && "type" in v && typeof v.type === "string";
}
async function readLog(root, id) {
  let text;
  try {
    text = await readFile(logPath(root, id), "utf8");
  } catch (e) {
    if (isNotFound(e))
      return [];
    throw e;
  }
  const lines = text.split(`
`);
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines.map((line, i) => parseLine(line, i + 1));
}
async function readVerdict(path, allowed) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isNotFound(e))
      throw new Error(`${path}: missing`);
    throw e;
  }
  const first = text.split(`
`).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const hit = allowed.find((a) => a === first);
  if (hit === undefined)
    throw new Error(`${path}: first line must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  return hit.replace(/^VERDICT: /, "");
}
var REVIEW_VERDICTS = ["PASS", "CHANGES"];
var DECISION_VERDICTS = ["APPROVE", "ESCALATE"];
async function withVerdict(root, id, input) {
  if (input.type !== "agent.finished")
    return input;
  if (input.role === "reviewer") {
    const path = join(jobDir(root, id), `round-${input.round}`, `review-${input.key}.md`);
    const v = await readVerdict(path, REVIEW_VERDICTS.map((x) => `VERDICT: ${x}`));
    const verdict = REVIEW_VERDICTS.find((x) => x === v);
    if (verdict === undefined)
      throw new Error(`${path}: unreachable verdict '${v}'`);
    return { ...input, verdict };
  }
  if (input.role === "approver") {
    const path = join(jobDir(root, id), "decision.md");
    const v = await readVerdict(path, DECISION_VERDICTS);
    const verdict = DECISION_VERDICTS.find((x) => x === v);
    if (verdict === undefined)
      throw new Error(`${path}: unreachable verdict '${v}'`);
    return { ...input, verdict };
  }
  return input;
}
async function withLock(dir, create, fn) {
  let created = false;
  if (create)
    created = await mkdir(dir, { recursive: true }) !== undefined;
  else if (!await exists(dir))
    throw new Error(`${dir.split("/").pop()}: no such job`);
  const lock = join(dir, ".events.lock");
  for (;; ) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (!isExists(e))
        throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS)
          await rm(lock, { recursive: true, force: true });
      } catch (s) {
        if (!isNotFound(s))
          throw s;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    await rm(lock, { recursive: true, force: true });
    if (created && !ok)
      await rmdir(dir).catch(() => {
        return;
      });
  }
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if (isNotFound(e))
      return false;
    throw e;
  }
}
async function writeSnapshot(root, id, snap) {
  const file = join(jobDir(root, id), "job.json");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snap, null, 2)}
`);
  await rename(tmp, file);
}
async function appendEvent(root, id, input, now = () => new Date) {
  return withLock(jobDir(root, id), input.type === "job.claimed", async () => {
    const prior = await readLog(root, id);
    if (prior.length === 0 && await exists(join(jobDir(root, id), "job.json"))) {
      throw new Error(`${id} is a legacy job (no events.jsonl); not modifiable`);
    }
    const raw = prior.length === 0 ? "" : await readFile(logPath(root, id), "utf8");
    if (raw !== "" && !raw.endsWith(`
`))
      throw new Error(`${id}: events.jsonl does not end with a newline (corrupt tail); refusing to append`);
    const checked = await withVerdict(root, id, input);
    checkTransition(prior, checked);
    const event = { ts: now().toISOString(), ...checked };
    await appendFile(logPath(root, id), `${JSON.stringify(event)}
`);
    const snap = project(await readLog(root, id));
    await writeSnapshot(root, id, snap);
    return snap;
  });
}
async function rebuild(root, id) {
  const ids = id !== undefined ? [id] : await listEventedJobs(root);
  const done = [];
  for (const j of ids) {
    await withLock(jobDir(root, j), false, async () => {
      const log = await readLog(root, j);
      if (log.length === 0)
        throw new Error(`${j}: no events.jsonl to rebuild from`);
      await writeSnapshot(root, j, project(log));
    });
    done.push(j);
  }
  return done;
}
async function listEventedJobs(root) {
  let entries;
  try {
    entries = (await readdir(join(root, "jobs"), { withFileTypes: true })).filter((d) => d.isDirectory() && JOB_ID2.test(d.name)).map((d) => d.name);
  } catch (e) {
    if (isNotFound(e))
      return [];
    throw e;
  }
  const out = [];
  for (const name of entries.sort()) {
    try {
      await stat(logPath(root, name));
      out.push(name);
    } catch (e) {
      if (!isNotFound(e))
        throw e;
    }
  }
  return out;
}
// packages/contract/src/fields.ts
var INT_KEYS = ["round", "maxRound", "k"];
function parseFields(args) {
  const out = {};
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq < 1)
      throw new Error(`bad field '${a}' (want key=value)`);
    const k = a.slice(0, eq);
    const v = a.slice(eq + 1);
    if (INT_KEYS.includes(k)) {
      if (!/^-?\d+$/.test(v))
        throw new Error(`field '${k}' must be an integer, got '${v}'`);
      out[k] = Number(v);
    } else if (k === "reviewers") {
      let parsed;
      try {
        parsed = JSON.parse(v);
      } catch {
        throw new Error(`field 'reviewers' must be a JSON array`);
      }
      if (!Array.isArray(parsed))
        throw new Error(`field 'reviewers' must be a JSON array`);
      out[k] = parsed;
    } else
      out[k] = v === "null" ? null : v;
  }
  return out;
}
// packages/contract/src/show.ts
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)
    return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)
    return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function span(ms, openSince, now) {
  return ms !== null ? duration(ms) : `running ${duration(now.getTime() - Date.parse(openSince))}`;
}
function formatShow(snap, now) {
  const out = [`${snap.id}  ${snap.stage}${snap.title ? `  ${snap.title}` : ""}`];
  for (const s of snap.timing.stages) {
    const head = `stage  ${s.stage}${s.round ? ` r${s.round}` : ""}`;
    out.push(s.stage === "merged" ? head : `${head}  ${span(s.ms, s.enteredAt, now)}`);
  }
  for (const a of snap.timing.agents) {
    const who = [a.role, a.key, a.round !== null ? `r${a.round}` : null, a.name].filter((x) => x !== null).join(" ");
    out.push(`agent  ${who}  ${span(a.ms, a.startedAt, now)}${a.verdict ? `  ${a.verdict}` : ""}`);
  }
  return out;
}
// packages/contract/src/manifest.ts
var SCHEMA2 = "factory/v1";
var SHA256_HEX = /^[0-9a-f]{64}$/;
var isRecord2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function checkManifestPath(p) {
  if (p === "")
    return "empty path";
  if (p.includes("\x00"))
    return "path contains a NUL byte";
  if (p.includes("\\"))
    return "path must use forward slashes";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p))
    return "path must be repo-relative, not absolute";
  if (p.split("/").some((seg) => seg === ".."))
    return "path must not contain '..'";
  return null;
}
function parseManifest(raw) {
  if (!isRecord2(raw))
    throw new Error("must be a JSON object");
  const extra = Object.keys(raw).filter((k) => !["schema", "version", "files"].includes(k));
  if (extra.length)
    throw new Error(`unknown key ${extra.map((k) => `'${k}'`).join(", ")}`);
  if (raw.schema !== SCHEMA2)
    throw new Error(`schema must be "${SCHEMA2}"`);
  if (typeof raw.version !== "string" || raw.version === "")
    throw new Error("version must be a non-empty string");
  if (!isRecord2(raw.files))
    throw new Error("files must be an object");
  const files = {};
  for (const [path, hash] of Object.entries(raw.files)) {
    const why = checkManifestPath(path);
    if (why !== null)
      throw new Error(`${JSON.stringify(path)}: ${why}`);
    if (typeof hash !== "string" || !SHA256_HEX.test(hash))
      throw new Error(`${JSON.stringify(path)}: hash must be 64 lowercase hex characters (sha256)`);
    files[path] = hash;
  }
  return { schema: SCHEMA2, version: raw.version, files };
}
// packages/cli/src/doctor.ts
import { createHash } from "crypto";
import { readFile as readFile2 } from "fs/promises";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "path";

// packages/cli/src/paths.ts
import { realpath } from "fs/promises";
import { basename, dirname, isAbsolute, join as join2, posix, relative, resolve, sep } from "path";
var isNotFound2 = (e) => typeof e === "object" && e !== null && ("code" in e) && e.code === "ENOENT";
function assertInside(repoReal, p) {
  const back = relative(repoReal, p);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error("resolves outside the repo");
  }
}
async function locate(repo, rel) {
  const why = checkManifestPath(rel);
  if (why !== null)
    throw new Error(why);
  const repoReal = await realpath(repo);
  const abs = resolve(repoReal, rel);
  const rest = [basename(abs)];
  let dir = dirname(abs);
  let dirReal = null;
  while (dirReal === null) {
    try {
      dirReal = await realpath(dir);
    } catch (e) {
      if (!isNotFound2(e) || dirname(dir) === dir)
        throw e;
      rest.unshift(basename(dir));
      dir = dirname(dir);
    }
  }
  const at = join2(dirReal, ...rest);
  assertInside(repoReal, at);
  try {
    assertInside(repoReal, await realpath(at));
  } catch (e) {
    if (!isNotFound2(e))
      throw e;
  }
  return at;
}

// packages/cli/src/doctor.ts
var firstLine = (e) => (e instanceof Error ? e.message : String(e)).split(`
`)[0] ?? "";
var ok = (what) => ({ ok: true, line: `ok    ${what}` });
var bad = (what, why) => ({ ok: false, line: `FAIL  ${what}: ${why}` });
async function readText(path) {
  try {
    return await readFile2(path, "utf8");
  } catch (e) {
    if (isNotFound2(e))
      return null;
    throw e;
  }
}
async function checkConfig(root) {
  let text;
  try {
    text = await readText(join3(root, "config.json"));
  } catch (e) {
    return bad("config.json", firstLine(e));
  }
  if (text === null)
    return bad("config.json", "missing");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("config.json", "not valid JSON");
  }
  try {
    parseConfig(raw);
  } catch (e) {
    return bad("config.json", firstLine(e));
  }
  return ok("config.json");
}
async function safeRead(repo, rel) {
  const at = await locate(repo, rel);
  try {
    return await readFile2(at);
  } catch (e) {
    if (isNotFound2(e))
      return null;
    throw e;
  }
}
async function checkManaged(root) {
  let text;
  try {
    text = await readText(join3(root, "managed.json"));
  } catch (e) {
    return [bad("managed.json", firstLine(e))];
  }
  if (text === null)
    return [{ ok: true, line: "note  unstamped install: no managed.json, hash checks skipped" }];
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(text));
  } catch (e) {
    return [bad("managed.json", e instanceof SyntaxError ? "not valid JSON" : firstLine(e))];
  }
  const repo = dirname2(resolve2(root));
  const out = [ok(`managed.json (version ${manifest.version})`)];
  for (const [rel, want] of Object.entries(manifest.files)) {
    try {
      const data = await safeRead(repo, rel);
      if (data === null) {
        out.push(bad(rel, "missing"));
        continue;
      }
      const got = createHash("sha256").update(data).digest("hex");
      out.push(got === want ? ok(rel) : bad(rel, "changed (sha256 mismatch)"));
    } catch (e) {
      out.push(bad(rel, firstLine(e)));
    }
  }
  return out;
}
async function doctor(root) {
  return [await checkConfig(root), ...await checkManaged(root)];
}

// packages/cli/src/core.ts
var USAGE = {
  event: "usage: event <id> <type> [field=value \u2026]",
  rebuild: "usage: rebuild <id> | --all",
  show: "usage: show <id>",
  all: "usage: event <id> <type> [k=v \u2026] | rebuild <id>|--all | show <id>"
};
async function dispatchCore(argv, io, usage = USAGE.all) {
  const [cmd, ...rest] = argv;
  if (cmd === "doctor") {
    const findings = await doctor(io.root);
    for (const f of findings)
      io.stdout(f.line);
    return findings.every((f) => f.ok) ? 0 : 1;
  }
  const config = parseConfig(JSON.parse(await readFile3(join4(io.root, "config.json"), "utf8")));
  switch (cmd) {
    case "event": {
      const [id, type, ...kv] = rest;
      if (!id || !type)
        throw new Error(USAGE.event);
      const input = parseEventInput(type, parseFields(kv), { id, config });
      io.stdout((await appendEvent(io.root, id, input)).stage);
      return 0;
    }
    case "rebuild": {
      const [target] = rest;
      if (!target)
        throw new Error(USAGE.rebuild);
      const ids = await rebuild(io.root, target === "--all" ? undefined : target);
      io.stdout(`rebuilt ${ids.length}: ${ids.join(" ")}`);
      return 0;
    }
    case "show": {
      const [id] = rest;
      if (!id)
        throw new Error(USAGE.show);
      const log = await readLog(io.root, id);
      if (log.length === 0)
        throw new Error(`${id}: no events.jsonl (legacy or unknown job)`);
      for (const line of formatShow(project(log), (io.now ?? (() => new Date))()))
        io.stdout(line);
      return 0;
    }
    default:
      throw new Error(usage);
  }
}
async function guarded(io, body) {
  try {
    return await body();
  } catch (e) {
    io.stderr((e instanceof Error ? e.message : String(e)).split(`
`)[0] ?? "");
    return 1;
  }
}
function runCore(argv, io) {
  return guarded(io, () => dispatchCore(argv, io));
}

// packages/cli/src/installed.ts
process.exitCode = await runCore(process.argv.slice(2), {
  root: import.meta.dir,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line)
});
