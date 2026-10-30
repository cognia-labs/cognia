jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  managedDesktopClient: { listConfigs: jest.fn() },
}))
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  ...jest.requireActual("@/lib/automation/managed-desktop-handoff-client"),
  managedDesktopHandoffClient: {
    deliveries: jest.fn(),
    acceptanceCheckpoint: jest.fn(),
    acceptanceComplete: jest.fn(),
    prepare: jest.fn(),
    acceptanceStart: jest.fn(),
  },
}))
jest.mock("@/lib/automation/managed-desktop-results-client", () => ({
  createManagedDesktopResultsScope: jest.fn(),
}))
import { getSession } from "@/lib/db/sessions"
import { managedDesktopClient } from "@/lib/automation/managed-desktop-client"
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"
import { createManagedDesktopResultsScope } from "@/lib/automation/managed-desktop-results-client"
import {
  ACCEPTANCE_BUILTIN_PLUGIN_ID,
  buildAcceptanceManifestEntries,
  buildAcceptanceProposalManifestEntries,
  isAcceptanceBuiltinTool,
  isAcceptanceProposalTool,
  runAcceptanceBuiltinTool,
  runAcceptanceProposalTool,
} from "./acceptance-builtin-tools"

const api = jest.mocked(managedDesktopHandoffClient)
const criteria = [{ description: "Page loads", screenshotRequired: true }]
const delivery = {
  id: "delivery",
  revision: 1,
  branch: "feature",
  commit: "a".repeat(40),
  modes: ["commit" as const],
  createdAt: 1,
}
const dispose = jest.fn()
const get = jest.fn()
beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(getSession)
    .mockResolvedValue({ id: "child", managedAcceptance: { acceptanceId: "acceptance" } } as never)
  api.acceptanceCheckpoint.mockResolvedValue({ id: "artifact" } as never)
  api.acceptanceComplete.mockResolvedValue({} as never)
  api.deliveries.mockResolvedValue([delivery])
  jest.mocked(managedDesktopClient.listConfigs).mockResolvedValue([
    {
      enabled: true,
      price: { currency: "USD", hourlyRateMicros: 165600, expiresAt: Date.now() + 10000 },
    },
  ] as never)
  get.mockResolvedValue({ artifacts: [{ id: "artifact", criterionId: "criterion-0" }] })
  jest
    .mocked(createManagedDesktopResultsScope)
    .mockReturnValue({ get, dispose, assertActive: jest.fn() } as never)
})

