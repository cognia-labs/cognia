import {
  exportSettingsProfile,
  serializeSettingsProfile,
  importSettingsProfile,
  buildResetPatch,
  deepStripSecrets,
  holdsSecret,
  stripSettingsRowSecrets,
  SETTINGS_PROFILE_SCHEMA,
  SETTINGS_PROFILE_VERSION,
} from "./profile-transfer"
import { DEFAULTS } from "@/lib/db/settings"
import type { AppSettings } from "@cognia/agent-config-types"
import { freshInstallWebReader } from "@/lib/web/reader/reader-settings"
import { globalResetKeys, resetKeysForSection } from "./section-keys"

const NOW = "2026-06-15T00:00:00.000Z"

it("strips HTTP credentials in object and JSON headers while preserving required empty reference arrays", () => {
  expect(
    deepStripSecrets({
      headers: { Authorization: "Bearer token", Cookie: "session=secret", Accept: "text/plain" },
      headersJson: JSON.stringify({ Authorization: "Bearer token", Accept: "text/plain" }),
      secretRefs: [],
      credentials: [],
    })
  ).toEqual({
    headers: { Accept: "text/plain" },
    headersJson: JSON.stringify({ Accept: "text/plain" }),
    secretRefs: [],
    credentials: [],
  })
})

function sampleSettings(): AppSettings {
  return {
    ...DEFAULTS,
    apiKey: "sk-ant-secret",
    apiBaseUrl: "https://proxy.example/key123",
    skillsShToken: "oidc-secret",
    installUuid: "install-123",
    updatedAt: 1234,
    theme: "dark",
    language: "zh-CN",
    providerSettings: {
      openai: { apiKey: "sk-openai", baseURL: "https://api.openai.com", enabled: true } as never,
    },
    customProviders: [
      { id: "x", customName: "X", baseURL: "https://x", apiKey: "secret", enabled: true } as never,
    ],
    webdavSync: {
      enabled: true,
      baseUrl: "https://dav",
      username: "u",
      rememberPassphrase: true,
    } as never,
    biometricRequiredFor: {
      deletePairing: false,
      exportBackup: true,
      revealSecrets: true,
      signOut: false,
    },
  }
}

describe("profile-transfer export", () => {
  it("keeps provider rotation policy but excludes credentials and host-local endpoints", () => {
    const settings = {
      ...DEFAULTS,
      searchProviders: {
        ...DEFAULTS.searchProviders!,
        searxng: {
          providerId: "searxng" as const,
          enabled: true,
          priority: 0,
          apiKey: "secret",
          apiKeys: ["secret2"],
          cx: "account",
          baseUrl: "https://private.example",
          allowPrivateEndpoint: true,
          apiKeyRotationStrategy: "round-robin" as const,
          engine: "google",
        },
      },
    }
    const provider = exportSettingsProfile(settings, NOW).settings.searchProviders!.searxng
    expect(provider).toEqual({
      providerId: "searxng",
      enabled: true,
      priority: 0,
      apiKeyRotationStrategy: "round-robin",
      engine: "google",
    })
  })
  it("strips top-level secret and identity keys", () => {
    const profile = exportSettingsProfile(sampleSettings(), NOW)
    expect(profile.schema).toBe(SETTINGS_PROFILE_SCHEMA)
    expect(profile.version).toBe(SETTINGS_PROFILE_VERSION)
    expect(profile.exportedAt).toBe(NOW)
    const s = profile.settings as Record<string, unknown>
    expect(s.apiKey).toBeUndefined()
    expect(s.apiBaseUrl).toBeUndefined()
    expect(s.skillsShToken).toBeUndefined()
    expect(s.id).toBeUndefined()
    expect(s.updatedAt).toBeUndefined()
    expect(s.installUuid).toBeUndefined()
  })

  it("keeps non-secret preferences", () => {
    const s = exportSettingsProfile(sampleSettings(), NOW).settings
    expect(s.theme).toBe("dark")
    expect(s.language).toBe("zh-CN")
    expect(s.biometricRequiredFor).toEqual({
      deletePairing: false,
      exportBackup: true,
      revealSecrets: true,
      signOut: false,
    })
  })

  it("recursively scrubs nested secrets (webdav)", () => {
    const s = exportSettingsProfile(sampleSettings(), NOW).settings as Record<string, never>
    const webdav = s.webdavSync as Record<string, unknown>
    expect(webdav.rememberPassphrase).toBe(true) // boolean flag, not a secret → kept
    expect(webdav.baseUrl).toBe("https://dav")
  })

  // Provider connections travel through the dedicated Provider export, which
  // keeps destination keys on import; a preferences profile never could
  // restore them, so it no longer writes them either.
  it("leaves provider connections to the Provider export", () => {
    const s = exportSettingsProfile(sampleSettings(), NOW).settings as Record<string, unknown>
    expect(s.providerSettings).toBeUndefined()
    expect(s.customProviders).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain("sk-openai")
  })

  it("serializes to valid JSON", () => {
    const json = serializeSettingsProfile(exportSettingsProfile(sampleSettings(), NOW))
    expect(() => JSON.parse(json)).not.toThrow()
    expect(JSON.parse(json).schema).toBe(SETTINGS_PROFILE_SCHEMA)
  })
})

