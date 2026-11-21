"use client"

/**
 * What the *host* said about itself, cached for the renderer.
 *
 * `lib/terminal/shell-detect.ts` answers "which shell should I spawn?" from
 * `navigator.userAgent`. On the desktop that is correct by accident — the
 * client and the host are the same machine. Over `ws` / `webrtc` they are not,
 * so a macOS browser paired to a Linux `cognia-server` asked it for `/bin/zsh`
 * and a Windows browser asked for `pwsh.exe`. Both spawns failed, and the only
 * clue was the host's `spawn_command failed`.
 *
 * The host now answers the question itself: `TerminalHostCapabilities` rides
 * the hello ack and the host snapshot (`crates/cognia-terminal/src/host_capabilities.rs`),
 * which are the two frames the renderer already receives before it can spawn
 * anything. This module holds the answer for the surfaces that need it — the
 * spawn default and the shell picker — and lets them re-render when it lands.
 *
 * Deliberately NOT persisted: the pairing can be repointed at a different
 * server between reloads, and a stale platform is worse than no platform (it
 * silently produces the exact wrong shell this module exists to prevent). The
 * cache is re-warmed on the first list/hello of every session, which the
 * reattach path performs at mount anyway.
 *
 * Every entry belongs to ONE host — both across desktop remote-host overlays
 * (ADR-0082) and across paired mobile/browser target switches (T06). Entries
 * are stamped with {@link currentTerminalHostKey} and optional `hostId` from
 * the wire frame; a host switch or a restarted host with a new `hostId`
 * invalidates stale protocol features instead of serving the previous host's.
 */

import { subscribeRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

import { currentTerminalTargetKey } from "./host-target"

/** Mirrors Rust `HostPlatform` — same four values as `ShellPlatform`. */
export type TerminalHostPlatform = "windows" | "macos" | "linux" | "other"

/** Mirrors Rust `HostShellCandidate`. */
export interface TerminalHostShell {
  /** Spawnable path / PATH-resolvable name, for `SpawnRequest.shell`. */
  path: string
  /** Shell family, in the same vocabulary as `ShellKind`. */
  kind: string
}

/** Mirrors Rust `TerminalHostCapabilities`. */
export interface TerminalHostCapabilities {
  platform: TerminalHostPlatform
  defaultShell: string
  availableShells: TerminalHostShell[]
  homeDir?: string | null
}

type Listener = () => void

/**
 * Which host the terminal transports reach right now, across both desktop
 * remote overlays and paired companion targets.
 */
export function currentTerminalHostKey(): string {
  return currentTerminalTargetKey()
}

let cached: { key: string; hostId: string | null; value: TerminalHostCapabilities } | null = null
const listeners = new Set<Listener>()
let inFlight: { key: string; promise: Promise<TerminalHostCapabilities | null> } | null = null

const PLATFORMS: ReadonlySet<string> = new Set(["windows", "macos", "linux", "other"])

function notifyListeners(): void {
  for (const listener of listeners) listener()
}

/**
 * Accept only a complete, usable answer.
 *
 * A partially-decoded capability blob is worse than none: `defaultShell: ""`
 * would be handed to the host as the shell to spawn, and the caller has no way
 * to tell that apart from a deliberate choice.
 */
export function parseHostCapabilities(value: unknown): TerminalHostCapabilities | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const platform = record.platform
  const defaultShell = record.defaultShell
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) return null
  if (typeof defaultShell !== "string" || defaultShell.trim() === "") return null
  const shells = Array.isArray(record.availableShells) ? record.availableShells : []
  const availableShells: TerminalHostShell[] = []
  for (const entry of shells) {
    if (!entry || typeof entry !== "object") continue
    const shell = entry as Record<string, unknown>
    if (typeof shell.path !== "string" || shell.path.trim() === "") continue
    availableShells.push({
      path: shell.path,
      kind: typeof shell.kind === "string" ? shell.kind : "unknown",
    })
  }
  return {
    platform: platform as TerminalHostPlatform,
    defaultShell,
    availableShells,
    homeDir: typeof record.homeDir === "string" ? record.homeDir : null,
  }
}

/**
 * Record what a hello ack or host snapshot reported. Ignores junk.
 *
 * `hostKey` is the {@link currentTerminalHostKey} the caller read before it
 * opened the connection the answer came over. An answer for a host that is no
 * longer selected is dropped. When `hostId` differs from the previously seen
 * host under the same key (for example a re-pointed custom resolver or a
 * restarted/upgraded server), any cached protocol feature list from the prior
 * host instance is invalidated so `List` cannot leave stale `Hello` features.
 */
export function recordHostCapabilities(
  value: unknown,
  hostKey: string = currentTerminalHostKey(),
  hostId?: string | null
): void {
  const normalizedHostId = typeof hostId === "string" && hostId.trim() ? hostId : null
  if (hostKey !== currentTerminalHostKey()) return

  let featuresInvalidated = false
  if (
    normalizedHostId &&
    features?.key === hostKey &&
    features.hostId !== null &&
    features.hostId !== normalizedHostId
  ) {
    features = null
    featuresInvalidated = true
  }

  const parsed = parseHostCapabilities(value)
  if (!parsed) {
    if (featuresInvalidated) notifyListeners()
    return
  }

  const previous = cached?.key === hostKey ? cached : null
  const sameCapabilities =
    previous !== null &&
    previous.value.platform === parsed.platform &&
    previous.value.defaultShell === parsed.defaultShell &&
    (previous.value.homeDir ?? null) === (parsed.homeDir ?? null) &&
    previous.value.availableShells.length === parsed.availableShells.length &&
    previous.value.availableShells.every(
      (shell, index) =>
        shell.path === parsed.availableShells[index].path &&
        shell.kind === parsed.availableShells[index].kind
    )
  const nextHostId = normalizedHostId ?? previous?.hostId ?? null
  if (sameCapabilities && previous?.hostId === nextHostId) {
    if (featuresInvalidated) notifyListeners()
    return
  }
  cached = { key: hostKey, hostId: nextHostId, value: parsed }
  if (!sameCapabilities || featuresInvalidated) {
    notifyListeners()
  }
}

