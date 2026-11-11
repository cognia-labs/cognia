/** Node filesystem adapter for the shared headless backup scheduler. */

import { mkdir, readdir, readFile, rm, writeFile, open, link } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

import type { BackupFilesystem } from "@/lib/data/backup-scheduler"

/** Retain the identity failure at every backup entry point; never choose a new owner. */
export function createUnavailableBackupFilesystem(error: Error): BackupFilesystem {
  const refuse = async (): Promise<never> => {
    throw error
  }
  return {
    get installationId(): never {
      throw error
    },
    writeStream: refuse,
    writeTextFile: refuse,
    readDirNames: refuse,
    remove: refuse,
  }
}

/** One random identity per serve volume, independent of its mount path or account. */
export async function getServeInstallationId(home: string): Promise<string> {
  const target = path.join(home, "installation-id")
  const readIdentity = async () => {
    const id = (await readFile(target, "utf8")).trim()
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
      throw new Error("invalid_headless_installation_id")
    return id
  }
  try {
    return await readIdentity()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const id = randomUUID()
  try {
    // The existing writer fsyncs a private 0600 file and publishes it without
    // replacement. A concurrent boot sees a complete UUID, never an empty file.
    await createNodeBackupFilesystem().writeStream!(
      target,
      (async function* () {
        yield new TextEncoder().encode(`${id}\n`)
      })()
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  return readIdentity()
}

export function createNodeBackupFilesystem(installationId?: string): BackupFilesystem {
  return {
    installationId,
    async writeStream(target, source, assertActive = () => undefined) {
      assertActive()
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      const file = await open(temporary, "wx", 0o600)
      let size = 0
      try {
        for await (const chunk of source) {
          let offset = 0
          while (offset < chunk.byteLength) {
            const result = await file.write(chunk, offset, chunk.byteLength - offset)
            assertActive()
            if (result.bytesWritten === 0) throw new Error("backup_write_failed")
            offset += result.bytesWritten
          }
          size += chunk.byteLength
        }
        await file.sync()
        await file.close()
        assertActive()
        // Publish without replacement, including writers in another process.
        await link(temporary, target)
        await rm(temporary, { force: true })
        return size
      } catch (error) {
        await file.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    },
    async writeTextFile(target, contents) {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, contents, { encoding: "utf8", mode: 0o600, flag: "wx" })
    },
    async readDirNames(directory) {
      return readdir(directory)
    },
    async remove(target) {
      await rm(target, { force: true })
    },
  }
}
