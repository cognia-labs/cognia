// Characterization probe of the PRE-FIX memory code (audit snapshot b2aa1ccee1).
// It asserts the defective behaviour and now fails by design; the fixes and their
// desired-behaviour tests are listed in the ledger's Repair record.
// Characterization probes for the memory job queue and worker. A passing
// assertion reproduces the reported behavior; it does not endorse it.
// Run: node --test docs/evidence/2026-11-08-memory-support-audit.lease-probes.mjs
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { after, afterEach, beforeEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import Dexie from "dexie"
import { build } from "esbuild"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

const root = fileURLToPath(new URL("../../", import.meta.url))
const cache = path.join(root, ".cache/memory-support-audit")
await mkdir(cache, { recursive: true })
const scratch = await mkdtemp(path.join(cache, "lease-probe-"))
const outfile = path.join(scratch, "source.mjs")

// Keep the queue, worker, extraction, policy, and memory/evidence writes real.
// Isolate the host schema, source readers, and all provider/backend access.
const seams = new Map([
  ["schema", "export const getDb = () => globalThis.__memoryLeaseAudit.db"],
  [
    "@/lib/db/settings",
    "export const getSettings = async () => globalThis.__memoryLeaseAudit.settings",
  ],
  [
    "@/lib/db/sessions",
    "export const getSession = id => globalThis.__memoryLeaseAudit.db.sessions.get(id)",
  ],
  [
    "@/lib/db/messages",
    `export const listMessages = sessionId => globalThis.__memoryLeaseAudit.db.messages
    .where('sessionId').equals(sessionId).toArray()`,
  ],
  ["@/lib/db/characters", "export const resolveCharacterById = async () => undefined"],
  [
    "@/lib/db/project-scope",
    `export const resolveScopeProjectId = async () => 'fixture-project';
    export const resolveSessionProjectId = resolveScopeProjectId;`,
  ],
  [
    "./acting-authority",
    `export const resolveRunActingIdentity = async () => undefined;
    export const resolveExecutingRun = async () => { throw Error('Unexpected execution run') };`,
  ],
  [
    "@/lib/db/execution-runs",
    `const unexpected = async () => { throw Error('Unexpected execution run') };
    export const appendRunEventInsideTransaction = unexpected, semanticRunEvent = unexpected;`,
  ],
  [
    "@/lib/db/files-library-items",
    "export const preserveGeneratedVideoRecords = async () => { throw Error('Unexpected video preservation') }",
  ],
  [
    "@/lib/memory/backfill/backfill-service",
    "export const tickWorkspaceBackfill = async () => { throw Error('Unexpected backfill') }",
  ],
  [
    "@/lib/memory/runtime/build-deps",
    `export const tryBuildMemoryDeps = async () => undefined;
    export const tryBuildMemoryVectorSink = async () => globalThis.__memoryLeaseAudit.sink;
    export const withPersonalMemoryVisibility = deps => deps;
    export const filterPersonalMemories = async rows => rows;
    export const tryBuildMemoryVectorReader = async () => undefined;`,
  ],
  ["@/lib/memory/retrieve/retriever", "export const retrieveMemories = async () => []"],
  [
    "@/lib/ai/generation/utility-client",
    "export const buildUtilityLlmClient = () => globalThis.__memoryLeaseAudit.client",
  ],
  [
    "@/lib/network/platform-streaming-fetch",
    "export const platformStreamingFetch = async () => { throw Error('Unexpected streaming fetch') }",
  ],
  [
    "@/lib/prompts/resolve",
    "export const resolvePromptAsync = async definition => ({ text: definition.defaultBody })",
  ],
  [
    "@/lib/project-knowledge/ingest/ingest-file",
    "export const hashContent = () => { throw Error('Unexpected project hashing') }",
  ],
  [
    "@/lib/memory/lifecycle/build-maintenance-deps",
    "export const buildEpisodicMaintenanceDeps = async () => { throw Error('Unexpected distillation') }",
  ],
  [
    "@/lib/memory/write/run-project-mining",
    "export const buildProjectMiningDeps = async () => { throw Error('Unexpected mining') }; export const runProjectMining = buildProjectMiningDeps",
  ],
  [
    "@/lib/memory/lifecycle/revalidate-claim",
    "export const buildClaimRevalidationDeps = async () => { throw Error('Unexpected revalidation') }; export const revalidateClaim = buildClaimRevalidationDeps",
  ],
  [
    "@/lib/memory/backfill/repair-workspace-scope",
    "export const repairWorkspaceScopedMemories = async () => { throw Error('Unexpected repair') }",
  ],
])

after(async () => {
  delete globalThis.__memoryLeaseAudit
  await rm(scratch, { recursive: true, force: true })
})

await build({
  stdin: {
    contents: `export * from './lib/db/memory-governance.ts';
      export { enqueueDailyVectorReconcile } from './lib/memory/lifecycle/enqueue-reconcile.ts';
      export { enqueueTurnMemory } from './lib/memory/lifecycle/enqueue-turn-memory.ts';
      export { revokeClaimsForDeletedSession } from './lib/memory/lifecycle/claim-deletion-closure.ts';
      export { drainMemoryJobs } from './lib/memory/lifecycle/job-worker.ts';
      export { DEFAULT_MEMORY_CONFIG } from './packages/memory/src/types/memory.ts';`,
    resolveDir: root,
    loader: "ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [
    {
      name: "memory-lease-audit-resources",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: requested, importer }) => {
          const key =
            requested === "@/lib/db/schema" ||
            (requested === "./schema" && path.dirname(importer) === path.join(root, "lib/db"))
              ? "schema"
              : requested
          return seams.has(key) ? { path: key, namespace: "audit-seam" } : undefined
        })
        builder.onLoad({ filter: /.*/, namespace: "audit-seam" }, ({ path: key }) => ({
          contents: seams.get(key),
          resolveDir: root,
        }))
      },
    },
  ],
})

