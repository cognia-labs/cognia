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
let currentRemoteTransport
let onRemoteTransportChange
let hostProfile = "desktop"
const processTransport = { transport: undefined }

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
      return {
        mergePersonalSinkContexts: (a, b) => ({ ...a, ...b }),
        unverifiedPersonalSinkContext: () => ({}),
      }
    // The ingest probes call the pure adapters and inject the real notify core.
    // Boot, native transport and the production store belong to other probes.
    if (spec === "@/lib/platform/capabilities") return { detectHostProfile: () => hostProfile }
    if (spec === "@/lib/tauri/transport-instance") return processTransport
    if (spec === "@/lib/tauri/transport-routing")
      return {
        getActiveRemoteTransport: () => currentRemoteTransport,
        subscribeActiveRemoteTransport: (listener) => {
          onRemoteTransportChange = listener
          return () => {
            onRemoteTransportChange = undefined
          }
        },
      }
    if (spec === "./runtime" || spec === "@/lib/push/push-notifications") return {}
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
const { ingestRemoteNotification, installRemoteNotificationListener } = load(
  "lib/notifications/remote-subscription.ts"
)
const { pushToInput } = load("lib/notifications/inbound-push.ts")
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
const deferredDeny = plan(fact(), sub([{ kind: "defer", until: now + 1000 }, { kind: "deny" }]))
  .routes[0]
assert.equal(deferredDeny.kind, "deferred")
record("aggregate before deny bypasses deny-first promise", {
  verdict: deny.kind,
  reason: deny.reasonCode,
  deferBeforeDenyVerdict: deferredDeny.kind,
})
const quota = planNotification({
  fact: fact(),
  subscriptions: [{ ...sub(), targetIds: ["t1", "t2"], maxIntentsPerFact: 1 }],
  targets: new Map([
    ["t1", target("t1")],
    ["t2", target("t2")],
  ]),
  incidents: [],
  priorIntents: [],
  policy: basePolicy,
  now,
}).routes
assert.deepEqual(
  quota.map((route) => route.kind),
  ["notified", "notified"]
)
record("initial fan-out exceeds the per-fact intent quota", { quota: 1, routes: quota.length })

const webhook = target("t1")
const originReply = { ...webhook, consent: { ...webhook.consent, mode: "origin-reply" } }
const normalVerdict = plan(fact(), sub(), originReply).routes[0]
const approvalVerdict = plan({ ...fact(), purpose: "approval-request" }, sub(), originReply)
  .routes[0]
assert.equal(normalVerdict.kind, "denied-by-target")
assert.equal(approvalVerdict.kind, "notified")
record("origin-reply webhook allows an approval fact without matching origin evidence", {
  ordinaryVerdict: normalVerdict.kind,
  approvalVerdict: approvalVerdict.kind,
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

  const remote = deps({
    loadPrefs: () =>
      resolvePreferences({
        perSource: {
          issue: { enabled: false },
          site: { enabled: false },
          collab: { enabled: false },
        },
      }),
  })
  const ingest = (frame, target = remote) =>
    ingestRemoteNotification(frame, {
      hostKey: "test-host",
      notifyFn: (input, host) => notify(input, target, host),
    })
  const mutedSourcesMappedToSystem = []
  for (const source of ["issue", "site", "collab"]) {
    const frame = { source, id: source, level: "warning", title: "Synthetic remote notice" }
    const direct = deps({ loadPrefs: remote.loadPrefs })
    await notify(frame, direct, { personalContext: {} })
    assert.deepEqual(direct.calls, ["persist"])
    const id = await ingest(frame)
    const row = remote.rows.get(id)
    assert.equal(row?.source, "system")
    assert.ok(row.deliveredVia.includes("toast"))
    mutedSourcesMappedToSystem.push(source)
  }
  record("remote ingress loses source and bypasses its mute", { mutedSourcesMappedToSystem })

  let receivedAt = now
  const replay = deps({ now: () => receivedAt })
  const frame = {
    id: "same-frame",
    source: "scheduler",
    level: "warning",
    title: "Synthetic replay",
  }
  const initialId = await ingest(frame, replay)
  replay.rows.get(initialId).readState = "read"
  assert.equal(await ingest(frame, replay), initialId)
  assert.equal(replay.rows.get(initialId).readState, "unseen")
  receivedAt += 46_000
  assert.notEqual(await ingest(frame, replay), initialId)
  assert.equal(replay.rows.size, 2)
  const toastCount = replay.calls.filter((call) => call === "toast").length
  assert.equal(toastCount, 3)
  record("identical remote frame interrupts again and reopens a read row", {
    toastCount,
    rowsAfterWindow: replay.rows.size,
  })

  const switched = deps()
  const ingested = []
  function makeTransport() {
    const listeners = new Set()
    return {
      listeners,
      subscribe: (_channel, listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      emit: (payload) => {
        for (const listener of listeners) listener(payload)
      },
    }
  }
  const hostA = makeTransport()
  const hostB = makeTransport()
  currentRemoteTransport = hostA
  const dispose = installRemoteNotificationListener({
    notifyFn: (input, host) => {
      const pending = notify(input, switched, host)
      ingested.push(pending)
      return pending
    },
  })
  assert.equal(hostA.listeners.size, 1)
  hostA.emit({ ...frame, title: "Host A" })
  const fromA = await ingested[0]
  switched.rows.get(fromA).readState = "read"
  onRemoteTransportChange(hostB)
  assert.equal(hostA.listeners.size, 0)
  assert.equal(hostB.listeners.size, 1)
  hostB.emit({ ...frame, title: "Host B" })
  const fromB = await ingested[1]
  assert.equal(fromA, fromB)
  assert.equal(switched.rows.get(fromA).readState, "unseen")
  assert.equal(switched.rows.get(fromA).title, "Host B")
  assert.equal(switched.rows.size, 1)
  dispose()
  record("desktop remote-host switch reuses the notification dedupe namespace", {
    distinctTransports: 2,
    resultingRows: switched.rows.size,
    overwrittenTitle: switched.rows.get(fromA).title,
  })

  hostProfile = "mobile-companion"
  processTransport.transport = hostA
  const mobileFrames = []
  const disposeMobile = installRemoteNotificationListener({
    notifyFn: async (input) => {
      mobileFrames.push(input.title)
      return "mobile-notification"
    },
  })
  hostA.emit({ ...frame, title: "Old transport" })
  processTransport.transport = hostB
  hostB.emit({ ...frame, title: "New transport" })
  assert.equal(hostB.listeners.size, 0)
  assert.deepEqual(mobileFrames, ["Old transport"])
  disposeMobile()
  record("mobile remote listener is not rebound when the process transport changes", {
    receivedFrom: mobileFrames,
    listenersOnReplacement: hostB.listeners.size,
  })

  const criticalPush = deps()
  const input = pushToInput({
    foreground: true,
    title: "Synthetic critical push",
    data: { source: "system", level: "critical" },
  })
  assert.deepEqual(input.channels, ["center"])
  await notify(input, criticalPush, { personalContext: {} })
  assert.deepEqual(criticalPush.calls, ["toast", "os", "persist"])
  record("inbound critical push requests another toast and OS alert", {
    operations: criticalPush.calls,
  })
  console.log(JSON.stringify({ probeCount: results.length, results }, null, 2))
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
