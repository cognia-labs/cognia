/** Document descriptors persist; bodies and retrieval authority never do. */
import { create } from "zustand"
import { dockSessionScopeKey } from "./dock-pages"
import {
  classifyCloudDocumentUrl,
  type CloudDocumentTarget,
} from "@/lib/docs-providers/document-url"
import { getDocsProvider } from "@/lib/docs-providers"
import { accountMatchesBinding } from "@/lib/docs-providers/account-binding"
import type { DocsProviderAccountBinding } from "@/lib/docs-providers/types"
import {
  useDockDocumentsStore,
  type DockDocumentTab,
  type DockDocumentView,
} from "@/stores/artifact/dock-documents-store"
import { documentTabKey, useDockTabsStore } from "@/stores/artifact/dock-tabs-store"
import { selectActiveArtifactId, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useChatStore } from "@/stores/chat"
import { unwrapUntrustedContent } from "@/lib/web/untrusted-content"
import { isInFlight } from "@/lib/chat/aggregate-run-state"
import {
  closeDocumentViewerPage,
  hasDocumentViewerPage,
} from "@/lib/browser/document-viewer-session"

export const DOCK_DOCUMENT_PANEL_ID = "cloud-document"
export type DockDocumentEntry =
  "link" | "picker" | "staged-attachment" | "sent-attachment" | "source" | "tool-result"
export interface DockDocumentSnapshotContent {
  title: string
  text: string
  format: "markdown" | "text" | "csv"
  fetchedAt: number
  completeness: { status: "complete" } | { status: "partial"; reasons: readonly string[] }
  truncated?: boolean
  origin: "sent" | "staged" | "fetched"
}
export type DockDocumentSnapshotSource =
  | { kind: "inline"; content: DockDocumentSnapshotContent }
  | { kind: "asset"; assetId: string; messageId?: string }
export interface DockDocumentOpenRequest {
  sessionId: string
  target: CloudDocumentTarget
  entry: DockDocumentEntry
  view?: DockDocumentView
  snapshot?: DockDocumentSnapshotSource
  binding?: DocsProviderAccountBinding
  reveal?: boolean
}
export interface DockDocumentMemory {
  generation: number
  binding?: DocsProviderAccountBinding
  seed?: DockDocumentSnapshotContent
  sent?: DockDocumentSnapshotContent
  /** Revision of the session asset `sent` was read from; a change reloads it. */
  sentRevision?: number
  latest?: DockDocumentSnapshotContent
  /**
   * Which body the tab shows when it has both. Reopening a sent attachment asks
   * for the version that was sent; a refresh asks for the latest preview.
   */
  showing?: "sent" | "latest"
}
export const useDockDocumentCache = create<{ byId: Record<string, DockDocumentMemory> }>(() => ({
  byId: {},
}))
let generation = 0
const requests = new Map<string, Set<AbortController>>()
const accountSubscriptions = new Map<string, () => void>()
let stopLifecycle: (() => void) | undefined

export function documentMemory(docTabId: string): DockDocumentMemory {
  const cached = useDockDocumentCache.getState().byId[docTabId]
  if (cached) return cached
  const memory = { generation: ++generation }
  useDockDocumentCache.setState((state) => ({ byId: { ...state.byId, [docTabId]: memory } }))
  return memory
}
export function updateDocumentMemory(docTabId: string, patch: Partial<DockDocumentMemory>): void {
  const memory = documentMemory(docTabId)
  useDockDocumentCache.setState((state) => ({
    byId: { ...state.byId, [docTabId]: { ...memory, ...patch } },
  }))
}
export function invalidateDocument(docTabId: string, release = false): void {
  for (const controller of requests.get(docTabId) ?? []) controller.abort()
  requests.delete(docTabId)
  useDockDocumentCache.setState((state) => {
    const byId = { ...state.byId }
    if (release) delete byId[docTabId]
    else if (byId[docTabId]) byId[docTabId] = { ...byId[docTabId], generation: ++generation }
    return { byId }
  })
}
export function trackDocumentRequest(docTabId: string, controller: AbortController): () => void {
  const active = requests.get(docTabId) ?? new Set<AbortController>()
  active.add(controller)
  requests.set(docTabId, active)
  return () => {
    active.delete(controller)
    if (!active.size) requests.delete(docTabId)
  }
}
/**
 * Forget what the tab's account read: abort its requests, drop the binding,
 * the latest preview and a picker preview fetched under it. Snapshots the
 * user staged or sent stay — they belong to the conversation, not to the
 * account — so a revoked or switched identity never strands them.
 */
export function dropDocumentIdentity(docTabId: string): void {
  invalidateDocument(docTabId)
  const memory = documentMemory(docTabId)
  updateDocumentMemory(docTabId, {
    binding: undefined,
    latest: undefined,
    ...(memory.seed?.origin === "fetched" ? { seed: undefined } : {}),
  })
}

