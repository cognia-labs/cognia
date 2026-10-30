jest.mock("@/lib/tauri", () => ({ transport: {} }))
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
