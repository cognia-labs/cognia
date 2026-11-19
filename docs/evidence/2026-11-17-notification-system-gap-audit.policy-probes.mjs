// Read-only source probes. No production files are modified and no platform
// calls occur. Pure modules use their real source; notify's unrelated scope,
// identity-merging, and ID dependencies are stubbed behind its existing DI seam.
import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
const root = process.cwd()
const rootRequire = createRequire(path.join(root, "package.json"))
const ts = rootRequire("typescript")
const cache = new Map()
function load(file) {
  file = path.resolve(root, file)
  if (cache.has(file)) return cache.get(file).exports
  const mod = { exports: {} }
  cache.set(file, mod)
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText
  const localRequire = (spec) => {
    if (spec === "nanoid") return { nanoid: () => "unused-id" }
    if (spec === "./scope" && file.endsWith("/notify.ts"))
      return { cachedNotificationScopeKey: () => "scope" }
    if (spec === "@/lib/execution/personal-sink")
      return { mergePersonalSinkContexts: (a, b) => ({ ...a, ...b }) }
    let next
    if (spec.startsWith("@/")) next = path.join(root, spec.slice(2))
    else if (spec.startsWith("@cognia/plugin-contract/"))
      next = path.join(
        root,
        "packages/plugin-contract/src",
        spec.slice("@cognia/plugin-contract/".length)
      )
    else if (spec.startsWith(".")) next = path.resolve(path.dirname(file), spec)
    else return rootRequire(spec)
    return load(fs.existsSync(next + ".ts") ? next + ".ts" : path.join(next, "index.ts"))
  }
  new Function("require", "module", "exports", source)(localRequire, mod, mod.exports)
  return mod.exports
}
const { planNotification } = load("lib/notifications/policy/planner.ts")
const { notificationPolicyContext } = load("lib/notifications/policy/context.ts")
const { resolvePreferences } = load("lib/notifications/preferences.ts")
const { resolveChannels } = load("lib/notifications/routing.ts")
const { notify } = load("lib/notifications/notify.ts")
const { buildBumpPatch } = load("lib/notifications/dedup.ts")
const { selectAutoWake } = load("lib/notifications/snooze.ts")
const scope = { namespaceId: "n", accountId: "a", authorityHostId: "h" }
const target = (id, timezone = "UTC") => ({
  id,
  version: 1,
  scope,
  scopeKey: "n::a::",
  label: id,
  address: { kind: "feishu-webhook", endpointSecretRef: "x", region: "feishu" },
  addressFingerprint: id,
  enabled: true,
  enabledKey: 1,
  consent: { mode: "proactive", grantRef: "g", grantedBy: "me", grantedAt: 0 },
  disclosureProfileId: "internal",
  locale: "en",
  timezone,
  createdAt: 0,
  updatedAt: 0,
})
const sub = (rules = []) => ({
  id: "s1",
  version: 1,
  scope,
  scopeKey: "n::a::",
  principalId: "a",
  binding: { kind: "scope" },
  targetIds: ["t1"],
  maxDisclosureProfileId: "internal",
  minLevel: "info",
  enabled: true,
  enabledKey: 1,
  rules,
  createdBy: "me",
  createdAt: 0,
  updatedAt: 0,
})
const fact = (factKey = "run:r1:terminal") => ({
  factKey,
  category: "run.terminal",
  purpose: "terminal-state",
  level: "info",
  source: "run",
  runId: "r1",
})
const now = Date.parse("2026-11-17T23:00:00Z")
const basePolicy = notificationPolicyContext(resolvePreferences(), { timezone: "UTC" })
const plan = (f = fact(), s = sub(), t = target("t1"), policy = basePolicy, priorIntents = []) =>
  planNotification({
    fact: f,
    subscriptions: [s],
    targets: new Map([[t.id, t]]),
    incidents: [],
    priorIntents,
    policy,
    now,
  })
