/** @jest-environment node */
import "fake-indexeddb/auto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AuthConnectionManager } from "@/lib/plugin/auth/connection-manager"
import { AuthAttemptStore, type AttemptIndexRow } from "@/lib/plugin/auth/auth-attempts"
import {
  ConnectionCredentialStore,
  HostAuthSecrets,
  setHostAuthBackend,
} from "@/lib/plugin/auth/connection-credentials"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import type { AuthenticationProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { createCliFileLock } from "./file-lock"
import { authSecretPath, createCliAuthSecretStore, realAuthSecretFs } from "./auth-secret-store"

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-auth-secrets-"))
})
afterEach(() => {
  setHostAuthBackend(null)
  fs.rmSync(home, { recursive: true, force: true })
})

function backend() {
  return {
    storeFor: (namespace: string) => createCliAuthSecretStore(home, namespace),
    lock: createCliFileLock(home, { retryMs: 2 }),
  }
}

it("commits credentials across fresh backend instances with private permissions", async () => {
  setHostAuthBackend(backend())
  const first = new ConnectionCredentialStore()
  await first.commit("ref", await first.read("ref"), {
    accessToken: "token",
    refreshToken: "rotated",
    scopes: [],
  })
  setHostAuthBackend(backend())
  expect(await new ConnectionCredentialStore().read("ref")).toMatchObject({
    revision: 1,
    credentials: { accessToken: "token", refreshToken: "rotated" },
  })
  for (const file of fs
    .readdirSync(path.join(home, "auth"))
    .filter((name) => name.endsWith(".json"))) {
    expect(fs.statSync(path.join(home, "auth", file)).mode & 0o777).toBe(0o600)
  }
  expect(fs.statSync(path.join(home, "auth")).mode & 0o777).toBe(0o700)
  await first.delete("ref")
  expect((await new ConnectionCredentialStore().read("ref")).raw).toBeNull()
})

it("leaves the old committed value intact if the process fails before rename", async () => {
  const store = createCliAuthSecretStore(home, "connections")
  await store.save("key", "old")
  let temporary: string | undefined
  const crashing = createCliAuthSecretStore(home, "connections", {
    ...realAuthSecretFs,
    rename: (from) => {
      temporary = from
      throw new Error("simulated crash")
    },
    remove: () => {}, // Model an abrupt exit leaving a fully written temp file.
  })
  await expect(crashing.save("key", "uncommitted")).rejects.toThrow("simulated crash")
  expect(temporary).toBeDefined()
  expect(fs.existsSync(temporary!)).toBe(true)
  expect(await createCliAuthSecretStore(home, "connections").load("key")).toBe("old")
})

it("keeps committed files usable and private with a restrictive process umask", async () => {
  const previous = process.umask(0o777)
  try {
    await createCliAuthSecretStore(home, "restricted").save("key", "value")
    expect(await createCliAuthSecretStore(home, "restricted").load("key")).toBe("value")
    expect(fs.statSync(authSecretPath(home, "restricted")).mode & 0o777).toBe(0o600)
  } finally {
    process.umask(previous)
  }
})

it("serializes namespace mutations, separates unsafe names, and fails closed on corruption", async () => {
  const a = createCliAuthSecretStore(home, "../a:b")
  const b = createCliAuthSecretStore(home, "../a:b")
  await Promise.all([a.save("__proto__", "first"), b.save("other", "second")])
  expect(await b.load("__proto__")).toBe("first")
  expect(await a.load("other")).toBe("second")
  expect(await createCliAuthSecretStore(home, "../a?b").load("other")).toBeNull()
  fs.writeFileSync(authSecretPath(home, "../a:b"), '{"key":42}')
  await expect(a.save("key", "overwrite")).rejects.toThrow("Invalid CLI auth secret store")
})

it("two independent managers over one home refresh a rotated lineage once", async () => {
  const rows = new Map<string, AuthConnectionRow>()
  const store = {
    get: async (id: string) => rows.get(id),
    find: async (key: string) => [...rows.values()].find((row) => row.identityKey === key),
    list: async () => [...rows.values()],
    put: async (row: AuthConnectionRow) => {
      rows.set(row.id, structuredClone(row))
    },
  }
  const fresh = {
    accessToken: "new",
    refreshToken: "rotated",
    scopes: ["read"],
    expiresAt: "2100-01-01T00:00:00Z",
  }
  const provider: AuthenticationProvider = {
    id: "acme",
    label: "Acme",
    pluginId: null,
    getSessions: async () => [],
    removeSession: async () => {},
    createSession: async () => {
      throw new Error("unused")
    },
    describe: async () => ({
      issuer: "https://issuer",
      clientId: "client",
      principal: { kind: "user", id: "user" },
      accountLabel: "Account",
      scopes: ["read"],
    }),
    refresh: jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return fresh
    }),
  }
  const manager = () => {
    const persistence = backend()
    return new AuthConnectionManager({
      store,
      provider: () => provider,
      lock: persistence.lock,
      credentials: new ConnectionCredentialStore(
        new HostAuthSecrets("connections", {
          native: false,
          store: persistence.storeFor("connections"),
          lock: persistence.lock,
        })
      ),
    })
  }
  const first = manager()
  const ref = await first.createConnectionFromCredentials(provider, {
    accessToken: "old",
    refreshToken: "old-refresh",
    scopes: ["read"],
    expiresAt: "2000-01-01T00:00:00Z",
  })
  expect(await Promise.all([first.getCredentials(ref), manager().getCredentials(ref)])).toEqual([
    fresh,
    fresh,
  ])
  expect(provider.refresh).toHaveBeenCalledTimes(1)
})

it("a pending PKCE attempt survives fresh stores and is accepted only once", async () => {
  const index = () => {
    const rows = new Map<string, AttemptIndexRow>()
    return {
      get: async (state: string) => rows.get(state),
      put: async (row: AttemptIndexRow) => {
        rows.set(row.state, row)
      },
      expired: async () => [],
      delete: async (state: string) => {
        rows.delete(state)
      },
    }
  }
  setHostAuthBackend(backend())
  const attempts = new AuthAttemptStore(undefined, index())
  const binding = { providerId: "acme", clientId: "client", issuer: "https://issuer" }
  const attempt = await attempts.createAttempt({
    ...binding,
    method: "oauth-pkce",
    scopes: ["read"],
  })
  expect(attempt.persistence).toBe("persistent")
  setHostAuthBackend(backend())
  const restarted = new AuthAttemptStore(undefined, index())
  const outcomes = await Promise.allSettled([
    restarted.consumeAttempt(attempt.state, binding),
    new AuthAttemptStore(undefined, index()).consumeAttempt(attempt.state, binding),
  ])
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(outcomes.find((result) => result.status === "fulfilled")).toMatchObject({
    value: { codeVerifier: attempt.codeVerifier },
  })
})
