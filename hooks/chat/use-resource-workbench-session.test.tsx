/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useResourceWorkbenchSession } from "./use-resource-workbench-session"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useChatStore } from "@/stores/chat"
import { toast } from "sonner"

jest.mock("next-intl", () => {
  const translate = (key: string) => key
  return { useTranslations: () => translate }
})
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

const get = jest.fn()
const put = jest.fn().mockResolvedValue(undefined)
const update = jest.fn().mockResolvedValue(1)
const toArray = jest.fn().mockResolvedValue([])
/** Resolves the indexed `surfaceBindingKey` lookup the hook uses since v131. */
const first = jest.fn().mockResolvedValue(undefined)
const equals = jest.fn(() => ({ first }))
const where = jest.fn(() => ({ equals }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: { get, put, add: put, update, toArray, where },
    syncTombstones: { get: async () => undefined },
    transaction: async (_mode: string, ...args: unknown[]) =>
      (args.at(-1) as () => Promise<unknown>)(),
  }),
}))
jest.mock("@/lib/db/project-scope", () => ({
  resolveScopeProjectId: jest.fn(async () => "proj-active"),
}))

beforeEach(() => {
  get.mockReset().mockResolvedValue(undefined)
  put.mockClear()
  update.mockClear()
  toArray.mockClear().mockResolvedValue([])
  first.mockClear().mockResolvedValue(undefined)
  equals.mockClear()
  where.mockClear()
  useContextWorkbenchStore.setState({ sessionOverrides: {} })
  useChatStore.setState({ activeSessionId: null, openSessionIds: [], sessions: {} })
  jest.mocked(toast.error).mockClear()
})

it("finds an existing aside through the surfaceBindingKey index, not a table scan", async () => {
  // The pre-v131 lookup was `db.sessions.toArray()` + a JSON compare per row —
  // a full scan of every session in the profile on every workbench open.
  first.mockResolvedValue({
    id: "resource-workbench:session:main-1",
    title: "aside",
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: { kind: "session", sessionId: "main-1" },
    surfaceBindingKey: "session:main-1",
    projectId: "proj-A",
    createdAt: 1,
    updatedAt: 1,
  })
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", capabilities: ["ai"], sessionId: "main-1" },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.id).toBe("resource-workbench:session:main-1"))
  expect(where).toHaveBeenCalledWith("surfaceBindingKey")
  expect(equals).toHaveBeenCalledWith("session:main-1")
  expect(toArray).not.toHaveBeenCalled()
})

it("stamps a new aside with the MAIN conversation's workspace, not the active one", async () => {
  // A row written without a projectId is absent from `[projectId+updatedAt]`
  // entirely — invisible to the sidebar and outside `deleteProjectCascade`.
  get.mockImplementation(async (id: string) =>
    id === "main-1" ? { id, title: "main", projectId: "proj-parent" } : undefined
  )
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", capabilities: ["ai"], sessionId: "main-1" },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.projectId).toBe("proj-parent"))
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "proj-parent", surfaceBindingKey: "session:main-1" })
  )
})

it("switches to a manually reassociated embedded session and migrates its binding", async () => {
  get.mockImplementation(async (id: string) =>
    id === "old-session"
      ? {
          id,
          title: "Old resource",
          kind: "resource-workbench",
          visibility: "embedded",
          createdAt: 1,
          updatedAt: 1,
          surfaceBinding: {
            kind: "project-file",
            projectId: "p",
            rootId: "r",
            relPath: "old.ts",
          },
        }
      : undefined
  )
  useContextWorkbenchStore.getState().setSessionOverride("project:p:r:new.ts", "old-session")
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "project-file",
        capabilities: ["ai"],
        projectId: "p",
        rootId: "r",
        relPath: "new.ts",
        contentHash: "hash",
        draftVersion: 1,
      },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.id).toBe("old-session"))
  expect(update).toHaveBeenCalledWith(
    "old-session",
    expect.objectContaining({
      surfaceBinding: { kind: "project-file", projectId: "p", rootId: "r", relPath: "new.ts" },
    })
  )
})

it("ensures an embedded session for a project resource without changing global focus", async () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "project-file",
        capabilities: ["ai"],
        projectId: "p",
        rootId: "r",
        relPath: "a.ts",
        contentHash: "hash",
        draftVersion: 1,
      },
      true,
      "window-a"
    )
  )

  await waitFor(() => expect(result.current?.visibility).toBe("embedded"))
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "resource-workbench",
      surfaceBinding: { kind: "project-file", projectId: "p", rootId: "r", relPath: "a.ts" },
    })
  )
})

it("keeps the same resource session when only the draft revision changes", async () => {
  const { result, rerender } = renderHook(
    ({ draftVersion }) =>
      useResourceWorkbenchSession(
        {
          kind: "project-file",
          capabilities: ["ai"],
          projectId: "p",
          rootId: "r",
          relPath: "a.ts",
          contentHash: `hash-${draftVersion}`,
          draftVersion,
        },
        true,
        "window-a"
      ),
    { initialProps: { draftVersion: 1 } }
  )

  await waitFor(() => expect(result.current?.visibility).toBe("embedded"))
  expect(get).toHaveBeenCalledTimes(2)

  rerender({ draftVersion: 2 })

  expect(result.current?.visibility).toBe("embedded")
  expect(get).toHaveBeenCalledTimes(2)
})

