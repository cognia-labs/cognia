"use client"

/**
 * Move a conversation to another Workspace, from any control that offers it.
 *
 * Attribution is correctable (ADR-0144): a conversation started in the wrong
 * workspace, or in Default before one existed, would otherwise be stuck there,
 * invisible to the workspace it belongs to. The session settings sheet offered
 * the move and the conversation list did not, and the list is where a reader
 * notices a conversation in the wrong place. Both call this, so there is one
 * copy of the three writes a move is: the `projectId` column, an execution
 * context rebuilt against the destination's root, and the roster on both sides.
 *
 * The refusals and the rebuilt context come from `planSessionMove`; the routed
 * writer (`lib/chat/session-workspace-move-writes.ts`) hands the move to the
 * Host on a paired client — the Host owns the rows there, exactly as it does
 * for archive, delete, rename and pin — and writes it here otherwise. This
 * hook says what happened. The writer, with the planner, the broker and the
 * session table behind it, is loaded on the first move rather than with the
 * hook: every row of the conversation list mounts it, and almost none of them
 * ever moves.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useProjectStore } from "@/stores/project/project-store"
import { useHostStateActionOffered } from "@/hooks/data/use-host-state-action-offered"
import type { MovableSession } from "@/lib/chat/session-workspace-move-writes"

export type { MovableSession }

export interface MoveSessionWorkspace {
  /**
   * Resolves true when the conversation moved, or was handed to the Host that
   * moves it; false when it was refused or the write failed.
   */
  move: (session: MovableSession, targetId: string) => Promise<boolean>
  busy: boolean
}

export function useMoveSessionWorkspace(): MoveSessionWorkspace {
  const t = useTranslations("chat.header.sheet.workspaceMove")
  const [busy, setBusy] = useState(false)

  const move = useCallback(
    async (session: MovableSession, targetId: string) => {
      setBusy(true)
      try {
        const { moveSessionWorkspaceRouted } =
          await import("@/lib/chat/session-workspace-move-writes")
        const result = await moveSessionWorkspaceRouted(session, targetId)
        switch (result.status) {
          case "refused":
            toast.error(t(`refused.${result.reason}`))
            return false
          // Not "moved": the Host has yet to apply it, and may still refuse a
          // move this device could not see was wrong (a turn the Host is
          // running). Its row arrives through sync either way.
          case "sent-to-host":
            toast.success(t("sentToHost"))
            return true
          case "moved":
            toast.success(t("moved"))
            return true
        }
      } catch (error) {
        toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }))
        return false
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  return { move, busy }
}

/** A conversation of a bulk move, with what its outcome line calls it. */
export type BulkMovableSession = MovableSession & { title?: string }

export interface BulkMoveSessionWorkspace {
  /**
   * Move every conversation to workspace `targetId`, one routed write each,
   * then say in one toast how many moved, how many went to the Host and which
   * ones were refused or failed (and why). Conversations already there are
   * skipped. Resolves true only when every one moved or was handed to the
   * Host — a selection with refusals survives for a retry.
   */
  moveMany: (sessions: readonly BulkMovableSession[], targetId: string) => Promise<boolean>
  busy: boolean
  /** The Host (if any) takes this move from this caller at all. */
  offered: boolean
  /** Non-archived workspaces — the destinations a selection is offered. */
  workspaceTargets: readonly { id: string; name: string }[]
}

/** Refused / failed rows the summary names before it counts the rest. */
const BULK_MOVE_NAMED_ROWS = 5

/**
 * Move a selection to another workspace — the bulk twin of
 * {@link useMoveSessionWorkspace} (sidebar audit item 10). Each conversation
 * goes through the same routed writer as a single move, so the planner's
 * refusals (running, archived, handed off) and the Host hand-over apply row by
 * row; the rows run one after another, because each move rewrites both
 * workspaces' rosters in the project store.
 */
export function useBulkMoveSessionWorkspace(): BulkMoveSessionWorkspace {
  const t = useTranslations("chat.header.sheet.workspaceMove")
  const [busy, setBusy] = useState(false)
  const offered = useHostStateActionOffered("session.workspace")
  const projects = useProjectStore((s) => s.projects)
  const workspaceTargets = useMemo(
    () =>
      projects
        .filter((workspace) => !workspace.isArchived)
        .map((workspace) => ({ id: workspace.id, name: workspace.name })),
    [projects]
  )

  const moveMany = useCallback(
    async (sessions: readonly BulkMovableSession[], targetId: string) => {
      const pending = sessions.filter((session) => session.projectId !== targetId)
      if (pending.length === 0) return true
      setBusy(true)
      let moved = 0
      let sentToHost = 0
      const problems: string[] = []
      try {
        const { moveSessionWorkspaceRouted } =
          await import("@/lib/chat/session-workspace-move-writes")
        for (const session of pending) {
          const name = session.title?.trim() || t("bulk.untitled")
          try {
            const result = await moveSessionWorkspaceRouted(session, targetId)
            if (result.status === "moved") moved += 1
            else if (result.status === "sent-to-host") sentToHost += 1
            else {
              problems.push(
                t("bulk.rowRefused", { title: name, reason: t(`refused.${result.reason}`) })
              )
            }
          } catch (error) {
            problems.push(
              t("bulk.rowFailed", {
                title: name,
                error: error instanceof Error ? error.message : String(error),
              })
            )
          }
        }
      } finally {
        setBusy(false)
      }
      const summary = t("bulk.summary", {
        moved,
        sentToHost,
        refused: problems.length,
      })
      const named = problems.slice(0, BULK_MOVE_NAMED_ROWS)
      const rest = problems.length - named.length
      const description =
        problems.length > 0
          ? [...named, ...(rest > 0 ? [t("bulk.more", { count: rest })] : [])].join("\n")
          : undefined
      // One line per named row.
      const options = { description, classNames: { description: "whitespace-pre-line" } }
      if (problems.length === 0) toast.success(summary)
      else if (moved + sentToHost > 0) toast.warning(summary, options)
      else toast.error(summary, options)
      return problems.length === 0
    },
    [t]
  )

  return { moveMany, busy, offered, workspaceTargets }
}

export interface SessionWorkspaceMoveMenu {
  /** Non-archived workspaces; the conversation's own is listed checked and inert. */
  workspaceTargets: readonly { id: string; name: string }[]
  /** There is somewhere else to move it. */
  canMoveWorkspace: boolean
  movingWorkspace: boolean
  onMoveWorkspace: (workspaceId: string) => void
}

/**
 * The "Move to workspace" submenu for one conversation row — what the desktop
 * row menu and the mobile action sheet both offer. Archived workspaces are not
 * destinations. Reads the stable store array and filters it here, so a row
 * does not re-render for unrelated project-store writes.
 */
export function useSessionWorkspaceMoveMenu(session: MovableSession): SessionWorkspaceMoveMenu {
  const projects = useProjectStore((s) => s.projects)
  const workspaceTargets = useMemo(
    () => projects.filter((workspace) => !workspace.isArchived),
    [projects]
  )
  const { move, busy } = useMoveSessionWorkspace()
  // A Host that refuses the move for this caller (an org member's partition)
  // gets no submenu: the move would only come back refused.
  const offered = useHostStateActionOffered("session.workspace")
  return {
    workspaceTargets,
    // An archived row is frozen in place (ADR-0213), workspace included.
    canMoveWorkspace:
      offered &&
      session.archivedAt == null &&
      workspaceTargets.some((workspace) => workspace.id !== session.projectId),
    movingWorkspace: busy,
    onMoveWorkspace: (workspaceId) => void move(session, workspaceId),
  }
}
