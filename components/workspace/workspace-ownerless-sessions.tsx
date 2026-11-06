"use client"

/**
 * Shared conversations in this workspace that nobody owns, for org owners and
 * admins (plan §7, F4).
 *
 * Offboarding or a workspace change hands a conversation to the member who
 * may be granted Owner. When nobody left may, it stays without an owner and
 * its members cannot be managed until an admin takes it over. The server
 * lists metadata only: the title and the messages stay private until then,
 * so a row names who started the conversation and how many people are in it.
 *
 * Taking ownership asks for a reason, which the audit log records. Read live
 * from the server like the invitations, and silent when nothing is waiting.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { CrownIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  membershipFailureMessage,
  toMembershipAdminFailure,
  type MembershipAdminFailure,
  type MembershipAdminState,
} from "@/hooks/workspace/use-membership-admin"
import { CollabError, type CollabOwnerlessSession } from "@/lib/collab/client"

/** The server refuses a shorter reason, as it does for break-glass. */
export const RECLAIM_REASON_MIN_LENGTH = 8

export interface WorkspaceOwnerlessSessionsProps {
  admin: Pick<MembershipAdminState, "status" | "canManageOrg" | "context">
  workspaceId: string | null
  /** Bump to reload after a write. */
  reloadKey?: number
  /** Called after a reclaim so the sections that read the audit reload. */
  onReclaimed?: () => void
}

export function WorkspaceOwnerlessSessions({
  admin,
  workspaceId,
  reloadKey = 0,
  onReclaimed,
}: WorkspaceOwnerlessSessionsProps) {
  const t = useTranslations("workspace.members")
  const format = useFormatter()
  const [rows, setRows] = useState<CollabOwnerlessSession[] | null>(null)
  const [error, setError] = useState<MembershipAdminFailure | null>(null)
  const [reclaiming, setReclaiming] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const contextRef = useRef(admin.context)
  useEffect(() => {
    contextRef.current = admin.context
  })
  const allowed = admin.status === "ready" && admin.canManageOrg && admin.context !== null

  const load = useCallback(async () => {
    const context = contextRef.current
    if (!context || !workspaceId) return
    setError(null)
    try {
      const all = await context.client.listOwnerlessSessions(context.orgId)
      setRows(all.filter((row) => row.workspaceId === workspaceId))
    } catch (cause) {
      setError(toMembershipAdminFailure(cause))
    }
  }, [workspaceId])

  useEffect(() => {
    if (!allowed) return
    queueMicrotask(() => void load())
  }, [allowed, reloadKey, load])

  if (!allowed || !workspaceId) return null
  if (error) {
    const message = membershipFailureMessage(error)
    return (
      <p role="alert" className="text-xs text-destructive" data-testid="workspace-ownerless-error">
        {t("ownerless.failed", { message: t(message.key, message.values) })}
      </p>
    )
  }
  if (!rows || rows.length === 0) return null

  const reclaim = async (sessionId: string) => {
    const context = contextRef.current
    if (!context) return
    setBusy(true)
    try {
      await context.client.reclaimSessionOwnership(context.orgId, sessionId, reason.trim())
      toast.success(t("ownerless.reclaimed"))
      setReclaiming(null)
      setReason("")
      onReclaimed?.()
    } catch (cause) {
      if (cause instanceof CollabError && cause.status === 409) {
        // A member owns it again (another admin, or a restored seat).
        toast.success(t("ownerless.alreadyOwned"))
        setReclaiming(null)
        setReason("")
      } else {
        const message = membershipFailureMessage(toMembershipAdminFailure(cause))
        toast.error(t("toast.failed"), { description: t(message.key, message.values) })
      }
    } finally {
      setBusy(false)
      void load()
    }
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 p-3"
      aria-labelledby="workspace-ownerless-heading"
      data-testid="workspace-ownerless-sessions"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id="workspace-ownerless-heading" className="text-sm font-medium">
          {t("ownerless.title", { count: rows.length })}
        </h3>
        <p className="text-xs text-muted-foreground">{t("ownerless.description")}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.sessionId}
            className="flex flex-col gap-1.5 text-xs"
            data-testid={`workspace-ownerless-${row.sessionId}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate">
                {t("ownerless.startedBy", { who: row.createdByUserId })}
              </span>
              <span className="text-muted-foreground">
                {t("ownerless.members", { count: row.memberCount })}
              </span>
              <span className="text-muted-foreground">
                {t("ownerless.changed", {
                  when: format.dateTime(new Date(row.updatedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </span>
              {reclaiming !== row.sessionId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 text-xs"
                  onClick={() => {
                    setReclaiming(row.sessionId)
                    setReason("")
                  }}
                  data-testid={`workspace-ownerless-reclaim-${row.sessionId}`}
                >
                  <CrownIcon aria-hidden className="size-3.5" />
                  {t("ownerless.reclaim")}
                </Button>
              ) : null}
            </div>
            {reclaiming === row.sessionId ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void reclaim(row.sessionId)
                }}
              >
                <Input
                  autoFocus
                  className="h-8 min-w-48 flex-1 text-xs"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("ownerless.reasonPlaceholder")}
                  aria-label={t("ownerless.reasonLabel")}
                  data-testid="workspace-ownerless-reason"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={busy || reason.trim().length < RECLAIM_REASON_MIN_LENGTH}
                  data-testid="workspace-ownerless-confirm"
                >
                  {t("ownerless.confirm")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  disabled={busy}
                  onClick={() => setReclaiming(null)}
                >
                  {t("ownerless.cancel")}
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default WorkspaceOwnerlessSessions
