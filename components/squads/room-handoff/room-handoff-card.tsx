"use client"

/**
 * A room member's proposal to hand work to a Squad (ADR-0252 §4), drawn in
 * place of its `room_handoff_to_squad` tool call, where the member proposed
 * it. The same card on the Host and on a paired device: a person picks the
 * Squad, confirms or declines, and once the Squad runs, follows it, steers it
 * and stops it here.
 *
 * The decision is read from the member's reply (`metadata.squadHandoffs`),
 * which the room's runner writes and the sync mirror brings to a phone; an
 * `auto` room's decision is in the call's own output too. The run is
 * live-queried, so the card stays true after a reload.
 */

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import type { UIMessage } from "ai"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SquadRunPart } from "@/components/chat/message-parts/squad-run-part"
import { useHostProfile } from "@/hooks/use-host-profile"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { dispatchRunControl } from "@/lib/execution/run-control-dispatch"
import type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"
import { requestRoomSquadHandoffDecision } from "@/lib/squads/room-handoff/decide-client"
import {
  decisionFromOutput,
  handoffDecisionOf,
  parseRoomHandoffArgs,
  parseRoomHandoffOutput,
} from "@/lib/squads/room-handoff/proposal"
import { useChatStore } from "@/stores/chat"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import type {
  RoomSquadHandoffDecideRefusal,
  RoomSquadHandoffDecision,
} from "@/types/squads/room-handoff"

const EMPTY_MESSAGES: readonly UIMessage[] = []

/** The decision the room holds for this call: the reply's, else an `auto` call's own. */
function useHandoffDecision(
  sessionId: string | undefined,
  toolUseId: string,
  output: ReturnType<typeof parseRoomHandoffOutput>
): RoomSquadHandoffDecision | undefined {
  const messages = useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  return useMemo(() => {
    const reply = messages.find((message) =>
      message.parts.some((part) => (part as { toolCallId?: unknown }).toolCallId === toolUseId)
    )
    return (reply && handoffDecisionOf(reply, toolUseId)) ?? decisionFromOutput(output)
  }, [messages, toolUseId, output])
}

export function RoomHandoffCard({ part, sessionId }: ToolResultRendererProps) {
  const t = useTranslations("squads.roomHandoff")
  const toolUseId = part.toolCallId
  const output = useMemo(() => parseRoomHandoffOutput(part.output), [part.output])
  const args = useMemo(() => parseRoomHandoffArgs(part.input), [part.input])
  const decision = useHandoffDecision(sessionId, toolUseId, output)
  const brief = output?.brief ?? (args.ok ? args.args.brief : "")
  if (!output || !brief) return null

  return (
    <section
      aria-label={t("title")}
      className="space-y-2 rounded-lg border border-transparent bg-muted/50 p-3 text-sm"
      data-testid="room-handoff-card"
    >
      <h4 className="font-medium">{t("title")}</h4>
      <p className="whitespace-pre-wrap break-words" data-testid="room-handoff-brief">
        {brief}
      </p>
      {decision ? (
        <DecidedHandoff decision={decision} brief={brief} />
      ) : output.status === "refused" ? (
        <p className="text-xs text-destructive" data-testid="room-handoff-refused">
          {t("refused", { reason: output.reason })}
        </p>
      ) : sessionId ? (
        <PendingHandoff roomId={sessionId} toolUseId={toolUseId} proposedSquadId={output.squadId} />
      ) : null}
    </section>
  )
}

