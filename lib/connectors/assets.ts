/** Durable, adapter-scoped inventory of reusable platform assets. */
import { getDb } from "@/lib/db/schema"
import type { ConnectorAsset } from "@/types/connectors/management"
const key = (adapterId: string, id: string) => `${adapterId}:connector-asset:${id}`
export async function rememberConnectorAssets(adapterId: string, assets: ConnectorAsset[]) {
  if (assets.some((asset) => asset.adapterId !== adapterId || !asset.id || !asset.reference))
    throw new TypeError("Invalid adapter-scoped asset receipt")
  if (!assets.length) return
  await getDb().transaction("rw", getDb().inboundLedger, async () => {
    const rows = await getDb().inboundLedger.where("namespace").equals("connector-asset").toArray()
    const expired = rows.filter(
      (row) => row.asset?.expiresAt !== undefined && row.asset.expiresAt <= Date.now()
    )
    if (expired.length) await getDb().inboundLedger.bulkDelete(expired.map((row) => row.id))
    const newCount = assets.filter(
      (asset) => !rows.some((row) => row.id === key(adapterId, asset.id))
    ).length
    if (rows.length - expired.length + newCount > 10_000)
      throw new Error("Connector asset inventory capacity reached")
    await getDb().inboundLedger.bulkPut(
      assets.map((asset) => ({
        id: key(adapterId, asset.id),
        adapterId,
        namespace: "connector-asset" as const,
        platformMessageId: asset.id,
        receivedAt: Date.now(),
        asset,
      }))
    )
  })
}
export async function forgetConnectorAsset(adapterId: string, id: string) {
  await getDb().inboundLedger.delete(key(adapterId, id))
}
export async function requireConnectorAsset(adapterId: string, id: string) {
  const asset = (await getDb().inboundLedger.get(key(adapterId, id)))?.asset
  if (
    !asset ||
    asset.adapterId !== adapterId ||
    (asset.expiresAt !== undefined && asset.expiresAt <= Date.now())
  )
    throw new Error("Asset is unknown or expired for this adapter; query its inventory first")
  return asset
}
export async function verifyConnectorAssetReferences(adapterId: string, references: string[]) {
  if (!references.length) return
  const rows = await getDb().inboundLedger.where("namespace").equals("connector-asset").toArray()
  for (const reference of references) {
    if (
      !rows.some(
        (row) =>
          row.adapterId === adapterId &&
          row.asset?.reference === reference &&
          (row.asset.expiresAt === undefined || row.asset.expiresAt > Date.now())
      )
    )
      throw new Error("Reusable media reference is unknown or expired for this adapter")
  }
}

/** Extract native references from every serialized message surface. */
export function collectConnectorAssetReferences(value: unknown, pattern: RegExp): string[] {
  if (typeof value === "string") return [...value.matchAll(pattern)].map((match) => match[0])
  if (!value || typeof value !== "object") return []
  return [
    ...new Set(
      Object.values(value).flatMap((item) => collectConnectorAssetReferences(item, pattern))
    ),
  ]
}

/** Providers with sliding expiry renew only after an acknowledged use. */
export async function renewConnectorAssetReferences(
  adapterId: string,
  references: string[],
  expiresAt: number
) {
  if (!references.length) return
  await getDb().transaction("rw", getDb().inboundLedger, async () => {
    const rows = await getDb().inboundLedger.where("adapterId").equals(adapterId).toArray()
    for (const row of rows) {
      if (
        row.namespace === "connector-asset" &&
        row.asset &&
        references.includes(row.asset.reference)
      )
        await getDb().inboundLedger.put({ ...row, asset: { ...row.asset, expiresAt } })
    }
  })
}
