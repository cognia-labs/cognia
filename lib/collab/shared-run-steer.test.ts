import type { ChatSession, RunLease, SessionEvent } from "@cognia/agent-config-types"
import { CollabError } from "./client"
import type { CurrentCollabContext } from "./runtime-client"
import {
  __resetSharedRunSteerForTesting,
  applySharedRunSteer,
  createSharedSessionSteerLane,
  steerSharedFollowUp,
  type SharedRunSteerDeps,
} from "./shared-run-steer"
import type { SteerOutcome, SteerRequest } from "@/lib/execution/steer"

const SHARED: Pick<ChatSession, "id" | "collaboration"> = {
  id: "local-1",
  collaboration: {
    orgId: "org",
    sessionId: "shared-1",
    workspaceId: "ws",
    endpoint: "https://collab.example",
  } as ChatSession["collaboration"],
}

function client() {
  return {
    baseUrl: "https://collab.example",
    getActiveSessionRunLease: jest.fn(
      async (): Promise<RunLease | null> => ({ runId: "run-7" }) as RunLease
    ),
    steerSessionRun: jest.fn(async () => ({ id: "evt-steer" }) as SessionEvent),
    enqueueSessionRunInput: jest.fn(async () => ({ id: "queued" })),
  }
}

function deps(
  c: ReturnType<typeof client>,
  patch: Partial<SharedRunSteerDeps> = {}
): SharedRunSteerDeps {
  return {
    getSession: (async (id: string) => (id === SHARED.id ? SHARED : undefined)) as never,
    resolveContext: async () =>
      ({ orgId: "org", userId: "me", client: c }) as unknown as CurrentCollabContext,
    heldRunId: () => undefined,
    ...patch,
  }
}

const person = (sessionId: string, content = "use staging"): SteerRequest => ({
  target: { sessionId },
  origin: "person",
  content,
  sourceMessageId: "msg-1",
})

beforeEach(() => __resetSharedRunSteerForTesting())

describe("the shared-session lane", () => {
  it("steers a run another device holds through the server, naming the message", async () => {
    const c = client()
    const lane = createSharedSessionSteerLane(deps(c))
    await expect(lane.steer("local-1", person("local-1"))).resolves.toEqual({
      status: "delivered",
      receiptIds: ["evt-steer"],
    })
    expect(c.steerSessionRun).toHaveBeenCalledWith("org", "shared-1", {
      runId: "run-7",
      payload: { text: "use staging", messageId: "msg-1" },
      operationId: "steer:msg-1",
    })
  })

  it("leaves a run this device holds, a private conversation and a derived input to the next lane", async () => {
    const c = client()
    await expect(
      createSharedSessionSteerLane(deps(c, { heldRunId: () => "run-7" })).steer(
        "local-1",
        person("local-1")
      )
    ).resolves.toBeNull()
    const lane = createSharedSessionSteerLane(deps(c))
    await expect(lane.steer("private", person("private"))).resolves.toBeNull()
    await expect(
      lane.steer("local-1", { ...person("local-1"), origin: "derived" })
    ).resolves.toBeNull()
    expect(c.steerSessionRun).not.toHaveBeenCalled()
  })

  it("has no run to steer when nothing streams, or the connection is elsewhere", async () => {
    const c = client()
    c.getActiveSessionRunLease.mockResolvedValueOnce(null)
    const lane = createSharedSessionSteerLane(deps(c))
    await expect(lane.steer("local-1", person("local-1"))).resolves.toEqual({
      status: "degraded",
      reason: "no_active_run",
    })
    const offline = createSharedSessionSteerLane(deps(c, { resolveContext: async () => null }))
    await expect(offline.steer("local-1", person("local-1"))).resolves.toEqual({
      status: "degraded",
      reason: "no_active_run",
    })
  })

  it("reports the server's refusals as the steer entry's reasons", async () => {
    const c = client()
    const lane = createSharedSessionSteerLane(deps(c))
    c.steerSessionRun.mockRejectedValueOnce(new CollabError(403, "forbidden"))
    await expect(lane.steer("local-1", person("local-1"))).resolves.toEqual({
      status: "degraded",
      reason: "not_admitted",
    })
    c.steerSessionRun.mockRejectedValueOnce(new CollabError(409, "no_active_run"))
    await expect(lane.steer("local-1", person("local-1"))).resolves.toEqual({
      status: "degraded",
      reason: "no_active_run",
    })
    await expect(lane.steer("local-1", person("local-1", "  "))).resolves.toEqual({
      status: "degraded",
      reason: "not_admitted",
    })
  })
})

