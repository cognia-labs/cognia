"use client"

import type React from "react"
import { routeFailureText } from "@/components/squads/agent-mention-picker"
import { detectInteractiveCommand } from "@/lib/ai/agent/execution/permissions/interactive-command"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import { formatReviewReceiptsForLLM } from "@/lib/artifacts/format-review-receipt"
import { formatContextSelectionsForLLM } from "@/lib/artifacts/format-selection-context"
import {
  INLINE_TOKEN_CEILING,
  buildSendContent,
  type AttachmentManifestEntry,
  type ExtractedAttachment,
  type SubmittedFile,
} from "@/lib/chat/attachments/dispatch"
import { type NativeVideoVerdict } from "@/lib/chat/attachments/video/delivery-gate"
import { buildLinkContextBlocks, mergeContextBlocks } from "@/lib/chat/link-context"
import { memoryTargetKey, type ComposerMemoryTarget } from "@/lib/chat/memory-target"
import { type AttachmentCitations } from "@/lib/chat/mentions/attachment-citations"
import { mergeContextRefs } from "@/lib/chat/mentions/merge-refs"
import { citationsForSelections } from "@/lib/chat/mentions/selection-citations"
import { refreshSelectionFreshness } from "@/lib/chat/mentions/selection-freshness"
import {
  carriedPreambleSections,
  composeTurnText,
  mergeCarriedPreambleSummary,
  summarizeSelectionForPreamble,
} from "@/lib/chat/prompt-preamble"
import { shellJobTranscript } from "@/lib/chat/shell-job-transcript"
import { sessionStatusOf } from "@/lib/chat/steer-runtime"
import { type ChatTemplateRun } from "@/lib/chat/template/run"
import { type ComposerTurnMetadata } from "@/lib/chat/turn-metadata"
import { resolveRouteLane } from "@/lib/chat/turn-route/resolve"
import { snapshotRouteContext } from "@/lib/chat/turn-route/snapshot"
import { type TurnRoute } from "@/lib/chat/turn-route/types"
import { resolveWebAccess } from "@/lib/chat/web-access"
import { isChatTurnQueued } from "@/lib/execution/chat-lease"
import {
  UnsupportedPlatformAttachmentsError,
  sendManualMessageToConversation,
} from "@/lib/inbox/manual-send"
import { searchWithAppSettings } from "@/lib/search/configured-search"
import { formatSearchResultsForLLM } from "@/lib/search/search-service"
import { runShellLine } from "@/lib/shell-intelligence/execute"
import { startShellJob, type ShellJobCopy } from "@/lib/shell-intelligence/shell-job"
import { buildShellJobCardMessage, startShellJobRun } from "@/lib/shell-intelligence/shell-job-run"
import { formatShellResult } from "@/lib/shell/exec"
import { SideChatDispatchError } from "@/lib/slash-commands/actions/side-chat"
import {
  type SlashCommand,
  type SlashContext,
  type SlashStagedFiles,
} from "@/lib/slash-commands/builtin"
import {
  type SlashCommandResultBlock,
  type SystemMessageBlock,
} from "@/lib/slash-commands/system-blocks"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { terminalAvailable } from "@/lib/terminal/pick-transport"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"
import { allRootPaths } from "@/lib/workspace/roots"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  selectComposerCarriedPreambles,
  selectComposerCitedRefs,
  selectComposerContextSelections,
  selectComposerPermissionMode,
  selectComposerReplyTo,
  selectComposerWebSearchOn,
  useChatStore,
} from "@/stores/chat"
import { useComposerCommandStore } from "@/stores/chat/composer-command-store"
import { clearComposerTyping } from "@/stores/chat/composer-typing-store"
import { roomTargetsOf } from "@/stores/chat/room-target-store"
import { useProjectStore } from "@/stores/project/project-store"
import {
  type AppSettings,
  type ChatSession,
  type MessageReplyTo,
  type SendContent,
  type SendOptions,
} from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { type useTranslations } from "next-intl"
import { toast } from "sonner"

import type { SettingsSectionId } from "@/components/settings/settings-nav-config"
import type { ShellContext } from "@/lib/shell-intelligence/availability"
import type { ChatStatus, PermissionMode } from "@/stores/chat/chat-store"

