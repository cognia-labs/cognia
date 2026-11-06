const installOcrRuntime = jest.fn(async (_opts?: unknown) => {})
const resetRuntime = jest.fn()
const resetRegistry = jest.fn()
jest.mock("./runtime", () => ({
  installOcrRuntime: (opts?: unknown) => installOcrRuntime(opts),
  __resetOcrRuntime: () => resetRuntime(),
}))
jest.mock("./registry", () => ({ __resetSharedOcrRegistry: () => resetRegistry() }))

import { start } from "./runtime-brain"

beforeEach(() => jest.clearAllMocks())

describe("OCR runtime on the brain", () => {
  it("installs the providers with no host transport", async () => {
    await start()
    expect(installOcrRuntime).toHaveBeenCalledWith(undefined)
  })

  it("resets the runtime and empties the registry on teardown", async () => {
    const teardown = await start()
    expect(resetRuntime).not.toHaveBeenCalled()
    teardown()
    expect(resetRuntime).toHaveBeenCalledTimes(1)
    expect(resetRegistry).toHaveBeenCalledTimes(1)
  })
})