it("leaves workflow session ownership to the workflow editor", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "workflow",
        capabilities: ["ai"],
        workflowId: "w",
        editorRevision: "1",
      },
      true,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
})

it("gives a conversation its own sidechat session", async () => {
  get.mockImplementation(async (id: string) => (id === "s" ? { id, title: "Main" } : undefined))
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "session",
        sessionId: "s",
        capabilities: ["inspect"],
      },
      true,
      "window-a"
    )
  )

  // A conversation CAN own an aside — that is the workbench sidechat.
  await waitFor(() => expect(result.current?.kind).toBe("resource-workbench"))
  expect(get).toHaveBeenCalledWith("resource-workbench:session:s")
})

it.each(["embedded", "unknown"])("never nests under a prefixed %s session", async (state) => {
  const id = "resource-workbench:session:s"
  get.mockResolvedValue(
    state === "embedded" ? { id, kind: "resource-workbench", visibility: "embedded" } : undefined
  )
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "session",
        // A workbench session's own id. Binding to it would nest without limit,
        // and no surface renders the second level.
        sessionId: "resource-workbench:session:s",
        capabilities: ["inspect"],
      },
      true,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  await waitFor(() => expect(get).toHaveBeenCalledWith(id))
  expect(result.current).toBeNull()
  expect(put).not.toHaveBeenCalled()
})

it("opens a promoted conversation's aside while retaining its permalink", async () => {
  const id = "resource-workbench:session:s"
  get.mockImplementation(async (key: string) =>
    key === id ? { id, kind: "direct", title: "Promoted" } : undefined
  )
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", sessionId: id, capabilities: ["ai"] },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.kind).toBe("resource-workbench"))
})

it("handles parent-gone rejection and clears a previously displayed session", async () => {
  useChatStore.setState({ activeSessionId: "s", openSessionIds: ["s"] })
  get.mockImplementation(async (id: string) => (id === "s" ? { id, title: "Main" } : undefined))
  const log = jest.spyOn(console, "error").mockImplementation(() => {})
  try {
    const { result, rerender } = renderHook(
      ({ windowId }) =>
        useResourceWorkbenchSession(
          { kind: "session", sessionId: "s", capabilities: ["ai"] },
          true,
          windowId
        ),
      { initialProps: { windowId: "a" } }
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    get.mockResolvedValue(undefined)
    rerender({ windowId: "b" })
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "aside_parent_gone" })
      )
    )
    expect(result.current).toBeNull()
    expect(useChatStore.getState().activeSessionId).toBeNull()
    expect(useChatStore.getState().openSessionIds).not.toContain("s")
    expect(toast.error).toHaveBeenCalledWith("openError")
  } finally {
    log.mockRestore()
  }
})

it.each(["generic", "cancelled"])(
  "keeps navigation and suppresses the toast for a %s failure",
  async (failure) => {
    useChatStore.setState({ activeSessionId: "s", openSessionIds: ["s"] })
    let release!: (value: undefined) => void
    if (failure === "generic") get.mockRejectedValueOnce(new Error("database unavailable"))
    else
      get.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            release = resolve
          })
      )
    const log = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { result, unmount } = renderHook(() =>
        useResourceWorkbenchSession(
          { kind: "session", sessionId: "s", capabilities: ["ai"] },
          true,
          "a"
        )
      )
      if (failure === "cancelled") {
        unmount()
        await act(async () => release(undefined))
      }
      await waitFor(() => expect(log).toHaveBeenCalled())
      expect(result.current).toBeNull()
      expect(useChatStore.getState().activeSessionId).toBe("s")
      expect(useChatStore.getState().openSessionIds).toEqual(["s"])
      expect(toast.error).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  }
)

it("creates no aside while the dock has no conversation open", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", sessionId: "none", capabilities: ["inspect"] },
      true,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
})

it("does not create a session before an AI panel is activated", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "artifact",
        artifactId: "a",
        version: "1",
        capabilities: ["ai"],
      },
      false,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
})

it("fills legacy additional-aside configuration when an override is opened", async () => {
  get.mockImplementation(async (id: string) =>
    id === "main-1"
      ? {
          id,
          title: "Main",
          model: "parent-model",
          accountId: "parent-account",
          teamId: "team",
          squadId: "squad",
        }
      : id === "extra"
        ? {
            id,
            title: "Aside",
            kind: "resource-workbench",
            model: "chosen",
            surfaceBinding: { kind: "session", sessionId: "main-1" },
            createdAt: 1,
            updatedAt: 1,
          }
        : undefined
  )
  useContextWorkbenchStore.getState().setSessionOverride("session:main-1", "extra")
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", capabilities: ["ai"], sessionId: "main-1" },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.accountId).toBe("parent-account"))
  expect(result.current?.model).toBe("chosen")
  expect(result.current?.teamId).toBeUndefined()
  expect(result.current?.squadId).toBeUndefined()
  expect(update).toHaveBeenCalledWith("extra", { accountId: "parent-account" })
})
