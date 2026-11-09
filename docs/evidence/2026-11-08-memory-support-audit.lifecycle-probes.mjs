// Characterization probe of the PRE-FIX memory code (audit snapshot b2aa1ccee1).
// It asserts the defective behaviour and now fails by design; the fixes and their
// desired-behaviour tests are listed in the ledger's Repair record.
// Characterization probes: a passing assertion confirms an audit finding.
// These are evidence artifacts, not regression tests approving the defects.
// Run: node --test docs/evidence/2026-11-08-memory-support-audit.lifecycle-probes.mjs
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
const cache = path.join(root, ".cache/memory-support-audit")
await mkdir(cache, { recursive: true })
const scratch = await mkdtemp(path.join(cache, "lifecycle-probe-"))
const evidence = []
after(async () => {
  delete globalThis.__memoryLifecycleAudit
  await writeFile(path.join(cache, "lifecycle-probes.json"), JSON.stringify(evidence, null, 2))
  await rm(scratch, { recursive: true, force: true })
})

// Persistence, provider/backend construction, prompt storage, and Host
// identity lookup are substituted. The extractor, orchestration, dispatch and
// outcome classification, transcript checks, memory policies, redaction,
// retention, compaction, and lifecycle sweep execute their checked-out sources.
// Unexercised job handlers fail loudly rather than loading a real host backend.
const seams = new Map([
  [
    "@/lib/db/settings",
    "export const getSettings=async()=>globalThis.__memoryLifecycleAudit.settings",
  ],
  [
    "@/lib/db/sessions",
    "export const getSession=async()=>globalThis.__memoryLifecycleAudit.session",
  ],
  ["@/lib/db/characters", "export const resolveCharacterById=async()=>undefined"],
  [
    "@/lib/execution/personal-visibility",
    `import {withholdForReaders} from '@cognia/plugin-contract/types/execution/personal-visibility';
     export const preparePersonalHistory=async(_sessionId,messages,{session}={})=>
       ({...withholdForReaders(messages,[],session),readers:[]});`,
  ],
  [
    "@/lib/db/messages",
    "export const listMessages=async()=>globalThis.__memoryLifecycleAudit.messages",
  ],
  [
    "@/lib/db/memories",
    `const state=()=>globalThis.__memoryLifecycleAudit;
     export const listMemories=async()=>state().rows;
     export const listProjectClaimsNeedingRecheck=async()=>[];
     export const getMemory=async id=>state().rows.find(row=>row.id===id);
     export const updateMemory=async(id,patch)=>{
       state().writes.push({id,patch});
       const row=state().rows.find(row=>row.id===id);
       if(row)Object.assign(row,patch);
     };
     export const invalidateMemory=async()=>{throw Error('Unexpected invalidation')};
     export const createMemory=async()=>{throw Error('Unexpected memory creation')};`,
  ],
  [
    "@/lib/db/memory-governance",
    `const unexpected=async()=>{throw Error('Unexpected governance mutation')};
     export const MEMORY_JOB_LEASE_TTL_MS=600000;
     export const appendMemoryAuditEvent=async event=>{
       globalThis.__memoryLifecycleAudit.audits.push(event);return event;
     };
     export const claimNextMemoryJob=unexpected,finishMemoryJob=unexpected,
       failMemoryJob=unexpected,createMemoryEvidence=unexpected,
       bindMemoryGovernanceOutcome=unexpected,heartbeatMemoryJob=unexpected,
       enqueueMemoryJob=unexpected;
     export const listMemoryEvidence=async()=>[];`,
  ],
  [
    "@/lib/memory/runtime/build-deps",
    `export const tryBuildMemoryDeps=async()=>({
       loadCandidates:async()=>[],loadProcedural:async()=>[]
     });
     export const tryBuildMemoryVectorSink=async()=>globalThis.__memoryLifecycleAudit.sink;
     export const tryBuildMemoryVectorReader=async()=>undefined;
     export const withPersonalMemoryVisibility=deps=>deps;
     export const filterPersonalMemories=async rows=>rows.filter(row=>
       globalThis.__memoryLifecycleAudit.messages.some(source=>
         source.id===row.sourceMessageId && source.sessionId===row.sourceSessionId));`,
  ],
  ["@/lib/memory/retrieve/retriever", "export const retrieveMemories=async()=>[]"],
  [
    "@/lib/ai/generation/utility-client",
    "export const buildUtilityLlmClient=()=>globalThis.__memoryLifecycleAudit.client",
  ],
  [
    "@/lib/prompts/resolve",
    "export const resolvePromptAsync=async definition=>({text:definition.defaultBody})",
  ],
  [
    "@/lib/project-knowledge/ingest/ingest-file",
    "export const hashContent=()=>{throw Error('Unexpected project evidence hashing')}",
  ],
  [
    "@/lib/memory/lifecycle/build-maintenance-deps",
    "export const buildEpisodicMaintenanceDeps=async()=>{throw Error('Unexpected distillation handler')}",
  ],
  [
    "@/lib/memory/lifecycle/maintenance",
    "export const runMemoryMaintenance=async()=>{throw Error('Unexpected distillation handler')}",
  ],
  ["@/lib/db/schema", "export const getDb=()=>{throw Error('Unexpected host database')}"],
  [
    "@/lib/workspace/roots",
    "export const allRootPaths=()=>{throw Error('Unexpected workspace access')}",
  ],
  [
    "@/lib/memory/write/run-project-mining",
    "export const buildProjectMiningDeps=async()=>{throw Error('Unexpected project mining')};export const runProjectMining=buildProjectMiningDeps",
  ],
  [
    "@/lib/db/project-mining-runs",
    "export const recordProjectMiningRunClaims=async()=>{throw Error('Unexpected backfill write')}",
  ],
  [
    "@/lib/memory/lifecycle/revalidate-claim",
    "export const buildClaimRevalidationDeps=async()=>{throw Error('Unexpected claim revalidation')};export const revalidateClaim=buildClaimRevalidationDeps",
  ],
  [
    "@/lib/memory/backfill/repair-workspace-scope",
    "export const repairWorkspaceScopedMemories=async()=>{throw Error('Unexpected namespace repair')}",
  ],
])
const outfile = path.join(scratch, "source.mjs")
await build({
  stdin: {
    contents: `export {extractMemories} from './packages/memory/src/extract/extractor.ts';
      export {processMemoryJob} from './lib/memory/lifecycle/job-worker.ts';
      export {DEFAULT_MEMORY_CONFIG} from './packages/memory/src/types/memory.ts';`,
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
      name: "memory-lifecycle-audit-resource-seams",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          seams.has(args.path) ? { path: args.path, namespace: "audit-seam" } : undefined
        )
        builder.onLoad({ filter: /.*/, namespace: "audit-seam" }, (args) => ({
          contents: seams.get(args.path),
          resolveDir: root,
        }))
      },
    },
  ],
})
const src = await import(pathToFileURL(outfile).href)
const DAY = 86_400_000
const settings = (over = {}) => ({ memory: { ...src.DEFAULT_MEMORY_CONFIG, ...over } })
const fixture = (over = {}) =>
  (globalThis.__memoryLifecycleAudit = {
    settings: settings(),
    session: { id: "audit-session", transcriptRevision: 1 },
    messages: [
      {
        id: "u1",
        sessionId: "audit-session",
        role: "user",
        parts: [{ type: "text", text: "I always use pnpm for all my projects." }],
      },
      {
        id: "a1",
        sessionId: "audit-session",
        role: "assistant",
        parts: [{ type: "text", text: "I will remember your package manager preference." }],
      },
    ],
    rows: [],
    writes: [],
    audits: [],
    sink: undefined,
    client: { complete: async () => '{"memories":[]}' },
    ...over,
  })
