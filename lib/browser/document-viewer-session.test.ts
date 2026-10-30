/** @jest-environment jsdom */
jest.mock("@/lib/browser/local-client", () => ({
  DOCUMENT_VIEWER_PROFILE: "cognia-document-viewer",
  clearDocumentViewerProfile: jest.fn(async () => ({ deleted: true })),
  localBrowser: {
    createSession: jest.fn(),
    closeSession: jest.fn(async () => undefined),
    rpc: jest.fn(),
    onEvent: jest.fn(),
    subscribeFrames: jest.fn(async () => () => undefined),
  },
}))
import { localBrowser, clearDocumentViewerProfile, type LocalBrowserEvent } from "./local-client"
import {
  documentViewerStore,
  ensureDocumentViewerPage,
  retainDocumentViewer,
  closeDocumentViewerPage,
  answerDocumentViewerDialog,
  signOutDocumentViewer,
  resetDocumentViewerForTests,
  DocumentViewerError,
  subscribeDocumentViewerFrames,
} from "./document-viewer-session"
import type { BrowserPageSummary } from "./session-types"
import { sharedLocalBrowserStore } from "./shared-local-browser"

let receive: (event: LocalBrowserEvent) => void
let pages: Array<BrowserPageSummary & { loading: boolean }>
let sequence: number
const url = "https://docs.google.com/document/d/abcdefghijklmnop/edit"
beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  resetDocumentViewerForTests()
  sequence = 0
  pages = []
  jest.mocked(localBrowser.onEvent).mockImplementation(async (callback) => {
    receive = callback
    return () => undefined
  })
  jest.mocked(localBrowser.createSession).mockImplementation(async ({ id }) => {
    pages = [{ id: `p-${++sequence}`, url: "about:blank", title: "", active: true, loading: false }]
    return { id }
  })
  jest.mocked(localBrowser.rpc).mockImplementation(async (op, payload = {}) => {
    if (op === "browser.pages") return pages
    if (op === "browser.page.create") {
      const page = {
        id: `p-${++sequence}`,
        url: "about:blank",
        title: "",
        active: false,
        loading: false,
      }
      pages.push(page)
      return page
    }
    if (op === "browser.navigate") {
      pages = pages.map((page) =>
        page.id === payload.pageId ? { ...page, url: String(payload.url) } : page
      )
    }
    if (op === "browser.page.close") pages = pages.filter((page) => page.id !== payload.pageId)
    return undefined
  })
})
afterEach(() => {
  resetDocumentViewerForTests()
  jest.useRealTimers()
})

it("lazily creates exactly one isolated session and one page per tab without shared owners", async () => {
  const shared = sharedLocalBrowserStore.getState()
  expect(localBrowser.createSession).not.toHaveBeenCalled()
  const [first, duplicate] = await Promise.all([
    ensureDocumentViewerPage("d1", url),
    ensureDocumentViewerPage("d1", url),
  ])
  expect(first.id).toBe(duplicate.id)
  await ensureDocumentViewerPage("d2", url)
  expect(localBrowser.createSession).toHaveBeenCalledTimes(1)
  expect(localBrowser.createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "local",
      purpose: "document-viewer",
      profileId: "cognia-document-viewer",
    })
  )
  expect(Object.keys(documentViewerStore.getState().byTab)).toHaveLength(2)
  expect(sharedLocalBrowserStore.getState()).toBe(shared)
})

it("only accepts page, dialog and closed events from its session", async () => {
  const page = await ensureDocumentViewerPage("d1", url)
  const sessionId = documentViewerStore.getState().sessionId!
  receive({ type: "pages.changed", sessionId: "shared", pages: [] })
  receive({ type: "session.closed", sessionId: "shared" })
  receive({
    type: "dialog.opened",
    sessionId: "shared",
    pageId: page.id,
    dialog: { type: "alert", message: "foreign" },
  })
  expect(documentViewerStore.getState().byTab.d1.id).toBe(page.id)
  expect(documentViewerStore.getState().dialogs).toEqual({})
  receive({
    type: "pages.changed",
    sessionId,
    pages: [{ ...page, url: "https://accounts.google.com/", title: "Login", loading: true }],
  })
  expect(documentViewerStore.getState().byTab.d1).toMatchObject({ title: "Login", loading: true })
})

it("refuses the ninth page including concurrent requests without evicting anything", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 9 }, (_, i) => ensureDocumentViewerPage(`d${i}`, url))
  )
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8)
  const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult
  expect(failure.reason).toBeInstanceOf(DocumentViewerError)
  expect(failure.reason.code).toBe("cap-reached")
  expect(localBrowser.rpc).not.toHaveBeenCalledWith("browser.page.close", expect.anything())
})

