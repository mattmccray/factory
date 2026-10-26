// factory 0.1.0 · managed file, do not edit: it is replaced on upgrade. Project settings go in the overlay: factory/config.json
// packages/cli/src/core.ts
import { readFile as readFile3, stat as stat2 } from "fs/promises";
import { dirname as dirname3, join as join4, relative as relative2, resolve as resolve3 } from "path";

// packages/contract/src/contract.ts
var WORKING_STAGES = ["claimed", "spec", "build", "review", "approve"];
var workingStage = (stage) => WORKING_STAGES.find((w) => w === stage) ?? null;
var CURRENT_TARGET = "current";
var BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function isTargetBranch(name) {
  return BRANCH_PATTERN.test(name) && !name.includes("..") && !name.includes("//") && !name.includes("/.") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock");
}
function mergeTarget(config) {
  return config.merge?.target ?? CURRENT_TARGET;
}
var MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
var RUNNERS = ["claude"];
var SCHEMA = "factory/v1";
var JOB_ID = /^\d{3}-[a-z0-9-]+$/;
var isJobId = (id) => JOB_ID.test(id);
var SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var SLUG_MAX = 40;
var JOB_NUMBER_MAX = 999;
function checkSlug(slug) {
  if (slug.length > SLUG_MAX)
    throw new Error(`slug ${JSON.stringify(slug)} is ${slug.length} characters (at most ${SLUG_MAX})`);
  if (!SLUG_PATTERN.test(slug))
    throw new Error(`slug ${JSON.stringify(slug)} must match ${SLUG_PATTERN.source}`);
}
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
  noExtraKeys(raw, ["schema", "reviewers", "maxRound", "dashboard", "gate", "roles", "merge"], "config");
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
  if (raw.merge !== undefined)
    config.merge = parseMerge(raw.merge);
  return config;
}
function parseMerge(merge) {
  if (!isRecord(merge))
    throw new Error("config: merge must be an object { target? }");
  noExtraKeys(merge, ["target"], "config.merge");
  if (merge.target === undefined)
    return {};
  const target = merge.target;
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error(`config: merge.target must be "${CURRENT_TARGET}" or a non-empty branch name`);
  }
  if (!isTargetBranch(target)) {
    throw new Error(`config: merge.target ${JSON.stringify(target)} is not an allowed branch name (want ${BRANCH_PATTERN.source}, no '..', no '.lock' suffix)`);
  }
  return { target };
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
      if (ctx.target !== undefined && !isTargetBranch(ctx.target))
        throw new Error(`job.claimed: target ${JSON.stringify(ctx.target)} is not an allowed branch name`);
      const maxRound = fields.maxRound === undefined ? ctx.config.maxRound : posInt(fields, "maxRound");
      const claimed = { type, schema: SCHEMA, id: ctx.id, maxRound, brief: nullableStr(fields, "brief"), issue: nullableStr(fields, "issue") };
      if (ctx.target !== undefined)
        claimed.target = ctx.target;
      return claimed;
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
    case "job.abandoned":
      allow("reason");
      return { type, reason: str(fields, "reason") };
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
      case "job.abandoned":
        s.stage = "abandoned";
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
function checkTransition(prior, next, opts = {}) {
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
  if (stage === "merged" || stage === "abandoned")
    fail(`job is ${stage} (terminal): ${next.type} not allowed`);
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
    case "job.abandoned":
      if (stage === "needs-human" || opts.force === true)
        return;
      return fail(`job.abandoned from working stage '${stage}' requires force (abandon --force)`);
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
function closeOpenAgents(s, ts) {
  for (const a of s.timing.agents) {
    if (a.finishedAt === null) {
      a.finishedAt = ts;
      a.ms = ms(a.startedAt, ts);
    }
  }
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
      closeOpenAgents(s, e.ts);
      s.note = e.reason;
      s.stoppedBy = "escalated";
      s.stoppedFrom = workingStage(s.stage);
      enterStage(s, "needs-human", e.ts);
      return;
    case "merge.failed":
      s.note = e.reason;
      s.stoppedBy = "merge-failed";
      if (s.stage !== "needs-human")
        s.stoppedFrom = workingStage(s.stage);
      enterStage(s, "needs-human", e.ts);
      return;
    case "job.reworked":
      s.reworks = e.k;
      s.stoppedBy = null;
      s.stoppedFrom = null;
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
    case "job.abandoned":
      closeOpenAgents(s, e.ts);
      s.endedAt = e.ts;
      s.note = e.reason;
      enterStage(s, "abandoned", e.ts);
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
    target: typeof first.target === "string" ? first.target : null,
    builder: null,
    stage: "claimed",
    round: 0,
    maxRound: first.maxRound,
    reviews: {},
    history: [],
    reworks: 0,
    decision: null,
    note: "",
    stoppedBy: null,
    stoppedFrom: null,
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
async function acquire(lock) {
  for (;; ) {
    try {
      await mkdir(lock);
      return;
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
}
async function withLock(dir, create, fn) {
  let created = false;
  if (create)
    created = await mkdir(dir, { recursive: true }) !== undefined;
  else if (!await exists(dir))
    throw new Error(`${dir.split("/").pop()}: no such job`);
  const lock = join(dir, ".events.lock");
  await acquire(lock);
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
async function appendEvent(root, id, input, now = () => new Date, opts = {}) {
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
    checkTransition(prior, checked, opts);
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
function claimedInput(id, input) {
  const ctx = { id, config: input.config };
  if (input.target !== undefined)
    ctx.target = input.target;
  return parseEventInput("job.claimed", input.fields, ctx);
}
function checkClaim(slug, input) {
  checkSlug(slug);
  claimedInput(`000-${slug}`, input);
}
async function jobDirs(root) {
  try {
    return (await readdir(join(root, "jobs"), { withFileTypes: true })).filter((d) => d.isDirectory() && JOB_ID2.test(d.name)).map((d) => d.name).sort();
  } catch (e) {
    if (isNotFound(e))
      return [];
    throw e;
  }
}
async function isLive(root, id) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(jobDir(root, id), "job.json"), "utf8"));
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null || !("stage" in raw) || typeof raw.stage !== "string")
    return false;
  return raw.stage !== "merged" && raw.stage !== "abandoned";
}
async function claimJob(root, slug, input, now = () => new Date) {
  checkClaim(slug, input);
  const jobs = join(root, "jobs");
  await mkdir(jobs, { recursive: true });
  const lock = join(jobs, ".claim.lock");
  await acquire(lock);
  try {
    const dirs = await jobDirs(root);
    for (const d of dirs) {
      if (d.slice(4) === slug && await isLive(root, d))
        throw new Error(`slug ${slug} is live as ${d}`);
    }
    const highest = dirs.reduce((n, d) => Math.max(n, Number(d.slice(0, 3))), 0);
    if (highest >= JOB_NUMBER_MAX)
      throw new Error(`job number ${JOB_NUMBER_MAX} is taken: no job numbers are left`);
    const id = `${String(highest + 1).padStart(3, "0")}-${slug}`;
    const snapshot = await appendEvent(root, id, claimedInput(id, input), now);
    return { id, snapshot };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
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
    out.push(s.stage === "merged" || s.stage === "abandoned" ? head : `${head}  ${span(s.ms, s.enteredAt, now)}`);
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
import { readFile as readFile2, readdir as readdir2 } from "fs/promises";
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
async function checkJobNumbers(root) {
  let names;
  try {
    names = (await readdir2(join3(root, "jobs"), { withFileTypes: true })).filter((d) => d.isDirectory() && isJobId(d.name)).map((d) => d.name);
  } catch (e) {
    if (isNotFound2(e))
      return [];
    return [bad("jobs/", firstLine(e))];
  }
  const byNumber = new Map;
  for (const name of names.sort()) {
    const n = name.slice(0, 3);
    byNumber.set(n, [...byNumber.get(n) ?? [], name]);
  }
  return [...byNumber.entries()].filter(([, ids]) => ids.length > 1).map(([n, ids]) => ({ ok: true, line: `note: job number ${n} is used by ${ids.join(", ")}` }));
}
async function doctor(root) {
  return [await checkConfig(root), ...await checkManaged(root), ...await checkJobNumbers(root)];
}

// packages/cli/src/git.ts
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "GIT_DIR" && k !== "GIT_WORK_TREE")
      env[k] = v;
  }
  return env;
}
async function git(repo, args, what = "merge.target") {
  let proc;
  try {
    proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: gitEnv() });
  } catch (e) {
    throw new Error(`${what}: cannot run git: ${e instanceof Error ? e.message : String(e)}`);
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim().split(`
`)[0] ?? "" };
}
function allowed(configured, branch) {
  if (!isTargetBranch(branch)) {
    throw new Error(`merge.target '${configured}': branch ${JSON.stringify(branch)} is not an allowed target name (want ${BRANCH_PATTERN.source}, no '..', no '.lock' suffix)`);
  }
  return branch;
}
async function resolveTarget(repo, configured) {
  if (configured === CURRENT_TARGET) {
    const r = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (r.code === 0 && r.out !== "")
      return allowed(configured, r.out);
    if (r.code === 1)
      throw new Error(`merge.target '${CURRENT_TARGET}': the checkout at ${repo} has a detached HEAD (no branch to target)`);
    throw new Error(`merge.target '${CURRENT_TARGET}': git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
  }
  allowed(configured, configured);
  const r = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${configured}`]);
  if (r.code === 0)
    return configured;
  if (r.code === 1)
    throw new Error(`merge.target '${configured}': no branch refs/heads/${configured} in ${repo}`);
  throw new Error(`merge.target '${configured}': git failed in ${repo}: ${r.err || `exit ${r.code}`}`);
}
async function removeWorktree(repo, path) {
  const r = await git(repo, ["worktree", "remove", "--force", path], "abandon");
  return r.code === 0 ? null : r.err || `exit ${r.code}`;
}
async function deleteBranch(repo, branch) {
  const has = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], "abandon");
  if (has.code === 1)
    return null;
  if (has.code !== 0)
    return has.err || `exit ${has.code}`;
  const r = await git(repo, ["branch", "-D", branch], "abandon");
  return r.code === 0 ? null : r.err || `exit ${r.code}`;
}

