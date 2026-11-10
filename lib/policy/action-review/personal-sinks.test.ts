/** @jest-environment jsdom */

// These tests exercise the real personal gate and real Dexie receipts. Only
// external transports and the Host's adapter audience evidence are replaced.
jest.mock("@/lib/connectors/personal-delivery", () => ({
  resolveConnectorSinkAudience: jest.fn(async () => ({ kind: "group" })),
}))

import { z } from "zod"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { PersonalSinkWithheldError } from "@/lib/execution/personal-sink"
import { sha256String } from "@/lib/utils/hash"
import { resolveConnectorSinkAudience } from "@/lib/connectors/personal-delivery"
import { runBuiltInSkill } from "@/lib/skills/built-in/dispatcher"
import {
  registerBuiltInSkill,
  __resetSharedBuiltInSkillRegistry,
} from "@/lib/skills/built-in/registry"
import { buildConfirmSurface } from "@/lib/skills/built-in/_shared/confirm-surface"
import { answerWithOutboundPolicy, planOutboundAsk } from "./plan-tool-call"
import { planIntegrationWrite } from "./plan-integration"
import { planBrowserSubmission } from "./plan-browser"
import { gateBrowserEngine } from "@/lib/browser/submission-gate"
import type { BrowserEngine } from "@/lib/browser/agent-engine"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  jest.mocked(resolveConnectorSinkAudience).mockResolvedValue({ kind: "group" })
})
afterAll(fixture.dispose)

const mark = { person: { kind: "local-person" as const }, source: "private-calendar", markedAt: 1 }
const request = {
  sessionId: "chat",
  requestId: "send",
  toolName: "mcp__cognia-plugin-tools__connectors_send_message",
  input: { conversationKey: "lark:bot:oc_group", text: "private summary" },
}
const origin = { rootSessionId: "chat", instructionEpoch: "u1" }

async function markedRun() {
  const run = await startToolExecutionRun("chat", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, { personalMarks: [mark] })
  return run.id
}

it.each(["off", "shadow", "enforce"])(
  "denies a group tool before operator approval in %s mode",
  async (mode) => {
    const executionRunId = await markedRun()
    const approve = jest.fn(async () => ({ decision: "allow" as const }))
    const result = await answerWithOutboundPolicy(
      request,
      {
        executionRunId,
        unattended: false,
        origin,
        settings: () => ({ agentPermissions: { outboundAuthorization: mode } }),
      },
      approve
    )
    expect(result).toMatchObject({
      decision: "deny",
      message: expect.stringMatching(/Only that person can disclose/),
    })
    expect(approve).not.toHaveBeenCalled()
    const [receipt] = await getDb().actionReviewReceipts.toArray()
    expect(receipt.personal).toMatchObject({
      outcome: "withheld",
      persons: [mark.person],
      originalTarget: expect.objectContaining({ kind: "conversation" }),
    })
    expect(receipt.personal).not.toHaveProperty("contentHash")
  }
)

it("answers an interactive private-content request with a denial, never a card", async () => {
  const executionRunId = await markedRun()
  const answer = jest.fn(async () => {})
  expect(
    await planOutboundAsk(request, { executionRunId, unattended: false, origin }, answer)
  ).toEqual({ answered: true })
  expect(answer).toHaveBeenCalledWith("deny", expect.stringMatching(/personal content/), {
    authority: "policy-deny",
  })
})

it("rechecks after an operator answer so new personal content cannot inherit approval", async () => {
  const run = await startToolExecutionRun("chat", { localAuthorization: LOCAL_PERSON_RUN })
  const result = await answerWithOutboundPolicy(
    request,
    {
      executionRunId: run.id,
      unattended: false,
      origin,
      configuredGrants: async () => [],
      settings: () => ({ agentPermissions: { outboundAuthorization: "enforce" } }),
    },
    async () => {
      await getDb().executionRuns.update(run.id, { personalMarks: [mark] })
      return { decision: "allow" }
    }
  )
  expect(result.decision).toBe("deny")
})

