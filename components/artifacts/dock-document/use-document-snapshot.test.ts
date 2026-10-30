/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useDocumentSnapshot } from "./use-document-snapshot"
import { getDocsProvider } from "@/lib/docs-providers"
import {
  DocsProviderError,
  type DocsProvider,
  type RemoteDocContent,
} from "@/lib/docs-providers/types"
import { getSessionAsset } from "@/lib/db/session-assets"
import {
  bindDockDocument,
  closeDockDocument,
  documentMemory,
  subscribeDockDocumentLifecycle,
  updateDocumentMemory,
  useDockDocumentCache,
} from "@/lib/artifacts/dock-documents"
import { useDockDocumentsStore, type DockDocumentTab } from "@/stores/artifact/dock-documents-store"
import { useChatStore } from "@/stores/chat"

jest.mock("@/lib/docs-providers", () => ({ getDocsProvider: jest.fn() }))
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => "desktop" }))
jest.mock("@/lib/db/session-assets", () => ({
  getSessionAsset: jest.fn(),
  getSessionAssetMetadata: jest.fn(),
}))
// The asset watcher's live query: undefined = still loading, null = removed.
let mockLiveAsset: unknown = undefined
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockLiveAsset }))
jest.mock("@cognia/ocr/blob-utils", () => ({
  readBlobAsArrayBuffer: jest.fn(async () => new ArrayBuffer(0)),
}))

const tab: DockDocumentTab = {
  id: "d",
  providerId: "lark",
  resourceKind: "doc",
  resourceId: "abcdefghijklmnop1234",
  url: "",
  title: "Report",
  view: "snapshot",
  openedAt: 1,
}
const binding = { accountId: "a", authorizationEpoch: "v1" }
const account = { id: "a", label: "Alice", authorizationEpoch: "v1" }
let notifyAccounts: () => void
let provider: DocsProvider
const content = (text = "fresh", extra = {}): RemoteDocContent => ({
  ref: { providerId: "lark", kind: "doc", id: tab.resourceId, title: "Report" },
  title: "Report",
  text,
  format: "text",
  ...extra,
})
beforeEach(() => {
  useDockDocumentsStore.setState({ bySession: {} })
  useDockDocumentCache.setState({ byId: {} })
  useChatStore.setState({ sessions: { s: { id: "s" } } as never, activeSessionId: "s" })
  useDockDocumentsStore.getState().put("s", tab)
  provider = {
    id: "lark",
    hosts: ["tauri"],
    kinds: ["doc"],
    mentionPrefix: "lark:",
    matchRef: () => null,
    listAccounts: jest.fn(async () => [account]),
    fetch: jest.fn(async () => content()),
    subscribeAccounts: (listener) => {
      notifyAccounts = listener
      return jest.fn()
    },
  }
  ;(getDocsProvider as jest.Mock).mockReturnValue(provider)
  ;(getSessionAsset as jest.Mock).mockReset()
  mockLiveAsset = undefined
})
afterEach(() => subscribeDockDocumentLifecycle()())

