/**
 * Read-only context-continuity characterization probes.
 *
 * Run: node docs/evidence/2026-11-17-context-management-gap-audit.continuity-probes.mjs
 * These assertions pin currently observed limitations, not desired behavior.
 * Production functions are transpiled from the live tree into isolated VMs;
 * only retrieval/filesystem boundaries are synthetic. No model/network calls,
 * real database writes, or user files are accessed by the probed functions.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const ts = createRequire(path.join(root, "package.json"))("typescript")

function loadProduction(relativePath, globals = {}, names) {
  const filePath = path.join(root, relativePath)
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const selected = source.statements.filter((node) => {
    if (ts.isImportDeclaration(node)) return false
    if (!names) return true
    if (ts.isFunctionDeclaration(node)) return names.includes(node.name?.text)
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations.some((item) => names.includes(item.name.getText()))
    return false
  })
  const text = selected.map((node) => node.getText(source)).join("\n")
  const compiled = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandbox = { exports: {}, ...globals }
  vm.runInNewContext(compiled, sandbox, { filename: relativePath, timeout: 2_000 })
  return sandbox.exports
}

function report(id, detail) {
  console.log(JSON.stringify({ id, result: "observed", ...detail }))
}

const types = loadProduction("lib/agents/instructions/types.ts")
const paths = loadProduction("lib/agents/instructions/paths.ts")
const { renderInstructions } = loadProduction("lib/agents/instructions/render.ts")
const { discoverInstructionPaths } = loadProduction("lib/agents/instructions/discover.ts", {
  ...paths,
  ...types,
})
const config = types.resolveInstructionsConfig({ maxFiles: 2 })
const contents = new Map([
  ["/home/.cognia/AGENTS.md", "Use npm."],
  ["/proj/AGENTS.md", "General repository instructions."],
  ["/proj/sub/AGENTS.md", "Use pnpm in sub/."],
])
const fakeFs = {
  exists: async (value) => contents.has(value),
  readDir: async () => [],
  readText: async (value) => contents.get(value) ?? "",
}
const discovered = await discoverInstructionPaths({
  cwd: "/proj/sub",
  roots: ["/proj"],
  globalPath: "/home/.cognia/AGENTS.md",
  config,
  fs: fakeFs,
})
const capped = renderInstructions(
  discovered.map((file) => ({ ...file, content: contents.get(file.absPath) })),
  config
)
assert.equal(discovered.length, 3)
assert.equal(capped.section.includes("Use npm."), true)
assert.equal(capped.section.includes("Use pnpm"), false)
report("C1-instruction-cap-drops-higher-precedence", {
  retained: capped.files.map((file) => file.absPath),
  warnings: capped.warnings,
})

const platform = loadProduction("lib/platform/detect.ts", { __COGNIA_HEADLESS__: true })
const { loadProjectInstructions } = loadProduction("lib/agents/instructions/load.ts", {
  ...types,
  ...platform,
})
const headless = await loadProjectInstructions({ cwd: "/proj", roots: ["/proj"] })
assert.equal(headless.section, "")
assert.equal(headless.warnings.length, 0)
report("C2-headless-instructions-empty-without-injected-fs", {
  section: headless.section,
  warnings: headless.warnings,
  scope: "Shared loader gate; native vendor instruction loading is not evaluated.",
})

const chunks = [
  {
    id: "chunk-a",
    fileId: "file-a",
    content: "Alpha evidence.",
    vectorDocId: "vector-a",
    generationId: "generation-a",
    charStart: 100,
    charEnd: 115,
    contentHash: "hash-a",
  },
  {
    id: "chunk-b",
    fileId: "file-a",
    content: "Beta evidence.",
    vectorDocId: "vector-b",
    generationId: "generation-a",
    charStart: 500,
    charEnd: 514,
    contentHash: "hash-a",
  },
  {
    id: "chunk-c",
    fileId: "file-b",
    content: "Gamma evidence from another same-named file.",
    vectorDocId: "vector-c",
    generationId: "generation-b",
    charStart: 0,
    charEnd: 45,
    contentHash: "hash-b",
  },
]
const { applyProjectKnowledgeContext } = loadProduction(
  "lib/project-knowledge/runtime/apply-project-context.ts",
  {
    retrieveProjectChunks: async () => ({
      chunks: chunks.map((chunk) => ({ chunk, score: 1 })),
      degraded: false,
    }),
  }
)
const applied = await applyProjectKnowledgeContext({
  projectId: "project-a",
  userMessage: "What does the evidence say?",
  topK: 3,
  fileNames: { "file-a": "guide.md", "file-b": "guide.md" },
})
assert.equal(applied.retrievedChunks.length, 3)
assert.equal(applied.systemPromptSection.includes("Gamma evidence"), true)
for (const chunk of applied.retrievedChunks) {
  for (const field of ["id", "vectorDocId", "generationId", "charStart", "charEnd", "contentHash"])
    assert.equal(Object.hasOwn(chunk, field), false)
}
const { mergeSources } = loadProduction("lib/chat/citations.ts")
const { mergeProjectKnowledgeSourcesIntoLastAssistant } = loadProduction(
  "lib/chat/sdk-message-adapter.ts",
  { mergeSources },
  ["appendSourcesToLastAssistant", "mergeProjectKnowledgeSourcesIntoLastAssistant"]
)
const merged = mergeProjectKnowledgeSourcesIntoLastAssistant(
  [{ id: "assistant-a", role: "assistant", parts: [{ type: "text", text: "Answer." }] }],
  applied
)
const sources = merged[0].parts.find((part) => part.type === "sources").sources
assert.equal(sources.length, 1)
assert.equal(sources[0].snippet, "Alpha evidence.")
report("C3-project-citations-lose-locators-and-collapse", {
  injectedChunks: applied.retrievedChunks.length,
  persistedSources: sources.length,
  retainedSnippet: sources[0].snippet,
  droppedLocators: ["id", "vectorDocId", "generationId", "charStart", "charEnd", "contentHash"],
})

console.log("3 continuity characterization probes observed the current limitations.")
