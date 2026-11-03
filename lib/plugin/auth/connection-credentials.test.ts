jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: jest.fn(() => "acct-a"),
}))
jest.mock("@/lib/credentials/keyring-store", () => {
  const namespaces = new Map<string, Map<string, string>>()
  return {
    createKeyringStore: jest.fn((namespace: string) => {
      let values = namespaces.get(namespace)
      if (!values) {
        values = new Map()
        namespaces.set(namespace, values)
      }
      const store = values
      return {
        load: async (key: string) => store.get(key) ?? null,
        save: async (key: string, value: string) => {
          store.set(key, value)
        },
        delete: async (key: string) => {
          store.delete(key)
        },
        isPersistent: () => true,
      }
    }),
  }
})
jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: jest.fn(() => null),
}))
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  ConnectionCredentialStore,
  CredentialRevisionConflict,
  CredentialStoreDegraded,
  HostAuthSecrets,
  setHostAuthBackend,
  withAuthLock,
} from "./connection-credentials"
import { withNamedLock } from "@/lib/locks/named-lock"

it("keeps the Host-selected auth method outside provider credentials across rotation and tombstoning", async () => {
  const store = new ConnectionCredentialStore(new HostAuthSecrets("method-test", { native: false }))
  const credentials = { accessToken: "key", scopes: [] }
  const committed = await store.commit(
    "method-ref",
    { raw: null, revision: 0 },
    credentials,
    undefined,
    "api-key"
  )
  expect(committed).toMatchObject({ authMethod: "api-key", credentials })
  expect(committed.credentials).not.toHaveProperty("authMethod")
  const rotated = await store.commit("method-ref", committed, {
    accessToken: "replacement",
    scopes: [],
  })
  expect(rotated.authMethod).toBe("api-key")
  expect((await store.tombstone("method-ref", rotated)).authMethod).toBe("api-key")
})

it("uses the CLI backend override and restores platform defaults with null", async () => {
  const values = new Map<string, string>()
  const storeFor = jest.fn(() => ({
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
    isPersistent: () => true,
  }))
  const lock = jest.fn((name: string, task: (assertHeld: () => void) => Promise<unknown>) =>
    withNamedLock(name, task, { mode: "in-process" })
  ) as unknown as jest.MockedFunction<typeof withAuthLock>
  setHostAuthBackend({ storeFor, lock })
  try {
    const secrets = new HostAuthSecrets("override", { native: false })
    await secrets.compareAndSet("key", null, "durable")
    expect(await secrets.read("key")).toBe("durable")
    expect(storeFor).toHaveBeenCalledWith("override")
    await withAuthLock(
      "direct",
      async (assertHeld) => {
        assertHeld()
      },
      "lineage"
    )
    expect(lock).toHaveBeenCalledWith("direct", expect.any(Function), "lineage")
    new HostAuthSecrets("native-bypasses-override", { native: true })
    expect(storeFor).toHaveBeenCalledTimes(1)
  } finally {
    setHostAuthBackend(null)
  }
  const calls = lock.mock.calls.length
  await withAuthLock("default-restored", async () => {}, "test")
  await new HostAuthSecrets("default-restored", { native: false }).read("key")
  expect(createKeyringStore).toHaveBeenCalledWith("default-restored")
  expect(lock).toHaveBeenCalledTimes(calls)
})

function fixture(persistent = true) {
  const rows = new Map<string, string>()
  const store = {
    load: async (id: string) => rows.get(id) ?? null,
    save: async (id: string, value: string) => {
      rows.set(id, value)
    },
    delete: async (id: string) => {
      rows.delete(id)
    },
    isPersistent: () => persistent,
  }
  const lock: typeof import("./connection-credentials").withAuthLock = (name, task) =>
    withNamedLock(name, task, { mode: "in-process" })
  const secrets = new HostAuthSecrets("auth-connections", { store, native: false, lock })
  return { rows, credentials: new ConnectionCredentialStore(secrets) }
}

