import type { SlashContext } from "../builtin"
import { toast } from "sonner"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { isNativeMobile } from "@/lib/platform/detect"
import { getDb } from "@/lib/db/schema"
import { createResourceSessionRepository } from "@/lib/db/resource-workbench-sessions"
import {
  ensureResourceWorkbenchSession,
  isEmbeddedAside,
} from "@/lib/context-workbench/resource-session"
import { getContextResourceKey } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { withScopedAsides } from "@/lib/chat/session-exposure"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"

/** A reported refusal: the slash-command caller must retain the owning draft. */
export class SideChatDispatchError extends Error {}

/** Reveal an existing aside without promoting it or replacing its draft. */
export async function revealSideChat(
  parentId: string,
  asideId: string,
  messageId?: string,
  signal?: AbortSignal
): Promise<boolean> {
  const initialActive = useChatStore.getState().activeSessionId
  const [parent, aside] = await Promise.all([
    getDb().sessions.get(parentId),
    getDb().sessions.get(asideId),
  ])
  if (
    signal?.aborted ||
    useChatStore.getState().activeSessionId !== initialActive ||
    !parent ||
    !aside ||
    !withScopedAsides([parent], [aside]).includes(aside)
  ) {
    return false
  }
  if (parent.projectId && useProjectStore.getState().activeProjectId !== parent.projectId) {
    useProjectStore.getState().setActiveProject(parent.projectId)
  }
  if (useChatStore.getState().activeSessionId !== parentId) {
    useChatStore.getState().setActiveSession(parentId)
  }
  if (
    isNativeMobile() ||
    (typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches)
  )
    return true
  const resourceKey = getContextResourceKey({
    kind: "session",
    sessionId: parentId,
    capabilities: ["ai"],
  })
  useContextWorkbenchStore.getState().setSessionOverride(resourceKey, asideId)
  useArtifactDockLayoutStore.getState().revealSidechat()
  return messageId
    ? jumpToSessionMessage(asideId, messageId, {
        activeSessionId: parentId,
        align: "center",
        signal,
      })
    : true
}

/** Resolve the same override / ensured primary used by the mounted workbench. */
export async function openSideChat(sessionId: string, question = ""): Promise<void> {
  const binding = { kind: "session" as const, sessionId }
  const resourceKey = getContextResourceKey({ ...binding, capabilities: ["ai"] })
  const workbench = useContextWorkbenchStore.getState()
  const override = workbench.sessionOverrides?.[resourceKey]
  let aside = override ? await getDb().sessions.get(override) : undefined
  if (aside?.kind !== "resource-workbench") {
    if (override) workbench.setSessionOverride(resourceKey, null)
    aside = await ensureResourceWorkbenchSession(
      binding,
      resourceKey,
      createResourceSessionRepository()
    )
  }
  if (question.trim()) useSideChatRequestStore.getState().enqueue(aside.id, question.trim())
  useComposerIntentStore.getState().stage(aside.id, {
    candidateId: crypto.randomUUID(),
    prompt: null,
  })
  useArtifactDockLayoutStore.getState().revealSidechat()
}

export async function dispatchSideChat(ctx: SlashContext): Promise<void> {
  const t = await getRuntimeTranslator("contextWorkbench.asides")
  if (
    ctx.isMobile ||
    isNativeMobile() ||
    (typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches)
  ) {
    toast.info(t("desktopOnly"))
    throw new SideChatDispatchError(t("desktopOnly"))
  }
  if (!ctx.activeSessionId) {
    toast.info(t("needSession"))
    throw new SideChatDispatchError(t("needSession"))
  }
  try {
    if (
      ctx.isAside ||
      isEmbeddedAside(ctx.activeSessionId, await getDb().sessions.get(ctx.activeSessionId))
    )
      throw new SideChatDispatchError(t("openError"))
    await openSideChat(ctx.activeSessionId, ctx.args)
  } catch {
    toast.error(t("openError"))
    throw new SideChatDispatchError(t("openError"))
  }
}
