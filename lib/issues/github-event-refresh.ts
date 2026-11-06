/** GitHub webhook freshness is scheduled by the shared external-sync runtime. */
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import { getIntegrationAccount } from "@/lib/db/integrations"
import { deleteGithubIssues } from "@/lib/db/github-issue-mirror"
import { GITHUB_DOT_COM, parseGithubHost } from "@/lib/github/host"
import { integrationApiBaseUrl } from "@/lib/integrations/action-runner"
import { requestExternalSync } from "@/lib/external-services/sync/runtime"
import { GITHUB_DELIVERY_PLUGIN_ID } from "./github-writeback"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { githubMirrorSyncTarget, GithubMirrorSyncOutcomeError } from "./github-sync"
import { issueSyncTarget, tombstoneIssueSyncRefs } from "./sync/engine"
import { reconcileIssueSyncRegistrations, runRegisteredIssueSync } from "./sync/runtime"
import { IssueSyncOutcomeError } from "./sync/types"

const REFRESHING_PREFIXES = ["issues.", "issue_comment."] as const
const DEPARTED = new Set(["issues.transferred", "issues.deleted"])

export interface GithubEventRefreshDeps {
  accountHostId: (pluginId: string, connectorAccountId: string) => Promise<string | undefined>
  reconcileRegistrations: typeof reconcileIssueSyncRegistrations
  runRegistered: typeof runRegisteredIssueSync
  requestSync: typeof requestExternalSync
  removeFromMirror: (repoFullName: string, numbers: number[]) => Promise<unknown>
  departImport: typeof tombstoneIssueSyncRefs
  onError: (repoFullName: string, error: unknown) => void
}

async function defaultAccountHostId(
  pluginId: string,
  connectorAccountId: string
): Promise<string | undefined> {
  const account = await getIntegrationAccount(pluginId, connectorAccountId)
  if (!account) return undefined
  const base = await integrationApiBaseUrl(account)
  // Not host-aware (or unresolvable) means the plugin's default: github.com.
  return (base ? parseGithubHost(base) : GITHUB_DOT_COM)?.id
}

