/**
 * E2E-only issue fixtures, hung off `window.__cogniaE2EIssues` by
 * `expose-test-globals.tsx` behind the same `NEXT_PUBLIC_E2E === "1"` gate.
 *
 * The state-flow spec (`tests/e2e/issues/issue-state-flow.spec.ts`) needs a
 * run it can hold open, finish and cancel on cue. A real engine cannot give
 * that in a browser: the agent-task adapter dispatches to the Scheduler and an
 * LLM. So the fixture swaps the ENGINE, not the bridge. A fake adapter takes
 * the agent-task adapter's id (so the Run dialog, run history and badges read
 * exactly as they do for a real run) and is registered only after the real
 * one, which the tracker's boot registers as usual. Everything between the
 * click and the engine (refuse-or-dispatch, the claim, the bind, the run
 * lock, settle-and-move, the cancel hand-back) is the production bridge.
 *
 * Production registration is untouched: this module is reached only through a
 * dynamic import inside the gated effect, which the bundler drops from builds
 * without the gate.
 */

import type { AgentTaskStatus } from "@/types/agent/agent-task"
import type { IssueRun } from "@/types/issues"
import type { IssueRunAdapter, IssueRunPollResult } from "@/lib/issues/run/types"

/** How a fake engine item ends when the spec finishes it. */
export type FakeIssueRunOutcome = "succeeded" | "failed"

type FakeItemState = "running" | FakeIssueRunOutcome | "cancelled"

export interface FakeIssueRunEngine {
  readonly adapter: IssueRunAdapter
  /** End one engine item. The bridge learns it on its next `poll`. */
  finish(targetId: string, outcome: FakeIssueRunOutcome): void
  /** Engine items that started and have not ended, oldest first. */
  running(): string[]
}

const TARGET_PREFIX = "e2e-run:"

/**
 * An engine that accepts every issue at once and holds each item `running`
 * until `finish` or a cancel. An item it never started (a run from before the
 * fake was installed) settles as failed rather than staying active forever,
 * the same answer the reconciler gives a run whose adapter is gone.
 */
export function createFakeIssueRunEngine(adapterId: string): FakeIssueRunEngine {
  const items = new Map<string, FakeItemState>()

  const adapter: IssueRunAdapter = {
    id: adapterId,
    kind: "agent-task",
    canRun: async () => ({ ok: true }),
    start: async (_target, context) => {
      const targetId = `${TARGET_PREFIX}${context.runId}`
      items.set(targetId, "running")
      return { targetId, status: "running" }
    },
    poll: async (run: IssueRun): Promise<IssueRunPollResult> => {
      const state = items.get(run.targetId)
      switch (state) {
        case undefined:
          return { status: "failed", error: "the e2e engine has no record of this run" }
        case "running":
        case "cancelled":
          // A cancelled item is settled by the bridge itself once `cancel`
          // resolves; the engine has nothing new to report.
          return null
        case "succeeded":
          return { status: "succeeded", summary: "e2e run finished", artifacts: [] }
        case "failed":
          return { status: "failed", error: "e2e run failed" }
      }
    },
    cancel: async (run) => {
      if (items.get(run.targetId) === "running") items.set(run.targetId, "cancelled")
    },
  }

  return {
    adapter,
    finish(targetId, outcome) {
      if (items.get(targetId) !== "running") {
        throw new Error(`e2e engine item ${targetId} is not running`)
      }
      items.set(targetId, outcome)
    },
    running() {
      return [...items].filter(([, state]) => state === "running").map(([id]) => id)
    },
  }
}

export interface E2EIssueFixtures {
  /**
   * Replace the agent-task engine with the fake. Waits for the tracker's boot
   * to register the real adapter first, so the boot cannot overwrite the fake
   * afterwards. Idempotent.
   */
  installFakeRunEngine(): Promise<void>
  /** Finish the active run of the issue printed as `identifier`, then reconcile. */
  finishActiveRun(identifier: string, outcome: FakeIssueRunOutcome): Promise<void>
  /** Add an agent task to the active workspace; returns its id. */
  seedAgentTask(draft: { agentId: string; title: string }): Promise<string>
  /** Move an agent task through its own state machine, as its engine would. */
  moveAgentTask(taskId: string, to: AgentTaskStatus): Promise<void>
}

/** How long `installFakeRunEngine` waits for the tracker to boot its adapters. */
export const ISSUE_BRIDGE_BOOT_TIMEOUT_MS = 20_000

export interface E2EIssueFixtureDeps {
  /** The workspace the board shows; agent tasks are seeded into it. */
  activeWorkspaceId: () => string | null
}

export function createE2EIssueFixtures(deps: E2EIssueFixtureDeps): E2EIssueFixtures {
  let engine: FakeIssueRunEngine | null = null

  return {
    async installFakeRunEngine() {
      if (engine) return
      const [{ getIssueRunRegistry }, { AGENT_TASK_RUN_ADAPTER_ID }] = await Promise.all([
        import("@/lib/issues/run/registry"),
        import("@/lib/issues/run/agent-task-adapter"),
      ])
      const registry = getIssueRunRegistry()
      const booted = await registry.waitFor(AGENT_TASK_RUN_ADAPTER_ID, ISSUE_BRIDGE_BOOT_TIMEOUT_MS)
      if (!booted) {
        throw new Error("the issue tracker never registered its run adapters")
      }
      const fake = createFakeIssueRunEngine(AGENT_TASK_RUN_ADAPTER_ID)
      registry.register(fake.adapter)
      engine = fake
    },

    async finishActiveRun(identifier, outcome) {
      if (!engine) throw new Error("installFakeRunEngine() first")
      const [{ getIssueByIdentifier }, { listIssueRuns }, { reconcileIssueRuns }] =
        await Promise.all([
          import("@/lib/db/issues"),
          import("@/lib/db/issue-runs"),
          import("@/lib/issues/run/registry"),
        ])
      const issue = await getIssueByIdentifier(identifier)
      if (!issue) throw new Error(`no issue is identified as ${identifier}`)
      const [run] = await listIssueRuns({ issueId: issue.id, activeOnly: true })
      if (!run) throw new Error(`${identifier} has no active run`)
      engine.finish(run.targetId, outcome)
      await reconcileIssueRuns()
    },

    async seedAgentTask({ agentId, title }) {
      const { createAgentTask } = await import("@/lib/db/agent-tasks")
      const projectId = deps.activeWorkspaceId()
      if (!projectId) throw new Error("no active workspace to seed an agent task into")
      const task = await createAgentTask({ agentId, projectId, title, description: "" })
      return task.id
    },

    async moveAgentTask(taskId, to) {
      const { moveAgentTask } = await import("@/lib/db/agent-tasks")
      await moveAgentTask(taskId, to)
    },
  }
}
