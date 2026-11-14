import type { AppSettings } from "@cognia/agent-config-types"

import {
  emptySecretSet,
  isEmptySecretSet,
  joinSettingsSecrets,
  overlaySecretSets,
  secretSetsEqual,
  splitSettingsSecrets,
} from "./provider-secret-split"

const SECRET = "sk-synthetic-settings-secret"

function settingsWithKeys(): Partial<AppSettings> {
  return {
    theme: "dark",
    apiKey: `${SECRET}-top`,
    providerSettings: {
      openai: {
        providerId: "openai",
        enabled: true,
        apiKey: SECRET,
        oauthRefreshToken: `${SECRET}-refresh`,
        openRouterSettings: { provisioningApiKey: SECRET, siteName: "Cognia" },
        cliProxyAPISettings: { host: "127.0.0.1", managementKey: SECRET },
      },
      ollama: { providerId: "ollama", enabled: true, baseURL: "http://localhost:11434" },
    } as unknown as AppSettings["providerSettings"],
    customProviders: [
      { id: "relay", providerName: "Relay", apiKey: `${SECRET}-relay` },
      { providerName: "No id", apiKey: `${SECRET}-anon` },
    ] as unknown as AppSettings["customProviders"],
  }
}

describe("splitSettingsSecrets", () => {
  it("removes every provider credential and the legacy top-level key", () => {
    const { publicRow, secrets } = splitSettingsSecrets(settingsWithKeys())
    expect(JSON.stringify(publicRow)).not.toContain(SECRET)
    expect(secrets.apiKey).toBe(`${SECRET}-top`)
    expect(Object.keys(secrets.providerSettings)).toEqual(["openai"])
    expect(Object.keys(secrets.customProviders)).toEqual(["relay", "#1"])
    expect(publicRow.theme).toBe("dark")
  })

  it("round-trips through join", () => {
    const row = settingsWithKeys()
    const { publicRow, secrets } = splitSettingsSecrets(row)
    expect(joinSettingsSecrets(publicRow, secrets)).toEqual(row)
  })

  it("never mutates its input", () => {
    const row = settingsWithKeys()
    const before = JSON.stringify(row)
    splitSettingsSecrets(row)
    expect(JSON.stringify(row)).toBe(before)
  })

  it("is empty for a row without credentials", () => {
    const { secrets } = splitSettingsSecrets({ theme: "light" } as Partial<AppSettings>)
    expect(isEmptySecretSet(secrets)).toBe(true)
  })
})

describe("joinSettingsSecrets", () => {
  it("ignores credentials for providers the row no longer lists", () => {
    const { secrets } = splitSettingsSecrets(settingsWithKeys())
    const joined = joinSettingsSecrets({ providerSettings: {}, customProviders: [] }, secrets)
    expect(joined.providerSettings).toEqual({})
    expect(joined.customProviders).toEqual([])
  })

  it("returns the same object when there is nothing to join", () => {
    const row = { theme: "dark" } as Partial<AppSettings>
    expect(joinSettingsSecrets(row, emptySecretSet())).toBe(row)
  })
})

describe("overlaySecretSets", () => {
  it("lets the override win per credential and keeps the rest of the base", () => {
    const base = {
      ...emptySecretSet(),
      apiKey: "base-top",
      providerSettings: {
        openai: [
          { path: ["apiKey"], value: "base" },
          { path: ["apiKeys"], value: ["pool"] },
        ],
      },
    }
    const override = {
      ...emptySecretSet(),
      providerSettings: { openai: [{ path: ["apiKey"], value: "row" }] },
    }
    const merged = overlaySecretSets(base, override)
    expect(merged.apiKey).toBe("base-top")
    expect(merged.providerSettings.openai).toEqual([
      { path: ["apiKeys"], value: ["pool"] },
      { path: ["apiKey"], value: "row" },
    ])
  })
})

describe("secretSetsEqual", () => {
  it("ignores key order and treats null as empty", () => {
    const a = { providerSettings: { x: [] }, customProviders: {} }
    const b = { customProviders: {}, providerSettings: { x: [] } }
    expect(secretSetsEqual(a, b)).toBe(true)
    expect(secretSetsEqual(null, emptySecretSet())).toBe(true)
    expect(secretSetsEqual({ ...emptySecretSet(), apiKey: "k" }, emptySecretSet())).toBe(false)
  })
})
