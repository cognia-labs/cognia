/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  PromptOverrideAccountChangedError,
  listPromptOverrideRevisions,
} from "@/lib/db/prompt-overrides"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import {
  PromptScopeError,
  PromptValidationError,
  discardPromptDraft,
  listPromptSlots,
  publishPromptBody,
  readPromptSlot,
  removePromptBinding,
  resetPromptToInherited,
  restorePromptRevision,
  savePromptDraft,
  shippedBodyDigest,
} from "./service"
import { invalidatePromptOverrideSnapshot, peekPromptOverrideSnapshot } from "./snapshot"
import { resolvePrompt } from "./resolve"
import { definePrompt } from "./types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

const def = definePrompt({
  id: "test.service",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  defaultBody: "Shipped {{topic}}",
  variables: [{ name: "topic", required: true, maxChars: 50 }],
  maxChars: 100,
  consumers: [],
})
const account = { scope: "account" as const, targetId: "" }

it("publishes a valid body and makes it the next resolution in this context", async () => {
  const binding = await publishPromptBody({
    def,
    target: account,
    body: "Mine {{topic}}",
    expectedRev: 0,
  })
  expect(binding.rev).toBe(1)
  // Settled: the snapshot already carries the revision when publish returns.
  expect(peekPromptOverrideSnapshot()).not.toBeNull()
  expect(resolvePrompt(def, { values: { topic: "x" } }).text).toBe("Mine x")
  const slot = await readPromptSlot(def.id, account)
  expect(slot.active?.baseDigest).toBe(await shippedBodyDigest(def))
})

it("refuses an invalid body or an undeclared scope without writing", async () => {
  await expect(
    publishPromptBody({ def, target: account, body: "no placeholder", expectedRev: 0 })
  ).rejects.toBeInstanceOf(PromptValidationError)
  await expect(
    publishPromptBody({
      def,
      target: { scope: "session", targetId: "s1" },
      body: "Mine {{topic}}",
      expectedRev: 0,
    })
  ).rejects.toBeInstanceOf(PromptScopeError)
  await expect(
    publishPromptBody({
      def,
      target: { scope: "workspace", targetId: "" },
      body: "x {{topic}}",
      expectedRev: 0,
    })
  ).rejects.toBeInstanceOf(PromptScopeError)
  expect(await listPromptSlots(def.id)).toEqual([])
})

it("saves an unfinished draft without validating it, then discards it", async () => {
  const drafted = await savePromptDraft({ def, target: account, body: "half done", expectedRev: 0 })
  expect((await readPromptSlot(def.id, account)).draft?.body).toBe("half done")
  await expect(
    savePromptDraft({ def, target: account, body: "x".repeat(200), expectedRev: drafted.rev })
  ).rejects.toBeInstanceOf(PromptValidationError)
  const discarded = await discardPromptDraft({ def, target: account, expectedRev: drafted.rev })
  expect(discarded.draftRevisionId).toBeNull()
})

it("resets to inheritance and restores an earlier revision as a new one", async () => {
  const first = await publishPromptBody({
    def,
    target: account,
    body: "One {{topic}}",
    expectedRev: 0,
  })
  const second = await publishPromptBody({
    def,
    target: account,
    body: "Two {{topic}}",
    expectedRev: 1,
  })
  const reset = await resetPromptToInherited({ def, target: account, expectedRev: second.rev })
  expect(resolvePrompt(def, { values: { topic: "x" } }).text).toBe("Shipped x")

  const restored = await restorePromptRevision({
    def,
    target: account,
    revisionId: first.activeRevisionId!,
    expectedRev: reset.rev,
  })
  expect(restored.activeRevisionId).not.toBe(first.activeRevisionId)
  expect(resolvePrompt(def, { values: { topic: "x" } }).text).toBe("One x")
  const history = await listPromptOverrideRevisions(restored.id)
  expect(history[0].origin).toBe("restore")
})