/**
 * What the composer's turn handlers (`/` commands, `!` lines, `#` memory and
 * a message) read from `Composer`.
 */
export interface ComposerTurnContext {
  session: ChatSession | null | undefined
  onStartNewSession: () => void | Promise<void>
  onOpenSettings: (tab: SettingsSectionId) => void
  onSend: (
    content: SendContent,
    manifest?: readonly AttachmentManifestEntry[] | undefined,
    templateRun?: ChatTemplateRun | null | undefined,
    turnMetadata?: ComposerTurnMetadata | undefined
  ) => boolean | void | Promise<boolean | void>
  tCommands: ReturnType<typeof useTranslations<"chat.composer.commands">>
  tShell: ReturnType<typeof useTranslations<"chat.composer.shell">>
  shellJobCopy: ShellJobCopy
  /** Only what the `!` handler reads, so its callback keys on those two fields. */
  shell: Pick<ShellContext, "availability" | "shell">
  tMemory: ReturnType<typeof useTranslations<"chat.composer.memory">>
  tAttach: ReturnType<typeof useTranslations<"chat.composer.attachments">>
  tPlatform: ReturnType<typeof useTranslations<"chatPlatformComposer">>
  tPlatformName: ReturnType<typeof useTranslations<"inbox.platformBadge.names">>
  tWebSearch: ReturnType<typeof useTranslations<"webSearchToggle">>
  tRoute: ReturnType<typeof useTranslations<"chat.composer.route">>
  tRouteRuntime: ReturnType<typeof useTranslations<"agentTeamsWorkspace.chat.runtime">>
  videoRoute: Pick<NativeVideoVerdict, "available">
  attachmentCitations: AttachmentCitations
  isMobileShell: boolean
  status: ChatStatus
  setPermissionMode: (mode: PermissionMode | null, sessionId?: string | null | undefined) => void
  clearReferencedPaths: (sessionId?: string | null | undefined) => void
  clearCitedRefs: (sessionId?: string | null | undefined) => void
  clearContextSelections: (sessionId?: string | null | undefined) => void
  cwd: string | null
  setOversizeConfirm: React.Dispatch<
    React.SetStateAction<{ tokens: number; resolve: (ok: boolean) => void } | null>
  >
  pushSystemMessage: (payload: string | SystemMessageBlock | SlashCommandResultBlock) => void
  runPluginCommand: (command: SlashCommand, context: SlashContext) => Promise<boolean>
  tBestOfN: ReturnType<typeof useTranslations<"bestOfNEntry">>
  setBestOfNChoice: React.Dispatch<React.SetStateAction<{ sessionId: string; n: 2 | 3 | 4 } | null>>
  bestOfNCount: 2 | 3 | 4 | null
  requestBestOfN: (prompt: string, n: 2 | 3 | 4, agents?: string[] | undefined) => Promise<boolean>
  /** The live app settings, read at the moment each step needs them. */
  readSettings: () => AppSettings | null
}

