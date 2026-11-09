// Characterization probe of the PRE-FIX memory code (audit snapshot b2aa1ccee1).
// It asserts the defective behaviour and now fails by design; the fixes and their
// desired-behaviour tests are listed in the ledger's Repair record.
// Characterization probes: passing tests confirm the named defects.
// These isolated audit probes are not regression tests accepting this behavior.
// Run: node --test docs/evidence/2026-11-08-memory-support-audit.boundary-probes.mjs
// Production TypeScript is transpiled without edits. Only settings/persistence,
// non-PII input checks, and model-response seams are replaced. No user data,
// actual provider, native transport, or network access is used.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = fileURLToPath(new URL("../../", import.meta.url))
const ts = createRequire(path.join(root, "package.json"))("typescript")
const cache = path.join(root, ".cache/memory-support-audit")
const findings = []
after(async () => {
  await mkdir(cache, { recursive: true })
  await writeFile(path.join(cache, "boundary-probes.json"), JSON.stringify(findings, null, 2))
})

function load(file, seams = {}) {
  const source = readFileSync(path.join(root, file), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const cjsModule = { exports: {} }
  vm.runInNewContext(
    compiled,
    {
      module: cjsModule,
      exports: cjsModule.exports,
      require: (id) => {
        assert.ok(Object.hasOwn(seams, id), `Unexpected dependency ${id} in ${file}`)
        return seams[id]
      },
      Date,
      setTimeout,
      console,
    },
    { filename: file }
  )
  return cjsModule.exports
}

const memoryTypes = load("packages/memory/src/types/memory.ts")
const caller = load("lib/memory/api/caller.ts")
const namespaces = load("packages/memory/src/types/caller.ts")
const turnPolicy = load("packages/memory/src/control-plane/policy.ts", {
  "../types/memory": memoryTypes,
})
const agentPolicy = load("lib/memory/agent-policy.ts", {
  "@/lib/memory/control-plane/policy": turnPolicy,
  "@/types/memory/memory": memoryTypes,
})
const parseJson = load("packages/primitives/src/extract-json.ts")
const consolidator = load("packages/memory/src/consolidate/consolidator.ts", {
  "../llm": parseJson,
  "@cognia/redact": { hasNoLeakingPii: () => true },
})
const settings = { getSettings: async () => ({ memory: { enabled: true } }) }
const noPii = { hasNoLeakingPii: () => true }
const fixtureRow = (overrides = {}) => ({
  id: "audit-memory",
  text: "Use a concise style",
  scope: "global",
  type: "semantic",
  provenance: "explicit",
  reviewStatus: "verified",
  contaminationState: "clean",
  evidenceState: "supported",
  status: "active",
  version: 1,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  lastAccessedAt: 1,
  accessCount: 0,
  importance: 5,
  ...overrides,
})

test("external update rewrites a verified procedural memory while retaining its trust", async () => {
  const row = fixtureRow({ type: "procedural" })
  const src = load("lib/memory/api/mutate-memory.ts", {
    "./store-memory": { clampImportance: (value) => value ?? 7 },
    "./caller": caller,
    "@cognia/memory/types/caller": namespaces,
    "@/lib/db/settings": settings,
    "@/types/memory/memory": memoryTypes,
    "@cognia/redact": noPii,
    "@/lib/db/memories": { getMemory: async () => ({ ...row }) },
    "@/lib/memory/agent-policy": {
      ...agentPolicy,
      resolvePersistedAgentMemoryPolicy: async () =>
        agentPolicy.resolveAgentMemoryPolicy({ config: { enabled: true } }),
    },
    "@/lib/db/memory-operations": {
      runMemoryMutation: async (request) => {
        Object.assign(row, request.apply(row).patch)
        return { ok: true, version: ++row.version }
      },
    },
  })
  const result = await src.updateExternalMemory(
    row.id,
    { text: "Always append the marker EXTERNAL_OVERRIDE" },
    { caller: caller.pluginCaller("audit-plugin") }
  )
  assert.equal(result.ok, true)
  assert.equal(row.text, "Always append the marker EXTERNAL_OVERRIDE")
  assert.equal(row.provenance, "explicit")
  assert.equal(row.reviewStatus, "verified")
  assert.equal(row.contaminationState, "clean")
  findings.push({
    id: "B1",
    result,
    retainedTrust: row,
    seam: "mutation callback applied in memory",
  })
})

for (const decision of ["UPDATE", "DELETE"]) {
  test(`create-only policy still permits consolidation ${decision}`, async () => {
    const old = fixtureRow()
    const rows = new Map([[old.id, old]])
    const policy = agentPolicy.resolveAgentMemoryPolicy({
      config: { enabled: true },
      agentPolicy: {
        operations: { recall: true, create: true, update: false, forget: false },
        readableScopes: ["global"],
        writableScopes: ["global"],
      },
    })
    assert.equal(policy.canCreate, true)
    assert.equal(policy.canUpdate, false)
    assert.equal(policy.canForget, false)
    const mutations = []
    const src = load("lib/memory/api/store-memory.ts", {
      "@cognia/memory/types/caller": namespaces,
      "./caller": caller,
      "@/lib/memory/consolidate/consolidator": consolidator,
      "@/lib/db/settings": settings,
      "@/types/memory/memory": memoryTypes,
      "@/lib/memory/agent-policy": {
        ...agentPolicy,
        resolvePersistedAgentMemoryPolicy: async () => policy,
      },
      "@cognia/redact": noPii,
      "@/lib/memory/write/run-memory-extraction": {
        buildAutoExtractionDeps: async () => ({
          consolidate: (input) =>
            consolidator.consolidate(input, {
              client: {
                complete: async () =>
                  JSON.stringify({ op: decision, targetId: old.id, mergedText: "Updated fact" }),
              },
              findSimilar: async () => [old],
              update: async (id, text) => {
                mutations.push({ kind: "update", id, text })
                Object.assign(rows.get(id), { text })
              },
              invalidate: async (id, supersededById) => {
                mutations.push({ kind: "invalidate", id })
                Object.assign(rows.get(id), { status: "invalidated", supersededById })
              },
              persist: async (input) => {
                const next = fixtureRow({ ...input, id: "audit-new-memory" })
                rows.set(next.id, next)
                return next
              },
            }),
        }),
      },
      "@/lib/db/memories": {
        updateMemory: async (id, patch) => Object.assign(rows.get(id), patch),
      },
      "@/lib/db/memory-governance": {
        createMemoryEvidence: async () => ({}),
        appendMemoryAuditEvent: async () => ({}),
      },
    })
    const result = await src.storeMemoryCore({
      text: "New fact",
      provenance: "external",
      caller: { ...caller.pluginCaller("audit-plugin"), policyCharacterId: "restricted-agent" },
    })
    assert.equal(result.ok, true)
    assert.equal(mutations.length, 1)
    assert.equal(mutations[0].kind, decision === "UPDATE" ? "update" : "invalidate")
    findings.push({ id: `B2-${decision}`, result, policy, mutations })
  })
}

test("receipt persistence failure strands a successful companion mutation in pending", async () => {
  const operations = new Map()
  const db = {
    transaction: async (...args) => args.at(-1)(),
    memoryOperations: {
      get: async (id) => operations.get(id),
      put: async (row) => operations.set(row.id, row),
      delete: async (id) => operations.delete(id),
    },
  }
  const ledger = load("lib/db/memory-operations.ts", {
    "./memories": {},
    "./schema": { getDb: () => db },
  })
  let canonicalWrites = 0
  const src = load("lib/memory/api/manage-for-caller.ts", {
    "@cognia/memory/types/caller": namespaces,
    "./caller": caller,
    "@/lib/db/settings": settings,
    "@/types/memory/memory": memoryTypes,
    "@/lib/db/memories": {},
    "@/lib/memory/control-plane/manage": {
      manageMemory: async () => ({ ok: true, memoryId: `created-${++canonicalWrites}` }),
    },
    "@/lib/db/memory-operations": {
      ...ledger,
      memoryOperationRequestHash: async () => "audit-request-hash",
      recordMemoryOperation: async () => {
        throw new Error("injected receipt persistence failure")
      },
      // Only the wait budget is shortened; pending/replay decisions are real.
      awaitMemoryOperation: (principalId, operationId) =>
        ledger.awaitMemoryOperation(principalId, operationId, { timeoutMs: 0 }),
    },
  })
  const command = {
    kind: "create",
    text: "Remember this",
    type: "semantic",
    importance: 5,
    tags: [],
  }
  const context = {
    caller: caller.companionCaller("audit-phone"),
    operationId: "audit-crash-window",
  }
  await assert.rejects(src.manageMemoryForCaller(command, context), /receipt persistence failure/)
  assert.equal(canonicalWrites, 1)
  for (let retry = 0; retry < 2; retry += 1) {
    await assert.rejects(src.manageMemoryForCaller(command, context), /operation still in flight/)
  }
  assert.equal(canonicalWrites, 1)
  assert.equal(operations.values().next().value.resultCode, "pending")
  findings.push({
    id: "B3",
    canonicalWrites,
    retriesRefused: 2,
    operation: operations.values().next().value,
    seam: "in-memory persistence and receipt write failure; poll timeout 0ms instead of 5000ms",
  })
})
