/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { createGoal, getGoal } from "@/lib/db/goals"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { Goal, GoalConfig } from "@/types/goal"
import type { ExecuteDeployedWorkflowResult } from "@/lib/workflow/runtime/execution-authority"
import {
  GOAL_VERIFICATION_INPUT_SCHEMA,
  GOAL_VERIFICATION_OUTPUT_SCHEMA,
  isGoalVerificationWorkflowVersion,
  reconcilePendingGoalVerifications,
  verifyGoalCompletion,
} from "./verification"

// The boot scan runs the real executor; tests stand in for the workflow run.
const mockExecuteDeployedWorkflow = jest.fn()
jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  ...jest.requireActual("@/lib/workflow/runtime/execution-authority"),
  executeDeployedWorkflow: (...args: unknown[]) => mockExecuteDeployedWorkflow(...args),
}))
const mockOnGoalTerminal = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./completion-linkage", () => ({
  onGoalTerminal: (...args: unknown[]) => mockOnGoalTerminal(...args),
}))

const config: GoalConfig = {
  maxTurns: 20,
  maxTokens: 100_000,
  maxJudgeFailures: 3,
  timeoutMs: 60_000,
  verificationWorkflow: {
    workflowId: "wf-1",
    versionId: "wfv-1",
    deploymentId: "wfd-1",
    deploymentRevision: 1,
    dependencyLock: { workflows: {}, indexes: {} },
  },
}

async function seedGoal(): Promise<Goal> {
  return createGoal({
    id: "goal-1",
    sessionId: "session-1",
    rawObjective: "Ship safely",
    safeObjective: "Ship safely",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 2,
    tokensUsed: 100,
    judgeFailureCount: 0,
    config,
    generationId: "generation-1",
  })
}

function executionResult(output: unknown): ExecuteDeployedWorkflowResult {
  return {
    invocationId: "inv-1",
    runId: "workflow-run-1",
    reused: false,
    version: {} as never,
    executionBinding: {} as never,
    result: { runId: "workflow-run-1", status: "succeeded", output },
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockExecuteDeployedWorkflow.mockReset()
  mockOnGoalTerminal.mockClear()
})

it("accepts only published interfaces that satisfy the verifier contract", () => {
  expect(
    isGoalVerificationWorkflowVersion({
      workflowId: "wf-1",
      id: "wfv-1",
      interface: {
        inputSchema: GOAL_VERIFICATION_INPUT_SCHEMA,
        outputSchema: GOAL_VERIFICATION_OUTPUT_SCHEMA,
      },
    } as never)
  ).toBe(true)
})

it("persists a passed workflow result and immutable idempotency key", async () => {
  await seedGoal()
  const execute = jest.fn(async (input) => {
    input.onAdmitted?.("workflow-run-1")
    return executionResult({ passed: true, summary: "All checks passed" })
  })
  await expect(
    verifyGoalCompletion(
      {
        goalId: "goal-1",
        candidateSummary: "Done for alice@example.com",
        capturedGenerationId: "generation-1",
      },
      { execute }
    )
  ).resolves.toMatchObject({ kind: "passed" })
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: "goal-verification:goal-1:generation-1:1",
      lockedDependency: config.verificationWorkflow,
    })
  )
  expect((await getGoal("goal-1"))?.verification).toMatchObject({
    status: "passed",
    workflowRunId: "workflow-run-1",
  })
})

it("reuses the same admission after reload instead of creating another attempt", async () => {
  await seedGoal()
  await getDb().chatGoals.update("goal-1", {
    verification: {
      attempt: 2,
      status: "running",
      idempotencyKey: "goal-verification:goal-1:generation-1:2",
      generationId: "generation-1",
      workflowRunId: "workflow-run-existing",
      failureCount: 1,
      candidateSummary: "Existing candidate",
      updatedAt: 1,
    },
  })
  const execute = jest.fn(async () => executionResult({ passed: true, summary: "Recovered" }))
  await verifyGoalCompletion(
    {
      goalId: "goal-1",
      candidateSummary: "Must not replace the durable candidate",
      capturedGenerationId: "generation-1",
    },
    { execute }
  )
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ idempotencyKey: "goal-verification:goal-1:generation-1:2" })
  )
  expect((await getGoal("goal-1"))?.verification).toMatchObject({
    attempt: 2,
    candidateSummary: "Existing candidate",
  })
})