it("CAS rejects stale revisions and commits rotated tokens together", async () => {
  const { rows, credentials } = fixture()
  const first = await credentials.read("ref")
  const fresh = { accessToken: "a", refreshToken: "r", scopes: [] }
  await credentials.commit("ref", first, fresh)
  await expect(credentials.commit("ref", first, fresh)).rejects.toBeInstanceOf(
    CredentialRevisionConflict
  )
  expect(JSON.parse(rows.get("ref")!)).toEqual({ revision: 1, credentials: fresh })
  const tombstone = await credentials.tombstone("ref", await credentials.read("ref"))
  await expect(credentials.commit("ref", tombstone, fresh)).rejects.toBeInstanceOf(
    CredentialRevisionConflict
  )
  await credentials.delete("ref")
  expect(await credentials.read("ref")).toEqual({ raw: null, revision: 0 })
})

it("reports locked Browser Vault persistence as a typed degraded state", async () => {
  const { credentials, rows } = fixture(false)
  expect(credentials.isPersistent()).toBe(false)
  await expect(credentials.read("ref")).rejects.toMatchObject({
    reason: "non-persistent-until-vault-unlock",
  })
  await expect(
    credentials.commit("ref", { raw: null, revision: 0 }, { accessToken: "a", scopes: [] })
  ).rejects.toBeInstanceOf(CredentialStoreDegraded)
  expect(rows.size).toBe(0)
})

it("rolls back only an unpublished credential write and preserves a newer CAS winner", async () => {
  const { credentials } = fixture()
  const blank = await credentials.read("ref")
  const first = await credentials.commit("ref", blank, { accessToken: "first", scopes: [] })
  const second = await credentials.commit("ref", first, { accessToken: "second", scopes: [] })
  await credentials.rollbackUnpublished("ref", second, first)
  expect(await credentials.read("ref")).toEqual(first)
  const next = await credentials.commit("ref", first, { accessToken: "next", scopes: [] })
  await expect(credentials.rollbackUnpublished("ref", second, first)).rejects.toBeInstanceOf(
    CredentialRevisionConflict
  )
  expect(await credentials.read("ref")).toEqual(next)
  await credentials.rollbackUnpublished("ref", next, blank)
  expect(await credentials.read("ref")).toEqual(blank)
})

it("native CAS uses the exact raw read and only translates condition mismatches", async () => {
  const cas = jest
    .fn()
    .mockRejectedValueOnce("secret-store condition mismatch")
    .mockRejectedValueOnce(new Error("offline"))
  const secrets = new HostAuthSecrets("auth-connections", { native: true, cas })
  await expect(secrets.compareAndSet("ref", "raw", "next")).rejects.toBeInstanceOf(
    CredentialRevisionConflict
  )
  expect(cas).toHaveBeenCalledWith({ namespace: "auth-connections", key: "ref" }, "raw", "next")
  await expect(secrets.compareAndSet("ref", "raw", "next")).rejects.toThrow("offline")
})

it("reports a vault locking during CAS before writing an ephemeral credential", async () => {
  let persistent = true
  const save = jest.fn()
  const store = {
    load: async () => {
      persistent = false
      return null
    },
    save,
    delete: async () => {},
    isPersistent: () => persistent,
  }
  const secrets = new HostAuthSecrets("auth-connections", {
    store,
    native: false,
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
  })
  await expect(
    new ConnectionCredentialStore(secrets).commit(
      "ref",
      { raw: null, revision: 0 },
      { accessToken: "token", scopes: [] }
    )
  ).rejects.toBeInstanceOf(CredentialStoreDegraded)
  expect(save).not.toHaveBeenCalled()
})

