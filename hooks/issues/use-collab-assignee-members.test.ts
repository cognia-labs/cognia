/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"

import type { CurrentCollabContext } from "@/lib/collab/runtime-client"
import type { CollabWorkspaceMirrorRow } from "@/lib/db/collab-workspace-mirror-types"
import { useCollabAssigneeMembers } from "./use-collab-assignee-members"

const ME = "usr_me"
const ROSTER = [
  { userId: "usr_cat", displayName: "Cat", role: "member", orgMember: true },
  { userId: ME, displayName: "Me", role: "maintainer", orgMember: true },
  { userId: "usr_ada", displayName: "Ada", role: "member", orgMember: true },
]

const workspaceRow = (id: string): CollabWorkspaceMirrorRow => ({
  id,
  orgId: "org_1",
  name: "Shared",
  createdAt: 1,
  updatedAt: 1,
  fetchedAt: 1,
})

function context(listWorkspaceMembers: jest.Mock): CurrentCollabContext {
  return {
    localAccountId: "local",
    orgId: "org_1",
    userId: ME,
    client: { listWorkspaceMembers } as unknown as CurrentCollabContext["client"],
  }
}

describe("useCollabAssigneeMembers", () => {
  it("offers the shared workspace's members, without the signed-in person", async () => {
    const list = jest.fn(async () => ROSTER)
    const readWorkspace = jest.fn(async (id: string) => workspaceRow(id))
    const resolveContext = jest.fn(async () => context(list))
    const { result } = renderHook(() =>
      useCollabAssigneeMembers("ws_1", { readWorkspace, resolveContext })
    )

    await waitFor(() => expect(result.current.options).toHaveLength(2))
    expect(list).toHaveBeenCalledWith("org_1", "ws_1")
    expect(result.current.options).toEqual([
      {
        key: "human:usr_ada",
        actor: { kind: "human", id: "usr_ada", label: "Ada" },
        group: "member",
      },
      {
        key: "human:usr_cat",
        actor: { kind: "human", id: "usr_cat", label: "Cat" },
        group: "member",
      },
    ])
  })

  it("asks nobody for a workspace that is not shared", async () => {
    const readWorkspace = jest.fn(async () => undefined)
    const resolveContext = jest.fn(async () => context(jest.fn()))
    const { result } = renderHook(() =>
      useCollabAssigneeMembers("ws_local", { readWorkspace, resolveContext })
    )
    await waitFor(() => expect(readWorkspace).toHaveBeenCalledWith("ws_local"))
    expect(result.current.options).toEqual([])
    expect(resolveContext).not.toHaveBeenCalled()
  })

  it("asks nobody without a workspace", async () => {
    const readWorkspace = jest.fn(async (id: string) => workspaceRow(id))
    const { result } = renderHook(() => useCollabAssigneeMembers(null, { readWorkspace }))
    await act(async () => {})
    expect(readWorkspace).not.toHaveBeenCalled()
    expect(result.current.options).toEqual([])
  })

  it("asks the server again on reload and drops somebody who left", async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce(ROSTER)
      .mockResolvedValueOnce(ROSTER.filter((member) => member.userId !== "usr_cat"))
    const readWorkspace = jest.fn(async (id: string) => workspaceRow(id))
    const resolveContext = jest.fn(async () => context(list))
    const { result } = renderHook(() =>
      useCollabAssigneeMembers("ws_1", { readWorkspace, resolveContext })
    )
    await waitFor(() => expect(result.current.options).toHaveLength(2))

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.options).toHaveLength(1))
    expect(result.current.options[0]!.actor).toEqual({
      kind: "human",
      id: "usr_ada",
      label: "Ada",
    })
    expect(list).toHaveBeenCalledTimes(2)
  })
})
