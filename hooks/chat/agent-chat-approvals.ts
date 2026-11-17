"use client"

import type React from "react"
import { isComputerUsePluginToolName } from "./agent-chat-tool-hooks"
import { type SendFn } from "./agent-chat-turn-tasks"

import { deriveAllowRuleFromApproval } from "@/lib/ai/agent/execution/permissions/approval-rule"
import { setToolRule } from "@/lib/ai/agent/execution/permissions/ruleset-edit"
import { approveTool } from "@/lib/ai/agent/execution/sidecar-client"
import { denialMessageForModel, denialReasonOf } from "@/lib/chat/approval-routing"
import { recordChatCanonicalEvents } from "@/lib/chat/canonical-sink"
import { authorizeSharedSessionApproval } from "@/lib/collab/shared-run-coordinator"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { recordChatToolApprovalDecision } from "@/lib/policy/action-review/chat-tool-channel"
import { type useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import {
  type ApprovalDecision,
  type ApprovalResponseOptions,
  type PendingApproval,
} from "@cognia/agent-config-types"

/** What answering a tool approval reads from the chat controller (`useAgentChat`). */
export interface AgentChatApprovalContext {
  store: typeof useChatStore
  sendRef: React.RefObject<SendFn | null>
  getExecutionHandle: (
    sessionId: string
  ) => import("@/lib/ai/agent/execution/agent-execution-handle").AgentExecutionHandle | undefined
}

/**
 * Answers a pending tool approval for a chat turn: authorizes it for a shared
 * session, records the decision (and an always-allow rule when asked), and
 * hands it to the runtime that asked — the sidecar, an external agent's
 * execution handle or the Host. `useAgentChat().respondToApproval` and the
 * approval bridge both land here.
 */
export async function respondToChatApproval(
  ctx: AgentChatApprovalContext,
  approval: PendingApproval,
  decision: ApprovalDecision,
  options?: ApprovalResponseOptions
): Promise<void> {
  const { store, sendRef, getExecutionHandle } = ctx

  if (approval.suppressAlwaysAllowRule && decision === "allow_always") decision = "allow"
  const authorized = await authorizeSharedSessionApproval(approval, decision)
  if (authorized === null) return
  decision =
    approval.suppressAlwaysAllowRule && authorized === "allow_always" ? "allow" : authorized
  // A deny's reason ("not that — back it up instead"). Runtimes whose
  // refusal carries text get it as the denied call's result; the rest get
  // it as a follow-up to the same turn, right behind the refusal, so the
  // one answer still redirects the work on every lane.
  const denialReason = denialReasonOf(decision, options)
  // ADR-0239: an allow on an outbound ask rests on a grant, this one call
  // or ("allow for this request") the rest of the requester's instruction.
  const outboundGrant =
    approval.outbound && decision !== "deny"
      ? (await import("@/lib/policy/action-review/plan-tool-call")).humanOutboundGrant(
          options?.forRequest,
          approval.outbound
        )
      : undefined
  const followDenialWithReason = () => {
    if (!denialReason) return
    void sendRef
      .current?.(denialReason, undefined, { sessionId: approval.sessionId })
      .catch(() => undefined)
  }
  {
    const { RENDERER_TOOL_HOST_APPROVAL_PREFIX } =
      await import("@/lib/ai/agent/external/session/renderer-tool-host")
    if (approval.requestId.startsWith(RENDERER_TOOL_HOST_APPROVAL_PREFIX)) {
      const { resolveApproval, grantSessionBypass } =
        await import("@/lib/ai/agent/execution/hitl/approval-registry")
      if (decision === "allow_always") grantSessionBypass(approval.sessionId, approval.toolName)
      resolveApproval(approval.sessionId, approval.requestId, { decision })
      await recordChatToolApprovalDecision(approval, decision, outboundGrant)
      store.getState().clearApproval(approval.requestId, approval.sessionId)
      followDenialWithReason()
      return
    }
  }
  // Built-in-skill desktop consent (W2 dual-channel HITL): synthetic
  // approvals are resolved IN-RENDERER via the approval registry — there
  // is no sidecar-side permission waiting, so `approveTool` must never
  // see these request ids. "Always allow" maps to a session-scoped
  // bypass (skills are renderer-side; the sidecar ruleset doesn't apply).
  {
    const { isBuiltInSkillApprovalRequestId, grantDesktopSkillSessionBypass } =
      await import("@/lib/skills/built-in/desktop-hitl")
    if (isBuiltInSkillApprovalRequestId(approval.requestId)) {
      if (decision === "allow_always") {
        grantDesktopSkillSessionBypass(approval.sessionId, approval.toolName)
      }
      const { resolveApproval } = await import("@/lib/ai/agent/execution/hitl/approval-registry")
      resolveApproval(approval.sessionId, approval.requestId, {
        decision: decision === "deny" ? "deny" : "allow",
      })
      store.getState().clearApproval(approval.requestId, approval.sessionId)
      followDenialWithReason()
      return
    }
  }
  // Realtime voice tool approvals — same in-renderer contract as the
  // built-in-skill branch above: there is no sidecar-side waiter, so these
  // ids must never reach `approveTool`. "Always allow" writes an explicit
  // `toolRules` entry rather than falling through to `alwaysAllowTools`,
  // because `deriveAllowRuleFromApproval` returns null for plugin tools and
  // that bare list is only consulted by the sidecar — the voice session
  // would have kept asking forever.
  // Asked of the `speech` port (ADR-0250 §14); without one, no live voice
  // session exists to have asked.
  {
    const { loadPort } = await import("@/lib/modules/ports")
    const speech = await loadPort("speech")
    if (speech?.live.isToolApprovalRequest(approval.requestId)) {
      if (decision === "allow_always") {
        const settingsState = useSettingsStore.getState()
        const ap = settingsState.settings?.agentPermissions ?? {}
        const nextRules = speech.live.allowToolAlways(
          approval.sessionId,
          approval.toolName,
          ap.toolRules
        )
        await settingsState.save({ agentPermissions: { ...ap, toolRules: nextRules } })
      }
      const { resolveApproval } = await import("@/lib/ai/agent/execution/hitl/approval-registry")
      resolveApproval(approval.sessionId, approval.requestId, {
        decision: decision === "deny" ? "deny" : "allow",
      })
      store.getState().clearApproval(approval.requestId, approval.sessionId)
      followDenialWithReason()
      return
    }
  }
  // External agent approvals. Same in-renderer contract as the two
  // branches above: there is no sidecar-side waiter, so these ids must
  // never reach `approveTool`. The answer goes to the adapter that asked,
  // addressed by the agent + session recorded when the request arrived —
  // not by the pane the user happens to be looking at now.
  //
  // `allow_always` also stops here rather than falling through: the code
  // below writes `toolRules` / `alwaysAllowTools`, both of which are read
  // by the SIDECAR. An external agent never talks to it, so the grant
  // would be recorded and then ignored forever, and the agent would keep
  // asking. The remembered choice travels in the agent's own protocol
  // instead (see `toPermissionResponse`).
  {
    const { isExternalAgentApprovalRequestId, resolveExternalApproval, getExternalApprovalTarget } =
      await import("@/lib/ai/agent/external/session/chat-decision-bridge")
    if (isExternalAgentApprovalRequestId(approval.requestId)) {
      try {
        // Where the agent actually is decides how the answer travels. A
        // host-run agent has no adapter in this shell to hand a response
        // to, so it goes back as an RPC; everything else about the entry —
        // the card, the decision, the bookkeeping below — is the same.
        const remoteDecisionId = getExternalApprovalTarget(approval.requestId)?.remoteDecisionId
        const respond = remoteDecisionId
          ? async () => {
              const { resolveRemotePermission } =
                await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
              const outcome = await resolveRemotePermission(remoteDecisionId, decision)
              // `wrong-device` cannot happen for the client that started
              // the run, and `unknown` means the host already decided (the
              // 120s auto-deny, or the run settled). Either way there is
              // nothing left to wait for, so the card comes down.
              if (!outcome.resolved && outcome.reason === "wrong-device") {
                throw new Error("This device is not the one that was asked.")
              }
            }
          : async (
              agentId: string,
              agentSessionId: string,
              response: import("@/types/agent/external-agent").AcpPermissionResponse
            ) => {
              const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
              await getExternalAgentManager().respondToPermission(agentId, agentSessionId, response)
            }
        const answered = await resolveExternalApproval(approval.requestId, decision, respond)
        // An unknown id means the turn already released it (the adapter is
        // gone). Clear the card rather than leaving a dialog the user
        // cannot dismiss.
        if (answered) await recordChatToolApprovalDecision(approval, decision, outboundGrant)
      } catch (error) {
        // Leave the approval mounted so the operator can retry; the agent
        // is still waiting.
        store.getState().setSessionDiagnostic(
          approval.sessionId,
          toDiagnostic(error, {
            source: "external-agent",
            meta: {
              sessionId: approval.sessionId,
              extra: { requestId: approval.requestId },
            },
          })
        )
        return
      }
      store.getState().clearApproval(approval.requestId, approval.sessionId)
      // ACP's permission answer has no text field: the reason follows.
      followDenialWithReason()
      return
    }
  }
  // Remember a refusal for the rest of this conversation. Without this a
  // "Deny" bought nothing: the same call asked again next turn, and any
  // widening in between (a new always-allow, a broader rule in Settings)
  // would start auto-approving the very thing the user just refused.
  //
  // An enforced outbound refusal is not remembered here: its receipt fences
  // the recipient for the rest of the requester's instruction, on every
  // tool and child run (ADR-0239), and a new instruction lifts it.
  if (decision === "deny" && !approval.outbound?.enforced) {
    const { rememberDenial } = await import("@/lib/ai/agent/execution/permissions/session-denials")
    rememberDenial(approval.sessionId, approval.toolName, approval.input)
  }
  // Persist the always-allow choice. Prefer a TARGET-SCOPED rule
  // (`Bash(git status)`, `Read(/path/x)`) so the grant is precise and
  // future matching calls auto-resolve via the sidecar ruleset — falling
  // back to a coarse tool-NAME grant only when no useful target can be
  // extracted.
  //
  // The scope is the action the user READ, never its family: the example
  // here used to say `Bash(git *)`, and so did the derivation, which meant
  // approving `git status` also bought `git push --force` forever. See
  // `deriveAllowRuleFromApproval` — a family grant is now something the
  // user authors deliberately in Settings, not something a click arrives at.
  if (decision === "allow_always") {
    const rule = deriveAllowRuleFromApproval(approval.toolName, approval.input)
    if (rule) {
      const settingsState = useSettingsStore.getState()
      const ap = settingsState.settings?.agentPermissions ?? {}
      const nextRules = setToolRule(ap.toolRules, rule.tool, rule.pattern, "allow")
      await settingsState.save({ agentPermissions: { ...ap, toolRules: nextRules } })
    } else {
      await useSettingsStore.getState().toggleAlwaysAllow(approval.toolName, true)
    }
  }
  // ADR-0020 W3 — remember the operator's Allow for any computer-use
  // plugin tool so subsequent turns inside this session skip the chat
  // modal when the active character's `chatConsentMode ===
  // "session-grant"`. The Rust ConsentBroker keeps its own
  // per-tuple session grants for defence-in-depth; this store only
  // governs the chat-side prompt cadence. Recording unconditionally
  // is safe because the SEND-side check
  // (`applyComputerUseTools`) consults `chatConsentMode` before
  // honouring a grant.
  if (decision === "allow" || decision === "allow_always") {
    if (!approval.suppressAlwaysAllowRule && isComputerUsePluginToolName(approval.toolName)) {
      const { recordSessionGrant } =
        await import("@/lib/plugin/security/computer-use-session-grants")
      recordSessionGrant(approval.sessionId, approval.toolName)
    }
  }
  try {
    const queued = options?.updatedInput
      ? false
      : await enqueueHostStateIntentIfAvailable({
          sessionId: approval.sessionId,
          action: {
            kind: "approval.respond",
            requestId: approval.requestId,
            decision,
          },
        })
    if (queued) {
      store.getState().clearApproval(approval.requestId, approval.sessionId)
      // The HostState answer is a fixed wire shape every paired Host
      // validates; the reason travels as the follow-up steer it is.
      followDenialWithReason()
      return
    }
  } catch (error) {
    store.getState().setSessionDiagnostic(
      approval.sessionId,
      toDiagnostic(error, {
        source: "chat",
        meta: {
          sessionId: approval.sessionId,
          extra: { requestId: approval.requestId },
        },
      })
    )
    return
  }
  const handle = getExecutionHandle(approval.sessionId)
  const denialMessage = denialReason ? denialMessageForModel(denialReason) : undefined
  if (handle && !approval.requestId.startsWith("local:")) {
    await handle.resolvePermission(
      approval.requestId,
      decision,
      ...(options?.updatedInput
        ? ([{ message: denialMessage, updatedInput: options.updatedInput }] as const)
        : denialMessage
          ? ([{ message: denialMessage }] as const)
          : ([] as const))
    )
    // `approveTool` journals the matching `permission-resolved`; this
    // branch never reaches it. Without the record the run's canonical log
    // (and the live Fleet / island rows folded from it) kept the ask open
    // until the turn ended.
    recordChatCanonicalEvents(approval.sessionId, [
      {
        kind: "permission-resolved",
        requestId: approval.requestId,
        behavior: decision === "deny" ? "deny" : "allow",
      },
    ])
  } else {
    const approvalArgs = [
      approval.sessionId,
      approval.requestId,
      decision === "allow_always" ? "allow" : decision,
    ] as const
    if (options?.updatedInput) {
      await approveTool(...approvalArgs, denialMessage, options.updatedInput)
    } else if (denialMessage) {
      await approveTool(...approvalArgs, denialMessage)
    } else {
      await approveTool(...approvalArgs)
    }
  }
  // The receipt asserts the backend received the decision, so it is written
  // only after either dispatch path succeeds. A failure leaves the approval
  // mounted and pending, allowing the operator to retry.
  await recordChatToolApprovalDecision(approval, decision, outboundGrant)
  // Scope the clear to the approval's own session so resolving a gate in
  // one pane never disturbs another pane's pending queue.
  store.getState().clearApproval(approval.requestId, approval.sessionId)
}
