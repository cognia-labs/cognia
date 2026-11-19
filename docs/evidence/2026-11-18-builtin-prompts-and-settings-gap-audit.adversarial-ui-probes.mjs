#!/usr/bin/env node
/** Offline mounted-component and real-loader probes. No product files or user data are changed. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const out = resolve(root, ".cache/prompts-doubt/ui")
mkdirSync(out, { recursive: true })
function extend(source, name, extra, prefix = "") {
  const owner = dirname(source)
  const original = readFileSync(resolve(root, source), "utf8").replace(
    /(["'])(\.{1,2}\/[^"']+)\1/g,
    (_, quote, target) => quote + "@/" + resolve(root, owner, target).slice(root.length + 1) + quote
  )
  writeFileSync(resolve(out, name), prefix + original + "\n" + extra)
}

extend(
  "components/settings/prompts/code-prompt-detail.test.tsx",
  "detail.test.tsx",
  `
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { BUILT_IN_MODE_PROMPTS } from "@/lib/agent/modes/built-ins"
import { useEffectiveChatPreview } from "@/hooks/prompts/use-effective-chat-preview"
it("ADVERSARIAL mounted detail reports last use after opening preview only", async () => {
  const [id, definition] = [...BUILT_IN_MODE_PROMPTS.entries()][0]
  await renderDetail(definition)
  expect(screen.getByText("Not used since this window opened")).toBeInTheDocument()
  function PreviewOnly() {
    const { state } = useEffectiveChatPreview({ agentId: null, modeId: id, workspaceId: "ws-1" })
    return <span>{state.status}</span>
  }
  render(<PreviewOnly />)
  await screen.findByText("ready")
  expect(screen.queryByText("Not used since this window opened")).toBeNull()
  expect(screen.getByText(/Shipped text, at /)).toBeInTheDocument()
  console.log("MOUNTED_DETAIL_PREVIEW_USE", "Preview-only hook changed never-used into Shipped text, at <time>")
})
it.each([false, true])("ADVERSARIAL reset account validity control=%s", async (valid) => {
  const inherited = valid ? "Valid inherited text." : "INCOMPATIBLE ACCOUNT TEXT."
  await publishPromptOverride({ promptId: BRIEF_MODE_PROMPT.id, target: account,
    body: inherited, contractVersion: BRIEF_MODE_PROMPT.contractVersion + (valid ? 0 : 1),
    baseDigest: "old", expectedRev: 0, mutationId: "account-reset", origin: "import" })
  await publishPromptBody({ def: BRIEF_MODE_PROMPT, target: { scope: "workspace", targetId: "ws-1" },
    body: "Workspace override.", expectedRev: 0 })
  await renderDetail(BRIEF_MODE_PROMPT)
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "workspace" } })
  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "ws-1" } })
  await waitFor(() => expect(editor().value).toBe("Workspace override."))
  await userEvent.click(screen.getByRole("button", { name: "Reset to inherited" }))
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog.textContent).toContain(inherited)
  const buttons = screen.getAllByRole("button", { name: "Reset to inherited" })
  await userEvent.click(buttons[buttons.length - 1])
  await waitFor(async () => expect((await readPromptSlot(BRIEF_MODE_PROMPT.id,
    { scope: "workspace", targetId: "ws-1" })).active).toBeUndefined())
  invalidatePromptOverrideSnapshot()
  let actual!: Awaited<ReturnType<typeof resolvePromptAsync>>
  await act(async () => { actual = await resolvePromptAsync(BRIEF_MODE_PROMPT, { context: { workspaceId: "ws-1" } }) })
  expect(actual.text).toBe(valid ? inherited : BRIEF_MODE_PROMPT.defaultBody)
  console.log("RESET_PROBE", JSON.stringify({ valid, dialog: inherited, actual: actual.text,
    source: actual.source }))
})
`
)

extend(
  "hooks/prompts/use-effective-chat-preview.test.ts",
  "preview.test.ts",
  `
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { processPromptTemplateVariables } from "@/stores/agent/custom-mode-store/helpers"
import { __resetPromptResolutionsForTests, lastPromptResolution, recordPromptResolution } from "@/lib/prompts/resolution-log"
it("ADVERSARIAL preview cwd fallback and raw static template differ from runtime helpers", async () => {
  await useSettingsStore.getState().save({ defaultWorkingDir: "/app/default" })
  const agent = await createCharacter({ name: "Cwd", systemPrompt: "Identity.", workingDir: "/agent/project" })
  const mode = useCustomModeStore.getState().createMode({ name: "Research", systemPrompt: "Mode={{mode_name}}; tools={{tools_list}}", tools: ["web_search"] })
  const { result } = renderHook(() => useEffectiveChatPreview({ agentId: agent.id, modeId: mode.id, workspaceId: null }))
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const preview = result.current.state.status === "ready" ? result.current.state.preview : null
  const displayed = preview?.segments.find(s => s.kind === "mode")?.text
  const actual = processPromptTemplateVariables(mode.systemPrompt!, { modeName: mode.name, tools: mode.tools })
  expect(displayed).toBe("Mode={{mode_name}}; tools={{tools_list}}")
  expect(actual).toBe("Mode=Research; tools=web_search")
  expect(mockLoadInstructions).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: undefined }))
  expect(resolveEffectiveCwd({ characterWorkingDir: agent.workingDir, defaultWorkingDir: "/app/default" })).toBe("/agent/project")
  console.log("PREVIEW_PARITY", JSON.stringify({ displayed, actual, previewCwd: null, runtimeCwd: "/agent/project" }))
})
it("ADVERSARIAL preview updates actual-use evidence without any provider call", async () => {
  __resetPromptResolutionsForTests()
  recordPromptResolution({ promptId: modeDef.id, source: { kind: "override", scope: "workspace", bindingId: "prior", revisionId: "prior-used" }, context: { workspaceId: "other-workspace" }, at: 1 })
  const { result } = renderHook(() => useEffectiveChatPreview({ agentId: null, modeId, workspaceId: "ws-1" }))
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  expect(lastPromptResolution(modeDef.id)?.at).toBeGreaterThan(1)
  expect(lastPromptResolution(modeDef.id)?.context).toEqual({ workspaceId: "ws-1" })
  expect(lastPromptResolution(modeDef.id)?.source.kind).toBe("default")
  console.log("PREVIEW_OVERWROTE_LAST_USE", JSON.stringify(lastPromptResolution(modeDef.id)))
})
it("ADVERSARIAL changing selection retains old ready preview while replacement loads", async () => {
  const first = await createCharacter({ name: "Old", systemPrompt: "OLD IDENTITY" })
  const next = await createCharacter({ name: "New", systemPrompt: "NEW IDENTITY" })
  const { result, rerender } = renderHook(({ agentId }) => useEffectiveChatPreview({ agentId, modeId: null, workspaceId: "ws-1" }), { initialProps: { agentId: first.id } })
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  let release!: (value: { section: string }) => void
  mockLoadInstructions.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  rerender({ agentId: next.id })
  await waitFor(() => expect(release).toBeDefined())
  expect(result.current.state.status).toBe("ready")
  expect(result.current.state.status === "ready" && result.current.state.preview.text).toContain("OLD IDENTITY")
  await act(async () => release({ section: "" }))
  await waitFor(() => expect(result.current.state.status === "ready" && result.current.state.preview.text).toContain("NEW IDENTITY"))
  console.log("PREVIEW_STALE_READY", "Old identity remains ready under newly selected agent until load finishes")
})
`
)

extend(
  "components/chat/session-settings-sheet.test.tsx",
  "session.test.tsx",
  `
it.each([false, true])("ADVERSARIAL mounted session preserves explicit flag=%s", async (initialFlag) => {
  mockIsTauri.mockReturnValue(false)
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  const character = mkCharacter({ bareMode: true, debugMode: true, briefMode: true })
  const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
  const adapter = makeAdapter({ useCharacter: () => character, updateSession })
  render(<DataAdapterProvider adapter={adapter}><SessionSettingsSheet
    session={mkSession({ characterId: character.id, bareMode: initialFlag, debugMode: initialFlag, briefMode: initialFlag })}
    open onOpenChange={jest.fn()} /></DataAdapterProvider>)
  for (const name of [/bare mode/i, /debug mode/i, /brief output/i]) {
    const control = screen.getByRole("switch", { name })
    expect(control).toHaveAttribute("aria-checked", String(initialFlag))
  }
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /save/i })))
  await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
  const patch = updateSession.mock.calls[0][1] as Record<string, unknown>
  for (const key of ["bareMode", "debugMode", "briefMode"]) {
    expect(Object.hasOwn(patch, key)).toBe(true)
    expect(patch[key]).toBe(initialFlag ? true : undefined)
    expect(patch[key] ?? character[key as keyof typeof character]).toBe(true)
  }
  console.log("SESSION_OFF_PROBE", JSON.stringify({ initialFlag, savedFlag: patch.bareMode ?? null, runtimeFlag: patch.bareMode ?? character.bareMode }))
})
`
)

extend(
  "lib/prompts/adapters/index.test.ts",
  "catalog.test.ts",
  `
import { MODULE_PROMPTS } from "@/lib/modules/generated/prompts"
import { __resetModulePromptsForTests, loadPromptCatalog } from "@/lib/prompts/catalog"
it("ADVERSARIAL real catalog rejects a chunk but merged resource listing reports no failure", async () => {
  __resetModulePromptsForTests()
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  const first = await listPromptResources({})
  expect(first.failed).toEqual([])
  expect(first.resources.some(r => r.promptId === "audit.partial.good")).toBe(true)
  expect(first.resources.some(r => r.promptId === "audit.partial.bad")).toBe(false)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("audit-bad"), expect.any(Error))
  expect((await loadPromptCatalog()).failures.map(f => f.module)).toEqual(["audit-bad"])
  const bad = MODULE_PROMPTS.find(e => e.module === "audit-bad")!
  jest.mocked(bad.load).mockResolvedValue({ prompts: [{ ...BRIEF_MODE_PROMPT, id: "audit.partial.bad" }] })
  const retry = await listPromptResources({})
  expect(retry.failed).toEqual([])
  expect(retry.resources.some(r => r.promptId === "audit.partial.bad")).toBe(true)
  console.log("PARTIAL_CATALOG_PROBE", JSON.stringify({ firstFailed: first.failed, warned: true, missing: "audit.partial.bad", retryRecovered: true }))
})
`,
  `jest.mock("@/lib/modules/generated/prompts", () => ({ MODULE_PROMPTS: [
  { module: "audit-good", stage: "stable", load: jest.fn(async () => ({ prompts: [{ ...require("@/lib/agent/prompts/brief-mode").BRIEF_MODE_PROMPT, id: "audit.partial.good" }] })) },
  { module: "audit-bad", stage: "stable", load: jest.fn(async () => { throw new Error("injected chunk unavailable") }) },
] }))\n`
)

writeFileSync(
  resolve(out, "jest.config.mjs"),
  `
import build from "../../../jest.config.ts"
export default async () => {
  const config = await build()
  const project = config.projects.find(p => p.displayName === "jsdom")
  return { ...config, rootDir: ${JSON.stringify(root)}, cacheDirectory: ${JSON.stringify(resolve(out, "jest-cache"))},
    projects: [{ ...project, rootDir: ${JSON.stringify(root)},
      roots: [${JSON.stringify(out)}, ${JSON.stringify(resolve(root, "__mocks__"))}],
      testMatch: [${JSON.stringify(out + "/*.test.ts*")}],
      testPathIgnorePatterns: project.testPathIgnorePatterns.filter(p => !p.includes(".cache")),
      modulePathIgnorePatterns: project.modulePathIgnorePatterns.filter(p => !p.includes(".cache/"))
    }] }
}
`
)
const result = spawnSync(
  "rtk",
  [
    "proxy",
    "pnpm",
    "test",
    "--config",
    resolve(out, "jest.config.mjs"),
    "--runInBand",
    "-t",
    "ADVERSARIAL",
    "--json",
    "--outputFile",
    resolve(out, "results.json"),
  ],
  { cwd: root, stdio: "inherit", env: process.env }
)
process.exitCode = result.status ?? 1
