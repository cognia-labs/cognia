/**
 * Per-user plugin enable/disable overlay, persisted to
 * `~/.cognia/plugin-state.json`. The legacy `disabled[]` projection remains
 * readable for older CLIs while `lifecycle` is the canonical CAS state.
 */
import nodeFs from "node:fs"
import path from "node:path"
import type { AuthProviderOwnershipStore } from "@/lib/plugin/auth/auth-provider-registry"
import {
  PluginLifecycleRevisionError,
  type PluginLifecycleRecord,
  type PluginLifecycleStateAdapter,
} from "@/lib/plugin/core/lifecycle-state"

export interface PluginStateFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

const defaultFs: PluginStateFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, data, "utf8")
  },
}

export function pluginStatePath(home: string): string {
  return path.join(home, "plugin-state.json")
}

export interface CliPluginStateDocument {
  version: 2
  disabled: string[]
  lifecycle: Record<string, PluginLifecycleRecord>
  /** Serialized host-owned provider bindings, separate from plugin lifecycle. */
  authProviderOwners?: string
}

function emptyDocument(): CliPluginStateDocument {
  return { version: 2, disabled: [], lifecycle: {} }
}

// Ownership reads and every write must propagate corruption: recovering an
// empty document while mutating lifecycle would silently erase owner bindings.
function loadPluginState(home: string, fs: PluginStateFs): CliPluginStateDocument {
  const file = pluginStatePath(home)
  if (!fs.exists(file)) return emptyDocument()
  const parsed = JSON.parse(fs.readText(file)) as {
    disabled?: unknown
    lifecycle?: unknown
    authProviderOwners?: string
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plugin state storage is invalid")
  }
  const disabled = Array.isArray(parsed.disabled)
    ? parsed.disabled.filter((id): id is string => typeof id === "string")
    : []
  const lifecycle =
    parsed.lifecycle && typeof parsed.lifecycle === "object"
      ? (parsed.lifecycle as Record<string, PluginLifecycleRecord>)
      : {}
  return {
    version: 2,
    disabled,
    lifecycle,
    ...(Object.hasOwn(parsed, "authProviderOwners")
      ? { authProviderOwners: parsed.authProviderOwners }
      : {}),
  }
}

export function readPluginState(
  home: string,
  fs: PluginStateFs = defaultFs
): CliPluginStateDocument {
  try {
    return loadPluginState(home, fs)
  } catch {
    return emptyDocument()
  }
}

function writePluginState(home: string, document: CliPluginStateDocument, fs: PluginStateFs): void {
  fs.writeText(pluginStatePath(home), JSON.stringify(document, null, 2))
}

/** Read through on every operation; corrupt or inaccessible ownership fails closed. */
export function createCliAuthProviderOwnershipStore(
  home: string,
  fs: PluginStateFs = defaultFs
): AuthProviderOwnershipStore {
  return {
    read() {
      const value = loadPluginState(home, fs).authProviderOwners
      if (value === undefined) return null
      if (typeof value !== "string") {
        throw new Error("Auth provider ownership storage is invalid")
      }
      return value
    },
    write(value) {
      const document = loadPluginState(home, fs)
      document.authProviderOwners = value
      writePluginState(home, document, fs)
    },
  }
}

export function readDisabledPlugins(home: string, fs: PluginStateFs = defaultFs): Set<string> {
  return new Set(readPluginState(home, fs).disabled)
}

export function setPluginDisabled(
  home: string,
  id: string,
  disabled: boolean,
  fs: PluginStateFs = defaultFs
): Set<string> {
  const document = loadPluginState(home, fs)
  const set = new Set(document.disabled)
  if (disabled) set.add(id)
  else set.delete(id)
  const current = document.lifecycle[id] ?? {
    intent: "auto",
    actual: "inactive",
    revision: 0,
    updatedAt: Date.now(),
  }
  document.disabled = [...set].sort()
  document.lifecycle[id] = {
    ...current,
    intent: disabled ? "disabled" : "enabled",
    revision: current.revision + 1,
    updatedAt: Date.now(),
  }
  writePluginState(home, document, fs)
  return set
}

export function createCliPluginLifecycleStateAdapter(
  home: string,
  fs: PluginStateFs = defaultFs
): PluginLifecycleStateAdapter {
  return {
    async read(pluginId) {
      const document = readPluginState(home, fs)
      return (
        document.lifecycle[pluginId] ?? {
          intent: document.disabled.includes(pluginId) ? "disabled" : "auto",
          actual: "inactive",
          revision: 0,
          updatedAt: Date.now(),
        }
      )
    },
    async write(pluginId, expectedRevision, patch) {
      const document = loadPluginState(home, fs)
      const current =
        document.lifecycle[pluginId] ??
        ({
          intent: document.disabled.includes(pluginId) ? "disabled" : "auto",
          actual: "inactive",
          revision: 0,
          updatedAt: Date.now(),
        } satisfies PluginLifecycleRecord)
      if (current.revision !== expectedRevision) {
        throw new PluginLifecycleRevisionError(pluginId)
      }
      const next: PluginLifecycleRecord = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      }
      if (patch.dirty === undefined && "dirty" in patch) delete next.dirty
      if (patch.lastError === undefined && "lastError" in patch) delete next.lastError
      document.lifecycle[pluginId] = next
      const disabled = new Set(document.disabled)
      if (next.intent === "disabled") disabled.add(pluginId)
      else disabled.delete(pluginId)
      document.disabled = [...disabled].sort()
      writePluginState(home, document, fs)
      return next
    },
  }
}
