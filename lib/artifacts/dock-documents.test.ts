/** @jest-environment jsdom */
jest.mock("@/lib/docs-providers", () => ({ getDocsProvider: jest.fn() }))
jest.mock("@/lib/browser/document-viewer-session", () => ({
  closeDocumentViewerPage: jest.fn(async () => true),
  hasDocumentViewerPage: jest.fn(() => false),
}))
import {
  closeDocumentViewerPage,
  hasDocumentViewerPage,
} from "@/lib/browser/document-viewer-session"
import {
  openDockDocument,
  closeDockDocument,
  documentMemory,
  useDockDocumentCache,
  subscribeDockDocumentLifecycle,
  setDockDocumentView,
  reverifyDockDocumentBindings,
} from "./dock-documents"
import { getDocsProvider } from "@/lib/docs-providers"
import { useDockDocumentsStore } from "@/stores/artifact/dock-documents-store"
import { useChatStore } from "@/stores/chat"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { dockSessionScopeKey } from "./dock-pages"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"

const target = {
  providerId: "lark" as const,
  resourceKind: "doc" as const,
  resourceId: "abcdefghijklmnop1234",
  url: "https://a.feishu.cn/docx/abcdefghijklmnop1234",
  title: "Report",
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(hasDocumentViewerPage).mockReturnValue(false)
  jest.mocked(closeDocumentViewerPage).mockResolvedValue(true)
  useDockDocumentsStore.setState({ bySession: {} })
  useDockDocumentCache.setState({ byId: {} })
  useChatStore.setState({
    activeSessionId: "s1",
    sessions: { s1: { id: "s1" }, s2: { id: "s2" } } as never,
  })
  useArtifactDockLayoutStore.getState().resetLayout()
  useArtifactDockLayoutStore.getState().setDockCollapsed(true)
  useContextWorkbenchStore.setState({ layouts: {} })
})

it("releases original pages on leaving the chat while preserving canonical descriptors", () => {
  const id = openDockDocument({ sessionId: "s1", target, entry: "link" })!
  useChatStore.setState({ activeSessionId: "s2" })
  expect(closeDocumentViewerPage).toHaveBeenCalledWith(id)
  expect(useDockDocumentsStore.getState().bySession.s1.documents[0].url).toBe(target.url)
})

it("defers release while streaming and cancels a deferred release when returning", () => {
  const id = openDockDocument({ sessionId: "s1", target, entry: "link" })!
  useChatStore.setState({
    sessions: { s1: { id: "s1", status: "streaming" }, s2: { id: "s2" } } as never,
  })
  useChatStore.setState({ activeSessionId: "s2" })
  expect(closeDocumentViewerPage).not.toHaveBeenCalled()
  useChatStore.setState({ activeSessionId: "s1" })
  useChatStore.setState({
    sessions: { s1: { id: "s1", status: "idle" }, s2: { id: "s2" } } as never,
  })
  expect(closeDocumentViewerPage).not.toHaveBeenCalled()
  useChatStore.setState({ activeSessionId: "s2" })
  expect(closeDocumentViewerPage).toHaveBeenCalledWith(id)
})

it("releases a background chat's document pages when its run settles", () => {
  const id = openDockDocument({ sessionId: "s1", target, entry: "link" })!
  useChatStore.setState({ sessions: { s1: { id: "s1", status: "streaming" } } as never })
  useChatStore.setState({ activeSessionId: "s2" })
  expect(closeDocumentViewerPage).not.toHaveBeenCalled()
  useChatStore.setState({ sessions: { s1: { id: "s1", status: "idle" } } as never })
  expect(closeDocumentViewerPage).toHaveBeenCalledWith(id)
})

