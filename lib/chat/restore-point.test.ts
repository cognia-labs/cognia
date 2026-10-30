import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { ApplyOutcome, PatchSet } from "@/lib/task-workspace/types"
import {
  assistantMessagesAfter,
  planFileRestore,
  runFileRestore,
  turnPatchRunId,
  type RestoreTurnState,
} from "./restore-point"

function row(id: string, overrides: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id,
    runId: 1,
    sessionId: "s1",
    taskWorkspaceRunId: `run:${id}`,
    assistantMessageId: `a-${id}`,
    workspaceRoot: "/repo",
    origin: { kind: "local" },
    agentKind: "in-app",
    model: null,
    ts: 1,
    totalFiles: 1,
    totalAdded: 2,
    totalRemoved: 1,
    files: [{ path: `${id}.ts`, added: 2, removed: 1, isNew: false, hunks: [] }],
    truncated: false,
    measurement: "taskWorkspace",
    ...overrides,
  }
}

function patch(runId: string, overrides: Partial<PatchSet> = {}): PatchSet {
  return {
    patchId: `p-${runId}`,
    taskId: "t",
    runId,
    state: "applied",
    baseRevision: 0,
    appliedRevision: 1,
    reversible: true,
    appliedSelectionKnown: true,
    files: [],
    ...overrides,
  } as PatchSet
}

function state(id: string, rowOverrides = {}, patchOverrides = {}): RestoreTurnState {
  const r = row(id, rowOverrides)
  return {
    row: r,
    patch: r.taskWorkspaceRunId ? patch(r.taskWorkspaceRunId, patchOverrides) : null,
  }
}

describe("assistantMessagesAfter", () => {
  it("lists the replies after the message, oldest first", () => {
    const messages = [
      { id: "u1", role: "user" as const },
      { id: "a1", role: "assistant" as const },
      { id: "u2", role: "user" as const },
      { id: "a2", role: "assistant" as const },
      { id: "a3", role: "assistant" as const },
    ]
    expect(assistantMessagesAfter(messages, "u2")).toEqual(["a2", "a3"])
    expect(assistantMessagesAfter(messages, "u1")).toEqual(["a1", "a2", "a3"])
    expect(assistantMessagesAfter(messages, "missing")).toEqual([])
  })
})

describe("turnPatchRunId", () => {
  it("names a ledger run only for a ledger-measured turn", () => {
    expect(turnPatchRunId(row("x"))).toBe("run:x")
    expect(turnPatchRunId(row("x", { measurement: "legacyFingerprint" }))).toBeNull()
  })
})