it("requires a named account click even when there is only one account", async () => {
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.accounts).toEqual([account])
  expect(provider.fetch).not.toHaveBeenCalled()
  await act(async () => {
    await result.current.refresh(binding)
  })
  expect(result.current.content?.text).toBe("fresh")
  expect(provider.fetch).toHaveBeenCalledWith(
    expect.objectContaining({ accountBinding: binding }),
    expect.objectContaining({
      accountId: "a",
      expectedAuthorizationEpoch: "v1",
      signal: expect.any(AbortSignal),
    })
  )
})
it("re-verifies the epoch before fetching", async () => {
  bindDockDocument(tab.id, binding)
  ;(provider.listAccounts as jest.Mock).mockResolvedValue([
    { ...account, authorizationEpoch: "v2" },
  ])
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  await act(async () => {
    await result.current.refresh()
  })
  expect(provider.fetch).not.toHaveBeenCalled()
  expect(result.current.error).toBe("notAuthorized")
})
it.each(["account", "close", "session", "tab", "unmount"])(
  "drops a late response after %s and aborts its signal",
  async (event) => {
    let resolve!: (value: RemoteDocContent) => void
    ;(provider.fetch as jest.Mock).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    bindDockDocument(tab.id, binding)
    const { result, unmount } = renderHook(() => useDocumentSnapshot("s", tab))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.refresh()
    })
    await waitFor(() => expect(provider.fetch).toHaveBeenCalled())
    const signal = (provider.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal
    await act(async () => {
      if (event === "account") {
        // A revocation: the bound epoch no longer verifies.
        ;(provider.listAccounts as jest.Mock).mockResolvedValue([
          { ...account, authorizationEpoch: "v2" },
        ])
        notifyAccounts()
        await Promise.resolve()
      } else if (event === "close") closeDockDocument("s", tab.id)
      else if (event === "session") useChatStore.setState({ activeSessionId: "other" })
      else if (event === "tab") useDockDocumentsStore.getState().put("s", { ...tab, id: "other" })
      else unmount()
    })
    await act(async () => {
      resolve(content("late"))
      await pending
    })
    expect(signal.aborted).toBe(true)
    expect(useDockDocumentCache.getState().byId[tab.id]?.latest).toBeUndefined()
  }
)
it("keeps the sent asset unchanged during refresh and failure, with a sent/latest toggle", async () => {
  const sentTab = { ...tab, snapshotRef: { kind: "asset" as const, assetId: "asset" } }
  useDockDocumentsStore.getState().put("s", sentTab)
  ;(getSessionAsset as jest.Mock).mockResolvedValue({
    filename: "Report.txt",
    mediaType: "text/plain",
    createdAt: 123,
    extractedContent: { status: "ready", segments: [{ text: "sent body" }] },
  })
  bindDockDocument(tab.id, binding)
  const { result } = renderHook(() => useDocumentSnapshot("s", sentTab))
  await waitFor(() => expect(result.current.content?.text).toBe("sent body"))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.content?.text).toBe("fresh")
  expect(result.current.sent?.text).toBe("sent body")
  act(() => result.current.setShowLatest(false))
  expect(result.current.content?.text).toBe("sent body")
  ;(provider.fetch as jest.Mock).mockRejectedValue(new DocsProviderError("network"))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.refreshFailed).toBe(true)
  expect(result.current.sent?.text).toBe("sent body")
  expect(useDockDocumentsStore.getState().bySession.s.documents[0].snapshotRef).toEqual({
    kind: "asset",
    assetId: "asset",
  })
})
it.each([
  ["partial", content("body", { completeness: { status: "partial", reasons: ["budget"] } })],
  ["empty", content("")],
] as const)("reports %s", async (state, value) => {
  bindDockDocument(tab.id, binding)
  ;(provider.fetch as jest.Mock).mockResolvedValue(value)
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.state).toBe(state)
})
it("reports errors without a previous body", async () => {
  bindDockDocument(tab.id, binding)
  ;(provider.fetch as jest.Mock).mockRejectedValue(new DocsProviderError("noPermission"))
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.state).toBe("error")
  expect(result.current.error).toBe("noPermission")
})

it("reports an empty provider error as an empty document", async () => {
  bindDockDocument(tab.id, binding)
  ;(provider.fetch as jest.Mock).mockRejectedValue(new DocsProviderError("empty"))
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.state).toBe("empty")
})

