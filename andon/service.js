#!/usr/bin/env bun
// @bun

// packages/andon-service/src/release-main.ts
import { join as join5 } from "path";

// packages/andon-service/src/entry.ts
import { join as join4 } from "path";

// packages/contract/src/contract.ts
var WORKING_STAGES = ["claimed", "spec", "build", "review", "approve"];
var workingStage = (stage) => WORKING_STAGES.find((w) => w === stage) ?? null;
var JOB_KINDS = ["member", "sync", "fix"];
var CURRENT_TARGET = "current";
var BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function isTargetBranch(name) {
  return BRANCH_PATTERN.test(name) && !name.includes("..") && !name.includes("//") && !name.includes("/.") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock");
}
var MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
var RUNNERS = ["claude"];
var SCHEMA = "factory/v1";
var JOB_ID = /^\d{3}-[a-z0-9-]+$/;
var isJobId = (id) => JOB_ID.test(id);
var SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var SLUG_MAX = 40;
function checkEpicSlug(slug) {
  if (slug.length > SLUG_MAX)
    throw new Error(`epic slug ${JSON.stringify(slug)} is ${slug.length} characters (at most ${SLUG_MAX})`);
  if (!SLUG_PATTERN.test(slug))
    throw new Error(`epic slug ${JSON.stringify(slug)} must match ${SLUG_PATTERN.source}`);
  if (JOB_ID.test(slug))
    throw new Error(`epic slug ${JSON.stringify(slug)} must not look like a job id (^\\d{3}-[a-z0-9-]+$)`);
}
function isEpicSlug(slug) {
  try {
    checkEpicSlug(slug);
    return true;
  } catch {
    return false;
  }
}
var epicBranch = (slug) => `factory/epic/${slug}`;
var SESSION_APP = "t3code";
var SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
function isSession(v) {
  return isRecord(v) && Object.keys(v).length === 3 && v.app === SESSION_APP && typeof v.environment === "string" && SESSION_ID_PATTERN.test(v.environment) && typeof v.thread === "string" && SESSION_ID_PATTERN.test(v.thread);
}
var REVIEWER_KEY = /^[a-z][a-z0-9-]*$/;
var RESERVED_KEYS = ["spec-writer", "builder", "approver"];
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
  noExtraKeys(raw, ["schema", "name", "reviewers", "maxRound", "dashboard", "gate", "roles", "merge", "archive", "epic"], "config");
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
  if (raw.name !== undefined)
    config.name = parseName(raw.name);
  if (raw.gate !== undefined)
    config.gate = parseGate(raw.gate);
  if (raw.roles !== undefined)
    config.roles = parseRoles(raw.roles, keys);
  if (raw.merge !== undefined)
    config.merge = parseMerge(raw.merge);
  if (raw.archive !== undefined)
    config.archive = parseArchive(raw.archive);
  if (raw.epic !== undefined)
    config.epic = parseEpic(raw.epic);
  return config;
}
function parseEpic(epic) {
  if (!isRecord(epic))
    throw new Error("config: epic must be an object { maxParallel? }");
  noExtraKeys(epic, ["maxParallel"], "config.epic");
  if (epic.maxParallel === undefined)
    return {};
  if (!isPosInt(epic.maxParallel))
    throw new Error("config: epic.maxParallel must be a positive integer");
  return { maxParallel: epic.maxParallel };
}
function parseArchive(archive) {
  if (!isRecord(archive))
    throw new Error("config: archive must be an object { enabled }");
  noExtraKeys(archive, ["enabled"], "config.archive");
  if (typeof archive.enabled !== "boolean")
    throw new Error("config: archive.enabled must be true or false");
  return { enabled: archive.enabled };
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
var NAME_MAX = 64;
var CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
function parseName(name) {
  if (typeof name !== "string")
    throw new Error("config: name must be a string");
  const length = [...name].length;
  if (length === 0)
    throw new Error("config: name must not be empty");
  if (length > NAME_MAX)
    throw new Error(`config: name is ${length} characters (at most ${NAME_MAX})`);
  if (CONTROL.test(name))
    throw new Error("config: name must not contain control characters");
  if (name.trim() !== name)
    throw new Error("config: name must not have leading or trailing whitespace");
  return name;
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
// packages/contract/src/epic.ts
var PLAN_STATUSES = ["draft", "ready", "done", "abandoned"];
var isSlug = (s) => s.length <= SLUG_MAX && SLUG_PATTERN.test(s);
var ITEM = /^- `([^`]*)`(.*)$/;
var AFTER = /\bafter:/g;
var AFTER_LIST = /\bafter:\s*(`[^`]*`(?:\s*,\s*`[^`]*`)*)/;
var MAX_ROUND = /\bmaxRound:/g;
var MAX_ROUND_VALUE = /\bmaxRound:\s*([1-9]\d*)(?!\w|\.\d)/;
var STATUS = /^- Status:(.*)$/;
function statusLine(text) {
  for (const line of text.split(`
`)) {
    if (line.startsWith("## "))
      return null;
    const m = STATUS.exec(line.trimEnd());
    if (m)
      return (m[1] ?? "").trim();
  }
  return null;
}
function parsePlan(text) {
  const plan = { status: null, statusError: null, members: [], errors: [] };
  const status = statusLine(text);
  if (status === null)
    plan.statusError = 'has no "- Status:" line';
  else {
    const hit = PLAN_STATUSES.find((s) => s === status);
    if (hit === undefined)
      plan.statusError = `has an unknown status (want ${PLAN_STATUSES.join("|")})`;
    else
      plan.status = hit;
  }
  const lines = text.split(`
`);
  const start = lines.findIndex((l) => l.trimEnd() === "## Members");
  if (start < 0) {
    plan.errors.push('has no "## Members" section');
    return plan;
  }
  const items = [];
  for (let i = start + 1;i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#{1,2} /.test(line))
      break;
    if (line.startsWith("- ") || line === "-" || line.startsWith("* ") || line.startsWith("+ ") || /^\d+[.)] /.test(line))
      items.push({ n: i + 1, text: line });
    else if (/^\s/.test(line) && line.trim() !== "" && items.length > 0) {
      const last = items[items.length - 1];
      if (last)
        last.text += ` ${line.trim()}`;
    }
  }
  const seen = new Set;
  for (const { n, text: item } of items) {
    const where = `## Members line ${n}`;
    const m = ITEM.exec(item);
    if (!m) {
      plan.errors.push(`${where} is malformed (want "- \`<brief slug>\`" first)`);
      continue;
    }
    const slug = m[1] ?? "";
    const rest = m[2] ?? "";
    if (!isSlug(slug)) {
      plan.errors.push(`${where}: member slug must match ${SLUG_PATTERN.source} (at most ${SLUG_MAX} characters)`);
      continue;
    }
    if (seen.has(slug)) {
      plan.errors.push(`${where}: member ${slug} is listed twice`);
      continue;
    }
    let after = [];
    const afters = rest.match(AFTER)?.length ?? 0;
    if (afters > 1) {
      plan.errors.push(`${where}: member ${slug} has more than one after:`);
      continue;
    }
    if (afters === 1) {
      const a = AFTER_LIST.exec(rest);
      if (!a) {
        plan.errors.push(`${where}: member ${slug} has a malformed after: (want after: \`<slug>\`[, \`<slug>\`])`);
        continue;
      }
      after = [...(a[1] ?? "").matchAll(/`([^`]*)`/g)].map((x) => x[1] ?? "");
      const bad = after.find((s) => !isSlug(s));
      if (bad !== undefined) {
        plan.errors.push(`${where}: member ${slug} has an after: entry that is not a slug`);
        continue;
      }
      if (new Set(after).size !== after.length) {
        plan.errors.push(`${where}: member ${slug} lists an after: member twice`);
        continue;
      }
    }
    let maxRound = null;
    const rounds = rest.match(MAX_ROUND)?.length ?? 0;
    if (rounds > 1) {
      plan.errors.push(`${where}: member ${slug} has more than one maxRound:`);
      continue;
    }
    if (rounds === 1) {
      const r = MAX_ROUND_VALUE.exec(rest);
      const value = r ? Number(r[1]) : Number.NaN;
      if (!Number.isSafeInteger(value) || value < 1) {
        plan.errors.push(`${where}: member ${slug} has a malformed maxRound: (want a positive integer)`);
        continue;
      }
      maxRound = value;
    }
    seen.add(slug);
    plan.members.push({ slug, after, maxRound });
  }
  if (items.length === 0)
    plan.errors.push('"## Members" lists no members');
  return plan;
}
var planPath = (slug) => `factory/epics/${slug}.md`;
var briefPath = (member) => `factory/briefs/${member}.md`;
function isEpicEvent(v) {
  return typeof v === "object" && v !== null && "ts" in v && typeof v.ts === "string" && "type" in v && typeof v.type === "string";
}
function logged(prior) {
  const s = { state: null, resumeTo: "running" };
  for (const e of prior) {
    switch (e.type) {
      case "epic.started":
        s.state = "running";
        break;
      case "epic.waiting":
        if (s.state === "running" || s.state === "landing")
          s.resumeTo = s.state;
        s.state = "waiting";
        break;
      case "epic.resumed":
        if (s.state === "waiting")
          s.state = s.resumeTo;
        break;
      case "epic.landing":
        s.state = "landing";
        break;
      case "epic.landed":
        s.state = "landed";
        break;
      case "epic.abandoned":
        s.state = "abandoned";
        break;
      default:
        break;
    }
  }
  return s;
}
var loggedEpicState = (prior) => logged(prior).state;
var WORKING = ["claimed", "spec", "build", "review", "approve"];
var isWorking = (stage) => WORKING.includes(stage);
var isLiveStage = (stage) => stage !== "merged" && stage !== "abandoned";
var memberJobs = (jobs, member) => jobs.filter((j) => j.kind === "member" && j.brief === briefPath(member)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function viewEpic(log, members, jobs) {
  const newest = new Map;
  for (const m of members) {
    const mine = memberJobs(jobs, m.slug);
    const last = mine[mine.length - 1];
    if (last)
      newest.set(m.slug, last);
  }
  const merged = (slug) => newest.get(slug)?.stage === "merged";
  const out = members.map((m) => {
    const job = newest.get(m.slug);
    const base = { slug: m.slug, after: [...m.after], job: job?.id ?? null, stage: job?.stage ?? null, blockedOn: [] };
    if (job) {
      const state = job.stage === "merged" ? "merged" : job.stage === "abandoned" ? "abandoned" : job.stage === "needs-human" ? "needs-human" : "running";
      return { ...base, state };
    }
    const blockedOn = m.after.filter((a) => !merged(a)).map((a) => ({ member: a, job: newest.get(a)?.id ?? null }));
    return { ...base, state: blockedOn.length > 0 ? "blocked" : "queued", blockedOn };
  });
  const generated = jobs.filter((j) => j.kind !== "member").sort((a, b) => a.id < b.id ? -1 : 1);
  const liveSync = generated.find((j) => j.kind === "sync" && isLiveStage(j.stage)) ?? null;
  const liveGenerated = generated.filter((j) => isLiveStage(j.stage));
  const claimable = liveSync === null ? out.filter((m) => m.state === "queued").map((m) => m.slug) : [];
  const workingMembers = jobs.filter((j) => j.kind === "member" && isWorking(j.stage)).length;
  let landBlock = null;
  const unmerged = out.filter((m) => m.state !== "merged");
  if (out.length === 0)
    landBlock = "the plan lists no members";
  else if (unmerged.length > 0)
    landBlock = `not every member has merged (${unmerged.map((m) => `${m.slug}: ${m.state}`).join(", ")})`;
  else if (liveGenerated.length > 0)
    landBlock = `${liveGenerated.map((j) => `${j.kind} job ${j.id}`).join(", ")} ${liveGenerated.length === 1 ? "is" : "are"} live`;
  return { logged: loggedEpicState(log), members: out, generated, claimable, workingMembers, liveSync, landBlock };
}
function projectEpic(log, members, jobs, planError = null) {
  const first = log[0];
  if (!first || first.type !== "epic.started")
    throw new Error("epic log must start with epic.started");
  const view = viewEpic(log, members, jobs);
  const snap = {
    schema: "factory/v1",
    slug: first.slug,
    branch: epicBranch(first.slug),
    target: first.target,
    plan: planPath(first.slug),
    planError,
    state: "running",
    waitingOn: null,
    note: "",
    session: isSession(first.session) ? { app: first.session.app, environment: first.session.environment, thread: first.session.thread } : null,
    sha: null,
    members: view.members,
    generated: view.generated.map((j) => ({ id: j.id, kind: j.kind, stage: j.stage })),
    counts: { queued: 0, blocked: 0, running: 0, merged: 0, "needs-human": 0, abandoned: 0 },
    startedAt: first.ts,
    endedAt: null,
    updated: first.ts
  };
  for (const e of log.slice(1)) {
    snap.updated = e.ts;
    switch (e.type) {
      case "epic.waiting":
        snap.note = e.reason;
        break;
      case "epic.resumed":
        snap.note = "";
        if (isSession(e.session))
          snap.session = { app: e.session.app, environment: e.session.environment, thread: e.session.thread };
        break;
      case "epic.landed":
        snap.sha = e.sha;
        snap.note = `landed ${e.sha}`;
        snap.endedAt = e.ts;
        break;
      case "epic.abandoned":
        snap.note = e.reason;
        snap.endedAt = e.ts;
        break;
      default:
        break;
    }
  }
  for (const j of jobs)
    if (j.updated !== null && j.updated > snap.updated)
      snap.updated = j.updated;
  for (const m of view.members)
    snap.counts[m.state] += 1;
  const state = view.logged ?? "running";
  snap.state = state;
  if (state === "waiting")
    snap.waitingOn = "you";
  else if ((state === "running" || state === "landing") && membersWait(view, jobs)) {
    snap.state = "waiting";
    snap.waitingOn = "members";
  }
  return snap;
}
function membersWait(view, jobs) {
  if (jobs.some((j) => isWorking(j.stage)))
    return false;
  if (!jobs.some((j) => j.stage === "needs-human"))
    return false;
  return view.claimable.length === 0 && view.landBlock !== null;
}
var HOUR_MS = 3600000;
var time = (now) => typeof now === "number" ? now : now.getTime();
function endedBefore(endedAt, hours, now) {
  if (endedAt === null)
    return false;
  const ended = Date.parse(endedAt);
  return !Number.isNaN(ended) && time(now) - ended > hours * HOUR_MS;
}
function isEpicSettled(epic, hours, now) {
  if (epic.state === "abandoned")
    return true;
  return epic.state === "landed" && endedBefore(epic.endedAt, hours, now);
}
function isSettled(job, hours, now, epic) {
  if (job.stage === "abandoned")
    return true;
  if (job.stage !== "merged")
    return false;
  if (job.epic === undefined || job.epic === null)
    return endedBefore(job.endedAt, hours, now);
  if (epic === undefined || epic === null || epic.state !== "landed" && epic.state !== "abandoned")
    return false;
  return isEpicSettled(epic, hours, now);
}
// packages/contract/src/epicstore.ts
function parseEpicLog(text) {
  const lines = text.split(`
`);
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines.map((line, i) => {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`epic events.jsonl line ${i + 1} is not valid JSON`);
    }
    if (!isEpicEvent(raw))
      throw new Error(`epic events.jsonl line ${i + 1} is not an epic event`);
    return raw;
  });
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
var storedSession = (v) => isSession(v) ? { app: v.app, environment: v.environment, thread: v.thread } : null;
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
    case "merge.conflicted":
      s.conflicts += 1;
      s.maxRound = s.round + 2;
      s.note = e.reason;
      s.decision = null;
      enterStage(s, "build", e.ts);
      return;
    case "job.reworked":
      s.reworks = e.k;
      s.stoppedBy = null;
      s.stoppedFrom = null;
      s.maxRound = e.maxRound;
      s.decision = null;
      s.note = "";
      s.session = storedSession(e.session) ?? s.session;
      enterStage(s, "build", e.ts);
      return;
    case "job.human-approved":
      s.decision = "APPROVE (human)";
      s.session = storedSession(e.session) ?? s.session;
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
    conflicts: 0,
    decision: null,
    note: "",
    stoppedBy: null,
    stoppedFrom: null,
    brief: first.brief,
    issue: first.issue,
    session: storedSession(first.session),
    epic: typeof first.epic === "string" ? first.epic : null,
    kind: typeof first.epic === "string" ? JOB_KINDS.find((k) => k === first.kind) ?? "member" : null,
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
function parseLog(text) {
  const lines = text.split(`
`);
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines.map((line, i) => parseLine(line, i + 1));
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
// packages/contract/src/registry.ts
import { mkdir, open, readFile, rename, rm } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
var SCHEMA3 = "factory/v1";
var isRecord3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isNotFound2 = (e) => typeof e === "object" && e !== null && ("code" in e) && e.code === "ENOENT";
function registryPath(andonHome) {
  return join(andonHome !== undefined && andonHome !== "" ? andonHome : join(homedir(), ".andon"), "projects.json");
}
function checkRoot(root) {
  if (root === "")
    return "root is empty";
  if (root.includes("\x00"))
    return "root contains a NUL byte";
  if (!isAbsolute(root))
    return `root ${JSON.stringify(root)} must be an absolute path`;
  return null;
}
function parseRegistry(raw) {
  if (!isRecord3(raw))
    throw new Error("registry: must be a JSON object");
  const extra = Object.keys(raw).filter((k) => k !== "schema" && k !== "projects");
  if (extra.length)
    throw new Error(`registry: unknown key ${extra.map((k) => `'${k}'`).join(", ")}`);
  if (raw.schema !== SCHEMA3)
    throw new Error(`registry: schema must be "${SCHEMA3}"`);
  if (!Array.isArray(raw.projects))
    throw new Error("registry: projects must be an array");
  const projects = [];
  const seen = new Set;
  for (const [i, p] of raw.projects.entries()) {
    if (!isRecord3(p))
      throw new Error(`registry: projects[${i}] must be an object`);
    const pExtra = Object.keys(p).filter((k) => k !== "root");
    if (pExtra.length)
      throw new Error(`registry: projects[${i}]: unknown key ${pExtra.map((k) => `'${k}'`).join(", ")}`);
    if (typeof p.root !== "string")
      throw new Error(`registry: projects[${i}].root must be a string`);
    const why = checkRoot(p.root);
    if (why !== null)
      throw new Error(`registry: projects[${i}]: ${why}`);
    if (resolve(p.root) !== p.root)
      throw new Error(`registry: projects[${i}]: root ${JSON.stringify(p.root)} must be normalized (${JSON.stringify(resolve(p.root))})`);
    if (seen.has(p.root))
      throw new Error(`registry: projects[${i}]: root ${JSON.stringify(p.root)} is listed twice`);
    seen.add(p.root);
    projects.push({ root: p.root });
  }
  return { schema: SCHEMA3, projects };
}
async function readRegistry(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isNotFound2(e))
      return { schema: SCHEMA3, projects: [] };
    throw e;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("registry: not valid JSON");
  }
  return parseRegistry(raw);
}
// packages/andon-service/src/index.ts
import { createHash } from "crypto";
import { watch } from "fs";
import { lstat, mkdir as mkdir2, readFile as readFile3, readdir, realpath, stat } from "fs/promises";
import { basename as basename2, dirname as dirname2, join as join3, resolve as resolve2, sep } from "path";

// packages/andon-service/src/archive.ts
var ARCHIVE_REF = "refs/heads/factory/archive";
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_"))
      env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
var READ_ONLY = new Set(["rev-parse", "ls-tree", "cat-file"]);
var spawnGit = async (args, { cwd, input }) => {
  if (!READ_ONLY.has(args[0] ?? ""))
    throw new Error(`git ${args[0] ?? ""}: not a read-only command`);
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
    env: gitEnv()
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  return { code, stdout: new Uint8Array(out) };
};
var EMPTY_ARCHIVE = { tip: null, jobs: new Map, epics: new Map };
var HEX_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
var TOP_MD = /^(feature|spec|build|decision|rework-\d+|conflict-\d+)\.md$/;
var ROUND_MD = /^round-\d+\/[^/]+\.md$/;
var REGULAR = /^100(644|755)$/;
var decoder = new TextDecoder("utf-8", { ignoreBOM: true });
var isRecord4 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var message = (e) => (e instanceof Error ? e.message : String(e)).split(`
`)[0] ?? "";
var wanted = (rel) => rel === "events.jsonl" || rel === "job.json" || TOP_MD.test(rel) || ROUND_MD.test(rel);
async function gitCommonDir(git, root) {
  try {
    const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
    const dir = decoder.decode(r.stdout).trim();
    return r.code === 0 && dir.startsWith("/") && !dir.includes(`
`) ? dir : null;
  } catch {
    return null;
  }
}
async function archiveTip(git, root) {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ARCHIVE_REF}^{commit}`], { cwd: root });
  const out = decoder.decode(r.stdout).trim();
  if (r.code === 0 && HEX_SHA.test(out))
    return out;
  if (r.code === 1 || r.code === 0 && out === "")
    return null;
  throw new Error(`git rev-parse exited ${r.code}`);
}
function blobs(raw) {
  const out = [];
  for (const rec of decoder.decode(raw).split("\x00")) {
    const tab = rec.indexOf("\t");
    if (tab < 0)
      continue;
    const [mode, type, sha] = rec.slice(0, tab).split(" ");
    if (type !== "blob" || mode === undefined || !REGULAR.test(mode) || sha === undefined || !HEX_SHA.test(sha))
      continue;
    out.push({ path: rec.slice(tab + 1), sha });
  }
  return out;
}
function jobBlobs(all) {
  const out = [];
  for (const { path, sha } of all) {
    const slash = path.indexOf("/");
    if (slash < 0)
      continue;
    const id = path.slice(0, slash);
    const rel = path.slice(slash + 1);
    if (!isJobId(id) || !wanted(rel))
      continue;
    out.push({ id, rel, sha });
  }
  return out;
}
function epicBlobs(all) {
  const out = [];
  for (const { path, sha } of all) {
    const [top, slug, rel, ...rest] = path.split("/");
    if (top !== "epics" || slug === undefined || !isEpicSlug(slug) || rest.length > 0)
      continue;
    if (rel === "events.jsonl" || rel === "plan.md")
      out.push({ slug, rel, sha });
  }
  return out;
}
function parseBatch(raw) {
  const out = new Map;
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf(10, at);
    if (nl < 0)
      break;
    const [sha, type, size] = decoder.decode(raw.subarray(at, nl)).split(" ");
    at = nl + 1;
    if (sha === undefined || type === undefined || size === undefined)
      continue;
    const n = Number(size);
    if (!Number.isSafeInteger(n) || n < 0 || at + n > raw.length)
      throw new Error("git cat-file: truncated output");
    if (type === "blob")
      out.set(sha, decoder.decode(raw.subarray(at, at + n)));
    at += n + 1;
  }
  return out;
}
function snapshot(id, files) {
  const log = files.get("events.jsonl");
  if (log !== undefined) {
    const snap = JSON.parse(JSON.stringify(project(parseLog(log))));
    if (!isRecord4(snap))
      throw new Error("projection is not an object");
    if (snap.id !== id)
      throw new Error(`events.jsonl claims ${JSON.stringify(snap.id)}`);
    return snap;
  }
  const legacy = files.get("job.json");
  if (legacy === undefined)
    throw new Error("no events.jsonl and no job.json");
  const job = JSON.parse(legacy);
  if (!isRecord4(job))
    throw new Error("job.json is not a JSON object");
  return job;
}
async function readArchive(git, root, tip, log) {
  if (!HEX_SHA.test(tip))
    throw new Error("archive tip is not an object id");
  const tree = await git(["ls-tree", "-r", "-z", "--full-tree", tip], { cwd: root });
  if (tree.code !== 0)
    throw new Error(`git ls-tree exited ${tree.code}`);
  const all = blobs(tree.stdout);
  const jobFiles = jobBlobs(all);
  const epicFiles = epicBlobs(all);
  const shas = [...new Set([...jobFiles, ...epicFiles].map((b) => b.sha))];
  let texts = new Map;
  if (shas.length > 0) {
    const batch = await git(["cat-file", "--batch"], { cwd: root, input: shas.map((s) => `${s}
`).join("") });
    if (batch.code !== 0)
      throw new Error(`git cat-file exited ${batch.code}`);
    texts = parseBatch(batch.stdout);
  }
  const byJob = new Map;
  for (const b of jobFiles) {
    const text = texts.get(b.sha);
    if (text === undefined)
      continue;
    const files = byJob.get(b.id) ?? new Map;
    files.set(b.rel, text);
    byJob.set(b.id, files);
  }
  const jobs = new Map;
  for (const [id, files] of [...byJob].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    try {
      jobs.set(id, { job: snapshot(id, files), files });
    } catch (e) {
      log(`andon: ${root}: factory/archive ${id}: ${message(e)}; left out`);
    }
  }
  const byEpic = new Map;
  for (const b of epicFiles) {
    const text = texts.get(b.sha);
    if (text === undefined)
      continue;
    const files = byEpic.get(b.slug) ?? new Map;
    files.set(b.rel, text);
    byEpic.set(b.slug, files);
  }
  const epics = new Map;
  for (const [slug, files] of [...byEpic].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    try {
      epics.set(slug, archivedEpic(slug, files));
    } catch (e) {
      log(`andon: ${root}: factory/archive epics/${slug}: ${message(e)}; left out`);
    }
  }
  return { tip, jobs, epics };
}
function archivedEpic(slug, files) {
  const text = files.get("events.jsonl");
  if (text === undefined)
    throw new Error("no events.jsonl");
  if (text !== "" && !text.endsWith(`
`))
    throw new Error("events.jsonl does not end with a newline (torn)");
  const log = parseEpicLog(text);
  const first = log[0];
  if (first === undefined || first.type !== "epic.started")
    throw new Error("events.jsonl does not start with epic.started");
  if (first.slug !== slug)
    throw new Error(`events.jsonl claims ${JSON.stringify(first.slug)}`);
  const plan = files.get("plan.md") ?? null;
  let members = [];
  let planError = null;
  if (plan === null)
    planError = `plan ${planPath(slug)} is missing`;
  else {
    const parsed = parsePlan(plan);
    members = parsed.members;
    const [problem] = parsed.errors;
    if (problem !== undefined)
      planError = `plan ${planPath(slug)} ${problem}`;
  }
  return { slug, log, plan, members, planError };
}
function epicJob(job, slug) {
  if (job.epic !== slug || typeof job.id !== "string" || typeof job.stage !== "string")
    return null;
  return {
    id: job.id,
    stage: job.stage,
    kind: JOB_KINDS.find((k) => k === job.kind) ?? "member",
    brief: typeof job.brief === "string" ? job.brief : null,
    updated: typeof job.updated === "string" ? job.updated : null
  };
}
function projectArchivedEpic(epic, jobs) {
  const mine = jobs.map((j) => epicJob(j, epic.slug)).filter((j) => j !== null).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const snap = JSON.parse(JSON.stringify(projectEpic(epic.log, epic.members, mine, epic.planError)));
  if (!isRecord4(snap))
    throw new Error("projection is not an object");
  return snap;
}