const src = await import(pathToFileURL(outfile).href)
let db
let fixture
let sequence = 0
beforeEach(() => {
  db = new Dexie(`memory-lease-audit-${++sequence}`, { indexedDB, IDBKeyRange })
  db.version(1).stores({
    adapterInstances: "&id",
    sessions: "&id",
    messages: "&id,sessionId",
    memories: "&id,status",
    memoryEvidence: "&id,memoryId,sessionId,messageId",
    memoryAuditEvents: "&id,memoryId,sessionId",
    memoryJobs: "&id,dedupeKey,sessionId,queuedAt,[status+queuedAt]",
  })
  fixture = globalThis.__memoryLeaseAudit = {
    db,
    settings: { memory: { ...src.DEFAULT_MEMORY_CONFIG, mineProjectContext: false } },
  }
})
afterEach(() => db.delete())

function enqueueVectorJob(dedupeKey) {
  return src.enqueueMemoryJob({
    dedupeKey,
    queuedAt: 100,
    kind: "vector-reconcile",
    scope: "global",
    provenance: "system",
    evidenceIds: [],
  })
}

test("Q1: the production daily enqueuer duplicates work while an earlier job waits to retry", async (t) => {
  const now = Date.parse("2026-11-08T12:00:00Z")
  t.mock.method(Date, "now", () => now)
  await src.enqueueDailyVectorReconcile(now)
  const first = await src.claimNextMemoryJob("worker", now, 1_000)
  assert.ok(first)
  await src.enqueueDailyVectorReconcile(now)
  assert.deepEqual(
    (await src.listMemoryJobs()).map(({ id }) => id),
    [first.id]
  )

  const failedAt = now + 1
  assert.equal(
    await src.failMemoryJob(first.id, "fixture_transient", failedAt, {
      workerId: "worker",
      fencingEpoch: first.fencingEpoch,
      baseDelayMs: 60_000,
    }),
    "retry_wait"
  )
  await src.enqueueDailyVectorReconcile(now)
  const second = await src.claimNextMemoryJob("worker", now + 2, 1_000)
  assert.ok(second)
  assert.notEqual(second.id, first.id)
  assert.equal(second.dedupeKey, first.dedupeKey)
  assert.equal(
    await src.finishMemoryJob(second.id, "succeeded", "fixture_success", now + 3, {
      workerId: "worker",
      fencingEpoch: second.fencingEpoch,
    }),
    "finished"
  )
  assert.equal((await src.claimNextMemoryJob("worker", failedAt + 60_000, 1_000))?.id, first.id)
})

test("Q2: an expired unreclaimed lease refuses renewal but accepts completion", async () => {
  const job = await enqueueVectorJob("expired")
  const claim = await src.claimNextMemoryJob("worker", 100, 50)
  assert.equal(
    await src.heartbeatMemoryJob(job.id, "worker", 151, 50, claim.fencingEpoch),
    undefined
  )
  assert.equal(
    await src.finishMemoryJob(job.id, "succeeded", "fixture_success", 151, {
      workerId: "worker",
      fencingEpoch: claim.fencingEpoch,
    }),
    "finished"
  )
  assert.equal((await src.getMemoryJob(job.id)).status, "succeeded")

  const control = await enqueueVectorJob("reclaimed")
  const first = await src.claimNextMemoryJob("worker", 200, 50)
  const second = await src.claimNextMemoryJob("worker", 250, 50)
  assert.equal(second.id, control.id)
  assert.equal(second.fencingEpoch, first.fencingEpoch + 1)
  assert.equal(
    await src.finishMemoryJob(control.id, "succeeded", "fixture_success", 251, {
      workerId: "worker",
      fencingEpoch: first.fencingEpoch,
    }),
    "lost"
  )
})