it("closes after 60 seconds only when no viewer and no page remains", async () => {
  const release = retainDocumentViewer()
  await ensureDocumentViewerPage("d1", url)
  release()
  await jest.advanceTimersByTimeAsync(60_000)
  expect(localBrowser.closeSession).not.toHaveBeenCalled()
  const hold = retainDocumentViewer()
  await closeDocumentViewerPage("d1")
  await jest.advanceTimersByTimeAsync(60_000)
  expect(localBrowser.closeSession).not.toHaveBeenCalled()
  hold()
  await jest.advanceTimersByTimeAsync(59_999)
  expect(localBrowser.closeSession).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(localBrowser.closeSession).toHaveBeenCalledTimes(1)
})

it.each(["closed", "runtime_exited"])("recreates on demand after %s", async (reason) => {
  await ensureDocumentViewerPage("d1", url)
  const sessionId = documentViewerStore.getState().sessionId!
  receive({ type: "session.closed", sessionId, reason })
  expect(documentViewerStore.getState().sessionId).toBeNull()
  await ensureDocumentViewerPage("d1", url)
  expect(localBrowser.createSession).toHaveBeenCalledTimes(2)
  expect(documentViewerStore.getState().sessionId).not.toBe(sessionId)
})

it("retains the page while beforeunload is pending and after cancellation", async () => {
  const page = await ensureDocumentViewerPage("d1", url)
  const sessionId = documentViewerStore.getState().sessionId!
  jest.mocked(localBrowser.rpc).mockImplementation(async (op) => {
    if (op === "browser.page.close")
      receive({
        type: "dialog.opened",
        sessionId,
        pageId: page.id,
        dialog: { type: "beforeunload", message: "Unsaved" },
      })
    if (op === "browser.pages") return pages
  })
  const closing = closeDocumentViewerPage("d1")
  await Promise.resolve()
  await Promise.resolve()
  expect(documentViewerStore.getState().byTab.d1).toBeDefined()
  expect(documentViewerStore.getState().dialogs[page.id]?.type).toBe("beforeunload")
  await answerDocumentViewerDialog(page.id, { accept: false })
  expect(await closing).toBe(false)
  expect(documentViewerStore.getState().byTab.d1).toBeDefined()
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.page.close", {
    sessionId,
    pageId: page.id,
    runBeforeUnload: true,
  })
})

it("signs out by closing the session before deleting the isolated profile", async () => {
  await ensureDocumentViewerPage("d1", url)
  const order: string[] = []
  jest.mocked(localBrowser.closeSession).mockImplementation(async () => {
    order.push("close")
  })
  jest.mocked(clearDocumentViewerProfile).mockImplementation(async () => {
    order.push("clear")
    return { deleted: true }
  })
  await signOutDocumentViewer()
  expect(order).toEqual(["close", "clear"])
  expect(documentViewerStore.getState().byTab).toEqual({})
})

it("does not delete the profile if closing its session fails", async () => {
  await ensureDocumentViewerPage("d1", url)
  jest.mocked(localBrowser.closeSession).mockRejectedValueOnce(new Error("busy"))
  await expect(signOutDocumentViewer()).rejects.toThrow("busy")
  expect(clearDocumentViewerProfile).not.toHaveBeenCalled()
})

it("keeps concurrent page reservations across pages.changed during creation", async () => {
  await ensureDocumentViewerPage("d0", url)
  const sessionId = documentViewerStore.getState().sessionId!
  const original = jest.mocked(localBrowser.rpc).getMockImplementation()!
  jest.mocked(localBrowser.rpc).mockImplementation(async (op, payload) => {
    if (op === "browser.page.create") {
      // The event can arrive before the create response is assigned to its tab.
      receive({ type: "pages.changed", sessionId, pages: [...pages] })
    }
    return original(op, payload)
  })
  await Promise.all([ensureDocumentViewerPage("d1", url), ensureDocumentViewerPage("d2", url)])
  expect(Object.keys(documentViewerStore.getState().byTab)).toHaveLength(3)
  expect(
    new Set(Object.values(documentViewerStore.getState().byTab).map((page) => page.id)).size
  ).toBe(3)
})

