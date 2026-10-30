import {
  connectorsMatrixCryptoBackup,
  type MatrixCryptoBackupRequest,
} from "@/lib/connectors/tauri/commands"
import type { MatrixRequest } from "./e2ee"

export class MatrixRequestNotDispatchedError extends Error {}

export interface MatrixKeyBackupOptions {
  adapterId: string
  request: MatrixRequest
  capture: () => () => boolean
  flush: () => Promise<void>
}

/** Explicit backup operations share the adapter's authenticated request owner. */
export class MatrixKeyBackup {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: MatrixKeyBackupOptions) {}

  private run<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
    const owner = this.options.capture()
    const check = () => {
      if (!owner()) throw new Error("Matrix backup adapter is not active")
    }
    const result = this.pending.then(async () => {
      check()
      return operation(check)
    })
    this.pending = result.catch(() => undefined)
    return result
  }

  private async native(request: Omit<MatrixCryptoBackupRequest, "adapterId">, check: () => void) {
    check()
    const result = await connectorsMatrixCryptoBackup({
      ...request,
      adapterId: this.options.adapterId,
    })
    check()
    return result
  }

  create(): Promise<{ version: string; recoveryKey: string }> {
    return this.run(async (check) => {
      // Persist before the server mutation. A lost create response can be
      // reconciled against the server's current version on the next call.
      const prepared = await this.native({ action: "prepare" }, check)
      if (!prepared.backupInfo || !prepared.recoveryKey)
        throw new Error("Matrix backup preparation failed")
      let info: Record<string, unknown>
      try {
        info = await this.options.request(
          "GET",
          "/_matrix/client/v3/room_keys/version",
          undefined,
          { maxResponseBytes: 64 * 1024 }
        )
      } catch (error) {
        check()
        if (!error || typeof error !== "object" || (error as { status?: number }).status !== 404)
          throw error
        if (prepared.createPending)
          throw new Error(
            "Matrix backup creation outcome is unknown; reconcile server state before another create"
          )
        const createClaim = crypto.randomUUID()
        try {
          await this.native(
            { action: "beginCreate", backupInfo: prepared.backupInfo, createClaim },
            check
          )
        } catch (error) {
          // No POST has started; claim-bound cleanup is idempotent even if
          // the claim response was lost or ownership changed in flight.
          await connectorsMatrixCryptoBackup({
            adapterId: this.options.adapterId,
            action: "cancelCreate",
            createClaim,
          }).catch(() => undefined)
          throw error
        }
        let created: Record<string, unknown>
        try {
          created = await this.options.request(
            "POST",
            "/_matrix/client/v3/room_keys/version",
            prepared.backupInfo,
            { maxResponseBytes: 64 * 1024 }
          )
        } catch (error) {
          const status =
            error && typeof error === "object" ? (error as { status?: number }).status : undefined
          if (
            error instanceof MatrixRequestNotDispatchedError ||
            status === 401 ||
            status === 403
          ) {
            // Domain cleanup is claim-bound and safe after the runtime stops.
            await connectorsMatrixCryptoBackup({
              adapterId: this.options.adapterId,
              action: "cancelCreate",
              createClaim,
            }).catch(() => undefined)
          }
          throw error
        }
        info = { ...prepared.backupInfo, version: created.version }
      }
      check()
      if (typeof info.version !== "string" || !info.version.trim())
        throw new Error("Invalid Matrix backup version")
      // Enabling refuses a foreign existing public key; never overwrite it.
      await this.native({ action: "enable", version: info.version, backupInfo: info }, check)
      await this.options.flush()
      check()
      return { version: info.version, recoveryKey: prepared.recoveryKey }
    })
  }

  restore(
    recoveryKey: string,
    version?: string
  ): Promise<{ version: string; imported: number; total: number }> {
    return this.run(async (check) => {
      const suffix = version === undefined ? "" : `/${encodeURIComponent(version)}`
      const info = await this.options.request(
        "GET",
        `/_matrix/client/v3/room_keys/version${suffix}`,
        undefined,
        { maxResponseBytes: 64 * 1024 }
      )
      check()
      if (
        typeof info.version !== "string" ||
        !info.version.trim() ||
        (version !== undefined && info.version !== version)
      )
        throw new Error("Matrix backup version mismatch")
      const payload = await this.options.request(
        "GET",
        `/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(info.version)}`,
        undefined,
        { maxResponseBytes: 8 * 1024 * 1024 }
      )
      check()
      if (!payload.rooms || typeof payload.rooms !== "object" || Array.isArray(payload.rooms))
        throw new Error("Invalid Matrix backup rooms")
      const restored = await this.native(
        {
          action: "restore",
          recoveryKey,
          version: info.version,
          backupInfo: info,
          rooms: payload.rooms as Record<string, unknown>,
        },
        check
      )
      await this.options.flush()
      check()
      return { version: info.version, imported: restored.imported ?? 0, total: restored.total ?? 0 }
    })
  }
}
