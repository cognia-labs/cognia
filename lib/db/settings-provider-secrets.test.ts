/** @jest-environment jsdom */
// ADR-0256: provider credentials never reach the persisted settings row.
// Every assertion about storage reads the raw IndexedDB row, never getSettings.

import "fake-indexeddb/auto"
import Dexie from "dexie"
import type { AppSettings } from "@cognia/agent-config-types"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { buildProviderVerificationFingerprint } from "@cognia/provider-core/providers/completeness"
import {
  __resetProviderSecretStoreForTesting,
  __setProviderSecretBackendForTesting,
  PROVIDER_SECRETS_REF_FIELD,
  ProviderSecretStoreUnavailableError,
} from "@/lib/settings/provider-secret-store"
import { getSettings, migrateProviderSecretsOutOfSettingsRow, saveSettings } from "./settings"
import { CogniaDB, __resetDbForTesting, getDb, whenSeeded } from "./schema"

const SECRET = "sk-synthetic-provider-secret"

class MemoryBackend implements KeyringStore {
  readonly values = new Map<string, string>()
  saves = 0
  failing = false
  async save(key: string, value: string) {
    if (this.failing) throw new Error("keyring down")
    this.saves += 1
    this.values.set(key, value)
  }
  async load(key: string) {
    if (this.failing) throw new Error("keyring down")
    return this.values.get(key) ?? null
  }
  async delete(key: string) {
    if (this.failing) throw new Error("keyring down")
    this.values.delete(key)
  }
}

let backend: MemoryBackend

async function rawRow(db: Dexie = getDb()): Promise<Record<string, unknown> | undefined> {
  return (await db.table("settings").get("singleton")) as Record<string, unknown> | undefined
}

function withKeys(): Partial<AppSettings> {
  return {
    apiKey: `${SECRET}-top`,
    providerSettings: {
      openai: {
        providerId: "openai",
        enabled: true,
        apiKey: SECRET,
        apiKeys: [SECRET, `${SECRET}-2`],
        apiKeyUsageStats: { [SECRET]: { usageCount: 1, lastUsed: 1, errorCount: 0 } },
        customHeaders: { Authorization: `Bearer ${SECRET}`, "x-tenant": "acme" },
        bedrock: { authMode: "iam", region: "us-east-1", secretAccessKey: SECRET },
      },
    } as unknown as AppSettings["providerSettings"],
    customProviders: [
      {
        id: "custom-1",
        providerName: "Relay",
        baseURL: "https://relay.example/v1",
        apiKey: `${SECRET}-custom`,
        enabled: true,
      },
    ] as unknown as AppSettings["customProviders"],
  }
}

beforeEach(async () => {
  __resetProviderSecretStoreForTesting()
  backend = new MemoryBackend()
  __setProviderSecretBackendForTesting(backend)
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().settings.clear()
})

afterAll(() => __resetProviderSecretStoreForTesting())

