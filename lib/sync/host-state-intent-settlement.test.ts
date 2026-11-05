/**
 * @jest-environment jsdom
 */
import type { AllowedHostStateIntent, HostStateAction } from "@cognia/agent-config-types/host-state"

const folders = {
  discardLocalFolder: jest.fn(async () => undefined),
  writeFolderRename: jest.fn(async () => true),
  writeFolderReorder: jest.fn(async () => undefined),
  writeFolderDelete: jest.fn(async () => undefined),
}
jest.mock("@/lib/db/session-folders", () => folders)

const sessions = {
  bulkSetSessionsPinned: jest.fn(async () => undefined),
  assignSessionToFolder: jest.fn(async () => undefined),
  setSessionRanks: jest.fn(async () => undefined),
  updateSession: jest.fn(async () => undefined),
}
jest.mock("@/lib/db/sessions", () => sessions)

const dispatchDiagnostic = jest.fn()
jest.mock("@/lib/diagnostics/bus", () => ({
  dispatchDiagnostic: (...args: unknown[]) => dispatchDiagnostic(...args),
}))

const deleteSessionsWithTeardown = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/chat/session-deletion", () => ({
  deleteSessionsWithTeardown: (...args: unknown[]) => deleteSessionsWithTeardown(...args),
}))

const moveSessionWorkspaceLocally = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  status: "moved",
}))
jest.mock("@/lib/chat/session-workspace-move-writes", () => ({
  moveSessionWorkspaceLocally: (...args: unknown[]) => moveSessionWorkspaceLocally(...args),
}))

import { settleRejectedHostStateIntent } from "./host-state-intent-settlement"

function action(intent: AllowedHostStateIntent, sessionId?: string): HostStateAction {
  return {
    channel: sessionId ? `cognia://target/t/sessions/${sessionId}` : "cognia://target/t/sessions",
    accountId: "a",
    runtimeTargetId: "t",
    hostId: "h",
    hostGeneration: 1,
    ...(sessionId ? { sessionId } : {}),
    clientId: "c",
    clientSeq: 1,
    actionId: "act-1",
    createdAt: 1,
    action: intent,
  }
}

beforeEach(() => {
  for (const mock of [...Object.values(folders), ...Object.values(sessions)]) mock.mockClear()
  deleteSessionsWithTeardown.mockClear()
  dispatchDiagnostic.mockClear()
  moveSessionWorkspaceLocally.mockReset().mockResolvedValue({ status: "moved" })
})

describe("a submit the Host could not read (ADR-0253 O05)", () => {
  it("applies nothing locally and says so", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "session.model", provider: "deepseek", model: "ds-flash" }, "s1"),
      "host_state_invalid_submit_request"
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.workspace", projectId: "p2" }, "s1"),
      "host_state_invalid_submit_request"
    )
    for (const mock of [...Object.values(folders), ...Object.values(sessions)]) {
      expect(mock).not.toHaveBeenCalled()
    }
    expect(moveSessionWorkspaceLocally).not.toHaveBeenCalled()
    expect(dispatchDiagnostic).toHaveBeenCalledTimes(2)
    expect(dispatchDiagnostic.mock.calls[0][0]).toMatchObject({
      code: "hostStateIntentRefused",
      message: "host_state_invalid_submit_request",
    })
  })
})

describe("a Host that understood and refused", () => {
  it("says so for a change the person made, with the Host's code", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "session.workspace", projectId: "p2" }, "s1"),
      "workspace_unavailable"
    )
    expect(dispatchDiagnostic).toHaveBeenCalledTimes(1)
    expect(dispatchDiagnostic.mock.calls[0][0]).toMatchObject({
      code: "hostStateIntentRefused",
      message: "workspace_unavailable",
      meta: { sessionId: "s1", extra: { kind: "session.workspace" } },
    })
  })

  it("stays quiet for a conflict, a send and a draft", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "session.pin", pinned: true }, "s1"),
      "host_state_conflict",
      "conflicted"
    )
    await settleRejectedHostStateIntent(
      action({ kind: "message.enqueue", messageId: "m", text: "t", attachments: [] }, "s1"),
      "model_access_unavailable"
    )
    await settleRejectedHostStateIntent(
      action({ kind: "draft.replace", text: "t", attachments: [] }, "s1"),
      "host_state_forbidden"
    )
    expect(dispatchDiagnostic).not.toHaveBeenCalled()
  })

  it("discards the optimistic row of a refused folder create", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "folder.create", folderId: "f1", projectId: "p1", name: "Work" }),
      "host_state_forbidden"
    )
    expect(folders.discardLocalFolder).toHaveBeenCalledWith("f1")
  })

  it("writes nothing locally for any other refused intent", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "folder.delete", folderId: "f1" }),
      "session_handoff_locked"
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.pin", pinned: true }, "s1"),
      "host_state_forbidden"
    )
    // The Host's refusal of a move (a turn it is running) is the answer.
    await settleRejectedHostStateIntent(
      action({ kind: "session.workspace", projectId: "p2" }, "s1"),
      "host_state_move_session_running"
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.model", provider: "deepseek", model: "ds-flash" }, "s1"),
      "host_state_forbidden"
    )
    for (const mock of [...Object.values(folders), ...Object.values(sessions)]) {
      expect(mock).not.toHaveBeenCalled()
    }
    expect(moveSessionWorkspaceLocally).not.toHaveBeenCalled()
  })
})

it("swallows a failing discard so a settled row stays settled", async () => {
  folders.discardLocalFolder.mockRejectedValueOnce(new Error("locked"))
  await expect(
    settleRejectedHostStateIntent(
      action({ kind: "folder.create", folderId: "f1", projectId: "p1", name: "Work" }),
      "host_state_forbidden"
    )
  ).resolves.toBeUndefined()
})
