/**
 * Research probes: assert the observed defects, not desired fixed behavior.
 * Reuses existing suite setup, writes only to .cache/, makes no provider calls.
 * Run: node docs/evidence/2026-11-08-selection-toolbar-support-audit.probes.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = process.cwd()
const output = resolve(root, ".cache/selection-toolbar-support-audit")
mkdirSync(output, { recursive: true })
const read = (path) => readFileSync(resolve(root, path), "utf8")
const write = (name, text) => writeFileSync(resolve(output, name), text)

write(
  "jest.config.ts",
  `
import base from "../../jest.config.ts"
export default async () => {
  const config = await base()
  const project = config.projects.find((p) => p.displayName === "jsdom")
  return {
    ...config,
    rootDir: process.cwd(),
    projects: [{
      ...project,
      rootDir: process.cwd(),
      displayName: "selection-audit",
      roots: ["<rootDir>/.cache/selection-toolbar-support-audit", "<rootDir>/__mocks__"],
      testMatch: ["<rootDir>/.cache/selection-toolbar-support-audit/*.test.tsx"],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: project.modulePathIgnorePatterns.filter((p) => !p.includes(".cache")),
    }],
  }
}
`
)

const pluginSetup = read("lib/selection/plugin-actions.test.ts")
  .split('it("executes an eligible metadata action')[0]
  .replace('from "./plugin-actions"', 'from "@/lib/selection/plugin-actions"')
write(
  "plugin-lifecycle.test.tsx",
  pluginSetup +
    `
import { unregisterQuickActionsByPlugin } from "@/lib/plugin/registries/quick-action-registry"
import { executeCommand, registerCommand } from "@/lib/plugin/commands/registry"
import { installPluginHostDispatch } from "@cognia/plugin-contract/lib/plugin/core/plugin-host-dispatch"
import { registerDeclaredInterceptors } from "@cognia/plugin-contract/lib/plugin/interceptors/contributions"
import { unregisterInterceptorsForPlugin } from "@cognia/plugin-contract/lib/plugin/interceptors/registry"
import { PluginConsentBroker, type PluginConsentRequestEvent } from "@/lib/plugin/security/consent-broker"

it("REPRO: disabling an action while consent is pending still releases the text", async () => {
  let prompt!: PluginConsentRequestEvent
  const run = jest.fn(async () => ({ kind: "text" as const, text: "result" }))
  const dispose = registerQuickAction("plug-a", {
    id: "late", title: "Late", run, surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
  })
  const broker = new PluginConsentBroker({ emit: (event) => { prompt = event } })
  const guard = registeredGuard(["selection:read"])
  const pending = executePluginSelectionQuickAction(
    getQuickAction("plug-a:late")!, candidate, { types: ["term"] },
    { guard, broker },
  )
  expect(broker.pendingCount()).toBe(1)
  dispose()
  guard.unregisterPlugin("plug-a")
  broker.clearSessionGrantsForPlugin("plug-a")
  expect(getQuickAction("plug-a:late")).toBeUndefined()
  broker.respond(prompt.requestId, { allow: true, persist: false })
  await pending
  expect(run).toHaveBeenCalledWith(expect.objectContaining({
    selection: expect.objectContaining({ text: candidate.text }),
  }))
})

it("REPRO: a cached confirmation still releases text after selection:read is revoked", async () => {
  const emit = jest.fn()
  const broker = new PluginConsentBroker({ emit })
  const guard = registeredGuard(["selection:read"])
  const run = jest.fn(() => ({ kind: "text" as const, text: "result" }))
  registerQuickAction("plug-a", {
    id: "repeat", title: "Repeat", run, surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
  })
  const invoke = () => executePluginSelectionQuickAction(
    getQuickAction("plug-a:repeat")!, candidate, { types: ["term"] }, { guard, broker },
  )
  const first = invoke()
  broker.respond(emit.mock.calls[0][0].requestId, { allow: true, persist: true })
  await first
  guard.revoke("plug-a", "selection:read")
  expect(guard.check("plug-a", "selection:read")).toBe(false)
  await invoke()
  expect(emit).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenCalledTimes(2)
})

it("REPRO: plugin accelerator dispatch calls selection handler without selection context", async () => {
  const bind = jest.fn(async () => () => {})
  installPluginHostDispatch({
    bindPluginShortcut: bind,
    findManifestCommand: async () => undefined,
    dispatchSlashCommand: async () => undefined,
  })
  const run = jest.fn(async () => ({ kind: "text" as const, text: "result" }))
  registerQuickAction("plug-a", {
    id: "accelerated", title: "Accelerated", run,
    accelerator: "Ctrl+Shift+Y", surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
  })
  const binding = bind.mock.calls[0][0]
  expect(binding.existingCommandId).toBe("_qa:plug-a:accelerated")
  await executeCommand(binding.existingCommandId)
  expect(run).toHaveBeenCalledWith(undefined)
  unregisterQuickActionsByPlugin("plug-a")
})

it("REPRO: approving plugin A releases text to plugin B's command without B's permission", async () => {
  let prompt!: PluginConsentRequestEvent
  const handler = jest.fn(() => ({ kind: "text" as const, text: "result" }))
  registerCommand({ id: "plug-b.transform", pluginId: "plug-b", handler })
  registerQuickAction("plug-a", {
    id: "relay", title: "Relay", command: "plug-b.transform", surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
  })
  const guard = registeredGuard(["selection:read"])
  guard.registerPlugin("plug-b", [])
  expect(guard.check("plug-b", "selection:read")).toBe(false)
  const broker = new PluginConsentBroker({ emit: (event) => { prompt = event } })
  const pending = executePluginSelectionQuickAction(
    getQuickAction("plug-a:relay")!, candidate, { types: ["term"] }, { guard, broker },
  )
  expect(prompt).toMatchObject({ pluginId: "plug-a", permission: "selection:read" })
  broker.respond(prompt.requestId, { allow: true, persist: false })
  await pending
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({
    selection: expect.objectContaining({ text: candidate.text }),
  }))
  expect(broker.pendingCount()).toBe(0)
})

it("REPRO: a command guard can read selection text meant for a different plugin", async () => {
  const inspect = jest.fn(() => ({ decision: "pass" as const }))
  const guard = registeredGuard(["selection:read"])
  guard.registerPlugin("plug-b", ["commands:read"])
  expect(guard.check("plug-b", "selection:read")).toBe(false)
  const registration = registerDeclaredInterceptors("plug-b", [{
    point: "ui.action.invoke", semantic: "guard", handler: inspect,
  }], { hasPermission: (permission) => permission === "commands:read" && guard.check("plug-b", permission) })
  expect(registration.registered).toBe(1)
  try {
    registerCommand({ id: "plug-a.transform", pluginId: "plug-a",
      handler: () => ({ kind: "text" as const, text: "result" }),
    })
    registerQuickAction("plug-a", {
      id: "self", title: "Self", command: "plug-a.transform", surfaces: ["selection"],
      selection: { input: "text", output: "preview" },
    })
    const request = jest.fn(async () => true)
    await executePluginSelectionQuickAction(
      getQuickAction("plug-a:self")!, candidate, { types: ["term"] }, { guard, broker: { request } },
    )
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "plug-a" }))
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      args: [expect.objectContaining({ selection: expect.objectContaining({ text: candidate.text }) })],
    }), expect.anything())
  } finally {
    unregisterInterceptorsForPlugin("plug-b")
  }
})
`
)

const hostSetup = read("components/providers/initializers/selection-toolbar-initializer.test.tsx")
  .split('it("publishes eligible plugin descriptors')[0]
  .replace(
    'from "./selection-toolbar-initializer"',
    'from "@/components/providers/initializers/selection-toolbar-initializer"'
  )
write(
  "host-lifecycle.test.tsx",
  hostSetup +
    `
jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn(() => ({})) }))
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({ buildHeadlessTurnLlmClient: jest.fn(() => null) }))
jest.mock("@/lib/chat/completion/enhance", () => ({
  ENHANCE_MODES: ["improve", "variants"], enhancePrompt: jest.fn(),
}))
import { enhancePrompt } from "@/lib/chat/completion/enhance"

it("REPRO: rewrite receives no abort signal and emits success after host unmount", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  try {
    let settle!: (value: unknown) => void
    ;(enhancePrompt as jest.Mock).mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    getCurrentCandidateMock.mockResolvedValue(candidate)
    const view = render(<SelectionToolbarInitializer />)
    await act(async () => {})
    emitToMock.mockClear()
    await act(async () => {
      handlers.get("selection://action-request")?.({ payload: {
        requestId: "rewrite-late", candidateId: candidate.id, actionId: "cognia:rewrite:improve",
      } })
    })
    expect(enhancePrompt).toHaveBeenCalledTimes(1)
    expect((enhancePrompt as jest.Mock).mock.calls[0][2].signal).toBeUndefined()
    await act(async () => { jest.advanceTimersByTime(35_000) })
    expect(emitToMock.mock.calls.filter((call) => call[1] === "selection://action-result")).toHaveLength(0)
    view.unmount()
    await act(async () => { settle({ kind: "rewrite", text: "late result" }) })
    expect(emitToMock).toHaveBeenCalledWith("selection-toolbar", "selection://action-result",
      expect.objectContaining({ requestId: "rewrite-late", ok: true }))
  } finally {
    jest.useRealTimers()
  }
})

it("REPRO: successful no-op speech never sends a terminal playback event", async () => {
  render(<SelectionToolbarInitializer />)
  await act(async () => {})
  emitToMock.mockClear()
  takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "speak" } })
  await act(async () => { stage()?.({ payload: null }) })
  expect(speakSelectionMock).toHaveBeenCalledTimes(1)
  expect(emitToMock.mock.calls.filter((call) => call[1] === "selection://speech")).toHaveLength(0)
})

it("REPRO: new host executes queued Remember although native has no current candidate", async () => {
  getCurrentCandidateMock.mockResolvedValue(null)
  takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "remember" } })
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(storeExternalMemoryMock).toHaveBeenCalledWith(
    expect.objectContaining({ text: candidate.text }), { channel: "selection" },
  ))
})

it("REPRO: Open result deduplicates different generated texts under one candidate id", async () => {
  useChatStore.getState().setActiveSession("session-1")
  getCurrentCandidateMock.mockResolvedValue(candidate)
  render(<SelectionToolbarInitializer />)
  await act(async () => {})
  await act(async () => {
    handlers.get("selection://open-result")?.({ payload: {
      candidateId: candidate.id, text: "first variant", attribution: "Cognia",
    } })
  })
  await act(async () => {
    handlers.get("selection://open-result")?.({ payload: {
      candidateId: candidate.id, text: "second variant", attribution: "Cognia",
    } })
  })
  expect(useChatStore.getState().contextSelections).toHaveLength(1)
  expect(useChatStore.getState().contextSelections[0].snapshot).toBe("first variant")
  expect(pushMock).toHaveBeenCalledTimes(2)
})
`
)

const viewSetup = read("components/selection-toolbar/selection-toolbar-view.test.tsx")
  .split('describe("SelectionToolbarView"')[0]
  .replaceAll("../../__mocks__/motion-react.js", "@/__mocks__/motion-react.js")
  .replaceAll(
    '"./use-selection-toolbar-geometry"',
    '"@/components/selection-toolbar/use-selection-toolbar-geometry"'
  )
  .replace(
    'from "./selection-toolbar-view"',
    'from "@/components/selection-toolbar/selection-toolbar-view"'
  )
write(
  "overlay-lifecycle.test.tsx",
  viewSetup +
    `
it("REPRO: missing main-window result leaves remember pending beyond 35 seconds", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  try {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "remember" }))
    await act(async () => { jest.advanceTimersByTime(35_000) })
    expect(executeMock).toHaveBeenCalledWith(candidate.id, { kind: "remember" })
    expect(keepAliveMock).toHaveBeenLastCalledWith(true)
    expect(finishMock).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "copy" })).toBeDisabled()
  } finally { jest.useRealTimers() }
})

it("REPRO: Open in Cognia emits an event but never finishes the overlay", async () => {
  render(<SelectionToolbarView />)
  await act(async () => {})
  await emit("selection://action-catalog", { candidateId: candidate.id, actions: [{
    id: "plug-a:preview", title: "Preview", source: "plugin", pluginId: "plug-a",
    input: "text", output: "preview",
  }] })
  fireEvent.click(screen.getByRole("button", { name: "more" }))
  fireEvent.click(screen.getByRole("menuitem", { name: /Preview/ }))
  const request = emitToMock.mock.calls.find((call) => call[1] === "selection://action-request")![2]
  await emit("selection://action-result", { ...request, ok: true,
    output: "preview", result: { kind: "text", text: "generated result" } })
  fireEvent.click(screen.getByRole("button", { name: "openInCognia" }))
  expect(emitToMock).toHaveBeenCalledWith("main", "selection://open-result", expect.objectContaining({ text: "generated result" }))
  expect(finishMock).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "copy" })).toBeInTheDocument()
})

it("REPRO: a shortcut arriving before the new candidate effect mounts is dropped", async () => {
  currentMock.mockResolvedValue(null)
  render(<SelectionToolbarView />)
  await act(async () => {})
  expect(listeners.has("selection://shortcut")).toBe(false)
  await act(async () => {
    listeners.get("selection://candidate")?.({ payload: candidate })
    listeners.get("selection://shortcut")?.({ payload: {
      shortcutId: "selection.copy", candidateId: candidate.id,
    } })
  })
  expect(screen.getByRole("button", { name: "copy" })).toBeInTheDocument()
  expect(executeMock).not.toHaveBeenCalled()
  await emit("selection://shortcut", { shortcutId: "selection.copy", candidateId: candidate.id })
  expect(executeMock).toHaveBeenCalledWith(candidate.id, { kind: "copy" })
})

it("REPRO: a reused overlay translates with a saved preference from its first mount", async () => {
  let locale = "de"
  getPrefMock.mockImplementation(async (key: string) =>
    key === "selectionToolbar.translateLocale" ? locale : null,
  )
  render(<SelectionToolbarView />)
  await act(async () => {})
  await emit("selection://dismiss", {})
  locale = "ja"
  const nextCandidate = { ...candidate, id: "candidate-2" }
  await emit("selection://candidate", nextCandidate)
  fireEvent.click(screen.getByRole("button", { name: "translate" }))
  expect(executeMock).toHaveBeenCalledWith(nextCandidate.id, { kind: "translate", targetLocale: "de" })
})

it("REPRO: an action shortcut can launch a URL from an OCR candidate", async () => {
  const ocr = { ...candidate, id: "ocr-1", origin: "ocr", text: "https://example.com/" }
  currentMock.mockResolvedValue(ocr)
  render(<SelectionToolbarView />)
  await act(async () => {})
  expect(screen.queryByRole("button", { name: "openLink" })).not.toBeInTheDocument()
  await emit("selection://shortcut", { shortcutId: "selection.action:openLink", candidateId: ocr.id })
  expect(executeMock).toHaveBeenCalledWith(ocr.id, { kind: "openLink", url: ocr.text })
})
`
)

const restoreSetup = read(
  "components/providers/initializers/selection-toolbar-restore-initializer.test.tsx"
)
  .split('it("restores an enabled toolbar')[0]
  .replace(
    'from "./selection-toolbar-restore-initializer"',
    'from "@/components/providers/initializers/selection-toolbar-restore-initializer"'
  )
  .replace(/const ensureBootCapabilityMock[\s\S]*?(?=const getPrefMock)/, "")
  .replace("import { render, waitFor }", "import { act, render, waitFor }")
write(
  "restore-readiness.test.tsx",
  restoreSetup +
    `
import {
  __resetBootCapabilitiesForTesting,
  getBootDiagnosticsSnapshot,
  markBootCapabilityReady,
} from "@/lib/boot/capabilities"

it("REFUTATION: opt-in restore waits for below-gate capability readiness", async () => {
  __resetBootCapabilitiesForTesting("eager")
  getPrefMock.mockImplementation(async (key: string) =>
    key === "selectionToolbar.mode" ? "automatic" : null,
  )
  render(<SelectionToolbarRestoreInitializer />)
  await waitFor(() => expect(getBootDiagnosticsSnapshot().pending).toContain("desktop-tools"))
  expect(startMock).not.toHaveBeenCalled()
  await act(async () => { markBootCapabilityReady("desktop-tools") })
  expect(startMock).not.toHaveBeenCalled()
  await act(async () => { markBootCapabilityReady("plugin-runtime") })
  expect(startMock).toHaveBeenCalledWith({ mode: "automatic", disabledApps: [], disabledSites: [] })
})
`
)

const excerptSetup = read("lib/chat/selection/message-excerpt.test.ts")
  .split('describe("buildMessageExcerptSelection"')[0]
  .replace('from "./message-excerpt"', 'from "@/lib/chat/selection/message-excerpt"')
write(
  "excerpt-refresh.test.tsx",
  excerptSetup +
    `
it("REPRO: Refresh certifies a stale code excerpt after the comparison operator reverses", async () => {
  const quote = "count >= 10"
  await seed("m1", "Use \\u0060count >= 10\\u0060.")
  const selection = (await buildMessageExcerptSelection({
    sessionId: "s1", messageIds: ["m1"], text: quote, excerpt: { derivation: "quote", quote },
  })) as Excerpt
  await edit("m1", "Use \\u0060count <= 10\\u0060.")
  await expect(isEntitySelectionStale(selection)).resolves.toBe(true)
  const outcome = await refreshMessageExcerpt({ ...selection, stale: true })
  expect(outcome.kind).toBe("current")
  if (outcome.kind !== "current") return
  expect(outcome.selection.snapshot).toContain(quote)
  await expect(isEntitySelectionStale(outcome.selection)).resolves.toBe(false)
})
`
)

const result = spawnSync(
  "pnpm",
  ["test", "--config", resolve(output, "jest.config.ts"), "--runInBand"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }
)
const log = [result.stdout, result.stderr].filter(Boolean).join("\n")
write("probes.log", log)
process.stdout.write(log)
process.exitCode = result.status ?? 1
