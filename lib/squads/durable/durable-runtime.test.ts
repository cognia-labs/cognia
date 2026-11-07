import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { runEventJournal } from "@/lib/db/execution-runs"
import type { AgentTeam, AgentTeamConfig } from "@/types/agent/agent-team"
import {
  __resetDurableTeamCoordinatorForTesting,
  appTeamPathPolicy,
  createDurableTeamCoordinator,
  durableTeamSpec,
  getDurableTeamCoordinator,
  redactTeamTextForPersistence,
} from "./durable-runtime"
import * as runtimeDb from "@/lib/db/agent-team-runtime"
import {
  isStoredChildReplaySafe,
  isStoredChildStopped,
} from "@cognia/agent-orchestration/coordinator"

const mockLiveSidecarSessions = jest.fn<Promise<ReadonlySet<string> | undefined>, []>()
const mockLiveExternalProcesses = jest.fn<Promise<ReadonlySet<string> | undefined>, []>()
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  getLiveExternalAgentProcessIds: () => mockLiveExternalProcesses(),
}))
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  getLiveSidecarSessionIds: () => mockLiveSidecarSessions(),
}))

const mockIsTauri = jest.fn(() => false)
const mockCanonicalRoot = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))
jest.mock("@/lib/task-workspace/user-action", () => ({
  approvalAwareTransport: {
    call: (command: string, input: unknown) => mockCanonicalRoot(command, input),
  },
}))

describe("appTeamPathPolicy canonical workspace roots", () => {
  afterEach(() => {
    mockIsTauri.mockReturnValue(false)
    mockCanonicalRoot.mockReset()
  })

  it("uses the Host canonical root authority for disk aliases", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCanonicalRoot.mockResolvedValue("/physical/repo")
    await expect(appTeamPathPolicy.canonicalize!("/symlink/repo")).resolves.toBe("/physical/repo")
    expect(mockCanonicalRoot).toHaveBeenCalledWith("task_workspace_canonical_root", {
      path: "/symlink/repo",
    })
  })

  it("fails closed if the Host cannot resolve a root", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCanonicalRoot.mockRejectedValue(new Error("canonical Host root unavailable"))
    await expect(appTeamPathPolicy.canonicalize!("/missing")).rejects.toThrow("canonical Host root")
  })

  it("retains lexical browser-only paths when no Host filesystem exists", async () => {
    await expect(appTeamPathPolicy.canonicalize!("/repo/../work")).resolves.toBe("/work")
    expect(mockCanonicalRoot).not.toHaveBeenCalled()
  })
})

// The coordinator's own behavior is covered against the memory store in
// `@cognia/agent-orchestration` (coordinator.test.ts). This suite covers the
// app's bindings: Dexie, the execution-run journal, `@cognia/redact`, the
// app's path semantics, the fleet session projection and the team mapping.

const removeManagedFleetSession = jest.fn<Promise<boolean>, [sessionId: string]>(async () => true)
jest.mock("@/lib/fleet/managed-session-projection", () => ({
  removeManagedFleetSession: (sessionId: string) => removeManagedFleetSession(sessionId),
}))

const mockLeakCheck = jest.fn<boolean | undefined, [string]>(() => undefined)
jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    // `undefined` defers to the real check; a test forces a verdict.
    hasNoLeakingPii: (text: string) => mockLeakCheck(text) ?? actual.hasNoLeakingPii(text),
  }
})

const config = (overrides: Partial<AgentTeamConfig> = {}): AgentTeamConfig => ({
  maxTeammates: 3,
  maxConcurrentTeammates: 2,
  executionMode: "coordinated",
  displayMode: "expanded",
  writeMode: "single-writer",
  repositories: [
    { id: "primary", role: "primary", path: "/repo", writable: true },
    { id: "dep", role: "dependency", path: "/dep", writable: true },
  ],
  resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
  ...overrides,
})