it("removes a binding entirely", async () => {
  const binding = await publishPromptBody({
    def,
    target: account,
    body: "One {{topic}}",
    expectedRev: 0,
  })
  await removePromptBinding(binding)
  expect(await listPromptSlots(def.id)).toEqual([])
  expect(resolvePrompt(def, { values: { topic: "x" } }).text).toBe("Shipped x")
})

it("lists a prompt's slots broadest scope first", async () => {
  await publishPromptBody({
    def,
    target: { scope: "workspace", targetId: "ws-b" },
    body: "B {{topic}}",
    expectedRev: 0,
  })
  await publishPromptBody({ def, target: account, body: "A {{topic}}", expectedRev: 0 })
  await publishPromptBody({
    def,
    target: { scope: "workspace", targetId: "ws-a" },
    body: "W {{topic}}",
    expectedRev: 0,
  })
  const slots = await listPromptSlots(def.id)
  expect(slots.map((slot) => `${slot.binding?.scope}:${slot.binding?.targetId}`)).toEqual([
    "account:",
    "workspace:ws-a",
    "workspace:ws-b",
  ])
  expect(slots.every((slot) => slot.database === getDb().name)).toBe(true)
})

describe("an account switch while a write is pending (F17)", () => {
  const ACCOUNT_A = "acct_prompt_service_a"
  const ACCOUNT_B = "acct_prompt_service_b"

  async function cipherFor(accountId: string): Promise<AccountContentCipher> {
    const key = new Uint8Array(32).fill(accountId === ACCOUNT_A ? 3 : 4)
    return AccountContentCipher.fromRawKey(accountId, encryptedAccountDatabaseName(accountId), key)
  }

  function switchTo(accountId: string, cipher: AccountContentCipher): void {
    activateAccountContentCipher(cipher)
    activateAccountDatabase(accountId)
  }

  beforeEach(() => {
    dbFixture.registerCleanup(async () => {
      for (const accountId of [ACCOUNT_A, ACCOUNT_B]) {
        switchTo(accountId, await cipherFor(accountId))
        await getDb().delete()
      }
      lockAccountContentCipher()
      clearAccountDatabaseSelection()
      invalidatePromptOverrideSnapshot()
    })
  })

  it("refuses a publish started for one account once another is active", async () => {
    const [cipherA, cipherB] = await Promise.all([cipherFor(ACCOUNT_A), cipherFor(ACCOUNT_B)])
    switchTo(ACCOUNT_A, cipherA)
    const publishing = publishPromptBody({
      def,
      target: account,
      body: "Mine {{topic}}",
      expectedRev: 0,
    })
    // The publish is awaiting its shipped-body digest when the account switches.
    switchTo(ACCOUNT_B, cipherB)
    await expect(publishing).rejects.toBeInstanceOf(PromptOverrideAccountChangedError)
    expect(await listPromptSlots(def.id)).toEqual([])
    switchTo(ACCOUNT_A, await cipherFor(ACCOUNT_A))
    expect(await listPromptSlots(def.id)).toEqual([])
  })

  it("refuses a write named for the database its slot was read from", async () => {
    const [cipherA, cipherB] = await Promise.all([cipherFor(ACCOUNT_A), cipherFor(ACCOUNT_B)])
    switchTo(ACCOUNT_A, cipherA)
    const slot = await readPromptSlot(def.id, account)
    switchTo(ACCOUNT_B, cipherB)
    await expect(
      savePromptDraft({ def, target: account, body: "x", expectedRev: 0, database: slot.database })
    ).rejects.toBeInstanceOf(PromptOverrideAccountChangedError)
    await expect(
      resetPromptToInherited({ def, target: account, expectedRev: 0, database: slot.database })
    ).rejects.toBeInstanceOf(PromptOverrideAccountChangedError)
    expect(await listPromptSlots(def.id)).toEqual([])
  })
})
