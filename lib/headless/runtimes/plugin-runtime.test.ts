jest.mock("@/lib/tauri", () => ({ transport: { subscribe: jest.fn(() => jest.fn()) } }))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  sweepTombstoned: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/character-pack/warning-refresh-wiring", () => ({
  installPackWarningRefreshWiring: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/plugin/devtools/plugin-log-bridge", () => ({
  installPluginRuntimeLogBridge: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/plugin/cogset/bootstrap-default", () => ({
  ensureDefaultCogsetOnHost: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/cogset/write-through", () => ({
  startDefaultCogsetWriteThrough: jest.fn(async () => ({ stop: jest.fn() })),
}))
jest.mock("@/lib/plugin/cogset/follower", () => ({
  startDefaultCogsetFollower: jest.fn(async () => ({ stop: jest.fn() })),
}))
jest.mock("@/lib/plugin/messaging/stream-hook-source", () => ({
  installStreamHookSource: jest.fn(() => jest.fn()),
}))
jest.mock("../registry", () => ({ registerHeadlessRuntime: jest.fn() }))
jest.mock("@/lib/plugin/messaging/external-agent-config-hook-source", () => ({
  installExternalAgentConfigHookSource: jest.fn(),
}))
jest.mock("@/lib/plugin/messaging/glance-visibility-hook-source", () => ({
  installGlanceVisibilityHookSource: jest.fn(),
}))
jest.mock("@/lib/plugin/messaging/workflow-registry-hook-source", () => ({
  installWorkflowRegistryHookSource: jest.fn(),
}))

jest.mock("@/lib/plugin/messaging/chat-lifecycle-hook-source", () => ({
  installChatLifecycleHookSource: jest.fn(() => jest.fn()),
}))

import { startPluginHookSources } from "./plugin-runtime"
import { registerHeadlessRuntime } from "../registry"
import { sweepTombstoned } from "@/lib/plugin/auth/connection-manager"

// Captured at import: the jest config clears mock calls between tests.
const registeredRuntime = jest.mocked(registerHeadlessRuntime).mock.calls[0][0] as unknown as {
  start: (ctx: unknown) => Promise<() => Promise<void>>
}
import { installExternalAgentConfigHookSource } from "@/lib/plugin/messaging/external-agent-config-hook-source"
import { installGlanceVisibilityHookSource } from "@/lib/plugin/messaging/glance-visibility-hook-source"
import { installWorkflowRegistryHookSource } from "@/lib/plugin/messaging/workflow-registry-hook-source"

it("installs the same registry feeds for both hosts and releases each exactly once", () => {
  const stops = [jest.fn(), jest.fn(), jest.fn()]
  jest.mocked(installExternalAgentConfigHookSource).mockReturnValue(stops[0])
  jest.mocked(installGlanceVisibilityHookSource).mockReturnValue(stops[1])
  jest.mocked(installWorkflowRegistryHookSource).mockReturnValue(stops[2])
  const stop = startPluginHookSources()
  stop()
  stop()
  stops.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1))
})

it("rolls back already-installed feeds when a later feed cannot start", () => {
  const stopExternal = jest.fn()
  const stopGlance = jest.fn()
  jest.mocked(installExternalAgentConfigHookSource).mockReturnValue(stopExternal)
  jest.mocked(installGlanceVisibilityHookSource).mockReturnValue(stopGlance)
  jest.mocked(installWorkflowRegistryHookSource).mockImplementationOnce(() => {
    throw new Error("failed source")
  })
  expect(() => startPluginHookSources()).toThrow("failed source")
  expect(stopGlance).toHaveBeenCalledTimes(1)
  expect(stopExternal).toHaveBeenCalledTimes(1)
})

it("sweeps interrupted auth disconnects after start without blocking or failing it", async () => {
  const definition = registeredRuntime
  // A revoke that never answers must not hold the runtime, and a failing
  // sweep is logged, not thrown.
  jest.mocked(sweepTombstoned).mockImplementationOnce(() => new Promise<void>(() => {}))
  const log = jest.fn()
  const runtime = { start: jest.fn(async () => {}), reconcile: jest.fn() }
  const stop = await definition.start({ pluginRuntime: runtime, log, localAccountId: "acct" })
  expect(runtime.start).toHaveBeenCalledTimes(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sweepTombstoned).toHaveBeenCalledTimes(1)
  await stop()

  jest.mocked(sweepTombstoned).mockRejectedValueOnce(new Error("keyring locked"))
  const stopAgain = await definition.start({ pluginRuntime: runtime, log, localAccountId: "acct" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(log).toHaveBeenCalledWith("warn", "auth tombstone cleanup unavailable: keyring locked")
  await stopAgain()
})