/** The selected host's answer, or null when it has not introduced itself yet. */
export function getHostCapabilities(): TerminalHostCapabilities | null {
  return cached && cached.key === currentTerminalHostKey() ? cached.value : null
}

/** Last durable `hostId` observed for the currently selected host, if any. */
export function getObservedTerminalHostId(): string | null {
  const key = currentTerminalHostKey()
  if (cached?.key === key && cached.hostId) return cached.hostId
  if (features?.key === key && features.hostId) return features.hostId
  return null
}

/**
 * Hear when the host answers — and when the selected desktop remote host or
 * paired runtime target changes, since every cached answer then stops applying.
 */
export function subscribeHostCapabilities(listener: Listener): () => void {
  listeners.add(listener)
  const offRouting = subscribeActiveRemoteTransport(() => listener())
  const offScope = subscribeRuntimeTargetContext(() => listener())
  return () => {
    listeners.delete(listener)
    offRouting()
    offScope()
  }
}

function runHostHelloProbe(key: string): Promise<TerminalHostCapabilities | null> {
  if (inFlight && inFlight.key === key) return inFlight.promise
  const entry: { key: string; promise: Promise<TerminalHostCapabilities | null> } = {
    key,
    promise: Promise.resolve(null),
  }
  entry.promise = (async () => {
    try {
      const { selectTerminalTransportChain } = await import("./pick-transport")
      const chain = selectTerminalTransportChain()
      if (chain.length === 0 || chain[0] === "tauri-channel") return null
      const { RemoteTerminalSession } = await import("./transport-ws")
      await RemoteTerminalSession.describeHost(key)
      return cached && cached.key === key ? cached.value : null
    } catch {
      return null
    } finally {
      if (inFlight === entry) inFlight = null
    }
  })()
  inFlight = entry
  return entry.promise
}

/**
 * The cached answer, asking the host once when it is cold.
 *
 * Callers are on the spawn path, so this must never throw: a host that cannot
 * be reached returns `null` and the caller falls back to its own guess.
 */
export async function ensureHostCapabilities(): Promise<TerminalHostCapabilities | null> {
  const key = currentTerminalHostKey()
  const warm = getHostCapabilities()
  if (warm) return warm
  return runHostHelloProbe(key)
}

/**
 * Protocol features the host advertised in its hello ack.
 *
 * Only the hello ack carries this (`only_the_hello_ack_carries_the_host_description`).
 */
export type TerminalProtocolFeature =
  | "pathInjection"
  | "flowControl"
  | "history"
  | "sshForwarding"
  | "workspaceEnvBridge"
  | "idempotentSpawn"

let features: { key: string; hostId: string | null; value: readonly string[] } | null = null

/**
 * Record the ack's feature list.
 */
export function recordProtocolFeatures(
  value: unknown,
  hostKey: string = currentTerminalHostKey(),
  hostId?: string | null
): void {
  if (!Array.isArray(value)) return
  if (hostKey !== currentTerminalHostKey()) return
  const normalizedHostId = typeof hostId === "string" && hostId.trim() ? hostId : null
  const next = value.filter((entry): entry is string => typeof entry === "string")
  const previous = features?.key === hostKey ? features : null
  const nextHostId = normalizedHostId ?? previous?.hostId ?? null
  if (
    previous &&
    previous.hostId === nextHostId &&
    previous.value.length === next.length &&
    previous.value.every((f, i) => f === next[i])
  ) {
    return
  }
  const valueChanged =
    !previous ||
    previous.value.length !== next.length ||
    !previous.value.every((f, i) => f === next[i])
  features = { key: hostKey, hostId: nextHostId, value: next }
  if (valueChanged) {
    notifyListeners()
  }
}

/**
 * What the host said it speaks, or `null` when no host has introduced itself.
 */
export function getProtocolFeatures(): readonly string[] | null {
  return features && features.key === currentTerminalHostKey() ? features.value : null
}

/**
 * Whether the host named `feature`.
 *
 * Unknown hosts answer `true`. A host that never introduced itself is the
 * local PTY or a probe that has not run yet.
 */
export function hostSupportsProtocolFeature(feature: TerminalProtocolFeature): boolean {
  const known = getProtocolFeatures()
  if (known === null) return true
  return known.includes(feature)
}

/**
 * The cached feature list, running the `Hello` probe when features are still
 * unknown — even if `List` already warmed shell capabilities without `Hello`.
 */
export async function ensureProtocolFeatures(): Promise<readonly string[] | null> {
  const known = getProtocolFeatures()
  if (known) return known
  const key = currentTerminalHostKey()
  await runHostHelloProbe(key)
  return getProtocolFeatures()
}

/** Test-only: forget the host so a re-stubbed one is observed. */
export function __resetHostCapabilitiesForTests(): void {
  cached = null
  features = null
  inFlight = null
  listeners.clear()
}