const job = (kind) => ({
  id: `audit-${kind}`,
  kind,
  status: "running",
  scope: "global",
  provenance: "user",
  evidenceIds: [],
  retryCount: 0,
  attempt: 1,
  maxAttempts: 4,
  queuedAt: Date.now(),
  sessionId: "audit-session",
  dedupeKey: `${kind}:audit-session:2`,
})

test("L1: provider outage becomes the same terminal no-output result as an empty extraction", async () => {
  let calls = 0
  const state = fixture({
    client: {
      complete: async () => {
        calls++
        throw Error("fixture 503")
      },
    },
  })
  const errorResult = await src.processMemoryJob(job("turn-extraction"))
  assert.equal(calls, 1, "Real extractor reached the injected provider seam")
  assert.deepEqual(errorResult, { status: "no_output", resultCode: "nothing_durable" })
  assert.equal(state.writes.length, 0)
  state.client = { complete: async () => '{"memories":[]}' }
  const emptyResult = await src.processMemoryJob(job("turn-extraction"))
  assert.deepEqual(emptyResult, errorResult)
  const direct = await src.extractMemories(
    {
      newPair: { userText: "I always use pnpm", assistantText: "OK" },
      allowTypes: ["semantic"],
    },
    {
      complete: async () => {
        throw Error("fixture 503")
      },
    }
  )
  assert.deepEqual(direct, [])
  evidence.push({
    id: "L1",
    providerCalls: calls,
    errorResult,
    emptyResult,
    directExtractorResult: direct,
  })
})

