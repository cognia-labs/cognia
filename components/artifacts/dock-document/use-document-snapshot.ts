"use client"

import { requestComposerDocument } from "@/lib/chat/composer-document-request"
import { useCallback, useEffect, useRef, useState } from "react"
import { useHostProfile } from "@/hooks/use-host-profile"
import { getDocsProvider } from "@/lib/docs-providers"
import { accountMatchesBinding } from "@/lib/docs-providers/account-binding"
import { docsProviderReach } from "@/lib/docs-providers/reach"
import {
  DocsProviderError,
  type DocsProviderAccount,
  type DocsProviderAccountBinding,
  type DocsProviderErrorCode,
} from "@/lib/docs-providers/types"
import { useLiveQuery } from "dexie-react-hooks"
import { getSessionAsset, getSessionAssetMetadata } from "@/lib/db/session-assets"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { unwrapUntrustedContent } from "@/lib/web/untrusted-content"
import {
  bindDockDocument,
  documentMemory,
  dropDocumentIdentity,
  invalidateDocument,
  subscribeDockDocumentLifecycle,
  trackDocumentRequest,
  updateDocumentMemory,
  useDockDocumentCache,
  type DockDocumentSnapshotContent,
} from "@/lib/artifacts/dock-documents"
import { useDockDocumentsStore, type DockDocumentTab } from "@/stores/artifact/dock-documents-store"
import { useChatStore } from "@/stores/chat"

export type DocumentSnapshotState =
  "idle" | "resolving" | "loading" | "refreshing" | "ready" | "partial" | "empty" | "error"