export function bindDockDocument(docTabId: string, binding: DocsProviderAccountBinding): void {
  const previous = useDockDocumentCache.getState().byId[docTabId]?.binding
  if (
    previous &&
    (previous.accountId !== binding.accountId ||
      previous.authorizationEpoch !== binding.authorizationEpoch)
  )
    dropDocumentIdentity(docTabId)
  else invalidateDocument(docTabId)
  updateDocumentMemory(docTabId, { binding: { ...binding } })
}

/**
 * A provider's accounts changed (sign-in, sign-out, revocation, or just a
 * token refresh). A tab bound to an identity that no longer verifies loses the
 * binding and the latest preview that identity read; snapshots the user staged
 * or sent stay, because they belong to the conversation, not to the account.
 */
export async function reverifyDockDocumentBindings(providerId: string): Promise<void> {
  const provider = getDocsProvider(providerId)
  if (!provider) return
  const bound = Object.values(useDockDocumentsStore.getState().bySession)
    .flatMap((entry) => entry.documents)
    .filter(
      (tab) =>
        tab.providerId === providerId && useDockDocumentCache.getState().byId[tab.id]?.binding
    )
  if (!bound.length) return
  const accounts = await provider.listAccounts().catch(() => [])
  for (const tab of bound) {
    const binding = useDockDocumentCache.getState().byId[tab.id]?.binding
    if (!binding || accounts.some((account) => accountMatchesBinding(account, binding))) continue
    dropDocumentIdentity(tab.id)
  }
}

function watchProvider(providerId: string): void {
  if (accountSubscriptions.has(providerId)) return
  const provider = getDocsProvider(providerId)
  if (!provider) return
  const stop = provider.subscribeAccounts?.(() => void reverifyDockDocumentBindings(providerId))
  if (stop) accountSubscriptions.set(providerId, stop)
}

/** Installed by the dock and lazily by direct opens, including restored tabs. */
export function subscribeDockDocumentLifecycle(): () => void {
  if (stopLifecycle) return stopLifecycle
  const waiting = new Set<string>()
  const releasePages = (sessionId: string) => {
    for (const tab of useDockDocumentsStore.getState().bySession[sessionId]?.documents ?? [])
      void closeDocumentViewerPage(tab.id).catch(() => undefined)
  }
  const watch = () => {
    for (const entry of Object.values(useDockDocumentsStore.getState().bySession)) {
      for (const tab of entry.documents) watchProvider(tab.providerId)
    }
  }
  watch()
  const stopDocuments = useDockDocumentsStore.subscribe((state, previous) => {
    for (const [sessionId, entry] of Object.entries(previous.bySession)) {
      const next = state.bySession[sessionId]
      for (const tab of entry.documents) {
        if (!next?.documents.some((doc) => doc.id === tab.id)) {
          invalidateDocument(tab.id, true)
          void closeDocumentViewerPage(tab.id).catch(() => undefined)
        } else if (entry.activeDocumentTabId === tab.id && next.activeDocumentTabId !== tab.id)
          invalidateDocument(tab.id)
      }
    }
    watch()
  })
  const stopChat = useChatStore.subscribe((state, previous) => {
    for (const sessionId of waiting) {
      if (state.activeSessionId === sessionId) waiting.delete(sessionId)
      else if (!isInFlight(state.sessions[sessionId]?.status ?? "idle")) {
        waiting.delete(sessionId)
        releasePages(sessionId)
      }
    }
    for (const [sessionId, entry] of Object.entries(useDockDocumentsStore.getState().bySession)) {
      if (!state.sessions[sessionId] && previous.sessions[sessionId]) {
        for (const tab of entry.documents) closeDockDocument(sessionId, tab.id)
        useDockDocumentsStore.getState().removeSession(sessionId)
      } else if (
        state.activeSessionId !== previous.activeSessionId &&
        sessionId === previous.activeSessionId
      ) {
        for (const tab of entry.documents) invalidateDocument(tab.id)
        if (isInFlight(state.sessions[sessionId]?.status ?? "idle")) waiting.add(sessionId)
        else releasePages(sessionId)
      }
    }
  })
  stopLifecycle = () => {
    stopDocuments()
    stopChat()
    waiting.clear()
    for (const stop of accountSubscriptions.values()) stop()
    accountSubscriptions.clear()
    for (const id of Object.keys(useDockDocumentCache.getState().byId)) invalidateDocument(id, true)
    stopLifecycle = undefined
  }
  return stopLifecycle
}

export function activateDockDocument(sessionId: string, docTabId: string, reveal = true): void {
  const store = useDockDocumentsStore.getState()
  if (!store.bySession[sessionId]?.documents.some((tab) => tab.id === docTabId)) return
  store.activate(sessionId, docTabId)
  useContextWorkbenchStore
    .getState()
    .navigatePanel(dockSessionScopeKey(sessionId), DOCK_DOCUMENT_PANEL_ID, "wide")
  if (!reveal || useChatStore.getState().activeSessionId !== sessionId) return
  const artifacts = useArtifactStore.getState()
  if (selectActiveArtifactId(artifacts, sessionId)) artifacts.setActiveArtifact(null, sessionId)
  useArtifactDockLayoutStore.getState().openBrowser()
}

