/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SyncDelta } from "../types"
import { syncSessions } from "./sessions"
import { resolveBuiltInSkillSessionBinding } from "@/lib/skills/built-in/context"

function transportFor(rows: unknown[]): Transport {
  const delta: SyncDelta<unknown> = { rows, deleted_ids: [], next_since: 20 }
  return {
    call: jest.fn(async () => delta) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncSessions managed workspace boundary", () => {
  beforeEach(async () => {
    await getDb().sessions.clear()
  })

  it.each([false, true])("keeps paired-Host creator provenance (managed: %s)", async (managed) => {
    await syncSessions(
      transportFor([
        {
          id: "plugin",
          title: "Custom title",
          kind: "direct",
          programmaticCreator: "plugin:example",
          agentTurnOwner: { kind: "bot", id: "lecturer-bot", key: "topic" },
          imAuthorityBinding: {
            platform: "lark",
            adapterId: "lark-1",
            conversationKey: "lark:lark-1:chat:topic",
            conversationRef: { platform: "lark", adapterId: "lark-1" },
          },
          createdAt: 1,
          updatedAt: 20,
          ...(managed
            ? {
                executionContext: {
                  location: "managedWorktree",
                  projectId: "",
                  projectRoot: "/remote/private",
                  workspaceBinding: { kind: "managed", workspaceId: "mw:plugin" },
                  managedWorkspace: { availability: "available", localRoot: "/remote/private" },
                  taskWorkspace: { taskId: "task:plugin", workspaceKey: "mw:plugin" },
                },
              }
            : {}),
        },
      ]),
      { since: 0 }
    )
    expect((await getDb().sessions.get("plugin"))?.programmaticCreator).toBe("plugin:example")
    expect((await resolveBuiltInSkillSessionBinding("plugin")).personalLane).toBe("unverified")
    expect(await getDb().sessions.get("plugin")).toMatchObject({
      agentTurnOwner: { kind: "bot", id: "lecturer-bot", key: "topic" },
      imAuthorityBinding: { conversationKey: "lark:lark-1:chat:topic" },
    })
    expect((await getDb().sessions.get("plugin"))?.platformBinding).toBeUndefined()
    expect((await resolveBuiltInSkillSessionBinding("plugin")).binding?.conversationKey).toBe(
      "lark:lark-1:chat:topic"
    )
    const { listSessionsByConversationKey } = await import("@/lib/connectors/session-bindings")
    expect(await listSessionsByConversationKey("lark:lark-1:chat:topic")).toEqual([])
  })

  it("marks a managed workspace from another device as missing instead of guessing a path", async () => {
    await syncSessions(
      transportFor([
        {
          id: "s1",
          title: "Remote",
          createdAt: 1,
          updatedAt: 20,
          executionContext: {
            location: "managedWorktree",
            workspaceBinding: { kind: "managed", workspaceId: "mw:s1" },
            managedWorkspace: { availability: "available", localRoot: "/remote/private" },
            projectId: "",
            projectRoot: "/remote/private",
            taskWorkspace: { taskId: "task:s1", workspaceKey: "mw:s1" },
          },
        },
      ]),
      { since: 0 }
    )

    const context = (await getDb().sessions.get("s1"))?.executionContext
    expect(context?.projectRoot).toBe("")
    expect(context?.managedWorkspace).toEqual({ availability: "missing-on-device" })
  })

  it("preserves a matching workspace's local binding while applying remote metadata", async () => {
    await getDb().sessions.put({
      id: "s1",
      title: "Local",
      createdAt: 1,
      updatedAt: 10,
      executionContext: {
        location: "managedWorktree",
        workspaceBinding: { kind: "managed", workspaceId: "mw:s1" },
        managedWorkspace: { availability: "available", localRoot: "/local/root" },
        projectId: "",
        projectRoot: "/local/root",
        taskWorkspace: { taskId: "task:s1", workspaceKey: "mw:s1" },
      },
    } as never)

    await syncSessions(
      transportFor([
        {
          id: "s1",
          title: "Remote title",
          createdAt: 1,
          updatedAt: 20,
          executionContext: {
            location: "managedWorktree",
            workspaceBinding: { kind: "managed", workspaceId: "mw:s1" },
            managedWorkspace: { availability: "missing-on-device" },
            projectId: "",
            projectRoot: "",
            taskWorkspace: { taskId: "task:s1", workspaceKey: "mw:s1" },
          },
        },
      ]),
      { since: 0 }
    )

    const row = await getDb().sessions.get("s1")
    expect(row?.title).toBe("Remote title")
    expect(row?.executionContext?.projectRoot).toBe("/local/root")
    expect(row?.executionContext?.managedWorkspace).toEqual(
      expect.objectContaining({ availability: "available", localRoot: "/local/root" })
    )
  })

  it("reads previous plain sessions too so their device-local binding can be preserved", async () => {
    const table = getDb().sessions
    const read = jest.spyOn(table, "bulkGet")
    const rows = [
      { id: "plain", title: "Plain", createdAt: 1, updatedAt: 20 },
      {
        id: "local",
        title: "Local",
        createdAt: 1,
        updatedAt: 20,
        executionContext: { location: "local", projectId: "p", projectRoot: "/project" },
      },
    ]
    try {
      expect((await syncSessions(transportFor(rows), { since: 0 })).ok).toBe(true)
      expect(read).toHaveBeenCalledWith(["plain", "local"])
      expect(await table.get("plain")).toEqual(rows[0])
      expect(await table.get("local")).toEqual(rows[1])
    } finally {
      read.mockRestore()
    }
  })

  it("reads merge rows and preserves duplicate-id last-write behavior", async () => {
    const context = {
      location: "managedWorktree",
      projectId: "p",
      projectRoot: "/local/workspace",
      workspaceBinding: { kind: "managed", workspaceId: "workspace" },
      managedWorkspace: { availability: "available", localRoot: "/local/workspace" },
      taskWorkspace: { taskId: "task:managed", workspaceKey: "workspace" },
    }
    const table = getDb().sessions
    await table.put({
      id: "managed",
      title: "Before",
      createdAt: 1,
      updatedAt: 10,
      executionContext: context,
    } as never)
    const managed = {
      id: "managed",
      title: "First",
      createdAt: 1,
      updatedAt: 20,
      executionContext: {
        ...context,
        projectRoot: "",
        managedWorkspace: { availability: "missing-on-device" },
      },
    }
    const read = jest.spyOn(table, "bulkGet")
    try {
      expect(
        (
          await syncSessions(
            transportFor([
              managed,
              { id: "plain", title: "Plain", createdAt: 1, updatedAt: 20 },
              { ...managed, title: "Last" },
            ]),
            { since: 0 }
          )
        ).ok
      ).toBe(true)
      expect(read).toHaveBeenCalledWith(["managed", "plain", "managed"])
      expect(await table.get("managed")).toMatchObject({
        title: "Last",
        executionContext: {
          projectRoot: "/local/workspace",
          managedWorkspace: context.managedWorkspace,
        },
      })
    } finally {
      read.mockRestore()
    }
  })

  it("keeps this device's binding to A when a synced update arrives", async () => {
    const hostBinding = {
      origin: { kind: "remote" as const, hostId: "a" },
      workspaceRoot: "/a/repo",
    }
    await getDb().sessions.put({
      id: "bound",
      title: "Local",
      createdAt: 1,
      updatedAt: 10,
      hostBinding,
      workingDir: "/a/repo",
      sdkSessionId: "a-sdk",
    })
    await syncSessions(
      transportFor([
        {
          id: "bound",
          title: "Updated",
          createdAt: 1,
          updatedAt: 20,
          workingDir: "/foreign/repo",
          sdkSessionId: "foreign-sdk",
        },
      ]),
      { since: 0 }
    )
    // The binding stays; the source Host's working dir and resume id win.
    expect(await getDb().sessions.get("bound")).toMatchObject({
      title: "Updated",
      hostBinding,
      workingDir: "/foreign/repo",
      sdkSessionId: "foreign-sdk",
    })
  })

  it("ignores an inbound Host binding on both new and existing unbound rows", async () => {
    await getDb().sessions.put({ id: "existing", title: "Local", createdAt: 1, updatedAt: 10 })
    await syncSessions(
      transportFor(
        ["new", "existing"].map((id) => ({
          id,
          title: "Incoming",
          createdAt: 1,
          updatedAt: 20,
          hostBinding: { origin: { kind: "remote", hostId: "foreign" }, workspaceRoot: "/foreign" },
        }))
      ),
      { since: 0 }
    )
    for (const id of ["new", "existing"])
      expect(await getDb().sessions.get(id)).not.toHaveProperty("hostBinding")
  })
})

it("rejects cancellation after asynchronous merge preparation", async () => {
  const table = getDb().sessions
  let current = true
  const read = jest.spyOn(table, "bulkGet").mockImplementation(() =>
    Dexie.Promise.resolve().then(() => {
      current = false
      return []
    })
  )
  const write = jest.spyOn(table, "bulkPut")
  const assertCurrent = () => {
    if (!current) throw new Error("scope cancelled")
  }
  try {
    expect(
      (
        await syncSessions(
          transportFor([
            {
              id: "cancelled",
              executionContext: { workspaceBinding: { kind: "managed", workspaceId: "cancelled" } },
            },
          ]),
          { since: 0, assertCurrent }
        )
      ).ok
    ).toBe(false)
    expect(read).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    write.mockRestore()
  }
})
