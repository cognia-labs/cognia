import type { ChatSession } from "@cognia/agent-config-types"
import type { TaskWorkspaceOrigin } from "@/lib/task-workspace/types"
import {
  captureTaskWorkspaceOrigin,
  callTaskWorkspaceOrigin,
  sameTaskWorkspaceOrigin,
} from "@/lib/task-workspace/origin"
import { getSession, updateSessionHostBinding } from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import {
  getRuntimeSnapshot,
  runtimeHostSnapshotFromManifest,
  subscribeRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { resolveOperationAvailability } from "@/lib/runtime/operation-availability"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { ExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { runtimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { isTauri, isHeadlessHost } from "@/lib/platform/detect"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import { resolveEffectiveCwdForSession } from "@/lib/chat/session-effective-cwd"

export type SessionHostBinding = NonNullable<ChatSession["hostBinding"]>
export type SessionHostDecision = "bind" | "ok" | "switch-required" | "host-unavailable"
export interface SessionHostLiveState {
  online: boolean
  connectionState: string
  capable: boolean
}

/** No I/O, fallback or per-turn routing. Account identity is part of the Host. */
export function assessSessionHostBinding(
  binding: SessionHostBinding | undefined,
  active: TaskWorkspaceOrigin,
  live: SessionHostLiveState
): SessionHostDecision {
  if (!binding) return "bind"
  if (!sameTaskWorkspaceOrigin(binding.origin, active)) return "switch-required"
  return live.online && live.connectionState === "ready" && live.capable ? "ok" : "host-unavailable"
}

/** Read current evidence, never the registry's cached last-connected timestamp. */
export function sessionHostLiveState(origin: TaskWorkspaceOrigin): SessionHostLiveState {
  if (origin.kind === "local") {
    const available = isTauri() || isHeadlessHost() || isStandaloneChatMode()
    return {
      online: available,
      connectionState: available ? "ready" : "disconnected",
      capable: available,
    }
  }
  if (origin.hostId.startsWith("companion:")) {
    const snapshot = getRuntimeSnapshot()
    const online =
      snapshot.target?.kind === "companion" &&
      `companion:${snapshot.target.id}` === origin.hostId &&
      snapshot.connectionState === "online"
    return {
      online,
      connectionState: online ? "ready" : snapshot.connectionState,
      // agent_send is this checkout's execution-target send operation.
      capable:
        resolveOperationAvailability({ snapshot, command: "agent_send" }).state === "available",
    }
  }
  const host = useRemoteHostStore
    .getState()
    .hosts.find((candidate) => candidate.id === origin.hostId)
  return {
    online: host?.connectionState === "ready",
    connectionState: host?.connectionState ?? "disconnected",
    capable:
      host?.capabilities?.includes("sidecar") === true &&
      (!host.featureManifest ||
        resolveOperationAvailability({
          command: "agent_send",
          snapshot: {
            target: { kind: "companion", id: host.id, hostKind: "desktop", platform: "web" },
            vaultState: "unlocked",
            connectionState: host.connectionState === "ready" ? "online" : "offline",
            host: runtimeHostSnapshotFromManifest(host.featureManifest),
          },
        }).state === "available"),
  }
}

export function subscribeSessionHostTarget(listener: () => void): () => void {
  const unsubscribe = [
    useRemoteHostStore.subscribe(listener),
    subscribeRuntimeSnapshot(listener),
    subscribeRuntimeTargetContext(listener),
  ]
  return () => unsubscribe.forEach((close) => close())
}

/** Workspace roots are read on the named authority, even when it isn't active. */
export async function sessionHostWorkspaceRoots(origin: TaskWorkspaceOrigin): Promise<string[]> {
  const report = await callTaskWorkspaceOrigin<{ roots?: unknown }>(
    origin,
    "fs_workspace_roots",
    {}
  )
  if (!report || !Array.isArray(report.roots)) return []
  return report.roots.flatMap((root: unknown) => {
    if (!root || typeof root !== "object") return []
    const row = root as { path?: unknown; source?: unknown }
    return typeof row.path === "string" &&
      row.path.length > 0 &&
      (row.source === "desktop-project" || row.source === "headless-workspaces-dir")
      ? [row.path]
      : []
  })
}

export function sessionHostOriginForId(hostId: string | null): TaskWorkspaceOrigin {
  const accountId = getActiveRuntimeTargetContext()?.accountId
  return hostId === null
    ? { kind: "local" }
    : {
        kind: "remote",
        hostId,
        ...(accountId ? { accountId } : {}),
      }
}

/** Hydration can delay activation beyond requestSwitch's callback. */
export function switchSessionHostTarget(
  origin: TaskWorkspaceOrigin,
  requestSwitch: ExecutionHostSwitch["requestSwitch"],
  signal?: AbortSignal
): Promise<boolean> {
  if (
    signal?.aborted ||
    (origin.kind === "remote" && origin.accountId !== getActiveRuntimeTargetContext()?.accountId)
  )
    return Promise.resolve(false)
  return new Promise((resolve) => {
    let accepted = false
    let done = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (switched: boolean) => {
      if (done) return
      done = true
      unsubscribe()
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      resolve(switched)
    }
    const check = () => {
      if (accepted && sameTaskWorkspaceOrigin(origin, captureTaskWorkspaceOrigin())) finish(true)
    }
    const abort = () => finish(false)
    const unsubscribe = subscribeSessionHostTarget(check)
    signal?.addEventListener("abort", abort, { once: true })
    void requestSwitch(origin.kind === "local" ? null : origin.hostId, {
      onSwitched: () => {
        if (done) return
        accepted = true
        // Human confirmation has no deadline. Only delayed activation does.
        timeout = setTimeout(() => finish(false), 30_000)
        check()
      },
      onSettled: (switched) => {
        if (!switched) finish(false)
      },
    }).then(
      (outcome) => {
        if (outcome === "unknown-host") finish(false)
      },
      () => finish(false)
    )
  })
}

export interface SessionHostPrompt {
  sessionId: string
  binding: SessionHostBinding
  decision: "switch-required" | "host-unavailable"
}
export type SessionHostPromptHandler = (prompt: SessionHostPrompt) => Promise<boolean>

// The composer's prompt registers itself (`session-host-prompt.tsx`), so this
// kernel file never imports the chat UI. Without a handler nobody can answer,
// and a send that needs an answer is refused rather than sent elsewhere.
let promptHandler: SessionHostPromptHandler | null = null

/** Install the UI that asks the person; returns the uninstall. */
export function registerSessionHostPromptHandler(handler: SessionHostPromptHandler): () => void {
  promptHandler = handler
  return () => {
    if (promptHandler === handler) promptHandler = null
  }
}

/** Await a user choice before admission; re-read all authority after every await. */
export async function guardSessionHostSend(
  sessionId: string,
  prompt: SessionHostPromptHandler
): Promise<TaskWorkspaceOrigin | false> {
  const db = getDb()
  for (;;) {
    const session = await getSession(sessionId)
    if (!session || getDb() !== db) return false
    const active = captureTaskWorkspaceOrigin()
    const decision = assessSessionHostBinding(
      session.hostBinding,
      active,
      sessionHostLiveState(active)
    )
    if (decision === "bind") {
      // Preserve the existing execution model on first binding. An explicit
      // later Host/workspace choice clears the old Host's handles in sessions.ts.
      let root = session.executionContext
        ? resolveSessionWorkspaceRoot(session.executionContext)
        : session.workingDir
      if (active.kind === "local")
        root ??= (await resolveEffectiveCwdForSession(session)) ?? undefined
      if (active.kind === "remote") {
        const roots = sessionHostLiveState(active).online
          ? await sessionHostWorkspaceRoots(active).catch(() => [])
          : []
        root = roots.includes(root ?? "") ? root : roots[0]
      }
      if (getDb() !== db || !sameTaskWorkspaceOrigin(active, captureTaskWorkspaceOrigin()))
        return false
      await updateSessionHostBinding(
        sessionId,
        { origin: active, ...(root ? { workspaceRoot: root } : {}) },
        { onlyIfUnbound: true }
      )
      continue
    }
    const binding = session.hostBinding!
    if (decision === "ok") return binding.origin
    if (!(await prompt({ sessionId, binding, decision }))) return false
    if (getDb() !== db) return false
  }
}

/** Public built-in sends only; lease-owned continuations bypass this entry. */
export interface SessionHostSendPermit {
  origin: TaskWorkspaceOrigin
  isCurrent(): Promise<boolean>
}

export async function guardBuiltinSessionHostSend(
  sessionId: string
): Promise<SessionHostSendPermit | false | undefined> {
  if (runtimeRefForSession(sessionId).kind !== "builtin") return undefined
  const db = getDb()
  const origin = await guardSessionHostSend(sessionId, async (prompt) =>
    promptHandler ? promptHandler(prompt) : false
  )
  if (origin === false || getDb() !== db) return false
  return {
    origin,
    async isCurrent() {
      if (getDb() !== db) return false
      const session = await getSession(sessionId)
      return (
        getDb() === db &&
        Boolean(
          session?.hostBinding &&
          sameTaskWorkspaceOrigin(origin, session.hostBinding.origin) &&
          assessSessionHostBinding(
            session.hostBinding,
            captureTaskWorkspaceOrigin(),
            sessionHostLiveState(origin)
          ) === "ok"
        )
      )
    },
  }
}
