"use client"

/**
 * subagent-runtime-store — Phase 6 of the ClaudeCode 完整化 plan.
 *
 * Two slices in one Zustand store:
 *
 *  - `subAgentTemplates` — persisted to localStorage. Seed = the eight
 *    `BUILT_IN_SUBAGENT_TEMPLATES` from `types/agent/sub-agent.ts`. Users
 *    fork built-ins (which mints a new id with `isBuiltIn: false`) or
 *    create from scratch. Built-ins are read-only — `updateTemplate` and
 *    `deleteTemplate` refuse on `isBuiltIn: true`.
 *
 *  - `subAgents` — a read model of subagent runs, not persisted. Live
 *    progress (logs, tool calls, streamed text, usage, the result detail)
 *    comes from the two engines' events: `lib/claude/agents/dispatch-runtime.ts`
 *    for `dispatch_agent` and `lib/claude/sdk-subagent-bridge.ts` for the SDK
 *    `Task` tool. The status of a run that has an `execution:job:<id>` row is
 *    that row's (ADR-0252 §2), kept in `runs` by the run projection
 *    (`./run-projection.ts`): what an engine reports stands only for an entry
 *    with no run row (an in-turn SDK `Task`, a dispatch refused before it
 *    started). Consumers subscribe to read: the chat-side `SubagentPart` tree
 *    (via `subagent-bridge` → `use-claude-chat`) and the Settings Runtime tab.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { ExecutionRunStatus } from "@cognia/plugin-contract/types/execution/run"
import {
  BUILT_IN_SUBAGENT_TEMPLATES,
  assertSubagentContextPolicy,
  type SubAgent,
  type SubAgentLog,
  type SubAgentStatus,
  type SubAgentTemplate,
  type SubAgentTokenUsage,
  type SubAgentToolCall,
} from "@/types/agent/sub-agent"

/** Cap on the live tool-call list retained per run (most recent kept). */
const MAX_SUBAGENT_TOOL_CALLS = 100

interface TemplatesSlice {
  templates: Record<string, SubAgentTemplate>
  addTemplate: (t: SubAgentTemplate) => void
  updateTemplate: (id: string, patch: Partial<SubAgentTemplate>) => void
  deleteTemplate: (id: string) => void
}

/** What the run projection reads off an entry's `execution:job:<id>` row. */
export interface SubAgentRunState {
  status: ExecutionRunStatus
  endedAt?: number
}

/**
 * An entry with its run's status, when it has a run row. `timeout` survives a
 * `failed` run (the row has no timeout status; the engine knows why it ended).
 */
export function withRunStatus(entry: SubAgent, run: SubAgentRunState | undefined): SubAgent {
  if (!run) return entry
  const status = subAgentStatusOf(run.status, entry.status)
  const ended =
    status === "completed" || status === "failed" || status === "cancelled" || status === "timeout"
  const completedAt = ended
    ? (entry.completedAt ?? (run.endedAt !== undefined ? new Date(run.endedAt) : new Date()))
    : undefined
  if (status === entry.status && completedAt === entry.completedAt) return entry
  return { ...entry, status, ...(ended ? { completedAt } : { completedAt: undefined }) }
}

/**
 * A run row's status in subagent words. `reported` is the engine's own
 * status, which only tells a timeout from another failure.
 */
export function subAgentStatusOf(
  run: ExecutionRunStatus,
  reported: SubAgentStatus
): SubAgentStatus {
  switch (run) {
    case "queued":
      return "queued"
    case "running":
      return "running"
    case "waiting":
    case "paused":
    case "recovery_required":
      return "waiting"
    case "completed":
      return "completed"
    case "failed":
      return reported === "timeout" ? "timeout" : "failed"
    case "cancelled":
      return "cancelled"
  }
}