describe("profile-transfer import", () => {
  it("does not infer a reader profile when an import lacks one", () => {
    const result = importSettingsProfile({
      schema: SETTINGS_PROFILE_SCHEMA,
      version: 1,
      settings: { theme: "dark" },
    })
    expect(result.ok && Object.hasOwn(result.patch, "webReader")).toBe(false)
  })

  it("strips host-local provider fields even from hand-edited imports", () => {
    const result = importSettingsProfile({
      schema: SETTINGS_PROFILE_SCHEMA,
      version: 1,
      settings: {
        searchProviders: {
          searxng: {
            enabled: true,
            apiKey: "remote",
            apiKeys: ["remote"],
            cx: "remote",
            baseUrl: "https://remote.example",
            allowPrivateEndpoint: true,
            apiKeyRotationStrategy: "round-robin",
          },
        },
      },
    })
    expect(result.ok && result.patch.searchProviders?.searxng).toEqual({
      enabled: true,
      apiKeyRotationStrategy: "round-robin",
    })
  })
  function validJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schema: SETTINGS_PROFILE_SCHEMA,
      version: 1,
      exportedAt: NOW,
      settings: { theme: "dark", language: "en", ...overrides },
    })
  }

  it("rejects malformed JSON", () => {
    expect(importSettingsProfile("{not json")).toEqual({ ok: false, errorKey: "invalidJson" })
  })

  it("rejects the wrong schema", () => {
    const r = importSettingsProfile(JSON.stringify({ schema: "other", version: 1, settings: {} }))
    expect(r).toEqual({ ok: false, errorKey: "wrongSchema" })
  })

  it("rejects a missing version", () => {
    const r = importSettingsProfile(
      JSON.stringify({ schema: SETTINGS_PROFILE_SCHEMA, settings: {} })
    )
    expect(r).toEqual({ ok: false, errorKey: "missingVersion" })
  })

  it("rejects a version newer than supported", () => {
    const r = importSettingsProfile(
      JSON.stringify({ schema: SETTINGS_PROFILE_SCHEMA, version: 999, settings: { theme: "dark" } })
    )
    expect(r).toEqual({ ok: false, errorKey: "versionTooNew" })
  })

  it("accepts a valid profile and returns a patch", () => {
    const r = importSettingsProfile(validJson())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch.theme).toBe("dark")
      expect(r.patch.language).toBe("en")
    }
  })

  it("drops unknown and secret keys from the patch", () => {
    const r = importSettingsProfile(
      validJson({ apiKey: "smuggled", notARealKey: 1, skillsShToken: "x" })
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect("apiKey" in r.patch).toBe(false)
      expect("skillsShToken" in r.patch).toBe(false)
      expect("notARealKey" in r.patch).toBe(false)
    }
  })

  it("rejects an effectively empty profile", () => {
    const r = importSettingsProfile(validJson2())
    expect(r).toEqual({ ok: false, errorKey: "emptyProfile" })
  })

  function validJson2(): string {
    return JSON.stringify({
      schema: SETTINGS_PROFILE_SCHEMA,
      version: 1,
      settings: { apiKey: "only-a-secret" },
    })
  }

  it("round-trips export → import", () => {
    const profile = exportSettingsProfile(sampleSettings(), NOW)
    const r = importSettingsProfile(serializeSettingsProfile(profile))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch.theme).toBe("dark")
  })

  it("takes back an optional override it exported, such as the color preset", () => {
    // Import accepted only keys with a default, so an exported Ocean preset was
    // dropped on the way back in.
    const profile = exportSettingsProfile({ ...sampleSettings(), colorTheme: "ocean" }, NOW)
    const r = importSettingsProfile(serializeSettingsProfile(profile))
    expect(r.ok && r.patch.colorTheme).toBe("ocean")
    expect(r.ok && r.skipped).toEqual([])
  })

  it("skips a value its key cannot hold and names it, saving the rest", () => {
    const r = importSettingsProfile(
      validJson({
        theme: "neon",
        fontScale: 3,
        colorTheme: "plaid",
        permissionMode: "root",
        language: "zh-CN",
        biometricRequiredFor: "yes",
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch).toEqual({ language: "zh-CN" })
    expect(r.skipped.sort()).toEqual(
      ["biometricRequiredFor", "colorTheme", "fontScale", "permissionMode", "theme"].sort()
    )
  })

  it("names unknown keys as skipped, but never the secrets it drops by design", () => {
    const r = importSettingsProfile(validJson({ notARealKey: 1, apiKey: "smuggled" }))
    expect(r.ok && r.skipped).toEqual(["notARealKey"])
  })
})

