/** @cognia-host-integration-test */
import {
  createDbTestFixture,
  listCallbackBindings,
  seedPlatformBoundSession,
  seedRunningInboundJob,
} from "@/lib/plugin/api/testing"
import { getDb } from "@/lib/db/schema"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { createWorkflowAuthorAPI } from "@/lib/plugin/api/workflow-author-api"

// Exercise host copy without the global React next-intl mock.
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: jest.fn(async (namespace: string) => {
    if (namespace !== "workflows.approvals") throw new Error(`Unexpected namespace: ${namespace}`)
    const { getSettings } = await import("@/lib/db/settings")
    const locale = (await getSettings())?.language === "zh-CN" ? "zh-CN" : "en"
    const messages = jest.requireActual(`@/i18n/messages/${locale}/workflows/approvals.json`)
    return (key: string, values?: Record<string, unknown>) => {
      const template = key.split(".").reduce((value, part) => value[part], messages)
      return template.replace(/\{(\w+)\}/g, (_: string, name: string) =>
        String(values?.[name] ?? "")
      )
    }
  }),
}))
import { buildRunByNameTools } from "./run-by-name-tools"
import { configureWorkflowApi } from "../store-bridge"
import manifestJson from "../../plugin.json"

import { saveSettings } from "@/lib/db/settings"
import { assistantReplyToSegments } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

async function queuedCard(surfaceId: string) {
  const jobs = await getDb().outboundQueue.toArray()
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({
    adapterId: "wecom:a",
    conversationKey: "wecom:wecom:a:room",
    source: "ai-run",
  })
  const card = jobs[0].request.segments.find((segment) => segment.type === "a2ui")
  if (!card || card.type !== "a2ui") throw new Error("Missing host-sent card")
  expect(card.surfaceId).toBe(surfaceId)
  for (const component of ["approve", "cancel"]) {
    const value = (card.content.components[component] as { value: string }).value
    const binding = await resolveCallbackBinding("wecom:a", value)
    expect(binding).toMatchObject({
      surfaceId,
      componentId: component,
      conversationKey: jobs[0].conversationKey,
    })
  }
  const [relayed] = assistantReplyToSegments({
    text: JSON.stringify({ surfaceId, surface: card.content }),
  })
  if (relayed.type !== "a2ui") throw new Error("Missing relayed card")
  expect(relayed.content.components.approve).not.toHaveProperty("value")
  expect(relayed.content.components.cancel).not.toHaveProperty("value")
  return card
}

async function seedSession(opts: { sessionId: string; bindToIM?: boolean }): Promise<void> {
  if (opts.bindToIM)
    await getDb().adapterInstances.put({
      id: "wecom:a",
      type: "wecom",
      displayName: "Test",
      enabled: true,
      transportMode: "stub",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 1,
      updatedAt: 1,
    })
  await seedPlatformBoundSession({
    sessionId: opts.sessionId,
    ...(opts.bindToIM
      ? {
          binding: {
            adapterId: "wecom:a",
            conversationKey: "wecom:wecom:a:room",
            platform: "wecom",
          },
        }
      : {}),
  })
}

configureWorkflowApi(createWorkflowAuthorAPI() as never)
const tools = buildRunByNameTools()
const listTool = tools.find((t) => t.name === "wf_list_workflows")!
const runByNameTool = tools.find((t) => t.name === "wf_run_workflow_by_name")!
const subscribeTool = tools.find((t) => t.name === "wf_subscribe_workflow_fanout")!

const ctx = (sessionId?: string) => ({
  sessionId,
  config: {},
})

// Shared fixture rather than a per-test delete()+reopen — it snapshots and
// restores instead of tearing the Dexie database down, and it binds
// `jest.setTimeout(30_000)`. Without that, this suite inherited Jest 30's 5s
// hook default and its `beforeEach` DB open intermittently timed out under
// full-batch contention. Matches run-typed-tools.test.ts and
// lib/workflow/runtime/execution-authority.test.ts.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("wf_list_workflows", () => {
  it("returns id + name + description for every workflow up to limit", async () => {
    const a = await createWorkflow({ name: "Alpha", description: "the first" })
    const b = await createWorkflow({ name: "Beta" })
    const result = (await listTool.execute({}, ctx())) as {
      ok: boolean
      count: number
      workflows: Array<{ id: string; name: string; description?: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.workflows.map((w) => w.id)).toEqual(expect.arrayContaining([a.id, b.id]))
    const alpha = result.workflows.find((w) => w.id === a.id)
    expect(alpha?.description).toBe("the first")
  })

  it("clamps limit to the documented range", async () => {
    for (let i = 0; i < 3; i++) await createWorkflow({ name: `WF ${i}` })
    const tooBig = (await listTool.execute({ limit: 9999 }, ctx())) as {
      workflows: unknown[]
    }
    expect(tooBig.workflows.length).toBeLessThanOrEqual(200)
    const sane = (await listTool.execute({ limit: 2 }, ctx())) as { workflows: unknown[] }
    expect(sane.workflows).toHaveLength(2)
  })
})