it("refuses to write when the browser vault switches profiles during the CAS read", async () => {
  const vault = { localAccountId: "acct-a" }
  jest
    .mocked(getActiveBrowserVault)
    .mockImplementation(() => vault as unknown as ReturnType<typeof getActiveBrowserVault>)
  const rows = new Map<string, string>()
  const save = jest.fn(async (key: string, value: string) => {
    rows.set(key, value)
  })
  const store = {
    load: async (key: string) => {
      // The credential read is in flight when another profile's vault opens.
      if (key === "ref") vault.localAccountId = "acct-b"
      return rows.get(key) ?? null
    },
    save,
    delete: async (key: string) => {
      rows.delete(key)
    },
    isPersistent: () => true,
  }
  const secrets = new HostAuthSecrets("auth-connections:acct-a", {
    store,
    native: false,
    accountId: "acct-a",
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
  })
  try {
    await expect(secrets.compareAndSet("ref", null, "value")).rejects.toThrow(
      "The local profile changed during authentication"
    )
    expect(save.mock.calls.map(([key]) => key)).not.toContain("ref")
  } finally {
    jest.mocked(getActiveBrowserVault).mockImplementation(() => null)
  }
})

it("default credential stores isolate the same ref in active-account namespaces", async () => {
  jest.mocked(getActiveAccountId).mockReturnValue("acct-a")
  const a = new ConnectionCredentialStore()
  await a.commit("shared-ref", await a.read("shared-ref"), { accessToken: "a", scopes: [] })
  jest.mocked(getActiveAccountId).mockReturnValue("acct-b")
  const b = new ConnectionCredentialStore()
  expect((await b.read("shared-ref")).credentials).toBeUndefined()
  await b.commit("shared-ref", await b.read("shared-ref"), { accessToken: "b", scopes: [] })
  expect((await a.read("shared-ref")).credentials?.accessToken).toBe("a")
  expect((await b.read("shared-ref")).credentials?.accessToken).toBe("b")
  expect(createKeyringStore).toHaveBeenCalledWith("auth-connections:acct-a")
  expect(createKeyringStore).toHaveBeenCalledWith("auth-connections:acct-b")
})

it("native account inventories fence deletion and retain orphan keys after a failed credential CAS", async () => {
  const rows = new Map<string, string>()
  const cas = jest.fn(
    async (_ref: { namespace: string; key: string }, expected: string | null, value: string) => {
      expect(_ref.namespace).toBe("auth-connections:inactive")
      if ((rows.get(_ref.key) ?? null) !== expected)
        throw new Error("secret-store condition mismatch")
      rows.set(_ref.key, value)
    }
  )
  const secrets = new HostAuthSecrets("auth-connections:inactive", {
    native: true,
    accountId: "inactive",
    cas,
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
    store: {
      load: async (key) => rows.get(key) ?? null,
      save: async () => {
        throw new Error("must use native CAS")
      },
      delete: async (key) => {
        rows.delete(key)
      },
      isPersistent: () => true,
    },
  })
  await secrets.compareAndSet("ref", null, "token")
  await expect(secrets.compareAndSet("orphan", "stale", "unused")).rejects.toBeInstanceOf(
    CredentialRevisionConflict
  )
  expect(await secrets.beginDeletion()).toEqual(["ref", "orphan"])
  await secrets.delete("ref")
  await secrets.delete("orphan")
  await expect(secrets.compareAndSet("ref", null, "late-token")).rejects.toThrow("deleted")
  expect(rows.get("ref")).toBeUndefined()
  expect(JSON.parse(rows.get("__host_auth_keys__")!)).toEqual({ keys: [], deleting: true })
})

it("serializes secret deletion with recreation so the new key remains enumerable", async () => {
  const rows = new Map<string, string>()
  let removed!: () => void
  let release!: () => void
  const deleted = new Promise<void>((resolve) => {
    removed = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const secrets = new HostAuthSecrets("auth-connections:recreate", {
    native: false,
    accountId: "recreate",
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
    store: {
      load: async (key) => rows.get(key) ?? null,
      save: async (key, value) => {
        rows.set(key, value)
      },
      delete: async (key) => {
        rows.delete(key)
        removed()
        await gate
      },
      isPersistent: () => true,
    },
  })
  await secrets.compareAndSet("ref", null, "old")
  const deleting = secrets.delete("ref")
  await deleted
  const recreating = secrets.compareAndSet("ref", null, "new")
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  await Promise.all([deleting, recreating])
  expect(await secrets.read("ref")).toBe("new")
  expect(await secrets.beginDeletion()).toEqual(["ref"])
})
