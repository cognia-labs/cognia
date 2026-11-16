"use client"

// Renders the divider the SDK emits when it compacts the conversation context
// (manual `/compact` or the automatic threshold). The adapter
// (`lib/claude/adapter.ts:appendCompactBoundary`) projects the SDK
// `compact_boundary` system message into a `system`-role UIMessage carrying a
// single `compact-boundary` part; the message list swaps this marker in for
// the normal `MessageRenderer` so it shows no avatar / actions / usage chrome.
//
// When the generic-path compaction captured an undo snapshot, an "Undo" action
// is offered while the snapshot is still live (in-memory, this session only).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ImageIcon, ScissorsIcon, Undo2Icon } from "lucide-react"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import { useChatStore } from "@/stores/chat"
import { restoreSession } from "@/lib/ai/agent/execution/sidecar-client"
import { getUndoSnapshot, hasUndoSnapshot, clearUndoSnapshot } from "@/lib/claude/compaction-undo"
import { OpticalArchiveDialog } from "./optical-archive-dialog"
import {
  computeCompactionTokenDeltas,
  deriveContextPhases,
  indexDeltasByBoundary,
} from "@/lib/usage/compaction-metrics"

const compactNum = new Intl.NumberFormat("en-US", { notation: "compact" })

interface BoundaryMetric {
  turnLabel: number
  effectiveness: number
}

const NO_MESSAGES: UIMessage[] = []

/**
 * Turn label and effectiveness of every boundary in one transcript, computed
 * once per transcript array. Every marker in the list reads the same entry, so
 * N markers walk the transcript once per frame, not N times.
 */
const metricsByTranscript = new WeakMap<UIMessage[], Map<string, BoundaryMetric>>()

function boundaryMetrics(messages: UIMessage[]): Map<string, BoundaryMetric> {
  const cached = metricsByTranscript.get(messages)
  if (cached) return cached
  const deltas = indexDeltasByBoundary(computeCompactionTokenDeltas(messages))
  const metrics = new Map<string, BoundaryMetric>()
  for (const phase of deriveContextPhases(messages)) {
    // The first phase a boundary opens is the one its label names.
    if (!phase.boundaryId || metrics.has(phase.boundaryId)) continue
    metrics.set(phase.boundaryId, {
      turnLabel: phase.turnLabel,
      effectiveness: deltas.get(phase.boundaryId)?.effectiveness ?? 0,
    })
  }
  for (const [boundaryId, delta] of deltas) {
    if (!metrics.has(boundaryId)) {
      metrics.set(boundaryId, { turnLabel: 0, effectiveness: delta.effectiveness ?? 0 })
    }
  }
  metricsByTranscript.set(messages, metrics)
  return metrics
}

export interface CompactBoundaryPartData {
  type: "compact-boundary"
  trigger?: string
  preTokens?: number
  postTokens?: number
  strategy?: string
  /** Present when a live undo snapshot exists for this boundary. */
  undoToken?: string
  /** Present when the "optical" strategy archived this boundary (ADR-0063). */
  opticalArchiveId?: string
  /** Number of image frames in the optical archive. */
  opticalFrameCount?: number
  /** True when the optical strategy fell back to a text summary this boundary. */
  opticalFallback?: boolean
  checkpointId?: string
  checkpointState?: "stored" | "locked" | "failed"
}

/** True when a message is the synthetic compact-boundary marker. */
export function isCompactBoundaryMessage(message: UIMessage): boolean {
  return (
    message.role === "system" &&
    message.parts.length === 1 &&
    (message.parts[0] as { type?: string }).type === "compact-boundary"
  )
}

export function CompactBoundaryMarker({ message }: { message: UIMessage }) {
  const t = useTranslations("chat.compactBoundary")
  const tc = useTranslations("chat.compaction")
  const part = message.parts[0] as unknown as CompactBoundaryPartData
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const replaceMessages = useChatStore((s) => s.replaceMessages)
  // The marker's own conversation, which in a split pane or the dock is not
  // the focused one.
  const ownSessionId = (message.metadata as { sessionId?: unknown } | undefined)?.sessionId
  const messages = useChatStore((s) =>
    typeof ownSessionId === "string" && ownSessionId !== s.activeSessionId
      ? (s.sessions[ownSessionId]?.messages ?? NO_MESSAGES)
      : s.messages
  )
  const [undoing, setUndoing] = useState(false)
  const [viewingFrames, setViewingFrames] = useState(false)

  // Turn label + effectiveness for THIS boundary, derived from the transcript.
  const metric = boundaryMetrics(messages).get(message.id)

  const detail =
    part.preTokens !== undefined && part.postTokens !== undefined
      ? t("detail", {
          from: compactNum.format(part.preTokens),
          to: compactNum.format(part.postTokens),
        })
      : part.trigger === "manual"
        ? t("manual")
        : t("auto")

  // "context reset at turn N" + "reclaimed X%" when we could derive the metric.
  const phaseLabel = metric ? t("phase", { turn: metric.turnLabel }) : null
  const effectivenessLabel =
    metric && metric.effectiveness > 0
      ? t("effectiveness", { pct: Math.round(metric.effectiveness * 100) })
      : null

  const canUndo = !!part.undoToken && hasUndoSnapshot(part.undoToken) && !!activeSessionId

  const onUndo = async () => {
    if (!part.undoToken || !activeSessionId) return
    const entry = getUndoSnapshot(part.undoToken)
    if (!entry) return
    setUndoing(true)
    try {
      await restoreSession(activeSessionId, entry.snapshot)
      clearUndoSnapshot(part.undoToken)
      // Drop this boundary marker from the visible transcript.
      const remaining = useChatStore.getState().messages.filter((m) => m.id !== message.id)
      replaceMessages(remaining)
      toast.success(tc("undoSuccess"))
    } catch {
      toast.error(tc("undoFailed"))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div
      className="my-3 flex items-center gap-2 px-1 text-xs text-muted-foreground"
      data-testid="compact-boundary"
      role="separator"
      aria-label={t("label")}
    >
      <div className="h-px flex-1 bg-border" />
      <ScissorsIcon className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">{t("label")}</span>
      <span className="min-w-0 truncate text-muted-foreground/70" title={detail}>
        · {detail}
      </span>
      {phaseLabel && (
        <span className="shrink-0 text-muted-foreground/70" data-testid="compact-phase">
          · {phaseLabel}
        </span>
      )}
      {effectivenessLabel && (
        <span className="shrink-0 text-muted-foreground/70" data-testid="compact-effectiveness">
          · {effectivenessLabel}
        </span>
      )}
      {part.checkpointState && (
        <span className="shrink-0 text-muted-foreground/70" data-testid="compact-checkpoint-state">
          · {t(`checkpoint.${part.checkpointState}`)}
        </span>
      )}
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          data-testid="compact-undo"
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
        >
          <Undo2Icon className="size-3" aria-hidden />
          {tc("undo")}
        </button>
      )}
      {part.opticalArchiveId && (
        <button
          type="button"
          onClick={() => setViewingFrames(true)}
          data-testid="compact-view-frames"
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ImageIcon className="size-3" aria-hidden />
          {t("viewFrames")}
        </button>
      )}
      <div className="h-px flex-1 bg-border" />
      {part.opticalArchiveId && (
        <OpticalArchiveDialog
          archiveId={part.opticalArchiveId}
          open={viewingFrames}
          onOpenChange={setViewingFrames}
        />
      )}
    </div>
  )
}
