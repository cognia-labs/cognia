jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: jest.fn(() => ({ settings: {} })) },
}))
jest.mock("@/lib/ai/renderer-llm-client", () => ({ buildRendererLlmClient: jest.fn() }))

import { getSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { AppSettings } from "@cognia/agent-config-types"
import { getSession } from "@/lib/db/sessions"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { buildPlanRepairClient } from "./repair-client"

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(useSettingsStore.getState)
    .mockReturnValue({ settings: {} } as ReturnType<typeof useSettingsStore.getState>)
  jest.mocked(getSettings).mockResolvedValue({} as AppSettings)
  jest.mocked(getSession).mockResolvedValue(undefined)
  jest.mocked(buildRendererLlmClient).mockReturnValue(null)
})

it("builds a repair client in the plan session's workspace", async () => {
  const session = { id: "ses", projectId: "session-ws" } as Awaited<ReturnType<typeof getSession>>
  jest.mocked(getSession).mockResolvedValue(session)
  const client = { complete: jest.fn() }
  jest.mocked(buildRendererLlmClient).mockReturnValue(client)
  expect(
    await buildPlanRepairClient({ sessionId: "ses", projectId: "plan-ws" }, "test-repair")
  ).toBe(client)
  expect(buildRendererLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({
      session,
      featureId: "test-repair",
      ledgerSurface: "agentsWorkflows",
      ledgerOrigin: "agent",
      workspaceId: "session-ws",
    })
  )
})

it("uses the plan's workspace, then the caller's workspace, when the session has none", async () => {
  await buildPlanRepairClient({ sessionId: "ses", projectId: "plan-ws" }, "repair", "caller-ws")
  expect(buildRendererLlmClient).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: "plan-ws" })
  )
  await buildPlanRepairClient({ sessionId: "ses" }, "repair", "caller-ws")
  expect(buildRendererLlmClient).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: "caller-ws" })
  )
})

it("allows runs without repair when no model is configured or the plan is missing", async () => {
  expect(await buildPlanRepairClient({ sessionId: "ses" }, "repair")).toBeUndefined()
  jest.mocked(buildRendererLlmClient).mockClear()
  expect(await buildPlanRepairClient(null, "repair")).toBeUndefined()
  expect(buildRendererLlmClient).not.toHaveBeenCalled()
})

it("can build from app defaults when the session read fails", async () => {
  jest.mocked(getSession).mockRejectedValue(new Error("session unavailable"))
  await buildPlanRepairClient({ sessionId: "ses" }, "repair")
  expect(buildRendererLlmClient).toHaveBeenCalledWith(expect.objectContaining({ session: null }))
})

it("keeps client construction failures off the run path", async () => {
  jest.mocked(buildRendererLlmClient).mockImplementationOnce(() => {
    throw new Error("settings unavailable")
  })
  expect(await buildPlanRepairClient({ sessionId: "ses" }, "repair")).toBeUndefined()
})

it("uses persisted settings when a headless host has no hydrated settings store", async () => {
  jest
    .mocked(useSettingsStore.getState)
    .mockReturnValue({ settings: null } as ReturnType<typeof useSettingsStore.getState>)
  const stored = { defaultProvider: "configured-provider" } as AppSettings
  jest.mocked(getSettings).mockResolvedValue(stored)
  const client = { complete: jest.fn() }
  jest.mocked(buildRendererLlmClient).mockReturnValue(client)
  expect(await buildPlanRepairClient({ sessionId: "ses" }, "repair")).toBe(client)
  expect(getSettings).toHaveBeenCalledTimes(1)
  expect(buildRendererLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({ appSettings: stored })
  )
})

it("does not read persisted settings when the renderer store is loaded", async () => {
  await buildPlanRepairClient({ sessionId: "ses" }, "repair")
  expect(getSettings).not.toHaveBeenCalled()
})

it("allows a run without repair when persisted settings cannot be read", async () => {
  jest
    .mocked(useSettingsStore.getState)
    .mockReturnValue({ settings: null } as ReturnType<typeof useSettingsStore.getState>)
  jest.mocked(getSettings).mockRejectedValue(new Error("settings unavailable"))
  expect(await buildPlanRepairClient({ sessionId: "ses" }, "repair")).toBeUndefined()
})
