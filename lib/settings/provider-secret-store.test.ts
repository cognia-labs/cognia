/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import type { KeyringStore } from "@/lib/credentials/keyring-store"

import { emptySecretSet } from "./provider-secret-split"
import {
  __resetProviderSecretStoreForTesting,
  __setProviderSecretBackendForTesting,
  deleteProviderSecrets,
  forgetProviderSecretsForDatabases,
  ProviderSecretStoreUnavailableError,
  readOwnProviderSecrets,
  releaseAdoptedProviderSecrets,
  resolveProviderSecrets,
  writeProviderSecrets,
} from "./provider-secret-store"

class MemoryBackend implements KeyringStore {
  readonly values = new Map<string, string>()
  loads = 0
  failing = false
  async save(key: string, value: string) {
    if (this.failing) throw new Error("down")
    this.values.set(key, value)
  }
  async load(key: string) {
    if (this.failing) throw new Error("down")
    this.loads += 1
    return this.values.get(key) ?? null
  }
  async delete(key: string) {
    if (this.failing) throw new Error("down")
    this.values.delete(key)
  }
}

const secrets = (apiKey: string) => ({ ...emptySecretSet(), apiKey })

let backend: MemoryBackend
beforeEach(() => {
  __resetProviderSecretStoreForTesting()
  backend = new MemoryBackend()
  __setProviderSecretBackendForTesting(backend)
})
afterAll(() => __resetProviderSecretStoreForTesting())

describe("provider secret store", () => {
  it("writes one blob per database and resolves it by revision", async () => {
    const ref = await writeProviderSecrets("db-a", secrets("k1"))
    expect(ref.db).toBe("db-a")
    const resolved = await resolveProviderSecrets("db-a", ref)
    expect(resolved).toMatchObject({
      status: "ok",
      blob: { rev: ref.rev, secrets: { apiKey: "k1" } },
    })
  })

  it("uses its cache while the revision matches and reloads when it does not", async () => {
    const ref = await writeProviderSecrets("db-a", secrets("k1"))
    await resolveProviderSecrets("db-a", ref)
    expect(backend.loads).toBe(0)
    await resolveProviderSecrets("db-a", { db: "db-a", rev: "elsewhere" })
    expect(backend.loads).toBe(1)
  })

  it("resolves no blob for a row without a pointer", async () => {
    await writeProviderSecrets("db-a", secrets("k1"))
    expect(await resolveProviderSecrets("db-a", undefined)).toMatchObject({ blob: null })
  })

  it("finds a copied row's blob under the source name and marks it for adoption", async () => {
    const ref = await writeProviderSecrets("source", secrets("k1"))
    __setProviderSecretBackendForTesting(backend)
    const resolved = await resolveProviderSecrets("target", ref)
    expect(resolved).toMatchObject({ status: "ok", adoptFrom: "source", blob: { db: "source" } })
  })

  it("reports an unavailable store instead of throwing", async () => {
    backend.failing = true
    const resolved = await resolveProviderSecrets("db-a", { db: "db-a", rev: "r" })
    expect(resolved.status).toBe("unavailable")
    await expect(writeProviderSecrets("db-a", secrets("k"))).rejects.toBeInstanceOf(
      ProviderSecretStoreUnavailableError
    )
    await expect(deleteProviderSecrets("db-a")).rejects.toBeInstanceOf(
      ProviderSecretStoreUnavailableError
    )
  })

  it("rejects a blob with an unknown shape as unavailable", async () => {
    backend.values.set("db-a", JSON.stringify({ v: 9 }))
    const resolved = await resolveProviderSecrets("db-a", { db: "db-a", rev: "r" })
    expect(resolved.status).toBe("unavailable")
  })

  it("forgets the blobs of deleted databases and reports failures per database", async () => {
    await writeProviderSecrets("a", secrets("1"))
    await writeProviderSecrets("b", secrets("2"))
    expect(await forgetProviderSecretsForDatabases(["a", "b", "a"])).toEqual({ failed: [] })
    expect(backend.values.size).toBe(0)
    backend.failing = true
    expect(await forgetProviderSecretsForDatabases(["c"])).toEqual({ failed: ["c"] })
  })

  it("releases an adopted source only once its database is gone", async () => {
    const live = new Dexie("provider-secret-store-live-source")
    live.version(1).stores({ t: "id" })
    await live.open()
    try {
      await writeProviderSecrets(live.name, secrets("1"))
      await releaseAdoptedProviderSecrets(live.name)
      expect(backend.values.has(live.name)).toBe(true)
    } finally {
      live.close()
      await Dexie.delete(live.name)
    }
    await releaseAdoptedProviderSecrets(live.name)
    expect(backend.values.has(live.name)).toBe(false)
  })

  it("reads a database's own credentials fresh for restore", async () => {
    await writeProviderSecrets("db-a", secrets("k1"))
    expect(await readOwnProviderSecrets("db-a")).toMatchObject({ apiKey: "k1" })
    expect(await readOwnProviderSecrets("missing")).toBeNull()
  })
})
