// Local preview parity probe for mode template substitution and instruction working directory.
// Executes the production preview hook and runtime helpers through TypeScript in VM contexts.
// React, stores, and filesystem dependencies are stubbed; no real UI or provider is invoked.
// Run from the repository root: node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.preview-probes.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")
const repositoryRoot = path.resolve(__dirname, "../..")
const ts = require(require.resolve("typescript", { paths: [repositoryRoot] }))
function load(file, deps) {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(path.join(repositoryRoot, file), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  )
  const module = { exports: {} }
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      require(n) {
        if (n in deps) return deps[n]
        throw new Error(n)
      },
      console,
      Date,
      Map,
      Set,
      Intl,
    },
    { filename: file }
  )
  return module.exports
}
const base = load("lib/prompts/base-selection.ts", {})
const preview = load("lib/prompts/effective-preview.ts", {
  "@/lib/ai/tokens/fallback-estimator": {
    estimateFallbackTokens: (text) => Math.ceil(text.length / 4),
  },
  "@/lib/workspace/workspace-instructions": { buildWorkspaceInstructionsSection: () => "" },
  "./base-selection": base,
})
const helpers = load("stores/agent/custom-mode-store/helpers.ts", {
  nanoid: { nanoid: () => "unused" },
  "@/lib/ai/tools/task-aware-selection": {},
})
const cwd = load("lib/workspace/effective-cwd.ts", {
  "@/lib/workspace/roots": { primaryRootOf: () => undefined },
})
let state, instructionInput
const pending = []
const selectedMode = {
  id: "custom",
  name: "Research",
  description: "Research tasks",
  tools: ["web_search"],
  systemPrompt: "Mode={{mode_name}}; tools={{tools_list}}",
}
const character = {
  id: "agent",
  name: "Agent",
  systemPrompt: "Base.",
  workingDir: "/agent/project",
}
const settings = { defaultWorkingDir: "/default/project" }
const hook = load("hooks/prompts/use-effective-chat-preview.ts", {
  react: {
    useCallback: (f) => f,
    useEffect: (f) => pending.push(f),
    useState: (init) => [init, (value) => (state = value)],
  },
  "@/lib/agent/modes/built-ins": {
    BUILT_IN_AGENT_MODES: [],
    BUILT_IN_MODE_PROMPTS: new Map(),
    MODE_PROMPT_PASSTHROUGH_VALUES: {},
  },
  "@/lib/db/characters": { resolveCharacterById: async () => character },
  "@/lib/db/skills": { listEnabledSkillsByIds: async () => [] },
  "@/lib/harness/render": { renderHarnessSections: () => "" },
  "@/lib/prompts/effective-preview": preview,
  "@/lib/agent/resolve-agent-mode": { resolveActiveAgentMode: () => selectedMode },
  "@/lib/prompts/resolve": {},
  "@/lib/tauri": { isTauri: () => true },
  "@/lib/workspace/roots": { allRootPaths: () => [] },
  "@/stores/agent/custom-mode-store": {
    useCustomModeStore: (f) => f({ customModes: { custom: selectedMode } }),
  },
  "@/stores/plugin-runtime/plugin-store": { usePluginStore: (f) => f({ plugins: {} }) },
  "@/stores/project/project-store": { useProjectStore: (f) => f({ projects: [] }) },
  "@/stores/settings": { useSettingsStore: (f) => f({ settings }) },
  "@/lib/agents/instructions/load": {
    loadProjectInstructions: async (input) => {
      instructionInput = input
      return { section: "" }
    },
  },
})
;(async () => {
  hook.useEffectiveChatPreview({ agentId: "agent", modeId: "custom", workspaceId: null })
  pending.forEach((f) => f())
  await new Promise((r) => setImmediate(r))
  assert.equal(state.status, "ready")
  const previewMode = state.preview.segments.find((s) => s.kind === "mode").text
  const runtimeMode = helpers.processPromptTemplateVariables(selectedMode.systemPrompt, {
    modeName: selectedMode.name,
    modeDescription: selectedMode.description,
    tools: selectedMode.tools,
  })
  const runtimeCwd = cwd.resolveEffectiveCwd({
    characterWorkingDir: character.workingDir,
    defaultWorkingDir: settings.defaultWorkingDir,
  })
  assert.notEqual(previewMode, runtimeMode)
  assert.equal(instructionInput.cwd, undefined)
  assert.equal(runtimeCwd, "/agent/project")
  console.log(
    JSON.stringify(
      {
        scenario: "new chat selected custom mode + agent workingDir, no workspace",
        previewMode,
        runtimeMode,
        previewInstructionCwd: instructionInput.cwd ?? null,
        runtimeInstructionCwd: runtimeCwd,
        evidenceScope:
          "actual hook and pure runtime helpers, mocked React stores and filesystem; no UI or provider run",
      },
      null,
      2
    )
  )
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