function defaultDeps(): GithubEventRefreshDeps {
  return {
    accountHostId: defaultAccountHostId,
    reconcileRegistrations: reconcileIssueSyncRegistrations,
    runRegistered: runRegisteredIssueSync,
    requestSync: requestExternalSync,
    removeFromMirror: deleteGithubIssues,
    departImport: tombstoneIssueSyncRefs,
    onError: (repoFullName, error) =>
      console.warn("GitHub event issue refresh failed", { repoFullName, error }),
  }
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function issueNumberOf(event: IntegrationEventEnvelope): number | undefined {
  const issue = (event.payload as { issue?: { number?: unknown } } | undefined)?.issue
  const number = issue?.number
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * The remote version a departure is pinned to: the payload issue's own
 * `updated_at`, never a Host clock. `occurredAt` is the Host's receipt time
 * (late delivery, local skew), and a barrier above the item's real versions
 * would keep a genuinely returned item departed until it is edited again.
 * Without a remote version the departure is recorded unpinned: a stale page
 * may revive it, and the next full scan verifies and departs it again.
 */
function departedRemoteAt(event: IntegrationEventEnvelope): number | undefined {
  const updated = (event.payload as { issue?: { updated_at?: unknown } } | undefined)?.issue
    ?.updated_at
  const time = typeof updated === "string" ? Date.parse(updated) : NaN
  return Number.isFinite(time) ? time : undefined
}

export class GithubEventIssueRefresher {
  constructor(private readonly deps: GithubEventRefreshDeps = defaultDeps()) {}

  /** True when the event can change the issue board. */
  static relevant(event: IntegrationEventEnvelope): boolean {
    return (
      event.pluginId === GITHUB_DELIVERY_PLUGIN_ID &&
      event.resource?.kind === "repository" &&
      typeof event.resource.id === "string" &&
      REFRESHING_PREFIXES.some((prefix) => event.eventType.startsWith(prefix))
    )
  }

  /**
   * React to one published event. Never throws: this consumer is best-effort,
   * like bot delivery, and must not fail the event for workflows or the inbox.
   */
  async handle(event: IntegrationEventEnvelope): Promise<void> {
    if (!GithubEventIssueRefresher.relevant(event)) return
    const repoFullName = event.resource!.id
    try {
      const hostId = await this.deps.accountHostId(event.pluginId, event.accountId)
      if (hostId !== GITHUB_DOT_COM.id) return
      // crates/cognia-scheduling/src/workflow/triggers/webhook_router.rs:
      // handle_integration_ingress verifies the HMAC before queueing a delivery;
      // lib/integrations/ingress-client.ts normalizes it before publishIntegrationEvent.
      const { mirror, imported } = await this.deps.reconcileRegistrations()
      const boundMirrors = mirror.filter((binding) => sameRepo(binding.repoFullName, repoFullName))
      const boundImports = imported.filter(
        (binding) => binding.providerId === "github" && sameRepo(binding.key, repoFullName)
      )
      if (DEPARTED.has(event.eventType)) {
        const number = issueNumberOf(event)
        if (number !== undefined) {
          for (const binding of boundMirrors)
            await this.deps.removeFromMirror(binding.repoFullName, [number])
          for (const binding of boundImports) {
            const remoteAt = departedRemoteAt(event)
            await this.deps.departImport(binding, [`${binding.key}#${number}`], {
              eventAccount: { pluginId: event.pluginId, accountId: event.accountId },
              ...(remoteAt !== undefined ? { departedRemoteAt: remoteAt } : {}),
            })
          }
        }
      }
      for (const binding of boundMirrors)
        this.deps.requestSync(githubMirrorSyncTarget(binding).key, "push")
      for (const binding of boundImports)
        this.deps.requestSync(issueSyncTarget(binding).key, "push")
    } catch (error) {
      this.deps.onError(repoFullName, error)
    }
  }

  /**
   * Read back the person's own write to one repository (D20). It takes the
   * webhook's targets, so each binding reads only what changed since its
   * checkpoint (the written issue, plus anything edited meanwhile) instead of
   * re-reading the workspace. Unlike `handle` it waits and rejects: the write
   * already landed, and a refresh that fails leaves the board stale until the
   * next sync, which the caller should say.
   *
   * A target another run holds ends "busy"; that run may predate the write,
   * so a push is queued behind it.
   */
  async refreshAfterWrite(
    repoFullName: string,
    credentialContext?: PersonalCredentialContext
  ): Promise<void> {
    const { mirror, imported } = await this.deps.reconcileRegistrations()
    const targets = [
      ...mirror
        .filter((binding) => sameRepo(binding.repoFullName, repoFullName))
        .map((binding) => ({ key: githubMirrorSyncTarget(binding).key, mirror: true })),
      ...imported
        .filter((binding) => binding.providerId === "github" && sameRepo(binding.key, repoFullName))
        .map((binding) => ({ key: issueSyncTarget(binding).key, mirror: false })),
    ]
    for (const target of targets) {
      const outcome = await this.deps.runRegistered(
        target.key,
        credentialContext ? { credentialContext } : {}
      )
      if (!outcome) continue
      if (outcome.status === "busy") this.deps.requestSync(target.key, "push")
      if (outcome.status === "failed" || outcome.status === "backoff") {
        const code = outcome.errorCode ?? outcome.status
        throw target.mirror
          ? new GithubMirrorSyncOutcomeError(code)
          : new IssueSyncOutcomeError(code)
      }
    }
  }
}

let singleton: GithubEventIssueRefresher | undefined

/** The process-wide refresher `publishIntegrationEvent` feeds. */
export function getGithubEventIssueRefresher(): GithubEventIssueRefresher {
  if (!singleton) singleton = new GithubEventIssueRefresher()
  return singleton
}
