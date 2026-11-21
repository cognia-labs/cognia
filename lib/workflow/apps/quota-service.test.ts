/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkflowAppRelease } from "@/types/workflow/app"
import { assertWorkflowAppAdmissionQuota } from "./quota-service"

jest.setTimeout(20_000)

function release(quota: WorkflowAppRelease["snapshot"]["quota"]): WorkflowAppRelease {
  return {
    id: "release_2",
    appId: "app_1",
    accountId: "account_1",
    workflowId: "workflow_1",
    appKind: "workflow",
    sequence: 2,
    appDraftRevision: 2,
    versionId: "version_2",
    versionDigest: "digest",
    deploymentId: "deployment_1",
    deploymentRevision: 1,
    workflowInterface: {},
    dependencyLock: { workflows: {}, indexes: {} },
    snapshot: {
      blocks: [],
      theme: { colorMode: "system", primaryColor: "#000000" },
      localized: {},
      access: { mode: "anonymous", oidcGroupIds: [] },
      embed: { enabled: false, allowedOrigins: [] },
      resultSharing: { enabled: false },
      mcp: { enabled: false },
      quota,
      contentPolicy: { inputModeration: true, outputModeration: true },
      legal: { requireConsent: false },
      reviewGate: {
        enabled: false,
        requiredApprovals: 1,
        reviewerSubjectIds: [],
        reviewerGroupIds: [],
        requireNoBlockingComments: true,
      },
      qualityGate: { enabled: false, thresholds: {}, maxRunAgeMs: 1 },
      annotationReply: { enabled: false, threshold: 0.85 },
      knowledgeBindings: {},
    },
    createdAt: 1,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("enforces request and active-run quotas across releases of the same app", async () => {
  await getDb().workflowInvocations.bulkPut([
    {
      id: "inv_1",
      accountId: "account_1",
      entrypoint: "portal",
      caller: "app:app_1:release:release_1:external:one",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_1",
      status: "running",
      createdAt: 9_500,
      updatedAt: 9_500,
    },
  ])

  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ requestsPerMinute: 1 }),
      now: 10_000,
    })
  ).rejects.toMatchObject({ code: "request_rate_exhausted", retryAfterSeconds: 60 })
  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ concurrentRuns: 1 }),
      now: 10_000,
    })
  ).rejects.toMatchObject({ code: "concurrency_exhausted" })
})

it("allows in-flight work to finish and rejects the next admission after daily usage is spent", async () => {
  await getDb().workflowInvocations.put({
    id: "inv_1",
    accountId: "account_1",
    entrypoint: "portal",
    caller: "app:app_1:release:release_1:external:one",
    deploymentId: "deployment_1",
    deploymentRevision: 1,
    versionId: "version_1",
    runId: "run_1",
    status: "completed",
    createdAt: 9_000,
    updatedAt: 9_500,
  })
  await getDb().sessionUsage.put({
    messageId: "wf:run_1:prompt",
    sessionId: "wf:run_1",
    runId: "run_1",
    at: 9_500,
    inputTokens: 60,
    outputTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 2,
    costKnown: true,
    durationMs: 1,
    surface: "workflow",
  })

  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ dailyTokenBudget: 100 }),
      now: 10_000,
    })
  ).rejects.toMatchObject({ code: "token_budget_exhausted" })
  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ dailyCostBudgetUsd: 2 }),
      now: 10_000,
    })
  ).rejects.toMatchObject({ code: "cost_budget_exhausted" })
})

it("counts the usage a placed run's Host reported, once, against the daily budgets (WF-13)", async () => {
  const placed = {
    accountId: "account_1",
    entrypoint: "http" as const,
    caller: "app:app_1:release:release_2:external:visitor",
    deploymentId: "deployment_1",
    deploymentRevision: 1,
    versionId: "version_2",
    status: "completed" as const,
    createdAt: 9_000,
    updatedAt: 9_000,
  }
  await getDb().workflowInvocations.bulkPut([
    {
      ...placed,
      id: "placed_1",
      runId: "run_placed_1",
      placement: {
        hostRef: "host_b",
        dispatchId: "dispatch_1",
        state: "settled",
        usage: { tokens: 70, costUsd: 1.5, costKnown: true },
      },
    },
    {
      ...placed,
      id: "placed_2",
      runId: "run_placed_2",
      placement: {
        hostRef: "host_b",
        dispatchId: "dispatch_2",
        state: "settled",
        usage: { tokens: 40, costUsd: 0.75, costKnown: true },
      },
    },
  ])
  // A local usage row under a placed run id would be a second count; it is ignored.
  await getDb().sessionUsage.put({
    messageId: "wf:run_placed_1:prompt",
    sessionId: "wf:run_placed_1",
    runId: "run_placed_1",
    at: 9_500,
    inputTokens: 1_000,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 100,
    costKnown: true,
    durationMs: 1,
    surface: "workflow",
  })

  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ dailyTokenBudget: 110 }),
      now: 10_000,
    })
  ).rejects.toMatchObject({ code: "token_budget_exhausted" })
  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ dailyTokenBudget: 111, dailyCostBudgetUsd: 2.3 }),
      now: 10_000,
    })
  ).resolves.toBeUndefined()
  await getDb().workflowInvocations.update("placed_2", {
    placement: {
      hostRef: "host_b",
      dispatchId: "dispatch_2",
      state: "settled",
      usage: { tokens: 40, costUsd: 0, costKnown: false },
    },
  })
  await expect(
    assertWorkflowAppAdmissionQuota({
      appId: "app_1",
      accountId: "account_1",
      release: release({ dailyCostBudgetUsd: 100 }),
      now: 10_000,
    })
  ).rejects.toMatchObject({ code: "cost_budget_unknown" })
})
