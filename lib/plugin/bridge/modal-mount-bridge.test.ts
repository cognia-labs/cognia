import { registerModalMountsForPlugin } from "./modal-mount-bridge"
import { bindPluginCallbacks } from "@/lib/plugin/core/invocation-identity"
import { configurePersonalDispatchFence } from "@/lib/execution/personal-operation"
import type { PluginManifest } from "@/types/plugin/plugin"
const mockRegister = jest.fn()
jest.mock("@cognia/plugin-contract/lib/plugin/bridge/modal-mount-bridge", () => ({
  registerModalMountsForPlugin: (...args: unknown[]) => mockRegister(...args),
}))
it("R11 declared modal maps only its component export to a synchronous gate", async () => {
  const restore = configurePersonalDispatchFence(() => undefined)
  const guest = jest.fn(() => null),
    utility = jest.fn()
  mockRegister.mockImplementation(async (_manifest, _root, options) => {
    const importedModule = await options.importer("modal.js")
    expect(importedModule.utility).toBe(utility)
    expect(
      bindPluginCallbacks("r11", importedModule.Modal, () => ({ executionRunId: "r11-cold" }))()
    ).toBeNull()
  })
  try {
    await registerModalMountsForPlugin(
      { id: "r11", modalMounts: [{ export: "Modal" }] } as PluginManifest,
      "/root",
      { importer: async () => ({ Modal: guest, utility }) }
    )
    expect(guest).not.toHaveBeenCalled()
  } finally {
    restore()
  }
})
