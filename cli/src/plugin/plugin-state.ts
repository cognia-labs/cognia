/**
 * Per-user plugin enable/disable overlay, persisted to
 * `~/.cognia/plugin-state.json`. `lifecycle` is the canonical CAS state.
 */
import nodeFs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { withCliFileLockSync } from "./file-lock"
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
  rename(from: string, to: string): void
  remove(path: string): void
  withLock<T>(home: string, task: (assertHeld: () => void) => T): T
}

const defaultFs: PluginStateFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    const fd = nodeFs.openSync(p, "wx", 0o600)
    try {
      nodeFs.fchmodSync(fd, 0o600)
      nodeFs.writeFileSync(fd, data, "utf8")
      nodeFs.fsyncSync(fd)
    } finally {
      nodeFs.closeSync(fd)
    }
  },
  rename: (from, to) => nodeFs.renameSync(from, to),
  remove: (p) => {
    try {
      nodeFs.unlinkSync(p)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  },
  withLock: (home, task) => withCliFileLockSync(home, "plugin-state", task, "plugin-state"),
}

export function pluginStatePath(home: string): string {
  return path.join(home, "plugin-state.json")
}

export interface CliPluginStateDocument {
  version: 2
  lifecycle: Record<string, PluginLifecycleRecord>
  /** Serialized host-owned provider bindings, separate from plugin lifecycle. */
  authProviderOwners?: string
}

function emptyDocument(): CliPluginStateDocument {
  return { version: 2, lifecycle: {} }
}

// Ownership reads and every write must propagate corruption: recovering an
// empty document while mutating lifecycle would silently erase owner bindings.
function loadPluginState(home: string, fs: PluginStateFs): CliPluginStateDocument {
  const file = pluginStatePath(home)
  if (!fs.exists(file)) return emptyDocument()
  const parsed = JSON.parse(fs.readText(file)) as {
    lifecycle?: unknown
    authProviderOwners?: string
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plugin state storage is invalid")
  }
  const lifecycle =
    parsed.lifecycle && typeof parsed.lifecycle === "object"
      ? (parsed.lifecycle as Record<string, PluginLifecycleRecord>)
      : {}
  return {
    version: 2,
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

function writePluginState(
  home: string,
  document: CliPluginStateDocument,
  fs: PluginStateFs,
  assertHeld: () => void
): void {
  const file = pluginStatePath(home)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeText(temporary, JSON.stringify(document, null, 2))
    assertHeld()
    fs.rename(temporary, file)
  } finally {
    fs.remove(temporary)
  }
}

/** Read through on every operation; corrupt or inaccessible ownership fails closed. */
export function createCliAuthProviderOwnershipStore(
  home: string,
  fs: PluginStateFs = defaultFs
): AuthProviderOwnershipStore {
  function ownershipValue(document: CliPluginStateDocument): string | null {
    const value = document.authProviderOwners
    if (value === undefined) return null
    if (typeof value !== "string") throw new Error("Auth provider ownership storage is invalid")
    return value
  }
  return {
    read() {
      return ownershipValue(loadPluginState(home, fs))
    },
    write(value) {
      fs.withLock(home, (assertHeld) => {
        const document = loadPluginState(home, fs)
        document.authProviderOwners = value
        writePluginState(home, document, fs, assertHeld)
      })
    },
    update(transform) {
      fs.withLock(home, (assertHeld) => {
        const document = loadPluginState(home, fs)
        const current = ownershipValue(document)
        const next = transform(current)
        if (next === current) return
        if (next === null) delete document.authProviderOwners
        else document.authProviderOwners = next
        writePluginState(home, document, fs, assertHeld)
      })
    },
  }
}

function disabledPlugins(document: CliPluginStateDocument): Set<string> {
  return new Set(
    Object.entries(document.lifecycle)
      .filter(([, record]) => record.intent === "disabled")
      .map(([id]) => id)
  )
}

export function readDisabledPlugins(home: string, fs: PluginStateFs = defaultFs): Set<string> {
  return disabledPlugins(readPluginState(home, fs))
}

export function setPluginDisabled(
  home: string,
  id: string,
  disabled: boolean,
  fs: PluginStateFs = defaultFs
): Set<string> {
  return fs.withLock(home, (assertHeld) => {
    const document = loadPluginState(home, fs)
    const current = document.lifecycle[id] ?? {
      intent: "auto",
      actual: "inactive",
      revision: 0,
      updatedAt: Date.now(),
    }
    document.lifecycle[id] = {
      ...current,
      intent: disabled ? "disabled" : "enabled",
      revision: current.revision + 1,
      updatedAt: Date.now(),
    }
    writePluginState(home, document, fs, assertHeld)
    return disabledPlugins(document)
  })
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
          intent: "auto",
          actual: "inactive",
          revision: 0,
          updatedAt: Date.now(),
        }
      )
    },
    async write(pluginId, expectedRevision, patch) {
      return fs.withLock(home, (assertHeld) => {
        const document = loadPluginState(home, fs)
        const current =
          document.lifecycle[pluginId] ??
          ({
            intent: "auto",
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
        writePluginState(home, document, fs, assertHeld)
        return next
      })
    },
  }
}
