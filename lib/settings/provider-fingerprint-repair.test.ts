import type { AppSettings } from "@cognia/agent-config-types"
import { buildProviderVerificationFingerprint } from "@cognia/provider-core/providers/completeness"
import { repairLegacyProviderFingerprints } from "./provider-fingerprint-repair"

const KEY = "sk-synthetic-legacy"

/** The v2 layout older builds persisted (raw key inside). */
function legacyFingerprint(row: { apiKey?: string; baseURL?: string; defaultModel?: string }) {
  return JSON.stringify({
    verificationContract: "provider-connectivity-v2",
    apiKey: row.apiKey ?? "",
    apiKeys: [],
    currentKeyIndex: 0,
    baseURL: row.baseURL ?? "",
    defaultModel: row.defaultModel ?? "",
    apiProtocol: "",
    customHeaders: [],
  })
}

function settingsWith(
  providerSettings: AppSettings["providerSettings"],
  customProviders?: AppSettings["customProviders"]
) {
  return { providerSettings, customProviders } as AppSettings
}

describe("repairLegacyProviderFingerprints", () => {
  it("rewrites a matching v2 fingerprint into the credential-free v3 one", () => {
    const row = {
      providerId: "openai",
      enabled: true,
      defaultModel: "gpt",
      apiKey: KEY,
      verificationStatus: "verified" as const,
    }
    const patch = repairLegacyProviderFingerprints(
      settingsWith({ openai: { ...row, verificationFingerprint: legacyFingerprint(row) } })
    )
    const repaired = patch?.providerSettings?.openai
    expect(repaired?.verificationFingerprint).toBe(buildProviderVerificationFingerprint(row))
    expect(repaired?.verificationFingerprint).not.toContain(KEY)
  })

  it("turns a stale v2 fingerprint into a marker that keeps the row stale", () => {
    const row = { providerId: "openai", enabled: true, defaultModel: "gpt", apiKey: KEY }
    const patch = repairLegacyProviderFingerprints(
      settingsWith({
        openai: {
          ...row,
          verificationStatus: "verified",
          verificationFingerprint: legacyFingerprint({ ...row, apiKey: "old-key" }),
        },
      })
    )
    const fingerprint = patch?.providerSettings?.openai?.verificationFingerprint
    expect(fingerprint).not.toContain("old-key")
    expect(fingerprint).not.toBe(buildProviderVerificationFingerprint(row))
  })

  it("repairs custom provider rows", () => {
    const row = {
      id: "custom-a",
      providerId: "custom-a",
      isCustom: true as const,
      enabled: true,
      defaultModel: "m",
      apiKey: KEY,
      baseURL: "https://gw.example/v1",
      apiProtocol: "openai" as const,
      customName: "A",
      name: "A",
      customModels: ["m"],
      models: ["m"],
    }
    const patch = repairLegacyProviderFingerprints(
      settingsWith(undefined, [{ ...row, verificationFingerprint: legacyFingerprint(row) }])
    )
    expect(patch?.customProviders?.[0].verificationFingerprint).not.toContain(KEY)
  })

  it("returns null when nothing is legacy", () => {
    const row = { providerId: "openai", enabled: true, defaultModel: "gpt", apiKey: KEY }
    expect(
      repairLegacyProviderFingerprints(
        settingsWith({
          openai: { ...row, verificationFingerprint: buildProviderVerificationFingerprint(row) },
        })
      )
    ).toBeNull()
    expect(repairLegacyProviderFingerprints(settingsWith(undefined))).toBeNull()
  })
})
