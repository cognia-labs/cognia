"use client"

/**
 * A room's own settings (ADR-0177), for every kind of room.
 *
 * Which controls a room shows depends on where its kind keeps the setting and
 * whether anything reads it yet ({@link ROOM_SETTINGS_CONTROLS}):
 *
 * - **Team rooms** keep everything on `ChatSession.roomSettings`: the reply
 *   mode and the mute list are what the room runner routes on, the hand-off
 *   mode is what `room_handoff_to_squad` reads, the instructions reach every
 *   member's prompt, and the memory switch is what the memory plane reads.
 * - **IM rooms** (ADR-0177 batch 4) take their reply mode from the
 *   conversation's activation policy (`useImRoomReplyMode`), the same field
 *   the Inbox's conversation settings edit, and keep their instructions,
 *   memory switch and mute list on the session, where the connector runtime
 *   reads them for every reply. The mute list shows only when the
 *   conversation names a character team (`useImRoomTeam`): a plain group has
 *   one voice and nobody to mute. Their hand-off mode arrives with the IM
 *   hand-off confirmation.
 * - **Shared rooms** show the memory switch. Their reply mode and
 *   instructions arrive with the shared room's own batch.
 *
 * A control nothing reads is not shown at all, so the section never offers a
 * choice that does nothing.
 *
 * Every control here is live. The reply mode's hint under the buttons says
 * what the chosen mode does to the next turn, and the mute list's hint says
 * what a mute does not do (an `@` or a composer pick still reaches the
 * member), because those are the two rules a reader would otherwise guess.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, Settings2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useImRoomReplyMode } from "@/hooks/connectors/use-im-room-reply-mode"
import { useImRoomTeam } from "@/hooks/connectors/use-im-room-team"
import { useClientLiveQuery } from "@/hooks/data"
import { roomKindOf } from "@/lib/chat/room/kind"
import {
  MAX_ROOM_INSTRUCTIONS_CHARS,
  ROOM_REPLY_MODES,
  ROOM_SQUAD_HANDOFF_MODES,
  resolveRoomSettings,
  roomSettingsPatch,
} from "@/lib/chat/room/settings"
import type { RoomKind, RoomReplyMode, RoomSettings } from "@/lib/chat/room/types"
import { getSession, updateSession } from "@/lib/db/sessions"
import { loggers } from "@cognia/logging"
import type { Character, ChatSession } from "@cognia/agent-config-types"

const log = loggers.ui

export type RoomSettingsControl =
  "replyMode" | "squadHandoff" | "instructions" | "memory" | "mutedMembers"

/** The controls each kind of room shows, in order. */
export const ROOM_SETTINGS_CONTROLS: Record<RoomKind, readonly RoomSettingsControl[]> = {
  team: ["replyMode", "squadHandoff", "instructions", "memory", "mutedMembers"],
  im: ["replyMode", "instructions", "memory", "mutedMembers"],
  shared: ["memory"],
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id]
}

/** One write path for every session-stored control, so the memory mirror can never be skipped. */
export function persistRoomSettings(
  sessionId: string,
  session: ChatSession | undefined,
  change: Partial<RoomSettings>
): void {
  void updateSession(sessionId, roomSettingsPatch(session?.roomSettings, change)).catch((err) => {
    log.error("room settings persist failed", err, { sessionId })
  })
}