it("can choose a different account after resolving a sent asset", async () => {
  const sentTab = { ...tab, snapshotRef: { kind: "asset" as const, assetId: "asset" } }
  useDockDocumentsStore.getState().put("s", sentTab)
  ;(getSessionAsset as jest.Mock).mockResolvedValue({
    filename: "Report.txt",
    mediaType: "text/plain",
    createdAt: 123,
    extractedContent: { status: "ready", segments: [{ text: "sent body" }] },
  })
  ;(provider.listAccounts as jest.Mock).mockResolvedValue([
    account,
    { id: "b", label: "Bob", authorizationEpoch: "v2" },
  ])
  bindDockDocument(tab.id, binding)
  const { result } = renderHook(() => useDocumentSnapshot("s", sentTab))
  await waitFor(() => expect(result.current.sent?.text).toBe("sent body"))
  await act(async () => {
    await result.current.refresh({ accountId: "b", authorizationEpoch: "v2" })
  })
  await waitFor(() => expect(result.current.latest?.text).toBe("fresh"))
  expect(result.current.sent?.text).toBe("sent body")
  expect(provider.fetch).toHaveBeenCalledWith(
    expect.objectContaining({ accountBinding: { accountId: "b", authorizationEpoch: "v2" } }),
    expect.anything()
  )
})
it("serves inline content without any provider request", () => {
  documentMemory(tab.id)
  updateDocumentMemory(tab.id, {
    seed: {
      title: "Report",
      text: "seed",
      format: "text",
      origin: "staged",
      fetchedAt: 1,
      completeness: { status: "complete" },
    },
  })
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  expect(result.current.content?.text).toBe("seed")
  expect(provider.fetch).not.toHaveBeenCalled()
})

it("drops a sent snapshot whose asset was removed from the conversation and does not reload it", async () => {
  const sentTab = { ...tab, snapshotRef: { kind: "asset" as const, assetId: "asset" } }
  useDockDocumentsStore.getState().put("s", sentTab)
  ;(getSessionAsset as jest.Mock).mockResolvedValue({
    filename: "Report.txt",
    mediaType: "text/plain",
    createdAt: 123,
    revision: 1,
    extractedContent: { status: "ready", segments: [{ text: "sent body" }] },
  })
  mockLiveAsset = { revision: 1 }
  const { result, rerender } = renderHook(() => useDocumentSnapshot("s", sentTab))
  await waitFor(() => expect(result.current.content?.text).toBe("sent body"))
  expect(getSessionAsset).toHaveBeenCalledTimes(1)
  mockLiveAsset = null
  rerender()
  await waitFor(() => expect(result.current.content).toBeUndefined())
  expect(result.current.sourceRemoved).toBe(true)
  expect(documentMemory(tab.id).sent).toBeUndefined()
  expect(getSessionAsset).toHaveBeenCalledTimes(1)
})

it("reloads the sent snapshot when its asset revision changes", async () => {
  const sentTab = { ...tab, snapshotRef: { kind: "asset" as const, assetId: "asset" } }
  useDockDocumentsStore.getState().put("s", sentTab)
  const asset = (revision: number, text: string) => ({
    filename: "Report.txt",
    mediaType: "text/plain",
    createdAt: 123,
    revision,
    extractedContent: { status: "ready", segments: [{ text }] },
  })
  ;(getSessionAsset as jest.Mock).mockResolvedValue(asset(1, "v1"))
  mockLiveAsset = { revision: 1 }
  const { result, rerender } = renderHook(() => useDocumentSnapshot("s", sentTab))
  await waitFor(() => expect(result.current.content?.text).toBe("v1"))
  ;(getSessionAsset as jest.Mock).mockResolvedValue(asset(2, "v2"))
  mockLiveAsset = { revision: 2 }
  rerender()
  await waitFor(() => expect(result.current.content?.text).toBe("v2"))
})

it("a failed re-verification clears what the revoked account read", async () => {
  bindDockDocument(tab.id, binding)
  const { result } = renderHook(() => useDocumentSnapshot("s", tab))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.content?.text).toBe("fresh")
  ;(provider.listAccounts as jest.Mock).mockResolvedValue([
    { ...account, authorizationEpoch: "v2" },
  ])
  await act(async () => {
    await result.current.refresh()
  })
  expect(documentMemory(tab.id).binding).toBeUndefined()
  expect(documentMemory(tab.id).latest).toBeUndefined()
  expect(result.current.content).toBeUndefined()
  expect(result.current.error).toBe("notAuthorized")
})