it("keeps a closing tab until beforeunload resolves and retains it on cancel", async () => {
  const id = openDockDocument({ sessionId: "s1", target, entry: "link", view: "snapshot" })!
  jest.mocked(hasDocumentViewerPage).mockReturnValue(true)
  jest.mocked(closeDocumentViewerPage).mockResolvedValueOnce(false)
  closeDockDocument("s1", id)
  await Promise.resolve()
  expect(useDockDocumentsStore.getState().bySession.s1.documents).toHaveLength(1)
  expect(useDockDocumentsStore.getState().bySession.s1.documents[0].view).toBe("live")
  jest.mocked(closeDocumentViewerPage).mockResolvedValueOnce(true)
  closeDockDocument("s1", id)
  await Promise.resolve()
  expect(useDockDocumentsStore.getState().bySession.s1.documents).toHaveLength(0)
})
afterEach(() => subscribeDockDocumentLifecycle()())
it("deduplicates by session/provider/kind/id and preserves an unnamed view", () => {
  const first = openDockDocument({ sessionId: "s1", target, entry: "link" })!
  expect(openDockDocument({ sessionId: "s1", target, entry: "picker" })).toBe(first)
  expect(useDockDocumentsStore.getState().bySession.s1.documents).toHaveLength(1)
  expect(useDockDocumentsStore.getState().bySession.s1.documents[0].view).toBe("live")
  openDockDocument({ sessionId: "s1", target, entry: "picker", view: "snapshot" })
  expect(useDockDocumentsStore.getState().bySession.s1.documents[0].view).toBe("snapshot")
})
it("reveals only the session on screen and respects reveal false", () => {
  openDockDocument({ sessionId: "s2", target, entry: "picker" })
  expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  expect(useContextWorkbenchStore.getState().layouts[dockSessionScopeKey("s2")].activePanelId).toBe(
    "cloud-document"
  )
  openDockDocument({ sessionId: "s1", target, entry: "picker", reveal: false })
  expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  openDockDocument({ sessionId: "s1", target, entry: "picker" })
  expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
})
it.each(["", "missing", "__proto__", "toString"])("refuses an unknown session %s", (sessionId) =>
  expect(openDockDocument({ sessionId, target, entry: "link" })).toBeNull()
)
it("releases cache on close, invalidates on view switch, and cleans up session deletion", () => {
  const id = openDockDocument({ sessionId: "s1", target, entry: "picker" })!
  const before = documentMemory(id).generation
  setDockDocumentView("s1", id, "live")
  expect(documentMemory(id).generation).toBeGreaterThan(before)
  closeDockDocument("s1", id)
  expect(useDockDocumentCache.getState().byId[id]).toBeUndefined()
  const next = openDockDocument({ sessionId: "s1", target, entry: "picker" })!
  documentMemory(next)
  useChatStore.setState({ sessions: {} })
  expect(useDockDocumentCache.getState().byId[next]).toBeUndefined()
  expect(useDockDocumentsStore.getState().bySession.s1).toBeUndefined()
})
it("promotes an ephemeral preview to an asset and follows the asset the user clicked", () => {
  const id = openDockDocument({ sessionId: "s1", target, entry: "picker" })!
  openDockDocument({
    sessionId: "s1",
    target,
    entry: "sent-attachment",
    snapshot: { kind: "asset", assetId: "first" },
  })
  openDockDocument({
    sessionId: "s1",
    target,
    entry: "sent-attachment",
    snapshot: { kind: "asset", assetId: "second" },
  })
  expect(useDockDocumentsStore.getState().bySession.s1.documents[0]).toMatchObject({
    id,
    snapshotRef: { assetId: "second" },
  })
})

it("keeps a later inline preview separate from the sent asset and unwraps its display body", () => {
  const id = openDockDocument({
    sessionId: "s1",
    target,
    entry: "sent-attachment",
    snapshot: { kind: "asset", assetId: "sent" },
  })!
  openDockDocument({
    sessionId: "s1",
    target,
    entry: "picker",
    snapshot: {
      kind: "inline",
      content: {
        title: "Report",
        text: wrapUntrustedContent("latest preview"),
        format: "text",
        origin: "staged",
        fetchedAt: 1,
        completeness: { status: "complete" },
      },
    },
  })
  expect(documentMemory(id).latest?.text).toBe("latest preview")
  expect(useDockDocumentsStore.getState().bySession.s1.documents[0].snapshotRef?.assetId).toBe(
    "sent"
  )
})