export async function runComposerSlashCommand(
  ctx: Pick<
    ComposerTurnContext,
    | "session"
    | "onStartNewSession"
    | "onOpenSettings"
    | "tCommands"
    | "isMobileShell"
    | "status"
    | "setPermissionMode"
    | "pushSystemMessage"
    | "runPluginCommand"
    | "tBestOfN"
    | "requestBestOfN"
  >,
  cmd: SlashCommand,
  args: string,
  staged?: SlashStagedFiles
): Promise<boolean> {
  const {
    session,
    onStartNewSession,
    onOpenSettings,
    tCommands,
    isMobileShell,
    status,
    setPermissionMode,
    pushSystemMessage,
    runPluginCommand,
    tBestOfN,
    requestBestOfN,
  } = ctx

  if (cmd.handler) {
    if (cmd.name === "best-of-n" && staged?.files.length) {
      toast.error(tBestOfN("textOnly"))
      return false
    }
    let bestOfNAccepted = true
    const ctx: SlashContext = {
      args,
      startBestOfN: async (prompt, n, agents) => {
        bestOfNAccepted = await requestBestOfN(prompt, n, agents)
        return bestOfNAccepted
      },
      isAside: session?.kind === "resource-workbench",
      // The compact shell has no dock, so `/btw` reports desktop-only there too.
      isMobile: isMobileShell,
      activeSessionId: session?.id ?? null,
      chatStatus: status,
      // Read AND written against this composer's conversation. The mode
      // cycle (`lib/slash-commands/builtin.ts`) reads this value and hands
      // it straight back, so a focused-projection read here made an
      // unfocused pane silently cycle the pane beside it — and that mode
      // reaches the model through `resolveSendOptions`.
      currentPermissionMode: selectComposerPermissionMode(
        useChatStore.getState(),
        session?.id ?? null
      ),
      startNewSession: onStartNewSession,
      openSettings: onOpenSettings,
      setPermissionMode: (mode) => setPermissionMode(mode, session?.id ?? null),
      pushSystemMessage,
      ...(staged ? { stagedFiles: staged.files, consumeStagedFiles: staged.consume } : {}),
    }
    try {
      if (cmd.scope === "plugin") {
        if (!(await runPluginCommand(cmd, ctx))) return false
      } else {
        await cmd.handler(ctx)
        if (!bestOfNAccepted) return false
      }
      // Registered command names only — never the argument string, which
      // is free user text.
      void trackEvent("app.command.executed", {
        command: cmd.name,
        kind: "action",
        outcome: "succeeded",
      })
    } catch (err) {
      loggers.chat.error("slash command failed", err, {
        command: cmd.name,
        sessionId: session?.id,
      })
      void trackEvent("app.command.executed", {
        command: cmd.name,
        kind: "action",
        outcome: "failed",
      })
      // The action already explained the refusal. Retain its question.
      if (err instanceof SideChatDispatchError) return false
      toast.error(err instanceof Error ? err.message : tCommands("failed"))
    }
    return true
  }
  if (cmd.template) {
    void trackEvent("app.command.executed", {
      command: cmd.name,
      kind: "template",
      outcome: "succeeded",
    })
    return true
  }
  return false
}