it("denies instead of asking when personal receipt persistence fails", async () => {
  const executionRunId = await markedRun()
  const fail = () => {
    throw new Error("receipt unavailable")
  }
  getDb().actionReviewReceipts.hook("creating", fail)
  const respond = jest.fn(async () => ({ decision: "allow" as const }))
  try {
    const result = await answerWithOutboundPolicy(
      request,
      { executionRunId, unattended: false, origin },
      respond
    )
    expect(result.decision).toBe("deny")
    expect(respond).not.toHaveBeenCalled()
  } finally {
    getDb().actionReviewReceipts.hook("creating").unsubscribe(fail)
  }
})

it("allows an opaque tool descriptor when the Host proves its recipient is the marked person", async () => {
  const executionRunId = await markedRun()
  jest
    .mocked(resolveConnectorSinkAudience)
    .mockResolvedValue({ kind: "person", person: mark.person })
  const respond = jest.fn(async () => ({ decision: "allow" as const }))
  expect(
    (
      await answerWithOutboundPolicy(
        request,
        {
          executionRunId,
          unattended: false,
          origin,
          configuredGrants: async () => [],
          settings: () => ({ agentPermissions: {} }),
        },
        respond
      )
    ).decision
  ).toBe("allow")
  expect(resolveConnectorSinkAudience).toHaveBeenCalled()
  await expect(jest.mocked(resolveConnectorSinkAudience).mock.results[0].value).resolves.toEqual({
    kind: "person",
    person: mark.person,
  })
  expect(respond).toHaveBeenCalled()
  expect(
    await getDb()
      .actionReviewReceipts.filter((row) => !!row.personal)
      .count()
  ).toBe(0)
})