describe("steerSharedFollowUp", () => {
  const delivered: SteerOutcome = { status: "delivered", receiptIds: [] }
  const refused: SteerOutcome = { status: "degraded", reason: "provider_unsupported" }

  it("steers through the one entry as a person's input from the message", async () => {
    const c = client()
    const steer = jest.fn(async () => delivered)
    await expect(
      steerSharedFollowUp("local-1", { messageId: "msg-1", content: "hi" }, deps(c, { steer }))
    ).resolves.toBe("steered")
    expect(steer).toHaveBeenCalledWith({
      target: { sessionId: "local-1" },
      origin: "person",
      content: "hi",
      sourceMessageId: "msg-1",
    })
  })

  it("queues the message for the next run when the holder's own turn closed its input", async () => {
    const c = client()
    const steer = jest.fn(async () => refused)
    await expect(
      steerSharedFollowUp(
        "local-1",
        { messageId: "msg-1", content: "hi" },
        deps(c, { steer, heldRunId: () => "run-7" })
      )
    ).resolves.toBe("queued")
    expect(c.enqueueSessionRunInput).toHaveBeenCalledWith("org", "shared-1", {
      payload: { messageId: "msg-1" },
      operationId: "steer-local:msg-1",
    })
  })

  it("leaves an ordinary message when no run took it elsewhere", async () => {
    const c = client()
    await expect(
      steerSharedFollowUp(
        "local-1",
        { messageId: "msg-1", content: "hi" },
        deps(c, { steer: async () => refused })
      )
    ).resolves.toBe("none")
    expect(c.enqueueSessionRunInput).not.toHaveBeenCalled()
  })
})

describe("applySharedRunSteer", () => {
  const steered = (patch: Partial<SessionEvent> = {}, payload?: unknown): SessionEvent =>
    ({
      id: "evt-1",
      kind: "run.steered",
      sessionId: "shared-1",
      sequence: 9,
      payload: payload ?? { runId: "run-7", input: { text: "add tests", messageId: "msg-2" } },
      ...patch,
    }) as unknown as SessionEvent

  it("delivers a member's steer into the run this device holds, once", async () => {
    const c = client()
    const steer = jest.fn(async (): Promise<SteerOutcome> => ({
      status: "delivered",
      receiptIds: [],
    }))
    const holder = deps(c, { steer, heldRunId: () => "run-7" })
    await expect(applySharedRunSteer("local-1", steered(), holder)).resolves.toBe("steered")
    expect(steer).toHaveBeenCalledWith({
      target: { sessionId: "local-1" },
      origin: "person",
      content: "add tests",
      sourceMessageId: "msg-2",
    })
    await expect(applySharedRunSteer("local-1", steered(), holder)).resolves.toBe("skipped")
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it("queues the message for the next run when the held turn closed its input", async () => {
    const c = client()
    const holder = deps(c, {
      steer: async () => ({ status: "degraded", reason: "provider_unsupported" }),
      heldRunId: () => "run-7",
    })
    await expect(applySharedRunSteer("local-1", steered(), holder)).resolves.toBe("queued")
    expect(c.enqueueSessionRunInput).toHaveBeenCalledWith("org", "shared-1", {
      payload: { messageId: "msg-2" },
      operationId: "steer-fallback:evt-1",
    })
  })

  it("skips a steer for a run this device does not hold, and other events", async () => {
    const c = client()
    const steer = jest.fn()
    await expect(
      applySharedRunSteer("local-1", steered(), deps(c, { steer, heldRunId: () => undefined }))
    ).resolves.toBe("skipped")
    await expect(
      applySharedRunSteer(
        "local-1",
        steered({ id: "evt-2" }),
        deps(c, { steer, heldRunId: () => "run-other" })
      )
    ).resolves.toBe("skipped")
    await expect(
      applySharedRunSteer(
        "local-1",
        steered({ id: "evt-3", kind: "message.created" }),
        deps(c, { steer, heldRunId: () => "run-7" })
      )
    ).resolves.toBe("skipped")
    expect(steer).not.toHaveBeenCalled()
  })
})
