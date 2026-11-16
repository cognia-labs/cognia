// Where a composer `#` capture should be written.
//
// Two unrelated kinds of destination:
//   - a file scope, "project" | "user": a line appended to the instruction file
//     a turn loads (`lib/agents/instructions/append-memory.ts`)
//   - a store scope, "global" | "workspace" (of "global" | "workspace" |
//     "character" | "agent"): the ADR-0069 learned-memory store, all platforms
//
// They are not interchangeable, so this module models the choice as a
// discriminated union rather than flattening both into one string union — which
// would let a file scope be passed to the store write and vice versa.

import type { InstructionMemoryScope as FileMemoryScope } from "@/lib/agents/instructions/append-memory"
import type { TaskWorkspaceOrigin } from "@/lib/task-workspace/types"
import type { MemoryScope as StoreMemoryScope } from "@/types/memory/memory"

/** Long-term-store scopes the `#` picker offers. The remaining store scopes
 * (`character`, `agent`) are derived from session context, never picked by
 * hand, so they are deliberately absent here. */
export type PickableStoreScope = Extract<StoreMemoryScope, "global" | "workspace">

export type ComposerMemoryTarget =
  { target: "file"; scope: FileMemoryScope } | { target: "store"; scope: PickableStoreScope }

/** The four rows the `#` popover offers, in display order. */
export const COMPOSER_MEMORY_TARGETS: readonly ComposerMemoryTarget[] = [
  { target: "store", scope: "global" },
  { target: "store", scope: "workspace" },
  { target: "file", scope: "project" },
  { target: "file", scope: "user" },
]

/** Stable key for React lists, persistence and equality checks. */
export function memoryTargetKey(target: ComposerMemoryTarget): string {
  return `${target.target}:${target.scope}`
}

/**
 * Parse a {@link memoryTargetKey} back into a target. Returns null for anything
 * unrecognised, so a stale persisted value degrades to "ask the user" rather
 * than writing to the wrong place.
 */
export function parseMemoryTargetKey(key: string | null | undefined): ComposerMemoryTarget | null {
  if (!key) return null
  return COMPOSER_MEMORY_TARGETS.find((t) => memoryTargetKey(t) === key) ?? null
}

/**
 * Whether this window can write the instruction files the conversation's turns
 * load. `remote-host`: the turns run on a remote Host, whose files this window
 * does not reach yet. `desktop-only`: no project filesystem here at all.
 */
export type MemoryFilesAccess = "available" | "desktop-only" | "remote-host"

export function resolveMemoryFilesAccess(input: {
  isDesktop: boolean
  /** The conversation's `hostBinding.origin`; absent before its first send. */
  boundOrigin?: TaskWorkspaceOrigin
  /** The desktop drives a remote Host, so workspace-file calls go there. */
  drivingRemoteHost: boolean
}): MemoryFilesAccess {
  if (!input.isDesktop) return "desktop-only"
  if (input.boundOrigin?.kind === "remote" || input.drivingRemoteHost) return "remote-host"
  return "available"
}

/** Store writes work everywhere; file writes need {@link resolveMemoryFilesAccess}. */
export function isMemoryTargetAvailable(
  target: ComposerMemoryTarget,
  filesAccess: MemoryFilesAccess
): boolean {
  return target.target === "store" || filesAccess === "available"
}

/** The `chat.composer.memory` key explaining an unavailable file target. */
export function memoryFilesUnavailableKey(
  filesAccess: MemoryFilesAccess
): "desktopOnly" | "remoteHost" | null {
  return filesAccess === "available"
    ? null
    : filesAccess === "remote-host"
      ? "remoteHost"
      : "desktopOnly"
}