const team = (overrides: Partial<AgentTeam> = {}): AgentTeam =>
  ({
    id: "team-1",
    projectId: "project-1",
    name: "Team",
    description: "",
    task: "Ship",
    status: "idle",
    config: config(),
    leadId: "lead-1",
    teammateIds: ["lead-1", "mate-1"],
    taskIds: ["task-1"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1),
    ...overrides,
  }) as AgentTeam

describe("durableTeamSpec", () => {
  it("maps the team onto the coordinator's spec", () => {
    expect(
      durableTeamSpec(
        team({
          config: config({
            environmentRef: { environmentId: "env", versionId: "env-v3" },
            userConstraints: [{ title: "API", detail: "Keep it" }],
            workingDir: "/work",
          }),
        })
      )
    ).toEqual({
      id: "team-1",
      leadId: "lead-1",
      projectId: "project-1",
      objective: "Ship",
      repositories: config().repositories,
      workingDir: "/work",
      writeMode: "single-writer",
      resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
      maxConcurrentTeammates: 2,
      environmentVersionId: "env-v3",
      userConstraints: [{ title: "API", detail: "Keep it" }],
    })
  })

  it("leaves unset configuration out", () => {
    const spec = durableTeamSpec(
      team({
        projectId: undefined,
        config: {
          maxTeammates: 1,
          maxConcurrentTeammates: 1,
          executionMode: "coordinated",
          displayMode: "expanded",
        } as AgentTeamConfig,
      })
    )
    expect(spec).toEqual({
      id: "team-1",
      leadId: "lead-1",
      objective: "Ship",
      maxConcurrentTeammates: 1,
    })
  })
})

describe("redactTeamTextForPersistence", () => {
  afterEach(() => mockLeakCheck.mockReset().mockReturnValue(undefined))

  it("redacts with @cognia/redact", () => {
    const redacted = redactTeamTextForPersistence("Contact operator@example.com now")
    expect(redacted).toBeDefined()
    expect(redacted).not.toContain("operator@example.com")
  })

  it("refuses text that still leaks after redaction", () => {
    mockLeakCheck.mockReturnValue(false)
    expect(redactTeamTextForPersistence("anything")).toBeUndefined()
  })
})

