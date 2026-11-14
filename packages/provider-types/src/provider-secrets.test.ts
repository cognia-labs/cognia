import {
  isCredentialHeaderName,
  stripProviderCollectionSecrets,
  stripProviderSecrets,
} from "./provider-secrets"

const SECRET = "sk-synthetic-secret-value"

function fullRow() {
  return {
    providerId: "openrouter",
    enabled: true,
    defaultModel: "openai/gpt-x",
    baseURL: "https://gateway.example/v1",
    apiProtocol: "openai",
    apiFlavor: "chat",
    apiKey: SECRET,
    apiKeys: [SECRET, `${SECRET}-2`],
    apiKeyUsageStats: { [SECRET]: { usageCount: 1, lastUsed: 1, errorCount: 0 } },
    currentKeyIndex: 1,
    oauthConnected: true,
    oauthRefreshToken: `${SECRET}-refresh`,
    verificationStatus: "verified",
    verificationFingerprint: JSON.stringify({ apiKey: SECRET }),
    lastVerifiedAt: 5,
    verificationMessage: "ok",
    customHeaders: { Authorization: `Bearer ${SECRET}`, "x-tenant-id": "acme" },
    bedrock: {
      authMode: "iam",
      region: "us-east-1",
      apiKey: SECRET,
      accessKeyId: "AKIASYNTHETIC",
      secretAccessKey: SECRET,
      sessionToken: SECRET,
      profile: "dev",
    },
    openRouterSettings: {
      provisioningApiKey: SECRET,
      byokKeys: [{ id: "b", provider: "openai", config: JSON.stringify({ apiKey: SECRET }) }],
      siteName: "Cognia",
    },
    cliProxyAPISettings: { host: "127.0.0.1", port: 8317, managementKey: SECRET },
    inferenceDefaults: { temperature: 0.2 },
    providerSpecificParams: { reasoning_effort: "high", api_token: SECRET, enabled: true },
  }
}

describe("stripProviderSecrets", () => {
  it("removes every credential the row carries", () => {
    const stripped = stripProviderSecrets(fullRow())
    expect(JSON.stringify(stripped)).not.toContain(SECRET)
    expect(JSON.stringify(stripped)).not.toContain("AKIASYNTHETIC")
  })

  it("keeps the non-secret connection metadata", () => {
    const stripped = stripProviderSecrets(fullRow()) as Record<string, unknown>
    expect(stripped).toMatchObject({
      providerId: "openrouter",
      baseURL: "https://gateway.example/v1",
      apiProtocol: "openai",
      apiFlavor: "chat",
      defaultModel: "openai/gpt-x",
      customHeaders: { "x-tenant-id": "acme" },
      bedrock: { authMode: "iam", region: "us-east-1", profile: "dev" },
      openRouterSettings: { siteName: "Cognia" },
      cliProxyAPISettings: { host: "127.0.0.1", port: 8317 },
      inferenceDefaults: { temperature: 0.2 },
      providerSpecificParams: { reasoning_effort: "high", enabled: true },
    })
  })

  it("drops verification, which only describes the removed credentials", () => {
    const stripped = stripProviderSecrets(fullRow()) as Record<string, unknown>
    expect(stripped.verificationStatus).toBeUndefined()
    expect(stripped.verificationFingerprint).toBeUndefined()
    expect(stripped.lastVerifiedAt).toBeUndefined()
  })

  it("removes the headers field entirely when only credential headers were set", () => {
    const stripped = stripProviderSecrets({ customHeaders: { "x-api-key": SECRET } }) as Record<
      string,
      unknown
    >
    expect("customHeaders" in stripped).toBe(false)
  })

  it("never mutates its input", () => {
    const row = fullRow()
    const before = JSON.stringify(row)
    stripProviderSecrets(row)
    expect(JSON.stringify(row)).toBe(before)
  })

  it("passes non-object values through", () => {
    expect(stripProviderSecrets(null)).toBeNull()
    expect(stripProviderSecrets("x")).toBe("x")
  })
})

describe("stripProviderCollectionSecrets", () => {
  it("strips every row of a map and of a list", () => {
    expect(JSON.stringify(stripProviderCollectionSecrets({ a: fullRow() }))).not.toContain(SECRET)
    expect(JSON.stringify(stripProviderCollectionSecrets([fullRow()]))).not.toContain(SECRET)
  })
})

describe("isCredentialHeaderName", () => {
  it.each(["Authorization", "x-api-key", "X-Goog-Api-Key", "x-auth-token", "Cookie"])(
    "treats %s as a credential header",
    (name) => expect(isCredentialHeaderName(name)).toBe(true)
  )
  it.each(["x-tenant-id", "anthropic-version", "HTTP-Referer"])("keeps %s as metadata", (name) =>
    expect(isCredentialHeaderName(name)).toBe(false)
  )
})