const results = []
function record(name, detail) {
  results.push({ name, ...detail })
}
const a = plan(fact("run:r1:step-a"), sub([{ kind: "aggregate" }])).routes[0].aggregateKey
const b = plan(fact("run:r1:step-b"), sub([{ kind: "aggregate" }])).routes[0].aggregateKey
assert.notEqual(a, b)
record("different facts fail to share a digest bucket", { keyA: a, keyB: b })
const deny = plan(fact(), sub([{ kind: "aggregate" }, { kind: "deny" }])).routes[0]
assert.equal(deny.kind, "digest")
record("aggregate before deny bypasses deny-first promise", {
  verdict: deny.kind,
  reason: deny.reasonCode,
})
const old = {
  id: "old",
  source: "system",
  level: "info",
  title: "old",
  createdAt: now,
  updatedAt: now,
  readState: "read",
  count: 1,
  snoozedUntil: now + 3600000,
  groupKey: "group",
}
assert.equal(selectAutoWake([old], now, { snoozeAutoWakeOnActivity: false }).length, 0)
const bumped = buildBumpPatch(old, { title: "new", level: "info" }, now + 1000)
assert.equal(bumped.snoozedUntil, undefined)
record("dedup bump ignores disabled activity wake", {
  helperWouldWake: false,
  bumpClearsSnooze: bumped.snoozedUntil === undefined,
  newState: bumped.readState,
})
const qPrefs = resolvePreferences({ quietHours: { enabled: true, start: "22:00", end: "08:00" } })
const hostPolicy = notificationPolicyContext(qPrefs, { timezone: "UTC" })
const tokyo = target("t1", "Asia/Tokyo")
const q = plan(fact(), sub(), tokyo, hostPolicy).routes[0]
assert.equal(q.kind, "deferred")
record("target timezone is masked by host context", {
  instant: new Date(now).toISOString(),
  targetLocalTime: "08:00 Asia/Tokyo (outside quiet hours)",
  policyTimezone: hostPolicy.quietHoursTimezone,
  actualVerdict: q.kind,
})
const sleepingTargetNow = Date.parse("2026-11-17T15:00:00Z")
const sleepingTarget = planNotification({
  fact: fact(),
  subscriptions: [sub()],
  targets: new Map([["t1", tokyo]]),
  incidents: [],
  priorIntents: [],
  policy: hostPolicy,
  now: sleepingTargetNow,
}).routes[0]
assert.equal(sleepingTarget.kind, "notified")
record("target midnight can notify because host is afternoon", {
  instant: new Date(sleepingTargetNow).toISOString(),
  targetLocalTime: "00:00 Asia/Tokyo (inside quiet hours)",
  actualVerdict: sleepingTarget.kind,
})
const crit = { ...fact(), level: "critical" }
const v1Crit = resolveChannels({ source: "system", level: "critical" }, qPrefs, now, "UTC")
const v2Crit = plan(crit, sub(), target("t1"), hostPolicy).routes[0]
assert.equal(v1Crit.suppressedByDnd, false)
assert.equal(v2Crit.kind, "deferred")
record("critical quiet-hours behavior differs between pipelines", {
  v1Channels: v1Crit.channels,
  v2Verdict: v2Crit.kind,
})
function deps(overrides = {}) {
  const rows = new Map(),
    calls = []
  let seq = 0
  const db = {
    findByDedupeKey: async (key, since) =>
      [...rows.values()].find((x) => x.dedupeKey === key && x.updatedAt >= since),
    putNotification: async (rec) => {
      calls.push("persist")
      rows.set(rec.id, rec)
    },
    patchNotification: async (id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
    pruneNotifications: async () => [],
  }
  return {
    rows,
    calls,
    db,
    now: () => now,
    loadPrefs: () =>
      resolvePreferences({ globalDefaultChannels: ["center", "toast", "os", "push"] }),
    newId: () => `n${++seq}`,
    toast: () => calls.push("toast"),
    osNotify: async () => {
      calls.push("os")
    },
    push: async () => {
      calls.push("push")
    },
    tz: "UTC",
    ...overrides,
  }
}
;(async () => {
  const dnd = deps({
    loadPrefs: () => ({ ...qPrefs, globalDefaultChannels: ["center", "toast", "os", "push"] }),
  })
  await notify({ source: "system", level: "info", title: "notice" }, dnd, { personalContext: {} })
  assert.deepEqual(dnd.calls, ["persist"])
  record("quiet hours strip V1 channels without creating deferred work", {
    operations: dnd.calls,
    recordChannels: [...dnd.rows.values()][0].deliveredVia,
  })
  const perm = deps({
    isOsPermitted: async () => {
      throw new Error("permission bridge failed")
    },
  })
  let failure
  try {
    await notify({ source: "system", level: "error", title: "notice" }, perm, {
      personalContext: {},
    })
  } catch (e) {
    failure = e.message
  }
  assert.equal(perm.rows.size, 0)
  assert.equal(failure, "permission bridge failed")
  record("permission checker error drops persistence and later channels", {
    error: failure,
    operations: perm.calls,
    storedRows: perm.rows.size,
  })
  const concurrent = deps()
  await Promise.all(
    [1, 2].map(() =>
      notify({ source: "system", level: "error", title: "same", dedupeKey: "same" }, concurrent, {
        personalContext: {},
      })
    )
  )
  assert.equal(concurrent.rows.size, 2)
  record("concurrent same-key calls create two records", {
    rowCount: concurrent.rows.size,
    ids: [...concurrent.rows.keys()],
  })
  const order = deps()
  await notify({ source: "system", level: "error", title: "notice" }, order, {
    personalContext: {},
  })
  assert.equal(order.calls.at(-1), "persist")
  record("ephemeral side effects precede durable record", { operations: order.calls })
  const expired = deps()
  await notify(
    { source: "system", level: "error", title: "expired", validUntil: now - 1 },
    expired,
    { personalContext: {} }
  )
  assert.ok(expired.calls.includes("os"))
  record("expired validUntil still fans out", {
    operations: expired.calls,
    rowExpiresAt: [...expired.rows.values()][0].expiresAt ?? null,
  })
  const silent = deps()
  await notify(
    { source: "system", level: "error", title: "silent", presentation: "silent" },
    silent,
    { personalContext: {} }
  )
  assert.ok(silent.calls.includes("toast"))
  record("silent presentation still interrupts", {
    operations: silent.calls,
    storedPresentation: [...silent.rows.values()][0].presentation,
  })
  const repeatedOp = deps()
  const opInput = {
    source: "system",
    level: "error",
    title: "once",
    operationKey: "stable-operation",
  }
  await notify(opInput, repeatedOp, { personalContext: {} })
  await notify(opInput, repeatedOp, { personalContext: {} })
  assert.equal(repeatedOp.rows.size, 2)
  record("same operationKey creates two durable records and two fanouts", {
    storedRows: repeatedOp.rows.size,
    toastCount: repeatedOp.calls.filter((x) => x === "toast").length,
  })
  console.log(JSON.stringify({ probeCount: results.length, results }, null, 2))
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
