/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { DIFFICULTY_JUDGE_PROMPT } from "@/lib/ai/routing/difficulty-judge"
import {
  PROMPT_PROFILE_KIND,
  PromptProfileFormatError,
  applyPromptProfileImport,
  exportPromptProfile,
  importTargetKey,
  parsePromptProfile,
  previewPromptProfileImport,
  serializePromptProfile,
  type PromptProfileV1,
} from "./profile"
import { publishPromptOverride } from "@/lib/db/prompt-overrides"
import { publishPromptBody, readPromptSlot, shippedBodyDigest } from "./service"
import { invalidatePromptOverrideSnapshot } from "./snapshot"
import { resolvePrompt, resolvePromptAsync } from "./resolve"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }

async function profileWith(
  entries: Array<Partial<PromptProfileV1["entries"][number]>>
): Promise<PromptProfileV1> {
  const baseDigest = await shippedBodyDigest(BRIEF_MODE_PROMPT)
  return {
    kind: PROMPT_PROFILE_KIND,
    schemaVersion: 1,
    exportedAt: "2026-10-20T00:00:00.000Z",
    entries: entries.map((entry) => ({
      promptId: BRIEF_MODE_PROMPT.id,
      scope: "account",
      targetId: "",
      contractVersion: BRIEF_MODE_PROMPT.contractVersion,
      baseDigest,
      body: "Be terse.",
      ...entry,
    })),
  }
}

describe("exportPromptProfile", () => {
  it("exports published overrides only, sorted, with their contract and base digest", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: { scope: "workspace", targetId: "ws-1" },
      body: "Workspace brevity.",
      expectedRev: 0,
    })
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Be terse.",
      expectedRev: 0,
    })
    const profile = await exportPromptProfile({ now: () => new Date("2026-10-20T08:00:00Z") })
    expect(profile.exportedAt).toBe("2026-10-20T08:00:00.000Z")
    expect(profile.entries.map((entry) => [entry.scope, entry.targetId, entry.body])).toEqual([
      ["account", "", "Be terse."],
      ["workspace", "ws-1", "Workspace brevity."],
    ])
    expect(profile.entries[0].baseDigest).toBe(await shippedBodyDigest(BRIEF_MODE_PROMPT))
    const accountOnly = await exportPromptProfile({ scopes: ["account"] })
    expect(accountOnly.entries).toHaveLength(1)
    // Round-trips through the file format.
    expect(parsePromptProfile(serializePromptProfile(profile))).toEqual(profile)
  })
})

describe("parsePromptProfile", () => {
  it("rejects text that is not a prompt profile", () => {
    expect(() => parsePromptProfile("{")).toThrow(PromptProfileFormatError)
    expect(() => parsePromptProfile(JSON.stringify({ kind: "other" }))).toThrow(
      PromptProfileFormatError
    )
    expect(() =>
      parsePromptProfile(
        JSON.stringify({ kind: PROMPT_PROFILE_KIND, schemaVersion: 2, exportedAt: "", entries: [] })
      )
    ).toThrow(PromptProfileFormatError)
  })
})

describe("previewPromptProfileImport", () => {
  it("classifies every entry without writing", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Old.",
      expectedRev: 0,
    })
    const profile = await profileWith([
      { body: "Old." },
      { scope: "workspace", targetId: "far-ws", body: "Mapped." },
      { scope: "workspace", targetId: "unmapped-ws", body: "Unmapped." },
      { promptId: "nope.missing" },
      { contractVersion: 99 },
      { scope: "session", targetId: "s1" },
      { body: "Contact me at dana@example.com, card 4111 1111 1111 1111." },
      { promptId: DIFFICULTY_JUDGE_PROMPT.id, body: "no tier contract at all" },
    ])
    const preview = await previewPromptProfileImport(profile, {
      [importTargetKey({ scope: "workspace", targetId: "far-ws" })]: "ws-local",
    })
    expect(preview.map((item) => item.status)).toEqual([
      "unchanged",
      "new",
      "needs-target",
      "unknown-prompt",
      "contract-mismatch",
      "scope-unsupported",
      "invalid",
      "invalid",
    ])
    expect(preview[1].target).toEqual({ scope: "workspace", targetId: "ws-local" })
    expect(preview[6].issues.map((issue) => issue.code)).toContain("pii")
    expect(preview[7].issues.map((issue) => issue.code)).toContain("missing-fragment")
    // Nothing was published by the preview.
    expect(
      (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-local" }))
        .binding
    ).toBeUndefined()
  })

  it("flags text written against an older shipped default", async () => {
    const preview = await previewPromptProfileImport(
      await profileWith([{ baseDigest: "sha256:old" }])
    )
    expect(preview[0]).toMatchObject({ status: "new", upstreamChanged: true })
  })
})

