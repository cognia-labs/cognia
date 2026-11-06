const installOcrRuntime = jest.fn()
const proxyFetch = jest.fn()
jest.mock("./runtime", () => ({
  installOcrRuntime: (opts?: unknown) => installOcrRuntime(opts),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => proxyFetch(...args),
}))

import { start } from "./runtime-renderer"

beforeEach(() => {
  installOcrRuntime.mockReset().mockResolvedValue(undefined)
  proxyFetch.mockReset().mockResolvedValue(new Response("ok"))
})

describe("OCR runtime in a window", () => {
  it("installs the providers and keeps them across restarts (no teardown)", async () => {
    await expect(start({ log: jest.fn() })).resolves.toBeUndefined()
    expect(installOcrRuntime).toHaveBeenCalledTimes(1)
  })

  it("routes the cloud providers through the proxy-aware transport", async () => {
    await start({ log: jest.fn() })
    const [options] = installOcrRuntime.mock.calls[0] as [{ cloudFetch: typeof fetch }]
    // Delegation, not identity: the wrapper keeps `proxyFetch`'s narrower
    // option type assignable to `typeof fetch`.
    await options.cloudFetch("https://api.mistral.ai/v1/ocr", { method: "POST" })
    expect(proxyFetch).toHaveBeenCalledWith("https://api.mistral.ai/v1/ocr", { method: "POST" })
  })

  it("logs an install that fails instead of failing the host", async () => {
    installOcrRuntime.mockRejectedValueOnce(new Error("boom"))
    const log = jest.fn()
    await expect(start({ log })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith("warn", "ocr runtime install failed: boom")
  })
})
