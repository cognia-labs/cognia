/**
 * `provider usage`: what this install spent, per provider and model, from
 * the two ledgers the CLI actually has.
 *
 *   1. The Dexie `sessionUsage` ledger (the same table the desktop keeps,
 *      restored from `~/.cognia/db.json`), read by the reader the shared
 *      `usage.local.read` operation answers from, which also says how many
 *      turns no rate priced. Every row names the provider that served it, so
 *      attribution is exact.
 *   2. The canonical session store (`~/.cognia/sessions/<id>/manifest.json`),
 *      which carries cumulative usage per session and, when the runtime
 *      recorded one, the provider it was bound to. A manifest without a
 *      provider is attributed through the model catalog, which is exact for a
 *      model only one configured provider lists and APPROXIMATE for an alias
 *      several providers share. The report says which. Usage is cumulative,
 *      so only a session that ran wholly inside the window is counted; one
 *      that began before it or ran past it is reported, not split.
 *
 * Costs are priced by `effectiveCostUsd`, the one pricing path. A row no rate
 * priced is unknown rather than free, and a partly priced one a lower bound.
 */

import type { z } from "zod"
import type { ProviderOperationFailure, usageLocalReadOutput } from "@cognia/provider-types"

import { catalogModelIds } from "@/lib/ai/model-options"
import { readLocalProviderUsage } from "@/lib/ai/operations/handlers/account"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { aggregateByModel } from "@/lib/usage/session-analytics"

import { parseManifest, type SessionManifest } from "../agent/session-store/manifest"
import {
  manifestPath,
  realSessionStoreFs,
  sessionsRoot,
  type SessionStoreFs,
} from "../agent/session-store/paths"
import type { ResolvedConfig } from "../config/schema"
import { configuredProviderIds } from "./local"

export type UsageLedgerOutput = z.infer<typeof usageLocalReadOutput>
export type UsageAttribution = UsageLedgerOutput["rows"][number]["attribution"]

export interface ProviderUsageRow {
  providerId?: string
  model: string
  attribution: UsageAttribution
  turns: number
  inputTokens: number
  outputTokens: number
  /** The priced part: a lower bound when `unpricedTurns` is above zero. */
  costUsd: number
  /** True only when every turn was priced. */
  costKnown: boolean
  /** Turns no rate priced. Their spend is unknown, not free. */
  unpricedTurns: number
}

export interface ProviderUsageReport {
  from: number
  to: number
  ledger: {
    rows: ProviderUsageRow[]
    /** Per-provider read failures (the ledger is one operation per provider). */
    failures: Array<{ providerId: string; failure: ProviderOperationFailure }>
    /** Set when the local database could not be opened at all. */
    unavailable?: string
  }
  sessions: {
    rows: ProviderUsageRow[]
    /** Manifests whose session overlapped the window. */
    scanned: number
    /** Manifests inside the window that recorded no usage. */
    withoutUsage: number
    /**
     * Sessions that began before the window or ran past it. Their usage is a
     * cumulative total that cannot be split by time, so none of it is counted.
     */
    spanning: number
    /** Rows whose provider came from the catalog, not the session. */
    catalogAttributed: number
    approximate: number
  }
}

export interface ReadUsageDeps {
  config: ResolvedConfig
  home: string
  providerId?: string
  from?: number
  to?: number
  now?: () => number
  /** Opens the local database before the ledger read. Defaults to `ensureCliDb`. */
  ensureDb?: () => Promise<void>
  fsx?: SessionStoreFs
  /** Model catalog per provider (tests). Defaults to the shared catalog. */
  modelCatalog?: (providerId: string) => string[]
  /** One provider's local ledger. Defaults to the reader `usage.local.read` uses. */
  readLocalUsage?: typeof readLocalProviderUsage
}

const DAY_MS = 24 * 60 * 60 * 1000

async function defaultEnsureDb(home: string): Promise<void> {
  const { ensureCliDb } = await import("../db/bootstrap")
  await ensureCliDb({ home })
}

function windowOf(deps: ReadUsageDeps): { from: number; to: number } {
  const now = (deps.now ?? Date.now)()
  const to = deps.to ?? now
  const from = deps.from ?? to - 7 * DAY_MS
  if (from >= to) throw new Error("usage window must start before it ends")
  return { from, to }
}

