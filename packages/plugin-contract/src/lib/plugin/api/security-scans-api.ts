/**
 * The plugin contract's share of `lib/plugin/api/security-scans-api.ts`, which re-exports these.
 */
export interface SecurityScanRunRecord {
  runId: string
  target: string
  startedAt: number
  endedAt?: number
  status: "running" | "done" | "error" | "cancelled"
  findingsCount: number
  reportUnreadable?: boolean
}

export interface PluginSecurityScansAPI {
  syncExecutionRun(record: SecurityScanRunRecord): Promise<void>
  registerRunController(runId: string, controller: AbortController): () => void
}