describe("provider credentials in the settings row (ADR-0256)", () => {
  it("persists no raw credential and still returns every credential to readers", async () => {
    await saveSettings(withKeys(), { mirrorToHost: false })

    const raw = await rawRow()
    expect(JSON.stringify(raw)).not.toContain(SECRET)
    expect(raw?.[PROVIDER_SECRETS_REF_FIELD]).toEqual({ db: getDb().name, rev: expect.any(String) })

    __setProviderSecretBackendForTesting(backend) // drop the in-process cache
    const read = await getSettings()
    expect(read.apiKey).toBe(`${SECRET}-top`)
    expect(read.providerSettings?.openai).toMatchObject({
      apiKey: SECRET,
      apiKeys: [SECRET, `${SECRET}-2`],
      customHeaders: { Authorization: `Bearer ${SECRET}`, "x-tenant": "acme" },
      bedrock: { authMode: "iam", region: "us-east-1", secretAccessKey: SECRET },
    })
    expect(read.customProviders?.[0]?.apiKey).toBe(`${SECRET}-custom`)
    expect(PROVIDER_SECRETS_REF_FIELD in read).toBe(false)
  })

  it("does not touch the secret store for a save that leaves credentials alone", async () => {
    await saveSettings(withKeys(), { mirrorToHost: false })
    const saves = backend.saves
    await saveSettings({ theme: "dark" }, { mirrorToHost: false })
    expect(backend.saves).toBe(saves)
    expect((await getSettings()).providerSettings?.openai?.apiKey).toBe(SECRET)
  })

  it("removes the blob when the last credential is cleared", async () => {
    await saveSettings({ apiKey: "only-key" }, { mirrorToHost: false })
    expect(backend.values.size).toBe(1)
    await saveSettings({ apiKey: undefined }, { mirrorToHost: false })
    expect(backend.values.size).toBe(0)
    expect((await rawRow())?.[PROVIDER_SECRETS_REF_FIELD]).toBeUndefined()
  })

  it("migrates a row written by an older build exactly once", async () => {
    await getDb().settings.put({ id: "singleton", ...withKeys() } as AppSettings)
    expect(await migrateProviderSecretsOutOfSettingsRow()).toBe(true)
    expect(JSON.stringify(await rawRow())).not.toContain(SECRET)
  })

  it("migrates on read, then leaves the row alone", async () => {
    await getDb().settings.put({ id: "singleton", ...withKeys() } as AppSettings)

    // The read returns the plaintext keys and queues the migration itself.
    expect((await getSettings()).providerSettings?.openai?.apiKey).toBe(SECRET)

    // Queued behind the read's migration, so it finds nothing left to move.
    await migrateProviderSecretsOutOfSettingsRow()
    const raw = await rawRow()
    expect(JSON.stringify(raw)).not.toContain(SECRET)
    expect((await getSettings()).customProviders?.[0]?.apiKey).toBe(`${SECRET}-custom`)

    const updatedAt = raw?.updatedAt
    expect(await migrateProviderSecretsOutOfSettingsRow()).toBe(false)
    expect((await rawRow())?.updatedAt).toBe(updatedAt)
  })

  it("rewrites a v2 fingerprint that embedded the raw key while migrating", async () => {
    const row = { providerId: "openai", apiKey: SECRET, baseURL: "", defaultModel: "" }
    const v2 = JSON.stringify({
      verificationContract: "provider-connectivity-v2",
      apiKey: SECRET,
      apiKeys: [],
      currentKeyIndex: 0,
      baseURL: "",
      defaultModel: "",
      apiProtocol: "",
      customHeaders: [],
    })
    await getDb().settings.put({
      id: "singleton",
      providerSettings: { openai: { ...row, verificationFingerprint: v2 } },
    } as unknown as AppSettings)

    await migrateProviderSecretsOutOfSettingsRow()
    const raw = await rawRow()
    expect(JSON.stringify(raw)).not.toContain(SECRET)
    const read = await getSettings()
    expect(read.providerSettings?.openai?.verificationFingerprint).toBe(
      buildProviderVerificationFingerprint(read.providerSettings?.openai)
    )
  })

  it("refuses a credential change when the secret store is unavailable and writes nothing", async () => {
    await saveSettings(withKeys(), { mirrorToHost: false })
    const before = await rawRow()
    __setProviderSecretBackendForTesting(backend)
    backend.failing = true

    await expect(
      saveSettings(
        {
          providerSettings: { openai: { providerId: "openai", apiKey: "sk-new" } },
        } as unknown as Partial<Omit<AppSettings, "id">>,
        { mirrorToHost: false }
      )
    ).rejects.toBeInstanceOf(ProviderSecretStoreUnavailableError)
    expect(await rawRow()).toEqual(before)
  })

  it("keeps saving other settings, and the pointer, while the store is unavailable", async () => {
    await saveSettings(withKeys(), { mirrorToHost: false })
    const ref = (await rawRow())?.[PROVIDER_SECRETS_REF_FIELD]
    __setProviderSecretBackendForTesting(backend)
    backend.failing = true

    await saveSettings({ theme: "dark" }, { mirrorToHost: false })
    const raw = await rawRow()
    expect(raw?.theme).toBe("dark")
    expect(raw?.[PROVIDER_SECRETS_REF_FIELD]).toEqual(ref)
    expect(JSON.stringify(raw)).not.toContain(SECRET)

    backend.failing = false
    expect((await getSettings()).providerSettings?.openai?.apiKey).toBe(SECRET)
  })

  it("leaves legacy plaintext in place until the store comes back", async () => {
    await getDb().settings.put({ id: "singleton", ...withKeys() } as AppSettings)
    backend.failing = true
    await saveSettings({ theme: "dark" }, { mirrorToHost: false })
    expect(JSON.stringify(await rawRow())).toContain(SECRET)

    backend.failing = false
    await migrateProviderSecretsOutOfSettingsRow()
    expect(JSON.stringify(await rawRow())).not.toContain(SECRET)
    expect((await getSettings()).apiKey).toBe(`${SECRET}-top`)
  })

  it("reads keys another context changed instead of writing a stale cache back", async () => {
    await saveSettings({ apiKey: "first" }, { mirrorToHost: false })
    await getSettings() // warm this context's cache

    // Another tab writes a new blob revision and points the row at it.
    const name = getDb().name
    const blob = JSON.parse(backend.values.get(name)!)
    const next = { ...blob, rev: "other-tab", secrets: { ...blob.secrets, apiKey: "second" } }
    backend.values.set(name, JSON.stringify(next))
    await getDb()
      .table("settings")
      .update("singleton", { [PROVIDER_SECRETS_REF_FIELD]: { db: name, rev: "other-tab" } })

    expect((await getSettings()).apiKey).toBe("second")
    await saveSettings({ theme: "dark" }, { mirrorToHost: false })
    expect((await getSettings()).apiKey).toBe("second")
  })

  it("follows a row copied to another database and adopts its blob", async () => {
    await saveSettings(withKeys(), { mirrorToHost: false })
    const sourceName = getDb().name
    const copy = new CogniaDB(`${sourceName}-copy-target`, "test")
    await copy.open()
    try {
      await copy.table("settings").put((await rawRow())!)
      const scope = { db: copy, assertActive() {} }

      await getDb().delete() // the migration deletes its source
      expect((await getSettings(scope)).providerSettings?.openai?.apiKey).toBe(SECRET)
      await migrateProviderSecretsOutOfSettingsRow(scope)

      expect((await rawRow(copy))?.[PROVIDER_SECRETS_REF_FIELD]).toMatchObject({ db: copy.name })
      expect(backend.values.has(copy.name)).toBe(true)
      expect(backend.values.has(sourceName)).toBe(false)
      expect((await getSettings(scope)).customProviders?.[0]?.apiKey).toBe(`${SECRET}-custom`)
    } finally {
      copy.close()
      await Dexie.delete(copy.name)
    }
  })

  it("never picks up a blob whose revision the row does not name", async () => {
    await saveSettings({ apiKey: "mine" }, { mirrorToHost: false })
    backend.values.set(
      "another-device-db",
      JSON.stringify({
        v: 1,
        db: "another-device-db",
        rev: "theirs",
        secrets: { apiKey: "theirs", providerSettings: {}, customProviders: {} },
      })
    )
    await getDb()
      .table("settings")
      .update("singleton", {
        [PROVIDER_SECRETS_REF_FIELD]: { db: "another-device-db", rev: "unknown-rev" },
      })
    __setProviderSecretBackendForTesting(backend)
    expect((await getSettings()).apiKey).toBe("mine")
  })
})
