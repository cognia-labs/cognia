/**
 * Tests for the plugin-model-call PII red-line.
 */

import { assertNoLeakingPii, PluginPiiError, sanitizePluginNetworkEgress } from "./plugin-pii-gate"

describe("assertNoLeakingPii", () => {
  it("passes clean text through", () => {
    expect(() => assertNoLeakingPii("p", "site", ["hello world", "no pii here"])).not.toThrow()
  })

  it("ignores empty / nullish entries", () => {
    expect(() => assertNoLeakingPii("p", "site", ["", undefined, null])).not.toThrow()
  })

  it("throws PluginPiiError for an email address", () => {
    expect(() => assertNoLeakingPii("p", "ctx.ai.chat", ["contact me at foo@bar.com"])).toThrow(
      PluginPiiError
    )
  })

  it("throws for an API-key-shaped secret", () => {
    expect(() =>
      assertNoLeakingPii("p", "ctx.ai.embed", ["sk-ant-api03-abcdefghijklmnopqrstuvwx"])
    ).toThrow(PluginPiiError)
  })

  it("carries pluginId and site on the error", () => {
    try {
      assertNoLeakingPii("my-plugin", "ctx.vector.embed", ["foo@bar.com"])
      fail("expected throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PluginPiiError)
      expect((error as PluginPiiError).pluginId).toBe("my-plugin")
      expect((error as PluginPiiError).site).toBe("ctx.vector.embed")
      expect((error as PluginPiiError).message).toContain("ctx.vector.embed")
    }
  })
})

describe("sanitizePluginNetworkEgress", () => {
  it("preserves OAuth token exchange credentials while still redacting other fields", () => {
    const result = sanitizePluginNetworkEgress("feishu-auth", {
      url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      body: {
        grant_type: "refresh_token",
        client_secret: "sk-proj-abcdefghijklmnopqrstuv",
        refresh_token: "alice@example.com",
        note: "alice@example.com",
      },
    })
    expect(result.body).toEqual({
      grant_type: "refresh_token",
      client_secret: "sk-proj-abcdefghijklmnopqrstuv",
      refresh_token: "alice@example.com",
      note: "<EMAIL_001>",
    })
  })

  it("does not exempt OAuth-named fields in ordinary requests", () => {
    const result = sanitizePluginNetworkEgress("feishu-auth", {
      url: "https://api.example.com/messages",
      body: { grant_type: "refresh_token", refresh_token: "alice@example.com" },
    })
    expect(result.body).toEqual({ grant_type: "refresh_token", refresh_token: "<EMAIL_001>" })
  })

  it.each([
    ["ordinary-plugin", "https://open.feishu.cn/open-apis/authen/v2/oauth/token"],
    ["ordinary-plugin", "https://example.com/token"],
    ["feishu-auth", "https://example.com/token"],
    ["feishu-auth", "https://open.feishu.cn/open-apis/authen/v2/oauth/token?other=1"],
    ["feishu-auth", "https://open.feishu.cn/open-apis/authen/v2/oauth/token#other"],
    ["feishu-auth", "https://person@open.feishu.cn/open-apis/authen/v2/oauth/token"],
  ])("does not classify credentials outside Feishu transport ownership: %s %s", (pluginId, url) => {
    const result = sanitizePluginNetworkEgress(pluginId, {
      url,
      body: { grant_type: "authorization_code", code: "alice@example.com" },
    })
    expect(result.body).toEqual({ grant_type: "authorization_code", code: "<EMAIL_001>" })
  })
  it("redacts PII deeply while preserving explicit credential fields", () => {
    const result = sanitizePluginNetworkEgress("sre", {
      url: "https://api.example.com/logs?owner=alice@example.com",
      headers: {
        "x-api-key": "sk-proj-abcdefghijklmnopqrstuv",
        "x-customer-email": "alice@example.com",
      },
      body: {
        api_key: "sk-proj-abcdefghijklmnopqrstuv",
        query: { owner: "alice@example.com" },
      },
    })

    expect(decodeURIComponent(result.url)).toContain("owner=<EMAIL_001>")
    expect(result.headers?.["x-api-key"]).toBe("sk-proj-abcdefghijklmnopqrstuv")
    expect(result.headers?.["x-customer-email"]).toBe("<EMAIL_001>")
    expect(result.body).toEqual({
      api_key: "sk-proj-abcdefghijklmnopqrstuv",
      query: { owner: "<EMAIL_001>" },
    })
  })

  it("blocks instead of rewriting when the strict policy is requested", () => {
    expect(() =>
      sanitizePluginNetworkEgress("sre", {
        url: "https://api.example.com/logs",
        body: { query: "owner alice@example.com" },
        piiPolicy: "block",
      })
    ).toThrow(PluginPiiError)
  })

  it("sanitizes JSON string bodies without changing their transport shape", () => {
    const result = sanitizePluginNetworkEgress("sre", {
      url: "https://api.example.com/logs",
      body: JSON.stringify({ owner: "alice@example.com" }),
    })

    expect(typeof result.body).toBe("string")
    expect(JSON.parse(result.body as string)).toEqual({ owner: "<EMAIL_001>" })
  })
})
