/**
 * `provider capabilities`: the operation profile per configured provider.
 *
 * Cells come from the shared `capabilities.read` operation (the pure matrix in
 * `@cognia/provider-core` plus this host's surfaces), run over this machine's
 * configuration, so the answer is always local. The desktop's manifest, when
 * a bridge is attached, only says which contract and admin commands that
 * desktop exposes, and the report names it as such.
 */

import type {
  ProviderOperationCell,
  ProviderOperationFailure,
  ProviderOperationProfile,
} from "@cognia/provider-types"

import { PROVIDER_OPERATION_MANIFEST } from "@/lib/ai/operations"

import type { ResolvedConfig } from "../config/schema"
import { configuredProviderIds, type CliProviderExecutor } from "./local"
import { LOCAL_ANSWER, type ProviderAnswerSource, type ProviderTransport } from "./transport"

export interface ProviderCapabilityEntry {
  providerId: string
  profile?: ProviderOperationProfile
  failure?: ProviderOperationFailure
}

/** The contract bundled with this CLI, named when no desktop manifest is attached. */
export const BUNDLED_CONTRACT_LABEL = "the contract bundled with this CLI"

export interface ProviderCapabilitiesReport {
  /** The cells: this machine's executor over its own configuration. */
  answeredBy: ProviderAnswerSource
  /** Whose contract the counts below describe: the desktop's manifest, or the bundled one. */
  contractFrom: string
  schemaVersion: number
  operationCount: number
  /** Companion commands the attached desktop will dispatch (bridge only). */
  adminCommands: string[]
  /** Set when `--operation` narrowed the cells. */
  operationFilter?: string
  providers: ProviderCapabilityEntry[]
}

export interface ReadCapabilitiesDeps {
  config: ResolvedConfig
  executor: CliProviderExecutor
  transport: ProviderTransport
  providerId?: string
  operationId?: string
}

export async function readProviderCapabilities(
  deps: ReadCapabilitiesDeps
): Promise<ProviderCapabilitiesReport> {
  const manifest = deps.transport.manifest ?? PROVIDER_OPERATION_MANIFEST
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
    contractFrom: deps.transport.manifest ? deps.transport.label : BUNDLED_CONTRACT_LABEL,
    schemaVersion: manifest.schemaVersion,
    operationCount: manifest.operations.length,
    adminCommands: deps.transport.manifest?.adminCommands ?? [],
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
