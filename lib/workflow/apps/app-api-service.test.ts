jest.mock("@/lib/db/workflow-apps", () => ({
  resolvePublishedWorkflowApp: jest.fn(),
  resolveWorkflowAppRelease: jest.fn(),
}))
jest.mock("./app-execution", () => ({
  authorizeWorkflowAppRequest: jest.fn(() => ({ caller: "external:visitor" })),
  executePublishedWorkflowApp: jest.fn(),
}))
jest.mock("./app-run-placement", () => ({
  admitWorkflowAppRunPlacement: jest.fn(async () => undefined),
  readPlacedWorkflowAppRun: jest.fn(),
  listPlacedWorkflowAppRunEvents: jest.fn(),
  cancelPlacedWorkflowAppRun: jest.fn(),
  judgePlacedWorkflowAppRunDisclosure: jest.fn(),
}))
jest.mock("@/lib/workflow/api/workflow-api-service", () => ({
  getWorkflowApiRun: jest.fn(),
  listWorkflowApiEvents: jest.fn(),
  cancelWorkflowApiRun: jest.fn(),
}))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { resolvePublishedWorkflowApp, resolveWorkflowAppRelease } from "@/lib/db/workflow-apps"
import { executePublishedWorkflowApp } from "./app-execution"
import {
  admitWorkflowAppRun,
  cancelWorkflowAppRun,
  getWorkflowAppRun,
  listWorkflowAppRunEvents,
  WorkflowAppApiError,
} from "./app-api-service"
import {
  cancelWorkflowApiRun,
  getWorkflowApiRun,
  listWorkflowApiEvents,
} from "../api/workflow-api-service"
import {
  admitWorkflowAppRunPlacement,
  cancelPlacedWorkflowAppRun,
  judgePlacedWorkflowAppRunDisclosure,
  listPlacedWorkflowAppRunEvents,
  readPlacedWorkflowAppRun,
} from "./app-run-placement"
import { judgeWorkflowAppRunDisclosure } from "./app-api-service"

const dbFixture = createDbTestFixture()
const resolveApp = resolvePublishedWorkflowApp as jest.MockedFunction<
  typeof resolvePublishedWorkflowApp
>
const resolveRelease = resolveWorkflowAppRelease as jest.MockedFunction<
  typeof resolveWorkflowAppRelease
>
const execute = executePublishedWorkflowApp as jest.MockedFunction<
  typeof executePublishedWorkflowApp
>
const getRun = getWorkflowApiRun as jest.MockedFunction<typeof getWorkflowApiRun>
const listEvents = listWorkflowApiEvents as jest.MockedFunction<typeof listWorkflowApiEvents>
const cancelRun = cancelWorkflowApiRun as jest.MockedFunction<typeof cancelWorkflowApiRun>

const resolved = {
  app: { id: "app_1", accountId: "account_1", slug: "review" },
  release: { id: "release_1" },
} as never
const actor = { authenticated: false, externalSubjectKey: "visitor" }

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  resolveApp.mockResolvedValue(resolved)
  resolveRelease.mockResolvedValue(resolved)
  getRun.mockResolvedValue({
    runId: "run_1",
    workflowId: "wf_1",
    status: "succeeded",
    startedAt: 1,
  })
  listEvents.mockResolvedValue({ events: [], terminal: true })
  cancelRun.mockResolvedValue({ runId: "run_1", cancelled: true, mode: "cooperative" })
})
afterAll(dbFixture.dispose)

