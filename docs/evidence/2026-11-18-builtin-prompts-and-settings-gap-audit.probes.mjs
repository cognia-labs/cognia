/**
 * Read-only diagnostic probes for the 2026-11-18 prompt/settings audit.
 * Run: node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.probes.mjs
 *
 * The actual TypeScript modules are transpiled in memory. Persistence, logging,
 * catalog discovery, and validation boundaries are mocked explicitly below.
 * No app data, files, network calls, or real accounts are mutated. Assertions
 * describe the observed defects, not the behavior a fixed version should have.
 * The account-switch probe does NOT exercise the real account lifecycle and
 * establishes a public-resolver race risk, not production cross-account use.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(path.join(root, "package.json"))
const ts = require("typescript")

function loadModule(relativePath, dependencies) {
  const filename = path.join(root, relativePath)
  const module = { exports: {} }
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  })
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      require: (id) => (Object.hasOwn(dependencies, id) ? dependencies[id] : require(id)),
      Date,
      Map,
      Set,
    },
    { filename }
  )
  return module.exports
}

const def = {
  id: "audit.prompt",
  operation: "replace-template",
  scopes: ["account"],
  contractVersion: 1,
  defaultBody: "Shipped default",
  variables: [],
  requiredFragments: [],
  maxChars: 2000,
}

async function replacementImportOverwritesConcurrentEdit() {
  let slot = {
    binding: { rev: 1 },
    active: { kind: "published", body: "Reviewed original" },
  }
  const profile = loadModule("lib/prompts/profile.ts", {
    "@/lib/db/prompt-overrides": {},
    "./catalog": {
      loadPromptCatalog: async () => {},
      getPromptDefinition: () => def,
    },
    "./service": {
      shippedBodyDigest: async () => "digest",
      readPromptSlot: async () => structuredClone(slot),
      publishPromptBody: async ({ body, expectedRev }) => {
        assert.equal(slot.binding.rev, expectedRev)
        slot = {
          binding: { rev: expectedRev + 1 },
          active: { kind: "published", body },
        }
      },
    },
    "./template": { validatePromptBody: () => [] },
  })
  const preview = await profile.previewPromptProfileImport({
    entries: [
      {
        promptId: def.id,
        scope: "account",
        targetId: "",
        contractVersion: 1,
        baseDigest: "digest",
        body: "Imported replacement",
      },
    ],
  })
  assert.equal(preview[0].status, "replace")
  slot = {
    binding: { rev: 2 },
    active: { kind: "published", body: "Concurrent author edit" },
  }
  const result = await profile.applyPromptProfileImport(preview, new Set([0]))
  assert.equal(result.applied, 1)
  assert.equal(result.conflicted.length, 0)
  assert.equal(slot.active.body, "Imported replacement")
  console.log(
    JSON.stringify({
      probe: "replacement-import-concurrency",
      preview: preview[0].status,
      result,
      final: slot,
      boundary: "actual profile module; mocked storage/service",
    })
  )
}

async function asyncResolverReusesAnotherAccountsInflightLoad() {
  let database = "account-A"
  let release
  let revisionReadStarted
  const revisionRead = new Promise((resolve) => {
    revisionReadStarted = resolve
  })
  const revisions = new Promise((resolve) => {
    release = resolve
  })
  const snapshot = loadModule("lib/prompts/snapshot.ts", {
    "@/lib/db/schema": { getDb: () => ({ name: database }) },
    "@/lib/db/prompt-overrides": {
      listPromptOverrideBindings: async () => [
        {
          id: "binding-A",
          promptId: def.id,
          scope: "account",
          targetId: "",
          activeRevisionId: "revision-A",
        },
      ],
      getPromptOverrideRevisions: () => {
        revisionReadStarted()
        return revisions
      },
      onPromptOverridesChanged: () => () => {},
    },
  })
  const resolver = loadModule("lib/prompts/resolve.ts", {
    "@cognia/logging": { loggers: { ai: { child: () => ({ warn() {} }) } } },
    "./template": {
      validatePromptBody: () => [],
      renderPromptTemplate: (_definition, body) => body,
    },
    "./snapshot": snapshot,
    "./resolution-log": { recordPromptResolution() {} },
    "./types": { PROMPT_SCOPE_SPECIFICITY: ["account", "workspace", "agent", "session"] },
  })
  const first = snapshot.loadPromptOverrideSnapshot()
  await revisionRead
  database = "account-B"
  const resolveOnB = resolver.resolvePromptAsync(def)
  release([
    {
      id: "revision-A",
      kind: "published",
      body: "Account A override",
      contractVersion: 1,
    },
  ])
  const resolved = await resolveOnB
  assert.equal(resolved.text, "Account A override")
  assert.equal(resolved.source.kind, "override")
  assert.equal(snapshot.peekPromptOverrideSnapshot(), null)
  await first
  console.log(
    JSON.stringify({
      probe: "public-async-resolver-inflight-account-switch",
      activeDatabase: database,
      resolvedText: resolved.text,
      resolvedSource: resolved.source,
      guardedPeek: snapshot.peekPromptOverrideSnapshot(),
      boundary: "actual snapshot and async resolver; mocked DB switch, no real lifecycle",
    })
  )
}

await replacementImportOverwritesConcurrentEdit()
await asyncResolverReusesAnotherAccountsInflightLoad()