function PendingHandoff({
  roomId,
  toolUseId,
  proposedSquadId,
}: {
  roomId: string
  toolUseId: string
  proposedSquadId?: string
}) {
  const t = useTranslations("squads.roomHandoff")
  const teams = useAgentTeamStore((s) => s.teams)
  const squads = useMemo(
    () =>
      Object.values(teams)
        .map((team) => ({ id: team.id, name: team.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [teams]
  )
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const squadId =
    picked ?? (squads.some((s) => s.id === proposedSquadId) ? proposedSquadId : undefined)
  const [busy, setBusy] = useState(false)
  // The ref is the guard: a double-click lands before the re-render.
  const busyRef = useRef(false)
  const [refusal, setRefusal] = useState<RoomSquadHandoffDecideRefusal | "failed" | null>(null)

  const decide = async (decision: "confirm" | "decline") => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setRefusal(null)
    try {
      const result = await requestRoomSquadHandoffDecision({
        roomId,
        toolUseId,
        decision,
        ...(decision === "confirm" && squadId ? { squadId } : {}),
      })
      if (!result.ok) setRefusal(result.reason)
    } catch {
      setRefusal("failed")
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {squads.length > 0 ? (
        <Select value={squadId} onValueChange={setPicked} disabled={busy}>
          <SelectTrigger
            className="h-8 w-full text-xs"
            aria-label={t("squadLabel")}
            data-testid="room-handoff-squad"
          >
            <SelectValue placeholder={t("squadPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {squads.map((squad) => (
              <SelectItem key={squad.id} value={squad.id}>
                {squad.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-xs text-muted-foreground">{t("noSquads")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("gatesNote")}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void decide("confirm")}
          disabled={busy || !squadId}
          data-testid="room-handoff-confirm"
        >
          {t("confirm")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void decide("decline")}
          disabled={busy}
          data-testid="room-handoff-decline"
        >
          {t("decline")}
        </Button>
      </div>
      {refusal ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`refusal.${refusal}`)}
        </p>
      ) : null}
    </div>
  )
}

function DecidedHandoff({
  decision,
  brief,
}: {
  decision: RoomSquadHandoffDecision
  brief: string
}) {
  const t = useTranslations("squads.roomHandoff")
  const by = t(`decidedBy.${decision.decidedBy.kind}`)
  if (decision.status === "declined") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="room-handoff-declined">
        {t("declined", { by })}
      </p>
    )
  }
  if (decision.status === "failed") {
    return (
      <p className="text-xs text-destructive" data-testid="room-handoff-failed">
        {t("failedToStart", { reason: decision.reason })}
      </p>
    )
  }
  return (
    <div className="space-y-2" data-testid="room-handoff-started">
      <p className="text-xs text-muted-foreground">
        {t("started", { squad: decision.squadName, by })}
      </p>
      <SquadRunPart
        part={{
          type: "squad-run",
          runId: decision.squadRunId,
          squadId: decision.squadId,
          squadName: decision.squadName,
          objective: brief,
        }}
      />
      <HandoffControls delegationRunId={decision.delegationRunId} />
    </div>
  )
}

/** Steer and stop the hand-off through its delegation, which forwards to the Squad run. */
function HandoffControls({ delegationRunId }: { delegationRunId: string }) {
  const t = useTranslations("squads.roomHandoff")
  const hostProfile = useHostProfile()
  const run = useLiveQuery(() => getExecutionRun(delegationRunId), [delegationRunId], undefined)
  const allowed = run?.latestSnapshot?.allowedActions ?? []
  const [steer, setSteer] = useState("")
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const steerSequence = useRef(0)
  const [failed, setFailed] = useState<"steer" | "stop" | null>(null)
  const canSteer = allowed.includes("steer")
  const canStop = allowed.includes("stop")
  if (!canSteer && !canStop) return null

  const control = async (action: "steer" | "stop") => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setFailed(null)
    try {
      if (action === "steer") steerSequence.current += 1
      const outcome = await dispatchRunControl({
        runId: delegationRunId,
        action,
        surface: "room-handoff",
        hostProfile,
        ...(action === "steer"
          ? { steerMessage: steer.trim(), steerSequence: steerSequence.current }
          : {}),
      })
      if (!outcome.accepted) setFailed(action)
      else if (action === "steer") setSteer("")
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {canSteer ? (
        <div className="flex items-end gap-2">
          <Textarea
            value={steer}
            onChange={(event) => setSteer(event.target.value)}
            placeholder={t("steerPlaceholder")}
            aria-label={t("steerLabel")}
            className="min-h-8 text-xs"
            rows={1}
            disabled={busy}
            data-testid="room-handoff-steer-input"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void control("steer")}
            disabled={busy || !steer.trim()}
            data-testid="room-handoff-steer"
          >
            {t("steer")}
          </Button>
        </div>
      ) : null}
      {canStop ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void control("stop")}
          disabled={busy}
          data-testid="room-handoff-stop"
        >
          {t("stop")}
        </Button>
      ) : null}
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`controlFailed.${failed}`)}
        </p>
      ) : null}
    </div>
  )
}
