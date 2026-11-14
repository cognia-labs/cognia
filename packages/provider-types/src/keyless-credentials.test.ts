import {
  allowsAmbientSdkCredential,
  KEYLESS_SDK_PLACEHOLDER,
  keylessSdkCredential,
  withKeylessFetch,
} from "./keyless-credentials"

describe("allowsAmbientSdkCredential", () => {
  it("allows the SDK default and the vendor's own host", () => {
    expect(allowsAmbientSdkCredential({ sdk: "openai" })).toBe(true)
    expect(
      allowsAmbientSdkCredential({ sdk: "openai", baseURL: "https://api.openai.com/v1" })
    ).toBe(true)
    expect(
      allowsAmbientSdkCredential({ sdk: "azure", baseURL: "https://res.openai.azure.com/openai" })
    ).toBe(true)
  })

  it("refuses any other host, including local engines", () => {
    expect(
      allowsAmbientSdkCredential({ sdk: "openai", baseURL: "http://localhost:11434/v1" })
    ).toBe(false)
    expect(
      allowsAmbientSdkCredential({ sdk: "anthropic", baseURL: "https://relay.example/anthropic" })
    ).toBe(false)
    expect(allowsAmbientSdkCredential({ sdk: "openai", baseURL: "not a url" })).toBe(false)
  })
})

describe("keylessSdkCredential", () => {
  it("passes a configured key through unchanged", () => {
    const inner = jest.fn()
    expect(
      keylessSdkCredential({ sdk: "openai", apiKey: "k", baseURL: "http://x", fetch: inner })
    ).toEqual({ apiKey: "k", fetch: inner })
  })

  it("keeps the SDK's environment fallback toward the vendor host", () => {
    expect(keylessSdkCredential({ sdk: "openai" })).toEqual({ apiKey: undefined, fetch: undefined })
  })

  it("uses the placeholder for a keyless foreign endpoint", () => {
    const result = keylessSdkCredential({ sdk: "openai", baseURL: "http://localhost:11434/v1" })
    expect(result.apiKey).toBe(KEYLESS_SDK_PLACEHOLDER)
    expect(typeof result.fetch).toBe("function")
  })

  it("treats a blank key as absent", () => {
    expect(
      keylessSdkCredential({ sdk: "openai", apiKey: "  ", baseURL: "http://localhost:1/v1" }).apiKey
    ).toBe(KEYLESS_SDK_PLACEHOLDER)
  })
})

describe("withKeylessFetch", () => {
  it("drops the header built from the placeholder and keeps the rest", async () => {
    const inner = jest.fn(async () => new Response("ok"))
    await withKeylessFetch(inner as unknown as typeof fetch)("http://localhost/v1/chat", {
      headers: {
        Authorization: `Bearer ${KEYLESS_SDK_PLACEHOLDER}`,
        "x-tenant-id": "acme",
      },
    })
    const init = (inner.mock.calls[0] as unknown[])[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("x-tenant-id")).toBe("acme")
  })

  it("leaves a caller-configured Authorization header alone", async () => {
    const inner = jest.fn(async () => new Response("ok"))
    const init = { headers: { Authorization: "Bearer configured" } }
    await withKeylessFetch(inner as unknown as typeof fetch)("http://x", init)
    expect((inner.mock.calls[0] as unknown[])[1]).toBe(init)
  })
})