describe("planFileRestore", () => {
  it("retains exact root, Host, contribution and applied-hunk scope for confirmation", () => {
    const origin = { kind: "remote" as const, hostId: "host-a", accountId: "account-a" }
    const captured = state(
      "a",
      {},
      {
        files: [
          { path: "user.txt", origin: "user" },
          { path: "unknown.txt", origin: "unknown" },
          { path: "not-applied.txt", origin: "agent" },
        ],
        appliedSelection: [
          { path: "user.txt", hunkIds: ["h1"] },
          { path: "unknown.txt", hunkIds: [] },
        ],
      }
    )
    captured.run = { runId: "run:a", workspaceRoot: "/remote/project", origin }
    const plan = planFileRestore([captured])
    expect(plan).toMatchObject({
      kind: "undoable",
      files: 2,
      targets: [
        {
          run: captured.run,
          files: [
            { path: "user.txt", origin: "user", hunkIds: ["h1"] },
            { path: "unknown.txt", origin: "unknown", hunkIds: [] },
          ],
        },
      ],
    })
  })
  it("blocks restoration when any later capture is unavailable, including zero counted files", () => {
    expect(
      planFileRestore([
        state("known"),
        state("unknown", {
          measurement: "unavailable",
          trackingState: "unavailable",
          totalFiles: 0,
          files: [],
        }),
      ])
    ).toMatchObject({ kind: "blocked", reason: "untracked", turns: 2 })
  })
  it("has nothing to do when no later turn changed files", () => {
    expect(planFileRestore([])).toEqual({ kind: "none" })
    expect(planFileRestore([state("a", { totalFiles: 0, files: [] })])).toEqual({ kind: "none" })
  })

  it("undoes every later turn, newest first", () => {
    expect(planFileRestore([state("a"), state("b")])).toEqual({
      kind: "undoable",
      runIds: ["run:b", "run:a"],
      turns: 2,
      files: 2,
      targets: [
        {
          run: { runId: "run:b", workspaceRoot: "/repo", origin: { kind: "local" } },
          files: [{ path: "b.ts", origin: "unknown", hunkIds: [] }],
        },
        {
          run: { runId: "run:a", workspaceRoot: "/repo", origin: { kind: "local" } },
          files: [{ path: "a.ts", origin: "unknown", hunkIds: [] }],
        },
      ],
    })
  })

  it("skips a turn already undone, and says so when all of them are", () => {
    expect(planFileRestore([state("a", {}, { state: "reverted" }), state("b")])).toMatchObject({
      kind: "undoable",
      runIds: ["run:b"],
    })
    expect(planFileRestore([state("a", { adoptionState: "reverted" })])).toEqual({
      kind: "undone",
    })
  })

  it("refuses all of it when one turn has no revertible patch", () => {
    expect(
      planFileRestore([state("a"), state("b", { measurement: "legacyFingerprint" })])
    ).toMatchObject({ kind: "blocked", reason: "untracked" })
    expect(planFileRestore([state("a"), state("b", {}, { reversible: false })])).toMatchObject({
      kind: "blocked",
      reason: "irreversible",
    })
    expect(planFileRestore([state("a", {}, { state: "conflict" })])).toMatchObject({
      kind: "blocked",
      reason: "irreversible",
    })
  })
})

describe("runFileRestore", () => {
  it("keeps distinct Host owners when roots reuse a run ID", async () => {
    const undo = jest.fn().mockResolvedValue({ state: "reverted", conflicts: [], revision: 1 })
    const refs = [
      {
        runId: "same-run",
        workspaceRoot: "/repo",
        origin: { kind: "remote" as const, hostId: "A" },
      },
      {
        runId: "same-run",
        workspaceRoot: "/repo",
        origin: { kind: "remote" as const, hostId: "B" },
      },
    ]
    await runFileRestore(["same-run", "same-run"], undo, refs)
    expect(undo.mock.calls).toEqual([
      ["same-run", refs[0].origin],
      ["same-run", refs[1].origin],
    ])
  })
  const outcome = (state: ApplyOutcome["state"], conflicts = 0): ApplyOutcome => ({
    state,
    revision: 1,
    conflicts: Array.from({ length: conflicts }, (_, i) => ({ path: `f${i}`, reason: "edited" })),
  })

  it("undoes each run in order", async () => {
    const undo = jest.fn(async (_runId: string) => outcome("reverted"))
    await expect(runFileRestore(["run:b", "run:a"], undo)).resolves.toEqual({
      state: "reverted",
      undone: 2,
    })
    expect(undo.mock.calls.map(([id]) => id)).toEqual(["run:b", "run:a"])
  })

  it("stops at a conflict instead of undoing older turns underneath it", async () => {
    const undo = jest
      .fn<Promise<ApplyOutcome>, [string]>()
      .mockResolvedValueOnce(outcome("reverted"))
      .mockResolvedValueOnce(outcome("conflict", 2))
    await expect(runFileRestore(["run:c", "run:b", "run:a"], undo)).resolves.toEqual({
      state: "conflict",
      undone: 1,
      runId: "run:b",
      conflicts: 2,
    })
    expect(undo).toHaveBeenCalledTimes(2)
  })

  it("stops when the ledger did not revert a run", async () => {
    const undo = jest.fn(async (_runId: string) => outcome("applied"))
    await expect(runFileRestore(["run:a"], undo)).resolves.toEqual({
      state: "notReverted",
      undone: 0,
      runId: "run:a",
    })
  })
})
