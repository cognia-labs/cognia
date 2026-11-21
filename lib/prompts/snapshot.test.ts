/** @jest-environment jsdom */

import { publishPromptOverride, resetPromptOverride } from "@/lib/db/prompt-overrides"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { TITLE_CHAT_PROMPT } from "@/lib/ai/generation/title"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { resolvePromptAsync } from "./resolve"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  buildPromptOverrideSnapshot,
  invalidatePromptOverrideSnapshot,
  loadPromptOverrideSnapshot,
  peekPromptOverrideSnapshot,
  subscribePromptOverrideSnapshot,
} from "./snapshot"

/** Runs once right after the next snapshot read finished, before it is delivered. */
const mockAfterRead: { next: (() => Promise<void>) | null } = { next: null }
jest.mock("@/lib/db/prompt-overrides", () => {
  const actual = jest.requireActual("@/lib/db/prompt-overrides")
  return {
    ...actual,
    readActivePromptOverrides: async () => {
      const read = await actual.readActivePromptOverrides()
      const hook = mockAfterRead.next
      mockAfterRead.next = null
      if (hook) await hook()
      return read
    },
  }
})

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }
let n = 0
const publish = (body: string, expectedRev: number) =>
  publishPromptOverride({
    promptId: "generation.title.chat",
    target: account,
    body,
    contractVersion: 1,
    baseDigest: "sha256:x",
    expectedRev,
    mutationId: `m${++n}`,
    origin: "editor",
  })

it("groups rows by prompt id", () => {
  const snapshot = buildPromptOverrideSnapshot("db", [
    {
      bindingId: "b1",
      promptId: "p",
      scope: "account",
      targetId: "",
      revisionId: "r1",
      body: "x",
      contractVersion: 1,
    },
  ])
  expect(snapshot.byPrompt.get("p")).toHaveLength(1)
})

it("loads only published active revisions for the active database", async () => {
  expect(peekPromptOverrideSnapshot()).toBeNull()
  const binding = await publish("Live body", 0)
  const snapshot = await loadPromptOverrideSnapshot()
  expect(snapshot.databaseName).toBe(getDb().name)
  expect(snapshot.byPrompt.get("generation.title.chat")?.[0]).toMatchObject({
    body: "Live body",
    revisionId: binding.activeRevisionId,
  })
  expect(peekPromptOverrideSnapshot()).toBe(snapshot)
})

it("reloads after a committed mutation and drops a reset binding", async () => {
  const binding = await publish("Live body", 0)
  await loadPromptOverrideSnapshot()
  const replaced = new Promise<void>((resolve) => {
    const off = subscribePromptOverrideSnapshot(() => {
      off()
      resolve()
    })
  })
  await resetPromptOverride({
    promptId: "generation.title.chat",
    target: account,
    expectedRev: binding.rev,
    mutationId: "reset-1",
    origin: "editor",
    contractVersion: 1,
    baseDigest: "sha256:x",
  })
  await replaced
  expect(peekPromptOverrideSnapshot()?.byPrompt.get("generation.title.chat")).toBeUndefined()
})

describe("account switches (F14)", () => {
  const ACCOUNT_A = "acct_prompt_snapshot_a"
  const ACCOUNT_B = "acct_prompt_snapshot_b"

  /** What signing in to an account does: its content key unlocks, its database becomes active. */
  async function switchToAccount(accountId: string): Promise<void> {
    const name = encryptedAccountDatabaseName(accountId)
    const key = new Uint8Array(32).fill(accountId === ACCOUNT_A ? 1 : 2)
    activateAccountContentCipher(await AccountContentCipher.fromRawKey(accountId, name, key))
    activateAccountDatabase(accountId)
  }

  async function seedAccount(accountId: string, body: string): Promise<void> {
    await switchToAccount(accountId)
    await publish(body, 0)
  }

  beforeEach(() => {
    dbFixture.registerCleanup(async () => {
      mockAfterRead.next = null
      for (const accountId of [ACCOUNT_A, ACCOUNT_B]) {
        await switchToAccount(accountId)
        await getDb().delete()
      }
      lockAccountContentCipher()
      clearAccountDatabaseSelection()
      invalidatePromptOverrideSnapshot()
    })
  })

  const bodyOf = (snapshot: { byPrompt: ReadonlyMap<string, readonly { body: string }[]> }) =>
    snapshot.byPrompt.get("generation.title.chat")?.[0]?.body

  it("never hands a read that finished for one account to a caller of the next", async () => {
    await seedAccount(ACCOUNT_B, "B text")
    await seedAccount(ACCOUNT_A, "A text")
    invalidatePromptOverrideSnapshot()
    // A's read is complete; the account switches before it is delivered.
    mockAfterRead.next = () => switchToAccount(ACCOUNT_B)
    const snapshot = await loadPromptOverrideSnapshot()
    expect(snapshot.databaseName).toBe(getDb().name)
    expect(bodyOf(snapshot)).toBe("B text")
    expect(bodyOf(peekPromptOverrideSnapshot()!)).toBe("B text")
  })

  it("does not join a load in flight for the previous account", async () => {
    await seedAccount(ACCOUNT_B, "B text")
    await seedAccount(ACCOUNT_A, "A text")
    invalidatePromptOverrideSnapshot()
    const forA = loadPromptOverrideSnapshot()
    await switchToAccount(ACCOUNT_B)
    const forB = loadPromptOverrideSnapshot()
    expect(bodyOf(await forB)).toBe("B text")
    // The caller who started under A is handed the account active now, too.
    expect(bodyOf(await forA)).toBe("B text")
  })

  it("resolves the active account's override, never the one a stale load read", async () => {
    await seedAccount(ACCOUNT_B, "B text")
    await seedAccount(ACCOUNT_A, "A text")
    invalidatePromptOverrideSnapshot()
    mockAfterRead.next = () => switchToAccount(ACCOUNT_B)
    const resolved = await resolvePromptAsync(TITLE_CHAT_PROMPT, { record: false })
    expect(resolved.text).toBe("B text")
  })
})
