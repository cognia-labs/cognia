/** Human-only document browser. Deliberately independent of shared/agent browser owners. */
import { createStore } from "zustand/vanilla"
import {
  clearDocumentViewerProfile,
  DOCUMENT_VIEWER_PROFILE,
  localBrowser,
  type LocalBrowserEvent,
} from "./local-client"
import type { BrowserPageSummary } from "./session-types"

export const DOCUMENT_VIEWER_PAGE_CAP = 8
export const DOCUMENT_VIEWER_IDLE_MS = 60_000
export const DOCUMENT_VIEWER_VIEWPORT = { width: 1280, height: 800 }
export interface DocumentViewerPage extends BrowserPageSummary {
  loading?: boolean
  loadError?: string
}
export interface DocumentViewerDialog {
  type: string
  message: string
  defaultValue?: string
}
export class DocumentViewerError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = "DocumentViewerError"
  }
}
interface ViewerState {
  sessionId: string | null
  status: "idle" | "preparing" | "ready" | "error"
  error: string | null
  byTab: Record<string, DocumentViewerPage>
  pages: DocumentViewerPage[]
  dialogs: Record<string, DocumentViewerDialog>
  activePageId: string | null
}
const initial: ViewerState = {
  sessionId: null,
  status: "idle",
  error: null,
  byTab: {},
  pages: [],
  dialogs: {},
  activePageId: null,
}
export const documentViewerStore = createStore<ViewerState>(() => initial)
let starting: Promise<string> | undefined
let signingOut: Promise<void> | undefined
let listening: Promise<void> | undefined
let unlisten: (() => void) | undefined
let generation = 0
let viewers = 0
let idle: ReturnType<typeof setTimeout> | undefined
// Only the initial page is reusable. Runtime page events may beat create replies.
let initialPageId: string | undefined
const pageOwners = new Map<string, string>()
const creating = new Map<string, Promise<DocumentViewerPage>>()
const closing = new Map<
  string,
  {
    promise: Promise<boolean>
    resolve: (closed: boolean) => void
    reject: (error: unknown) => void
    pageId?: string
  }
>()
const frameListeners = new Map<symbol, { pageId: string; receive: (bytes: Uint8Array) => void }>()
let frameSubscription: { sessionId: string; stop: () => void } | undefined
let frameSync = Promise.resolve()

