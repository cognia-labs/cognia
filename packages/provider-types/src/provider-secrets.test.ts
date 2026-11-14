import {
  isCredentialHeaderName,
  joinProviderSecrets,
  splitProviderSecrets,
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

describe("splitProviderSecrets", () => {
  it("leaves no credential in the public half", () => {
    // A pre-v3 fingerprint embeds the key; the settings layer upgrades it
    // before splitting (lib/settings/provider-secret-split.ts).
    const { verificationFingerprint: _legacy, ...row } = fullRow()
    const { publicRow } = splitProviderSecrets(row)
    const text = JSON.stringify(publicRow)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("AKIASYNTHETIC")
  })

  it("keeps verification state, the key index and the fingerprint in the public half", () => {
    const { publicRow } = splitProviderSecrets({
      verificationStatus: "verified",
      verificationFingerprint: '{"verificationContract":3}',
      lastVerifiedAt: 5,
      currentKeyIndex: 2,
      apiKey: SECRET,
    }) as { publicRow: Record<string, unknown> }
    expect(publicRow).toEqual({
      verificationStatus: "verified",
      verificationFingerprint: '{"verificationContract":3}',
      lastVerifiedAt: 5,
      currentKeyIndex: 2,
    })
  })

  it("round-trips: join(split(row)) equals the row", () => {
    const row = {
      ...fullRow(),
      advancedParams: {
        nested: [{ secret_value: SECRET, keep: 1 }, { flag: true }],
        password: { inner: SECRET },
        tokenizer_enabled: true,
      },
    }
    const { publicRow, secrets } = splitProviderSecrets(row)
    expect(secrets.length).toBeGreaterThan(0)
    expect(joinProviderSecrets(publicRow, secrets)).toEqual(row)
  })

  it("records nothing for a row without credentials", () => {
    const row = { providerId: "ollama", baseURL: "http://localhost:11434", enabled: true }
    const { publicRow, secrets } = splitProviderSecrets(row)
    expect(secrets).toEqual([])
    expect(publicRow).toEqual(row)
    expect(joinProviderSecrets(publicRow, secrets)).toBe(publicRow)
  })

  it("never mutates its input, and join never mutates the public row", () => {
    const row = fullRow()
    const before = JSON.stringify(row)
    const { publicRow, secrets } = splitProviderSecrets(row)
    expect(JSON.stringify(row)).toBe(before)
    const publicBefore = JSON.stringify(publicRow)
    joinProviderSecrets(publicRow, secrets)
    expect(JSON.stringify(publicRow)).toBe(publicBefore)
  })

  it("recreates a container the public row no longer has", () => {
    const joined = joinProviderSecrets({ id: "x" } as Record<string, unknown>, [
      { path: ["bedrock", "secretAccessKey"], value: SECRET },
      { path: ["advancedParams", "list", 0, "token"], value: SECRET },
    ])
    expect(joined).toEqual({
      id: "x",
      bedrock: { secretAccessKey: SECRET },
      advancedParams: { list: [{ token: SECRET }] },
    })
  })
})