export function RoomSettingsSection({
  sessionId,
  session,
  members: membersProp = [],
  defaultCollapsed = true,
  kind: kindProp,
}: {
  sessionId: string
  session: ChatSession | undefined
  /** The room's kind when the host already knows it (the team panel); read off the session otherwise. */
  kind?: RoomKind
  /** A team room's members, to name the muted ones. An IM room reads its own. */
  members?: readonly Character[]
  /** Collapsed with a one-line summary where a members list is the panel's point. */
  defaultCollapsed?: boolean
}) {
  const t = useTranslations("desktop.memberList")
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const resolved = useMemo(() => resolveRoomSettings(session), [session])
  const kind = kindProp ?? roomKindOf(session)
  const imReplyMode = useImRoomReplyMode(session)
  const imTeam = useImRoomTeam(session)
  const members = kind === "im" ? (imTeam?.members ?? []) : membersProp
  const controls = (kind ? ROOM_SETTINGS_CONTROLS[kind] : []).filter(
    // A plain IM group answers with one voice: there is nobody to mute.
    (control) => control !== "mutedMembers" || kind !== "im" || members.length > 0
  )

  // An IM room's reply mode is its conversation's policy; every other kind
  // keeps it on the session.
  const replyMode: RoomReplyMode | null = imReplyMode ? imReplyMode.mode : resolved.replyMode
  const setReplyMode = (mode: RoomReplyMode) => {
    if (imReplyMode) {
      void imReplyMode.setMode(mode).catch((err) => {
        log.error("room reply mode persist failed", err, { sessionId })
      })
      return
    }
    persistRoomSettings(sessionId, session, { replyMode: mode })
  }
  const replyModeHints =
    kind === "im" ? "roomSettings.imReplyModeHints" : "roomSettings.replyModeHints"

  const [draft, setDraft] = useState(resolved.instructions)
  const lastSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastSessionRef.current === sessionId) return
    lastSessionRef.current = sessionId
    setDraft(resolved.instructions)
  }, [sessionId, resolved.instructions])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) return
    if (draft === resolved.instructions) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      persistRoomSettings(sessionId, session, { instructions: draft })
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sessionId])

  if (controls.length === 0) return null

  const nameOf = (id: string) => members.find((member) => member.id === id)?.name ?? id
  const memoryLabel = t(resolved.memory ? "roomSettings.memoryOn" : "roomSettings.memoryOff")
  const summary =
    controls.includes("replyMode") && replyMode
      ? t("roomSettings.summary", {
          replyMode: t(`roomSettings.replyModes.${replyMode}`),
          memory: memoryLabel,
        })
      : memoryLabel

  return (
    <div className="shrink-0 border-b" data-testid="room-settings" data-room-kind={kind ?? ""}>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        data-testid="room-settings-toggle"
        className="h-8 w-full justify-start gap-1.5 rounded-none px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
        <Settings2Icon className="size-3 shrink-0" />
        <span className="truncate">{t("roomSettings.title")}</span>
        <span
          className="ml-auto min-w-0 truncate font-normal normal-case tracking-normal"
          data-testid="room-settings-summary"
        >
          {summary}
        </span>
      </Button>
      {collapsed ? null : (
        <div className="flex flex-col gap-3 px-3 pb-3 text-xs">
          {controls.includes("replyMode") ? (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("roomSettings.replyMode")}
              </span>
              <div
                className="flex flex-wrap gap-1"
                role="group"
                aria-label={t("roomSettings.replyMode")}
              >
                {ROOM_REPLY_MODES.map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    size="sm"
                    variant={replyMode === mode ? "secondary" : "outline"}
                    aria-pressed={replyMode === mode}
                    // Disabled until the conversation's policy is known, so a
                    // click never writes from a mode that was not on screen.
                    disabled={replyMode === null}
                    data-testid={`room-reply-mode-${mode}`}
                    onClick={() => setReplyMode(mode)}
                    className="h-7 px-2 text-xs"
                  >
                    {t(`roomSettings.replyModes.${mode}`)}
                  </Button>
                ))}
              </div>
              {replyMode ? (
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="room-settings-reply-mode-hint"
                >
                  {t(`${replyModeHints}.${replyMode}`)}
                </p>
              ) : null}
              {kind === "im" ? (
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="room-settings-reply-mode-im-note"
                >
                  {t("roomSettings.imReplyModeNote")}
                </p>
              ) : null}
            </div>
          ) : null}

          {controls.includes("squadHandoff") ? (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("roomSettings.squadHandoff")}
              </span>
              <div
                className="flex flex-wrap gap-1"
                role="group"
                aria-label={t("roomSettings.squadHandoff")}
              >
                {ROOM_SQUAD_HANDOFF_MODES.map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    size="sm"
                    variant={resolved.squadHandoff === mode ? "secondary" : "outline"}
                    aria-pressed={resolved.squadHandoff === mode}
                    data-testid={`room-squad-handoff-${mode}`}
                    onClick={() => persistRoomSettings(sessionId, session, { squadHandoff: mode })}
                    className="h-7 px-2 text-xs"
                  >
                    {t(`roomSettings.squadHandoffModes.${mode}`)}
                  </Button>
                ))}
              </div>
              <p
                className="text-[11px] text-muted-foreground"
                data-testid="room-settings-squad-handoff-hint"
              >
                {t(`roomSettings.squadHandoffHints.${resolved.squadHandoff}`)}
              </p>
            </div>
          ) : null}

          {controls.includes("instructions") ? (
            <div className="flex flex-col gap-1">
              <label
                htmlFor={`room-instructions-${sessionId}`}
                className="flex items-center text-[11px] font-medium text-muted-foreground"
              >
                <span className="truncate">{t("roomSettings.instructions")}</span>
                <span className="ml-auto shrink-0 font-normal tabular-nums">
                  {draft.length > 0 ? t("charsCount", { count: draft.length }) : ""}
                </span>
              </label>
              <Textarea
                id={`room-instructions-${sessionId}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                maxLength={MAX_ROOM_INSTRUCTIONS_CHARS}
                placeholder={t("roomSettings.instructionsPlaceholder")}
                data-testid="room-instructions"
                className="resize-y text-xs"
              />
            </div>
          ) : null}

          {controls.includes("memory") ? (
            <div className="flex items-start gap-2">
              <Switch
                id={`room-memory-${sessionId}`}
                checked={resolved.memory}
                onCheckedChange={(memory) => persistRoomSettings(sessionId, session, { memory })}
                aria-label={t("roomSettings.memory")}
                data-testid="room-memory-switch"
              />
              <label htmlFor={`room-memory-${sessionId}`} className="flex min-w-0 flex-col">
                <span className="text-xs font-medium">{t("roomSettings.memory")}</span>
                <span className="text-[11px] text-muted-foreground">
                  {t(resolved.memory ? "roomSettings.memoryHint" : "roomSettings.memoryOffHint")}
                </span>
              </label>
            </div>
          ) : null}

          {controls.includes("mutedMembers") ? (
            <div className="flex flex-col gap-1" data-testid="room-muted-members">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("roomSettings.mutedMembers")}
              </span>
              {kind === "im" ? (
                // An IM room has no roster panel to mute from, so every member
                // is a toggle here.
                <div
                  className="flex flex-wrap gap-1"
                  role="group"
                  aria-label={t("roomSettings.mutedMembers")}
                >
                  {members.map((member) => {
                    const muted = resolved.mutedMemberIds.includes(member.id)
                    return (
                      <Button
                        key={member.id}
                        type="button"
                        size="sm"
                        variant={muted ? "secondary" : "outline"}
                        aria-pressed={muted}
                        data-testid={`room-mute-toggle-${member.id}`}
                        title={t(muted ? "roomSettings.unmute" : "roomSettings.mute", {
                          name: member.name,
                        })}
                        onClick={() =>
                          persistRoomSettings(sessionId, session, {
                            mutedMemberIds: toggleId(resolved.mutedMemberIds, member.id),
                          })
                        }
                        className="h-6 px-2 text-[11px]"
                      >
                        {member.name}
                      </Button>
                    )
                  })}
                </div>
              ) : resolved.mutedMemberIds.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t("roomSettings.noMuted")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1">
                  {resolved.mutedMemberIds.map((id) => (
                    <li key={id}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`room-unmute-${id}`}
                        title={t("roomSettings.unmute", { name: nameOf(id) })}
                        aria-label={t("roomSettings.unmute", { name: nameOf(id) })}
                        onClick={() =>
                          persistRoomSettings(sessionId, session, {
                            mutedMemberIds: toggleId(resolved.mutedMemberIds, id),
                          })
                        }
                        className="h-6 px-2 text-[11px]"
                      >
                        {nameOf(id)}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-foreground" data-testid="room-muted-hint">
                {t(kind === "im" ? "roomSettings.imMutedHint" : "roomSettings.mutedHint")}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * The room panel of an IM or shared room: the room's settings, open. A team
 * room's panel is the members list (`team-members-panel.tsx`), which carries
 * the same section collapsed above its roster.
 */
export function RoomSettingsPanel({ sessionId }: { sessionId: string | null }) {
  const t = useTranslations("desktop.memberList")
  const session = useClientLiveQuery<ChatSession | undefined>(
    () => (sessionId ? getSession(sessionId) : Promise.resolve(undefined)),
    [sessionId],
    undefined
  )
  if (!sessionId || !roomKindOf(session)) {
    return (
      <Empty className="h-full rounded-none" data-testid="room-settings-panel-empty">
        <EmptyMedia variant="icon">
          <Settings2Icon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("roomSettings.title")}</EmptyTitle>
        <EmptyDescription className="text-xs">{t("roomSettings.noRoom")}</EmptyDescription>
      </Empty>
    )
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="room-settings-panel">
      <RoomSettingsSection sessionId={sessionId} session={session} defaultCollapsed={false} />
    </div>
  )
}