export function documentViewerErrorReason(error: unknown): string {
  if (error instanceof DocumentViewerError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  if (/chromium_not_installed/.test(message)) return "chromium"
  if (/profile_in_use/.test(message)) return "profile-in-use"
  if (/browser_page_quota_exceeded/.test(message)) return "cap-reached"
  if (
    /option_invalid|unknown.*purpose|unexpected.*purpose|unsupported.*purpose|purpose.*(invalid|unknown|unsupported)/i.test(
      message
    )
  )
    return "update-app"
  if (/op_refused|op_not_allowed|window_mismatch|profile_mismatch|profile_reserved/.test(message))
    return "op-refused"
  if (/runtime_exited|runtime_stopped|session_not_found|disconnected/.test(message))
    return "runtime-exited"
  return "browser-error"
}

function settleClose(tabId: string, closed: boolean) {
  const pending = closing.get(tabId)
  closing.delete(tabId)
  pending?.resolve(closed)
}
function reset(reason: string | null = null) {
  generation += 1
  clearTimeout(idle)
  idle = undefined
  for (const tabId of closing.keys()) settleClose(tabId, true)
  creating.clear()
  initialPageId = undefined
  pageOwners.clear()
  starting = undefined
  documentViewerStore.setState({ ...initial, status: reason ? "error" : "idle", error: reason })
  void syncFrames()
}
function scheduleIdle() {
  clearTimeout(idle)
  idle = undefined
  const { sessionId, pages } = documentViewerStore.getState()
  if (!sessionId || viewers || pages.length || creating.size || starting || signingOut) return
  idle = setTimeout(() => {
    idle = undefined
    const state = documentViewerStore.getState()
    if (
      viewers ||
      state.pages.length ||
      creating.size ||
      starting ||
      signingOut ||
      state.sessionId !== sessionId
    )
      return
    // Keep identity until the close completes; never race a new profile holder.
    starting = localBrowser
      .closeSession(sessionId)
      .then(() => {
        if (documentViewerStore.getState().sessionId === sessionId) reset()
        return ""
      })
      .catch((error) => {
        documentViewerStore.setState({ status: "error", error: documentViewerErrorReason(error) })
        return ""
      })
      .finally(() => {
        starting = undefined
      })
  }, DOCUMENT_VIEWER_IDLE_MS)
}
function applyPages(pages: DocumentViewerPage[], activePageId?: string | null) {
  const state = documentViewerStore.getState()
  // Opener chains can be reported in any order, or after the opener closes.
  let inherited = true
  while (inherited) {
    inherited = false
    for (const page of pages) {
      const owner = page.openerId ? pageOwners.get(page.openerId) : undefined
      if (!pageOwners.has(page.id) && owner) {
        pageOwners.set(page.id, owner)
        inherited = true
      }
    }
  }
  const active = activePageId ?? pages.find((page) => page.active)?.id ?? null
  const byTab: ViewerState["byTab"] = {}
  for (const [tabId, old] of Object.entries(state.byTab)) {
    const owned = pages.filter((page) => pageOwners.get(page.id) === tabId)
    const page =
      owned.find((next) => state.dialogs[next.id]) ??
      owned.find((next) => next.id === active) ??
      owned.find((next) => next.id === old.id) ??
      owned.find((next) => next.id === old.openerId) ??
      owned[0]
    if (page) byTab[tabId] = page
    else if (creating.has(tabId)) byTab[tabId] = old
    else settleClose(tabId, true)
  }
  const alive = new Set(pages.map((page) => page.id))
  documentViewerStore.setState({
    pages,
    byTab,
    activePageId: active,
    dialogs: Object.fromEntries(Object.entries(state.dialogs).filter(([id]) => alive.has(id))),
  })
  for (const [pageId, tabId] of pageOwners) {
    if (!byTab[tabId]) pageOwners.delete(pageId)
  }
  for (const tabId of closing.keys()) continueClose(tabId)
  scheduleIdle()
}
function onEvent(event: LocalBrowserEvent) {
  if (!event.sessionId || event.sessionId !== documentViewerStore.getState().sessionId) return
  if (event.type === "session.closed") {
    reset("runtime-exited")
    return
  }
  if (event.type === "pages.changed" && Array.isArray(event.pages)) {
    applyPages(
      event.pages as DocumentViewerPage[],
      typeof event.activePageId === "string" ? event.activePageId : undefined
    )
  }
  if (event.type === "dialog.opened" && typeof event.pageId === "string" && event.dialog) {
    const pageId = event.pageId
    const owner = pageOwners.get(pageId)
    documentViewerStore.setState((state) => {
      const page = state.pages.find((next) => next.id === pageId)
      return {
        dialogs: { ...state.dialogs, [pageId]: event.dialog! },
        ...(owner && page ? { byTab: { ...state.byTab, [owner]: page } } : {}),
      }
    })
  }
}
async function ensureSession(): Promise<string> {
  if (signingOut) throw new DocumentViewerError("signed-out")
  if (starting) {
    await starting
    return ensureSession()
  }
  const existing = documentViewerStore.getState().sessionId
  if (existing) return existing
  const epoch = generation
  const work = (async () => {
    documentViewerStore.setState({ status: "preparing", error: null })
    listening ??= localBrowser
      .onEvent(onEvent)
      .then((stop) => {
        unlisten = stop
      })
      .catch((error) => {
        listening = undefined
        throw error
      })
    await listening
    const id = `document-viewer-${crypto.randomUUID()}`
    // Set before create: session.closed during initialization must invalidate it.
    documentViewerStore.setState({ sessionId: id })
    await localBrowser.createSession({
      id,
      kind: "local",
      purpose: "document-viewer",
      profileId: DOCUMENT_VIEWER_PROFILE,
      viewport: DOCUMENT_VIEWER_VIEWPORT,
      deviceScaleFactor: 1,
    })
    if (generation !== epoch) {
      await localBrowser.closeSession(id).catch(() => undefined)
      throw new DocumentViewerError("runtime-exited")
    }
    const pages = await localBrowser.rpc<DocumentViewerPage[]>("browser.pages", { sessionId: id })
    if (generation !== epoch) throw new DocumentViewerError("runtime-exited")
    initialPageId = pages.find((page) => page.url === "about:blank" && !page.openerId)?.id
    applyPages(pages)
    documentViewerStore.setState({ status: "ready" })
    return id
  })()
  starting = work
  try {
    return await work
  } catch (error) {
    if (generation === epoch) {
      const id = documentViewerStore.getState().sessionId
      if (id) await localBrowser.closeSession(id).catch(() => undefined)
      reset(documentViewerErrorReason(error))
    }
    throw error
  } finally {
    if (starting === work) starting = undefined
  }
}

/** A mount holds the runtime, but unmounting does not own/close its dock tab. */
export function retainDocumentViewer(): () => void {
  viewers += 1
  scheduleIdle()
  let released = false
  return () => {
    if (!released) {
      released = true
      viewers -= 1
      scheduleIdle()
    }
  }
}
export function hasDocumentViewerPage(docTabId: string): boolean {
  return !!documentViewerStore.getState().byTab[docTabId] || creating.has(docTabId)
}
export function ensureDocumentViewerPage(
  docTabId: string,
  url: string
): Promise<DocumentViewerPage> {
  const pending = creating.get(docTabId)
  if (pending) return pending
  const work = (async () => {
    const sessionId = await ensureSession()
    const state = documentViewerStore.getState()
    const existing = state.byTab[docTabId]
    if (existing) {
      if (existing.loadError || existing.url === "about:blank") {
        await localBrowser.rpc("browser.navigate", { sessionId, pageId: existing.id, url })
        await refreshDocumentViewerPages(sessionId)
      }
      return documentViewerStore.getState().byTab[docTabId] ?? existing
    }
    const blank = state.pages.find(
      (page) => page.id === initialPageId && page.url === "about:blank"
    )
    // Each pending request reserves a slot before its page RPC can yield.
    if (
      Object.keys(state.byTab).length >= DOCUMENT_VIEWER_PAGE_CAP ||
      (!blank && state.pages.length >= DOCUMENT_VIEWER_PAGE_CAP)
    )
      throw new DocumentViewerError("cap-reached")
    const reserved = { id: `pending:${docTabId}`, url, title: "", active: false, loading: true }
    if (blank) {
      initialPageId = undefined
      pageOwners.set(blank.id, docTabId)
    }
    documentViewerStore.setState((current) => ({
      byTab: { ...current.byTab, [docTabId]: blank ?? reserved },
    }))
    try {
      const page =
        blank ??
        (await localBrowser.rpc<DocumentViewerPage>("browser.page.create", {
          sessionId,
          activate: false,
        }))
      if (sessionId !== documentViewerStore.getState().sessionId)
        throw new DocumentViewerError("runtime-exited")
      pageOwners.set(page.id, docTabId)
      documentViewerStore.setState((current) => ({
        byTab: { ...current.byTab, [docTabId]: { ...page, loading: true } },
      }))
      await localBrowser.rpc("browser.navigate", { sessionId, pageId: page.id, url })
      await refreshDocumentViewerPages(sessionId)
      return documentViewerStore.getState().byTab[docTabId] ?? page
    } catch (error) {
      // Preserve a created page after navigation failure for retry/close.
      documentViewerStore.setState((current) => ({
        byTab: Object.fromEntries(
          Object.entries(current.byTab).filter(
            ([tab, page]) => tab !== docTabId || !page.id.startsWith("pending:")
          )
        ),
      }))
      throw error
    }
  })()
  creating.set(docTabId, work)
  void work
    .finally(() => {
      if (creating.get(docTabId) === work) creating.delete(docTabId)
      scheduleIdle()
    })
    .catch(() => undefined)
  return work
}
export async function refreshDocumentViewerPages(
  sessionId = documentViewerStore.getState().sessionId
): Promise<void> {
  if (!sessionId) return
  const pages = await localBrowser.rpc<DocumentViewerPage[]>("browser.pages", { sessionId })
  if (documentViewerStore.getState().sessionId === sessionId) applyPages(pages)
}
export async function activateDocumentViewerPage(pageId: string): Promise<void> {
  const { sessionId } = documentViewerStore.getState()
  if (!sessionId) throw new DocumentViewerError("runtime-exited")
  await localBrowser.rpc("browser.page.activate", { sessionId, pageId })
  if (sessionId === documentViewerStore.getState().sessionId)
    documentViewerStore.setState({ activePageId: pageId })
}
/** Resolves only when gone or cancelled; the tab survives an unsaved-change dialog. */
export async function closeDocumentViewerPage(docTabId: string): Promise<boolean> {
  if (creating.has(docTabId)) await creating.get(docTabId)!.catch(() => undefined)
  const pending = closing.get(docTabId)
  if (pending) return pending.promise
  const { sessionId, byTab, dialogs } = documentViewerStore.getState()
  const page = byTab[docTabId]
  if (!sessionId || !page) return true
  if (Object.keys(dialogs).some((id) => pageOwners.get(id) === docTabId)) return false
  let resolve!: (closed: boolean) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes
    reject = no
  })
  closing.set(docTabId, { promise, resolve, reject })
  continueClose(docTabId)
  return promise
}
function continueClose(docTabId: string) {
  const pending = closing.get(docTabId)
  if (!pending) return
  const { sessionId, byTab, pages, dialogs } = documentViewerStore.getState()
  if (!sessionId || !byTab[docTabId]) {
    settleClose(docTabId, true)
    return
  }
  // A requested beforeunload close completes through events after the answer.
  if (pending.pageId && pages.some((page) => page.id === pending.pageId)) return
  if (Object.keys(dialogs).some((id) => pageOwners.get(id) === docTabId)) {
    settleClose(docTabId, false)
    return
  }
  // Close descendants before their openers, preserving each page's unload prompt.
  const owned = pages.filter((page) => pageOwners.get(page.id) === docTabId)
  const leaves = owned.filter(
    (candidate) => !owned.some((child) => child.openerId === candidate.id)
  )
  const page =
    leaves.find((candidate) => candidate.id === byTab[docTabId].id) ??
    leaves.at(-1) ??
    byTab[docTabId]
  pending.pageId = page.id
  // Register the completion before dispatch: dialog and page events may beat the RPC.
  void localBrowser
    .rpc<{ closed: boolean; reason?: string } | undefined>("browser.page.close", {
      sessionId,
      pageId: page.id,
      runBeforeUnload: true,
    })
    .then(async (result) => {
      if (closing.get(docTabId) !== pending) return
      if (result?.closed === false) settleClose(docTabId, false)
      await refreshDocumentViewerPages(sessionId)
    })
    .catch((error) => {
      if (closing.get(docTabId) !== pending) return
      closing.delete(docTabId)
      if (documentViewerStore.getState().sessionId === sessionId)
        documentViewerStore.setState({ status: "error", error: documentViewerErrorReason(error) })
      pending.reject(error)
    })
}
export async function answerDocumentViewerDialog(
  pageId: string,
  answer: { accept: boolean; promptText?: string }
): Promise<void> {
  const { sessionId, dialogs } = documentViewerStore.getState()
  if (!sessionId) throw new DocumentViewerError("runtime-exited")
  await localBrowser.rpc("browser.dialog.handle", { sessionId, pageId, ...answer })
  if (documentViewerStore.getState().sessionId !== sessionId) return
  documentViewerStore.setState((state) => ({
    dialogs: Object.fromEntries(Object.entries(state.dialogs).filter(([id]) => id !== pageId)),
  }))
  if (dialogs[pageId]?.type === "beforeunload" && !answer.accept) {
    const tabId = pageOwners.get(pageId)
    if (tabId) settleClose(tabId, false)
  }
  await refreshDocumentViewerPages(sessionId)
}
export function signOutDocumentViewer(): Promise<void> {
  if (signingOut) return signingOut
  const work = (async () => {
    await starting?.catch(() => undefined)
    const { sessionId } = documentViewerStore.getState()
    if (sessionId) await localBrowser.closeSession(sessionId)
    reset()
    await clearDocumentViewerProfile()
    documentViewerStore.setState({ status: "error", error: "signed-out" })
  })()
  signingOut = work
  void work
    .finally(() => {
      if (signingOut === work) signingOut = undefined
    })
    .catch(() => undefined)
  return work
}
function syncFrames(): Promise<void> {
  frameSync = frameSync
    .catch(() => undefined)
    .then(async () => {
      const sessionId = documentViewerStore.getState().sessionId
      const wanted = frameListeners.size ? sessionId : null
      if (frameSubscription && frameSubscription.sessionId !== wanted) {
        frameSubscription.stop()
        frameSubscription = undefined
      }
      if (!wanted || frameSubscription) return
      const stop = await localBrowser.subscribeFrames(wanted, (bytes) => {
        if (documentViewerStore.getState().sessionId !== wanted) return
        const active = documentViewerStore.getState().activePageId
        for (const listener of frameListeners.values())
          if (listener.pageId === active) listener.receive(bytes)
      })
      frameSubscription = { sessionId: wanted, stop }
    })
  return frameSync
}
export function subscribeDocumentViewerFrames(
  pageId: string,
  receive: (bytes: Uint8Array) => void,
  onError: (error: unknown) => void
): () => void {
  const key = Symbol()
  frameListeners.set(key, { pageId, receive })
  void syncFrames().catch(onError)
  return () => {
    frameListeners.delete(key)
    void syncFrames().catch(() => undefined)
  }
}
export function resetDocumentViewerForTests(): void {
  unlisten?.()
  unlisten = undefined
  listening = undefined
  frameSubscription?.stop()
  frameSubscription = undefined
  frameListeners.clear()
  frameSync = Promise.resolve()
  viewers = 0
  signingOut = undefined
  reset()
}
