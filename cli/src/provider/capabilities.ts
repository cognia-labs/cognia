/**
 * `provider capabilities`: the operation profile per configured provider.
 *
 * Cells come from the shared `capabilities.read` operation (the pure matrix in
 * `@cognia/provider-core` plus this host's surfaces), run over this machine's
 * configuration against the contract bundled with this CLI, so the answer is
 * always this machine's.
 */

import type {
  ProviderOperationCell,
  ProviderOperationFailure,
  ProviderOperationProfile,
} from "@cognia/provider-types"

import { PROVIDER_OPERATION_MANIFEST } from "@/lib/ai/operations"

import type { ResolvedConfig } from "../config/schema"
import { configuredProviderIds, type CliProviderExecutor } from "./local"
import { LOCAL_ANSWER, type ProviderAnswerSource } from "./target"

export interface ProviderCapabilityEntry {
  providerId: string
  profile?: ProviderOperationProfile
  failure?: ProviderOperationFailure
}

export interface ProviderCapabilitiesReport {
  /** The cells: this machine's executor over its own configuration. */
  answeredBy: ProviderAnswerSource
  /** The bundled contract's version and size. */
  schemaVersion: number
  operationCount: number
  /** Set when `--operation` narrowed the cells. */
  operationFilter?: string
  providers: ProviderCapabilityEntry[]
}

export interface ReadCapabilitiesDeps {
  config: ResolvedConfig
  executor: CliProviderExecutor
  providerId?: string
  operationId?: string
}

export async function readProviderCapabilities(
  deps: ReadCapabilitiesDeps
): Promise<ProviderCapabilitiesReport> {
  const manifest = PROVIDER_OPERATION_MANIFEST
  const ids = deps.providerId ? [deps.providerId] : configuredProviderIds(deps.config)
  const providers: ProviderCapabilityEntry[] = []
  for (const providerId of ids) {
    const result = await deps.executor.execute<ProviderOperationProfile>(
      "capabilities.read",
      providerId,
      {}
    )
    if (!result.ok) {
      providers.push({ providerId, failure: result })
      continue
    }
    const cells = deps.operationId
      ? result.output.cells.filter((cell) => cell.operationId === deps.operationId)
      : result.output.cells
    providers.push({ providerId, profile: { ...result.output, cells } })
  }
  return {
    answeredBy: LOCAL_ANSWER,
    schemaVersion: manifest.schemaVersion,
    operationCount: manifest.operations.length,
    ...(deps.operationId ? { operationFilter: deps.operationId } : {}),
    providers,
  }
}

/** One fixed-width line per cell, for the human listing. */
export function formatCapabilityCell(cell: ProviderOperationCell): string {
  const id = cell.operationId.padEnd(24)
  const support = cell.support.padEnd(11)
  const availability = cell.availability.padEnd(12)
  const detail =
    cell.support === "unsupported"
      ? cell.reason
      : cell.support === "unknown"
        ? `${cell.provenance}: ${cell.failure.message}`
        : cell.support === "plugin"
          ? `via ${cell.via}`
          : (cell.note ?? "")
  return `${id} ${support} ${availability} ${detail}`.trimEnd()
}