describe("application-level workflow API", () => {
  it("returns a stable run id at admission while completion continues", async () => {
    let finish!: (value: never) => void
    execute.mockImplementation(
      ({ onAdmitted }) =>
        new Promise((resolve) => {
          onAdmitted?.("run_1")
          finish = resolve
        })
    )

    const admitted = await admitWorkflowAppRun({
      accountId: "account_1",
      appSlug: "review",
      actor,
      input: { topic: "release" },
      idempotencyKey: "request-1",
      responseMode: "async",
    })

    expect(admitted.runId).toBe("run_1")
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved,
        actor,
        entrypoint: "http",
        idempotencyKey: "request-1",
      })
    )
    finish({ runId: "run_1", result: { output: { ok: true } } } as never)
    await expect(admitted.completion).resolves.toMatchObject({ runId: "run_1" })
  })

  it("scopes status, SSE replay, and cancellation to the app release and actor", async () => {
    await getDb().workflowInvocations.put({
      id: "inv_1",
      accountId: "account_1",
      entrypoint: "http",
      caller: "app:app_1:release:release_1:external:visitor",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_1",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(
      getWorkflowAppRun({ accountId: "account_1", appSlug: "review", runId: "run_1", actor })
    ).resolves.toMatchObject({ runId: "run_1" })
    await listWorkflowAppRunEvents({
      accountId: "account_1",
      appSlug: "review",
      runId: "run_1",
      actor,
      afterSequence: 12,
    })
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 12 }))
    await cancelWorkflowAppRun({
      accountId: "account_1",
      appSlug: "review",
      runId: "run_1",
      actor,
    })
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }))
  })

  it("does not let an external subject read another subject's run", async () => {
    await getDb().workflowInvocations.put({
      id: "inv_1",
      accountId: "account_1",
      entrypoint: "http",
      caller: "app:app_1:release:release_1:external:other",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_1",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(
      getWorkflowAppRun({ accountId: "account_1", appSlug: "review", runId: "run_1", actor })
    ).rejects.toBeInstanceOf(WorkflowAppApiError)
  })

  it("answers an async request the Run Policy placed elsewhere with the placed run, and runs nothing here", async () => {
    const place = admitWorkflowAppRunPlacement as jest.MockedFunction<
      typeof admitWorkflowAppRunPlacement
    >
    place.mockResolvedValueOnce({
      runId: "run_placed",
      invocationId: "wfi_1",
      dispatchId: "dispatch_1",
      reused: false,
    })
    const admitted = await admitWorkflowAppRun({
      accountId: "account_1",
      appSlug: "review",
      actor,
      input: { topic: "release" },
      idempotencyKey: "request-1",
      responseMode: "async",
    })
    expect(admitted).toEqual({ runId: "run_placed", releaseId: "release_1", placed: true })
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ placeable: true }))
    expect(execute).not.toHaveBeenCalled()
  })

  it("keeps a blocking request colocated: placement may only replay, never place", async () => {
    execute.mockImplementation(async ({ onAdmitted }) => {
      onAdmitted?.("run_1")
      return { runId: "run_1" } as never
    })
    await admitWorkflowAppRun({
      accountId: "account_1",
      appSlug: "review",
      actor,
      input: {},
      idempotencyKey: "request-1",
      responseMode: "blocking",
    })
    expect(admitWorkflowAppRunPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placeable: false })
    )
    expect(execute).toHaveBeenCalled()
  })

  it("reads, pages, cancels and judges a placed run through its Host", async () => {
    await getDb().workflowInvocations.put({
      id: "inv_placed",
      accountId: "account_1",
      entrypoint: "http",
      caller: "app:app_1:release:release_1:external:visitor",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_placed",
      status: "admitted",
      placement: { hostRef: "host_b", dispatchId: "dispatch_1", state: "dispatching" },
      createdAt: 1,
      updatedAt: 1,
    })
    const placedView = {
      runId: "run_placed",
      workflowId: "wf_1",
      status: "pending" as const,
      startedAt: 1,
      placement: { state: "dispatching" as const },
    }
    ;(readPlacedWorkflowAppRun as jest.Mock).mockResolvedValue(placedView)
    ;(listPlacedWorkflowAppRunEvents as jest.Mock).mockResolvedValue({
      events: [],
      terminal: false,
    })
    ;(cancelPlacedWorkflowAppRun as jest.Mock).mockResolvedValue({
      runId: "run_placed",
      cancelled: true,
      mode: "handoff-cancelled",
    })
    ;(judgePlacedWorkflowAppRunDisclosure as jest.Mock).mockResolvedValue({ outcome: "allow" })
    const scope = { accountId: "account_1", appSlug: "review", runId: "run_placed", actor }

    await expect(getWorkflowAppRun(scope)).resolves.toEqual(placedView)
    await expect(listWorkflowAppRunEvents({ ...scope, afterSequence: 4 })).resolves.toEqual({
      events: [],
      terminal: false,
    })
    expect(listPlacedWorkflowAppRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inv_placed" }),
      { afterSequence: 4 }
    )
    await expect(cancelWorkflowAppRun(scope)).resolves.toMatchObject({ cancelled: true })
    await expect(
      judgeWorkflowAppRunDisclosure({ ...scope, payload: "{}", label: "public workflow result" })
    ).resolves.toEqual({ outcome: "allow" })
    // The local run API is never asked about a run that is not here.
    expect(getRun).not.toHaveBeenCalled()
    expect(listEvents).not.toHaveBeenCalled()
    expect(cancelRun).not.toHaveBeenCalled()
  })

  it("leaves a local run's disclosure to the local personal sink", async () => {
    await getDb().workflowInvocations.put({
      id: "inv_1",
      accountId: "account_1",
      entrypoint: "http",
      caller: "app:app_1:release:release_1:external:visitor",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_1",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(
      judgeWorkflowAppRunDisclosure({
        accountId: "account_1",
        appSlug: "review",
        runId: "run_1",
        actor,
        payload: "{}",
        label: "public workflow result",
      })
    ).resolves.toBeUndefined()
  })
})
