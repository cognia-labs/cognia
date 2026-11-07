/** @jest-environment node */
import type { ChatSession } from "@cognia/agent-config-types"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { buildSquadStartInput, type SquadStartSurface } from "./build-start-input"

const session = { id: "chat-1", title: "t" } as ChatSession
const build = (surface: SquadStartSurface, extra: Record<string, unknown> = {}) =>
  buildSquadStartInput({ squadId: "sq-1", surface, ...extra })

describe("buildSquadStartInput", () => {
  it("carries a person's authority only for gestures made on this device", () => {
    expect(build({ kind: "chat", person: true, session }).localAuthorization).toBe(LOCAL_PERSON_RUN)
    expect(build({ kind: "console" }).localAuthorization).toBe(LOCAL_PERSON_RUN)
    expect(build({ kind: "companion", deviceId: "dev-1" }).localAuthorization).toBe(
      LOCAL_PERSON_RUN
    )
    for (const surface of [
      { kind: "chat", person: false, session },
      { kind: "scheduler" },
      { kind: "plugin" },
      { kind: "remote" },
      { kind: "evaluation" },
      { kind: "issue" },
      { kind: "workflow", workflowRunId: "wf-1" },
      { kind: "retry", replacesRunId: "execution:team:old" },
      { kind: "child", origin: "delegation" },
      { kind: "im", triggeredFrom: { source: "im" } },
    ] as SquadStartSurface[]) {
      expect(build(surface)).not.toHaveProperty("localAuthorization")
    }
  })

  it("starts a conversation's run in that conversation, entering as its persona", () => {
    expect(build({ kind: "chat", person: true, session, characterId: "char-1" })).toEqual({
      squadId: "sq-1",
      goal: "",
      localAuthorization: LOCAL_PERSON_RUN,
      origin: "chat",
      triggeredFrom: { source: "chat", sessionId: "chat-1" },
      session,
      characterId: "char-1",
    })
  })

  it("names a conversation it could not load by id, without starting in it", () => {
    const input = build({ kind: "chat", person: false, sessionId: "chat-9" })
    expect(input.triggeredFrom).toEqual({ source: "chat", sessionId: "chat-9" })
    expect(input).not.toHaveProperty("session")
  })

  it("keeps the console and a paired device on the interactive gates", () => {
    expect(build({ kind: "console" })).toMatchObject({
      origin: "interactive",
      triggeredFrom: { source: "ui" },
    })
    expect(build({ kind: "companion", deviceId: "dev-1" })).toMatchObject({
      origin: "interactive",
      triggeredFrom: { source: "api", deviceId: "dev-1" },
    })
  })

  it("binds an IM run to its conversation and passes its policy through", () => {
    const delegate = async () => undefined
    const triggeredFrom = { source: "im" as const, adapterId: "lark", conversationKey: "c-1" }
    expect(
      build({
        kind: "im",
        triggeredFrom,
        session,
        characterId: "char-1",
        permissionCeiling: { permissionMode: "default" },
        requirePlanApprovalFloor: true,
        planApprovalDelegate: delegate,
      })
    ).toEqual({
      squadId: "sq-1",
      goal: "",
      origin: "im",
      triggeredFrom,
      session,
      bindConnectorRun: true,
      characterId: "char-1",
      permissionCeiling: { permissionMode: "default" },
      requirePlanApprovalFloor: true,
      planApprovalDelegate: delegate,
    })
    expect(build({ kind: "im", triggeredFrom })).not.toHaveProperty("bindConnectorRun")
  })

  it("runs a Bot's step under its ceiling", () => {
    expect(
      build({
        kind: "bot",
        triggeredFrom: { source: "bot" },
        permissionCeiling: { permissionMode: "plan" },
      })
    ).toEqual({
      squadId: "sq-1",
      goal: "",
      origin: "bot",
      triggeredFrom: { source: "bot" },
      permissionCeiling: { permissionMode: "plan" },
    })
  })

  it("records a scheduled run as the schedule's", () => {
    expect(build({ kind: "scheduler" })).toMatchObject({
      origin: "scheduler",
      triggeredFrom: { source: "schedule" },
    })
  })

  it("makes a workflow's run its child, headless and reporting back when it came from IM", () => {
    const knowledgeAccess = {
      entrypoint: "manual",
      revisionBindings: { kb1: ["gen-1"] },
      allowedKnowledgeBaseIds: ["kb1"],
    } as never
    expect(
      build({
        kind: "workflow",
        workflowRunId: "wf-1",
        conversation: { adapterId: "lark", conversationKey: "c-1", sessionId: "chat-1" },
        knowledgeAccess,
        triggerChainDepth: 2,
      })
    ).toEqual({
      squadId: "sq-1",
      goal: "",
      origin: "im",
      triggeredFrom: {
        source: "im",
        adapterId: "lark",
        conversationKey: "c-1",
        sessionId: "chat-1",
      },
      launchedByRunId: "execution:workflow:wf-1",
      knowledgeAccess,
      triggerChainDepth: 2,
    })
    expect(build({ kind: "workflow", workflowRunId: "wf-2" })).toEqual({
      squadId: "sq-1",
      goal: "",
      origin: "interactive",
      triggeredFrom: { source: "ui" },
      launchedByRunId: "execution:workflow:wf-2",
    })
  })

  it("replaces a run with its frozen authority and the conversation it belonged to", () => {
    const executionConstraints = { version: 1 } as never
    expect(
      build({
        kind: "retry",
        replacesRunId: "execution:team:old",
        sessionId: "chat-1",
        executionConstraints,
      })
    ).toEqual({
      squadId: "sq-1",
      goal: "",
      origin: "interactive",
      triggeredFrom: { source: "ui" },
      parentRunId: "execution:team:old",
      executionConstraints,
      session: { id: "chat-1" },
    })
  })

  it("launches a child run under its parent with the gate policy its surface asked for", () => {
    expect(
      build(
        {
          kind: "child",
          origin: "delegation",
          launchedByRunId: "execution:job:parent",
          sessionId: "chat-1",
        },
        { goal: "write hello", ultracode: true }
      )
    ).toEqual({
      squadId: "sq-1",
      goal: "write hello",
      ultracode: true,
      origin: "delegation",
      triggeredFrom: { source: "api" },
      launchedByRunId: "execution:job:parent",
      session: { id: "chat-1" },
    })
  })

  it("passes the caller's run id and the API surfaces' origins", () => {
    expect(build({ kind: "plugin" }, { runId: "run_team_x" })).toMatchObject({
      runId: "run_team_x",
      origin: "api",
      triggeredFrom: { source: "api" },
    })
    expect(build({ kind: "remote" })).toMatchObject({
      origin: "remote",
      triggeredFrom: { source: "api" },
    })
    expect(build({ kind: "evaluation" })).toMatchObject({
      origin: "evaluation",
      triggeredFrom: { source: "api" },
    })
    expect(build({ kind: "issue" })).toMatchObject({
      origin: "interactive",
      triggeredFrom: { source: "ui" },
    })
  })
})
