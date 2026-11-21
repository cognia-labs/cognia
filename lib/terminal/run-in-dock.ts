"use client"

/**
 * Bridge from a chat surface to a dock tab: "run this command in the
 * selected tab on my behalf".
 *
 * Composes existing pieces — no new event pipelines:
 *   1. `requestAgentTrust` opens the consent overlay (or skips if a
 *      session grant already exists).
 *   2. `awaitCommandEnd` taps the session's output and arms the next
 *      `command_end` integration event BEFORE anything is written —
 *      `spawn-orchestrator` has already attached the OSC 633 → store wiring.
 *   3. `getLiveSession(tabId).write(cmd + "\r")` pipes the command into
 *      the PTY.
 *   4. The result carries the exit code from the integration event and the
 *      text the command printed between its OSC 633 `C` and `D` sequences.
 *      By default, unavailable integration returns `unsupported` before writing.
 *      If integration degrades after the write, `sent` means the command may
 *      still run and completion is unobservable. Callers must not resend it.
 *
 * User-driven calls can set `requireCommandEnd: false`. When integration is
 * unavailable, the command is written after consent and returns `sent` without
 * waiting or claiming an exit code/output. Supported sessions still capture and
 * wait for command end with either option. The wait timeout defaults to 60 seconds;
 * long-running commands can pass a higher limit.
 */

import { requestAgentTrust } from "./agent-trust"
import { awaitCommandEnd, unsupportedOutcome } from "./await-command-end"
import { ensureHostCapabilities } from "./host-capabilities"
import { getLiveSession } from "./session-registry"
import { resolveDefaultShell } from "./shell-detect"
import { spawnFromDock } from "./spawn-orchestrator"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { SpawnRequest } from "./types"
import { spawnerMessage } from "./spawner-message-arg"

export interface RunInDockInput {
  /** Identifier of the chat session driving this — scopes the trust grant. */
  chatSessionId: string
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  /** Existing tab to run in. Mutually exclusive with `newTab`. */
  tabId?: string
  /** When true, spawn a new tab first, then run. */
  newTab?: { req: Pick<SpawnRequest, "shell" | "cwd" | "env" | "projectId" | "rows" | "cols"> }
  command: string
  /** Max wait time for command_end in ms. Default 60_000. */
  timeoutMs?: number
  /** Default true. When false, unsupported integration sends without waiting. */
  requireCommandEnd?: boolean
}

export type RunInDockOutcome =
  | {
      kind: "ok"
      sessionId: string
      exitCode: number | null
      /** What the command printed (control sequences stripped), not its command line. */
      output: string
      /** The head of a very long output was dropped; the tail is kept. */
      outputTruncated: boolean
    }
  | { kind: "denied" }
  | { kind: "timeout"; sessionId: string }
  | { kind: "unsupported"; sessionId: string; reason: string | null }
  /** Already submitted and may still run; completion, exit code and output are unavailable. */
  | { kind: "sent"; sessionId: string; reason: string | null }
  | { kind: "error"; message: string }

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Resolve the effective wait-for-exit timeout. Per-call `input.timeoutMs`
 * wins; otherwise read the user setting `terminal.runInDockTimeoutSec`
 * (clamped to [5, 600] seconds); otherwise fall back to 60 s.
 *
 * Reading at call time (not import time) means a settings change takes
 * effect on the very next invocation without restarting the renderer.
 */
function resolveTimeoutMs(perCallMs: number | undefined): number {
  if (typeof perCallMs === "number" && Number.isFinite(perCallMs) && perCallMs > 0) {
    return perCallMs
  }
  try {
    const sec = useSettingsStore.getState().settings?.terminal?.runInDockTimeoutSec
    if (typeof sec === "number" && Number.isFinite(sec) && sec >= 5 && sec <= 600) {
      return sec * 1000
    }
  } catch {
    /* settings store not initialised — fall through */
  }
  return DEFAULT_TIMEOUT_MS
}