describe("profile-transfer reset", () => {
  it("resets the search section to the fresh reader recipient policy", () => {
    const patch = buildResetPatch(resetKeysForSection("search")!)
    expect(patch.webReader).toEqual(freshInstallWebReader())
  })
  // Section → owned keys now lives in `section-keys.ts` (tested there). This
  // suite covers the reset-patch shape only.
  it("buildResetPatch(keys) returns only those keys at default", () => {
    const patch = buildResetPatch(["biometricRequiredFor"])
    expect(Object.keys(patch)).toEqual(["biometricRequiredFor"])
    expect(patch.biometricRequiredFor).toEqual(DEFAULTS.biometricRequiredFor)
  })

  it("a global reset resets all preferences but keeps secrets/identity", () => {
    const patch = buildResetPatch(globalResetKeys()) as Record<string, unknown>
    expect("apiKey" in patch).toBe(false)
    expect("apiBaseUrl" in patch).toBe(false)
    expect("id" in patch).toBe(false)
    expect("installUuid" in patch).toBe(false)
    expect(patch.theme).toBe(DEFAULTS.theme)
  })

  it("a global reset clears what a section reset clears, the color preset included", () => {
    // It walked `DEFAULTS`, which has no `colorTheme`, so Ocean survived
    // "Reset all" while the appearance section's reset cleared it.
    const patch = buildResetPatch(globalResetKeys(), {
      keepCredentialsOf: { ...DEFAULTS, colorTheme: "ocean" },
    })
    expect(Object.hasOwn(patch, "colorTheme")).toBe(true)
    expect(patch.colorTheme).toBeUndefined()
    for (const key of resetKeysForSection("appearance")!)
      expect(Object.hasOwn(patch, key)).toBe(true)
  })

  it("a global reset leaves UI-local state and provider connections alone", () => {
    const keys = globalResetKeys()
    for (const key of [
      "onboardingProgress",
      "activeProviderId",
      "pinnedWorkflowIds",
      "providerSettings",
      "customProviders",
    ] as const)
      expect(keys).not.toContain(key)
  })

  it("keeps search provider keys and endpoints while resetting their preferences", () => {
    // The default Tavily entry carries `apiKey: ""`, so "Reset all" emptied the
    // stored key its confirmation promised to keep.
    const current = {
      ...DEFAULTS,
      searchProviders: {
        ...DEFAULTS.searchProviders!,
        tavily: {
          ...DEFAULTS.searchProviders!.tavily,
          apiKey: "tvly-synthetic",
          apiKeys: ["tvly-second"],
          enabled: true,
          priority: 99,
        },
      },
    } as AppSettings
    const patch = buildResetPatch(["searchProviders"], { keepCredentialsOf: current })
    const tavily = (patch.searchProviders as unknown as Record<string, Record<string, unknown>>)
      .tavily!
    expect(tavily.apiKey).toBe("tvly-synthetic")
    expect(tavily.apiKeys).toEqual(["tvly-second"])
    expect(tavily.priority).toBe(
      (DEFAULTS.searchProviders!.tavily as unknown as Record<string, unknown>).priority
    )
  })

  it("leaves out a key whose value holds a credential when keeping them", () => {
    const patch = buildResetPatch(["webdavSync", "theme"], {
      keepCredentialsOf: {
        theme: "dark",
        webdavSync: { enabled: true, baseUrl: "https://dav", password: "pw" } as never,
      },
    })
    expect(patch).toEqual({ theme: DEFAULTS.theme })
  })
})