interface RuntimeSlice {
  subAgents: Record<string, SubAgent>
  /** Run status by entry id, for entries that have a run row (the projection's). */
  runs: Record<string, SubAgentRunState>
  /** The run projection's write: record each id's run row and re-derive its entry. */
  applyRuns: (runs: Record<string, SubAgentRunState | undefined>) => void
  upsert: (subAgent: SubAgent) => void
  setStatus: (id: string, status: SubAgentStatus) => void
  setProgress: (id: string, progress: number) => void
  setToolUses: (id: string, toolUses: number) => void
  appendLog: (id: string, log: SubAgentLog) => void
  /**
   * Apply log + progress + toolUses for a single run event in ONE store write
   * (one map spread, one subscriber notification) instead of 3 separate
   * mutators. The hot path is `dispatch-runtime`'s tool-call event sink.
   */
  applyRunEvent: (
    id: string,
    patch: {
      log?: SubAgentLog
      progress?: number
      toolUses?: number
      /** Push a freshly-started tool call (state "running"). */
      toolStart?: { id: string; name: string; input?: Record<string, unknown> }
      /** Resolve a previously-started tool call by id (output / error). */
      toolEnd?: { id: string; output?: unknown; isError?: boolean }
      /** Replace the live cumulative token usage (dispatch run tracker). */
      usage?: SubAgentTokenUsage
      /** Record a transient-failure retry (bumps `retryCount`). */
      retry?: { attempt: number }
    }
  ) => void
  pushStreamText: (id: string, text: string) => void
  remove: (id: string) => void
  clearRuntime: () => void
}

export type SubagentRuntimeState = TemplatesSlice & RuntimeSlice

/** Seed = built-in templates keyed by id. */
function seedTemplates(): Record<string, SubAgentTemplate> {
  const out: Record<string, SubAgentTemplate> = {}
  for (const t of BUILT_IN_SUBAGENT_TEMPLATES) out[t.id] = t
  return out
}