export function openDockDocument(req: DockDocumentOpenRequest): string | null {
  const sessions = useChatStore.getState().sessions
  if (!req.sessionId || !Object.hasOwn(sessions, req.sessionId) || !sessions[req.sessionId])
    return null
  const { target } = req
  if (!["lark", "google"].includes(target.providerId) || !target.resourceId) return null
  const parsed = target.url ? classifyCloudDocumentUrl(target.url) : null
  const url =
    parsed?.providerId === target.providerId &&
    parsed.resourceKind === target.resourceKind &&
    parsed.resourceId === target.resourceId
      ? parsed.url
      : ""
  subscribeDockDocumentLifecycle()
  const store = useDockDocumentsStore.getState()
  const existing = store.bySession[req.sessionId]?.documents.find(
    (tab) =>
      tab.providerId === target.providerId &&
      tab.resourceKind === target.resourceKind &&
      tab.resourceId === target.resourceId
  )
  const id =
    existing?.id ?? `dt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const tab: DockDocumentTab = existing
    ? {
        ...existing,
        ...(target.title ? { title: target.title } : {}),
        ...(target.sourceType ? { sourceType: target.sourceType } : {}),
        ...(req.view ? { view: req.view } : {}),
        ...(url ? { url } : {}),
      }
    : {
        ...target,
        url,
        id,
        title: target.title ?? "",
        openedAt: Date.now(),
        view:
          req.view ?? (["link", "source", "tool-result"].includes(req.entry) ? "live" : "snapshot"),
      }
  if (existing && (tab.view !== existing.view || req.snapshot)) invalidateDocument(id)
  // The tab shows the version the user clicked: another message's asset of the
  // same document replaces the sent snapshot (the latest preview stays apart).
  if (
    req.snapshot?.kind === "asset" &&
    (tab.snapshotRef?.assetId !== req.snapshot.assetId ||
      tab.snapshotRef?.messageId !== req.snapshot.messageId)
  ) {
    tab.snapshotRef = { ...req.snapshot }
    updateDocumentMemory(id, { seed: undefined, sent: undefined })
  }
  // Opening from a sent message shows what was sent, even after a refresh.
  if (req.snapshot?.kind === "asset" || req.snapshot?.content.origin === "sent")
    updateDocumentMemory(id, { showing: "sent" })
  store.put(req.sessionId, tab)
  if (req.binding) bindDockDocument(id, req.binding)
  if (req.snapshot?.kind === "inline") {
    const content = {
      ...req.snapshot.content,
      text: unwrapUntrustedContent(req.snapshot.content.text),
    }
    const held = documentMemory(id)
    if (content.origin !== "sent")
      updateDocumentMemory(
        id,
        held.sent || tab.snapshotRef
          ? { latest: content, showing: "latest" }
          : { seed: content, latest: undefined }
      )
    else if (!held.sent && !tab.snapshotRef) updateDocumentMemory(id, { sent: content })
  }
  activateDockDocument(req.sessionId, id, req.reveal !== false)
  return id
}
export function closeDockDocument(sessionId: string, docTabId: string): void {
  if (
    !useDockDocumentsStore
      .getState()
      .bySession[sessionId]?.documents.some((tab) => tab.id === docTabId)
  )
    return
  if (hasDocumentViewerPage(docTabId)) {
    // Make an unsaved-change dialog reachable even when closing an inactive tab.
    setDockDocumentView(sessionId, docTabId, "live")
    activateDockDocument(sessionId, docTabId)
    void closeDocumentViewerPage(docTabId)
      .then((closed) => {
        if (closed) removeDockDocument(sessionId, docTabId)
      })
      .catch(() => undefined)
    return
  }
  removeDockDocument(sessionId, docTabId)
}
function removeDockDocument(sessionId: string, docTabId: string): void {
  invalidateDocument(docTabId, true)
  useDockDocumentsStore.getState().remove(sessionId, docTabId)
  const tabs = useDockTabsStore.getState()
  const entry = tabs.bySession[sessionId]
  if (entry?.order.includes(documentTabKey(docTabId))) {
    useDockTabsStore.setState({
      bySession: {
        ...tabs.bySession,
        [sessionId]: {
          ...entry,
          order: entry.order.filter((key) => key !== documentTabKey(docTabId)),
        },
      },
    })
  }
  if (!useDockDocumentsStore.getState().bySession[sessionId]?.documents.length) {
    useContextWorkbenchStore
      .getState()
      .closePanelTab(dockSessionScopeKey(sessionId), DOCK_DOCUMENT_PANEL_ID)
  }
}
export function setDockDocumentView(
  sessionId: string,
  docTabId: string,
  view: DockDocumentView
): void {
  const tab = useDockDocumentsStore
    .getState()
    .bySession[sessionId]?.documents.find((doc) => doc.id === docTabId)
  if (!tab || tab.view === view) return
  invalidateDocument(docTabId)
  useDockDocumentsStore.getState().put(sessionId, { ...tab, view })
}