test("L2: reconciliation declares an existing stale vector consistent; missing-document control heals", async () => {
  const backend = new Map([["m1", "OLD preference"]])
  const upserts = []
  const state = fixture({
    rows: [
      {
        id: "m1",
        status: "active",
        text: "NEW preference",
        vectorDocId: "m1",
        sourceSessionId: "audit-session",
        sourceMessageId: "a1",
      },
    ],
    sink: {
      listIds: async () => [...backend.keys()],
      upsert: async (id, text) => {
        upserts.push({ id, text })
        backend.set(id, text)
      },
      delete: async (ids) => ids.forEach((id) => backend.delete(id)),
    },
  })
  const staleResult = await src.processMemoryJob(job("vector-reconcile"))
  assert.deepEqual(staleResult, { status: "no_output", resultCode: "already_consistent" })
  assert.equal(upserts.length, 0)
  assert.equal(backend.get("m1"), "OLD preference")
  backend.delete("m1")
  const missingControl = await src.processMemoryJob(job("vector-reconcile"))
  assert.deepEqual(missingControl, { status: "succeeded", resultCode: "vectors_reconciled" })
  assert.deepEqual(upserts, [{ id: "m1", text: state.rows[0].text }])
  evidence.push({ id: "L2", staleResult, staleUpserts: 0, missingControl, controlUpserts: upserts })
})

test("L3: a queued lifecycle sweep still compacts memory in temporary mode", async () => {
  const original =
    "Decided to use a local package cache.\n\n" + "Additional historical discussion. ".repeat(80)
  const state = fixture({
    settings: settings({ temporary: true, compactColdEpisodic: true, dedupColdClusters: false }),
    rows: [
      {
        id: "cold-episode",
        text: original,
        type: "episodic",
        scope: "global",
        status: "active",
        pinned: false,
        createdAt: Date.now() - 400 * DAY,
        lastAccessedAt: Date.now() - 400 * DAY,
        accessCount: 0,
      },
    ],
  })
  const result = await src.processMemoryJob(job("memory-lifecycle-sweep"))
  assert.deepEqual(result, { status: "succeeded", resultCode: "lifecycle_swept" })
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].patch.revisionReason, "compaction")
  assert.ok(state.rows[0].text.length < original.length)
  const tempWrites = state.writes.length
  state.writes.length = 0
  state.settings = settings({ enabled: false, compactColdEpisodic: true })
  const disabledControl = await src.processMemoryJob(job("memory-lifecycle-sweep"))
  assert.deepEqual(disabledControl, { status: "skipped", resultCode: "memory_disabled" })
  assert.equal(state.writes.length, 0)
  evidence.push({ id: "L3", temporary: true, result, temporaryWrites: tempWrites, disabledControl })
})