it("does not let another document claim a blank page announced before its create response", async () => {
  await ensureDocumentViewerPage("d0", url)
  const sessionId = documentViewerStore.getState().sessionId!
  const original = jest.mocked(localBrowser.rpc).getMockImplementation()!
  let announce!: () => void
  let finish!: () => void
  const announced = new Promise<void>((resolve) => {
    announce = resolve
  })
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  let first = true
  jest.mocked(localBrowser.rpc).mockImplementation(async (op, payload) => {
    const result = await original(op, payload)
    if (op === "browser.page.create" && first) {
      first = false
      receive({ type: "pages.changed", sessionId, pages: [...pages] })
      announce()
      await gate
    }
    return result
  })
  const opening = ensureDocumentViewerPage("d1", url)
  await announced
  const concurrent = ensureDocumentViewerPage("d2", url)
  await Promise.resolve()
  finish()
  const [one, two] = await Promise.all([opening, concurrent])
  expect(one.id).not.toBe(two.id)
  expect(
    new Set(Object.values(documentViewerStore.getState().byTab).map(({ id }) => id)).size
  ).toBe(3)
})

function announcePopup(openerId: string, id = "popup") {
  const popup = {
    id,
    openerId,
    url: "https://accounts.google.com/signin",
    title: "Login",
    active: true,
    loading: false,
  }
  pages = [...pages.map((page) => ({ ...page, active: false })), popup]
  receive({
    type: "pages.changed",
    sessionId: documentViewerStore.getState().sessionId!,
    pages,
    activePageId: id,
  })
  return popup
}

it("inherits popup ownership, follows activation and routes popup frames and dialogs", async () => {
  const root = await ensureDocumentViewerPage("d1", url)
  await ensureDocumentViewerPage("d2", url)
  const popup = announcePopup(root.id)
  expect(documentViewerStore.getState().byTab.d1.id).toBe(popup.id)
  expect(documentViewerStore.getState().byTab.d2.id).not.toBe(popup.id)
  const frame = jest.fn()
  const stop = subscribeDocumentViewerFrames(popup.id, frame, jest.fn())
  await jest.advanceTimersByTimeAsync(0)
  const receiveFrame = jest.mocked(localBrowser.subscribeFrames).mock.calls.at(-1)![1]
  const bytes = new Uint8Array([1, 2])
  receiveFrame(bytes)
  expect(frame).toHaveBeenCalledWith(bytes)
  const sessionId = documentViewerStore.getState().sessionId!
  receive({
    type: "dialog.opened",
    sessionId,
    pageId: popup.id,
    dialog: { type: "prompt", message: "Login" },
  })
  await answerDocumentViewerDialog(documentViewerStore.getState().byTab.d1.id, { accept: true })
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.dialog.handle", {
    sessionId,
    pageId: popup.id,
    accept: true,
  })
  expect(documentViewerStore.getState().dialogs).toEqual({})
  pages = pages.filter(({ id }) => id !== popup.id)
  receive({ type: "pages.changed", sessionId, pages, activePageId: root.id })
  expect(documentViewerStore.getState().byTab.d1.id).toBe(root.id)
  stop()
})

it("closes nested popups with their document and then closes the idle session", async () => {
  const root = await ensureDocumentViewerPage("d1", url)
  const popup = announcePopup(root.id)
  announcePopup(popup.id, "nested-popup")
  expect(await closeDocumentViewerPage("d1")).toBe(true)
  expect(
    jest
      .mocked(localBrowser.rpc)
      .mock.calls.filter(([op]) => op === "browser.page.close")
      .map(([, payload]) => payload?.pageId)
  ).toEqual(["nested-popup", popup.id, root.id])
  expect(documentViewerStore.getState().byTab).toEqual({})
  expect(pages).toEqual([])
  await jest.advanceTimersByTimeAsync(60_000)
  expect(localBrowser.closeSession).toHaveBeenCalledTimes(1)
})

it("retains popup ownership after the opener disappears", async () => {
  const root = await ensureDocumentViewerPage("d1", url)
  const popup = announcePopup(root.id)
  pages = pages.filter(({ id }) => id !== root.id)
  receive({ type: "pages.changed", sessionId: documentViewerStore.getState().sessionId!, pages })
  expect(documentViewerStore.getState().byTab.d1.id).toBe(popup.id)
  expect(await closeDocumentViewerPage("d1")).toBe(true)
  await jest.advanceTimersByTimeAsync(60_000)
  expect(localBrowser.closeSession).toHaveBeenCalledTimes(1)
})

