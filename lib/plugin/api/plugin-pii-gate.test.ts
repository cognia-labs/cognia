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
  it("preserves bundled Feishu refresh credentials while still redacting other fields", () => {
    const result = sanitizePluginNetworkEgress(
      "feishu-auth",
      {
        url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        body: {
          grant_type: "refresh_token",
          client_secret: "sk-proj-abcdefghijklmnopqrstuv",
          refresh_token: "alice@example.com",
          note: "alice@example.com",
        },
      },
      { isBuiltin: true }
    )
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

  const protocol = {
    grant_type: "authorization_code",
    code: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    redirect_uri: "http://localhost/callback",
    client_id: "10123456789-abc.apps.googleusercontent.com",
    code_verifier: "sk-proj-abcdefghijklmnopqrstuvwx123456789012345",
  }
  const oauthTokenKeys = new Set(Object.keys(protocol))

  it.each(["json", "form"] as const)(
    "preserves host PKCE %s protocol fields and sanitizes decoded extra values per key",
    (encoding) => {
      for (const code of [protocol.code, "1234567890", "13812345678"]) {
        for (const prefix of ["sk-", "EAA", "AIza", "ghp_"]) {
          const fields = {
            ...protocol,
            code,
            code_verifier: `${prefix}${"a".repeat(43)}`,
            token: "alice@example.com",
            secret: "bob@example.com",
            note: "carol@example.com",
            api_key: "sk-proj-abcdefghijklmnopqrstuvwx",
          }
          const result = sanitizePluginNetworkEgress(
            "provider",
            {
              url: "https://provider.example/token",
              headers: {
                "Content-Type":
                  encoding === "json"
                    ? "application/json"
                    : "application/x-www-form-urlencoded; charset=UTF-8",
              },
              body: encoding === "json" ? fields : new URLSearchParams(fields).toString(),
            },
            { oauthTokenKeys }
          )
          const body =
            encoding === "json"
              ? result.body
              : Object.fromEntries(new URLSearchParams(result.body as string))
          expect(body).toEqual({
            ...fields,
            token: "<EMAIL_001>",
            secret: "<EMAIL_001>",
            note: "<EMAIL_001>",
          })
        }
      }
    }
  )

  it.each(["object", "json", "form"])("sanitizes a non-exempt code override in %s", (encoding) => {
    const fields = { ...protocol, code: "alice@example.com" }
    const result = sanitizePluginNetworkEgress(
      "provider",
      {
        url: "https://provider.example/token",
        headers: {
          "content-type":
            encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
        },
        body:
          encoding === "object"
            ? fields
            : encoding === "json"
              ? JSON.stringify(fields)
              : new URLSearchParams(fields).toString(),
      },
      { oauthTokenKeys: new Set([...oauthTokenKeys].filter((key) => key !== "code")) }
    )
    const body =
      encoding === "object"
        ? result.body
        : encoding === "json"
          ? JSON.parse(result.body as string)
          : Object.fromEntries(new URLSearchParams(result.body as string))
    expect(body).toEqual({ ...fields, code: "<EMAIL_001>" })
  })

  it("does not treat nested or non-string protocol values as host credentials", () => {
    const result = sanitizePluginNetworkEgress(
      "provider",
      {
        url: "https://provider.example/token",
        body: { code: { code: "alice@example.com" }, extra: { code: "bob@example.com" } },
      },
      { oauthTokenKeys }
    )
    expect(result.body).toEqual({ code: { code: "<EMAIL_001>" }, extra: { code: "<EMAIL_001>" } })
  })

  it("still blocks PII in marked extra values under the strict policy", () => {
    expect(() =>
      sanitizePluginNetworkEgress(
        "provider",
        {
          url: "https://provider.example/token",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...protocol, note: "alice@example.com" }).toString(),
          piiPolicy: "block",
        },
        { oauthTokenKeys }
      )
    ).toThrow(PluginPiiError)
  })

  it("keeps unmarked form inspection unchanged", () => {
    const body = new URLSearchParams({ note: "alice@example.com" }).toString()
    expect(
      sanitizePluginNetworkEgress("provider", {
        url: "https://provider.example/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }).body
    ).toBe(body)
  })

  it.each(["authorization_code", "client_credentials"])(
    "does not exempt the bundled Feishu %s grant",
    (grant_type) => {
      const result = sanitizePluginNetworkEgress(
        "feishu-auth",
        {
          url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
          body: { grant_type, code: "alice@example.com", client_secret: "bob@example.com" },
        },
        { isBuiltin: true }
      )
      expect(result.body).toEqual({ grant_type, code: "<EMAIL_001>", client_secret: "<EMAIL_001>" })
    }
  )

  it("does not exempt an externally installed Feishu namesake", () => {
    const result = sanitizePluginNetworkEgress("feishu-auth", {
      url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      body: { grant_type: "refresh_token", refresh_token: "alice@example.com" },
    })
    expect(result.body).toEqual({ grant_type: "refresh_token", refresh_token: "<EMAIL_001>" })
  })

  it("keeps the Feishu refresh exception JSON-only and limited to refresh credentials", () => {
    const fields = {
      grant_type: "refresh_token",
      refresh_token: "alice@example.com",
      code: "bob@example.com",
      code_verifier: "carol@example.com",
    }
    const result = sanitizePluginNetworkEgress(
      "feishu-auth",
      {
        url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        body: JSON.stringify(fields),
      },
      { isBuiltin: true }
    )
    expect(JSON.parse(result.body as string)).toEqual({
      ...fields,
      code: "<EMAIL_001>",
      code_verifier: "<EMAIL_001>",
    })
    expect(
      sanitizePluginNetworkEgress(
        "feishu-auth",
        {
          url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "refresh_token=1234567890",
        },
        { isBuiltin: true }
      ).body
    ).not.toBe("refresh_token=1234567890")
  })

  it.each([
    ["ordinary-plugin", "https://open.feishu.cn/open-apis/authen/v2/oauth/token"],
    ["ordinary-plugin", "https://example.com/token"],
    ["feishu-auth", "https://example.com/token"],
    ["feishu-auth", "https://open.feishu.cn/open-apis/authen/v2/oauth/token?other=1"],
    ["feishu-auth", "https://open.feishu.cn/open-apis/authen/v2/oauth/token#other"],
    ["feishu-auth", "https://person@open.feishu.cn/open-apis/authen/v2/oauth/token"],
  ])("does not classify credentials outside Feishu transport ownership: %s %s", (pluginId, url) => {
    const result = sanitizePluginNetworkEgress(
      pluginId,
      {
        url,
        body: { grant_type: "refresh_token", refresh_token: "alice@example.com" },
      },
      { isBuiltin: true }
    )
    expect(result.body).toEqual({ grant_type: "refresh_token", refresh_token: "<EMAIL_001>" })
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
