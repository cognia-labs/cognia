/** CLI Host auth secrets, separate from plugin-state.json and Dexie snapshots. */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { createCliFileLock, sanitizedAuthName } from "./file-lock"

/** Injectable like LogtoSessionFs, with atomic replacement rather than overwrite. */
export interface AuthSecretFs {
  read(file: string): string | null
  write(file: string, content: string, mode: number): void
  rename(from: string, to: string): void
  remove(file: string): void
  mkdirp(dir: string, mode: number): void
}

export const realAuthSecretFs: AuthSecretFs = {
  read(file) {
    try {
      return fs.readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  },
  write(file, content, mode) {
    const fd = fs.openSync(file, "wx", mode)
    try {
      fs.fchmodSync(fd, mode)
      fs.writeFileSync(fd, content, "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  remove(file) {
    try {
      fs.unlinkSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  },
  mkdirp(dir, mode) {
    fs.mkdirSync(dir, { recursive: true, mode })
    fs.chmodSync(dir, mode)
  },
}

export function authSecretPath(home: string, namespace: string): string {
  return path.join(home, "auth", `${sanitizedAuthName(namespace)}.json`)
}

export function createCliAuthSecretStore(
  home: string,
  namespace: string,
  fsImpl: AuthSecretFs = realAuthSecretFs
): KeyringStore {
  const file = authSecretPath(home, namespace)
  const lock = createCliFileLock(home)
  function read(): Record<string, string> {
    const raw = fsImpl.read(file)
    if (raw === null) return Object.create(null) as Record<string, string>
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("Invalid CLI auth secret store")
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== "string")
    )
      throw new Error("Invalid CLI auth secret store")
    return Object.assign(Object.create(null), parsed) as Record<string, string>
  }
  function mutate(task: (values: Record<string, string>) => void): Promise<void> {
    // A namespace is one JSON file: per-key CAS locks alone cannot prevent
    // two different keys from overwriting each other's document updates.
    return lock(
      namespace,
      async (assertHeld) => {
        const values = read()
        task(values)
        fsImpl.mkdirp(path.dirname(file), 0o700)
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          fsImpl.write(temporary, JSON.stringify(values), 0o600)
          assertHeld()
          fsImpl.rename(temporary, file)
        } finally {
          fsImpl.remove(temporary)
        }
      },
      "secret-store"
    )
  }
  return {
    isPersistent: () => true,
    load: async (key) => read()[key] ?? null,
    save: (key, value) =>
      mutate((values) => {
        values[key] = value
      }),
    delete: (key) =>
      mutate((values) => {
        delete values[key]
      }),
  }
}
