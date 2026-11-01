import {
  defineBackupDestination,
  definePlugin,
  definePluginManifest,
  type BackupDestinationBody,
  type BackupDestinationSnapshot,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)
const SCOPES = ["backups.read", "backups.write"]
const ORIGIN = "https://api.example-tracker.test"

export async function requestAccess(ctx: Pick<PluginContext, "auth">): Promise<boolean> {
  const connection = await ctx.auth.connections.get({
    service: "auth.example-tracker",
    scopes: SCOPES,
    interactive: true,
  })
  return connection
    ? (
        await ctx.auth.connections.requestGrant(connection.ref, {
          operations: ["backups.request.GET", "backups.request.PUT"],
          scopes: SCOPES,
        })
      ).granted
    : false
}

/** Example Tracker's JSON protocol base64-encodes opaque ciphertext; it never parses or decrypts it. */
async function encodeBody(body: BackupDestinationBody, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let bytes: Uint8Array
  if (ArrayBuffer.isView(body)) bytes = body
  else {
    const reader = body.getReader()
    const abort = () => {
      void reader.cancel().catch(() => undefined)
    }
    signal.addEventListener("abort", abort, { once: true })
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      signal.throwIfAborted()
      for (;;) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        chunks.push(value)
        length += value.byteLength
      }
      bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
    } finally {
      signal.removeEventListener("abort", abort)
      reader.releaseLock()
    }
  }
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export default definePlugin({
  manifest,
  async activate(ctx) {
    async function account() {
      const connection = await ctx.auth.connections.get({
        service: "auth.example-tracker",
        scopes: SCOPES,
      })
      if (!connection) return undefined
      return (await ctx.integrations.listAccounts("backups")).find(
        (item) => item.connectionId === connection.ref
      )
    }
    async function request(path: string, signal: AbortSignal, body?: string): Promise<unknown> {
      signal.throwIfAborted()
      const selected = await account()
      if (!selected) throw new Error("Connect and grant Example Tracker backup access first")
      const response = await ctx.integrations.authenticatedRequest<unknown>(
        selected.id,
        `${ORIGIN}${path}`,
        {
          method: body === undefined ? "GET" : "PUT",
          headers: { "content-type": "application/json" },
          body,
          signal,
        }
      )
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Backup request failed (${response.status})`)
      return response.data
    }
    const registration = ctx.backup.registerDestination(
      defineBackupDestination({
        id: "archive",
        label: "Example Tracker Backup",
        async readiness(signal) {
          signal.throwIfAborted()
          return (await account())
            ? { state: "ready" }
            : { state: "needs-auth", reasonKey: "access.denied" }
        },
        async upload({ body, meta }, signal) {
          const ciphertext = await encodeBody(body, signal)
          const response = await request(
            `/backups/${encodeURIComponent(meta.snapshotId)}`,
            signal,
            JSON.stringify({ ciphertext, meta })
          )
          const result = response as { remoteId?: unknown; bytes?: unknown } | null
          if (
            !result ||
            typeof result.remoteId !== "string" ||
            !result.remoteId ||
            result.bytes !== meta.bytes
          )
            throw new Error("Invalid backup upload result")
          return { remoteId: result.remoteId, bytes: meta.bytes }
        },
        async list(signal) {
          const response = await request("/backups", signal)
          if (!Array.isArray(response)) throw new Error("Invalid backup list")
          return response.map((raw: unknown): BackupDestinationSnapshot => {
            const item = raw as Partial<BackupDestinationSnapshot> | null
            if (
              !item ||
              typeof item.remoteId !== "string" ||
              !item.remoteId ||
              typeof item.label !== "string" ||
              (item.createdAt !== undefined &&
                (typeof item.createdAt !== "string" ||
                  !Number.isFinite(Date.parse(item.createdAt)))) ||
              (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || item.bytes < 0))
            )
              throw new Error("Invalid backup snapshot")
            return {
              remoteId: item.remoteId,
              label: item.label,
              createdAt: item.createdAt,
              bytes: item.bytes,
            }
          })
        },
        async download(remoteId, signal) {
          const response = await request(`/backups/${encodeURIComponent(remoteId)}`, signal)
          const item = response as { ciphertext?: unknown } | null
          if (!item || typeof item.ciphertext !== "string")
            throw new Error("Invalid backup download")
          const binary = atob(item.ciphertext)
          return Uint8Array.from(binary, (character) => character.charCodeAt(0))
        },
      })
    )
    return {
      onDisable: () => registration.unregister(),
      onUnload: () => registration.unregister(),
      async onCommand(command) {
        if (command !== "example-backups-connect") return false
        const granted = await requestAccess(ctx)
        return { handled: true, message: ctx.i18n.t(granted ? "access.granted" : "access.denied") }
      },
    }
  },
})