it("closes the visible popup first and surfaces a sibling's unload dialog before continuing", async () => {
  const root = await ensureDocumentViewerPage("d1", url)
  const sibling = announcePopup(root.id, "sibling")
  const visible = announcePopup(root.id, "visible")
  const sessionId = documentViewerStore.getState().sessionId!
  const original = jest.mocked(localBrowser.rpc).getMockImplementation()!
  jest.mocked(localBrowser.rpc).mockImplementation(async (op, payload) => {
    if (op === "browser.page.close" && payload?.pageId === visible.id) {
      await original(op, payload)
      pages = pages.map((page, index) => ({ ...page, active: index === 0 }))
      receive({ type: "pages.changed", sessionId, pages, activePageId: root.id })
      return undefined
    }
    if (op === "browser.page.close" && payload?.pageId === sibling.id) {
      receive({
        type: "dialog.opened",
        sessionId,
        pageId: sibling.id,
        dialog: { type: "beforeunload", message: "Unsaved popup" },
      })
      return undefined
    }
    return original(op, payload)
  })
  const closing = closeDocumentViewerPage("d1")
  await jest.advanceTimersByTimeAsync(0)
  const requests = jest
    .mocked(localBrowser.rpc)
    .mock.calls.filter(([op]) => op === "browser.page.close")
  expect(requests.map(([, payload]) => payload?.pageId)).toEqual([visible.id, sibling.id])
  expect(documentViewerStore.getState().byTab.d1.id).toBe(sibling.id)
  await answerDocumentViewerDialog(sibling.id, { accept: false })
  expect(await closing).toBe(false)
  expect(pages.map(({ id }) => id)).toEqual([root.id, sibling.id])
  // Retrying must create a fresh close, and accepting cascades to the root.
  const retry = closeDocumentViewerPage("d1")
  await jest.advanceTimersByTimeAsync(0)
  jest.mocked(localBrowser.rpc).mockImplementation(async (op, payload) => {
    if (op === "browser.dialog.handle" && payload?.accept) {
      pages = pages.filter(({ id }) => id !== sibling.id)
    }
    return original(op, payload)
  })
  await answerDocumentViewerDialog(sibling.id, { accept: true })
  expect(await retry).toBe(true)
  expect(pages).toEqual([])
})

it("settles and clears closing when an ordinary dialog beats the close RPC", async () => {
  const page = await ensureDocumentViewerPage("d1", url)
  const sessionId = documentViewerStore.getState().sessionId!
  const original = jest.mocked(localBrowser.rpc).getMockImplementation()!
  let refused = false
  jest.mocked(localBrowser.rpc).mockImplementation(async (op, payload) => {
    if (op === "browser.page.close" && !refused) {
      refused = true
      receive({
        type: "dialog.opened",
        sessionId,
        pageId: page.id,
        dialog: { type: "alert", message: "Existing dialog" },
      })
      return { closed: false, reason: "dialog-pending" }
    }
    return original(op, payload)
  })
  const settled = jest.fn()
  const closing = closeDocumentViewerPage("d1").then(settled)
  await jest.advanceTimersByTimeAsync(0)
  expect(settled).toHaveBeenCalledWith(false)
  await closing
  expect(documentViewerStore.getState().byTab.d1.id).toBe(page.id)
  await answerDocumentViewerDialog(page.id, { accept: true })
  expect(await closeDocumentViewerPage("d1")).toBe(true)
})

it("does not recreate a session from an acquisition waiting during sign-out", async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const original = jest.mocked(localBrowser.createSession).getMockImplementation()!
  jest.mocked(localBrowser.createSession).mockImplementation(async (payload) => {
    await gate
    return original(payload)
  })
  const first = ensureDocumentViewerPage("d1", url)
  const second = ensureDocumentViewerPage("d2", url)
  const signedOut = signOutDocumentViewer()
  finish()
  await Promise.allSettled([first, second, signedOut])
  expect(localBrowser.createSession).toHaveBeenCalledTimes(1)
  expect(documentViewerStore.getState().sessionId).toBeNull()
  expect(documentViewerStore.getState().byTab).toEqual({})
  expect(clearDocumentViewerProfile).toHaveBeenCalledTimes(1)
})

it("closes a partially initialized session before reporting a page-list failure", async () => {
  jest.mocked(localBrowser.rpc).mockRejectedValueOnce(new Error("page list failed"))
  await expect(ensureDocumentViewerPage("d1", url)).rejects.toThrow("page list failed")
  expect(localBrowser.closeSession).toHaveBeenCalledTimes(1)
  expect(documentViewerStore.getState().sessionId).toBeNull()
})

it("retries a failed page at its canonical URL without creating another page", async () => {
  const page = await ensureDocumentViewerPage("d1", url)
  const sessionId = documentViewerStore.getState().sessionId!
  receive({
    type: "pages.changed",
    sessionId,
    pages: [{ ...page, loadError: "navigation-failed" }],
  })
  jest.mocked(localBrowser.rpc).mockClear()
  await ensureDocumentViewerPage("d1", url)
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.navigate", {
    sessionId,
    pageId: page.id,
    url,
  })
  expect(
    jest.mocked(localBrowser.rpc).mock.calls.some(([op]) => op === "browser.page.create")
  ).toBe(false)
})