describe("the app's durable AgentTeam coordinator", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    __resetDurableTeamCoordinatorForTesting()
    removeManagedFleetSession.mockReset().mockResolvedValue(true)
    mockLiveSidecarSessions.mockReset().mockResolvedValue(undefined)
    mockLiveExternalProcesses.mockReset().mockResolvedValue(undefined)
  })

  it.each(["live", "absent", "unknown", "error"] as const)(
    "queries the external executor registry after reload: %s",
    async (mode) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team(), "external-reload")
      await coordinator.registerChild({
        runId: "external-reload",
        childRunId: "external-child",
        teammateId: "mate",
        taskId: "task",
        repositoryId: "primary",
        access: "read",
        runtime: "codex",
        executorRegistry: "external-process",
        sessionId: "native-thread-id",
      })
      await runtimeDb.updateAgentTeamChildRun("external-child", {
        status: "running",
        startedAt: 1,
        dispatchEpoch: 1,
      })
      await coordinator.checkpoint("external-child", {
        replay: "safe",
        sideEffects: [],
        trajectorySequence: 0,
      })
      // JS has no live controls. The empty sidecar list knows nothing about
      // the external process, whose id differs from the native thread id.
      mockLiveSidecarSessions.mockResolvedValue(new Set())
      if (mode === "error") mockLiveExternalProcesses.mockRejectedValue(new Error("Host lost"))
      else
        mockLiveExternalProcesses.mockResolvedValue(
          mode === "unknown" ? undefined : new Set(mode === "live" ? ["codex-process-id"] : [])
        )
      __resetDurableTeamCoordinatorForTesting()
      const restarted = createDurableTeamCoordinator()
      await expect(restarted.recover()).resolves.toEqual([
        { runId: "external-reload", status: mode === "absent" ? "recovering" : "needs_input" },
      ])
      expect(mockLiveExternalProcesses).toHaveBeenCalled()
      expect(mockLiveSidecarSessions).not.toHaveBeenCalled()
      if (mode === "absent")
        await expect(restarted.retryChild("external-child")).resolves.toMatchObject({
          status: "queued",
        })
      else {
        await expect(restarted.retryChild("external-child")).rejects.toThrow("stop_unconfirmed")
        await expect(restarted.terminateChild("external-child")).rejects.toThrow("stop_unconfirmed")
        expect((await runtimeDb.getAgentTeamChildRun("external-child"))?.stop?.state).toBe(
          "unconfirmed"
        )
      }
    }
  )

  it.each([
    ["claude", "session", ["session"], false],
    ["claude-agent-sdk", "session", ["another-session"], true],
    ["ai-sdk", undefined, ["another-session"], false],
    ["ai-sdk", undefined, [], true],
    ["codex-acp", "thread", ["process"], false],
    ["claude-code", "thread", [], true],
    ["opencode-server", "thread", ["process"], false],
    ["unknown-runtime", "session", [], false],
    ["toString", "session", [], false],
    [undefined, "session", [], false],
  ] as const)(
    "uses only the registry owning %s (session=%s, ids=%j)",
    async (runtime, sessionId, ids, stopped) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team(), "owning-registry")
      await registerChild(coordinator, "owning-registry", "registry-child")
      await coordinator.store.updateChild("registry-child", {
        runtime,
        executorRegistry: ["codex-acp", "claude-code", "opencode-server"].includes(runtime ?? "")
          ? "external-process"
          : "sidecar",
        sessionId,
        status: "running",
        startedAt: 1,
        dispatchEpoch: 1,
      })
      const child = (await coordinator.store.getChild("registry-child"))!
      mockLiveSidecarSessions.mockResolvedValue(new Set(ids))
      mockLiveExternalProcesses.mockResolvedValue(new Set(ids))
      await expect(isStoredChildStopped(coordinator.store, child, 100)).resolves.toBe(stopped)
      const sidecar = ["claude", "claude-agent-sdk", "ai-sdk"].includes(runtime ?? "")
      const external = ["codex-acp", "claude-code", "opencode-server"].includes(runtime ?? "")
      expect(mockLiveSidecarSessions).toHaveBeenCalledTimes(sidecar ? 1 : 0)
      expect(mockLiveExternalProcesses).toHaveBeenCalledTimes(external ? 1 : 0)
    }
  )

  it.each([
    ["codex", "external-process", true],
    ["codex", "unconfirmed", false],
    ["codex", undefined, false],
    ["claude", undefined, false],
    ["opencode-server", "unconfirmed", false],
    ["claude", "external-process", true],
    ["unknown-runtime", "external-process", false],
  ] as const)(
    "requires actual process ownership before an empty registry proves %s stopped: %s",
    async (runtime, executorRegistry, stopped) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team(), "bound-registry")
      await registerChild(coordinator, "bound-registry", "bound-child")
      await coordinator.store.updateChild("bound-child", {
        runtime,
        executorRegistry,
        status: "running",
        startedAt: 1,
        dispatchEpoch: 1,
      })
      mockLiveSidecarSessions.mockResolvedValue(new Set())
      mockLiveExternalProcesses.mockResolvedValue(new Set())
      const child = (await coordinator.store.getChild("bound-child"))!
      await expect(isStoredChildStopped(coordinator.store, child, 100)).resolves.toBe(stopped)
      expect(mockLiveSidecarSessions).toHaveBeenCalledTimes(
        runtime === "claude" && executorRegistry === undefined ? 1 : 0
      )
    }
  )

  it("records an already frozen scheduled run's resolved ceiling", async () => {
    await runtimeDb.createAgentTeamRun({
      id: "run-scheduled",
      teamId: "team-1",
      objective: "Ship",
      status: "queued",
      priority: 0,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
      executionConstraints: {
        version: 1,
        origin: "schedule",
        triggeredFrom: { source: "schedule" },
        requirePlanApprovalFloor: false,
        permissionCeiling: { permissionMode: "plan", allowedTools: ["Read"] },
      },
    })
    await createDurableTeamCoordinator({ now: () => 50 }).prepareRun(team(), "run-scheduled")
    const run = await getDb().executionRuns.get("execution:team:run-scheduled")
    expect(run?.actingIdentity).toMatchObject({
      lane: "legacy",
      trigger: "schedule",
      requesters: [],
    })
    expect(run?.authority).toEqual({
      schemaVersion: 1,
      permissionMode: "plan",
      tools: { allow: ["Read"] },
    })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    mockLeakCheck.mockReset().mockReturnValue(undefined)
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  const registerChild = (
    coordinator: ReturnType<typeof createDurableTeamCoordinator>,
    runId: string,
    childRunId: string
  ) =>
    coordinator.registerChild({
      runId,
      childRunId,
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
      runtime: "claude",
      executorRegistry: "sidecar",
    })

  it("keeps run state in Dexie by default", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 50 })
    expect(coordinator.store).toBe(runtimeDb.dexieTeamRunStore)
    await coordinator.prepareRun(team(), "run-dexie")
    expect(await runtimeDb.getAgentTeamRun("run-dexie")).toMatchObject({
      teamId: "team-1",
      objective: "Ship",
      status: "running",
    })
  })

  it.each([true, false])(
    "keeps a real settlement transaction alive during delayed host IPC (live=%s)",
    async (live) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team(), "run-native-query")
      await registerChild(coordinator, "run-native-query", "native-child")
      await coordinator.store.updateChild("native-child", {
        status: "running",
        startedAt: 1,
        dispatchEpoch: 1,
        sessionId: "native-session",
      })
      mockLiveSidecarSessions.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(new Set(live ? ["native-session"] : [])), 20)
          })
      )
      const run = (await coordinator.store.getRun("run-native-query"))!
      await expect(
        runtimeDb.settleAgentTeamRunIfCurrent(run.id, run, { status: "completed", updatedAt: 100 })
      ).resolves.toBe(live ? "needs_input" : "completed")
      expect(mockLiveSidecarSessions).toHaveBeenCalledTimes(1)
      expect((await coordinator.store.getRun(run.id))?.status).toBe(
        live ? "needs_input" : "completed"
      )
    }
  )

  it("journals the run under the bridge's execution id and notes a resumption", async () => {
    await runtimeDb.createAgentTeamRun({
      id: "run-journal",
      teamId: "team-1",
      objective: "Ship",
      status: "queued",
      priority: 0,
      decisionVersion: 0,
      createdAt: 90,
      updatedAt: 90,
      executionConstraints: {
        version: 1,
        origin: "chat",
        triggeredFrom: { source: "chat" },
        requirePlanApprovalFloor: false,
      },
    })
    const coordinator = createDurableTeamCoordinator({ now: () => 90 })
    await coordinator.prepareRun(team(), "run-journal")
    // Addressed the way `agent-team-bridge` addresses it. Keying the row on the
    // bare run id made this path create a SECOND execution row for the same
    // run (`sourceId: <teamId>` rather than `<runId>`), which nothing deduped.
    expect(await getDb().executionRuns.get("run-journal")).toBeUndefined()
    const recordedIdentity = (await getDb().executionRuns.get("execution:team:run-journal"))
      ?.actingIdentity
    // A caller-supplied "chat" origin is not host proof of a local person
    // (ADR-0243 phase 2-0), so the run records as an external event.
    expect(recordedIdentity).toMatchObject({
      lane: "legacy",
      trigger: "external-event",
      requesters: [],
      authorityRevision: 0,
    })
    expect(await getDb().executionRuns.get("execution:team:run-journal")).toMatchObject({
      kind: "team",
      sourceId: "run-journal",
      projectId: "project-1",
      title: "Ship",
      status: "running",
    })

    await getDb().executionRuns.update("execution:team:run-journal", { status: "waiting" })
    await createDurableTeamCoordinator({ now: () => 95 }).prepareRun(team(), "run-journal")
    const events = await runEventJournal.replay("execution:team:run-journal")
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.resumed"])
    expect((await getDb().executionRuns.get("execution:team:run-journal"))?.actingIdentity).toEqual(
      recordedIdentity
    )
  })

  it("writes no team row for a best-of-N group's run, which has a row of its own", async () => {
    await getDb().executionRuns.add({
      id: "execution:best-of-n:run-group",
      kind: "best-of-n",
      sourceId: "group-1",
      title: "Fix it",
      status: "running",
      currentRevision: 0,
      startedAt: 80,
      updatedAt: 80,
    })
    await createDurableTeamCoordinator({ now: () => 90 }).prepareRun(team(), "run-group")
    expect(await getDb().executionRuns.get("execution:team:run-group")).toBeUndefined()
    expect(await runEventJournal.replay("execution:team:run-group")).toEqual([])
  })

  it("records a durable run without frozen origin as external-event", async () => {
    await createDurableTeamCoordinator({ now: () => 90 }).prepareRun(team(), "automatic")
    expect(
      (await getDb().executionRuns.get("execution:team:automatic"))?.actingIdentity
    ).toMatchObject({
      trigger: "external-event",
      rootRunId: "execution:team:automatic",
      requesters: [],
    })
  })

  it("sends the steering payload redacted by @cognia/redact to the live runtime", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 225 })
    await coordinator.prepareRun(team(), "run-redacted-steer")
    await registerChild(coordinator, "run-redacted-steer", "child-redacted-steer")
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-redacted-steer", { steer })

    const receipt = await coordinator.steer(
      "child-redacted-steer",
      "Contact operator@example.com before continuing"
    )

    expect(receipt.message).not.toContain("operator@example.com")
    expect(steer).toHaveBeenCalledWith(receipt.message, receipt.id)
  })

  it.each(["", "../outside", "/outside", "C:relative", "src\0file"])(
    "rejects invalid isolated ownership %s under the app's path semantics",
    async (path) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(
        team({ config: config({ writeMode: "isolated-parallel" }) }),
        "run-admission"
      )
      const operation = jest.fn()
      await expect(
        coordinator.withWorkspaceLease(
          {
            runId: "run-admission",
            repositoryId: "primary",
            access: "write",
            fileOwnership: [path],
          },
          operation
        )
      ).rejects.toThrow(/ownership/)
      expect(operation).not.toHaveBeenCalled()
    }
  )

  it("releases a terminated remote child's fleet session, even when removal fails", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 250 })
    await coordinator.prepareRun(team(), "run-control")
    await registerChild(coordinator, "run-control", "child-control")
    await runtimeDb.updateAgentTeamChildRun("child-control", { remoteSessionId: "remote-control" })
    coordinator.attachLiveControl("child-control", {
      steer: jest.fn(),
      terminate: async () => ({ kind: "ack", epoch: 0, at: 250 }),
    })
    removeManagedFleetSession.mockRejectedValueOnce(new Error("projection offline"))

    await coordinator.terminateChild("child-control")

    expect(removeManagedFleetSession).toHaveBeenCalledWith("remote-control")
    expect((await runtimeDb.getAgentTeamChildRun("child-control"))?.status).toBe("terminated")
  })

  it("shares one coordinator whose store the replay checks read", async () => {
    const shared = getDurableTeamCoordinator()
    expect(getDurableTeamCoordinator()).toBe(shared)
    await shared.prepareRun(team(), "run-replay")
    await registerChild(shared, "run-replay", "child-replay")
    expect(await isStoredChildReplaySafe(shared.store, "child-replay")).toBe(false)
    await shared.checkpoint("child-replay", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    expect(await isStoredChildReplaySafe(shared.store, "child-replay")).toBe(true)
  })
})