// packages/cli/src/core.ts
var USAGE = {
  claim: "usage: claim <slug> [brief=\u2026] [issue=\u2026] [maxRound=\u2026]",
  event: "usage: event <id> <type> [field=value \u2026]",
  rebuild: "usage: rebuild <id> | --all",
  show: "usage: show <id>",
  abandon: 'usage: abandon <id> "<reason>" [--force] [--delete-branch]',
  all: "usage: claim <slug> [k=v \u2026] | event <id> <type> [k=v \u2026] | rebuild <id>|--all | show <id>"
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
    case "claim": {
      const [slug, ...kv] = rest;
      if (slug === undefined)
        throw new Error(USAGE.claim);
      checkSlug(slug);
      const fields = parseFields(kv);
      checkClaim(slug, { fields, config });
      const target = await resolveTarget(dirname3(resolve3(io.root)), mergeTarget(config));
      io.stdout((await claimJob(io.root, slug, { fields, config, target })).id);
      return 0;
    }
    case "event": {
      const [id, type, ...kv] = rest;
      if (!id || !type)
        throw new Error(USAGE.event);
      if (type === "job.claimed")
        throw new Error(`job.claimed is written only by claim: run ${USAGE.claim.replace("usage: ", "")}`);
      const fields = parseFields(kv);
      io.stdout((await appendEvent(io.root, id, parseEventInput(type, fields, { id, config }))).stage);
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
    case "abandon":
      return abandon(rest, io);
    default:
      throw new Error(usage);
  }
}
function parseAbandon(rest) {
  const [id, reason, ...flags] = rest;
  if (id === undefined || reason === undefined || reason === "" || flags.length > 2)
    throw new Error(USAGE.abandon);
  const known = ["--force", "--delete-branch"];
  if (flags.some((f) => !known.includes(f)) || new Set(flags).size !== flags.length)
    throw new Error(USAGE.abandon);
  return { id, reason, force: flags.includes("--force"), deleteBranch: flags.includes("--delete-branch") };
}
var isDir = async (path) => {
  try {
    return (await stat2(path)).isDirectory();
  } catch (e) {
    if (isNotFound2(e))
      return false;
    throw e;
  }
};
async function abandon(rest, io) {
  const args = parseAbandon(rest);
  if (!isJobId(args.id))
    throw new Error(`job id '${args.id}' must match ^\\d{3}-[a-z0-9-]+$`);
  const input = parseEventInput("job.abandoned", { reason: args.reason });
  const snap = await appendEvent(io.root, args.id, input, undefined, { force: args.force });
  const repo = dirname3(resolve3(io.root));
  const branch = `factory/${args.id}`;
  const worktree = relative2(repo, join4(resolve3(io.root), ".worktrees", args.id));
  const left = [];
  if (await isDir(join4(repo, worktree))) {
    const why = await removeWorktree(repo, worktree);
    if (why !== null)
      left.push(`worktree ${worktree} (${why})`);
  }
  if (args.deleteBranch) {
    if (snap.branch !== branch)
      left.push(`branch ${snap.branch} (not ${branch}; not deleted)`);
    else if (left.length > 0)
      left.push(`branch ${branch} (its worktree is still there)`);
    else {
      const why = await deleteBranch(repo, branch);
      if (why !== null)
        left.push(`branch ${branch} (${why})`);
    }
  }
  if (left.length > 0)
    throw new Error(`${args.id} is abandoned, but cleanup left behind: ${left.join("; ")}`);
  io.stdout(snap.stage);
  return 0;
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