it("pauses after three negative verdicts and immediately on contract errors", async () => {
  await seedGoal()
  const rejected = jest.fn(async () => executionResult({ passed: false, summary: "Missing tests" }))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await verifyGoalCompletion(
      {
        goalId: "goal-1",
        candidateSummary: `Candidate ${attempt}`,
        capturedGenerationId: "generation-1",
      },
      { execute: rejected }
    )
  }
  expect(await getGoal("goal-1")).toMatchObject({
    status: "paused",
    verification: { status: "failed", failureCount: 3 },
  })

  await getDb().chatGoals.update("goal-1", {
    status: "active",
    generationId: "generation-2",
    verification: undefined,
  })
  await verifyGoalCompletion(
    { goalId: "goal-1", candidateSummary: "Candidate", capturedGenerationId: "generation-2" },
    { execute: async () => executionResult({ passed: "yes", summary: "bad" }) }
  )
  expect(await getGoal("goal-1")).toMatchObject({
    status: "paused",
    verification: { status: "error" },
  })
})

describe("a Stop wins over a verifier still running", () => {
  const running = (generationId: string) => ({
    attempt: 1,
    status: "running" as const,
    idempotencyKey: `goal-verification:goal-1:${generationId}:1`,
    generationId,
    workflowRunId: "workflow-run-1",
    failureCount: 0,
    candidateSummary: "Candidate",
    updatedAt: 1,
  })

  it("a verifier error after the person stopped the goal leaves it stopped", async () => {
    await seedGoal()
    const outcome = await verifyGoalCompletion(
      { goalId: "goal-1", candidateSummary: "Candidate", capturedGenerationId: "generation-1" },
      {
        execute: async () => {
          // The person presses Stop while the verifier runs, which then fails.
          await getDb().chatGoals.update("goal-1", {
            status: "stopped",
            generationId: "generation-2",
          })
          throw new Error("verifier crashed")
        },
      }
    )
    expect(outcome).toEqual({ kind: "stale" })
    expect(await getGoal("goal-1")).toMatchObject({ status: "stopped" })
  })

  it("the boot scan never runs a stopped goal's verification again", async () => {
    await seedGoal()
    await getDb().chatGoals.update("goal-1", {
      status: "stopped",
      generationId: "generation-2",
      verification: running("generation-1"),
    })
    mockExecuteDeployedWorkflow.mockResolvedValue(
      executionResult({ passed: true, summary: "Would have passed" })
    )
    await reconcilePendingGoalVerifications()
    expect(mockExecuteDeployedWorkflow).not.toHaveBeenCalled()
    expect(await getGoal("goal-1")).toMatchObject({ status: "stopped" })
    expect(mockOnGoalTerminal).not.toHaveBeenCalled()
  })

  it("the boot scan finishes an interrupted attempt for its own generation", async () => {
    await seedGoal()
    await getDb().chatGoals.update("goal-1", { verification: running("generation-1") })
    mockExecuteDeployedWorkflow.mockResolvedValue(
      executionResult({ passed: true, summary: "Recovered" })
    )
    await reconcilePendingGoalVerifications()
    expect(mockExecuteDeployedWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "goal-verification:goal-1:generation-1:1" })
    )
    expect(await getGoal("goal-1")).toMatchObject({ status: "completed" })
  })

  it("the boot scan completes an active goal whose verification passed before the crash", async () => {
    await seedGoal()
    await getDb().chatGoals.update("goal-1", {
      verification: { ...running("generation-1"), status: "passed", summary: "All good" },
    })
    await reconcilePendingGoalVerifications()
    expect(mockExecuteDeployedWorkflow).not.toHaveBeenCalled()
    expect(await getGoal("goal-1")).toMatchObject({ status: "completed" })
    expect(mockOnGoalTerminal).toHaveBeenCalledTimes(1)

    // Run again (a second boot): a completed goal is not ended twice.
    await reconcilePendingGoalVerifications()
    expect(mockOnGoalTerminal).toHaveBeenCalledTimes(1)
  })
})
