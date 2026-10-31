jest.mock("@/lib/credentials/keyring-store", () => {
  const namespaces = new Map<string, Map<string, string>>()
  return {
    createKeyringStore: (namespace: string) => {
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
    },
  }
})
import { accountAuthSecrets } from "./connection-credentials"
import { getAuthAttemptStore } from "./auth-attempts"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  activateAccountDatabase,
  clearAccountDatabaseSelection,
  getDb,
  whenSeeded,
} from "@/lib/db/schema"
import Dexie from "dexie"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { AuthAttemptStore, type AttemptIndexRow } from "./auth-attempts"
import { HostAuthSecrets } from "./connection-credentials"
import { withNamedLock } from "@/lib/locks/named-lock"
import { generateCodeChallenge } from "@cognia/provider-core/providers/oauth"

const input = {
  providerId: "provider",
  clientId: "client",
  issuer: "https://issuer",
  method: "oauth-pkce" as const,
  scopes: ["read"],
}
function fixture(native = false) {
  const rows = new Map<string, AttemptIndexRow>()
  const secrets = new Map<string, string>()
  let now = Date.now()
  const lock: typeof import("./connection-credentials").withAuthLock = (name, task) =>
    withNamedLock(name, task, { mode: "in-process" })
  const cas = jest.fn(async (_ref, expected, value) => {
    if ((secrets.get(_ref.key) ?? null) !== expected)
      throw new Error("secret-store condition mismatch")
    secrets.set(_ref.key, value)
  })
  const backing = new HostAuthSecrets("auth-attempts", {
    native,
    cas,
    lock,
    store: {
      load: async (key) => secrets.get(key) ?? null,
      save: async (key, value) => {
        secrets.set(key, value)
      },
      delete: async (key) => {
        secrets.delete(key)
      },
      isPersistent: () => true,
    },
  })
  const index = {
    get: async (state: string) => rows.get(state),
    put: async (row: AttemptIndexRow) => {
      rows.set(row.state, row)
    },
    delete: async (state: string) => {
      rows.delete(state)
    },
    expired: async (time: number) => [...rows.values()].filter((row) => row.expiresAt <= time),
  }
  const attempts = new AuthAttemptStore(backing, index, () => now, lock)
  return {
    attempts,
    backing,
    index,
    lock,
    rows,
    secrets,
    cas,
    advance: () => {
      now += 10 * 60 * 1000 + 1
    },
  }
}