// packages/andon-service/src/release.ts
import { readFile as readFile2 } from "fs/promises";
import { join as join2 } from "path";
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
var JOB_ID2 = /^\d{3}-[a-z0-9-]+$/;
var isSemver = (v) => SEMVER.test(v);
var compareDigits = (a, b) => a.length !== b.length ? Math.sign(a.length - b.length) : a < b ? -1 : a > b ? 1 : 0;
function compareSemver(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (x === null || y === null)
    return null;
  for (let i = 1;i <= 3; i++) {
    const c = compareDigits(x[i] ?? "", y[i] ?? "");
    if (c !== 0)
      return c;
  }
  return 0;
}
function releaseState(installed, running) {
  if (installed === null || running === null)
    return "unknown";
  const c = compareSemver(installed, running);
  return c === null ? "unknown" : c < 0 ? "behind" : c > 0 ? "ahead" : "current";
}
async function readInstalled(factory) {
  try {
    return parseManifest(JSON.parse(await readFile2(join2(factory, "managed.json"), "utf8"))).version;
  } catch {
    return null;
  }
}
var SOURCE_VERSION_FILE = "packages/templates/package.json";
var BUNDLE_VERSION_FILE = "package.json";
async function readTemplatesVersion(cloneRoot, versionFile = SOURCE_VERSION_FILE) {
  if (cloneRoot === undefined)
    return null;
  try {
    const pkg = JSON.parse(await readFile2(join2(cloneRoot, versionFile), "utf8"));
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg) || !("version" in pkg))
      return null;
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
var JOB_SUFFIX = /^(.*?)\s*\(([^()]*)\)$/;
var AREA_PREFIX = /^([^\s:()][^:()]*?):(?:\s+(.*))?$/;
function parseEntry(raw) {
  const trimmed = raw.trim();
  const line = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
  let rest = line;
  let job = null;
  const j = JOB_SUFFIX.exec(rest);
  if (j !== null && JOB_ID2.test(j[2] ?? "")) {
    rest = j[1] ?? "";
    job = j[2] ?? null;
  }
  let area = null;
  const a = AREA_PREFIX.exec(rest);
  if (a !== null) {
    area = (a[1] ?? "").trimEnd();
    rest = a[2] ?? "";
  }
  const text = rest.trim();
  if (text === "")
    return { area: null, text: line, job: null };
  return { area, text, job };
}
var RELEASE = /^## v(\S+) \((\d{4}-\d{2}-\d{2})\)$/;
var HEADING = /^(#{1,6})(?:\s|$)/;
var SECTIONS = { "### Breaking": "breaking", "### Added": "added", "### Fixed": "fixed" };
function parseChangelog(text) {
  const releases = [];
  let release = null;
  let section = null;
  for (const raw of text.split(`
`)) {
    const line = raw.trimEnd();
    if (line.trim() === "")
      continue;
    const h = HEADING.exec(line);
    if (h !== null) {
      const level = (h[1] ?? "").length;
      const r = RELEASE.exec(line);
      const key = Object.hasOwn(SECTIONS, line) ? SECTIONS[line] : undefined;
      if (r !== null && isSemver(r[1] ?? "")) {
        release = { version: r[1] ?? "", date: r[2] ?? "", sections: { breaking: [], added: [], fixed: [] } };
        releases.push(release);
        section = null;
      } else if (key !== undefined && release !== null) {
        section = release.sections[key];
      } else {
        if (level <= 2)
          release = null;
        section = null;
      }
      continue;
    }
    if (section !== null)
      section.push(parseEntry(line));
  }
  return releases;
}
async function readChangelog(cloneRoot) {
  if (cloneRoot === undefined)
    return [];
  try {
    return parseChangelog(await readFile2(join2(cloneRoot, "CHANGELOG.md"), "utf8"));
  } catch {
    return [];
  }
}
async function readRelease(cloneRoot, running, versionFile = SOURCE_VERSION_FILE) {
  const [onDisk, changelog] = await Promise.all([readTemplatesVersion(cloneRoot, versionFile), readChangelog(cloneRoot)]);
  return { running, onDisk, changelog };
}

// packages/andon-service/src/settled.ts
var HOUR_MS2 = 3600000;
var MAX_DELAY_MS = 2147483647;
var str2 = (v) => typeof v === "string" ? v : null;
var jobFacts = (job) => ({ stage: str2(job.stage), endedAt: str2(job.endedAt), epic: str2(job.epic) });
var epicFacts = (epic) => ({ state: str2(epic.state), endedAt: str2(epic.endedAt) });
function endedAt(rec) {
  if (typeof rec.endedAt !== "string")
    return null;
  const ended = Date.parse(rec.endedAt);
  return Number.isNaN(ended) ? null : ended;
}
var mergedAt = (job) => job.stage === "merged" ? endedAt(job) : null;
function isEpicSnapshotSettled(epic, hours, now) {
  return isEpicSettled(epicFacts(epic), hours, now);
}
function isSettled2(job, epics, hours, now) {
  const slug = str2(job.epic);
  const epic = slug === null ? undefined : epics.get(slug);
  return isSettled(jobFacts(job), hours, now, epic === undefined ? null : epicFacts(epic));
}
function partition(jobs, epics, hours, now) {
  const out = { unsettled: [], settled: [], unsettledEpics: [], settledEpics: [] };
  for (const job of jobs)
    (isSettled2(job, epics, hours, now) ? out.settled : out.unsettled).push(job);
  for (const epic of epics.values())
    (isEpicSnapshotSettled(epic, hours, now) ? out.settledEpics : out.unsettledEpics).push(epic);
  return out;
}
function summarize(settled, settledEpics) {
  let last = null;
  for (const job of settled) {
    const at = mergedAt(job);
    if (at !== null && typeof job.endedAt === "string" && (last === null || at > last.at))
      last = { at, text: job.endedAt };
  }
  return { count: settled.length, lastMergedAt: last === null ? null : last.text, epics: settledEpics.length };
}
function nextSettle(jobs, epics, hours, now) {
  const ends = [];
  for (const job of jobs) {
    const ended = mergedAt(job);
    if (ended !== null && str2(job.epic) === null && !isSettled2(job, epics, hours, now))
      ends.push(ended);
  }
  for (const epic of epics.values()) {
    const ended = epic.state === "landed" ? endedAt(epic) : null;
    if (ended !== null && !isEpicSnapshotSettled(epic, hours, now))
      ends.push(ended);
  }
  let next = null;
  for (const ended of ends) {
    const delay = Math.max(0, Math.floor(ended + hours * HOUR_MS2 - now) + 1);
    if (next === null || delay < next)
      next = delay;
  }
  return next;
}

// packages/andon-service/src/index.ts
var HOSTNAME = "127.0.0.1";
var JOB_ID3 = /^\d{3}-[a-z0-9-]+$/;
var BRIEF = /^factory\/briefs\/[\w.-]+\.md$/;
var projectId = (root) => createHash("sha256").update(root).digest("hex").slice(0, 12);
var message2 = (e) => (e instanceof Error ? e.message : String(e)).split(`
`)[0] ?? "";
var isRecord5 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
async function entries(dir) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}
async function readJob(p, id) {
  try {
    const job = JSON.parse(await readFile3(join3(p.factory, "jobs", id, "job.json"), "utf8"));
    if (isRecord5(job))
      p.lastGood.set(id, { ...job });
  } catch {}
  return p.lastGood.get(id);
}
async function readEpic(p, slug) {
  try {
    const epic = JSON.parse(await readFile3(join3(p.factory, "jobs", "epics", slug, "epic.json"), "utf8"));
    if (isRecord5(epic))
      p.lastGoodEpic.set(slug, { ...epic });
  } catch {}
  return p.lastGoodEpic.get(slug);
}
async function readConfig(p) {
  return parseConfig(JSON.parse(await readFile3(join3(p.factory, "config.json"), "utf8")));
}
async function resolveName(p) {
  try {
    return (await readConfig(p)).name ?? basename2(p.info.root);
  } catch {
    return basename2(p.info.root);
  }
}
var bySlugOrId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
async function board(p) {
  const config = await readConfig(p);
  await p.archiveTask;
  const ids = (await entries(join3(p.factory, "jobs"))).filter((d) => d.isDirectory() && JOB_ID3.test(d.name)).map((d) => d.name);
  const local = new Set(ids);
  const read = await Promise.all(ids.map(async (id) => ({ id, job: await readJob(p, id) })));
  for (const [id, a] of p.archive.jobs)
    if (!local.has(id))
      read.push({ id, job: { ...a.job } });
  read.sort(bySlugOrId);
  const jobs = read.map((r) => r.job).filter((j) => j !== undefined);
  const slugs = (await entries(join3(p.factory, "jobs", "epics"))).filter((d) => d.isDirectory() && isEpicSlug(d.name)).map((d) => d.name);
  const localEpics = new Set(slugs);
  const epicRead = await Promise.all(slugs.map(async (id) => ({ id, epic: await readEpic(p, id) })));
  for (const [slug, a] of p.archive.epics) {
    if (localEpics.has(slug))
      continue;
    try {
      epicRead.push({ id: slug, epic: projectArchivedEpic(a, jobs) });
    } catch (e) {
      const key = `${p.archive.tip ?? ""} ${slug}`;
      if (!p.epicFailures.has(key)) {
        p.epicFailures.add(key);
        p.log(`andon: ${p.info.root}: factory/archive epics/${slug}: ${message2(e)}; left out`);
      }
    }
  }
  epicRead.sort(bySlugOrId);
  const epics = new Map;
  for (const r of epicRead)
    if (r.epic !== undefined)
      epics.set(r.id, r.epic);
  return { jobs, config, epics };
}
function plain(b, now) {
  const { unsettledEpics } = partition([], b.epics, b.config.dashboard.settleAfterHours, now);
  return { jobs: b.jobs, config: b.config, epics: unsettledEpics };
}
function narrow(b, now) {
  const { unsettled, settled, unsettledEpics, settledEpics } = partition(b.jobs, b.epics, b.config.dashboard.settleAfterHours, now);
  return { jobs: unsettled, config: b.config, settled: summarize(settled, settledEpics), epics: unsettledEpics };
}
function settledOf(b, now) {
  const { settled, settledEpics } = partition(b.jobs, b.epics, b.config.dashboard.settleAfterHours, now);
  return { jobs: settled, epics: settledEpics };
}
async function readInside(p, rel) {
  const path = join3(p.factory, rel);
  try {
    if (!(await lstat(path)).isFile())
      return null;
    const [root, real] = await Promise.all([realpath(p.factory), realpath(path)]);
    if (!real.startsWith(root + sep))
      return null;
    return await readFile3(real, "utf8");
  } catch {
    return null;
  }
}
async function epicDocs(p, slug) {
  const path = `epics/${slug}.md`;
  let plan = await readInside(p, path);
  if (plan === null) {
    await p.archiveTask;
    plan = p.archive.epics.get(slug)?.plan ?? null;
  }
  if (plan === null)
    return null;
  const files = [{ path, text: plan }];
  for (const m of parsePlan(plan).members) {
    const brief = `briefs/${m.slug}.md`;
    const text = await readInside(p, brief);
    if (text !== null)
      files.push({ path: brief, text });
  }
  return { files };
}
var num = (name) => Number(name.match(/\d+/)?.[0] ?? 0);
function readingOrder(top, rounds, reviewers) {
  const reworks = top.filter((f) => /^rework-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const conflicts = top.filter((f) => /^conflict-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const paths = ["feature.md", "spec.md", "build.md", ...reworks, ...conflicts, "decision.md"].filter((f) => top.includes(f));
  const rank = (f) => {
    const i = reviewers.indexOf(f.replace(/^review-|\.md$/g, ""));
    return i === -1 ? reviewers.length : i;
  };
  for (const round of [...rounds.keys()].filter((r) => /^round-\d+$/.test(r)).sort((a, b) => num(a) - num(b))) {
    const files = [...rounds.get(round) ?? []].filter((f) => f.endsWith(".md"));
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    paths.push(...files.map((f) => `${round}/${f}`));
  }
  return paths;
}
async function briefPath2(p, job) {
  const brief = job?.brief;
  if (typeof brief !== "string" || !BRIEF.test(brief))
    return null;
  const rel = brief.replace(/^factory\//, "");
  const info = await lstat(join3(p.factory, rel)).catch(() => null);
  return info?.isFile() === true ? rel : null;
}
async function docs(p, id) {
  const { reviewers } = await readConfig(p);
  const dir = join3(p.factory, "jobs", id);
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    await p.archiveTask;
    const archived = info === null || !info.isSymbolicLink() ? p.archive.jobs.get(id) : undefined;
    if (archived === undefined)
      return { files: [] };
    const top = [];
    const rounds = new Map;
    for (const rel of archived.files.keys()) {
      const [head, name, ...rest] = rel.split("/");
      if (head === undefined)
        continue;
      if (name === undefined)
        top.push(head);
      else if (rest.length === 0)
        rounds.set(head, [...rounds.get(head) ?? [], name]);
    }
    const files = readingOrder(top, rounds, reviewers).map((rel) => ({ path: `jobs/${id}/${rel}`, text: archived.files.get(rel) ?? "" }));
    const brief = await briefPath2(p, archived.job);
    if (brief !== null)
      files.unshift({ path: brief, text: await readFile3(join3(p.factory, brief), "utf8") });
    return { files };
  }
  const top = (await entries(dir)).filter((d) => d.isFile()).map((d) => d.name);
  const rounds = new Map;
  for (const d of await entries(dir)) {
    if (!d.isDirectory() || !/^round-\d+$/.test(d.name))
      continue;
    rounds.set(d.name, (await entries(join3(dir, d.name))).filter((f) => f.isFile()).map((f) => f.name));
  }
  const paths = readingOrder(top, rounds, reviewers).map((rel) => `jobs/${id}/${rel}`);
  const brief = await briefPath2(p, await readJob(p, id));
  if (brief !== null)
    paths.unshift(brief);
  const files = await Promise.all(paths.map(async (path) => ({ path, text: await readFile3(join3(p.factory, path), "utf8") })));
  return { files };
}
var NO_STORE = { "cache-control": "no-store" };
var json = (body) => Response.json(body, { headers: NO_STORE });
var text = (body, status) => new Response(body, { status, headers: NO_STORE });
var notFound = () => text("Not found", 404);
var UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
async function uiFile(uiDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\x00"))
    return null;
  if (rel === "/")
    rel = "/index.html";
  const root = await realpath(uiDir).catch(() => null);
  if (root === null)
    return null;
  const inside = (p) => p.startsWith(root + sep);
  const target = resolve2(root, `.${rel}`);
  if (!inside(target))
    return null;
  const real = await realpath(target).catch(() => null);
  if (real === null || !inside(real))
    return null;
  if ((await stat(real).catch(() => null))?.isFile() !== true)
    return null;
  const file = Bun.file(real);
  return new Response(file, { headers: { ...NO_STORE, "content-type": file.type, "content-security-policy": UI_CSP } });
}
var encoder = new TextEncoder;
var frame = (event, data) => encoder.encode(`event: ${event}
data: ${JSON.stringify(data)}

`);
async function startService(opts) {
  const debounceMs = opts.debounceMs ?? 50;
  const log = opts.log ?? ((line) => console.error(line));
  const git = opts.git ?? spawnGit;
  const timers = opts.settleTimers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
  const clients = new Map;
  let projects = new Map;
  let stopped = false;
  const versionFile = opts.versionFile ?? SOURCE_VERSION_FILE;
  const running = await readTemplatesVersion(opts.cloneRoot, versionFile);
  const resolveRelease = async (p) => {
    const installed = await readInstalled(p.factory);
    return { installed, state: releaseState(installed, running) };
  };
  let announcing = Promise.resolve();
  function announce(force) {
    const run = announcing.then(async () => {
      const open = [...projects.values()];
      const [names, releases] = await Promise.all([Promise.all(open.map(resolveName)), Promise.all(open.map(resolveRelease))]);
      let changed = force;
      const current = open.filter((p, i) => {
        const name = names[i] ?? basename2(p.info.root);
        if (name !== p.info.name) {
          p.info.name = name;
          changed = true;
        }
        const release = releases[i] ?? { installed: null, state: "unknown" };
        if (release.installed !== p.info.release.installed || release.state !== p.info.release.state) {
          p.info.release = release;
          changed = true;
        }
        return !p.closed;
      });
      const list = current.map((p) => ({ ...p.info, release: { ...p.info.release } }));
      if (changed)
        broadcast("projects", { projects: list });
      return list;
    });
    announcing = run.catch(() => {
      return;
    });
    return run;
  }
  const hasForm = (form) => [...clients.values()].includes(form);
  function removeClient(c) {
    if (!clients.delete(c))
      return;
    if (!hasForm("narrow"))
      for (const p of projects.values())
        clearSettle(p);
  }
  function broadcast(event, data, form) {
    const bytes = frame(event, data);
    for (const [c, f] of [...clients]) {
      if (form !== undefined && f !== form)
        continue;
      try {
        c.enqueue(bytes);
      } catch {
        removeClient(c);
      }
    }
  }
  function clearSettle(p) {
    if (p.settleTimer !== null)
      timers.clear(p.settleTimer);
    p.settleTimer = null;
  }
  function armSettle(p, b) {
    clearSettle(p);
    if (p.closed || stopped || !hasForm("narrow"))
      return;
    const now = Date.now();
    const delay = nextSettle(b.jobs, b.epics, b.config.dashboard.settleAfterHours, now);
    if (delay === null)
      return;
    p.settleDue = now + delay;
    p.settleTimer = timers.set(() => {
      p.settleTimer = null;
      settleFired(p);
    }, Math.min(delay, MAX_DELAY_MS));
  }
  async function armFromBuild(p) {
    try {
      await archiveReady(p);
      const b = await board(p);
      if (!p.closed)
        armSettle(p, b);
    } catch {
      clearSettle(p);
    }
  }
  async function settleFired(p) {
    if (p.closed || !hasForm("narrow"))
      return;
    try {
      await archiveReady(p);
      const b = await board(p);
      if (p.closed)
        return;
      const now = Date.now();
      if (now >= p.settleDue)
        broadcast("board", { project: p.info.id, ...narrow(b, now) }, "narrow");
      armSettle(p, b);
    } catch {
      clearSettle(p);
    }
  }
  async function readArchiveOf(p) {
    if (p.closed)
      return;
    try {
      const tip = await archiveTip(git, p.info.root);
      if (tip === p.archive.tip || p.closed)
        return;
      const next = tip === null ? EMPTY_ARCHIVE : await readArchive(git, p.info.root, tip, log);
      if (!p.closed) {
        p.archive = next;
        p.epicFailures.clear();
      }
    } catch (e) {
      if (!p.closed)
        log(`andon: ${p.info.root}: reading factory/archive: ${message2(e)}`);
    }
  }
  function refreshArchive(p) {
    p.archiveDirty = false;
    p.archiveTask = p.archiveTask.then(() => readArchiveOf(p));
    return p.archiveTask;
  }
  const archiveReady = (p) => p.archiveDirty ? refreshArchive(p) : p.archiveTask;
  async function emitBoard(p) {
    if (p.closed || clients.size === 0)
      return;
    try {
      await archiveReady(p);
      const b = await board(p);
      if (!p.closed) {
        const now = Date.now();
        if (hasForm("plain"))
          broadcast("board", { project: p.info.id, ...plain(b, now) }, "plain");
        if (hasForm("narrow"))
          broadcast("board", { project: p.info.id, ...narrow(b, now) }, "narrow");
        armSettle(p, b);
      }
    } catch (e) {
      clearSettle(p);
      if (!p.closed)
        broadcast("error", { project: p.info.id, reason: `config.json: ${message2(e)}` });
    }
    if (!p.closed)
      await announce(false);
  }
  function schedule(p) {
    if (p.closed || p.timer !== null)
      return;
    p.timer = setTimeout(() => {
      p.timer = null;
      emitBoard(p);
    }, debounceMs);
  }
  function watchJobs(p) {
    if (p.closed || p.jobsWatcher !== null)
      return;
    try {
      const w = watch(join3(p.factory, "jobs"), { recursive: true }, () => schedule(p));
      w.on("error", () => {
        w.close();
        if (p.jobsWatcher === w)
          p.jobsWatcher = null;
      });
      p.jobsWatcher = w;
    } catch {}
  }
  function watchEpics(p) {
    if (p.closed || p.epicsWatcher !== null)
      return;
    p.epicsWatcher = watchDir(join3(p.factory, "epics"), () => schedule(p), (w) => {
      if (p.epicsWatcher === w)
        p.epicsWatcher = null;
    });
  }
  function refMoved(p) {
    p.archiveDirty = true;
    schedule(p);
  }
  function watchDir(dir, on, drop) {
    try {
      const w = watch(dir, (_event, name) => on(name));
      w.on("error", () => {
        w.close();
        drop(w);
      });
      return w;
    } catch {
      return null;
    }
  }
  function watchFactoryRefs(p, common) {
    if (p.closed)
      return;
    p.refs.factory?.close();
    p.refs.factory = watchDir(join3(common, "refs", "heads", "factory"), () => refMoved(p), (w) => {
      if (p.refs.factory === w)
        p.refs.factory = null;
    });
  }
  function watchRefs(p, common) {
    p.refs.common = watchDir(common, (name) => {
      if (name === null || name === "packed-refs")
        refMoved(p);
    }, (w) => {
      if (p.refs.common === w)
        p.refs.common = null;
    });
    p.refs.heads = watchDir(join3(common, "refs", "heads"), (name) => {
      if (name !== null && name !== "factory")
        return;
      watchFactoryRefs(p, common);
      refMoved(p);
    }, (w) => {
      if (p.refs.heads === w)
        p.refs.heads = null;
    });
    watchFactoryRefs(p, common);
  }
  async function openArchive(p) {
    const common = await gitCommonDir(git, p.info.root);
    if (common === null || p.closed)
      return;
    watchRefs(p, common);
    await readArchiveOf(p);
  }
  function openProject(root) {
    const p = {
      info: { id: projectId(root), name: basename2(root), root, release: { installed: null, state: "unknown" } },
      factory: join3(root, "factory"),
      lastGood: new Map,
      lastGoodEpic: new Map,
      factoryWatcher: null,
      jobsWatcher: null,
      epicsWatcher: null,
      timer: null,
      settleTimer: null,
      settleDue: 0,
      closed: false,
      archive: EMPTY_ARCHIVE,
      archiveDirty: false,
      archiveTask: Promise.resolve(),
      refs: { common: null, heads: null, factory: null },
      log,
      epicFailures: new Set
    };
    p.archiveTask = openArchive(p);
    try {
      const w = watch(p.factory, (_event, filename) => {
        if (filename !== null && filename.startsWith("."))
          return;
        if (filename === null || filename === "jobs")
          watchJobs(p);
        if (filename === null || filename === "epics")
          watchEpics(p);
        schedule(p);
      });
      w.on("error", () => {
        w.close();
        if (p.factoryWatcher === w)
          p.factoryWatcher = null;
      });
      p.factoryWatcher = w;
    } catch {}
    watchJobs(p);
    watchEpics(p);
    return p;
  }
  function closeProject(p) {
    p.closed = true;
    p.factoryWatcher?.close();
    p.jobsWatcher?.close();
    p.epicsWatcher?.close();
    p.factoryWatcher = null;
    p.jobsWatcher = null;
    p.epicsWatcher = null;
    for (const w of [p.refs.common, p.refs.heads, p.refs.factory])
      w?.close();
    p.refs = { common: null, heads: null, factory: null };
    if (p.timer !== null)
      clearTimeout(p.timer);
    p.timer = null;
    clearSettle(p);
  }
  async function loadRegistry() {
    if (stopped)
      return;
    let roots;
    try {
      roots = (await readRegistry(opts.registryPath)).projects.map((p) => p.root);
    } catch (e) {
      log(`andon: ${opts.registryPath}: ${message2(e)}`);
      return;
    }
    if (stopped)
      return;
    const before = [...projects.keys()].join(",");
    const next = new Map;
    const opened = [];
    for (const root of roots) {
      const id = projectId(root);
      const known = projects.get(id);
      if (known !== undefined)
        next.set(id, known);
      else {
        const p = openProject(root);
        opened.push(p);
        next.set(id, p);
      }
    }
    for (const [id, p] of projects)
      if (!next.has(id))
        closeProject(p);
    projects = next;
    if (hasForm("narrow"))
      for (const p of opened)
        armFromBuild(p);
    if ([...projects.keys()].join(",") !== before)
      await announce(true);
  }
  let reloading = Promise.resolve();
  let registryTimer = null;
  const reload = () => {
    reloading = reloading.then(loadRegistry);
    return reloading;
  };
  function scheduleRegistry() {
    if (stopped || registryTimer !== null)
      return;
    registryTimer = setTimeout(() => {
      registryTimer = null;
      reload();
    }, debounceMs);
  }
  const registryDir = dirname2(opts.registryPath);
  let registryWatcher = null;
  try {
    await mkdir2(registryDir, { recursive: true });
    registryWatcher = watch(registryDir, () => scheduleRegistry());
    registryWatcher.on("error", (e) => log(`andon: watching ${registryDir}: ${message2(e)}`));
  } catch (e) {
    log(`andon: cannot watch ${registryDir}: ${message2(e)}`);
  }
  await reload();
  let releaseTimer = null;
  const releaseBody = () => readRelease(opts.cloneRoot, running, versionFile);
  async function emitRelease() {
    if (stopped || clients.size === 0)
      return;
    const body = await releaseBody();
    if (!stopped)
      broadcast("release", body);
  }
  function scheduleRelease() {
    if (stopped || releaseTimer !== null)
      return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      emitRelease();
    }, debounceMs);
  }
  const cloneWatchers = new Set;
  function watchClone(dir, files) {
    const w = watchDir(dir, (name) => {
      if (name === null || files.includes(name))
        scheduleRelease();
    }, (dropped) => cloneWatchers.delete(dropped));
    if (w !== null)
      cloneWatchers.add(w);
  }
  if (opts.cloneRoot !== undefined) {
    const root = resolve2(opts.cloneRoot);
    const versionAt = resolve2(root, versionFile);
    if (dirname2(versionAt) === root)
      watchClone(root, ["CHANGELOG.md", basename2(versionAt)]);
    else {
      watchClone(root, ["CHANGELOG.md"]);
      watchClone(dirname2(versionAt), [basename2(versionAt)]);
    }
  }
  async function events(req, form) {
    const list = await announce(false);
    const release = await releaseBody();
    let self = null;
    const drop = () => {
      if (self === null)
        return;
      removeClient(self);
      try {
        self.close();
      } catch {}
    };
    const stream = new ReadableStream({
      start(c) {
        self = c;
        const first = form === "narrow" && !hasForm("narrow");
        clients.set(c, form);
        c.enqueue(frame("projects", { projects: list }));
        c.enqueue(frame("release", release));
        if (first)
          for (const p of projects.values())
            armFromBuild(p);
      },
      cancel() {
        if (self !== null)
          removeClient(self);
      }
    });
    req.signal.addEventListener("abort", drop);
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }
  let boundPort = 0;
  function trusted(req) {
    const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    const host = req.headers.get("host");
    if (host === null || !hosts.includes(host.toLowerCase()))
      return false;
    const origin = req.headers.get("origin");
    return origin === null || hosts.some((h) => origin.toLowerCase() === `http://${h}`);
  }
  async function handle(req) {
    if (!trusted(req))
      return text("Forbidden", 403);
    if (req.method !== "GET")
      return text("Method not allowed", 405);
    const url = new URL(req.url);
    const { pathname } = url;
    const summary = url.searchParams.get("settled") === "summary";
    if (pathname === "/projects")
      return json({ projects: await announce(false) });
    if (pathname === "/events")
      return events(req, summary ? "narrow" : "plain");
    if (pathname === "/release")
      return json(await releaseBody());
    const b = pathname.match(/^\/projects\/([^/]+)\/(board|settled)$/);
    if (b !== null) {
      const p = projects.get(b[1] ?? "");
      if (p === undefined)
        return notFound();
      try {
        await archiveReady(p);
        const full = await board(p);
        const now = Date.now();
        if (b[2] === "settled")
          return json(settledOf(full, now));
        return json(summary ? narrow(full, now) : plain(full, now));
      } catch (e) {
        return text(`config.json: ${message2(e)}`, 500);
      }
    }
    const d = pathname.match(/^\/projects\/([^/]+)\/jobs\/([^/]+)\/docs$/);
    if (d !== null) {
      const p = projects.get(d[1] ?? "");
      const id = d[2] ?? "";
      if (p === undefined || !JOB_ID3.test(id))
        return notFound();
      try {
        await archiveReady(p);
        return json(await docs(p, id));
      } catch (e) {
        return text(`config.json: ${message2(e)}`, 500);
      }
    }
    const e = pathname.match(/^\/projects\/([^/]+)\/epics\/([^/]+)\/docs$/);
    if (e !== null) {
      const p = projects.get(e[1] ?? "");
      const slug = e[2] ?? "";
      if (p === undefined || !isEpicSlug(slug))
        return notFound();
      try {
        await archiveReady(p);
        const docs = await epicDocs(p, slug);
        return docs === null ? notFound() : json(docs);
      } catch (e) {
        return text(`epic docs: ${message2(e)}`, 500);
      }
    }
    if (opts.uiDir !== undefined)
      return await uiFile(opts.uiDir, pathname) ?? notFound();
    return notFound();
  }
  const server = Bun.serve({
    hostname: HOSTNAME,
    port: opts.port,
    idleTimeout: 0,
    fetch: handle
  });
  boundPort = server.port ?? 0;
  return {
    url: `http://${HOSTNAME}:${server.port}`,
    async stop() {
      stopped = true;
      if (registryTimer !== null)
        clearTimeout(registryTimer);
      registryWatcher?.close();
      if (releaseTimer !== null)
        clearTimeout(releaseTimer);
      for (const w of cloneWatchers)
        w.close();
      cloneWatchers.clear();
      const open = [...projects.values()];
      for (const p of open)
        closeProject(p);
      await Promise.all(open.map((p) => p.archiveTask));
      for (const c of clients.keys()) {
        try {
          c.close();
        } catch {}
      }
      clients.clear();
      await server.stop(true);
    }
  };
}

// packages/andon-service/src/entry.ts
var bundleTree = (bundleRoot) => ({ uiDir: join4(bundleRoot, "andon", "ui"), cloneRoot: bundleRoot, versionFile: BUNDLE_VERSION_FILE });
async function serve(tree) {
  const raw = process.env.ANDON_PORT ?? "8766";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    console.error(`andon: ANDON_PORT must be a port number (0-65535), got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  const registry = registryPath(process.env.ANDON_HOME);
  const service = await startService({ port, registryPath: registry, ...tree });
  console.log(`Andon service: ${service.url} (registry ${registry})`);
  const shutdown = () => {
    service.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// packages/andon-service/src/release-main.ts
await serve(bundleTree(join5(import.meta.dir, "..")));