export async function runComposerShellSubmit(
  ctx: Pick<
    ComposerTurnContext,
    "session" | "tShell" | "shellJobCopy" | "shell" | "cwd" | "pushSystemMessage"
  >,
  rawCmd: string
): Promise<boolean> {
  const { session, tShell, shellJobCopy, shell, cwd, pushSystemMessage } = ctx

  const cmd = rawCmd.trim()
  if (!cmd) return false
  if (!cwd) {
    toast.error(tShell("needsCwd"))
    return false
  }
  // An interactive command (ssh, a REPL, a login flow, `git rebase -i`, …)
  // needs a TTY the capture path lacks — it would hang or read EOF. Route it
  // to the real integrated terminal instead.
  //
  // Gated on the DOCK being reachable, not on `isTauri()`. The old gate was
  // safe only because `executeShell` threw "desktop app only" underneath it;
  // `runShellLine` runs anywhere a Host is, so an `isTauri()` gate would
  // send `!ssh host` from a paired browser down the capture path to block
  // until the capture timeout.
  //
  // …and gated on a Host being reachable as well, because `terminalAvailable()`
  // alone is NOT the predicate `useShellContext` answers with. It reports
  // whether a terminal transport could be picked — true for any Capacitor
  // shell and any browser with a companion target configured, paired or
  // not — while `availability` is the negotiated verdict, which additionally
  // requires the Host to advertise `terminal_exec` and grant it. An
  // unpaired phone satisfies the first and fails the second, so `!ssh host`
  // used to be handed to a dock with nothing behind it instead of getting
  // the one message that names the fix. Reading the run verdict here is what
  // actually makes the two branches unable to disagree: below, anything
  // short of `full` refuses immediately and by name, and now so does this
  // one. `full`, and not merely "not static-only", because
  // `shell-unavailable` is a reachable Host too, one that does not have the
  // configured shell. Routing that to the dock hands it a shell it cannot
  // spawn, which is the same silent nothing this gate exists to stop, while
  // the capture path refuses with `shell-unavailable` and names the shell.
  const hostReachable = shell.availability === "full"
  if (hostReachable && terminalAvailable() && detectInteractiveCommand(cmd).interactive) {
    try {
      await runInTerminalDock(cmd, cwd, session?.id ?? "")
      pushSystemMessage(tShell("interactiveRoutedToTerminal", { cmd }))
    } catch (err) {
      loggers.chat.error("interactive shell routing failed", err, { cmd, cwd })
      pushSystemMessage(
        tShell("failed", {
          cmd,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
    return true
  }
  const reportRefusal = (refusal: { reason: string; detail: string }) => {
    loggers.chat.error("shell command failed", refusal.detail, {
      cmd,
      cwd,
      reason: refusal.reason,
      shell: shell.shell.path,
    })
    if (refusal.reason === "no-host") {
      pushSystemMessage(tShell("noHost", { cmd }))
    } else if (refusal.reason === "consent-required") {
      // The host wants a human to approve remote execution. Telling the user
      // that names an action; the generic "failed" sentence names none.
      pushSystemMessage(tShell("consentRequired", { cmd }))
    } else if (refusal.reason === "shell-unavailable") {
      pushSystemMessage(tShell("shellUnavailable", { cmd, shell: shell.shell.path }))
    } else if (refusal.reason === "unsupported-shell") {
      pushSystemMessage(tShell("unsupportedShell", { cmd, shell: shell.shell.path }))
    } else {
      pushSystemMessage(tShell("failed", { cmd, error: refusal.detail }))
    }
  }

  // As a supervised job owned by this conversation: output streams into a
  // live card, nothing kills it at a timeout, and it can be moved to the
  // Job Center or stopped. See `lib/shell-intelligence/shell-job.ts`.
  // Needs a conversation to own the job; the home composer has none yet.
  const sessionId = session?.id
  if (sessionId) {
    const started = await startShellJob({
      sessionId,
      line: cmd,
      cwd,
      shell: shell.shell,
      availability: shell.availability,
      label: tShell("job.label"),
    })
    if (started.ok) {
      const block = {
        kind: "shell-job" as const,
        jobId: started.job.id,
        sessionId,
        command: cmd,
        cwd,
      }
      // The card goes in before the run starts: every later write from
      // the run rewrites this row, and a fast `ls` must not settle first.
      try {
        await shellJobTranscript.upsert(sessionId, buildShellJobCardMessage(block))
      } catch (err) {
        loggers.chat.error("posting a shell job card failed", err, { jobId: block.jobId })
      }
      startShellJobRun(block, { transcript: shellJobTranscript, copy: shellJobCopy })
      return true
    }
    // A Host without the job command still runs the line, the old way.
    if (started.reason !== "job-unavailable") {
      reportRefusal(started)
      return true
    }
  }

  pushSystemMessage(tShell("runningHint", { cmd, cwd }))
  // Through the routed `terminal_exec`, under the user's configured shell —
  // so a `!` line works from a paired browser or phone, and `fish` users
  // stop silently getting `sh`. See `lib/shell-intelligence/execute.ts`.
  const outcome = await runShellLine({
    line: cmd,
    cwd,
    shell: shell.shell,
    availability: shell.availability,
  })
  if (outcome.ok) {
    pushSystemMessage(formatShellResult(cmd, outcome))
    return true
  }
  reportRefusal(outcome)
  return true
}

export async function runComposerMemorySubmit(
  ctx: Pick<ComposerTurnContext, "session" | "tMemory" | "cwd" | "readSettings">,
  target: ComposerMemoryTarget,
  text: string
): Promise<boolean> {
  const { session, tMemory, cwd, readSettings } = ctx

  const noteUsed = () =>
    useComposerCommandStore.getState().noteMemoryTargetUsed(memoryTargetKey(target))
  if (target.target === "store") {
    // ADR-0069 long-term memory — the SAME write path `/remember` uses, so
    // the PII gate and the consolidator can't be bypassed here.
    const { rememberFact } = await import("@/lib/memory/write/remember-fact")
    const result = await rememberFact({
      text,
      scope: target.scope,
      sessionId: session?.id ?? null,
    })
    if (result.ok) {
      noteUsed()
      toast.success(tMemory("storedInMemory", { scope: tMemory(`scope.${target.scope}`) }))
      return true
    }
    loggers.chat.warn("memory store write refused", { reason: result.reason })
    toast.error(tMemory(`storeError.${result.reason}`))
    return false
  }
  try {
    // The instruction file this conversation's next turn loads, found by
    // the send path's own discovery over the same roots and settings.
    const [{ appendInstructionMemory }, { resolveCharacterById }] = await Promise.all([
      import("@/lib/agents/instructions/append-memory"),
      import("@/lib/db/characters"),
    ])
    const { projects, activeProjectId } = useProjectStore.getState()
    const workspace = resolveSessionWorkspace(session, projects, activeProjectId)
    const character = session?.characterId
      ? await resolveCharacterById(session.characterId)
      : undefined
    const path = await appendInstructionMemory({
      scope: target.scope,
      text,
      cwd,
      roots: workspace ? allRootPaths(workspace) : cwd ? [cwd] : [],
      config: character?.instructionsOverride ?? readSettings()?.instructions,
    })
    noteUsed()
    toast.success(tMemory("appended", { path }))
    return true
  } catch (err) {
    loggers.chat.error("memory append failed", err, { scope: target.scope, cwd })
    const { InstructionMemoryError } = await import("@/lib/agents/instructions/append-memory")
    toast.error(
      err instanceof InstructionMemoryError
        ? tMemory(`fileError.${err.reason}`)
        : err instanceof Error
          ? err.message
          : tMemory("failed")
    )
    return false
  }
}

export async function runComposerTurn(
  ctx: Pick<
    ComposerTurnContext,
    | "session"
    | "onOpenSettings"
    | "onSend"
    | "tAttach"
    | "tPlatform"
    | "tPlatformName"
    | "tWebSearch"
    | "tRoute"
    | "tRouteRuntime"
    | "videoRoute"
    | "attachmentCitations"
    | "clearReferencedPaths"
    | "clearCitedRefs"
    | "clearContextSelections"
    | "setOversizeConfirm"
    | "pushSystemMessage"
    | "tBestOfN"
    | "setBestOfNChoice"
    | "bestOfNCount"
    | "requestBestOfN"
    | "readSettings"
  >,
  text: string,
  files: SubmittedFile[],
  precomputed?: ReadonlyMap<string, ExtractedAttachment>,
  templateRun?: ChatTemplateRun | null,
  submission?: { replyTo: MessageReplyTo | null },
  route?: TurnRoute | null
) {
  const {
    session,
    onOpenSettings,
    onSend,
    tAttach,
    tPlatform,
    tPlatformName,
    tWebSearch,
    tRoute,
    tRouteRuntime,
    videoRoute,
    attachmentCitations,
    clearReferencedPaths,
    clearCitedRefs,
    clearContextSelections,
    setOversizeConfirm,
    pushSystemMessage,
    tBestOfN,
    setBestOfNChoice,
    bestOfNCount,
    requestBestOfN,
    readSettings,
  } = ctx

  const trimmed = text.trim()
  if (bestOfNCount) {
    if (files.length || route) {
      toast.error(tBestOfN("textOnly"))
      return false
    }
    const started = await requestBestOfN(trimmed, bestOfNCount)
    if (started) setBestOfNChoice(null)
    return started
  }
  // NOTE: `!shell` / `#memory` are NOT detected here any more. They are
  // first-line modes decided from the ORIGINAL input inside `ComposerInner`
  // (see `onSubmitShell` / `onSubmitMemory`); sniffing the prefix off this
  // post-command text meant `/clear\n!ls` executed a shell command.

  if (session?.platformBinding) {
    if (!trimmed && files.length === 0) return false
    const replyTo = submission?.replyTo ?? null
    try {
      await sendManualMessageToConversation({
        session,
        text: trimmed,
        files,
        replyTo,
        templateRun,
      })
      const chatState = useChatStore.getState()
      if (replyTo && selectComposerReplyTo(chatState, session.id) === replyTo) {
        chatState.setReplyTo(null, session.id)
      }
      return true
    } catch (error) {
      toast.error(
        error instanceof UnsupportedPlatformAttachmentsError
          ? tPlatform("attachmentsUnsupported", {
              platform: tPlatformName.has(error.platform)
                ? tPlatformName(error.platform)
                : error.platform,
            })
          : tPlatform("sendFailed")
      )
      return false
    }
  }

  // ── Addressed turn: `@claude` / `@codex` / `@<Squad member>` ─────
  // Checked before anything below consumes a toggle, a chip or a receipt,
  // so a refused route leaves the draft AND everything staged with it in
  // place. The controller re-checks at commit (a lane can change between
  // here and there); this is the check that can still say why, offer the
  // way to fix it, and keep the text in the box.
  if (route) {
    // A live follow-up can only reach the runtime already answering, and
    // queued follow-ups merge into one payload — neither can move a turn.
    // Same verdict the controller's steer gate reaches.
    if (session?.id) {
      const current = sessionStatusOf(session.id)
      if (
        current === "streaming" ||
        current === "awaiting_approval" ||
        isChatTurnQueued(session.id)
      ) {
        toast.error(tRoute("busy", { handle: route.handle }))
        return false
      }
    }
    // `@codex` alone addresses a runtime with nothing to ask it. The token
    // is stripped before the runtime sees the turn, so this would send an
    // empty prompt — or, since stripping refuses to empty a message, the
    // bare handle as the question.
    const afterHandle = trimmed.slice(route.handle.length + 1).trim()
    if (!afterHandle && files.length === 0) {
      toast.error(tRoute("emptyPrompt", { handle: route.handle }))
      return false
    }
    const snapshot = await snapshotRouteContext(session?.id ?? null, {
      providerId: session?.providerOverride ?? readSettings()?.defaultProvider ?? "anthropic",
      session: session ?? null,
    })
    const lane = resolveRouteLane(route.target, snapshot)
    if (!lane.ok) {
      toast.error(tRoute("unavailable", { handle: route.handle }), {
        description: routeFailureText(
          lane,
          { handle: route.handle, name: route.label },
          tRoute,
          tRouteRuntime
        ),
        action: {
          label: tRoute("openSettings"),
          // A missing member is fixed in the Squad; everything else is an
          // external agent to add, enable or repair.
          onClick: () => onOpenSettings(lane.reason === "member-missing" ? "squads" : "agents"),
        },
      })
      return false
    }
  }

  // ── Web search prefetch ─────────────────────────────────────────
  // If the user toggled web search for this turn, run the query through
  // the configured provider before forwarding to the SDK and prepend the
  // formatted results as a system block. We don't fail the send on
  // search errors — fall back to the original message instead.
  // The three things that can ride in front of the typed text. Each is built
  // as its own section and assembled once by `composeTurnText`, which wraps
  // them in the envelope every "what did the user type" reader strips.
  let webSearchSection = ""
  let webSearchContext: SendOptions["webSearchContext"]
  // THIS composer's conversation, matching where `WebSearchToggle` writes
  // it. The bare projection is the focused pane, so an unfocused pane's
  // armed toggle was never consumed (and never cleared, so it stayed lit)
  // while a send from the focused pane ran the search it had armed.
  const webOn = selectComposerWebSearchOn(useChatStore.getState(), session?.id ?? null)
  // The SAME verdict `WebSearchToggle` disables itself on — not a private
  // re-derivation of half of it. `preSearch` also covers the `webTools`
  // kill switch and "is a provider actually configured", so a toggle armed
  // before the user turned web tools off cannot still reach the network.
  const searchSettings = readSettings()
  const proactiveSearchEnabled = resolveWebAccess({
    ...(searchSettings?.webTools ? { webTools: searchSettings.webTools } : {}),
    nativeAvailable: false,
    ...(searchSettings?.searchProviders ? { searchProviders: searchSettings.searchProviders } : {}),
    ...(searchSettings?.defaultSearchProvider
      ? { defaultSearchProvider: searchSettings.defaultSearchProvider }
      : {}),
    ...(searchSettings?.searchEnabled !== undefined
      ? { searchEnabled: searchSettings.searchEnabled }
      : {}),
  }).preSearch
  if (webOn && proactiveSearchEnabled && trimmed) {
    try {
      const resp = await searchWithAppSettings(trimmed)
      webSearchSection = wrapUntrustedContent(formatSearchResultsForLLM(resp))
      webSearchContext = {
        provider: resp.provider,
        results: resp.results.map(({ title, url, content, score }) => ({
          title,
          url,
          content,
          score,
        })),
      }
      pushSystemMessage(
        `🔎 ${tWebSearch("searchedVia", {
          provider: resp.provider,
          count: resp.results.length,
        })}`
      )
    } catch (err) {
      loggers.chat.error("web search failed", err, { query: trimmed })
      toast.error(
        tWebSearch("searchFailed", {
          message: err instanceof Error ? err.message : String(err),
        })
      )
    }
  }
  if (webOn) useChatStore.getState().setWebSearchOnForNextSend(false, session?.id ?? null)

  // ── Context selections ──────────────────────────────────────────
  // Prepend the selected material + comment as context, and record the
  // edit target so the assistant reply routes into a per-hunk review
  // proposal against the targeted artifact. The first selection wins; the
  // rest contribute context only. That is now stated in the UI — the lead
  // chip carries an "edit target" badge and the others promote on click
  // (`artifact-selection-chips.tsx`) — where it used to be a `debug` log
  // nobody would ever see.
  // This pane's staged material, matching the chips that display it and the
  // `clearContextSelections(session?.id)` below. Reading the focused
  // projection here sent the OTHER conversation's file and artifact
  // excerpts in this turn — and cleared selections that were never used.
  const stagedSelections = selectComposerContextSelections(
    useChatStore.getState(),
    session?.id ?? null
  )
  // Last look before the snapshots leave. The chip bar re-checks on focus,
  // but a record edited in the seconds between that and Enter would
  // otherwise be sent as current. The bodies are NOT refreshed — the user
  // approved these — only the divergence is recorded, so
  // `formatContextSelectionsForLLM` can say the copy is behind.
  const contextSelections = (await refreshSelectionFreshness(stagedSelections)).selections
  // Formatted whether or not a conversation exists yet. The block used to be
  // gated on `session?.id`, and the new-chat composer has none — so the chips
  // of a first message were silently dropped and then cleared, which is the
  // main way a conversation gets started FROM a reference.
  const referencesSection = formatContextSelectionsForLLM(contextSelections, {
    sessionId: session?.id ?? null,
  })
  if (contextSelections.length > 0 && session?.id) {
    // The first *artifact*, not the first selection. A file, comment or web
    // reference has nothing for a revision proposal to diff against, so
    // reading index 0 blindly would let a staged workspace file silently
    // disarm the whole review round trip — the AI's reply would then
    // auto-create a duplicate artifact instead of proposing hunks against
    // the one the user was actually working on.
    const primary = contextSelections.find((sel) => sel.kind === "artifact")
    if (primary) {
      useChatStore.getState().setPendingArtifactEditTarget(session.id, {
        artifactId: primary.artifactId,
        requestId: crypto.randomUUID(),
      })
    }
  }

  // ── Review outcomes ─────────────────────────────────────────────
  // Close the revision round trip the block above opens. Rejecting a
  // proposal (or keeping 2 of its 5 hunks) used to be invisible to the
  // assistant, which could then re-propose exactly what the user had just
  // turned down. Read here but consumed only once the send commits, below —
  // the same lifetime as a staged selection — so a receipt rides exactly
  // one message and survives a send that bails before `onSend`.
  const sentReceipts = session?.id ? useArtifactStore.getState().peekReviewReceipts(session.id) : []
  // Envelopes carried over from a put-back message: what it referenced
  // when it was first sent, re-sent verbatim beside this turn's own.
  const carriedPreambles = selectComposerCarriedPreambles(
    useChatStore.getState(),
    session?.id ?? null
  )
  const turn = composeTurnText(text, [
    {
      kind: "reviewReceipts",
      text: sentReceipts.length > 0 ? formatReviewReceiptsForLLM(sentReceipts) : "",
    },
    { kind: "references", text: referencesSection },
    ...carriedPreambleSections(carriedPreambles),
    { kind: "webSearch", text: webSearchSection },
  ])
  const preambleSummary = turn.preamble
    ? mergeCarriedPreambleSummary(
        {
          sections: turn.sections,
          references: contextSelections.map(summarizeSelectionForPreamble),
        },
        carriedPreambles
      )
    : null
  const augmented = turn.text

  const linkContext = await buildLinkContextBlocks(text)
  // `precomputed` makes this a map lookup for anything already extracted at
  // staging time; files it doesn't cover still extract inline here.
  const attachmentResult = await buildSendContent(augmented, files, {
    precomputed,
    allowNativeVideo: videoRoute.available,
  })
  const content = mergeContextBlocks(attachmentResult.content, linkContext.blocks)
  const rejected = attachmentResult.rejected
  // The envelope counts too. The ceiling used to see attachments and links
  // only, so twenty staged references went out with no confirmation at all.
  const tokens =
    attachmentResult.tokens + linkContext.tokens + estimateFallbackTokens(turn.preamble)
  const isEmpty =
    (typeof content === "string" && !content.trim()) ||
    (Array.isArray(content) && content.length === 0)
  if (rejected.length > 0) {
    toast.error(tAttach("processing.rejected", { count: rejected.length }))
    return false
  }
  if (isEmpty) return true
  if (linkContext.rejected.length > 0) {
    toast.warning(tAttach("linkSkipped", { count: linkContext.rejected.length }))
  }
  // Oversize guard: above the inline-token ceiling we ask the user to
  // confirm before sending — never silently truncate. The promise resolves
  // when they pick an option in the dialog rendered below.
  if (tokens > INLINE_TOKEN_CEILING) {
    const ok = await new Promise<boolean>((resolve) => {
      setOversizeConfirm({ tokens, resolve })
    })
    setOversizeConfirm(null)
    if (!ok) return false
  }
  // The reply target rides this exact turn (ADR-0177 batch 2). Read from
  // THIS pane's conversation and cleared after the send, like the cited
  // refs, so the chip is gone the moment the quoted turn is in the list.
  const replyTo = selectComposerReplyTo(useChatStore.getState(), session?.id ?? null)
  // The standing member pick (ADR-0177 batch 3) rides every send in a
  // team room until the user clears it, so it is read, not consumed.
  const targetMemberIds =
    session?.kind === "team" && session.teamId ? roomTargetsOf(session.id) : []
  // Read from THIS composer's slice, like the chips, and handed over with
  // the turn: the destination conversation of a first message does not
  // exist yet, so the send path cannot find these by looking it up.
  // A picked remote document leaves no token and no chip-bar selection: its
  // citation is bound to the attachment it staged, so it is read off the
  // files this turn actually submits. A chip removed before sending, or an
  // extraction that was rejected, therefore cites nothing.
  const citations = mergeContextRefs(
    [
      ...citationsForSelections(contextSelections),
      ...attachmentCitations.citationsFor(files, precomputed),
    ],
    selectComposerCitedRefs(useChatStore.getState(), session?.id ?? null)
  )
  const turnMetadata: ComposerTurnMetadata = {
    ...(webSearchContext ? { webSearchContext } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(targetMemberIds.length > 0 ? { targetMemberIds } : {}),
    ...(preambleSummary ? { promptPreamble: preambleSummary } : {}),
    ...(citations.length > 0 ? { citations } : {}),
    ...(route ? { route } : {}),
  }
  const outcome =
    Object.keys(turnMetadata).length > 0
      ? await onSend(content, attachmentResult.manifest, templateRun, turnMetadata)
      : await onSend(content, attachmentResult.manifest, templateRun)
  if (outcome === false) return false
  if (citations.length > 0) {
    // `kinds` is a sorted set joined with `+` — an enum-shaped string like
    // `entity+file`, never a title or anything the user typed.
    const kinds = [...new Set(citations.map((ref) => ref.kind))].sort().join("+")
    void trackEvent("chat.reference.sent", {
      kinds,
      staleCount: contextSelections.filter((sel) => sel.kind === "entity" && sel.stale).length,
    })
  }
  if (replyTo) useChatStore.getState().setReplyTo(null, session?.id ?? null)
  if (session?.kind === "team" && session.teamId) clearComposerTyping(session.id)
  clearReferencedPaths(session?.id ?? null)
  clearContextSelections(session?.id ?? null)
  useChatStore.getState().clearCarriedPreambles(session?.id ?? null)
  // Same lifetime as the chips they describe: the citations rode exactly
  // this message. Cleared AFTER `onSend` so the controller has already read
  // them into `metadata.mentions`.
  clearCitedRefs(session?.id ?? null)
  useArtifactStore.getState().consumeReviewReceipts(sentReceipts)
  return true
}