describe("wf_run_workflow_by_name", () => {
  it("rejects when the session has no IM binding", async () => {
    await seedSession({ sessionId: "s1", bindToIM: false })
    await createWorkflow({ name: "Anything" })
    const result = (await runByNameTool.execute({ name: "Anything" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("not-an-im-session")
  })

  it("rejects when the name is empty / whitespace", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const result = (await runByNameTool.execute({ name: "  " }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("invalid-name")
  })

  it("returns workflow-not-found with a list-tool hint", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const result = (await runByNameTool.execute({ name: "zeta-no-match" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("workflow-not-found")
    expect(result.error?.message).toContain("wf_list_workflows")
  })

  it("returns workflow-ambiguous with candidate bullets", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    await createWorkflow({ name: "Report A" })
    await createWorkflow({ name: "Report B" })
    const result = (await runByNameTool.execute({ name: "report" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string; message: string; detail: { candidates: unknown[] } }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("workflow-ambiguous")
    expect(result.error?.detail.candidates).toHaveLength(2)
    expect(result.error?.message).toContain("Report A")
  })

  it("keeps a plugin approval below the calling turn ceiling after live policy widens", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    await getDb().adapterInstances.update("wecom:a", {
      defaultAuthority: "bypassPermissions",
      defaultAutonomy: "autopilot",
    })
    const wf = await createWorkflow({ name: "Parent constrained" })
    await publishWorkflow(wf.id, Date.now())
    recordResolvedPermissionCeiling("s1", { permissionMode: "plan", disallowedTools: ["Bash"] })
    try {
      expect(await runByNameTool.execute({ name: "Parent constrained" }, ctx("s1"))).toMatchObject({
        ok: true,
      })
      const binding = (await listCallbackBindings()).find((row) => row.kind === "wf_approve")
      expect(
        (binding?.payload as { permissionCeiling?: unknown } | undefined)?.permissionCeiling
      ).toMatchObject({
        permissionMode: "plan",
        disallowedTools: expect.arrayContaining(["Bash"]),
      })
    } finally {
      clearResolvedPermissionCeiling("s1")
    }
  })

  it("describes and pins the published graph when its editable draft has changed", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const wf = await createWorkflow({
      name: "Published version",
      description: "PUBLISHED_BEHAVIOR",
    })
    const version = await publishWorkflow(wf.id, Date.now())
    await updateWorkflow(wf.id, { name: "Unpublished draft", description: "UNPUBLISHED_BEHAVIOR" })
    const result = (await runByNameTool.execute({ name: "Unpublished draft" }, ctx("s1"))) as {
      ok: boolean
      workflowName: string
      surface: unknown
    }
    expect(result.ok).toBe(true)
    expect(result.workflowName).toBe("Published version")
    expect(result).not.toHaveProperty("surface")
    const [job] = await getDb().outboundQueue.toArray()
    expect(JSON.stringify(job.request.segments)).toContain("PUBLISHED_BEHAVIOR")
    expect(JSON.stringify(job.request.segments)).not.toContain("UNPUBLISHED_BEHAVIOR")
    const binding = (await listCallbackBindings()).find((row) => row.kind === "wf_approve")
    expect(binding?.payload).toMatchObject({
      workflowName: "Published version",
      lockedDependency: { versionId: version.versionId },
    })
  })

  it("sends one host card with wf_approve / wf_cancel bindings and returns only an acknowledgement", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const wf = await createWorkflow({
      name: "Daily Standup",
      description: "Runs every morning",
    })
    await publishWorkflow(wf.id, Date.now())
    const result = (await runByNameTool.execute(
      { name: "Daily Standup", runParams: { focus: "today" } },
      ctx("s1")
    )) as {
      ok: boolean
      workflowId: string
      surface: { components: Record<string, unknown> }
      surfaceId: string
      instruction: string
    }
    expect(result.ok).toBe(true)
    expect(result.workflowId).toBe(wf.id)
    expect(result.surfaceId.startsWith("wfsurf:")).toBe(true)
    expect(result).toMatchObject({ sent: true })
    expect(result).not.toHaveProperty("surface")
    const card = await queuedCard(result.surfaceId)
    const approve = card.content.components.approve as { value: string }
    const cancel = card.content.components.cancel as { value: string }
    expect(approve.value.startsWith("wfapp:")).toBe(true)
    expect(cancel.value.startsWith("wfcan:")).toBe(true)

    const bindings = await listCallbackBindings()
    const approveBinding = bindings.find((b) => b.kind === "wf_approve")
    const cancelBinding = bindings.find((b) => b.kind === "wf_cancel")
    expect(approveBinding).toBeDefined()
    expect(cancelBinding).toBeDefined()
    expect(approveBinding?.payload).toMatchObject({
      workflowId: wf.id,
      workflowName: "Daily Standup",
      runParams: { focus: "today" },
      triggeredFrom: {
        source: "im",
        adapterId: "wecom:a",
        conversationKey: "wecom:wecom:a:room",
        sessionId: "s1",
      },
    })
    expect(result.instruction).toContain("Do not re-emit")
    // No running inbound job in this harness → operators-only actor scope
    // (plan 2026-07-24 Phase 2).
    expect(approveBinding?.actorScope).toEqual({ mode: "operators" })
    expect(approveBinding?.allowedActions).toEqual(["approve", "cancel"])
    expect(cancelBinding?.actorScope).toEqual({ mode: "operators" })
  })

  it("scopes the approval to the current turn's sender when a job is running", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const scoped = await createWorkflow({ name: "Scoped Flow" })
    await publishWorkflow(scoped.id, Date.now())
    await seedRunningInboundJob({
      adapterId: "wecom:a",
      conversationKey: "wecom:wecom:a:room",
      platform: "wecom",
      sender: { id: "wecom:u_requester", remoteUserId: "u_requester" },
    })

    const result = (await runByNameTool.execute({ name: "Scoped Flow" }, ctx("s1"))) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    const bindings = await listCallbackBindings()
    const approveBinding = bindings.find((b) => b.kind === "wf_approve")
    expect(approveBinding?.actorScope).toEqual({
      mode: "initiator",
      allowedUserIds: ["u_requester"],
    })
    const payload = approveBinding?.payload as
      { triggeredFrom?: { initiator?: { remoteUserId?: string } } } | undefined
    expect(payload?.triggeredFrom?.initiator?.remoteUserId).toBe("u_requester")
  })
})

describe("wf_subscribe_workflow_fanout", () => {
  it("rejects when the session has no IM binding", async () => {
    await seedSession({ sessionId: "s1", bindToIM: false })
    await createWorkflow({ name: "Anything" })
    const result = (await subscribeTool.execute({ name: "Anything" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("not-an-im-session")
  })

  it("rejects empty / unknown / ambiguous name with structured errors", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const empty = (await subscribeTool.execute({ name: "  " }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(empty.error?.code).toBe("invalid-name")

    const notFound = (await subscribeTool.execute({ name: "ghost-flow" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(notFound.error?.code).toBe("workflow-not-found")

    await createWorkflow({ name: "Report A" })
    await createWorkflow({ name: "Report B" })
    const ambiguous = (await subscribeTool.execute({ name: "report" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(ambiguous.error?.code).toBe("workflow-ambiguous")
  })

  it("sends one host fan-out card with working bindings and returns only an acknowledgement", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const wf = await createWorkflow({ name: "Deploy Pipeline" })
    const result = (await subscribeTool.execute({ name: "Deploy Pipeline" }, ctx("s1"))) as {
      ok: boolean
      workflowId: string
      surface: { components: Record<string, unknown> }
      surfaceId: string
      instruction: string
    }
    expect(result).toMatchObject({ ok: true, sent: true })
    expect(result.workflowId).toBe(wf.id)
    expect(result.surfaceId.startsWith("wffanout:")).toBe(true)
    expect(result).not.toHaveProperty("surface")
    expect(result.instruction).toContain("Do not re-emit")
    await queuedCard(result.surfaceId)

    const bindings = await listCallbackBindings()
    const approve = bindings.find((b) => b.kind === "wf_fanout_approve")
    const cancel = bindings.find((b) => b.kind === "wf_fanout_cancel")
    expect(approve).toMatchObject({
      actorScope: { mode: "operators" },
      allowedActions: ["approve", "cancel"],
    })
    expect(cancel).toMatchObject({
      actorScope: { mode: "operators" },
      allowedActions: ["approve", "cancel"],
      payload: approve?.payload,
    })
    expect(approve?.payload).toMatchObject({
      workflowId: wf.id,
      workflowName: "Deploy Pipeline",
      target: {
        adapterId: "wecom:a",
        conversationKey: "wecom:wecom:a:room",
      },
      createdBy: "claude-tool",
    })
  })
})

describe("host fan-out approval card copy", () => {
  it.each([
    ["en", "Subscribe to “Deploy”", "Reply 1 to approve / 2 to cancel"],
    ["zh-CN", "订阅「Deploy」", "回复 1 同意 / 2 取消"],
  ] as const)("uses the host %s bundle", async (language, title, hint) => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    await saveSettings({ language })
    await createWorkflow({ name: "Deploy" })
    const result = (await subscribeTool.execute({ name: "Deploy" }, ctx("s1"))) as {
      ok: boolean
      surfaceId: string
    }
    expect(result).toMatchObject({ ok: true, sent: true })
    const card = await queuedCard(result.surfaceId)
    expect(card.content.title).toBe(title)
    expect(card.plainTextMirror).toContain(hint)
  })

  it("ships every en key in zh-CN", () => {
    expect(Object.keys(manifestJson.i18n.locales["zh-CN"]).sort()).toEqual(
      Object.keys(manifestJson.i18n.locales.en).sort()
    )
  })
})

import {
  recordResolvedPermissionCeiling,
  clearResolvedPermissionCeiling,
} from "@/lib/claude/agents/dispatch-context-registry"
