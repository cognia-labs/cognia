// Characterization probe of the PRE-FIX memory code (audit snapshot b2aa1ccee1).
// It asserts the defective behaviour and now fails by design; the fixes and their
// desired-behaviour tests are listed in the ledger's Repair record.
// Characterization probes: passing confirms the named current defect.
// Run: node --test docs/evidence/2026-11-08-memory-support-audit.retrieval-probes.mjs
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import "fake-indexeddb/auto"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
const cache = path.join(root, ".cache/memory-support-audit")
await mkdir(cache, { recursive: true })
const scratch = await mkdtemp(path.join(cache, "retrieval-"))
const require = createRequire(import.meta.url)
const outfile = path.join(scratch, "source.cjs")
// Only the DB resource is replaced: a private fake IndexedDB, using real Dexie
// index/query/transaction behavior. Candidate selection and retrieval are real.
const seams = new Map([
  [
    "@/lib/db/schema",
    `
    import Dexie from 'dexie';
    export const db = new Dexie('memory-support-audit-'+process.pid);
    db.version(1).stores({memories:'id,status,scope,characterId,projectId,agentId,[scope+status],[projectId+status],[agentId+status]'});
    export const getDb=()=>db;
  `,
  ],
  ["./tombstones", "export const recordTombstones=async()=>{}"],
  ["@/lib/memory/memory-event-bus", "export const emitMemoryWritten=()=>{}"],
  ["@/lib/tauri", "export const isTauri=()=>true"],
  [
    "@/lib/file/file-operations",
    "export const readTextFile=async()=>'', writeTextFile=async()=>{}, copyFile=async()=>{}, exists=async()=>false",
  ],
])
await build({
  stdin: {
    contents: `
      export { db } from '@/lib/db/schema';
      export { invalidateMemory, listActiveForReader, listHistoricalForReader, restoreArchivedMemory } from './lib/db/memories.ts';
      export { retrieveMemories, isMemoryEligibleForRetrieval } from './packages/memory/src/retrieve/retriever.ts';
      export { applyMemoryContext } from './packages/memory/src/runtime/apply-memory-context.ts';
      export { buildExpandedKeywordQuery } from './packages/rag/src/keyword-expansion.ts';
      export { cosineSimilarity } from './packages/provider-embedding/src/embedding-utils.ts';
      export { discoverOpencode } from './lib/memory/external/providers/opencode.ts';
      export { discoverPi } from './lib/memory/external/providers/pi.ts';
      export { saveExternalFile } from './lib/memory/external/edit.ts';
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  outfile,
  logLevel: "silent",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [
    {
      name: "isolated-memory-database",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          const key =
            args.path === "./schema" && args.importer.endsWith("/lib/db/memories.ts")
              ? "@/lib/db/schema"
              : args.path
          if (seams.has(key)) return { path: key, namespace: "audit" }
        })
        builder.onLoad({ filter: /.*/, namespace: "audit" }, (args) => ({
          contents: seams.get(args.path),
          resolveDir: root,
        }))
      },
    },
  ],
})
const src = require(outfile)
after(async () => {
  await src.db.delete()
  await rm(scratch, { recursive: true, force: true })
})

const memory = (id, extra = {}) => ({
  id,
  text: "Use pnpm",
  type: "semantic",
  scope: "global",
  status: "active",
  tags: [],
  pinned: false,
  provenance: "user",
  importance: 7,
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastAccessedAt: Date.now(),
  accessCount: 0,
  ...extra,
})
const recall = (queryText, loadCandidates, extra = {}) =>
  src.retrieveMemories(
    {
      queryText,
      topK: 8,
      relevanceFloor: 0.35,
      ...extra,
    },
    { loadCandidates }
  )

test("R1: expansion-only keyword hits are discarded by the original-query gate", async () => {
  const row = memory("synonym", { text: "Remove document" })
  assert.equal(src.buildExpandedKeywordQuery("delete file"), "delete file remove document")
  const direct = await recall("remove document", async () => [row])
  assert.equal(direct.length, 1)
  const expanded = await recall("delete file", async () => [row], { enableQueryExpansion: true })
  assert.equal(expanded.length, 0)
})

test("R2: expired or quarantined scoped overrides hide eligible global fallback", async () => {
  for (const excluded of [{ expiresAt: Date.now() - 1 }, { trustState: "quarantined" }]) {
    await src.db.memories.clear()
    await src.db.memories.bulkAdd([
      memory("global", { key: "package-manager" }),
      memory("workspace", {
        key: "package-manager",
        scope: "workspace",
        projectId: "p1",
        ...excluded,
      }),
    ])
    const reader = { projectId: "p1" }
    const selected = await src.listActiveForReader(reader)
    assert.deepEqual(
      selected.map((row) => row.id),
      ["workspace"]
    )
    assert.equal(src.isMemoryEligibleForRetrieval(selected[0]), false)
    const hits = await recall("pnpm", src.listActiveForReader, { reader })
    assert.equal(hits.length, 0)
    // Same query and corpus, with the ineligible override removed: fallback works.
    await src.db.memories.delete("workspace")
    const fallback = await recall("pnpm", src.listActiveForReader, { reader })
    assert.deepEqual(
      fallback.map((hit) => hit.memory.id),
      ["global"]
    )
  }
})

test("R3: editable OpenCode and Pi global files are outside the console save roots", async () => {
  const home = "/home/audit"
  const ctx = {
    home,
    roots: ["/workspace"],
    platform: "linux",
    fs: {
      exists: async () => false,
      readDir: async () => [],
      stat: async () => ({ size: 0, isFile: true }),
    },
  }
  const files = [...(await src.discoverOpencode(ctx)), ...(await src.discoverPi(ctx))]
  assert.equal(files.length, 3)
  assert(files.every((file) => file.editable))
  // Production hook's allowedRoots is precisely workspace roots + these two
  // home directories (use-external-memory.ts:123-129); it omits OpenCode/Pi.
  const allowedRoots = [...ctx.roots, `${home}/.claude`, `${home}/.codex`]
  for (const file of files) {
    await assert.rejects(
      src.saveExternalFile(file.absPath, "synthetic fixture", {
        allowedRoots,
        isDesktop: true,
      }),
      /Refusing to write outside the allowed roots/
    )
  }
})

test("R4: historical recall rewrites an archived interval after restore", async (t) => {
  let clock = 100
  t.mock.method(Date, "now", () => clock)
  await src.db.memories.clear()
  const row = memory("archived", { createdAt: 10 })
  await src.db.memories.add(row)
  await src.invalidateMemory(row.id)
  const { invalidatedAt } = await src.db.memories.get(row.id)
  assert.ok(invalidatedAt > row.createdAt)
  const historicalRecall = (asOf) =>
    src.retrieveMemories(
      { queryText: "pnpm", topK: 8, relevanceFloor: 0.35, asOf },
      {
        loadCandidates: src.listActiveForReader,
        loadHistoricalCandidates: src.listHistoricalForReader,
      }
    )
  assert.equal((await historicalRecall(invalidatedAt - 1)).length, 1)
  assert.equal((await historicalRecall(invalidatedAt)).length, 0)
  clock = 200
  assert.equal((await src.restoreArchivedMemory(row.id)).ok, true)
  const rewritten = await historicalRecall(invalidatedAt)
  assert.deepEqual(
    rewritten.map((hit) => hit.memory.id),
    [row.id]
  )
})

test("R5: a negative-similarity vector becomes an injected relevance-1 memory", async () => {
  const row = memory("off-topic", { vectorDocId: "off-topic-vector" })
  const queryVector = [1, 0]
  const memoryVector = [-1, 0]
  const similarity = src.cosineSimilarity(queryVector, memoryVector)
  assert.equal(similarity, -1)
  const deps = {
    loadCandidates: async () => [row],
    loadProcedural: async () => [],
  }
  const input = { userMessage: "volcano", topK: 8, relevanceFloor: 0.99 }
  assert.equal((await src.applyMemoryContext({ ...input, deps })).systemPromptSection, null)
  const withVector = await src.applyMemoryContext({
    ...input,
    precomputedQueryEmbedding: queryVector,
    deps: {
      ...deps,
      vectorSearch: async () => [{ id: row.vectorDocId, score: similarity }],
    },
  })
  assert.equal(withVector.retrievedMemories[0].relevance, 1)
  assert.match(withVector.systemPromptSection, /Use pnpm/)
})
