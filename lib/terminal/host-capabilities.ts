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
 * For the same reason the cache belongs to ONE host. A desktop can switch the
 * Host it drives (ADR-0082) without reloading; an answer recorded for Linux
 * host A must not be handed out once Windows host B — or the desktop's own
 * PTY — is selected. Every entry is stamped with {@link currentTerminalHostKey}
 * as it stood when the probe or list *started*, a read under a different key
 * is a miss, and an answer that arrives for a host no longer selected is
 * dropped rather than recorded against the new one.
 */

import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"

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
 * Which host the terminal transports reach right now.
 *
 * `"default"` is the host this shell talks to with no remote selected: the
 * desktop's local PTY, or the paired server of a phone or browser. A desktop
 * driving a remote Host gets one key per installed remote transport — the
 * routing holder installs a fresh transport for every switch, so the object's
 * identity is the switch, even back to a Host used before.
 */
const remoteKeys = new WeakMap<object, string>()
let nextRemoteKey = 1

export function currentTerminalHostKey(): string {
  const remote = getActiveRemoteTransport()
  if (!remote) return "default"
  let key = remoteKeys.get(remote)
  if (!key) {
    key = `remote:${nextRemoteKey++}`
    remoteKeys.set(remote, key)
  }
  return key
}

let cached: { key: string; value: TerminalHostCapabilities } | null = null
const listeners = new Set<Listener>()
let inFlight: { key: string; promise: Promise<TerminalHostCapabilities | null> } | null = null

const PLATFORMS: ReadonlySet<string> = new Set(["windows", "macos", "linux", "other"])

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
 * longer selected is dropped. Omitted, the answer is taken to describe the
 * current host.
 */
export function recordHostCapabilities(
  value: unknown,
  hostKey: string = currentTerminalHostKey()
): void {
  const parsed = parseHostCapabilities(value)
  if (!parsed) return
  if (hostKey !== currentTerminalHostKey()) return
  const previous = cached?.key === hostKey ? cached.value : null
  if (
    previous &&
    previous.platform === parsed.platform &&
    previous.defaultShell === parsed.defaultShell &&
    previous.availableShells.length === parsed.availableShells.length &&
    previous.availableShells.every(
      (shell, index) => shell.path === parsed.availableShells[index].path
    )
  ) {
    return
  }
  cached = { key: hostKey, value: parsed }
  for (const listener of listeners) listener()
}

/** The selected host's answer, or null when it has not introduced itself yet. */
export function getHostCapabilities(): TerminalHostCapabilities | null {
  return cached && cached.key === currentTerminalHostKey() ? cached.value : null
}

/**
 * Hear when the host answers — and when the selected host changes, since every
 * cached answer then stops applying and a reader must re-read (and re-probe).
 */
export function subscribeHostCapabilities(listener: Listener): () => void {
  listeners.add(listener)
  const offRouting = subscribeActiveRemoteTransport(() => listener())
  return () => {
    listeners.delete(listener)
    offRouting()
  }
}

/**
 * The cached answer, asking the host once when it is cold.
 *
 * Callers are on the spawn path, so this must never throw: a host that cannot
 * be reached returns `null` and the caller falls back to its own guess, which
 * is exactly the pre-existing behaviour.
 *
 * Concurrent callers share one probe — the dock's "+ New" and the shell picker
 * opening together must not each pay a socket ticket and a WebSocket.
 */
export async function ensureHostCapabilities(): Promise<TerminalHostCapabilities | null> {
  const key = currentTerminalHostKey()
  const warm = getHostCapabilities()
  if (warm) return warm
  // A probe still running for the previous host answers for that host only.
  if (inFlight && inFlight.key === key) return inFlight.promise
  const entry: { key: string; promise: Promise<TerminalHostCapabilities | null> } = {
    key,
    promise: Promise.resolve(null),
  }
  entry.promise = (async () => {
    try {
      const { selectTerminalTransportChain } = await import("./pick-transport")
      const chain = selectTerminalTransportChain()
      // The local PTY is the host; `shell-detect` is already right there, and
      // opening a remote probe would be nonsense.
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
 * Protocol features the host advertised in its hello ack.
 *
 * Rust holds the list in `crates/cognia-terminal/src/host_wire.rs:PROTOCOL_FEATURES`
 * and `protocol.rs` makes it load-bearing: a client rejects an unmapped frame
 * discriminant outright, so a newer host must not push a kind an older client
 * has never heard of. The negotiation channel has been on the wire since the
 * beginning and nothing in TypeScript read it, which meant "does this host
 * speak frames 24/25?" could only be answered by trying and failing.
 *
 * Only the hello ack carries this (Rust pins that with
 * `only_the_hello_ack_carries_the_host_description`), so it warms on the same
 * probe as the host description and shares its in-flight promise.
 */
export type TerminalProtocolFeature = "pathInjection" | "flowControl" | "history" | "sshForwarding"

let features: { key: string; value: readonly string[] } | null = null

/**
 * Record the ack's feature list.
 *
 * An unknown string is kept rather than dropped: the question callers ask is
 * "did the host name this feature", and a build that has not heard of a newer
 * feature name still answers that correctly for the ones it knows.
 */
export function recordProtocolFeatures(
  value: unknown,
  hostKey: string = currentTerminalHostKey()
): void {
  if (!Array.isArray(value)) return
  if (hostKey !== currentTerminalHostKey()) return
  const next = value.filter((entry): entry is string => typeof entry === "string")
  const previous = features?.key === hostKey ? features.value : null
  if (previous && previous.length === next.length && previous.every((f, i) => f === next[i])) {
    return
  }
  features = { key: hostKey, value: next }
  for (const listener of listeners) listener()
}

/**
 * What the host said it speaks, or `null` when no host has introduced itself.
 *
 * `null` is deliberately not the empty list. "The host has not said" and "the
 * host named nothing" lead to opposite decisions: the first should fall back to
 * trying, the second should not.
 */
export function getProtocolFeatures(): readonly string[] | null {
  return features && features.key === currentTerminalHostKey() ? features.value : null
}

/**
 * Whether the host named `feature`.
 *
 * Unknown hosts answer `true`. A host that never introduced itself is the
 * local PTY or a probe that has not run yet, and refusing a capability the
 * host may well have would turn a missing probe into a missing feature.
 */
export function hostSupportsProtocolFeature(feature: TerminalProtocolFeature): boolean {
  const known = getProtocolFeatures()
  if (known === null) return true
  return known.includes(feature)
}

/** The cached feature list, running the host probe once when it is cold. */
export async function ensureProtocolFeatures(): Promise<readonly string[] | null> {
  const known = getProtocolFeatures()
  if (known) return known
  await ensureHostCapabilities()
  return getProtocolFeatures()
}

/** Test-only: forget the host so a re-stubbed one is observed. */
export function __resetHostCapabilitiesForTests(): void {
  cached = null
  features = null
  inFlight = null
  listeners.clear()
}
