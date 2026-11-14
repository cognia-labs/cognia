import {
  buildProviderVerificationFingerprint,
  customProviderAllowsKeyless,
  evaluateBuiltInProviderCompleteness,
  evaluateCustomProviderCompleteness,
  evaluateRuntimeEligibility,
  getActiveCredential,
  getProviderRequirements,
  hasAnyCredential,
  isValidHttpUrl,
  upgradeLegacyVerificationFingerprint,
} from "./completeness"

describe("provider completeness contract", () => {
  it("resolves active credentials from explicit keys and key pools", () => {
    expect(getActiveCredential({ apiKey: "  sk-direct  " })).toBe("sk-direct")
    expect(getActiveCredential({ apiKeys: ["", " sk-pool "], currentKeyIndex: 1 })).toBe("sk-pool")
    expect(getActiveCredential()).toBe("")
    expect(getActiveCredential({ apiKeys: [], currentKeyIndex: 0 })).toBe("")
    expect(getActiveCredential({ apiKeys: [" ", " sk-fallback "], currentKeyIndex: 0 })).toBe(
      "sk-fallback"
    )
    expect(getActiveCredential({ apiKeys: [" sk-first "], currentKeyIndex: 5 })).toBe("sk-first")
    expect(hasAnyCredential()).toBe(false)
    expect(hasAnyCredential({ apiKeys: undefined })).toBe(false)
    expect(hasAnyCredential({ apiKeys: [" ", "sk-pool"] })).toBe(true)
    expect(hasAnyCredential({ apiKeys: [" "] })).toBe(false)
  })

  it("validates only http and https base URLs", () => {
    expect(isValidHttpUrl("https://api.example.com/v1")).toBe(true)
    expect(isValidHttpUrl("http://localhost:11434")).toBe(true)
    expect(isValidHttpUrl()).toBe(false)
    expect(isValidHttpUrl("   ")).toBe(false)
    expect(isValidHttpUrl("ftp://example.com")).toBe(false)
    expect(isValidHttpUrl("not a url")).toBe(false)
  })

  it("builds stable fingerprints from trimmed optional settings", () => {
    expect(buildProviderVerificationFingerprint({ apiKey: " sk-direct " })).toBe(
      buildProviderVerificationFingerprint({ apiKey: "sk-direct" })
    )

    const fingerprint = JSON.parse(
      buildProviderVerificationFingerprint({
        apiKey: " sk-direct ",
        apiKeys: [" key-a ", " key-b "],
        baseURL: " https://api.example.com/v1 ",
        defaultModel: " gpt-4o ",
      })
    )

    expect(fingerprint).toMatchObject({
      currentKeyIndex: 0,
      baseURL: "https://api.example.com/v1",
      defaultModel: "gpt-4o",
    })
  })

  // The fingerprint is persisted beside the row and travels with exports and
  // backups; it must never be a second plaintext copy of a credential.
  it("never embeds credential material", () => {
    const serialized = buildProviderVerificationFingerprint({
      apiKey: "sk-synthetic-direct",
      apiKeys: ["sk-synthetic-pool"],
      customHeaders: { Authorization: "Bearer sk-synthetic-header" },
      bedrock: {
        authMode: "iam",
        region: "us-east-1",
        accessKeyId: "AKIASYNTHETIC",
        secretAccessKey: "synthetic-secret",
        sessionToken: "synthetic-session",
      },
    })
    for (const secret of [
      "sk-synthetic-direct",
      "sk-synthetic-pool",
      "sk-synthetic-header",
      "AKIASYNTHETIC",
      "synthetic-secret",
      "synthetic-session",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("changes with every credential and connection identity field", () => {
    const base = {
      apiKey: "k",
      baseURL: "https://api.example.com/v1",
      defaultModel: "m",
      apiFlavor: "chat",
      customHeaders: { "x-tenant-id": "a" },
      bedrock: {
        authMode: "iam",
        region: "us-east-1",
        accessKeyId: "id",
        secretAccessKey: "s",
        profile: "p",
        roleArn: "r",
      },
    }
    const fingerprint = buildProviderVerificationFingerprint(base)
    const variants = [
      { ...base, apiKey: "k2" },
      { ...base, apiFlavor: "responses" },
      { ...base, customHeaders: { "x-tenant-id": "b" } },
      { ...base, bedrock: { ...base.bedrock, region: "eu-west-1" } },
      { ...base, bedrock: { ...base.bedrock, secretAccessKey: "s2" } },
      { ...base, bedrock: { ...base.bedrock, accessKeyId: "id2" } },
      { ...base, bedrock: { ...base.bedrock, profile: "p2" } },
      { ...base, bedrock: { ...base.bedrock, roleArn: "r2" } },
    ]
    for (const variant of variants) {
      expect(buildProviderVerificationFingerprint(variant)).not.toBe(fingerprint)
    }
  })

  it("treats a verified row without a fingerprint as stale", () => {
    expect(
      evaluateBuiltInProviderCompleteness("ollama", {
        providerId: "ollama",
        enabled: true,
        defaultModel: "llama",
        baseURL: "http://localhost:11434",
        verificationStatus: "verified",
      }).verificationStatus
    ).toBe("stale")
  })

  it("rewrites a v2 fingerprint and recognises when it no longer matches", () => {
    const row = { apiKey: "sk-old", baseURL: "https://x/v1", defaultModel: "m" }
    const v2 = JSON.stringify({
      verificationContract: "provider-connectivity-v2",
      apiKey: "sk-old",
      apiKeys: [],
      currentKeyIndex: 0,
      baseURL: "https://x/v1",
      defaultModel: "m",
      apiProtocol: "",
      customHeaders: [],
    })
    expect(upgradeLegacyVerificationFingerprint({ ...row, verificationFingerprint: v2 })).toBe(
      buildProviderVerificationFingerprint(row)
    )
    const mismatch = upgradeLegacyVerificationFingerprint({
      ...row,
      apiKey: "sk-new",
      verificationFingerprint: v2,
    })
    expect(mismatch).not.toContain("sk-old")
    expect(mismatch).not.toBe(buildProviderVerificationFingerprint({ ...row, apiKey: "sk-new" }))
    expect(
      upgradeLegacyVerificationFingerprint({
        ...row,
        verificationFingerprint: buildProviderVerificationFingerprint(row),
      })
    ).toBeUndefined()
    expect(upgradeLegacyVerificationFingerprint(row)).toBeUndefined()
  })

  it("infers requirements for catalog, local, and unknown providers", () => {
    expect(getProviderRequirements("openai")).toMatchObject({
      providerId: "openai",
      requiresCredential: true,
      isLocal: false,
    })
    expect(getProviderRequirements("ollama")).toMatchObject({
      providerId: "ollama",
      requiresCredential: false,
      isLocal: true,
    })
    expect(getProviderRequirements("missing-provider")).toMatchObject({
      providerId: "missing-provider",
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    })
  })

  it("marks a verified built-in provider complete when its fingerprint matches", () => {
    const settings = {
      enabled: true,
      apiKey: "sk-test",
      defaultModel: "gpt-4o",
    }
    const verificationFingerprint = buildProviderVerificationFingerprint(settings)

    const result = evaluateBuiltInProviderCompleteness("openai", {
      ...settings,
      verificationStatus: "verified",
      verificationFingerprint,
    })

    expect(result.readiness).toBe("verified")
    expect(result.eligibility.testConnection.allowed).toBe(true)
    expect(result.setupChecklist.isComplete).toBe(true)
  })

  it("marks persisted verification stale when settings change or latest verification fails", () => {
    const previousFingerprint = buildProviderVerificationFingerprint({
      apiKey: "sk-old",
      defaultModel: "gpt-4o",
    })

    const changedSettings = evaluateBuiltInProviderCompleteness("openai", {
      enabled: true,
      apiKey: "sk-new",
      defaultModel: "gpt-4o",
      verificationStatus: "verified",
      verificationFingerprint: previousFingerprint,
    })
    expect(changedSettings.verificationStatus).toBe("stale")
    expect(changedSettings.setupChecklist.steps.at(-1)).toMatchObject({
      id: "verification",
      reason: "Provider configuration changed. Re-run verification.",
    })

    const failedLatest = evaluateBuiltInProviderCompleteness(
      "openai",
      {
        enabled: true,
        apiKey: "sk-test",
        defaultModel: "gpt-4o",
        verificationStatus: "verified",
      },
      { success: false }
    )
    expect(failedLatest.verificationStatus).toBe("stale")

    const staleLatest = evaluateBuiltInProviderCompleteness(
      "openai",
      {
        enabled: true,
        apiKey: "sk-test",
        defaultModel: "gpt-4o",
        verificationStatus: "stale",
      },
      { success: false }
    )
    expect(staleLatest.verificationStatus).toBe("stale")
  })

  it("keeps limited or non-authoritative latest results from marking providers verified", () => {
    const limited = evaluateBuiltInProviderCompleteness(
      "openai",
      { enabled: true, apiKey: "sk-test", defaultModel: "gpt-4o" },
      { success: true, outcome: "limited" }
    )
    expect(limited.verificationStatus).toBe("unverified")
    expect(limited.readiness).toBe("configured")

    const nonAuthoritative = evaluateBuiltInProviderCompleteness(
      "openai",
      { enabled: true, apiKey: "sk-test", defaultModel: "gpt-4o" },
      { success: true, authoritative: false }
    )
    expect(nonAuthoritative.verificationStatus).toBe("unverified")
  })

  it("blocks incomplete built-in and custom providers with actionable guards", () => {
    const builtIn = evaluateBuiltInProviderCompleteness("openai", { enabled: true })
    expect(builtIn.readiness).toBe("unconfigured")
    expect(builtIn.eligibility.testConnection).toMatchObject({
      allowed: false,
      nextAction: "add_api_key",
    })

    const custom = evaluateCustomProviderCompleteness({
      apiKey: "sk-test",
      baseURL: "ftp://invalid.example",
      enabled: true,
      defaultModel: "model-a",
    })
    expect(custom.eligibility.runtime).toMatchObject({
      allowed: false,
      nextAction: "configure_base_url",
    })
  })

  it("guards built-in providers that require explicit valid base URLs", () => {
    const missingBaseUrl = evaluateBuiltInProviderCompleteness("missing-provider", {
      enabled: true,
      apiKey: "sk-test",
      defaultModel: "model-a",
    })
    expect(missingBaseUrl.eligibility.enable).toMatchObject({
      code: "missing_base_url",
      nextAction: "configure_base_url",
    })
    expect(missingBaseUrl.eligibility.runtime).toMatchObject({
      code: "missing_base_url",
      nextAction: "configure_base_url",
    })

    const invalidBaseUrl = evaluateBuiltInProviderCompleteness("missing-provider", {
      enabled: true,
      apiKey: "sk-test",
      baseURL: "notaurl",
      defaultModel: "model-a",
    })
    expect(invalidBaseUrl.eligibility.testConnection).toMatchObject({
      code: "invalid_base_url",
      nextAction: "configure_base_url",
    })
    expect(invalidBaseUrl.eligibility.runtime).toMatchObject({
      code: "invalid_base_url",
      nextAction: "configure_base_url",
    })
    expect(
      invalidBaseUrl.setupChecklist.steps.find((step) => step.id === "base_url")
    ).toMatchObject({
      done: false,
      reason: "Configure a valid base URL before testing this provider.",
    })
  })

  it("covers custom provider setup, disabled runtime, and verification states", () => {
    expect(evaluateCustomProviderCompleteness(undefined).eligibility.enable).toMatchObject({
      code: "missing_credential",
    })

    const missingBaseUrl = evaluateCustomProviderCompleteness({
      apiKey: "sk-test",
      defaultModel: "model-a",
    })
    expect(missingBaseUrl.eligibility.enable).toMatchObject({ code: "missing_base_url" })
    expect(missingBaseUrl.eligibility.runtime).toMatchObject({ code: "missing_base_url" })

    const disabledVerified = evaluateCustomProviderCompleteness(
      {
        apiKey: "sk-test",
        baseURL: "https://custom.example/v1",
        defaultModel: "model-a",
        enabled: false,
      },
      { success: true }
    )
    expect(disabledVerified.readiness).toBe("verified")
    expect(disabledVerified.eligibility.runtime).toMatchObject({ code: "provider_disabled" })
    expect(disabledVerified.setupChecklist.isComplete).toBe(true)

    const configured = evaluateCustomProviderCompleteness({
      apiKey: "sk-test",
      baseURL: "https://custom.example/v1",
      defaultModel: "model-a",
    })
    expect(configured.readiness).toBe("configured")
    expect(configured.eligibility.enable.allowed).toBe(true)
  })

  it("exposes runtime eligibility as the built-in runtime guard", () => {
    expect(
      evaluateRuntimeEligibility("openai", { enabled: false, apiKey: "sk-test" })
    ).toMatchObject({
      allowed: false,
      code: "provider_disabled",
    })
  })
})

it("reads registered subscription defaults and requirements from the dynamic catalog", async () => {
  const { registerProviderDefinition, unregisterProvider } = await import("./provider-loader")
  registerProviderDefinition(
    {
      id: "example:api",
      name: "Example",
      type: "cloud",
      protocol: "anthropic",
      defaultBaseURL: "https://example.test/v1",
      apiKeyRequired: true,
      baseURLRequired: false,
      defaultModel: "model-a",
      defaultEnabled: false,
      category: "specialized",
      models: [],
    },
    "plugin"
  )
  try {
    expect(getProviderRequirements("example:api")).toMatchObject({ requiresCredential: true })
    expect(
      evaluateBuiltInProviderCompleteness("example:api", {
        providerId: "example:api",
        enabled: true,
        apiKey: "subscription:test",
      }).eligibility.runtime.allowed
    ).toBe(true)
  } finally {
    unregisterProvider("example:api")
  }
})

it("invalidates verification on protocol/header changes but ignores header insertion order", () => {
  const cfg = {
    apiKey: "key",
    baseURL: "https://example.test/v1",
    apiProtocol: "openai",
    customHeaders: { "X-A": "1", "X-B": "2" },
  }
  const fingerprint = buildProviderVerificationFingerprint(cfg)
  expect(
    buildProviderVerificationFingerprint({ ...cfg, customHeaders: { "X-B": "2", "X-A": "1" } })
  ).toBe(fingerprint)
  expect(buildProviderVerificationFingerprint({ ...cfg, apiProtocol: "anthropic" })).not.toBe(
    fingerprint
  )
  expect(
    buildProviderVerificationFingerprint({ ...cfg, customHeaders: { "X-A": "other" } })
  ).not.toBe(fingerprint)
})

describe("keyless custom providers", () => {
  const row = (baseURL: string, extra: Record<string, unknown> = {}) => ({
    id: "custom-x",
    providerId: "custom-x",
    enabled: true,
    baseURL,
    defaultModel: "m",
    ...extra,
  })

  it.each([
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://192.168.1.20:11434",
    "http://10.0.0.5/v1",
    "http://engine.local:8000/v1",
  ])("allows a keyless private endpoint %s", (baseURL) => {
    const result = evaluateCustomProviderCompleteness(row(baseURL))
    expect(result.eligibility.enable.allowed).toBe(true)
    expect(result.eligibility.testConnection.allowed).toBe(true)
    expect(result.eligibility.runtime.allowed).toBe(true)
  })

  it("allows a header-authenticated public relay", () => {
    expect(
      evaluateCustomProviderCompleteness(
        row("https://relay.example/v1", { customHeaders: { Authorization: "Bearer x" } })
      ).eligibility.runtime.allowed
    ).toBe(true)
  })

  it("accepts a key pool as the credential", () => {
    expect(
      evaluateCustomProviderCompleteness(row("https://relay.example/v1", { apiKeys: ["k"] }))
        .eligibility.runtime.allowed
    ).toBe(true)
  })

  it("still requires a credential for a public endpoint", () => {
    const result = evaluateCustomProviderCompleteness(row("https://relay.example/v1"))
    expect(result.eligibility.runtime).toMatchObject({ allowed: false, code: "missing_credential" })
    expect(customProviderAllowsKeyless({ baseURL: "https://relay.example/v1" })).toBe(false)
    expect(
      customProviderAllowsKeyless({
        baseURL: "https://relay.example/v1",
        customHeaders: { "x-tenant-id": "acme" },
      })
    ).toBe(false)
  })
})