describe("holdsSecret", () => {
  it("sees a non-empty credential at any depth, not an empty placeholder", () => {
    expect(holdsSecret({ a: { apiKey: "x" } })).toBe(true)
    expect(holdsSecret({ a: { apiKey: "", tokens: [] } })).toBe(false)
    expect(holdsSecret({ headersJson: JSON.stringify({ authorization: "Bearer t" }) })).toBe(true)
    expect(holdsSecret({ rememberPassphrase: true })).toBe(false)
  })
})

describe("stripSettingsRowSecrets (full backup without keys)", () => {
  const SECRET = "sk-synthetic-backup"
  const row = {
    ...DEFAULTS,
    apiKey: SECRET,
    providerSettings: {
      openrouter: {
        providerId: "openrouter",
        enabled: true,
        defaultModel: "m",
        apiKey: SECRET,
        apiKeyUsageStats: { [SECRET]: { usageCount: 1, lastUsed: 1, errorCount: 0 } },
        verificationFingerprint: JSON.stringify({ apiKey: SECRET }),
        customHeaders: { Authorization: `Bearer ${SECRET}`, "x-tenant-id": "acme" },
        openRouterSettings: {
          byokKeys: [{ id: "b", provider: "openai", config: JSON.stringify({ k: SECRET }) }],
        },
        cliProxyAPISettings: { managementKey: SECRET },
      },
    },
    customProviders: [
      { id: "x", customName: "X", baseURL: "https://x", apiKey: SECRET, enabled: true },
    ],
  } as unknown as AppSettings

  it("removes credentials a key-name scrub cannot see", () => {
    expect(JSON.stringify(stripSettingsRowSecrets(row))).not.toContain(SECRET)
  })

  it("keeps the provider connection metadata", () => {
    const stripped = stripSettingsRowSecrets(row)
    expect(stripped.providerSettings?.openrouter?.customHeaders).toEqual({ "x-tenant-id": "acme" })
    expect(stripped.customProviders?.[0]).toMatchObject({ customName: "X", baseURL: "https://x" })
  })
})

it("drops a CLIProxyAPI management key in the generic scrub", () => {
  expect(deepStripSecrets({ managementKey: "m" })).toEqual({})
})
