/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { getCodeAdoptionTurn, persistCodeAdoptionTurn } from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

const legacy: CodeAdoptionTurnRow = {
  id: "legacy:1",
  sessionId: "legacy",
  runId: 1,
  workspaceRoot: "/repo",
  agentKind: "in-app",
  model: null,
  ts: 1,
  totalFiles: 1,
  totalAdded: 1,
  totalRemoved: 0,
  files: [{ path: "same.ts", added: 1, removed: 0, isNew: true, hunks: [] }],
  truncated: false,
}

beforeEach(async () => {
  await getDb().codeAdoptionTurns.clear()
})

it("keeps legacy serialized rows valid without inventing captured provenance", async () => {
  await persistCodeAdoptionTurn(JSON.parse(JSON.stringify(legacy)))
  const restored = await getCodeAdoptionTurn(legacy.id)
  expect(restored).toEqual(legacy)
  expect(restored).not.toHaveProperty("taskWorkspaceRuns")
  expect(restored).not.toHaveProperty("origin")
})

it("round-trips same-path multi-root captures with distinct Host ownership and unknown contributors", async () => {
  const row: CodeAdoptionTurnRow = {
    ...legacy,
    id: "captured:1",
    measurement: "taskWorkspace",
    taskWorkspaceRunId: "run:a",
    bundleTurnId: "bundle-turn",
    assistantMessageId: "answer",
    origin: { kind: "local" },
    taskWorkspaceRuns: [
      { runId: "run:a", workspaceRoot: "/one", origin: { kind: "local" } },
      {
        runId: "run:b",
        workspaceRoot: "/two",
        origin: { kind: "remote", hostId: "host-b", accountId: "account-b" },
      },
    ],
    capturedFiles: [
      {
        ...legacy.files[0],
        taskWorkspaceRunId: "run:a",
        workspaceRoot: "/one",
        origin: "agent",
        statsKnown: true,
      },
      {
        ...legacy.files[0],
        taskWorkspaceRunId: "run:b",
        workspaceRoot: "/two",
        origin: "unknown",
        statsKnown: false,
      },
    ],
  }
  await persistCodeAdoptionTurn(JSON.parse(JSON.stringify(row)))
  const restored = await getCodeAdoptionTurn(row.id)
  expect(restored).toEqual(row)
  expect(
    restored?.capturedFiles?.map((file) => [
      file.taskWorkspaceRunId,
      file.workspaceRoot,
      file.path,
      file.origin,
    ])
  ).toEqual([
    ["run:a", "/one", "same.ts", "agent"],
    ["run:b", "/two", "same.ts", "unknown"],
  ])
})
