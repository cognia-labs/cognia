import { createModalAPI } from "./modal-api"
import { bindPluginCallbacks } from "@/lib/plugin/core/invocation-identity"
import { configurePersonalDispatchFence } from "@/lib/execution/personal-operation"
const mockOpen = jest.fn()
jest.mock("@cognia/plugin-contract/lib/plugin/api/modal-api", () => ({
  createModalAPI: () => ({ openModal: (...args: unknown[]) => mockOpen(...args), closeAll() {} }),
}))
it("R11 modal renderer synchronously stays empty while cold", () => {
  const restore = configurePersonalDispatchFence(() => undefined)
  const guest = jest.fn(() => null)
  try {
    createModalAPI("r11").openModal(guest)
    const registered = mockOpen.mock.calls[0][0]
    expect(
      bindPluginCallbacks("r11", registered, () => ({ executionRunId: "r11-cold" }))()
    ).toBeNull()
    expect(guest).not.toHaveBeenCalled()
  } finally {
    restore()
  }
})
