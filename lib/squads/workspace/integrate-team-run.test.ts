import type {
  IntegrateChangesetsInput,
  IntegrationOutcome,
} from "@/lib/scm/integration/orchestrator"
import type { ChangesetReviewResult } from "@/lib/scm/review/review-changeset"
import type { AgentChangeset, CaptureChangeset, ChangesetReview } from "@/lib/scm/types"

import {
  DEFAULT_AGENT_TEAM_INTEGRATION,
  integrateTeamRun,
  integrationBranchName,
  orderByDependencies,
  type AgentTeamIntegrationDeps,
  type TeamIntegrationCandidate,
} from "./integrate-team-run"

function candidate(taskId: string, logicalRootId = "app"): TeamIntegrationCandidate {
  return {
    key: `${logicalRootId}:${taskId}`,
    taskId,
    teammateName: `mate-${taskId}`,
    logicalRootId,
    sourceRoot: `/repo/${logicalRootId}`,
    workspaceId: `ws-${logicalRootId}-${taskId}`,
  }
}

type Verdict = "approve" | "human" | "changes" | "failingCheck"

/**
 * A run where each task's review outcome is scripted, and the queue composes
 * whatever it is given except `conflicting` changesets.
 */
function scenario(
  options: {
    verdicts?: Record<string, Verdict>
    unchanged?: string[]
    conflicting?: string[]
    currentBranch?: string | null
    /** Repositories whose checkout is on a detached HEAD. */
    detachedRoots?: string[]
    /** Tasks whose capture fails with a host error. */
    failCapture?: string[]
    existingBranch?: boolean
  } = {}
) {
  const captured: CaptureChangeset[] = []
  const changesets = new Map<string, AgentChangeset>()
  const taskOf = (workspaceId: string) => workspaceId.split("-").slice(2).join("-")
  const host = {
    captureChangeset: jest.fn(async (input: CaptureChangeset) => {
      captured.push(input)
      const task = taskOf(input.workspaceId)
      if (options.unchanged?.includes(task))
        throw { code: "nothing_to_capture", message: "nothing" }
      if (options.failCapture?.includes(task))
        throw { code: "overlay_conflict", message: `src/${task}.ts` }
      const changeset = {
        changesetId: `cs-${task}`,
        headSha: `h-${task}`,
        dependsOn: input.dependsOn ?? [],
        requiredChecks: input.requiredChecks ?? [],
        checks: [],
        review: null,
      } as unknown as AgentChangeset
      changesets.set(changeset.changesetId, changeset)
      return changeset
    }),
  }
  const review = jest.fn(async (changesetId: string): Promise<ChangesetReviewResult> => {
    const changeset = changesets.get(changesetId)!
    const task = changesetId.replace(/^cs-/, "")
    const verdict = options.verdicts?.[task] ?? "approve"
    const reviewRecord: ChangesetReview = {
      headSha: changeset.headSha,
      verdict: verdict === "changes" ? "requestChanges" : "approve",
      reviewer: "agent",
      riskTier: verdict === "human" ? "high" : "low",
      reasons: [],
      findings: [],
      requiresHumanApproval: verdict === "human",
      recordedAt: 1,
    }
    const reviewed = {
      ...changeset,
      review: reviewRecord,
      requiredChecks: verdict === "failingCheck" ? ["unit"] : changeset.requiredChecks,
      checks:
        verdict === "failingCheck"
          ? [
              {
                headSha: changeset.headSha,
                profileId: "unit",
                outcome: "failed" as const,
                tier: null,
                reportDigest: null,
                logTail: null,
                ranAt: 1,
              },
            ]
          : [],
    }
    return { changeset: reviewed, policy: null, risk: null, agent: null, checks: [] }
  })
  const integrate = jest.fn(
    async (input: IntegrateChangesetsInput): Promise<IntegrationOutcome> => ({
      kind: "published",
      analysis: {
        order: input.changesetIds,
        predictedConflicts: [],
        overlaps: [],
        prediction: "mergeTree",
        cycles: [],
      },
      run: {
        integrationId: `int-${input.targetRef}`,
        resultSha: "result",
        items: input.changesetIds.map((changesetId) => ({
          changesetId,
          headSha: "h",
          outcome: options.conflicting?.includes(changesetId) ? "conflicted" : "merged",
          conflictFiles: [],
          commitSha: null,
        })),
      } as never,
      dropped: [],
    })
  )
  const createBranch = jest.fn(async () => undefined)
  const deps: AgentTeamIntegrationDeps = {
    host: host as never,
    review,
    integrate,
    currentBranch: jest.fn(async (sourceRoot: string) =>
      options.detachedRoots?.some((root) => sourceRoot === `/repo/${root}`)
        ? null
        : options.currentBranch === undefined
          ? "main"
          : options.currentBranch
    ),
    branchExists: jest.fn(async () => options.existingBranch ?? false),
    createBranch,
    signal: new AbortController().signal,
  }
  return { deps, captured, host, review, integrate, createBranch }
}