async function assetSnapshot(
  sessionId: string,
  tab: DockDocumentTab
): Promise<{ content: DockDocumentSnapshotContent; revision: number } | undefined> {
  if (!tab.snapshotRef) return undefined
  const asset = await getSessionAsset(sessionId, tab.snapshotRef.assetId)
  if (!asset) throw new DocsProviderError("notFound")
  const extraction = asset.extractedContent
  const extracted = extraction?.segments.map((segment) => segment.text).join("\n\n")
  const text = extracted || new TextDecoder("utf-8").decode(await readBlobAsArrayBuffer(asset.blob))
  const truncated = text.includes("[Truncated by Cognia:")
  const incomplete = /\[Incomplete by Cognia: ([a-z, -]+)\./.exec(text)?.[1].split(", ") ?? []
  const reasons = [
    ...new Set([
      ...(extraction && extraction.status !== "ready"
        ? extraction.issues?.length
          ? extraction.issues
          : ["parse-degraded"]
        : []),
      ...incomplete,
      ...(truncated ? ["budget"] : []),
    ]),
  ]
  return {
    revision: asset.revision,
    content: {
      title: tab.title || asset.filename,
      text: unwrapUntrustedContent(text),
      format:
        /csv/i.test(asset.mediaType) || /\.csv$/i.test(asset.filename)
          ? "csv"
          : /markdown/i.test(asset.mediaType) || /\.md$/i.test(asset.filename)
            ? "markdown"
            : "text",
      fetchedAt: asset.createdAt,
      origin: "sent",
      truncated,
      completeness: reasons.length ? { status: "partial", reasons } : { status: "complete" },
    },
  }
}

export function useDocumentSnapshot(sessionId: string, tab: DockDocumentTab) {
  const provider = getDocsProvider(tab.providerId)
  const profile = useHostProfile()
  const reach = docsProviderReach(provider ?? { hosts: [] }, profile)
  const memory = useDockDocumentCache((state) => state.byId[tab.id])
  const [operation, setOperation] = useState<{
    phase: DocumentSnapshotState
    generation?: number
    error?: DocsProviderErrorCode
  }>({ phase: "idle" })
  const [accounts, setAccounts] = useState<DocsProviderAccount[] | null>(null)
  const showLatest = memory?.showing !== "sent"
  const setShowLatest = useCallback(
    (latest: boolean) => updateDocumentMemory(tab.id, { showing: latest ? "latest" : "sent" }),
    [tab.id]
  )
  const requestId = useRef(0)
  const autoFetched = useRef<string | null>(null)
  const mounted = useRef(false)
  const latest = memory?.latest
  const sent = memory?.sent ?? (memory?.seed?.origin === "sent" ? memory.seed : undefined)
  const content = !showLatest && sent ? sent : (latest ?? sent ?? memory?.seed)

  useEffect(() => {
    mounted.current = true
    subscribeDockDocumentLifecycle()
    return () => {
      mounted.current = false
      invalidateDocument(tab.id)
    }
  }, [tab.id])

  const currentTab = useCallback(
    () =>
      useChatStore.getState().activeSessionId === sessionId &&
      useDockDocumentsStore.getState().bySession[sessionId]?.activeDocumentTabId === tab.id &&
      useDockDocumentsStore
        .getState()
        .bySession[sessionId]?.documents.some(
          (doc) => doc.id === tab.id && doc.view === "snapshot"
        ),
    [sessionId, tab.id]
  )

  const snapshotAssetId = tab.snapshotRef?.assetId
  // Watch the asset the sent snapshot came from: removing it from the
  // conversation, or a new revision, must not leave the old body on screen.
  const watchedAsset = useLiveQuery(
    async () =>
      snapshotAssetId
        ? ((await getSessionAssetMetadata(sessionId, snapshotAssetId).catch(() => undefined)) ??
          null)
        : undefined,
    [sessionId, snapshotAssetId]
  )
  const sourceRemoved = !!snapshotAssetId && watchedAsset === null
  useEffect(() => {
    if (watchedAsset === undefined) return
    const held = useDockDocumentCache.getState().byId[tab.id]
    if (!held?.sent || held.sentRevision === undefined) return
    if (watchedAsset === null || watchedAsset.revision !== held.sentRevision) {
      invalidateDocument(tab.id)
      updateDocumentMemory(tab.id, { sent: undefined, sentRevision: undefined })
    }
  }, [tab.id, watchedAsset])

  const needsAsset = !!tab.snapshotRef && !sent && !sourceRemoved
  useEffect(() => {
    if (!needsAsset) return
    const controller = new AbortController()
    const untrack = trackDocumentRequest(tab.id, controller)
    const captured = documentMemory(tab.id)
    const attempt = requestId.current
    const current = () =>
      mounted.current &&
      !controller.signal.aborted &&
      currentTab() &&
      attempt === requestId.current &&
      useDockDocumentCache.getState().byId[tab.id]?.generation === captured.generation
    void (async () => {
      await Promise.resolve()
      if (!current()) return
      if (attempt === 0) setOperation({ phase: "resolving", generation: captured.generation })
      try {
        const snapshot = await assetSnapshot(sessionId, tab)
        if (current() && snapshot) {
          updateDocumentMemory(tab.id, { sent: snapshot.content, sentRevision: snapshot.revision })
          if (attempt === 0) setOperation({ phase: "ready", generation: captured.generation })
        }
      } catch (error) {
        if (current())
          setOperation({
            phase: "error",
            generation: captured.generation,
            error: error instanceof DocsProviderError ? error.code : "network",
          })
      } finally {
        untrack()
      }
    })()
    return () => {
      controller.abort()
      untrack()
    }
  }, [currentTab, needsAsset, sessionId, tab])

  const refresh = useCallback(
    async (choice?: DocsProviderAccountBinding) => {
      if (!provider || !reach.available || !currentTab()) return
      if (choice) bindDockDocument(tab.id, choice)
      else invalidateDocument(tab.id)
      const controller = new AbortController()
      const attempt = ++requestId.current
      const captured = documentMemory(tab.id)
      const binding = choice ?? captured.binding
      if (binding)
        autoFetched.current = JSON.stringify([
          tab.id,
          binding.accountId,
          binding.authorizationEpoch,
          captured.generation,
        ])
      const untrack = trackDocumentRequest(tab.id, controller)
      const alive = () =>
        mounted.current &&
        !controller.signal.aborted &&
        currentTab() &&
        requestId.current === attempt &&
        useDockDocumentCache.getState().byId[tab.id]?.generation === captured.generation
      const phase = content ? "refreshing" : "loading"
      setOperation({ phase, generation: captured.generation })
      try {
        if (!binding) {
          const available = await provider.listAccounts()
          if (alive()) {
            setAccounts(available)
            setOperation({ phase: "idle", generation: captured.generation })
          }
          return
        }
        // A named account click is the only way to establish a missing binding.
        const verify = async () => {
          const available = await provider.listAccounts()
          if (!alive()) return false
          if (!available.some((account) => accountMatchesBinding(account, binding))) {
            // Same path as an account-change notice: what this identity read goes too.
            dropDocumentIdentity(tab.id)
            setAccounts(available)
            setOperation({
              phase: "error",
              generation: documentMemory(tab.id).generation,
              error: "notAuthorized",
            })
            return false
          }
          const held = useDockDocumentCache.getState().byId[tab.id]?.binding
          if (
            !held ||
            held.accountId !== binding.accountId ||
            held.authorizationEpoch !== binding.authorizationEpoch
          )
            return false
          return true
        }
        if (!(await verify())) return
        if (tab.snapshotRef && !documentMemory(tab.id).sent && !sourceRemoved) {
          const snapshot = await assetSnapshot(sessionId, tab)
          if (!alive()) return
          if (snapshot)
            updateDocumentMemory(tab.id, {
              sent: snapshot.content,
              sentRevision: snapshot.revision,
            })
        }
        const fetched = await provider.fetch(
          {
            providerId: tab.providerId,
            kind: tab.resourceKind,
            id: tab.resourceId,
            title: tab.title,
            url: tab.url || undefined,
            sourceType: tab.sourceType,
            accountBinding: { ...binding },
          },
          {
            accountId: binding.accountId,
            expectedAuthorizationEpoch: binding.authorizationEpoch,
            signal: controller.signal,
          }
        )
        if (!(await verify())) return
        const snapshot: DockDocumentSnapshotContent = {
          title: fetched.title,
          text: unwrapUntrustedContent(fetched.text),
          format: fetched.format,
          fetchedAt: Date.now(),
          truncated: fetched.truncated,
          origin: "fetched",
          completeness:
            fetched.completeness?.status === "partial"
              ? { status: "partial", reasons: [...fetched.completeness.reasons] }
              : fetched.truncated
                ? { status: "partial", reasons: ["upstream-truncated"] }
                : { status: "complete" },
        }
        updateDocumentMemory(tab.id, { latest: snapshot, showing: "latest" })
        const descriptor = useDockDocumentsStore
          .getState()
          .bySession[sessionId]?.documents.find((doc) => doc.id === tab.id)
        if (descriptor && fetched.title && descriptor.title !== fetched.title) {
          useDockDocumentsStore.getState().put(sessionId, { ...descriptor, title: fetched.title })
        }
        setAccounts(null)
        setOperation({ phase: "ready", generation: captured.generation })
      } catch (error) {
        if (alive())
          setOperation({
            phase:
              error instanceof DocsProviderError && error.code === "empty" && !content
                ? "empty"
                : "error",
            generation: captured.generation,
            error: error instanceof DocsProviderError ? error.code : "network",
          })
      } finally {
        untrack()
        controller.abort()
      }
    },
    [content, currentTab, provider, reach.available, sessionId, sourceRemoved, tab]
  )

  const binding = memory?.binding
  useEffect(() => {
    if (
      content ||
      tab.snapshotRef ||
      !binding ||
      !reach.available ||
      !currentTab() ||
      (operation.generation === memory?.generation &&
        ["loading", "refreshing"].includes(operation.phase))
    )
      return
    const key = JSON.stringify([
      tab.id,
      binding.accountId,
      binding.authorizationEpoch,
      memory?.generation,
    ])
    if (autoFetched.current === key) return
    autoFetched.current = key
    void Promise.resolve().then(() => refresh())
  }, [
    binding,
    content,
    currentTab,
    operation.phase,
    operation.generation,
    memory?.generation,
    reach.available,
    refresh,
    tab.id,
    tab.snapshotRef,
  ])

  const canAttach =
    latest?.origin === "fetched" && content === latest && !!binding && reach.available
  const attachToChat = useCallback(async () => {
    if (!provider || !canAttach || !binding || !currentTab()) return false
    const held = documentMemory(tab.id)
    const accounts = await provider.listAccounts().catch(() => [])
    if (!mounted.current || !currentTab() || documentMemory(tab.id).generation !== held.generation)
      return false
    if (!accounts.some((account) => accountMatchesBinding(account, binding))) {
      dropDocumentIdentity(tab.id)
      return false
    }
    return requestComposerDocument({
      sessionId,
      doc: {
        providerId: tab.providerId,
        kind: tab.resourceKind,
        id: tab.resourceId,
        title: latest!.title,
        url: tab.url || undefined,
        sourceType: tab.sourceType,
        accountBinding: { ...binding },
      },
    })
  }, [binding, canAttach, currentTab, latest, provider, sessionId, tab])

  const validOperation =
    operation.generation === memory?.generation ? operation : { phase: "idle" as const }
  const state: DocumentSnapshotState = ["loading", "resolving", "refreshing"].includes(
    validOperation.phase
  )
    ? validOperation.phase
    : content
      ? !content.text.trim()
        ? "empty"
        : content.completeness.status === "partial" || content.truncated
          ? "partial"
          : "ready"
      : validOperation.phase
  return {
    state,
    content,
    sent,
    latest,
    showLatest,
    setShowLatest,
    accounts,
    refresh,
    reach,
    error: "error" in validOperation ? validOperation.error : undefined,
    refreshFailed: !!content && validOperation.phase === "error",
    sourceRemoved,
    canAttach,
    attachToChat,
  }
}