export const useSubagentRuntimeStore = create<SubagentRuntimeState>()(
  persist(
    (set) => ({
      // ---- Templates --------------------------------------------------
      templates: seedTemplates(),
      addTemplate: (t) => {
        assertSubagentContextPolicy(t.config)
        set((s) => ({
          templates: { ...s.templates, [t.id]: t },
        }))
      },
      updateTemplate: (id, patch) =>
        set((s) => {
          const existing = s.templates[id]
          if (!existing || existing.isBuiltIn) return s
          const next = { ...existing, ...patch }
          assertSubagentContextPolicy(next.config)
          return { templates: { ...s.templates, [id]: next } }
        }),
      deleteTemplate: (id) =>
        set((s) => {
          const existing = s.templates[id]
          if (!existing || existing.isBuiltIn) return s
          const next = { ...s.templates }
          delete next[id]
          return { templates: next }
        }),

      // ---- Runtime (ephemeral) ----------------------------------------
      subAgents: {},
      runs: {},
      applyRuns: (runs) =>
        set((s) => {
          let changed = false
          const nextRuns = { ...s.runs }
          const nextAgents = { ...s.subAgents }
          for (const [id, run] of Object.entries(runs)) {
            const before = s.runs[id]
            if (run) {
              if (before?.status !== run.status || before?.endedAt !== run.endedAt) {
                nextRuns[id] = run
                changed = true
              }
            } else if (before) {
              delete nextRuns[id]
              changed = true
            }
            const sa = s.subAgents[id]
            if (sa && run) {
              const derived = withRunStatus(sa, run)
              if (derived !== sa) {
                nextAgents[id] = derived
                changed = true
              }
            }
          }
          return changed ? { runs: nextRuns, subAgents: nextAgents } : s
        }),
      // An engine's status stands only until the run row says otherwise.
      upsert: (subAgent) => {
        set((s) => ({
          subAgents: {
            ...s.subAgents,
            [subAgent.id]: withRunStatus(subAgent, s.runs[subAgent.id]),
          },
        }))
        void import("./run-projection")
          .then(({ ensureSubagentRunProjection }) =>
            ensureSubagentRunProjection(useSubagentRuntimeStore)
          )
          .catch(() => undefined)
      },
      setStatus: (id, status) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          const completedAt =
            status === "completed" || status === "failed" || status === "cancelled"
              ? new Date()
              : sa.completedAt
          return {
            subAgents: {
              ...s.subAgents,
              [id]: withRunStatus({ ...sa, status, completedAt }, s.runs[id]),
            },
          }
        }),
      setProgress: (id, progress) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          const clamped = Math.max(0, Math.min(100, progress))
          return { subAgents: { ...s.subAgents, [id]: { ...sa, progress: clamped } } }
        }),
      setToolUses: (id, toolUses) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          // Monotonic, honest tool-call count (never negative). Drives the
          // chat SubagentPart "N tools" counter.
          const count = Math.max(0, Math.floor(toolUses))
          return { subAgents: { ...s.subAgents, [id]: { ...sa, toolUses: count } } }
        }),
      appendLog: (id, log) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          return {
            subAgents: {
              ...s.subAgents,
              [id]: { ...sa, logs: [...sa.logs, log].slice(-50), lastActivityAt: new Date() },
            },
          }
        }),
      applyRunEvent: (id, patch) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          // Apply the same caps/clamps the single mutators use, but in one pass.
          const next: SubAgent = { ...sa }
          let changed = false
          if (patch.log) {
            next.logs = [...sa.logs, patch.log].slice(-50)
            next.lastActivityAt = new Date()
            changed = true
          }
          if (typeof patch.progress === "number") {
            next.progress = Math.max(0, Math.min(100, patch.progress))
            changed = true
          }
          if (typeof patch.toolUses === "number") {
            next.toolUses = Math.max(0, Math.floor(patch.toolUses))
            changed = true
          }
          if (patch.toolStart) {
            const call: SubAgentToolCall = {
              id: patch.toolStart.id,
              name: patch.toolStart.name,
              state: "running",
              ...(patch.toolStart.input ? { input: patch.toolStart.input } : {}),
            }
            next.toolCalls = [...(sa.toolCalls ?? []), call].slice(-MAX_SUBAGENT_TOOL_CALLS)
            changed = true
          }
          if (patch.usage) {
            next.tokenUsage = patch.usage
            next.lastActivityAt = new Date()
            changed = true
          }
          if (patch.retry) {
            next.retryCount = Math.max(0, Math.floor(patch.retry.attempt))
            changed = true
          }
          if (patch.toolEnd) {
            const { id: callId, output, isError } = patch.toolEnd
            const calls = next.toolCalls ?? sa.toolCalls ?? []
            // Resolve the most recent running call with this id.
            let resolved = false
            const updated = calls
              .slice()
              .reverse()
              .map((c) => {
                if (!resolved && c.id === callId) {
                  resolved = true
                  return {
                    ...c,
                    state: isError ? ("error" as const) : ("done" as const),
                    ...(output !== undefined ? { output } : {}),
                    ...(isError ? { isError: true } : {}),
                  }
                }
                return c
              })
              .reverse()
            if (resolved) {
              next.toolCalls = updated
              changed = true
            }
          }
          if (!changed) return s
          return { subAgents: { ...s.subAgents, [id]: next } }
        }),
      // Coalesce a growing streaming-text line into ONE log entry (marked
      // `data.stream === "text"`): replace a trailing stream-text entry, else
      // append a fresh one. Keeps live token streaming from flooding the cap.
      pushStreamText: (id, text) =>
        set((s) => {
          const sa = s.subAgents[id]
          if (!sa) return s
          const logs = sa.logs.slice()
          const last = logs[logs.length - 1]
          const entry: SubAgentLog = {
            timestamp: new Date(),
            level: "info",
            message: text,
            data: { stream: "text" },
          }
          const isStreamText =
            !!last &&
            typeof last.data === "object" &&
            last.data !== null &&
            (last.data as { stream?: unknown }).stream === "text"
          if (isStreamText) logs[logs.length - 1] = entry
          else logs.push(entry)
          return {
            subAgents: {
              ...s.subAgents,
              [id]: { ...sa, logs: logs.slice(-50), lastActivityAt: new Date() },
            },
          }
        }),
      remove: (id) =>
        set((s) => {
          if (!s.subAgents[id]) return s
          const next = { ...s.subAgents }
          delete next[id]
          const runs = { ...s.runs }
          delete runs[id]
          return { subAgents: next, runs }
        }),
      clearRuntime: () => set({ subAgents: {}, runs: {} }),
    }),
    {
      name: "cognia.subagent-runtime",
      storage: persistLocalStorage(),
      // Only persist templates; runtime data is ephemeral by design.
      partialize: (state) => ({ templates: state.templates }) as Partial<SubagentRuntimeState>,
      // On rehydrate, re-seed any missing built-ins so a contributor
      // upgrading mid-version still gets fresh templates.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<SubagentRuntimeState>) }
        for (const t of BUILT_IN_SUBAGENT_TEMPLATES) {
          if (!merged.templates[t.id]) merged.templates = { ...merged.templates, [t.id]: t }
        }
        return merged
      },
    }
  )
)