it("withholds an approved Squad integration write with its exact payload hash", async () => {
  await startToolExecutionRun(undefined, {
    runId: "execution:team:team-run",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await getDb().executionRuns.update("execution:team:team-run", { personalMarks: [mark] })
  await expect(
    planIntegrationWrite({
      targets: [
        { kind: "repository", channel: "github", recipient: "github:github.com/acme/repo" },
      ],
      operation: "github.publishStack",
      payload: "private summary",
      authorization: {
        kind: "team-delivery",
        teamId: "team",
        runId: "team-run",
        decidedBy: "person",
      },
    })
  ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
  const [receipt] = await getDb().actionReviewReceipts.toArray()
  expect(receipt.personal?.contentHash).toBe(await sha256String("private summary"))
})

it("withholds opaque integration operations without hashing the operation descriptor", async () => {
  const executionRunId = await markedRun()
  await expect(
    planIntegrationWrite({
      targets: [{ kind: "unknown", channel: "integration", recipient: "plugin-action" }],
      operation: "plugin.uploadFile",
      authorization: { kind: "tool-call", pluginId: "plugin", sessionId: "chat", executionRunId },
    })
  ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
  const [receipt] = await getDb().actionReviewReceipts.toArray()
  expect(receipt.personal?.outcome).toBe("withheld")
  expect(receipt.personal).not.toHaveProperty("contentHash")
})

it("withholds opaque browser submissions without creating a disclosable hash", async () => {
  const executionRunId = await markedRun()
  await expect(
    planBrowserSubmission({
      url: "https://forms.test/submit",
      operation: "POST",
      basis: "request",
      asker: { kind: "chat", sessionId: "chat", executionRunId },
    })
  ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
  const [receipt] = await getDb().actionReviewReceipts.toArray()
  expect(receipt.personal?.outcome).toBe("withheld")
  expect(receipt.personal).not.toHaveProperty("contentHash")
})

it("stops opaque browser actions before the engine sends any content", async () => {
  const executionRunId = await markedRun()
  const act = jest.fn(async () => ({ ok: true }))
  const navigate = jest.fn(async () => ({ ok: true }))
  const engine = {
    act,
    navigate,
    getPage: async () => ({ url: "https://forms.test/edit" }),
  } as unknown as BrowserEngine
  const gated = gateBrowserEngine(engine, { kind: "chat", sessionId: "chat", executionRunId })
  await expect(gated.act("r1", "type", { text: "private summary" })).rejects.toBeInstanceOf(
    PersonalSinkWithheldError
  )
  await expect(gated.navigate("https://forms.test/private")).rejects.toBeInstanceOf(
    PersonalSinkWithheldError
  )
  expect(act).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
  const receipts = await getDb().actionReviewReceipts.toArray()
  expect(receipts.map((row) => row.personal?.originalTarget).sort()).toEqual([
    "https://forms.test/edit",
    "https://forms.test/private",
  ])
  expect(receipts.every((row) => row.personal && !Object.hasOwn(row.personal, "contentHash"))).toBe(
    true
  )
})

it.each(["lark.doc", "issue"])(
  "withholds %s writes before an operator's confirmation bypass",
  async (family) => {
    const executionRunId = await markedRun()
    __resetSharedBuiltInSkillRegistry()
    const execute = jest.fn(async () => ({ ok: true }))
    registerBuiltInSkill({
      id: `${family}.private_write`,
      family,
      mcpToolName: "lark_doc_private_write",
      label: { en: "Write", "zh-CN": "写入" },
      description: { en: "Write", "zh-CN": "写入" },
      platforms: ["lark"],
      mutation: "write",
      imAccess: "always",
      inputSchema: z.object({ content: z.string() }),
      hitlSurface: () =>
        buildConfirmSurface({ surfaceId: "confirm", title: "Write", summary: "Write" }),
      execute,
    })
    expect(
      await runBuiltInSkill(
        `${family}.private_write`,
        { content: "private summary" },
        {
          sessionId: "chat",
          executionRunId,
          hitlBypass: true,
        }
      )
    ).toMatchObject({
      status: "denied",
      message: expect.stringMatching(/Only that person can disclose/),
    })
    expect(execute).not.toHaveBeenCalled()
    const [receipt] = await getDb().actionReviewReceipts.toArray()
    expect(receipt.personal?.outcome).toBe("withheld")
    expect(receipt.personal).not.toHaveProperty("contentHash")
  }
)

it("withholds site tools and issue/site workflow writes before backend access", async () => {
  const executionRunId = await markedRun()
  const { toolFamily } = await import("@/lib/sites/agent-tools")
  for (const name of ["build_site", "deploy_site"]) {
    await expect(toolFamily.run(name, {}, { executionRunId } as never)).rejects.toBeInstanceOf(
      PersonalSinkWithheldError
    )
  }
  await getDb().executionRuns.put({
    ...(await getDb().executionRuns.get(executionRunId))!,
    id: "execution:workflow:private-write",
    actingIdentity: {
      ...(await getDb().executionRuns.get(executionRunId))!.actingIdentity!,
      rootRunId: "execution:workflow:private-write",
    },
  })
  await import("@/lib/sites/workflow-nodes")
  await import("@/lib/workflow/nodes/issues")
  const { getExecutor } = await import("@/lib/workflow/nodes/registry")
  for (const kind of [
    "action.site.build",
    "action.site.deploy",
    "action.site.rollback",
    "action.issue.create",
    "action.issue.update",
    "action.issue.assign",
    "action.issue.comment",
    "action.issue.label",
  ]) {
    await expect(
      getExecutor(kind as never, 1)!.execute({ runId: "private-write", params: {} } as never)
    ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
  }
  const receipts = await getDb().actionReviewReceipts.toArray()
  expect(receipts).toHaveLength(10)
  expect(
    receipts.every(
      (row) => row.personal?.outcome === "withheld" && !Object.hasOwn(row.personal, "contentHash")
    )
  ).toBe(true)
})

it("withholds plugin issue mutations using the Host invocation before any issue lookup", async () => {
  const executionRunId = await markedRun()
  const { withPluginExecutionContext } = await import("@/lib/plugin/core/invocation-identity")
  const { createIssuesAPI } = await import("@/lib/plugin/api/issues-api")
  const { getPermissionGuard } = await import("@/lib/plugin/security/permission-guard")
  const guard = jest.spyOn(getPermissionGuard(), "check").mockReturnValue(true)
  try {
    const api = createIssuesAPI("private-issues")
    for (const operation of [
      () => api.create({ title: "Private" }),
      () => api.update("absent", { title: "Private" }),
      () => api.assign("absent", null),
      () => api.comment("absent", "Private"),
      () => api.label("absent", { add: ["Private"] }),
    ]) {
      await expect(
        withPluginExecutionContext<Promise<unknown>>(
          "private-issues",
          { executionRunId },
          operation
        )
      ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
    }
    expect(await getDb().issues.count()).toBe(0)
  } finally {
    guard.mockRestore()
  }
})
