/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { getDb } from "@/lib/db"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetPluginPromptsForTesting,
  getPluginPromptEntry,
  pluginPromptId,
} from "@/lib/prompts/plugin-prompts"
import {
  __resetPromptResolutionsForTests,
  lastPromptResolution,
} from "@/lib/prompts/resolution-log"
import { publishPromptBody } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { createPromptsAPI } from "./prompts-api"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  __resetPromptResolutionsForTests()
  __resetPluginPromptsForTesting()
})
afterAll(dbFixture.dispose)

const OUTLINE = {
  id: "outline",
  title: "Report outline",
  description: "Plans the sections of a report.",
  defaultBody: "You are a research lead planning a report on {{topic}}.",
  variables: [{ name: "topic", required: true, maxChars: 20 }],
  requiredFragments: ["report"],
  group: "knowledge" as const,
}

async function publish(
  promptId: string,
  target: { scope: "account" | "workspace"; targetId: string },
  body: string
) {
  await publishPromptBody({
    def: getPluginPromptEntry(promptId)!.def,
    target,
    body,
    expectedRev: 0,
  })
}

describe("ctx.prompts", () => {
  it("registers namespaced slots and drops exactly them on unregister", () => {
    const prompts = createPromptsAPI("deep-research")
    const registration = prompts.register([OUTLINE])
    expect(registration.promptIds).toEqual(["plugin:deep-research/outline"])
    expect(getPluginPromptEntry("plugin:deep-research/outline")).toMatchObject({
      title: "Report outline",
      def: { group: "knowledge", risk: "ordinary", consumers: ["plugin:deep-research"] },
    })
    registration.unregister()
    registration.unregister()
    expect(getPluginPromptEntry("plugin:deep-research/outline")).toBeUndefined()
  })

  it("refuses a declaration whose default breaks its own contract", () => {
    const prompts = createPromptsAPI("deep-research")
    expect(() => prompts.register([{ ...OUTLINE, requiredFragments: ["JSON"] }])).toThrow(
      "missing-fragment"
    )
    expect(() => prompts.register("outline" as never)).toThrow("array")
  })

  it("resolves the default with values clipped to their budget", async () => {
    const prompts = createPromptsAPI("deep-research")
    prompts.register([OUTLINE])
    await expect(
      prompts.resolve("outline", { values: { topic: "solid-state batteries in 2026" } })
    ).resolves.toEqual({
      text: "You are a research lead planning a report on solid-state batterie.",
      source: "default",
    })
  })

  it("uses the session's workspace override, else the account one", async () => {
    const prompts = createPromptsAPI("deep-research")
    prompts.register([OUTLINE])
    const id = pluginPromptId("deep-research", "outline")
    await publish(id, { scope: "account", targetId: "" }, "Account: plan a report on {{topic}}.")
    await publish(id, { scope: "workspace", targetId: "ws-1" }, "Workspace: a report on {{topic}}.")
    await getDb().sessions.add({ id: "s-1", projectId: "ws-1" } as never)
    await getDb().sessions.add({ id: "s-2" } as never)

    await expect(
      prompts.resolve("outline", { sessionId: "s-1", values: { topic: "AI" } })
    ).resolves.toEqual({ text: "Workspace: a report on AI.", source: "override" })
    await expect(
      prompts.resolve("outline", { sessionId: "s-2", values: { topic: "AI" } })
    ).resolves.toEqual({ text: "Account: plan a report on AI.", source: "override" })
    await expect(prompts.resolve("outline", { values: { topic: "AI" } })).resolves.toMatchObject({
      source: "override",
    })
  })

  it("offers only the account scope for a prompt declared account-only", async () => {
    const prompts = createPromptsAPI("cognia-repowiki")
    prompts.register([{ ...OUTLINE, scopes: ["account"] }])
    const id = pluginPromptId("cognia-repowiki", "outline")
    expect(getPluginPromptEntry(id)!.def.scopes).toEqual(["account"])

    // The Prompt Center has nowhere to put a workspace override for it.
    await expect(
      publish(id, { scope: "workspace", targetId: "ws-1" }, "Workspace: a report on {{topic}}.")
    ).rejects.toThrow("cannot be overridden at the workspace scope")
    await publish(id, { scope: "account", targetId: "" }, "Account: plan a report on {{topic}}.")
    await expect(prompts.resolve("outline", { values: { topic: "AI" } })).resolves.toEqual({
      text: "Account: plan a report on AI.",
      source: "override",
    })
  })

  it("never resolves another plugin's prompt or an unregistered one", async () => {
    createPromptsAPI("deep-research").register([OUTLINE])
    const other = createPromptsAPI("other-plugin")
    await expect(other.resolve("outline")).rejects.toThrow("not registered by other-plugin")
    await expect(other.resolve("../deep-research/outline")).rejects.toThrow("not registered")
  })

  it("surfaces fallback reasons instead of collapsing snapshot failures into ordinary defaults", async () => {
    const prompts = createPromptsAPI("cognia-repowiki")
    prompts.register([{ ...OUTLINE, scopes: ["account"] }])
    const id = pluginPromptId("cognia-repowiki", "outline")

    const spy = jest
      .spyOn(getDb(), "transaction")
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
    try {
      invalidatePromptOverrideSnapshot()
      await expect(prompts.resolve("outline", { values: { topic: "AI" } })).resolves.toEqual({
        text: "You are a research lead planning a report on AI.",
        source: "default",
        fallback: "snapshot-unavailable",
      })
    } finally {
      spy.mockRestore()
    }

    invalidatePromptOverrideSnapshot()
    await publish(id, { scope: "account", targetId: "" }, "Account: plan a report on {{topic}}.")
    // Re-register with a stricter requiredFragment so the stored override fails contract validation.
    prompts.register([{ ...OUTLINE, scopes: ["account"], requiredFragments: ["report", "lead"] }])
    await expect(prompts.resolve("outline", { values: { topic: "AI" } })).resolves.toMatchObject({
      text: "You are a research lead planning a report on AI.",
      source: "default",
      fallback: "invalid-body",
      skippedRevisionId: expect.any(String),
    })
  })

  it("records Prompt Center usage only when options.record is true", async () => {
    const prompts = createPromptsAPI("deep-research")
    prompts.register([OUTLINE])
    const id = pluginPromptId("deep-research", "outline")

    await prompts.resolve("outline", { values: { topic: "AI" } })
    expect(lastPromptResolution(id)).toBeUndefined()

    await prompts.resolve("outline", { values: { topic: "AI" }, record: true })
    expect(lastPromptResolution(id)).toMatchObject({ promptId: id })
  })
})
