/**
 * Health and credential readiness probes for personal data sources (`F7`).
 *
 * Classifies each source into one actionable state:
 *  - `desktop_required` — standalone browser with no connected runtime host
 *  - `unconfigured`     — CLI missing or MCP preset not added yet
 *  - `disabled`         — MCP server exists locally but is switched off or untrusted
 *  - `reauth_required`  — keyring secret missing or latest auth/connect failed
 *  - `ready`            — binary/server configured and credentials verified
 */

import {
  runLarkCliProcess,
  type LarkCliProcessResult,
} from "@/lib/auth-providers/feishu/cli/process"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { getDb } from "@/lib/db/schema"
import {
  createMcpCredentialStore,
  hasMcpSecretRefs,
  resolveMcpSecrets,
} from "@/lib/mcp/credentials"
import {
  PERSONAL_DATA_SOURCE_PRESETS,
  findPersonalSourceMcpServer,
  type PersonalDataSourceId,
} from "./presets"

export type PersonalDataSourceStatus =
  "ready" | "unconfigured" | "disabled" | "reauth_required" | "desktop_required"

export interface PersonalDataSourceHealth {
  sourceId: PersonalDataSourceId
  status: PersonalDataSourceStatus
  serverId?: string
  detectedVersion?: string
  detail?: string
  checkedAt: number
}

export interface ProbePersonalSourceOptions {
  hostAvailable?: boolean
  now?: number
  credentialStore?: KeyringStore
  runLarkCli?: (args: readonly string[]) => Promise<LarkCliProcessResult>
}

const AUTH_FAILURE_RE = /auth|unauthorized|401|403|forbidden|token|expired|credential|login/i

async function defaultRunLarkCli(args: readonly string[]): Promise<LarkCliProcessResult> {
  return runLarkCliProcess("lark-cli", args, {
    timeoutMs: 6_000,
    maxOutputBytes: 128 * 1024,
  })
}

export async function probePersonalDataSource(
  sourceId: PersonalDataSourceId,
  options: ProbePersonalSourceOptions = {}
): Promise<PersonalDataSourceHealth> {
  const checkedAt = options.now ?? Date.now()
  if (options.hostAvailable === false) {
    return {
      sourceId,
      status: "desktop_required",
      checkedAt,
    }
  }

  if (sourceId === "lark") {
    const runner = options.runLarkCli ?? defaultRunLarkCli
    try {
      const versionRes = await runner(["--version"])
      if (versionRes.notFound) {
        return {
          sourceId,
          status: "unconfigured",
          detail: versionRes.stderr || "lark-cli not installed",
          checkedAt,
        }
      }
      const combined = `${versionRes.stdout}\n${versionRes.stderr}`.trim()
      if (versionRes.exitCode !== 0 && AUTH_FAILURE_RE.test(combined)) {
        return {
          sourceId,
          status: "reauth_required",
          detail: combined,
          checkedAt,
        }
      }
      if (versionRes.exitCode !== 0 || versionRes.timedOut) {
        return {
          sourceId,
          status: "unconfigured",
          detail: combined || "lark-cli check failed",
          checkedAt,
        }
      }
      const versionMatch = /(\d+\.\d+\.\d+)/.exec(combined)
      return {
        sourceId,
        status: "ready",
        ...(versionMatch ? { detectedVersion: versionMatch[1] } : {}),
        checkedAt,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        sourceId,
        status: AUTH_FAILURE_RE.test(message) ? "reauth_required" : "unconfigured",
        detail: message,
        checkedAt,
      }
    }
  }

  const server = await findPersonalSourceMcpServer(sourceId)
  if (!server) {
    return {
      sourceId,
      status: "unconfigured",
      checkedAt,
    }
  }

  const trustState = server.trust?.state ?? "legacy"
  if (!server.enabled || (trustState !== "trusted" && trustState !== "legacy")) {
    return {
      sourceId,
      status: "disabled",
      serverId: server.id,
      checkedAt,
    }
  }

  if (hasMcpSecretRefs(server.config)) {
    try {
      await resolveMcpSecrets(server.config, options.credentialStore ?? createMcpCredentialStore())
    } catch (err) {
      return {
        sourceId,
        status: "reauth_required",
        serverId: server.id,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      }
    }
  }

  try {
    const audits = await getDb()
      .mcpAuditLog.filter((row) => row.serverId === server.id && row.phase !== "close")
      .toArray()
    const latest = audits.reduce<(typeof audits)[number] | undefined>(
      (acc, cur) => (!acc || cur.ts > acc.ts ? cur : acc),
      undefined
    )
    if (latest?.errorCode && AUTH_FAILURE_RE.test(latest.errorCode)) {
      return {
        sourceId,
        status: "reauth_required",
        serverId: server.id,
        detail: latest.errorCode,
        checkedAt,
      }
    }
  } catch {
    // Ignore optional audit-table read errors during probing.
  }

  return {
    sourceId,
    status: "ready",
    serverId: server.id,
    checkedAt,
  }
}

export async function probeAllPersonalDataSources(
  options: ProbePersonalSourceOptions = {}
): Promise<Record<PersonalDataSourceId, PersonalDataSourceHealth>> {
  const results = await Promise.all(
    PERSONAL_DATA_SOURCE_PRESETS.map((preset) => probePersonalDataSource(preset.id, options))
  )
  return {
    lark: results[0],
    gmail: results[1],
    "google-calendar": results[2],
    outlook: results[3],
  }
}