test("manifests and matchers isolate child tools from the proposal tool", () => {
  expect(buildAcceptanceManifestEntries().map((entry) => entry.name)).toEqual([
    "acceptance_checkpoint",
    "acceptance_complete",
  ])
  expect(buildAcceptanceProposalManifestEntries()).toEqual([
    expect.objectContaining({ name: "propose_acceptance", pluginId: ACCEPTANCE_BUILTIN_PLUGIN_ID }),
  ])
  expect(isAcceptanceBuiltinTool("mcp__cognia-plugin-tools__acceptance_checkpoint")).toBe(true)
  expect(isAcceptanceBuiltinTool("propose_acceptance")).toBe(false)
  expect(isAcceptanceProposalTool("mcp__cognia-plugin-tools__propose_acceptance")).toBe(true)
})
test("checkpoint binds evidence to the persisted run and calling child, with a stable retry key", async () => {
  const run = () =>
    runAcceptanceBuiltinTool(
      "acceptance_checkpoint",
      { criterionId: "criterion-0" },
      { sessionId: "child" }
    )
  expect(await run()).toEqual({ ok: true, code: "recorded", artifactId: "artifact" })
  await run()
  expect(api.acceptanceCheckpoint).toHaveBeenNthCalledWith(2, {
    acceptanceId: "acceptance",
    sessionKey: "child",
    criterionId: "criterion-0",
    idempotencyKey: "checkpoint:criterion-0",
  })
})
test("completion reuses retained evidence metadata, preserves notes and sends the Host's exact shape", async () => {
  const input = {
    outcome: "passed",
    criteria: [{ criterionId: "criterion-0", outcome: "passed", note: "Visible" }],
    summary: "Done",
  }
  expect(
    await runAcceptanceBuiltinTool("acceptance_complete", input, { sessionId: "child" })
  ).toEqual({ ok: true, code: "recorded" })
  expect(api.acceptanceComplete).toHaveBeenCalledWith({
    acceptanceId: "acceptance",
    sessionKey: "child",
    idempotencyKey: "complete:acceptance",
    outcome: "passed",
    criteria: [{ criterionId: "criterion-0", outcome: "passed", artifactIds: ["artifact"] }],
    summary: "Done\ncriterion-0: Visible",
  })
  expect(dispose).toHaveBeenCalledTimes(1)
})
test.each([null, { criterionId: "forged" }, { criterionId: "criterion-0", acceptanceId: "other" }])(
  "invalid checkpoint %j cannot write",
  async (input) => {
    expect(
      await runAcceptanceBuiltinTool("acceptance_checkpoint", input, { sessionId: "child" })
    ).toEqual({ ok: false, code: "invalid_arguments" })
    expect(api.acceptanceCheckpoint).not.toHaveBeenCalled()
  }
)
test("ordinary sessions cannot record evidence; failures never throw or expose backend text", async () => {
  jest.mocked(getSession).mockResolvedValue({ id: "source" } as never)
  expect(
    await runAcceptanceBuiltinTool(
      "acceptance_checkpoint",
      { criterionId: "criterion-0" },
      { sessionId: "source" }
    )
  ).toEqual({ ok: false, code: "acceptance_session_required" })
  jest.mocked(getSession).mockRejectedValue(new Error("private credential"))
  expect(await runAcceptanceBuiltinTool("acceptance_complete", {}, { sessionId: "child" })).toEqual(
    { ok: false, code: "acceptance_tool_failed" }
  )
})
test("proposal validates and reads only deliveries/configs; it has no prepare or spending path", async () => {
  jest.mocked(getSession).mockResolvedValue({ id: "source" } as never)
  expect(
    await runAcceptanceProposalTool(
      { deliveryId: "delivery", criteria, summary: "Review" },
      { sessionId: "source" }
    )
  ).toEqual({
    ok: true,
    proposal: {
      delivery,
      criteria,
      summary: "Review",
      estimate: { currency: "USD", hourlyRateMicros: 165600 },
    },
  })
  expect(api.prepare).not.toHaveBeenCalled()
  expect(api.acceptanceStart).not.toHaveBeenCalled()
  expect(api.acceptanceCheckpoint).not.toHaveBeenCalled()
  expect(api.acceptanceComplete).not.toHaveBeenCalled()
})
test("proposal rejects child/invalid/missing delivery and returns safe failures", async () => {
  expect(await runAcceptanceProposalTool({ criteria }, { sessionId: "child" })).toEqual({
    ok: false,
    code: "acceptance_source_session_required",
  })
  expect(await runAcceptanceProposalTool({ criteria: [] }, { sessionId: "source" })).toEqual({
    ok: false,
    code: "invalid_arguments",
  })
  jest.mocked(getSession).mockResolvedValue({ id: "source" } as never)
  expect(
    await runAcceptanceProposalTool({ criteria, deliveryId: "missing" }, { sessionId: "source" })
  ).toEqual({ ok: false, code: "acceptance_delivery_unavailable" })
  api.deliveries.mockRejectedValue(new Error("private path"))
  expect(await runAcceptanceProposalTool({ criteria }, { sessionId: "source" })).toEqual({
    ok: false,
    code: "acceptance_proposal_failed",
  })
})
test("completion rejects duplicate criteria, invalid outcomes and oversized UTF-8 notes before reading evidence", async () => {
  for (const input of [
    { outcome: "passed", summary: "", criteria: [{ criterionId: "criterion-0", outcome: "pass" }] },
    {
      outcome: "passed",
      summary: "",
      criteria: Array(2).fill({ criterionId: "criterion-0", outcome: "passed" }),
    },
    {
      outcome: "passed",
      summary: "",
      criteria: [{ criterionId: "criterion-0", outcome: "passed", note: "中".repeat(342) }],
    },
  ])
    expect(
      await runAcceptanceBuiltinTool("acceptance_complete", input, { sessionId: "child" })
    ).toEqual({ ok: false, code: "invalid_arguments" })
  expect(api.acceptanceComplete).not.toHaveBeenCalled()
  expect(createManagedDesktopResultsScope).not.toHaveBeenCalled()
})