export async function runInDockTab(input: RunInDockInput): Promise<RunInDockOutcome> {
  let sessionId = input.tabId ?? null

  // 1. Spawn if requested.
  if (!sessionId) {
    if (!input.newTab) return { kind: "error", message: "no tabId and no newTab spec" }
    const outcome = await spawnFromDock({
      req: {
        rows: input.newTab.req.rows ?? 24,
        cols: input.newTab.req.cols ?? 80,
        shell: input.newTab.req.shell,
        cwd: input.newTab.req.cwd,
        env: input.newTab.req.env,
        projectId: input.newTab.req.projectId,
        enableShellIntegration: true,
      },
      store: useTerminalStore.getState(),
      agentSpawner: input.chatSessionId,
      ...spawnerMessage(input.chatSessionId),
    })
    if (outcome.kind !== "spawned") {
      return outcome.kind === "denied"
        ? { kind: "denied" }
        : { kind: "error", message: outcome.kind === "error" ? outcome.message : "spawn failed" }
    }
    sessionId = outcome.sessionId
  }
  if (!sessionId) return { kind: "error", message: "no session id resolved" }
  if (input.credentialContext) {
    const { retainTerminalPersonalEgress } = await import("./personal-egress")
    retainTerminalPersonalEgress(input.credentialContext, sessionId)
  }

  // Read the store AFTER the spawn. Zustand replaces `sessions` on every
  // registration, so a `getState()` taken before the await is a snapshot that
  // never contains the tab this call just opened.
  const row = useTerminalStore.getState().sessions[sessionId]
  if (!row) return { kind: "error", message: `unknown session: ${sessionId}` }

  // 2. Consent gate. The row's `agentTrusted` flag mirrors the broker's
  // grant — but the broker is the source of truth (so cross-reload state
  // stays consistent). Calling request again is cheap when a grant is
  // already cached.
  const trusted = await requestAgentTrust({
    chatSessionId: input.chatSessionId,
    tabId: sessionId,
    tabTitle: row.customTitle ?? row.title,
    commandPreview: input.command,
  })
  if (!trusted) return { kind: "denied" }
  useTerminalStore.getState().setAgentTrusted(sessionId, true)

  // 3. Get the live session; the wait attaches its listeners before `start`
  // writes, so neither the output nor the `command_end` can be missed.
  const session = getLiveSession(sessionId)
  if (!session) return { kind: "error", message: `session ${sessionId} is not live` }

  if (input.requireCommandEnd === false) {
    const unsupported = unsupportedOutcome(session.info)
    if (unsupported) {
      try {
        await session.write(input.command + "\r")
      } catch (error) {
        return { kind: "error", message: error instanceof Error ? error.message : String(error) }
      }
      return { kind: "sent", sessionId, reason: unsupported.reason }
    }
  }

  const ended = await awaitCommandEnd(session, {
    timeoutMs: resolveTimeoutMs(input.timeoutMs),
    // 4. Trailing CR triggers shell submit (and OSC 633 C, then D).
    start: () => void session.write(input.command + "\r"),
  })
  if (ended.kind === "timeout") return { kind: "timeout", sessionId }
  if (ended.kind === "unsupported") {
    return { kind: ended.started ? "sent" : "unsupported", sessionId, reason: ended.reason }
  }
  if (ended.kind === "exited") {
    return { kind: "error", message: `session ${sessionId} exited before the command finished` }
  }
  return {
    kind: "ok",
    sessionId,
    exitCode: ended.exitCode,
    output: ended.output,
    outputTruncated: ended.truncated,
  }
}

/**
 * Run a *user-typed* interactive command in a fresh dock terminal tab.
 *
 * The GUI `!command` path (`components/chat/composer.tsx`) is a one-shot capture
 * shell with no TTY, so a command that needs one (`ssh`, a REPL, a `login`
 * flow, `git rebase -i`, `psql`, …) would hang. When the detector flags it, we
 * open the integrated terminal instead and type the command there.
 *
 * Deliberately NOT `runInDockTab`: this is fire-and-forget (an interactive
 * session such as `ssh` never emits `command_end`, so awaiting one would hang)
 * and skips the agent-trust gate (the user is the one typing). It spawns a
 * fresh tab in `cwd`, reveals + focuses the dock, then pipes the command
 * (trailing CR submits it — the same convention as {@link runInDockTab}).
 *
 * `options.env` is layered over the project's terminal env and `options.title`
 * names the tab — a launch configuration's dev server is labelled by its name.
 *
 * @throws when the spawn is denied or fails.
 */
export async function runInTerminalDock(
  command: string,
  cwd: string,
  chatSessionId: string,
  options: { env?: Record<string, string>; title?: string } = {}
): Promise<void> {
  const store = useTerminalStore.getState()
  const projectState = useProjectStore.getState()
  const activeProjectId = projectState.activeProjectId
  const project = activeProjectId
    ? (projectState.projects.find((p) => p.id === activeProjectId) ?? null)
    : null
  const terminal = useSettingsStore.getState().settings?.terminal as
    | {
        defaultShell?: string
        enableShellIntegration?: boolean
        forceUtf8?: boolean
        sandboxed?: boolean
      }
    | undefined

  // Resolve the shell + spawn options exactly like the dock's "+ New" button so
  // the interactive command runs in the user's configured shell — and, with no
  // explicit choice, in the shell the *Host* reported rather than one guessed
  // from this client's user agent (`null`, and so the local guess, on the
  // desktop's own PTY).
  const shell = resolveDefaultShell({
    projectShell: project?.terminalConfig?.shell,
    settingShell: terminal?.defaultShell,
    hostDefaultShell: (await ensureHostCapabilities())?.defaultShell,
  })
  const resolvedCwd =
    cwd.trim() || project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined

  const outcome = await spawnFromDock({
    req: {
      shell,
      rows: 24,
      cols: 80,
      cwd: resolvedCwd,
      env:
        options.env && Object.keys(options.env).length > 0
          ? { ...project?.terminalConfig?.env, ...options.env }
          : project?.terminalConfig?.env,
      projectId: activeProjectId ?? undefined,
      enableShellIntegration: terminal?.enableShellIntegration ?? true,
      forceUtf8: terminal?.forceUtf8 ?? true,
      sandboxed: terminal?.sandboxed ?? false,
    },
    store,
    ...(options.title ? { title: options.title } : {}),
    agentSpawner: chatSessionId || undefined,
    ...spawnerMessage(chatSessionId),
  })
  if (outcome.kind !== "spawned") {
    throw new Error(
      outcome.kind === "denied"
        ? "terminal spawn was denied"
        : outcome.kind === "error"
          ? outcome.message
          : "terminal spawn failed"
    )
  }

  // Reveal + focus the dock, then pipe the command.
  store.setPanelOpen(true)
  store.setActiveSession(activeProjectId ?? null, outcome.sessionId)
  const session = getLiveSession(outcome.sessionId)
  if (session) void session.write(command + "\r")
}