it.each([false, true])("single-use attempt consumption, native=%s", async (native) => {
  const f = fixture(native)
  const attempt = await f.attempts.createAttempt(input)
  expect(attempt.state).toMatch(/^[0-9a-f]{64}$/)
  expect(attempt.codeChallenge).toBe(await generateCodeChallenge(attempt.codeVerifier!))
  expect(f.secrets.size).toBe(1)
  const results = await Promise.allSettled([
    f.attempts.consumeAttempt(attempt.state, input),
    f.attempts.consumeAttempt(attempt.state, input),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  expect(f.secrets.size).toBe(0)
  await expect(f.attempts.consumeAttempt(attempt.state, input)).rejects.toMatchObject({
    reason: "already-consumed",
  })
})

it.each([
  ["providerId", "provider-mismatch"],
  ["clientId", "client-mismatch"],
  ["issuer", "issuer-mismatch"],
])("rejects a cross-%s callback without consuming the valid attempt", async (field, reason) => {
  const f = fixture()
  const attempt = await f.attempts.createAttempt(input)
  await expect(
    f.attempts.consumeAttempt(attempt.state, { ...input, [field]: "other" })
  ).rejects.toMatchObject({ reason })
  await expect(f.attempts.consumeAttempt(attempt.state, input)).resolves.toMatchObject({
    state: attempt.state,
  })
})

it("expires and sweeps records on both create and consume", async () => {
  const f = fixture()
  const first = await f.attempts.createAttempt(input)
  f.advance()
  await expect(f.attempts.consumeAttempt(first.state, input)).rejects.toMatchObject({
    reason: "expired",
  })
  expect(f.secrets.size).toBe(0)
  const second = await f.attempts.createAttempt(input)
  f.advance()
  await f.attempts.createAttempt(input)
  expect(f.rows.has(second.state)).toBe(false)
  expect(f.secrets.has(second.state)).toBe(false)
  await expect(f.attempts.consumeAttempt("missing", input)).rejects.toMatchObject({
    reason: "unknown",
  })
})

it("cancel deletes the secret so late callbacks are rejected", async () => {
  const f = fixture()
  const attempt = await f.attempts.createAttempt(input)
  await f.attempts.cancelAttempt(attempt.state)
  expect(f.secrets.size).toBe(0)
  await expect(f.attempts.consumeAttempt(attempt.state, input)).rejects.toMatchObject({
    reason: "cancelled",
  })
})

it.each(["receipt", "secret"])(
  "returns the consumed attempt despite %s cleanup failure",
  async (failure) => {
    const f = fixture(true)
    const attempt = await f.attempts.createAttempt(input)
    if (failure === "receipt")
      jest.spyOn(f.index, "put").mockRejectedValueOnce(new Error("receipt disk failure"))
    else jest.spyOn(f.backing, "delete").mockRejectedValueOnce(new Error("keyring failure"))
    await expect(f.attempts.consumeAttempt(attempt.state, input)).resolves.toMatchObject({
      state: attempt.state,
    })
    await expect(f.attempts.consumeAttempt(attempt.state, input)).rejects.toMatchObject({
      reason: "already-consumed",
    })
  }
)

it("cancellation losing CAS cannot overwrite the consumer's receipt", async () => {
  const f = fixture(true)
  const attempt = await f.attempts.createAttempt(input)
  const original = f.backing.compareAndSet.bind(f.backing)
  jest
    .spyOn(f.backing, "compareAndSet")
    .mockImplementationOnce(async () => {
      await f.attempts.consumeAttempt(attempt.state, input)
      throw new (await import("./connection-credentials")).CredentialRevisionConflict()
    })
    .mockImplementation(original)
  await f.attempts.cancelAttempt(attempt.state)
  expect(f.rows.get(attempt.state)?.outcome).toBe("consumed")
  await expect(f.attempts.consumeAttempt(attempt.state, input)).rejects.toMatchObject({
    reason: "already-consumed",
  })
})

it("default attempt expiry sweeping touches only the active account namespace", async () => {
  const databaseFixture = createDbTestFixture()
  await databaseFixture.initialize()
  const names: string[] = []
  const clock = jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
  try {
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting(
        "sweep-a",
        encryptedAccountDatabaseName("sweep-a")
      )
    )
    activateAccountDatabase("sweep-a")
    names.push(getDb().name)
    await whenSeeded()
    const a = await getAuthAttemptStore().createAttempt(input)
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting(
        "sweep-b",
        encryptedAccountDatabaseName("sweep-b")
      )
    )
    activateAccountDatabase("sweep-b")
    names.push(getDb().name)
    await whenSeeded()
    const b = await getAuthAttemptStore().createAttempt(input)
    clock.mockReturnValue(1_800_000_000_000 + 10 * 60 * 1000 + 1)
    await getAuthAttemptStore().sweepExpired()
    expect(await accountAuthSecrets("auth-attempts", "sweep-a").read(a.state)).not.toBeNull()
    expect(await accountAuthSecrets("auth-attempts", "sweep-b").read(b.state)).toBeNull()
    expect(await getDb().authAttempts.get(b.state)).toBeUndefined()
  } finally {
    clock.mockRestore()
    clearAccountDatabaseSelection()
    lockAccountContentCipher()
    await databaseFixture.dispose()
    for (const name of names) await Dexie.delete(name)
  }
})
