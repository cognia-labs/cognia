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
//
// A collection port has many providers instead of one: each vendor that
// implements the capability is its own module (cloud documents: Google Docs,
// Lark Docs). Its contract augments `PortCollectionMap`, every active module
// providing it adds one member, and its framework loads them all with
// `loadPortCollection`. One member that fails to load does not hide the
// others.

import type { HostModuleManifest, ModulePortModule } from "./manifest-types"
import { activeHostModules } from "./registry"

/** Every port's id and contract. Each contract file adds its own entry. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by port contracts
export interface PortMap {}

export type PortId = keyof PortMap

/** Every collection port's id and the contract of one member. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by port contracts
export interface PortCollectionMap {}

export type PortCollectionId = keyof PortCollectionMap

/** One loaded member of a collection port, and the module that provides it. */
export interface PortCollectionMember<K extends PortCollectionId> {
  module: string
  port: PortCollectionMap[K]
}

/** A collection port's members, and the providers whose file failed to load. */
export interface PortCollectionLoad<K extends PortCollectionId> {
  members: readonly PortCollectionMember<K>[]
  failures: readonly { module: string; error: unknown }[]
}

let moduleSource: () => readonly HostModuleManifest[] = () => activeHostModules()

/** Resolved implementations: a value, or `null` when no module provides the port. */
const resolved = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()
/** Loaded collection members, keyed by port and then by providing module. */
const members = new Map<string, Map<string, unknown>>()
const memberLoads = new Map<string, Promise<unknown>>()

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

/** Every active module that provides the collection port `id`, in registry order. */
export function portCollectionProviders(
  id: string
): { module: string; load: () => Promise<unknown> }[] {
  const found: { module: string; load: () => Promise<unknown> }[] = []
  for (const manifest of moduleSource())
    for (const provision of manifest.provides ?? [])
      if (provision.port === id) found.push({ module: manifest.id, load: provision.load })
  return found
}

function loadMember(id: string, provider: { module: string; load: () => Promise<unknown> }) {
  const key = `${id}\u0000${provider.module}`
  const inFlight = memberLoads.get(key)
  if (inFlight) return inFlight
  const promise = provider
    .load()
    .then((loaded) => {
      const port = (loaded as Partial<ModulePortModule> | undefined)?.port
      if (port === undefined || port === null)
        throw new Error(
          `[ports] "${provider.module}" provides "${id}" but its file exports no port`
        )
      if (!members.has(id)) members.set(id, new Map())
      members.get(id)!.set(provider.module, port)
      memberLoads.delete(key)
      notify()
      return port
    })
    .catch((error: unknown) => {
      memberLoads.delete(key)
      throw error
    })
  memberLoads.set(key, promise)
  return promise
}

/**
 * Every member of a collection port, loading the ones not loaded yet. A
 * provider whose file fails to load is reported in `failures` and tried again
 * on the next call; the other members still arrive.
 */
export async function loadPortCollection<K extends PortCollectionId>(
  id: K
): Promise<PortCollectionLoad<K>> {
  const providers = portCollectionProviders(id)
  const settled = await Promise.allSettled(
    providers.map((provider) => {
      const known = members.get(id)?.get(provider.module)
      return known === undefined ? loadMember(id, provider) : Promise.resolve(known)
    })
  )
  const loaded: PortCollectionMember<K>[] = []
  const failures: { module: string; error: unknown }[] = []
  settled.forEach((outcome, index) => {
    const provider = providers[index].module
    if (outcome.status === "fulfilled")
      loaded.push({ module: provider, port: outcome.value as PortCollectionMap[K] })
    else failures.push({ module: provider, error: outcome.reason })
  })
  return { members: loaded, failures }
}

/** The members of a collection port loaded so far in this realm, in registry order. */
export function readPortCollection<K extends PortCollectionId>(
  id: K
): readonly PortCollectionMember<K>[] {
  const loaded = members.get(id)
  if (!loaded) return []
  return portCollectionProviders(id)
    .filter((provider) => loaded.has(provider.module))
    .map((provider) => ({
      module: provider.module,
      port: loaded.get(provider.module) as PortCollectionMap[K],
    }))
}

/** Hear every port and collection member that finishes resolving. Returns the unsubscribe function. */
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
  members.clear()
  memberLoads.clear()
  listeners.clear()
  moduleSource = () => activeHostModules()
}