describe("orderByDependencies", () => {
  it("puts every task after the tasks it depends on", () => {
    const ordered = orderByDependencies([candidate("c"), candidate("a"), candidate("b")], {
      c: ["b"],
      b: ["a"],
    })
    expect(ordered.map((entry) => entry.taskId)).toEqual(["a", "b", "c"])
  })

  it("ignores dependencies on tasks that are not candidates and keeps cycles stable", () => {
    expect(
      orderByDependencies([candidate("a")], { a: ["gone"] }).map((entry) => entry.taskId)
    ).toEqual(["a"])
    const cyclic = orderByDependencies([candidate("a"), candidate("b")], { a: ["b"], b: ["a"] })
    expect(cyclic.map((entry) => entry.taskId).sort()).toEqual(["a", "b"])
  })
})

describe("integrationBranchName", () => {
  it("is one branch per run, suffixed per repository only when there are several", () => {
    expect(integrationBranchName("run 1", "app", false)).toBe("agent/run-1/integrated")
    expect(integrationBranchName("run-1", "docs", true)).toBe("agent/run-1/integrated-docs")
  })
})

describe("integrateTeamRun", () => {
  it("captures in dependency order, declares dependencies, and integrates into a run branch", async () => {
    const s = scenario()
    const result = await integrateTeamRun(
      "run-1",
      [candidate("b"), candidate("a")],
      { b: ["a"] },
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(s.createBranch).toHaveBeenCalledWith("/repo/app", "agent/run-1/integrated", "HEAD")
    expect(s.captured.map((input) => [input.workspaceId, input.dependsOn])).toEqual([
      ["ws-app-a", []],
      ["ws-app-b", ["cs-a"]],
    ])
    expect(s.integrate).toHaveBeenCalledWith(
      expect.objectContaining({
        changesetIds: ["cs-a", "cs-b"],
        targetRef: "refs/heads/agent/run-1/integrated",
        strategy: "merge",
        onConflict: "skip",
      })
    )
    expect(result.roots[0]).toEqual(
      expect.objectContaining({
        outcome: "published",
        createdBranch: "agent/run-1/integrated",
        merged: ["cs-a", "cs-b"],
        integrationId: "int-refs/heads/agent/run-1/integrated",
      })
    )
    expect(result.changesets).toEqual({ "app:a": "cs-a", "app:b": "cs-b" })
  })

  it("holds back what owes a human, and everything that depends on it", async () => {
    const s = scenario({ verdicts: { a: "human" } })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a"), candidate("b"), candidate("c")],
      { b: ["a"] },
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(s.integrate).toHaveBeenCalledWith(expect.objectContaining({ changesetIds: ["cs-c"] }))
    expect(result.roots[0].awaitingApproval.sort()).toEqual(["cs-a", "cs-b"])
    expect(result.roots[0].holds).toEqual([
      {
        key: "app:b",
        changesetId: "cs-b",
        cause: "provider_awaiting_approval",
        provider: { key: "app:a", logicalRootId: "app", taskId: "a", changesetId: "cs-a" },
      },
    ])
  })

  it("holds a dependent whose prerequisite's capture failed, in the same repository", async () => {
    const s = scenario({ failCapture: ["a"] })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a"), candidate("b"), candidate("c")],
      { b: ["a"] },
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(s.integrate).toHaveBeenCalledWith(expect.objectContaining({ changesetIds: ["cs-c"] }))
    expect(result.roots[0].failed).toEqual([{ key: "app:a", reason: "overlay_conflict" }])
    expect(result.roots[0].awaitingApproval).toEqual(["cs-b"])
    expect(result.roots[0].holds).toEqual([
      {
        key: "app:b",
        changesetId: "cs-b",
        cause: "provider_failed",
        provider: { key: "app:a", logicalRootId: "app", taskId: "a", changesetId: null },
      },
    ])
  })

  it("holds a dependent whose prerequisite's teammate did not succeed", async () => {
    const s = scenario()
    const result = await integrateTeamRun(
      "run-1",
      [candidate("b")],
      { b: ["a"] },
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps,
      { unsuccessfulTasks: ["a"] }
    )
    expect(s.integrate).not.toHaveBeenCalled()
    expect(result.roots[0].holds).toEqual([
      {
        key: "app:b",
        changesetId: "cs-b",
        cause: "provider_failed",
        provider: { key: null, logicalRootId: null, taskId: "a", changesetId: null },
      },
    ])
  })

  it("never integrates a change a reviewer asked to change, or one whose checks did not pass", async () => {
    const s = scenario({ verdicts: { a: "changes", b: "failingCheck" } })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a"), candidate("b")],
      {},
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(s.integrate).not.toHaveBeenCalled()
    expect(result.roots[0]).toEqual(
      expect.objectContaining({
        outcome: "nothingToIntegrate",
        changesRequested: ["cs-a"],
        awaitingApproval: ["cs-b"],
      })
    )
  })

  it("passes the union of the run's and each review's required checks to the queue", async () => {
    const s = scenario()
    s.review.mockImplementation(async (changesetId: string) => ({
      changeset: {
        changesetId,
        headSha: "h",
        dependsOn: [],
        requiredChecks: [],
        checks: [
          {
            headSha: "h",
            profileId: "lint",
            outcome: "passed",
            tier: null,
            reportDigest: null,
            logTail: null,
            ranAt: 1,
          },
        ],
        review: { headSha: "h", verdict: "approve", requiresHumanApproval: false },
      } as never,
      policy: { requiredChecks: ["lint"] } as never,
      risk: null,
      agent: null,
      checks: [],
    }))
    await integrateTeamRun(
      "run-1",
      [candidate("a")],
      {},
      { ...DEFAULT_AGENT_TEAM_INTEGRATION, requiredChecks: ["unit"] },
      s.deps
    )
    expect(s.integrate.mock.calls[0][0].requiredChecks.sort()).toEqual(["lint", "unit"])
    expect(s.captured[0].requiredChecks).toEqual(["unit"])
  })

  it("reports teammates that changed nothing and keeps the rest", async () => {
    const s = scenario({ unchanged: ["a"] })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a"), candidate("b")],
      {},
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(result.roots[0].unchanged).toEqual(["app:a"])
    expect(result.roots[0].merged).toEqual(["cs-b"])
  })

  it("reports a conflicting changeset from the queue without counting it merged", async () => {
    const s = scenario({ conflicting: ["cs-b"] })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a"), candidate("b")],
      {},
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(result.roots[0]).toEqual(
      expect.objectContaining({ merged: ["cs-a"], conflicted: ["cs-b"] })
    )
  })

  it("integrates into the base branch only when asked, and refuses a detached checkout", async () => {
    const onBase = scenario()
    await integrateTeamRun(
      "run-1",
      [candidate("a")],
      {},
      { ...DEFAULT_AGENT_TEAM_INTEGRATION, target: "base" },
      onBase.deps
    )
    expect(onBase.createBranch).not.toHaveBeenCalled()
    expect(onBase.integrate).toHaveBeenCalledWith(
      expect.objectContaining({ targetRef: "refs/heads/main" })
    )

    const detached = scenario({ currentBranch: null })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a")],
      {},
      { ...DEFAULT_AGENT_TEAM_INTEGRATION, target: "base" },
      detached.deps
    )
    expect(result.roots[0]).toEqual(
      expect.objectContaining({ outcome: "blocked", reason: "base_detached" })
    )
    expect(detached.host.captureChangeset).not.toHaveBeenCalled()
  })

  it("reuses the run branch on a rerun instead of recreating it", async () => {
    const s = scenario({ existingBranch: true })
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a")],
      {},
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(s.createBranch).not.toHaveBeenCalled()
    expect(result.roots[0].createdBranch).toBeNull()
  })

  it("integrates each repository separately, one branch each", async () => {
    const s = scenario()
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a", "app"), candidate("b", "docs")],
      {},
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(s.createBranch.mock.calls).toEqual([
      ["/repo/app", "agent/run-1/integrated-app", "HEAD"],
      ["/repo/docs", "agent/run-1/integrated-docs", "HEAD"],
    ])
    expect(result.roots.map((root) => [root.logicalRootId, root.merged])).toEqual([
      ["app", ["cs-a"]],
      ["docs", ["cs-b"]],
    ])
  })

  it("records a capture or review failure and goes on with the others", async () => {
    const s = scenario()
    s.host.captureChangeset.mockRejectedValueOnce({ code: "overlay_conflict", message: "src/a.ts" })
    s.review.mockRejectedValueOnce(new Error("no model"))
    const result = await integrateTeamRun(
      "run-1",
      [candidate("a"), candidate("b"), candidate("c")],
      {},
      DEFAULT_AGENT_TEAM_INTEGRATION,
      s.deps
    )
    expect(result.roots[0].failed).toEqual([
      { key: "app:a", reason: "overlay_conflict" },
      { key: "app:b", reason: "review_failed" },
    ])
    expect(result.roots[0].merged).toEqual(["cs-c"])
  })

  describe("across repositories", () => {
    // The prior audit's counterexample (docs/evidence/2026-11-08-cognia-multi-repo-development-audit.md, O5):
    // the app task depends on the SDK task, and the SDK review asks for changes.
    it("does not integrate a consumer while its provider in another repository owes changes", async () => {
      const s = scenario({ verdicts: { sdk: "changes" } })
      const result = await integrateTeamRun(
        "run-1",
        [candidate("sdk", "sdk"), candidate("app", "app")],
        { app: ["sdk"] },
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps
      )
      expect(s.integrate).not.toHaveBeenCalled()
      const [sdk, app] = result.roots
      expect(sdk.changesRequested).toEqual(["cs-sdk"])
      expect(app).toEqual(expect.objectContaining({ merged: [], awaitingApproval: ["cs-app"] }))
      expect(app.holds).toEqual([
        {
          key: "app:app",
          changesetId: "cs-app",
          cause: "provider_changes_requested",
          provider: { key: "sdk:sdk", logicalRootId: "sdk", taskId: "sdk", changesetId: "cs-sdk" },
        },
      ])
    })

    it("integrates the provider's repository first and never declares a foreign changeset to the host", async () => {
      const s = scenario()
      const result = await integrateTeamRun(
        "run-1",
        // Input order puts the consumer first; dependency order must not.
        [candidate("app", "app"), candidate("sdk", "sdk")],
        { app: ["sdk"] },
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps
      )
      expect(s.integrate.mock.calls.map(([input]) => input.changesetIds)).toEqual([
        ["cs-sdk"],
        ["cs-app"],
      ])
      // The host composes one repository; a changeset in another is not its to order.
      expect(s.captured.map((input) => [input.workspaceId, input.dependsOn])).toEqual([
        ["ws-sdk-sdk", []],
        ["ws-app-app", []],
      ])
      // Results keep the run's repository order.
      expect(result.roots.map((root) => [root.logicalRootId, root.merged, root.holds])).toEqual([
        ["app", ["cs-app"], []],
        ["sdk", ["cs-sdk"], []],
      ])
    })

    it("holds a consumer whose provider's capture failed in another repository", async () => {
      const s = scenario({ failCapture: ["sdk"] })
      const result = await integrateTeamRun(
        "run-1",
        [candidate("sdk", "sdk"), candidate("app", "app")],
        { app: ["sdk"] },
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps
      )
      expect(s.integrate).not.toHaveBeenCalled()
      expect(result.roots[1].holds).toEqual([
        expect.objectContaining({
          key: "app:app",
          cause: "provider_failed",
          provider: { key: "sdk:sdk", logicalRootId: "sdk", taskId: "sdk", changesetId: null },
        }),
      ])
    })

    it("holds a consumer whose provider went to its queue and did not merge", async () => {
      const s = scenario({ conflicting: ["cs-sdk"] })
      const result = await integrateTeamRun(
        "run-1",
        [candidate("sdk", "sdk"), candidate("app", "app")],
        { app: ["sdk"] },
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps
      )
      expect(s.integrate.mock.calls.map(([input]) => input.changesetIds)).toEqual([["cs-sdk"]])
      expect(result.roots[0].conflicted).toEqual(["cs-sdk"])
      expect(result.roots[1].holds).toEqual([
        expect.objectContaining({ key: "app:app", cause: "provider_not_merged" }),
      ])
    })

    it("holds a consumer whose provider's repository was blocked", async () => {
      const s = scenario({ detachedRoots: ["sdk"] })
      const result = await integrateTeamRun(
        "run-1",
        [candidate("sdk", "sdk"), candidate("app", "app")],
        { app: ["sdk"] },
        { ...DEFAULT_AGENT_TEAM_INTEGRATION, target: "base" },
        s.deps
      )
      expect(result.roots[0]).toEqual(
        expect.objectContaining({ outcome: "blocked", reason: "base_detached" })
      )
      expect(s.integrate).not.toHaveBeenCalled()
      expect(result.roots[1].holds).toEqual([
        expect.objectContaining({ key: "app:app", cause: "provider_blocked" }),
      ])
    })

    it("follows a repository binding's dependsOn when no task edge exists", async () => {
      const s = scenario({ verdicts: { sdk: "human" } })
      const result = await integrateTeamRun(
        "run-1",
        [candidate("app", "app"), candidate("docs", "docs"), candidate("sdk", "sdk")],
        {},
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps,
        { repositoryDependencies: { app: ["sdk"], docs: ["sdk"] } }
      )
      expect(s.integrate).not.toHaveBeenCalled()
      for (const root of result.roots.filter((entry) => entry.logicalRootId !== "sdk")) {
        expect(root.holds).toEqual([
          expect.objectContaining({
            cause: "provider_awaiting_approval",
            provider: expect.objectContaining({ logicalRootId: "sdk", changesetId: "cs-sdk" }),
          }),
        ])
      }
    })

    it("integrates nothing in a repository dependency cycle", async () => {
      const s = scenario()
      const result = await integrateTeamRun(
        "run-1",
        [candidate("app", "app"), candidate("sdk", "sdk")],
        {},
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps,
        { repositoryDependencies: { app: ["sdk"], sdk: ["app"] } }
      )
      expect(s.integrate).not.toHaveBeenCalled()
      const causes = Object.fromEntries(
        result.roots.map((root) => [root.logicalRootId, root.holds.map((hold) => hold.cause)])
      )
      expect(causes).toEqual({ sdk: ["dependency_cycle"], app: ["provider_held"] })
    })

    it("lets a consumer of an unchanged provider through", async () => {
      const s = scenario({ unchanged: ["sdk"] })
      const result = await integrateTeamRun(
        "run-1",
        [candidate("sdk", "sdk"), candidate("app", "app")],
        { app: ["sdk"] },
        DEFAULT_AGENT_TEAM_INTEGRATION,
        s.deps
      )
      expect(result.roots[1]).toEqual(expect.objectContaining({ merged: ["cs-app"], holds: [] }))
    })
  })
})
