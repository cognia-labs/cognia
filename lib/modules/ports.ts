// Capability ports: the kernel's seam for an interchangeable implementation
// (ADR-0250 §14).
//
// The kernel declares a port: a contract in `types/modules/ports/<id>.ts`
// that augments `PortMap`
//
//   declare module "@/lib/modules/ports" {
//     interface PortMap { speech: SpeechPort }
//   }
//
// A module (later a plugin) implements it and says so in its host manifest,
// `provides: [{ port: "speech", load: () => import("./port") }]`, where the
// loaded file exports `port`. A user asks for the port by id and never imports
// the implementation, so the dependency points at this file and at the
// contract's types, and the implementation can be swapped or extracted
// without touching its users. A manifest module that asks for a port names it
// in `requires` (`"speech?"` when it copes without one); the module gate checks
// both ends (G4, G5).
//
// The implementation loads lazily on first use, once per JavaScript realm. A
// port no active module provides resolves to `null`, which every user treats
// as "this capability is not available here": an `experimental` provider
// contributes nothing (Rule 7), as for every other registry.

import type { HostModuleManifest, ModulePortModule } from "./manifest-types"
import { activeHostModules } from "./registry"

/** Every port's id and contract. Each contract file adds its own entry. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by port contracts
export interface PortMap {}

export type PortId = keyof PortMap

let moduleSource: () => readonly HostModuleManifest[] = () => activeHostModules()

/** Resolved implementations: a value, or `null` when no module provides the port. */
const resolved = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error("[ports] a listener threw", error)
    }
  }
}

/**
 * The active module that provides `id`, or `null`. The module gate allows one
 * provider per port; two at runtime is a broken build, not a choice to make.
 */
export function portProvider(id: string): { module: string; load: () => Promise<unknown> } | null {
  const found: { module: string; load: () => Promise<unknown> }[] = []
  for (const manifest of moduleSource())
    for (const provision of manifest.provides ?? [])
      if (provision.port === id) found.push({ module: manifest.id, load: provision.load })
  if (found.length > 1)
    throw new Error(
      `[ports] "${id}" is provided by ${found.map((p) => `"${p.module}"`).join(" and ")}; a port has one provider`
    )
  return found[0] ?? null
}

/**
 * The port's implementation, loading it on first use; `null` when no active
 * module provides it. A failed load is not remembered, so the next call tries
 * again.
 */
export function loadPort<K extends PortId>(id: K): Promise<PortMap[K] | null> {
  if (resolved.has(id)) return Promise.resolve(resolved.get(id) as PortMap[K] | null)
  const inFlight = pending.get(id)
  if (inFlight) return inFlight as Promise<PortMap[K] | null>
  const provider = portProvider(id)
  if (!provider) {
    resolved.set(id, null)
    notify()
    return Promise.resolve(null)
  }
  const promise = provider
    .load()
    .then((loaded) => {
      const port = (loaded as Partial<ModulePortModule> | undefined)?.port
      if (port === undefined || port === null)
        throw new Error(
          `[ports] "${provider.module}" provides "${id}" but its file exports no port`
        )
      resolved.set(id, port)
      pending.delete(id)
      notify()
      return port as PortMap[K]
    })
    .catch((error: unknown) => {
      pending.delete(id)
      throw error
    })
  pending.set(id, promise)
  return promise
}

/**
 * The port as far as this realm knows it now: the implementation, `null` when
 * no module provides it, or `undefined` while it has not loaded yet.
 */
export function readPort<K extends PortId>(id: K): PortMap[K] | null | undefined {
  return resolved.get(id) as PortMap[K] | null | undefined
}

/** Hear every port that finishes resolving. Returns the unsubscribe function. */
export function subscribePorts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper: answer a port with `value` (`null`: not provided) without loading anything. */
export function __setPortForTesting<K extends PortId>(id: K, value: PortMap[K] | null): void {
  pending.delete(id)
  resolved.set(id, value)
  notify()
}

/** Test helper: read providers from `modules` instead of the generated registry. */
export function __setPortModulesForTesting(modules: readonly HostModuleManifest[] | null): void {
  moduleSource = modules ? () => modules : () => activeHostModules()
}

/** Test helper: forget every resolved port, pending load and listener. */
export function __resetPortsForTesting(): void {
  resolved.clear()
  pending.clear()
  listeners.clear()
  moduleSource = () => activeHostModules()
}