async function readLedger(
  deps: ReadUsageDeps,
  window: { from: number; to: number }
): Promise<ProviderUsageReport["ledger"]> {
  try {
    await (deps.ensureDb ?? (() => defaultEnsureDb(deps.home)))()
  } catch (error) {
    return { rows: [], failures: [], unavailable: (error as Error).message }
  }
  const ids = deps.providerId ? [deps.providerId] : configuredProviderIds(deps.config)
  const read = deps.readLocalUsage ?? readLocalProviderUsage
  const rows: ProviderUsageRow[] = []
  const failures: ProviderUsageReport["ledger"]["failures"] = []
  for (const providerId of ids) {
    let usage: Awaited<ReturnType<typeof readLocalProviderUsage>>
    try {
      usage = await read(providerId, window)
    } catch (error) {
      failures.push({
        providerId,
        failure: {
          ok: false,
          operationId: "usage.local.read",
          providerId,
          availability: "unavailable",
          failure: {
            code: "unknown",
            retryable: false,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      })
      continue
    }
    for (const row of usage) {
      rows.push({
        providerId,
        model: row.model,
        attribution: "exact",
        turns: row.turns,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUsd,
        // An unpriced model's $0 is not free (F11).
        costKnown: row.unpricedTurns === 0,
        unpricedTurns: row.unpricedTurns,
      })
    }
  }
  return { rows, failures }
}

/** Walk every canonical session manifest under `home`. */
export function readSessionManifests(home: string, fsx: SessionStoreFs): SessionManifest[] {
  const root = sessionsRoot(home)
  if (!fsx.exists(root)) return []
  const manifests: SessionManifest[] = []
  for (const id of fsx.readdir(root)) {
    const path = manifestPath(home, id)
    if (!fsx.exists(path)) continue
    const manifest = parseManifest(fsx.readFile(path))
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

interface Attributed {
  providerId?: string
  attribution: UsageAttribution
}

/**
 * Which configured provider a model belongs to. The session's own binding
 * wins. Otherwise the catalog decides: one listing provider is exact by
 * catalog, several is an alias and only approximate, none is unknown.
 */
export function attributeModel(
  model: string,
  bound: string | undefined,
  config: ResolvedConfig,
  catalog: (providerId: string) => string[]
): Attributed {
  if (bound) return { providerId: bound, attribution: "exact" }
  const listing = configuredProviderIds(config).filter((id) => catalog(id).includes(model))
  if (listing.length === 1) return { providerId: listing[0], attribution: "catalog" }
  if (listing.length > 1) {
    const active = listing.includes(config.provider) ? config.provider : listing[0]
    return { providerId: active, attribution: "approximate" }
  }
  return { attribution: "approximate" }
}

function sessionRows(
  deps: ReadUsageDeps,
  window: { from: number; to: number }
): ProviderUsageReport["sessions"] {
  const fsx = deps.fsx ?? realSessionStoreFs
  const catalog = deps.modelCatalog ?? catalogModelIds
  // Overlapping the window by the session's whole span: picking by the last
  // update alone counted a long session's entire history in this window (F11).
  const manifests = readSessionManifests(deps.home, fsx).filter((manifest) => {
    const created = Date.parse(manifest.createdAt)
    const updated = Date.parse(manifest.updatedAt)
    return (
      Number.isFinite(created) &&
      Number.isFinite(updated) &&
      created < window.to &&
      updated >= window.from
    )
  })
  let withoutUsage = 0
  let spanning = 0
  const synthetic: Array<SessionUsageRow & { attribution: UsageAttribution }> = []
  for (const manifest of manifests) {
    const began = Date.parse(manifest.createdAt)
    const lastRan = Date.parse(manifest.updatedAt)
    if (began < window.from || lastRan >= window.to) {
      spanning += 1
      continue
    }
    const usage = manifest.usage
    if (!usage || ((usage.inputTokens ?? 0) === 0 && (usage.outputTokens ?? 0) === 0)) {
      withoutUsage += 1
      continue
    }
    const model = manifest.runtimeBinding?.model ?? "(unknown)"
    const attributed = attributeModel(
      model,
      manifest.runtimeBinding?.provider,
      deps.config,
      catalog
    )
    if (deps.providerId && attributed.providerId !== deps.providerId) continue
    synthetic.push({
      messageId: manifest.sessionId,
      sessionId: manifest.sessionId,
      at: Date.parse(manifest.updatedAt),
      model,
      ...(attributed.providerId ? { providerId: attributed.providerId } : {}),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      costUsd: usage.costUsd ?? 0,
      durationMs: 0,
      attribution: attributed.attribution,
    })
  }

  // Bucket by (provider, attribution) first so the model rollup never merges an
  // exact binding with a catalog guess for the same model id.
  const groups = new Map<string, typeof synthetic>()
  for (const row of synthetic) {
    const key = `${row.providerId ?? ""} ${row.attribution}`
    const slot = groups.get(key) ?? []
    slot.push(row)
    groups.set(key, slot)
  }
  const rows: ProviderUsageRow[] = []
  let catalogAttributed = 0
  let approximate = 0
  for (const group of groups.values()) {
    const first = group[0]!
    for (const bucket of aggregateByModel(group)) {
      const row: ProviderUsageRow = {
        ...(first.providerId ? { providerId: first.providerId } : {}),
        model: bucket.model,
        attribution: first.attribution,
        turns: bucket.turns,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        costUsd: bucket.costUsd,
        costKnown: bucket.unpricedTurns === 0,
        unpricedTurns: bucket.unpricedTurns,
      }
      if (row.attribution === "catalog") catalogAttributed += 1
      if (row.attribution === "approximate") approximate += 1
      rows.push(row)
    }
  }
  rows.sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.model.localeCompare(b.model)
  )
  return {
    rows,
    scanned: manifests.length,
    withoutUsage,
    spanning,
    catalogAttributed,
    approximate,
  }
}

export async function readProviderUsage(deps: ReadUsageDeps): Promise<ProviderUsageReport> {
  const window = windowOf(deps)
  const ledger = await readLedger(deps, window)
  const sessions = sessionRows(deps, window)
  return { from: window.from, to: window.to, ledger, sessions }
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * A row's cost: the price when every turn was priced, a lower bound when some
 * were, unknown when none were. The rule `formatBucketCost` applies in the app,
 * at the CLI's precision.
 */
export function formatUsageCost(row: ProviderUsageRow, unknown = "cost unknown"): string {
  if (row.costKnown) return `$${row.costUsd.toFixed(4)}`
  if (row.turns > 0 && row.unpricedTurns >= row.turns) return unknown
  return `≥ $${row.costUsd.toFixed(4)}`
}

/** One line per row. The first column marks how the provider was attributed. */
export function formatUsageRow(row: ProviderUsageRow): string {
  const provider = (row.providerId ?? "?").padEnd(16)
  const model = row.model.padEnd(32)
  const cost = formatUsageCost(row)
  const mark = row.attribution === "exact" ? " " : row.attribution === "catalog" ? "c" : "~"
  const input = tokens(row.inputTokens).padStart(7)
  const output = tokens(row.outputTokens).padStart(7)
  return `${mark} ${provider} ${model} in ${input}  out ${output}  ${cost}`
}
