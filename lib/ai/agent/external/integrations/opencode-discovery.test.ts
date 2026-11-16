const requestResult = jest.fn()
const validateOpenCodeV2Discovery = jest.fn()

jest.mock("@/lib/ai/agent/execution/sidecar-feature-client", () => ({
  defaultClient: { requestResult: (...args: unknown[]) => requestResult(...args) },
}))
jest.mock("@cognia/agent-opencode/discovery", () => ({
  validateOpenCodeV2Discovery: (value: unknown) => validateOpenCodeV2Discovery(value),
}))

import { discoverOpenCodeV2ViaSidecar } from "./opencode-discovery"

beforeEach(() => jest.clearAllMocks())

it("asks the Host for OpenCode v2 discovery without credentials and validates the reply", async () => {
  const signal = new AbortController().signal
  const raw = { version: "2" }
  const discovery = { validated: true }
  requestResult.mockResolvedValue(raw)
  validateOpenCodeV2Discovery.mockReturnValue(discovery)
  await expect(discoverOpenCodeV2ViaSidecar(signal)).resolves.toBe(discovery)
  expect(requestResult).toHaveBeenCalledWith(
    { operation: "opencode-v2-discover", credentials: {} },
    signal
  )
  expect(validateOpenCodeV2Discovery).toHaveBeenCalledWith(raw)
})

it("propagates a validation failure", async () => {
  requestResult.mockResolvedValue({})
  validateOpenCodeV2Discovery.mockImplementation(() => {
    throw new Error("invalid discovery")
  })
  await expect(discoverOpenCodeV2ViaSidecar()).rejects.toThrow("invalid discovery")
})