describe("applyPromptProfileImport", () => {
  it("publishes only the selected applicable entries and makes them resolve", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Old.",
      expectedRev: 0,
    })
    const profile = await profileWith([
      { body: "Imported brevity." },
      { scope: "workspace", targetId: "far-ws", body: "Mapped." },
      { promptId: "nope.missing" },
    ])
    const preview = await previewPromptProfileImport(profile, { "workspace:far-ws": "ws-local" })
    expect(preview.map((item) => item.status)).toEqual(["replace", "new", "unknown-prompt"])
    const result = await applyPromptProfileImport(preview, new Set([0, 2]))
    expect(result).toEqual({ applied: 1, conflicted: [] })
    expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Imported brevity.")
    const slot = await readPromptSlot(BRIEF_MODE_PROMPT.id, account)
    expect(slot.active?.origin).toBe("import")
    expect(
      (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-local" }))
        .binding
    ).toBeUndefined()
  })

  it("reports a slot edited since the preview instead of overwriting it", async () => {
    const preview = await previewPromptProfileImport(await profileWith([{ body: "From file." }]))
    expect(preview[0].status).toBe("new")
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Typed meanwhile.",
      expectedRev: 0,
    })
    const result = await applyPromptProfileImport(preview, new Set([0]))
    expect(result.applied).toBe(0)
    expect(result.conflicted).toHaveLength(1)
    expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Typed meanwhile.")
  })

  // F02: a "replace" preview used to re-read the slot at apply time and
  // publish over whatever someone else had published since.
  it("never replaces text published after the preview it was reviewed in", async () => {
    const first = await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Reviewed.",
      expectedRev: 0,
    })
    const preview = await previewPromptProfileImport(await profileWith([{ body: "From file." }]))
    expect(preview[0]).toMatchObject({ status: "replace", baseRev: first.rev })
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Published meanwhile.",
      expectedRev: first.rev,
    })
    const result = await applyPromptProfileImport(preview, new Set([0]))
    expect(result).toEqual({ applied: 0, conflicted: [preview[0]] })
    expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Published meanwhile.")
  })

  // F16: the same text published under an older contract is skipped by the
  // resolver, so importing it for the current contract is a real change.
  it("re-publishes the same text when the slot holds it under an older contract", async () => {
    await publishPromptOverride({
      promptId: BRIEF_MODE_PROMPT.id,
      target: account,
      body: "Be terse.",
      contractVersion: BRIEF_MODE_PROMPT.contractVersion - 1,
      baseDigest: await shippedBodyDigest(BRIEF_MODE_PROMPT),
      expectedRev: 0,
      mutationId: "older-contract",
      origin: "editor",
    })
    expect((await resolvePromptAsync(BRIEF_MODE_PROMPT)).source).toMatchObject({
      kind: "default",
      fallback: "contract-incompatible",
    })
    const preview = await previewPromptProfileImport(await profileWith([{ body: "Be terse." }]))
    expect(preview[0].status).toBe("replace")
    expect(await applyPromptProfileImport(preview, new Set([0]))).toEqual({
      applied: 1,
      conflicted: [],
    })
    expect(resolvePrompt(BRIEF_MODE_PROMPT)).toMatchObject({
      text: "Be terse.",
      source: { kind: "override" },
    })
  })

  it("still reports the current contract's identical text as unchanged", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Be terse.",
      expectedRev: 0,
    })
    const preview = await previewPromptProfileImport(await profileWith([{ body: "Be terse." }]))
    expect(preview[0].status).toBe("unchanged")
  })

  it("aborts the entire batch with zero writes when the active account switches before commit (T12)", async () => {
    const { activateAccountDatabase, clearAccountDatabaseSelection, getDb } =
      await import("@/lib/db/schema")
    const { encryptedAccountDatabaseName } = await import("@/lib/accounts/account-db")
    const { AccountContentCipher, activateAccountContentCipher, lockAccountContentCipher } =
      await import("@/lib/accounts/content-cipher")
    const acctA = "acct_profile_batch_a"
    const acctB = "acct_profile_batch_b"
    const switchTo = async (id: string, fill: number) => {
      const cipher = await AccountContentCipher.fromRawKey(
        id,
        encryptedAccountDatabaseName(id),
        new Uint8Array(32).fill(fill)
      )
      activateAccountContentCipher(cipher)
      activateAccountDatabase(id)
    }
    try {
      await switchTo(acctA, 7)
      const profile = await profileWith([
        { body: "Entry one." },
        { scope: "workspace", targetId: "ws-src", body: "Entry two." },
      ])
      const preview = await previewPromptProfileImport(profile, { "workspace:ws-src": "ws-local" })
      expect(preview).toHaveLength(2)

      await switchTo(acctB, 8)
      await expect(applyPromptProfileImport(preview, new Set([0, 1]))).rejects.toMatchObject({
        code: "prompt_override_account_changed",
      })
      expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).binding).toBeUndefined()

      await switchTo(acctA, 7)
      expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).binding).toBeUndefined()
      expect(
        (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-local" }))
          .binding
      ).toBeUndefined()
    } finally {
      for (const [id, fill] of [
        [acctA, 7],
        [acctB, 8],
      ] as const) {
        await switchTo(id, fill)
        await getDb().delete()
      }
      lockAccountContentCipher()
      clearAccountDatabaseSelection()
      invalidatePromptOverrideSnapshot()
    }
  })
})