describe("account changes", () => {
  const sent = {
    title: "Report",
    text: "body",
    format: "text" as const,
    fetchedAt: 1,
    completeness: { status: "complete" as const },
    origin: "sent" as const,
  }
  const providerWith = (accounts: Array<{ id: string; authorizationEpoch?: string }>) =>
    jest.mocked(getDocsProvider).mockReturnValue({
      listAccounts: jest.fn().mockResolvedValue(accounts.map((a) => ({ ...a, label: a.id }))),
    } as never)

  it("keeps a binding that still verifies, e.g. after a token refresh", async () => {
    providerWith([{ id: "acct", authorizationEpoch: "e1" }])
    const id = openDockDocument({
      sessionId: "s1",
      target,
      entry: "picker",
      binding: { accountId: "acct", authorizationEpoch: "e1" },
    })!
    useDockDocumentCache.setState((state) => ({
      byId: { ...state.byId, [id]: { ...state.byId[id], latest: { ...sent, origin: "fetched" } } },
    }))
    await reverifyDockDocumentBindings("lark")
    expect(documentMemory(id).binding).toEqual({ accountId: "acct", authorizationEpoch: "e1" })
    expect(documentMemory(id).latest?.text).toBe("body")
  })

  it("drops a revoked identity's binding and latest preview but keeps the sent snapshot", async () => {
    providerWith([{ id: "acct", authorizationEpoch: "e2" }])
    const id = openDockDocument({
      sessionId: "s1",
      target,
      entry: "sent-attachment",
      binding: { accountId: "acct", authorizationEpoch: "e1" },
      snapshot: { kind: "inline", content: sent },
    })!
    useDockDocumentCache.setState((state) => ({
      byId: { ...state.byId, [id]: { ...state.byId[id], latest: { ...sent, origin: "fetched" } } },
    }))
    await reverifyDockDocumentBindings("lark")
    expect(documentMemory(id).binding).toBeUndefined()
    expect(documentMemory(id).latest).toBeUndefined()
    expect(documentMemory(id).sent?.text).toBe("body")
  })
})

it("shows the asset version the user clicked for an already open document", () => {
  const id = openDockDocument({
    sessionId: "s1",
    target,
    entry: "sent-attachment",
    snapshot: { kind: "asset", assetId: "a1", messageId: "m1" },
  })!
  useDockDocumentCache.setState((state) => ({
    byId: {
      ...state.byId,
      [id]: {
        ...state.byId[id],
        sent: {
          title: "v1",
          text: "v1",
          format: "text",
          fetchedAt: 1,
          completeness: { status: "complete" },
          origin: "sent",
        },
      },
    },
  }))
  expect(
    openDockDocument({
      sessionId: "s1",
      target,
      entry: "sent-attachment",
      snapshot: { kind: "asset", assetId: "a2", messageId: "m2" },
    })
  ).toBe(id)
  const tab = useDockDocumentsStore.getState().bySession.s1.documents[0]
  expect(tab.snapshotRef).toEqual({ kind: "asset", assetId: "a2", messageId: "m2" })
  expect(documentMemory(id).sent).toBeUndefined()
})

it("switching the reading account keeps a staged snapshot but drops the old account's reads", () => {
  const staged = {
    title: "Report",
    text: "staged",
    format: "text" as const,
    fetchedAt: 1,
    completeness: { status: "complete" as const },
    origin: "staged" as const,
  }
  const id = openDockDocument({
    sessionId: "s1",
    target,
    entry: "staged-attachment",
    binding: { accountId: "a" },
    snapshot: { kind: "inline", content: staged },
  })!
  useDockDocumentCache.setState((state) => ({
    byId: {
      ...state.byId,
      [id]: { ...state.byId[id], latest: { ...staged, text: "read by a", origin: "fetched" } },
    },
  }))
  openDockDocument({ sessionId: "s1", target, entry: "picker", binding: { accountId: "b" } })
  expect(documentMemory(id).binding).toEqual({ accountId: "b" })
  expect(documentMemory(id).latest).toBeUndefined()
  expect(documentMemory(id).seed?.text).toBe("staged")
})

it("reopening a sent attachment after a refresh shows the sent version, a staged reopen the latest", () => {
  const sent = {
    title: "Report",
    text: "v1",
    format: "text" as const,
    fetchedAt: 1,
    completeness: { status: "complete" as const },
    origin: "sent" as const,
  }
  const id = openDockDocument({
    sessionId: "s1",
    target,
    entry: "sent-attachment",
    snapshot: { kind: "asset", assetId: "a1", messageId: "m1" },
  })!
  useDockDocumentCache.setState((state) => ({
    byId: {
      ...state.byId,
      [id]: {
        ...state.byId[id],
        sent,
        latest: { ...sent, text: "v2", origin: "fetched" },
        showing: "latest",
      },
    },
  }))
  openDockDocument({
    sessionId: "s1",
    target,
    entry: "sent-attachment",
    snapshot: { kind: "asset", assetId: "a1", messageId: "m1" },
  })
  expect(documentMemory(id).showing).toBe("sent")
  expect(documentMemory(id).latest?.text).toBe("v2")
  openDockDocument({
    sessionId: "s1",
    target,
    entry: "staged-attachment",
    snapshot: { kind: "inline", content: { ...sent, text: "staged", origin: "staged" } },
  })
  expect(documentMemory(id).showing).toBe("latest")
  expect(documentMemory(id).latest?.text).toBe("staged")
})