test("Q3: a mix of lease expiry and processing failure exceeds the default attempt cap", async () => {
  const job = await enqueueVectorJob("mixed")
  assert.equal(job.maxAttempts, 4)
  assert.equal((await src.claimNextMemoryJob("worker", 100, 10)).attempt, 1)
  let now = 110
  for (const attempt of [2, 3, 4]) {
    const claim = await src.claimNextMemoryJob("worker", now, 10)
    assert.equal(claim.attempt, attempt)
    assert.equal(
      await src.failMemoryJob(job.id, "fixture_transient", now + 1, {
        workerId: "worker",
        fencingEpoch: claim.fencingEpoch,
      }),
      "retry_wait"
    )
    now = (await src.getMemoryJob(job.id)).nextAttemptAt
  }
  assert.equal((await src.claimNextMemoryJob("worker", now, 10)).attempt, 5)
  assert.equal(await src.claimNextMemoryJob("worker", now + 10, 10), undefined)
  assert.equal((await src.getMemoryJob(job.id)).errorCode, "lease_expired_max_attempts")
})

async function enqueueSyntheticTurn(sessionId) {
  const transcript = [
    { id: `${sessionId}-a-user`, role: "user", text: "I always use pnpm for all my projects." },
    { id: `${sessionId}-b-assistant`, role: "assistant", text: "I will remember that preference." },
  ]
  await db.sessions.add({ id: sessionId, transcriptRevision: 1 })
  await db.messages.bulkAdd(
    transcript.map(({ id, role, text }) => ({
      id,
      sessionId,
      role,
      parts: [{ type: "text", text }],
    }))
  )
  const queued = await src.enqueueTurnMemory({
    sessionId,
    transcript,
    userText: transcript[0].text,
    assistantText: transcript[1].text,
  })
  assert.equal(queued.enqueued, true)
  return queued.jobId
}

async function deleteSyntheticSource(sessionId) {
  // Mirror the transcript deletion commit, then execute the real memory-side
  // fanout invoked by the session deletion entry point after commit.
  await db.transaction("rw", db.sessions, db.messages, async () => {
    await db.messages.where("sessionId").equals(sessionId).delete()
    await db.sessions.delete(sessionId)
  })
  await src.revokeClaimsForDeletedSession(sessionId)
}

test("Q4: source deletion cancels the job row but an in-flight extraction still writes memory", async () => {
  const controlJob = await enqueueSyntheticTurn("before-claim")
  let providerCalls = 0
  fixture.client = {
    complete: async () => {
      providerCalls++
      throw Error("Unexpected extraction")
    },
  }
  await deleteSyntheticSource("before-claim")
  assert.equal(await src.drainMemoryJobs({ maxJobs: 1 }), 0)
  assert.equal((await src.getMemoryJob(controlJob)).status, "cancelled")
  assert.equal(providerCalls, 0)
  assert.equal(await db.memories.count(), 0)

  const jobId = await enqueueSyntheticTurn("after-claim")
  const providerStarted = Promise.withResolvers()
  const providerReply = Promise.withResolvers()
  const upserts = []
  fixture.client = {
    complete: async () => {
      providerCalls++
      providerStarted.resolve()
      return providerReply.promise
    },
  }
  fixture.sink = { upsert: async (id, text) => upserts.push({ id, text }) }
  const drained = src.drainMemoryJobs({ maxJobs: 1 })
  try {
    await Promise.race([
      providerStarted.promise,
      drained.then(() => {
        throw Error("Worker settled before reaching the provider fixture")
      }),
    ])
    assert.equal((await src.getMemoryJob(jobId)).status, "running")
    await deleteSyntheticSource("after-claim")
    assert.equal((await src.getMemoryJob(jobId)).status, "cancelled")
    assert.equal(await db.memories.count(), 0)
  } finally {
    providerReply.resolve(
      JSON.stringify({
        memories: [
          {
            type: "semantic",
            text: "Prefers pnpm for every project.",
            importance: 8,
          },
        ],
      })
    )
    await drained
  }

  assert.equal(providerCalls, 1)
  assert.equal((await src.getMemoryJob(jobId)).status, "cancelled")
  const [memory] = await db.memories.toArray()
  assert.equal(memory.sourceSessionId, "after-claim")
  assert.equal(memory.status, "active")
  assert.equal((await src.listMemoryEvidence(memory.id)).length, 1)
  assert.deepEqual(upserts, [{ id: memory.id, text: memory.text }])
})
