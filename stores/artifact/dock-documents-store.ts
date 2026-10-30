"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { pruneByLastUsed } from "@/stores/context-workbench/context-workbench-store"
import {
  classifyCloudDocumentUrl,
  type CloudDocumentTarget,
} from "@/lib/docs-providers/document-url"

export type DockDocumentView = "snapshot" | "live"
export type DockDocumentSnapshotRef = { kind: "asset"; assetId: string; messageId?: string }
export interface DockDocumentTab extends CloudDocumentTarget {
  id: string
  title: string
  view: DockDocumentView
  snapshotRef?: DockDocumentSnapshotRef
  openedAt: number
}
export interface SessionDockDocuments {
  documents: DockDocumentTab[]
  activeDocumentTabId: string | null
  lastUsedAt: number
}
interface DockDocumentsState {
  bySession: Record<string, SessionDockDocuments>
  put: (sessionId: string, tab: DockDocumentTab) => void
  activate: (sessionId: string, id: string) => void
  remove: (sessionId: string, id: string) => void
  removeSession: (sessionId: string) => void
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function readTab(value: unknown): DockDocumentTab | null {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !["lark", "google"].includes(String(value.providerId)) ||
    !["doc", "wiki", "sheet", "bitable", "resource"].includes(String(value.resourceKind)) ||
    typeof value.resourceId !== "string" ||
    !value.resourceId ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    !["snapshot", "live"].includes(String(value.view)) ||
    typeof value.openedAt !== "number" ||
    !Number.isFinite(value.openedAt) ||
    !record(value.snapshotRef) ||
    value.snapshotRef.kind !== "asset" ||
    typeof value.snapshotRef.assetId !== "string" ||
    !value.snapshotRef.assetId
  )
    return null
  const target = value.url ? classifyCloudDocumentUrl(value.url) : null
  if (
    value.url &&
    (!target ||
      target.providerId !== value.providerId ||
      target.resourceId !== value.resourceId ||
      target.resourceKind !== value.resourceKind)
  )
    return null
  return {
    id: value.id,
    providerId: value.providerId as DockDocumentTab["providerId"],
    resourceKind: value.resourceKind as DockDocumentTab["resourceKind"],
    resourceId: value.resourceId,
    url: target?.url ?? "",
    title: value.title,
    view: value.view as DockDocumentView,
    openedAt: value.openedAt,
    ...(value.providerId === "lark" &&
    value.resourceKind === "doc" &&
    (value.sourceType === "doc" || value.sourceType === "docx")
      ? { sourceType: value.sourceType }
      : {}),
    snapshotRef: {
      kind: "asset",
      assetId: value.snapshotRef.assetId,
      ...(typeof value.snapshotRef.messageId === "string"
        ? { messageId: value.snapshotRef.messageId }
        : {}),
    },
  }
}

/** Whitelist durable descriptors on every persistence boundary, including same-version hydration. */
export function persistedDockDocuments(value: unknown): {
  bySession: Record<string, SessionDockDocuments>
} {
  const bySession: Record<string, SessionDockDocuments> = {}
  if (!record(value) || !record(value.bySession)) return { bySession }
  for (const [id, entry] of Object.entries(value.bySession)) {
    if (
      !id ||
      !record(entry) ||
      !Array.isArray(entry.documents) ||
      typeof entry.lastUsedAt !== "number" ||
      !Number.isFinite(entry.lastUsedAt)
    )
      continue
    const seen = new Set<string>()
    const documents = entry.documents.flatMap((raw) => {
      const tab = readTab(raw)
      if (!tab || seen.has(tab.id)) return []
      seen.add(tab.id)
      return [tab]
    })
    if (!documents.length) continue
    bySession[id] = {
      documents,
      lastUsedAt: entry.lastUsedAt,
      activeDocumentTabId: documents.some((tab) => tab.id === entry.activeDocumentTabId)
        ? (entry.activeDocumentTabId as string)
        : documents.at(-1)!.id,
    }
  }
  return { bySession: pruneByLastUsed(bySession) }
}

export const useDockDocumentsStore = create<DockDocumentsState>()(
  persist(
    (set) => ({
      bySession: {},
      put: (sessionId, tab) =>
        set((state) => {
          const entry = state.bySession[sessionId]
          return {
            bySession: pruneByLastUsed({
              ...state.bySession,
              [sessionId]: {
                documents: entry?.documents.some((doc) => doc.id === tab.id)
                  ? entry.documents.map((doc) => (doc.id === tab.id ? tab : doc))
                  : [...(entry?.documents ?? []), tab],
                activeDocumentTabId: tab.id,
                lastUsedAt: Date.now(),
              },
            }),
          }
        }),
      activate: (sessionId, id) =>
        set((state) => {
          const entry = state.bySession[sessionId]
          if (!entry?.documents.some((tab) => tab.id === id) || entry.activeDocumentTabId === id)
            return state
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...entry, activeDocumentTabId: id, lastUsedAt: Date.now() },
            },
          }
        }),
      remove: (sessionId, id) =>
        set((state) => {
          const entry = state.bySession[sessionId]
          if (!entry) return state
          const documents = entry.documents.filter((tab) => tab.id !== id)
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...entry,
                documents,
                activeDocumentTabId:
                  entry.activeDocumentTabId === id
                    ? (documents.at(-1)?.id ?? null)
                    : entry.activeDocumentTabId,
              },
            },
          }
        }),
      removeSession: (sessionId) =>
        set((state) => {
          const bySession = { ...state.bySession }
          delete bySession[sessionId]
          return { bySession }
        }),
    }),
    {
      name: "cognia-dock-documents-v1",
      version: 1,
      storage: persistLocalStorage(),
      partialize: (state) => persistedDockDocuments(state),
      migrate: (value, version) =>
        version === 1 ? persistedDockDocuments(value) : { bySession: {} },
      merge: (value, current) => ({ ...current, ...persistedDockDocuments(value) }),
    }
  )
)

const EMPTY_DOCUMENTS: DockDocumentTab[] = []
export function selectDockDocuments(
  state: DockDocumentsState,
  sessionId: string | null
): DockDocumentTab[] {
  return (sessionId ? state.bySession[sessionId]?.documents : undefined) ?? EMPTY_DOCUMENTS
}
export function selectActiveDockDocument(
  state: DockDocumentsState,
  sessionId: string | null
): DockDocumentTab | null {
  const entry = sessionId ? state.bySession[sessionId] : undefined
  return entry?.documents.find((tab) => tab.id === entry.activeDocumentTabId) ?? null
}
