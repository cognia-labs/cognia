import { nanoid } from "nanoid"

import { canonicalStringify } from "@/lib/data/migrate"
import {
  cancelSiteOperation,
  claimNextSiteOperation,
  claimSiteOperation,
  completeSiteOperation,
  createSiteDeployment,
  createSiteEnvironmentRevision,
  failSiteDeployment,
  failSiteOperation,
  failSiteVersion,
  getSiteArtifact,
  getSiteDeployment,
  getSiteEnvironmentRevision,
  getSiteOperation,
  getSiteProject,
  getSiteResource,
  getSiteVersion,
  listSiteDeployments,
  listSiteEnvironmentRevisions,
  listSiteOperations,
  listSiteResources,
  markSiteDeploymentAccepted,
  markSiteDeploymentActive,
  markSiteDeploymentsTakenDown,
  markSiteOperationForReconcile,
  queueSiteOperation,
  recordSiteResource,
  resolveSiteOperationFromReconcile,
  restoreSiteDeployment,
  setSiteDeploymentEntryVerification,
  setSiteLifecycle,
  setSiteProviderTokenState,
  setSiteResourceStatus,
  updateSiteVisitorPolicy,
} from "@/lib/db/sites"
import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { sha256Hex } from "@/lib/share/hash"
import { writeTextFile } from "@/lib/file/file-operations"
import { assertSiteAuthoringCapability } from "@/lib/sites/authoring-policy"
import { latestEnvironmentRevision, pickActiveDeployment } from "@/lib/sites/console-model"
import {
  parseSiteWorkerAnalytics,
  parseSiteWorkerLogs,
  type SiteAnalyticsView,
  type SiteLogsView,
} from "./observability-parse"
import type { SiteHostingManifest } from "@/lib/sites/manifest"
import type {
  SiteDeploymentRow,
  SiteEntryVerification,
  SiteEnvironmentRevisionRow,
  SiteOperationRow,
  SiteOperationType,
  SiteProjectRow,
  SiteResourceKind,
  SiteResourceOwnership,
  SiteResourceRow,
  SiteSecretEdit,
  SiteSecretReference,
  SiteVersionRow,
  SiteVisitorPolicy,
} from "@/types/sites"
import {
  CloudflareSitesClient,
  CloudflareSitesError,
  CloudflareSitesTransportError,
  type CloudflareSitesClientOptions,
  type CloudflareWorker,
  type CloudflareWorkerRoute,
} from "./client"
import {
  cloudflareAccessPolicyMatches,
  compileCloudflareAccessPolicy,
  type CloudflareAccessPolicySpec,
} from "./access-policy"
import { probeSiteEntries, routeProbeUrl } from "./entry-probe"
import {
  uploadCloudflareWorkerVersion,
  type CloudflareVersionUploadInput,
  type CloudflareVersionUploadResult,
} from "./version-uploader"

type CloudflareClient = Pick<
  CloudflareSitesClient,
  | "verifyToken"
  | "createD1Database"
  | "listD1Databases"
  | "deleteD1Database"
  | "createR2Bucket"
  | "listR2Buckets"
  | "deleteR2Bucket"
  | "listVersions"
  | "getWorker"
  | "createDeployment"
  | "listDeployments"
  | "listDomains"
  | "attachDomain"
  | "detachDomain"
  | "setWorkersDev"
  | "getWorkersSubdomain"
  | "listWorkerRoutes"
  | "createWorkerRoute"
  | "deleteWorkerRoute"
  | "createAccessApplication"
  | "getAccessApplication"
  | "listAccessApplications"
  | "updateAccessApplication"
  | "deleteAccessApplication"
  | "listAccessPolicies"
  | "createAccessPolicy"
  | "updateAccessPolicy"
  | "deleteAccessPolicy"
  | "queryWorkerLogs"
  | "queryWorkerAnalytics"
  | "deleteWorker"
>

interface CloudflareSitesServiceDeps {
  keyring: KeyringStore
  createClient: (options: CloudflareSitesClientOptions) => CloudflareClient
  uploadVersion: (input: CloudflareVersionUploadInput) => Promise<CloudflareVersionUploadResult>
  writeText: (path: string, contents: string) => Promise<void>
  probeEntries: (input: {
    urls: readonly string[]
    unprobeable: readonly string[]
    now: number
  }) => Promise<SiteEntryVerification>
  now: () => number
  newId: (prefix: string) => string
  leaseOwner: string
  actorAccountId: string
}

export interface SiteVersionUploadPaths {
  wranglerBinaryPath: string
  /** As detection reported it; gates the secret flags `uploadVersion` passes. */
  wranglerVersion?: string | null
  stagingRoot: string
  configPath: string
  entryPath: string
  assetsPath?: string
}

function defaultDeps(keyring?: KeyringStore): CloudflareSitesServiceDeps {
  return {
    keyring: keyring ?? createLocalKeyringStore("cognia-sites"),
    createClient: (options) => new CloudflareSitesClient(options),
    uploadVersion: uploadCloudflareWorkerVersion,
    writeText: writeTextFile,
    probeEntries: (input) => probeSiteEntries(input),
    now: Date.now,
    newId: (prefix) => `${prefix}_${nanoid()}`,
    leaseOwner: `sites-window-${nanoid()}`,
    actorAccountId: "local-user",
  }
}

/**
 * The provider refused the mutation outright, so none of it happened.
 * Wrangler exiting non-zero without reporting a saved version is one.
 */
export class SiteProviderRejection extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SiteProviderRejection"
  }
}

/**
 * The action knows exactly where the provider ended up, even though writes
 * landed: it closed the entries it found exposed, or it saved a version it
 * then refused to record. The operation fails; there is nothing to reconcile.
 */
export class SiteOperationSettled extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SiteOperationSettled"
  }
}

/**
 * How an action sends anything that changes provider state.
 *
 * Whether a failed operation is `failed` or `waiting-reconcile` depends on
 * what was SENT, not on the type of the last error. Classifying by error type
 * read a 403 from the post-deploy subdomain lookup as "the deploy failed"
 * after Cloudflare had accepted it, and read a JavaScript error right after a
 * successful upload as uncertain only by the accident of it being a
 * `TypeError`. Every provider write goes through `mutate`; an error once any
 * write may have applied is uncertain unless the action says otherwise.
 */
export interface ProviderWrites {
  mutate<T>(call: () => Promise<T>): Promise<T>
}

/** Reconciliation already runs against provider state it just read. */
const UNTRACKED: ProviderWrites = { mutate: (call) => call() }

function definitelyRejected(error: unknown): boolean {
  if (error instanceof SiteProviderRejection) return true
  return (
    error instanceof CloudflareSitesError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  )
}

function providerNotFound(error: unknown): boolean {
  return error instanceof CloudflareSitesError && error.status === 404
}

/** A DELETE whose target is already gone has done its job. */
async function deleteIfPresent(call: () => Promise<unknown>): Promise<void> {
  try {
    await call()
  } catch (error) {
    if (!providerNotFound(error)) throw error
  }
}

function providerTokenKey(siteId: string): string {
  return `provider:${siteId}:cloudflare`
}

function resourceId(siteId: string, kind: SiteResourceKind, providerId: string): string {
  return `${siteId}:${kind}:${encodeURIComponent(providerId)}`
}

function workerResourceId(site: SiteProjectRow): string {
  return resourceId(site.id, "worker", site.providerConfig.workerName)
}

function objectId(value: unknown, label: string): string {
  if (!value || typeof value !== "object") throw new Error(`${label} response is invalid`)
  const id =
    (value as { id?: unknown; uuid?: unknown }).id ??
    (value as { id?: unknown; uuid?: unknown }).uuid
  if (typeof id !== "string" || !id.trim()) throw new Error(`${label} response has no id`)
  return id
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accessPolicy(value: unknown): CloudflareAccessPolicySpec & { id?: string } {
  if (!value || typeof value !== "object") throw new Error("Cloudflare Access policy is invalid")
  const row = value as Record<string, unknown>
  if (typeof row.name !== "string" || row.decision !== "allow" || !Array.isArray(row.include)) {
    throw new Error("Cloudflare Access policy is invalid")
  }
  return {
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    name: row.name,
    decision: "allow",
    include: row.include as CloudflareAccessPolicySpec["include"],
  }
}

function accessApplicationName(site: SiteProjectRow): string {
  return `${site.name} — Cognia Sites`
}

/**
 * One Access application bound to the Worker itself.
 *
 * The previous application protected the single hostname typed into the
 * console. Every other way into the Worker — its `workers.dev` name, a second
 * Custom Domain, a route, a version preview — stayed open, and "private" was
 * the default. A `worker` destination (Cloudflare, 2026-08) covers all of them,
 * including domains and routes attached later.
 */
function accessApplicationBody(site: SiteProjectRow, workerId: string): Record<string, unknown> {
  return {
    type: "self_hosted",
    name: accessApplicationName(site),
    destinations: [{ type: "worker", worker_id: workerId }],
    session_duration: "24h",
    auto_redirect_to_identity: false,
  }
}

function coversWorker(application: unknown, workerId: string): boolean {
  if (!application || typeof application !== "object") return false
  const destinations = (application as { destinations?: unknown }).destinations
  return (
    Array.isArray(destinations) &&
    destinations.some(
      (destination) =>
        !!destination &&
        typeof destination === "object" &&
        (destination as { type?: unknown }).type === "worker" &&
        (destination as { worker_id?: unknown }).worker_id === workerId
    )
  )
}

function restrictedPolicy(policy: SiteVisitorPolicy): boolean {
  return compileCloudflareAccessPolicy(policy).applicationRequired
}

/** Kinds that live inside the Worker and disappear when it is deleted. */
const CONTAINED_IN_WORKER: ReadonlySet<SiteResourceKind> = new Set(["secret", "worker-version"])

interface ProviderDomain {
  id: string
  hostname: string
  zoneId?: string
}

interface ProviderRoute extends CloudflareWorkerRoute {
  zoneId: string
}

interface RoutePlan {
  zoneId?: string
  create: string[]
  adopt: CloudflareWorkerRoute[]
  remove: SiteResourceRow[]
}

async function requiredSite(siteId: string): Promise<SiteProjectRow> {
  const site = await getSiteProject(siteId)
  if (!site || site.lifecycle === "deleted" || site.lifecycle === "deleting") {
    throw new Error("active site project not found")
  }
  if ((site.executionTarget as { kind?: unknown }).kind !== "local") {
    throw new Error("Sites provider operations require the selected local execution host")
  }
  return site
}

export class CloudflareSitesService {
  private readonly deps: CloudflareSitesServiceDeps

  constructor(deps?: Partial<CloudflareSitesServiceDeps>) {
    this.deps = { ...defaultDeps(deps?.keyring), ...deps }
  }

  private async client(
    siteId: string,
    allowDeleting = false
  ): Promise<{ site: SiteProjectRow; client: CloudflareClient }> {
    const site = allowDeleting ? await getSiteProject(siteId) : await requiredSite(siteId)
    if (!site || site.lifecycle === "deleted") throw new Error("Site project not found")
    if ((site.executionTarget as { kind?: unknown }).kind !== "local") {
      throw new Error("Sites provider operations require the selected local execution host")
    }
    const token = await this.deps.keyring.load(providerTokenKey(siteId))
    if (!token) throw new Error("Cloudflare provider token is not configured on this host")
    return { site, client: this.deps.createClient({ token }) }
  }

  /**
   * How long an operation may hold its lease before recovery may reclaim it.
   *
   * Uploading a large artifact through wrangler routinely exceeds ten minutes,
   * which was the previous value for everything. A lease shorter than the work
   * it protects is not a safety mechanism: recovery sees `running` with an
   * expired lease, terminates it, and the live call then fails at
   * `completeSiteOperation` on a lease-owner mismatch — with the provider-side
   * effect already applied. The long operations get a window that actually
   * covers them; everything else keeps the tighter one so a genuinely dead
   * claim is reclaimed promptly.
   */
  private leaseMsFor(type: SiteOperationType): number {
    return type === "build" || type === "upload" ? 60 * 60 * 1000 : 10 * 60 * 1000
  }

  /**
   * How many times this kind of change has already succeeded for the Site.
   *
   * Part of the idempotency key for repeatable intents. `takedown:<site>` and
   * `access:<site>:<policy>` were fixed, so the second takedown after a
   * restore — or re-applying a policy to repair drift — matched the first
   * success and returned without calling Cloudflare. Two clicks of the same
   * intent still read the same count and dedupe.
   */
  private async epoch(siteId: string, type: SiteOperationType): Promise<number> {
    return (await listSiteOperations(siteId)).filter(
      (operation) => operation.type === type && operation.status === "succeeded"
    ).length
  }

  private async runOperation<T>(input: {
    site: SiteProjectRow
    type: SiteOperationType
    idempotencyKey: string
    payload: unknown
    action: (provider: ProviderWrites) => Promise<T>
    replay?: () => Promise<T>
    /** Runs when the operation ends `failed`: nothing it was asked to do applied. */
    onDefiniteFailure?: (error: unknown) => Promise<void>
  }): Promise<T> {
    const inputDigest = await sha256Hex(canonicalStringify(input.payload))
    let operation: SiteOperationRow
    try {
      operation = await queueSiteOperation({
        id: this.deps.newId("siteop"),
        siteId: input.site.id,
        type: input.type,
        executionTargetKey: input.site.executionTargetKey,
        idempotencyKey: input.idempotencyKey,
        inputDigest,
        inputPayload: input.payload,
        now: this.deps.now(),
      })
      if (operation.status === "succeeded") {
        if (input.replay) return input.replay()
        throw new Error("Site operation already succeeded; refresh the current Site state")
      }
      if (operation.status !== "queued" && operation.status !== "running") {
        throw new Error(`Site operation requires reconciliation: ${operation.status}`)
      }
      await claimSiteOperation({
        operationId: operation.id,
        leaseOwner: this.deps.leaseOwner,
        leaseMs: this.leaseMsFor(input.type),
        now: this.deps.now(),
      })
    } catch (error) {
      await input.onDefiniteFailure?.(error)
      throw error
    }

    const writes = { mayHaveApplied: false }
    const provider: ProviderWrites = {
      mutate: async (call) => {
        try {
          const value = await call()
          writes.mayHaveApplied = true
          return value
        } catch (error) {
          if (!definitelyRejected(error)) writes.mayHaveApplied = true
          throw error
        }
      },
    }
    try {
      const value = await input.action(provider)
      await completeSiteOperation({
        operationId: operation.id,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.now(),
      })
      return value
    } catch (error) {
      if (writes.mayHaveApplied && !(error instanceof SiteOperationSettled)) {
        await markSiteOperationForReconcile({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: errorMessage(error),
          now: this.deps.now(),
        })
      } else {
        await failSiteOperation({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: errorMessage(error),
          now: this.deps.now(),
        })
        await input.onDefiniteFailure?.(error)
      }
      throw error
    }
  }

  async saveProviderToken(siteId: string, token: string): Promise<void> {
    const site = await requiredSite(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (!token.trim()) throw new Error("Cloudflare provider token is required")
    const client = this.deps.createClient({ token })
    let verification: { status: string }
    try {
      verification = await client.verifyToken()
    } catch (error) {
      await setSiteProviderTokenState(site.id, {
        executionTargetKey: site.executionTargetKey,
        status: "rejected",
        lastFailureAt: this.deps.now(),
      })
      throw error
    }
    if (verification.status !== "active") {
      await setSiteProviderTokenState(site.id, {
        executionTargetKey: site.executionTargetKey,
        status: "rejected",
        lastFailureAt: this.deps.now(),
      })
      throw new Error("Cloudflare provider token is not active")
    }
    await this.deps.keyring.save(providerTokenKey(site.id), token)
    // The console has no other way to ask "is a credential configured on this
    // host" — the keyring cannot be enumerated and the token must never come
    // back out for a UI check.
    await setSiteProviderTokenState(site.id, {
      executionTargetKey: site.executionTargetKey,
      status: "verified",
      verifiedAt: this.deps.now(),
    })
  }

  /**
   * Write a new environment revision.
   *
   * `secrets` is a list of edits, not a value map, because the editor cannot
   * seed itself from the keyring: a secret's value is unreadable by design. The
   * previous shape took only newly typed values, so saving a variable change
   * dropped every configured secret from the new revision and the next publish
   * pushed a worker without them. A `keep` carries the previous reference
   * forward verbatim — `credentialId` is revision-scoped and old entries are
   * never deleted, so both revisions stay resolvable.
   */
  async saveEnvironment(input: {
    siteId: string
    variables: Record<string, string>
    secrets: readonly SiteSecretEdit[]
  }): Promise<SiteEnvironmentRevisionRow> {
    const site = await requiredSite(input.siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "edit")
    const edits = input.secrets.filter((edit) => edit.action !== "remove")
    const variableKeys = Object.keys(input.variables)
    const secretKeys = edits.map((edit) => edit.key)
    const keys = [...variableKeys, ...secretKeys]
    if (new Set(keys).size !== keys.length)
      throw new Error("environment key cannot be both plain and secret")
    if (keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      throw new Error("environment keys must be JavaScript identifiers")
    }

    const previous = latestEnvironmentRevision(await listSiteEnvironmentRevisions(site.id))
    const carried = new Map(previous?.secretRefs.map((ref) => [ref.key, ref]) ?? [])
    const revisionId = this.deps.newId("siteenv")

    const secretRefs: SiteSecretReference[] = []
    const minted: Array<{ credentialId: string; value: string }> = []
    for (const edit of [...edits].sort((left, right) => left.key.localeCompare(right.key))) {
      if (edit.action === "keep") {
        const existing = carried.get(edit.key)
        if (!existing) throw new Error(`no stored secret to keep for ${edit.key}`)
        secretRefs.push(existing)
        continue
      }
      const credentialId = `${mintedCredentialPrefix(site.id, revisionId)}${edit.key}`
      secretRefs.push({ key: edit.key, credentialId, revision: this.deps.newId("secret") })
      minted.push({ credentialId, value: edit.value })
    }

    const saved: string[] = []
    try {
      for (const credential of minted) {
        await this.deps.keyring.save(credential.credentialId, credential.value)
        saved.push(credential.credentialId)
      }
      return await this.runOperation({
        site,
        type: "environment",
        idempotencyKey: `environment:${site.id}:${revisionId}`,
        payload: {
          revisionId,
          variables: input.variables,
          secretKeys: secretKeys.sort(),
          secretRefs,
        },
        action: () =>
          createSiteEnvironmentRevision({
            id: revisionId,
            siteId: site.id,
            variables: input.variables,
            secretRefs,
            now: this.deps.now(),
          }),
      })
    } catch (error) {
      // A revision that committed before the failure (a lost lease on
      // completion) references these values; only an unsaved draft's are
      // safe to remove.
      if (!(await getSiteEnvironmentRevision(revisionId))) {
        await Promise.all(saved.map((key) => this.deps.keyring.delete(key)))
      }
      throw error
    }
  }

  /**
   * Resume what a stopped host left behind.
   *
   * Reads the Site even while it is `deleting`: a purge interrupted by the
   * host stopping is exactly the operation that needs recovering, and
   * refusing that lifecycle left the Site wedged in `deleting` for good.
   */
  async recoverInterruptedOperations(siteId: string): Promise<number> {
    const site = await getSiteProject(siteId)
    if (!site || site.lifecycle === "deleted") throw new Error("Site project not found")
    if ((site.executionTarget as { kind?: unknown }).kind !== "local") {
      throw new Error("Sites provider operations require the selected local execution host")
    }
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    let recovered = 0
    for (;;) {
      const operation = await claimNextSiteOperation({
        executionTargetKey: site.executionTargetKey,
        siteId: site.id,
        leaseOwner: this.deps.leaseOwner,
        leaseMs: 10 * 60 * 1000,
        now: this.deps.now(),
      })
      if (!operation) break
      const payload =
        operation.inputPayload && typeof operation.inputPayload === "object"
          ? (operation.inputPayload as Record<string, unknown>)
          : {}
      if (operation.type === "build") {
        if (typeof payload.versionId === "string") {
          await failSiteVersion(
            payload.versionId,
            "Build was interrupted when the desktop host stopped",
            this.deps.now()
          )
        }
        await failSiteOperation({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: "Build was interrupted; create a new immutable Site version",
          now: this.deps.now(),
        })
      } else if (operation.type === "environment") {
        await this.recoverEnvironmentSave(site, operation, payload)
      } else {
        await markSiteOperationForReconcile({
          operationId: operation.id,
          leaseOwner: this.deps.leaseOwner,
          message: "Desktop host stopped during a provider mutation",
          now: this.deps.now(),
        })
      }
      recovered += 1
    }
    return recovered
  }

  /**
   * An environment save stopped mid-way.
   *
   * Recovery used to delete every credential in the payload's `secretRefs` —
   * which carries `keep` references verbatim, so a crash deleted values the
   * PREVIOUS revision still pointed at, and redeploying that revision then
   * failed on a missing secret. Only credentials minted for this revision
   * (their id carries its revision prefix) are drafts, and only when the
   * revision itself never committed; if it did, the save simply finished.
   */
  private async recoverEnvironmentSave(
    site: SiteProjectRow,
    operation: SiteOperationRow,
    payload: Record<string, unknown>
  ): Promise<void> {
    const revisionId = typeof payload.revisionId === "string" ? payload.revisionId : ""
    if (revisionId && (await getSiteEnvironmentRevision(revisionId))) {
      await completeSiteOperation({
        operationId: operation.id,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.now(),
      })
      return
    }
    const prefix = revisionId ? mintedCredentialPrefix(site.id, revisionId) : undefined
    const references = Array.isArray(payload.secretRefs) ? payload.secretRefs : []
    await Promise.all(
      references.map((reference) => {
        const credentialId =
          reference && typeof reference === "object"
            ? (reference as { credentialId?: unknown }).credentialId
            : undefined
        return prefix && typeof credentialId === "string" && credentialId.startsWith(prefix)
          ? this.deps.keyring.delete(credentialId)
          : Promise.resolve()
      })
    )
    await failSiteOperation({
      operationId: operation.id,
      leaseOwner: this.deps.leaseOwner,
      message: "Environment save was interrupted; its new secret drafts were removed",
      now: this.deps.now(),
    })
  }

  async provisionBindings(
    siteId: string,
    bindings: SiteHostingManifest["cloudflare"]["bindings"]
  ): Promise<SiteResourceRow[]> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    const output: SiteResourceRow[] = []
    for (const binding of bindings) {
      if (binding.ownership !== "managed" && !binding.providerResourceId) {
        throw new Error(`adopted/shared binding ${binding.name} requires a provider resource id`)
      }
      if (binding.ownership === "managed" && binding.providerResourceId) {
        throw new Error(
          `managed binding ${binding.name} is created by Cognia; declare an existing resource as adopted or shared`
        )
      }
      const kind = binding.kind === "d1" ? "d1-database" : "r2-bucket"
      const row = await this.runOperation({
        site,
        type: "provision",
        idempotencyKey: `provision:${site.id}:${binding.kind}:${binding.name}:${binding.resourceName}`,
        payload: binding,
        replay: async () => {
          const existing = (await listSiteResources(site.id)).find(
            (resource) => resource.metadata?.bindingName === binding.name && resource.kind === kind
          )
          if (!existing) throw new Error("completed Site binding operation has no resource record")
          return existing
        },
        action: async (provider) => {
          let providerId = binding.providerResourceId
          if (!providerId) {
            // A managed resource is one Cognia created. Creating it under a
            // name the account already uses would either fail or — after an
            // uncertain create — let reconciliation claim someone else's
            // database by that name. The name must be free first.
            const taken =
              binding.kind === "d1"
                ? (await client.listD1Databases(site.providerConfig.accountId)).some(
                    (row) => row.name === binding.resourceName
                  )
                : (await client.listR2Buckets(site.providerConfig.accountId)).some(
                    (row) => row.name === binding.resourceName
                  )
            if (taken) {
              throw new Error(
                `${binding.resourceName} already exists in this Cloudflare account; declare it adopted or shared with its id`
              )
            }
          }
          if (!providerId && binding.kind === "d1") {
            providerId = objectId(
              await provider.mutate(() =>
                client.createD1Database(site.providerConfig.accountId, {
                  name: binding.resourceName,
                })
              ),
              "Cloudflare D1"
            )
          }
          if (!providerId && binding.kind === "r2") {
            const created = await provider.mutate(() =>
              client.createR2Bucket(site.providerConfig.accountId, { name: binding.resourceName })
            )
            providerId = typeof created.name === "string" ? created.name : binding.resourceName
          }
          if (!providerId) throw new Error("Cloudflare resource id is missing")
          return recordSiteResource({
            id: resourceId(site.id, kind, providerId),
            siteId: site.id,
            provider: "cloudflare",
            kind,
            providerResourceId: providerId,
            displayName: binding.resourceName,
            metadata: { bindingName: binding.name },
            ownership: binding.ownership,
            dependencies: [],
            now: this.deps.now(),
          })
        },
      })
      output.push(row)
    }
    return output
  }

  private async loadSecrets(
    environment: SiteEnvironmentRevisionRow
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {}
    for (const reference of environment.secretRefs) {
      const value = await this.deps.keyring.load(reference.credentialId)
      if (value === null) throw new Error(`secret ${reference.key} is unavailable on this host`)
      values[reference.key] = value
    }
    return values
  }

  /**
   * The D1/R2 resources THIS version binds.
   *
   * Upload used to bind every D1 and R2 row on the Site, whatever its status,
   * so re-uploading an old version attached a database provisioned after it
   * was built. The version snapshot names its bindings; each resolves to the
   * active resource provisioned for that binding name (and its pinned
   * provider id, for an adopted one).
   */
  private versionBindings(
    version: SiteVersionRow,
    resources: readonly SiteResourceRow[]
  ): Array<{ name: string; row: SiteResourceRow }> {
    return version.build.bindings.map((binding) => {
      const kind = binding.kind === "d1" ? "d1-database" : "r2-bucket"
      const row = resources.find(
        (resource) =>
          resource.kind === kind &&
          resource.status === "active" &&
          resource.metadata?.bindingName === binding.name &&
          (!binding.resourceId || resource.providerResourceId === binding.resourceId)
      )
      if (!row) {
        throw new Error(`binding ${binding.name} of this version is not provisioned on this Site`)
      }
      return { name: binding.name, row }
    })
  }

  /**
   * The Worker's ledger row, created before the first upload touches it.
   *
   * `managed` only when this upload creates the Worker. A Site pointed at a
   * Worker that already existed records it `adopted`, so purge leaves it
   * standing. Recorded before the provider call so a retry and reconciliation
   * read the same answer instead of re-probing a Worker the upload created.
   */
  private async ensureWorkerRecord(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<SiteResourceRow> {
    const existing = await getSiteResource(workerResourceId(site))
    if (existing) return existing
    let ownership: SiteResourceOwnership = "managed"
    try {
      await client.getWorker(site.providerConfig.accountId, site.providerConfig.workerName)
      ownership = "adopted"
    } catch (error) {
      if (!providerNotFound(error)) throw error
    }
    return recordSiteResource({
      id: workerResourceId(site),
      siteId: site.id,
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: site.providerConfig.workerName,
      displayName: site.providerConfig.workerName,
      ownership,
      dependencies: [],
      now: this.deps.now(),
    })
  }

  /**
   * The provider version a Cognia version became.
   *
   * The output file names the uploaded version. When the upload also had to
   * drop secrets, the version to record is the newer one `versions secret
   * bulk` created from it: the newest version carrying the tag, made by a
   * secret change.
   */
  private async uploadedVersionId(
    site: SiteProjectRow,
    client: CloudflareClient,
    tag: string,
    expectSecretChange: boolean,
    reported?: string
  ): Promise<string | undefined> {
    if (reported && !expectSecretChange) return reported
    const versions = await client.listVersions(
      site.providerConfig.accountId,
      site.providerConfig.workerName
    )
    const newest = versions.find((version) => version.annotations?.["workers/tag"] === tag)
    if (!newest) return undefined
    if (expectSecretChange) {
      if (newest.id === reported || newest.annotations?.["workers/triggered_by"] !== "secret") {
        return undefined
      }
    }
    return newest.id
  }

  private async recordUpload(
    site: SiteProjectRow,
    version: SiteVersionRow,
    providerId: string,
    input: {
      workerTag?: string
      bindingIds: string[]
      secretKeys: string[]
      removedSecrets: string[]
    }
  ): Promise<void> {
    const recorded = await getSiteResource(workerResourceId(site))
    if (!recorded) throw new Error("Site upload has no Worker record")
    const worker = await recordSiteResource({
      id: recorded.id,
      siteId: site.id,
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: recorded.providerResourceId,
      displayName: recorded.displayName,
      metadata: {
        ...recorded.metadata,
        ...(input.workerTag ? { workerTag: input.workerTag } : {}),
      },
      ownership: recorded.ownership,
      dependencies: input.bindingIds,
      status: "active",
      now: this.deps.now(),
    })
    await recordSiteResource({
      id: resourceId(site.id, "worker-version", providerId),
      siteId: site.id,
      provider: "cloudflare",
      kind: "worker-version",
      providerResourceId: providerId,
      displayName: version.id,
      metadata: { artifactDigest: version.artifactDigest! },
      ownership: "managed",
      dependencies: [worker.id, ...input.bindingIds],
      now: this.deps.now(),
    })
    // The ledger of secrets is "what the Worker's latest version carries",
    // which is what the next upload inherits and must remove from.
    for (const key of input.secretKeys) {
      await recordSiteResource({
        id: resourceId(site.id, "secret", key),
        siteId: site.id,
        provider: "cloudflare",
        kind: "secret",
        providerResourceId: key,
        displayName: key,
        ownership: worker.ownership,
        dependencies: [],
        status: "active",
        now: this.deps.now(),
      })
    }
    for (const key of input.removedSecrets) {
      const row = await getSiteResource(resourceId(site.id, "secret", key))
      if (row) await setSiteResourceStatus(row.id, "deleted", this.deps.now())
    }
  }

  async uploadVersion(
    siteId: string,
    versionId: string,
    paths: SiteVersionUploadPaths
  ): Promise<string> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    const version = await getSiteVersion(versionId)
    if (
      !version ||
      version.siteId !== site.id ||
      version.status !== "ready" ||
      !version.artifactDigest
    ) {
      throw new Error("ready Site version not found")
    }
    if (!(await getSiteArtifact(version.artifactDigest)))
      throw new Error("Site version artifact not found")
    const environment = await getSiteEnvironmentRevision(version.environmentRevisionId)
    if (!environment) throw new Error("Site environment revision not found")
    const resources = await listSiteResources(site.id)
    const bindings = this.versionBindings(version, resources)
    const config = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: site.providerConfig.workerName,
      main: paths.entryPath,
      compatibility_date: version.build.compatibilityDate,
      compatibility_flags: version.build.compatibilityFlags,
      // No `routes`: `versions upload` never applies triggers, so a route
      // written here was configuration that did nothing. Deploy attaches the
      // version's routes through the zone routes API.
      vars: environment.variables,
      d1_databases: bindings
        .filter(({ row }) => row.kind === "d1-database")
        .map(({ name, row }) => ({
          binding: name,
          database_name: row.displayName,
          database_id: row.providerResourceId,
        })),
      r2_buckets: bindings
        .filter(({ row }) => row.kind === "r2-bucket")
        .map(({ name, row }) => ({ binding: name, bucket_name: row.providerResourceId })),
    }
    await this.deps.writeText(paths.configPath, JSON.stringify(config, null, 2))
    const secrets = await this.loadSecrets(environment)
    const secretKeys = Object.keys(secrets).sort()
    const removedSecrets = resources
      .filter((row) => row.kind === "secret" && row.status === "active")
      .map((row) => row.providerResourceId)
      .filter((key) => !Object.hasOwn(secrets, key))
      .sort()
    const bindingIds = bindings.map(({ row }) => row.id)
    const tag = `cognia-${version.id}`
    return this.runOperation({
      site,
      type: "upload",
      idempotencyKey: `upload:${site.id}:${version.id}:${version.artifactDigest}`,
      payload: {
        versionId,
        artifactDigest: version.artifactDigest,
        config,
        tag,
        secretKeys,
        removedSecrets,
        bindingIds,
      },
      replay: async () => {
        const existing = (await listSiteResources(site.id)).find(
          (row) => row.kind === "worker-version" && row.displayName === version.id
        )
        if (!existing) throw new Error("completed Site upload has no provider version record")
        return existing.providerResourceId
      },
      action: async (provider) => {
        const token = await this.deps.keyring.load(providerTokenKey(site.id))
        if (!token) throw new Error("Cloudflare provider token is not configured on this host")
        await this.ensureWorkerRecord(site, client)
        const result = await provider.mutate(async () => {
          const upload = await this.deps.uploadVersion({
            ...paths,
            workerName: site.providerConfig.workerName,
            accountId: site.providerConfig.accountId,
            apiToken: token,
            tag,
            message: `Cognia Sites version ${version.sequence}`,
            compatibilityDate: version.build.compatibilityDate,
            compatibilityFlags: version.build.compatibilityFlags,
            secrets,
            removedSecrets,
          })
          if (upload.timedOut) {
            throw new CloudflareSitesTransportError("Cloudflare version upload timed out")
          }
          if (upload.exitCode !== 0 && !upload.versionId) {
            throw new SiteProviderRejection(upload.stderr || "Cloudflare version upload failed")
          }
          return upload
        })
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || "wrangler failed after Cloudflare saved the version")
        }
        if (result.secretRemoval) {
          if (result.secretRemoval.timedOut) {
            throw new CloudflareSitesTransportError(
              "Removing old secrets from the version timed out"
            )
          }
          if (result.secretRemoval.exitCode !== 0) {
            throw new SiteOperationSettled(
              `Cloudflare saved the version but did not remove ${removedSecrets.join(", ")}: ${
                result.secretRemoval.stderr || "wrangler failed"
              }. The version was not recorded; upload again.`
            )
          }
        }
        const providerId = await this.uploadedVersionId(
          site,
          client,
          tag,
          removedSecrets.length > 0,
          result.versionId
        )
        if (!providerId) {
          throw new Error("Cloudflare accepted the upload but the saved version is not yet visible")
        }
        await this.recordUpload(site, version, providerId, {
          ...(result.workerTag ? { workerTag: result.workerTag } : {}),
          bindingIds,
          secretKeys,
          removedSecrets,
        })
        return providerId
      },
    })
  }

  /* ------------------------------------------------------------- entries */

  private async readWorker(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<CloudflareWorker | undefined> {
    try {
      return await client.getWorker(site.providerConfig.accountId, site.providerConfig.workerName)
    } catch (error) {
      if (providerNotFound(error)) return undefined
      throw error
    }
  }

  /** The Worker's immutable ID, which a Worker-scoped Access destination names. */
  private async workerId(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<string | undefined> {
    const tag = (await getSiteResource(workerResourceId(site)))?.metadata?.workerTag
    if (tag) return tag
    return (await this.readWorker(site, client))?.id
  }

  private async workersDevUrl(site: SiteProjectRow, client: CloudflareClient): Promise<string> {
    const { subdomain } = await client.getWorkersSubdomain(site.providerConfig.accountId)
    return `https://${site.providerConfig.workerName}.${subdomain}.workers.dev`
  }

  /** Custom Domains Cloudflare routes to this Worker, ledger or not. */
  private async providerDomains(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<ProviderDomain[]> {
    return (await client.listDomains(site.providerConfig.accountId)).flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const row = value as {
        id?: unknown
        hostname?: unknown
        service?: unknown
        zone_id?: unknown
      }
      if (
        row.service !== site.providerConfig.workerName ||
        typeof row.id !== "string" ||
        typeof row.hostname !== "string"
      ) {
        return []
      }
      return [
        {
          id: row.id,
          hostname: row.hostname,
          ...(typeof row.zone_id === "string" ? { zoneId: row.zone_id } : {}),
        },
      ]
    })
  }

  /** Routes sending traffic to this Worker in the Site's zone and every zone it recorded routes in. */
  private async providerRoutes(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<ProviderRoute[]> {
    const zones = new Set<string>()
    if (site.providerConfig.zoneId) zones.add(site.providerConfig.zoneId)
    for (const row of await listSiteResources(site.id)) {
      if (row.kind === "worker-route" && row.metadata?.zoneId) zones.add(row.metadata.zoneId)
    }
    const routes: ProviderRoute[] = []
    for (const zoneId of zones) {
      for (const route of await client.listWorkerRoutes(zoneId)) {
        if (route.script === site.providerConfig.workerName) routes.push({ ...route, zoneId })
      }
    }
    return routes
  }

  /**
   * Visitor access, as Cloudflare holds it now.
   *
   * Returns why it is NOT in force, or `undefined` when it is (or the policy
   * is public). Read before any traffic moves: a restricted Site whose
   * protection cannot be confirmed does not get published (ADR-0084: "an
   * unverifiable or bypassed policy fails closed for restricted Sites").
   */
  private async accessNotInForce(
    site: SiteProjectRow,
    client: CloudflareClient,
    policy: SiteVisitorPolicy
  ): Promise<string | undefined> {
    const desired = compileCloudflareAccessPolicy(policy)
    if (!desired.applicationRequired) return undefined
    const workerId = await this.workerId(site, client)
    if (!workerId) return "the Worker does not exist yet"
    const application = (await listSiteResources(site.id)).find(
      (row) => row.kind === "access-application" && row.status === "active"
    )
    if (!application) return "no Cloudflare Access application protects this Worker"
    let remote: unknown
    try {
      remote = await client.getAccessApplication(
        site.providerConfig.accountId,
        application.providerResourceId
      )
    } catch (error) {
      if (providerNotFound(error)) return "its Cloudflare Access application was deleted"
      throw error
    }
    if (!coversWorker(remote, workerId)) {
      return "its Cloudflare Access application does not cover the Worker"
    }
    const policies = (
      await client.listAccessPolicies(site.providerConfig.accountId, application.providerResourceId)
    ).map(accessPolicy)
    if (!cloudflareAccessPolicyMatches(desired, policies)) {
      return "its Cloudflare Access policies differ from the Site's visitor policy"
    }
    return undefined
  }

  /** Every URL a visitor can reach the Worker on right now, and patterns with no single URL. */
  private async servingEntries(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<{ urls: string[]; unprobeable: string[] }> {
    const urls: string[] = []
    const unprobeable: string[] = []
    const worker = await this.readWorker(site, client)
    if (worker?.subdomain?.enabled) urls.push(`${await this.workersDevUrl(site, client)}/`)
    for (const domain of await this.providerDomains(site, client)) {
      urls.push(`https://${domain.hostname}/`)
    }
    for (const route of await this.providerRoutes(site, client)) {
      const url = routeProbeUrl(route.pattern)
      if (url) urls.push(url)
      else unprobeable.push(route.pattern)
    }
    return { urls: [...new Set(urls)], unprobeable }
  }

  private async verifyEntries(
    site: SiteProjectRow,
    client: CloudflareClient
  ): Promise<SiteEntryVerification> {
    return this.deps.probeEntries({
      ...(await this.servingEntries(site, client)),
      now: this.deps.now(),
    })
  }

  private async recordWorkersDevState(site: SiteProjectRow, enabled: boolean): Promise<void> {
    const worker = await getSiteResource(workerResourceId(site))
    if (!worker) return
    await recordSiteResource({
      id: worker.id,
      siteId: site.id,
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: worker.providerResourceId,
      displayName: worker.displayName,
      metadata: { ...worker.metadata, workersDev: enabled ? "enabled" : "disabled" },
      ownership: worker.ownership,
      dependencies: worker.dependencies,
      now: this.deps.now(),
    })
  }

  /**
   * Stop every way in: `workers.dev`, every Custom Domain and every route
   * pointing at the Worker.
   *
   * Takedown used to disable `workers.dev` and detach only the domains in
   * Cognia's ledger, so a domain attached in the dashboard, or any route, kept
   * serving a "taken down" Site. The provider's own lists are the inventory;
   * what was not in the ledger is recorded (`adopted`, `orphaned`) so restore
   * puts it back and purge leaves it alone.
   */
  private async closeEntries(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites
  ): Promise<void> {
    const accountId = site.providerConfig.accountId
    const worker = await this.readWorker(site, client)
    if (!worker) return
    const workersDevEnabled = worker.subdomain?.enabled === true
    if (workersDevEnabled) {
      await provider.mutate(() =>
        client.setWorkersDev(accountId, site.providerConfig.workerName, false)
      )
    }
    await this.recordWorkersDevState(site, workersDevEnabled)

    const ledger = await listSiteResources(site.id)
    const domains = await this.providerDomains(site, client)
    for (const domain of domains) {
      await provider.mutate(() => deleteIfPresent(() => client.detachDomain(accountId, domain.id)))
      const known = ledger.find(
        (row) => row.kind === "custom-domain" && row.providerResourceId === domain.id
      )
      if (known) {
        await setSiteResourceStatus(known.id, "orphaned", this.deps.now())
      } else {
        await recordSiteResource({
          id: resourceId(site.id, "custom-domain", domain.id),
          siteId: site.id,
          provider: "cloudflare",
          kind: "custom-domain",
          providerResourceId: domain.id,
          displayName: domain.hostname,
          metadata: { zoneId: domain.zoneId ?? "" },
          ownership: "adopted",
          status: "orphaned",
          dependencies: [workerResourceId(site)],
          now: this.deps.now(),
        })
      }
    }
    // A ledger domain the provider no longer lists was detached elsewhere; it
    // is still this Site's to put back on restore.
    for (const row of ledger.filter(
      (candidate) =>
        candidate.kind === "custom-domain" &&
        candidate.status === "active" &&
        !domains.some((domain) => domain.id === candidate.providerResourceId)
    )) {
      await setSiteResourceStatus(row.id, "orphaned", this.deps.now())
    }

    for (const route of await this.providerRoutes(site, client)) {
      await provider.mutate(() =>
        deleteIfPresent(() => client.deleteWorkerRoute(route.zoneId, route.id))
      )
      const known = ledger.find(
        (row) => row.kind === "worker-route" && row.providerResourceId === route.id
      )
      if (known) {
        await setSiteResourceStatus(known.id, "orphaned", this.deps.now())
      } else {
        await recordSiteResource({
          id: resourceId(site.id, "worker-route", route.id),
          siteId: site.id,
          provider: "cloudflare",
          kind: "worker-route",
          providerResourceId: route.id,
          displayName: route.pattern,
          metadata: { zoneId: route.zoneId, pattern: route.pattern },
          ownership: "adopted",
          status: "orphaned",
          dependencies: [workerResourceId(site)],
          now: this.deps.now(),
        })
      }
    }
  }

  /** Put back what `closeEntries` closed, as it was before. */
  private async reopenEntries(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites
  ): Promise<void> {
    const accountId = site.providerConfig.accountId
    const resources = await listSiteResources(site.id)
    // Restore used to switch `workers.dev` on unconditionally, opening an
    // entry the Site never had before it was taken down.
    const worker = resources.find((row) => row.id === workerResourceId(site))
    if (worker?.metadata?.workersDev !== "disabled") {
      await provider.mutate(() =>
        client.setWorkersDev(accountId, site.providerConfig.workerName, true)
      )
    }
    for (const domain of resources.filter(
      (row) =>
        row.kind === "custom-domain" &&
        row.status === "orphaned" &&
        row.displayName &&
        row.metadata?.zoneId
    )) {
      const attached = await provider.mutate(() =>
        client.attachDomain(accountId, {
          zoneId: domain.metadata!.zoneId,
          hostname: domain.displayName!,
          workerName: site.providerConfig.workerName,
        })
      )
      await setSiteResourceStatus(domain.id, "deleted", this.deps.now())
      await recordSiteResource({
        id: resourceId(site.id, "custom-domain", attached.id),
        siteId: site.id,
        provider: "cloudflare",
        kind: "custom-domain",
        providerResourceId: attached.id,
        displayName: domain.displayName!,
        metadata: { zoneId: domain.metadata!.zoneId },
        ownership: domain.ownership,
        status: "active",
        dependencies: [workerResourceId(site)],
        now: this.deps.now(),
      })
    }
    const orphanedRoutes = resources.filter(
      (row) =>
        row.kind === "worker-route" &&
        row.status === "orphaned" &&
        row.metadata?.zoneId &&
        row.metadata?.pattern
    )
    const live = new Map<string, CloudflareWorkerRoute[]>()
    for (const row of orphanedRoutes) {
      const zoneId = row.metadata!.zoneId
      if (!live.has(zoneId)) live.set(zoneId, await client.listWorkerRoutes(zoneId))
      const pattern = row.metadata!.pattern
      const present = live
        .get(zoneId)!
        .find(
          (route) => route.pattern === pattern && route.script === site.providerConfig.workerName
        )
      const route =
        present ??
        (await provider.mutate(() =>
          client.createWorkerRoute(zoneId, { pattern, script: site.providerConfig.workerName })
        ))
      await setSiteResourceStatus(row.id, "deleted", this.deps.now())
      await this.recordRoute(site, { id: route.id, pattern }, zoneId, row.ownership)
    }
  }

  /**
   * The entry check found a restricted Site answering anonymous visitors.
   * Close every entry and record why; returns the message for the journal.
   */
  private async closeExposedEntries(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites,
    deploymentId: string,
    verification: SiteEntryVerification
  ): Promise<string> {
    const exposed = verification.entries
      .filter((entry) => entry.outcome === "exposed")
      .map((entry) => entry.url)
    const message = `Cloudflare Access did not stop anonymous visitors at ${exposed.join(
      ", "
    )}; Cognia took the Site down`
    await this.closeEntries(site, client, provider)
    await markSiteDeploymentsTakenDown(site.id, this.deps.now())
    if ((await getSiteProject(site.id))?.lifecycle === "active") {
      await setSiteLifecycle(site.id, "taken-down", this.deps.now())
    }
    await setSiteDeploymentEntryVerification(deploymentId, verification, message, this.deps.now())
    return message
  }

  /* -------------------------------------------------------------- routes */

  private async recordRoute(
    site: SiteProjectRow,
    route: { id: string; pattern: string },
    zoneId: string,
    ownership: SiteResourceOwnership = "managed"
  ): Promise<SiteResourceRow> {
    return recordSiteResource({
      id: resourceId(site.id, "worker-route", route.id),
      siteId: site.id,
      provider: "cloudflare",
      kind: "worker-route",
      providerResourceId: route.id,
      displayName: route.pattern,
      metadata: { zoneId, pattern: route.pattern },
      ownership,
      status: "active",
      dependencies: [workerResourceId(site)],
      now: this.deps.now(),
    })
  }

  /**
   * What the routes of the version being deployed need, read before anything
   * changes. A pattern already routed to a different Worker refuses the
   * deploy: taking it over would cut that Worker's traffic.
   */
  private async planRoutes(
    site: SiteProjectRow,
    client: CloudflareClient,
    patterns: readonly string[]
  ): Promise<RoutePlan> {
    const ledger = (await listSiteResources(site.id)).filter(
      (row) => row.kind === "worker-route" && row.status === "active" && row.ownership === "managed"
    )
    const wanted = [...new Set(patterns)]
    if (wanted.length === 0 && ledger.length === 0) return { create: [], adopt: [], remove: [] }
    const zoneId = site.providerConfig.zoneId
    if (wanted.length > 0 && !zoneId) {
      throw new Error("This version publishes routes; set the Site's Cloudflare zone id first")
    }
    const existing = zoneId ? await client.listWorkerRoutes(zoneId) : []
    const create: string[] = []
    const adopt: CloudflareWorkerRoute[] = []
    for (const pattern of wanted) {
      const match = existing.find((route) => route.pattern === pattern)
      if (match && match.script !== site.providerConfig.workerName) {
        throw new Error(
          `Route ${pattern} already sends traffic to Worker ${match.script ?? "(none)"}`
        )
      }
      if (match) adopt.push(match)
      else create.push(pattern)
    }
    const remove = ledger.filter((row) => !wanted.includes(row.metadata?.pattern ?? ""))
    return { ...(zoneId ? { zoneId } : {}), create, adopt, remove }
  }

  private async applyRoutes(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites,
    plan: RoutePlan
  ): Promise<void> {
    for (const row of plan.remove) {
      const zoneId = row.metadata?.zoneId
      if (zoneId) {
        await provider.mutate(() =>
          deleteIfPresent(() => client.deleteWorkerRoute(zoneId, row.providerResourceId))
        )
      }
      await setSiteResourceStatus(row.id, "deleted", this.deps.now())
    }
    if (!plan.zoneId) return
    const zoneId = plan.zoneId
    for (const route of plan.adopt) await this.recordRoute(site, route, zoneId)
    for (const pattern of plan.create) {
      const route = await provider.mutate(() =>
        client.createWorkerRoute(zoneId, { pattern, script: site.providerConfig.workerName })
      )
      await this.recordRoute(site, { id: objectId(route, "Cloudflare route"), pattern }, zoneId)
    }
  }

  /* ------------------------------------------------------------- deploy */

  /**
   * After Cloudflare accepted a deployment: attach the version's routes and,
   * for a Worker with no other way in, its `workers.dev` name.
   *
   * Shared with reconciliation. A deploy whose route attach failed after the
   * accept used to be marked live by reconciliation with its routes never
   * attached; reconciliation now finishes the same step.
   */
  private async openDeployedEntries(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites,
    state: { routes: RoutePlan; worker: CloudflareWorker | undefined; domains: ProviderDomain[] }
  ): Promise<void> {
    await this.applyRoutes(site, client, provider, state.routes)
    // A Worker with no other entry is unreachable; `workers.dev` is the one it
    // always has.
    const routed = state.routes.create.length + state.routes.adopt.length > 0
    if (!state.worker?.subdomain?.enabled && state.domains.length === 0 && !routed) {
      await provider.mutate(() =>
        client.setWorkersDev(site.providerConfig.accountId, site.providerConfig.workerName, true)
      )
    }
  }

  /**
   * Mark the accepted deployment live — after checking, for a restricted
   * Site, that every entry actually stops an anonymous visitor.
   */
  private async activateDeployment(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites,
    deploymentId: string,
    providerDeploymentId: string,
    productionUrl: string
  ): Promise<SiteDeploymentRow> {
    const entryVerification = restrictedPolicy(site.visitorPolicy)
      ? await this.verifyEntries(site, client)
      : undefined
    const active = await markSiteDeploymentActive({
      deploymentId,
      providerDeploymentId,
      productionUrl,
      ...(entryVerification ? { entryVerification } : {}),
      now: this.deps.now(),
    })
    if (entryVerification?.state === "exposed") {
      throw new SiteOperationSettled(
        await this.closeExposedEntries(site, client, provider, deploymentId, entryVerification)
      )
    }
    return active
  }

  async deployVersion(siteId: string, versionId: string): Promise<SiteDeploymentRow> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    const version = await getSiteVersion(versionId)
    if (!version || version.siteId !== site.id || version.status !== "ready") {
      throw new Error("ready Site version not found")
    }
    const environment = await getSiteEnvironmentRevision(version.environmentRevisionId)
    if (!environment) throw new Error("Site environment revision not found")
    const versionResource = (await listSiteResources(site.id)).find(
      (row) =>
        row.kind === "worker-version" && row.displayName === version.id && row.status === "active"
    )
    if (!versionResource) throw new Error("Site version must be uploaded before deployment")
    const deployment = await createSiteDeployment({
      id: this.deps.newId("sitedeploy"),
      siteId: site.id,
      versionId: version.id,
      environmentRevisionId: environment.id,
      now: this.deps.now(),
    })
    const accountId = site.providerConfig.accountId
    const workerName = site.providerConfig.workerName
    return this.runOperation({
      site,
      type: "deploy",
      idempotencyKey: `deploy:${site.id}:${version.id}:${deployment.id}`,
      payload: {
        versionId: version.id,
        environmentRevisionId: environment.id,
        deploymentId: deployment.id,
        providerVersionId: versionResource.providerResourceId,
      },
      onDefiniteFailure: async (error) => {
        const current = await getSiteDeployment(deployment.id)
        if (
          current &&
          (current.status === "pending" || current.status === "deploying") &&
          !current.providerDeploymentId
        ) {
          await failSiteDeployment(deployment.id, errorMessage(error), this.deps.now())
        }
      },
      action: async (provider) => {
        // Everything that can refuse the deploy is read first, so a refusal
        // leaves production exactly as it was.
        const accessGap = await this.accessNotInForce(site, client, site.visitorPolicy)
        if (accessGap) {
          throw new Error(
            `Visitor access is not in force: ${accessGap}. Apply the Site's visitor policy before publishing it.`
          )
        }
        const routes = await this.planRoutes(site, client, version.build.routes)
        const worker = await this.readWorker(site, client)
        const domains = await this.providerDomains(site, client)
        const workersDevUrl = await this.workersDevUrl(site, client)

        const accepted = await provider.mutate(() =>
          client.createDeployment(accountId, workerName, {
            versionId: versionResource.providerResourceId,
            message: `Cognia Sites version ${version.sequence}`,
          })
        )
        await markSiteDeploymentAccepted({
          deploymentId: deployment.id,
          providerDeploymentId: accepted.id,
          now: this.deps.now(),
        })
        await this.openDeployedEntries(site, client, provider, { routes, worker, domains })
        const productionUrl = domains[0] ? `https://${domains[0].hostname}` : workersDevUrl
        return this.activateDeployment(
          site,
          client,
          provider,
          deployment.id,
          accepted.id,
          productionUrl
        )
      },
    })
  }

  /**
   * Ask every entry of a restricted, live Site what an anonymous visitor gets.
   *
   * The deploy-time check can come back `unverified` (a domain still
   * propagating). Exposure found later is closed at once, as a journaled
   * takedown under the same production lock — leaving a restricted Site open
   * is never the safe default, so this runs under `deploy`, not `manage`.
   */
  async recheckEntries(siteId: string): Promise<SiteEntryVerification> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    if (!restrictedPolicy(site.visitorPolicy)) {
      throw new Error("only a restricted Site is checked for anonymous access")
    }
    const active = pickActiveDeployment(await listSiteDeployments(site.id))
    if (!active) throw new Error("this Site has no live deployment to check")
    const verification = await this.verifyEntries(site, client)
    if (verification.state !== "exposed") {
      await setSiteDeploymentEntryVerification(active.id, verification, undefined, this.deps.now())
      return verification
    }
    const epoch = await this.epoch(site.id, "takedown")
    await this.runOperation({
      site,
      type: "takedown",
      idempotencyKey: `takedown:${site.id}:${epoch}`,
      payload: { siteId: site.id, reason: "exposed" },
      replay: async () => undefined,
      action: async (provider) => {
        await this.closeExposedEntries(site, client, provider, active.id, verification)
      },
    })
    return verification
  }

  /** Why visitor access is not in force for the Site right now, if it is not. */
  async visitorAccessGap(siteId: string): Promise<string | undefined> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "deploy")
    return this.accessNotInForce(site, client, site.visitorPolicy)
  }

  async reconcileVisitorAccess(siteId: string, policy: SiteVisitorPolicy): Promise<SiteProjectRow> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const desired = compileCloudflareAccessPolicy(policy)
    const accountId = site.providerConfig.accountId
    const epoch = await this.epoch(site.id, "access")
    return this.runOperation({
      site,
      type: "access",
      idempotencyKey: `access:${site.id}:${epoch}:${await sha256Hex(canonicalStringify(policy))}`,
      payload: { policy },
      replay: async () => {
        const current = await getSiteProject(site.id)
        if (!current) throw new Error("site project not found")
        return current
      },
      action: async (provider) => {
        const resources = await listSiteResources(site.id)
        const application = resources.find(
          (row) => row.kind === "access-application" && row.status === "active"
        )
        if (!desired.applicationRequired) {
          if (application && application.ownership === "managed") {
            await provider.mutate(() =>
              deleteIfPresent(() =>
                client.deleteAccessApplication(accountId, application.providerResourceId)
              )
            )
            for (const policyResource of resources.filter(
              (row) => row.kind === "access-policy" && row.status === "active"
            )) {
              await setSiteResourceStatus(policyResource.id, "deleted", this.deps.now())
            }
            await setSiteResourceStatus(application.id, "deleted", this.deps.now())
          }
          return updateSiteVisitorPolicy(site.id, policy, this.deps.now())
        }
        const workerId = await this.workerId(site, client)
        if (!workerId) {
          throw new Error("Upload a version first: Cloudflare Access protects an existing Worker")
        }
        const body = accessApplicationBody(site, workerId)
        let appId: string
        if (application) {
          appId = application.providerResourceId
          await provider.mutate(() => client.updateAccessApplication(accountId, appId, body))
        } else {
          appId = objectId(
            await provider.mutate(() => client.createAccessApplication(accountId, body)),
            "Cloudflare Access application"
          )
        }
        const appResource = await this.recordAccessApplication(site, appId, workerId, application)
        const actual = (await client.listAccessPolicies(accountId, appId)).map(accessPolicy)
        const wanted = desired.policies
        for (let index = 0; index < Math.max(actual.length, wanted.length); index += 1) {
          const current = actual[index]
          const next = wanted[index]
          if (current && next) {
            await provider.mutate(() =>
              client.updateAccessPolicy(accountId, appId, current.id ?? "", { ...next })
            )
          } else if (next) {
            await provider.mutate(() => client.createAccessPolicy(accountId, appId, { ...next }))
          } else if (current?.id) {
            const policyId = current.id
            await provider.mutate(() => client.deleteAccessPolicy(accountId, appId, policyId))
          }
        }
        const remote = await client.getAccessApplication(accountId, appId)
        const verified = (await client.listAccessPolicies(accountId, appId)).map(accessPolicy)
        if (!coversWorker(remote, workerId) || !cloudflareAccessPolicyMatches(desired, verified)) {
          throw new Error("Cloudflare Access has not converged")
        }
        await this.recordAccessPolicies(site, appResource.id, verified)
        return updateSiteVisitorPolicy(site.id, policy, this.deps.now())
      },
    })
  }

  private async recordAccessApplication(
    site: SiteProjectRow,
    appId: string,
    workerId: string,
    existing?: SiteResourceRow
  ): Promise<SiteResourceRow> {
    return recordSiteResource({
      id: existing?.id ?? resourceId(site.id, "access-application", appId),
      siteId: site.id,
      provider: "cloudflare",
      kind: "access-application",
      providerResourceId: appId,
      displayName: site.providerConfig.workerName,
      metadata: { workerId },
      ownership: existing?.ownership ?? "managed",
      dependencies: [],
      now: this.deps.now(),
    })
  }

  private async recordAccessPolicies(
    site: SiteProjectRow,
    appResourceId: string,
    verified: Array<CloudflareAccessPolicySpec & { id?: string }>
  ): Promise<void> {
    const verifiedIds = new Set<string>()
    for (const policy of verified) {
      if (!policy.id) throw new Error("Cloudflare Access policy has no provider id")
      verifiedIds.add(policy.id)
      await recordSiteResource({
        id: resourceId(site.id, "access-policy", policy.id),
        siteId: site.id,
        provider: "cloudflare",
        kind: "access-policy",
        providerResourceId: policy.id,
        displayName: policy.name,
        ownership: "managed",
        dependencies: [appResourceId],
        status: "active",
        now: this.deps.now(),
      })
    }
    for (const policyResource of (await listSiteResources(site.id)).filter(
      (row) => row.kind === "access-policy" && row.status === "active"
    )) {
      if (!verifiedIds.has(policyResource.providerResourceId)) {
        await setSiteResourceStatus(policyResource.id, "deleted", this.deps.now())
      }
    }
  }

  async addDomain(siteId: string, hostname: string, zoneId?: string): Promise<SiteResourceRow> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const zone = zoneId ?? site.providerConfig.zoneId
    if (!zone) throw new Error("Cloudflare zone id is required for a custom domain")
    const normalized = hostname.trim().toLowerCase()
    if (!normalized || normalized.includes(":") || normalized.includes("/"))
      throw new Error("custom domain hostname is invalid")
    const domainHistory = (await listSiteResources(site.id)).filter(
      (row) => row.kind === "custom-domain" && row.displayName === normalized
    )
    const activeDomain = domainHistory.find((row) => row.status === "active")
    if (activeDomain) return activeDomain
    return this.runOperation({
      site,
      type: "domain",
      idempotencyKey: `domain:add:${site.id}:${normalized}:${domainHistory.length}`,
      payload: { hostname: normalized, zoneId: zone },
      replay: async () => {
        const existing = (await listSiteResources(site.id)).find(
          (row) =>
            row.kind === "custom-domain" &&
            row.displayName === normalized &&
            row.status === "active"
        )
        if (!existing) throw new Error("completed Site domain operation has no resource record")
        return existing
      },
      action: async (provider) => {
        const domain = await provider.mutate(() =>
          client.attachDomain(site.providerConfig.accountId, {
            zoneId: zone,
            hostname: normalized,
            workerName: site.providerConfig.workerName,
          })
        )
        return recordSiteResource({
          id: resourceId(site.id, "custom-domain", domain.id),
          siteId: site.id,
          provider: "cloudflare",
          kind: "custom-domain",
          providerResourceId: domain.id,
          displayName: normalized,
          metadata: { zoneId: zone },
          ownership: "managed",
          dependencies: [workerResourceId(site)],
          now: this.deps.now(),
        })
      },
    })
  }

  async removeDomain(siteId: string, resourceRowId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const resource = await getSiteResource(resourceRowId)
    if (!resource || resource.siteId !== site.id || resource.kind !== "custom-domain") {
      throw new Error("Site custom domain not found")
    }
    await this.runOperation({
      site,
      type: "domain",
      idempotencyKey: `domain:remove:${site.id}:${resource.id}`,
      payload: { resourceId: resource.id },
      replay: async () => undefined,
      action: async (provider) => {
        await provider.mutate(() =>
          deleteIfPresent(() =>
            client.detachDomain(site.providerConfig.accountId, resource.providerResourceId)
          )
        )
        await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
      },
    })
  }

  /**
   * Worker (and, with a zone and a hostname, zone) analytics for a window.
   *
   * Parsed at this boundary rather than returned as `unknown`: the console had
   * no way to render a number it could not name, so it rendered the payload.
   */
  async analytics(siteId: string, from: string, to: string): Promise<SiteAnalyticsView> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "view")
    const domains = (await listSiteResources(site.id)).filter(
      (row) => row.kind === "custom-domain" && row.status === "active" && row.displayName
    )
    const deployments = await listSiteDeployments(site.id)
    const hostname =
      domains[0]?.displayName ??
      (() => {
        try {
          return deployments[0]?.productionUrl
            ? new URL(deployments[0].productionUrl).hostname
            : undefined
        } catch {
          return undefined
        }
      })()
    return parseSiteWorkerAnalytics(
      await client.queryWorkerAnalytics(site.providerConfig.accountId, {
        workerName: site.providerConfig.workerName,
        from,
        to,
        zoneId: site.providerConfig.zoneId,
        hostname,
      })
    )
  }

  async logs(siteId: string, from: number, to: number, errorsOnly = false): Promise<SiteLogsView> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "view")
    return parseSiteWorkerLogs(
      await client.queryWorkerLogs(site.providerConfig.accountId, {
        workerName: site.providerConfig.workerName,
        from,
        to,
        errorsOnly,
      })
    )
  }

  async takeDown(siteId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (site.lifecycle === "taken-down") return
    const epoch = await this.epoch(site.id, "takedown")
    await this.runOperation({
      site,
      type: "takedown",
      idempotencyKey: `takedown:${site.id}:${epoch}`,
      payload: { siteId: site.id },
      replay: async () => undefined,
      action: async (provider) => {
        await this.closeEntries(site, client, provider)
        await markSiteDeploymentsTakenDown(site.id, this.deps.now())
        await setSiteLifecycle(site.id, "taken-down", this.deps.now())
      },
    })
  }

  /**
   * Put a taken-down Site back as it was.
   *
   * Entries reopen as they were before the takedown, the deployment that was
   * serving is marked live again, and a restricted Site gets the same
   * fail-closed treatment as a publish: protection confirmed first, every
   * entry checked after.
   */
  async restore(siteId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (site.lifecycle !== "taken-down") throw new Error("only a taken-down Site can be restored")
    const epoch = await this.epoch(site.id, "restore")
    await this.runOperation({
      site,
      type: "restore",
      idempotencyKey: `restore:${site.id}:${epoch}`,
      payload: { siteId: site.id },
      replay: async () => undefined,
      action: (provider) => this.restoreEntriesAndTraffic(site, client, provider),
    })
  }

  private async restoreEntriesAndTraffic(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites
  ): Promise<void> {
    const accessGap = await this.accessNotInForce(site, client, site.visitorPolicy)
    if (accessGap) {
      throw new Error(
        `Cannot restore a restricted Site: ${accessGap}. Apply its visitor policy first.`
      )
    }
    await this.reopenEntries(site, client, provider)
    await setSiteLifecycle(site.id, "active", this.deps.now())
    const current = (
      await client.listDeployments(site.providerConfig.accountId, site.providerConfig.workerName)
    )[0]
    const restored = current
      ? await restoreSiteDeployment({
          siteId: site.id,
          providerDeploymentId: current.id,
          now: this.deps.now(),
        })
      : undefined
    if (!restored || !restrictedPolicy(site.visitorPolicy)) return
    const verification = await this.verifyEntries(site, client)
    await setSiteDeploymentEntryVerification(restored.id, verification, undefined, this.deps.now())
    if (verification.state === "exposed") {
      throw new SiteOperationSettled(
        await this.closeExposedEntries(site, client, provider, restored.id, verification)
      )
    }
  }

  /**
   * Abandon an operation whose outcome will not be confirmed.
   *
   * The journal's "abandon" button called the DB writer directly — no role
   * check, so anyone who could see the Site could do it — and cleared a LIVE
   * lease. It is the owner's call now, refused while the holder is still
   * running, and the local state the operation was driving is settled with
   * it: a pending deployment is marked failed, an interrupted purge returns
   * the Site to `taken-down`.
   */
  async abandonOperation(siteId: string, operationId: string): Promise<SiteOperationRow> {
    const site = await getSiteProject(siteId)
    if (!site || site.lifecycle === "deleted") throw new Error("Site project not found")
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    const operation = await getSiteOperation(operationId)
    if (!operation || operation.siteId !== site.id) throw new Error("Site operation not found")
    const cancelled = await cancelSiteOperation({
      operationId,
      message: "Abandoned by the Site owner; the provider outcome was not confirmed",
      now: this.deps.now(),
    })
    const payload =
      cancelled.inputPayload && typeof cancelled.inputPayload === "object"
        ? (cancelled.inputPayload as Record<string, unknown>)
        : {}
    if (cancelled.type === "deploy" && typeof payload.deploymentId === "string") {
      const deployment = await getSiteDeployment(payload.deploymentId)
      if (deployment && (deployment.status === "pending" || deployment.status === "deploying")) {
        await failSiteDeployment(
          deployment.id,
          "Abandoned before Cognia confirmed whether Cloudflare applied it",
          this.deps.now()
        )
      }
    }
    if (cancelled.type === "purge" && site.lifecycle === "deleting") {
      await setSiteLifecycle(site.id, "taken-down", this.deps.now())
    }
    return cancelled
  }

  /**
   * Delete one managed resource. A 404 means an earlier attempt already did,
   * so repeating a purge after a lost response finishes instead of sticking
   * in `deleting`.
   */
  private async deleteManagedResource(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites,
    resource: SiteResourceRow
  ): Promise<void> {
    const accountId = site.providerConfig.accountId
    const remove = (call: () => Promise<unknown>) => provider.mutate(() => deleteIfPresent(call))
    switch (resource.kind) {
      case "custom-domain":
        await remove(() => client.detachDomain(accountId, resource.providerResourceId))
        break
      case "worker-route": {
        const zoneId = resource.metadata?.zoneId
        if (zoneId)
          await remove(() => client.deleteWorkerRoute(zoneId, resource.providerResourceId))
        break
      }
      case "access-policy": {
        const appId = resource.dependencies[0]
          ? (await getSiteResource(resource.dependencies[0]))?.providerResourceId
          : undefined
        if (appId) {
          await remove(() =>
            client.deleteAccessPolicy(accountId, appId, resource.providerResourceId)
          )
        }
        break
      }
      case "access-application":
        await remove(() => client.deleteAccessApplication(accountId, resource.providerResourceId))
        break
      case "worker":
        await remove(() => client.deleteWorker(accountId, site.providerConfig.workerName))
        break
      case "d1-database":
        await remove(() => client.deleteD1Database(accountId, resource.providerResourceId))
        break
      case "r2-bucket":
        await remove(() => client.deleteR2Bucket(accountId, resource.providerResourceId))
        break
      case "secret":
      case "worker-version":
        // Contained in the Worker; see `purgeManagedResources`.
        break
    }
  }

  /**
   * Delete what this Site owns, dependents first.
   *
   * Secrets and saved versions live inside the Worker and go with it, so they
   * are not deleted one by one. Deleting versions individually used a path the
   * Scripts API does not have, and the version currently deployed cannot be
   * deleted at all — either refusal blocked the Worker behind it.
   */
  private async purgeManagedResources(
    site: SiteProjectRow,
    client: CloudflareClient,
    provider: ProviderWrites
  ): Promise<void> {
    for (const resource of (await listSiteResources(site.id)).filter(
      (row) => row.ownership !== "managed" && row.status !== "deleted"
    )) {
      // The provider object remains intact. `orphaned` preserves that fact in
      // the purge report until the user separately deletes Cognia metadata.
      await setSiteResourceStatus(resource.id, "orphaned", this.deps.now())
    }

    const live = async () =>
      (await listSiteResources(site.id)).filter(
        (row) =>
          row.ownership === "managed" &&
          row.status !== "deleted" &&
          !CONTAINED_IN_WORKER.has(row.kind)
      )
    let remaining = await live()
    while (remaining.length > 0) {
      const purgeable = remaining.filter(
        (resource) => !remaining.some((other) => other.dependencies.includes(resource.id))
      )
      if (purgeable.length === 0) {
        throw new Error("Site resource dependency graph cannot be purged")
      }
      for (const resource of purgeable) {
        await setSiteResourceStatus(resource.id, "deleting", this.deps.now())
        await this.deleteManagedResource(site, client, provider, resource)
        await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
      }
      remaining = await live()
    }

    const worker = await getSiteResource(workerResourceId(site))
    const workerGone = worker?.ownership === "managed" && worker.status === "deleted"
    for (const resource of (await listSiteResources(site.id)).filter(
      (row) => CONTAINED_IN_WORKER.has(row.kind) && row.status !== "deleted"
    )) {
      await setSiteResourceStatus(
        resource.id,
        workerGone || !worker ? "deleted" : "orphaned",
        this.deps.now()
      )
    }
  }

  async purge(siteId: string): Promise<void> {
    const { site, client } = await this.client(siteId)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    if (site.lifecycle !== "taken-down") throw new Error("Site must be taken down before purge")
    const attempt = (await listSiteOperations(site.id)).filter(
      (operation) => operation.type === "purge"
    ).length
    await this.runOperation({
      site,
      type: "purge",
      idempotencyKey: `purge:${site.id}:${attempt}`,
      payload: { siteId: site.id, attempt },
      onDefiniteFailure: async () => {
        // A definite failure rolls deletion back to a retryable state.
        if ((await getSiteProject(site.id))?.lifecycle === "deleting") {
          await setSiteLifecycle(site.id, "taken-down", this.deps.now())
        }
      },
      action: async (provider) => {
        // Inside the operation, not before it: setting `deleting` first left
        // a Site wedged there when the host stopped before the operation was
        // even recorded.
        await setSiteLifecycle(site.id, "deleting", this.deps.now())
        await this.purgeManagedResources(site, client, provider)
        await setSiteLifecycle(site.id, "deleted", this.deps.now())
      },
    })
  }

  /**
   * Resolve every operation waiting on an uncertain provider outcome.
   *
   * Wrapped in an operation of its own. `SiteOperationType` has always carried
   * `"reconcile"` and nothing ever queued one, so reconciliation did real
   * provider round-trips that left no durable trace: a crash mid-reconcile was
   * invisible, and the result was only visible if you happened to be on the
   * operations tab. Now it appears in the journal, feeds recovery, and
   * notifies like everything else.
   *
   * The idempotency key carries a nonce on purpose. `queueSiteOperation`
   * returns the existing row for a repeated key and `runOperation` then throws
   * "already succeeded" — a fixed key would make reconciliation a thing you can
   * do exactly once per Site, forever.
   */
  async reconcile(siteId: string): Promise<{ resolved: number; remaining: number }> {
    const { site } = await this.client(siteId, true)
    assertSiteAuthoringCapability(site.authoringPolicy, this.deps.actorAccountId, "manage")
    return this.runOperation({
      site,
      type: "reconcile",
      idempotencyKey: `reconcile:${site.id}:${this.deps.newId("run")}`,
      payload: { siteId: site.id },
      action: () => this.reconcileWaiting(siteId),
    })
  }

  private async reconcileWaiting(siteId: string): Promise<{ resolved: number; remaining: number }> {
    const { site, client } = await this.client(siteId, true)
    const waiting = (await listSiteOperations(site.id)).filter(
      (operation) => operation.status === "waiting-reconcile"
    )
    let resolved = 0
    for (const operation of waiting) {
      const payload =
        operation.inputPayload && typeof operation.inputPayload === "object"
          ? (operation.inputPayload as Record<string, unknown>)
          : {}
      try {
        const current = (await getSiteProject(site.id)) ?? site
        await this.reconcileOne(current, client, operation, payload)
        await resolveSiteOperationFromReconcile({
          operationId: operation.id,
          message: "Provider state reconciled by Cognia Sites",
          now: this.deps.now(),
        })
        resolved += 1
      } catch (error) {
        // Settled: the provider state is known and was acted on (an exposed
        // restricted Site was taken down), so the operation ends failed with
        // the reason rather than waiting for a pass that would report success.
        if (error instanceof SiteOperationSettled) {
          await resolveSiteOperationFromReconcile({
            operationId: operation.id,
            message: error.message,
            outcome: "failed",
            now: this.deps.now(),
          })
          resolved += 1
        }
        // Anything else leaves the operation waiting. The caller receives the
        // remaining count and can retry after provider state converges.
      }
    }
    return { resolved, remaining: waiting.length - resolved }
  }

  private async reconcileOne(
    site: SiteProjectRow,
    client: CloudflareClient,
    operation: SiteOperationRow,
    payload: Record<string, unknown>
  ): Promise<void> {
    switch (operation.type) {
      case "provision":
        return this.reconcileProvision(site, client, payload)
      case "upload":
        return this.reconcileUpload(site, client, payload)
      case "deploy":
        return this.reconcileDeploy(site, client, payload)
      case "domain":
        return this.reconcileDomain(site, client, payload)
      case "access":
        return this.reconcileAccess(site, client, payload)
      case "takedown":
        await this.closeEntries(site, client, UNTRACKED)
        await markSiteDeploymentsTakenDown(site.id, this.deps.now())
        if ((await getSiteProject(site.id))?.lifecycle === "active") {
          await setSiteLifecycle(site.id, "taken-down", this.deps.now())
        }
        return
      case "restore":
        if ((await getSiteProject(site.id))?.lifecycle === "active") return
        return this.restoreEntriesAndTraffic(site, client, UNTRACKED)
      case "purge":
        if ((await getSiteProject(site.id))?.lifecycle === "taken-down") {
          await setSiteLifecycle(site.id, "deleting", this.deps.now())
        }
        await this.purgeManagedResources(site, client, UNTRACKED)
        if ((await getSiteProject(site.id))?.lifecycle === "deleting") {
          await setSiteLifecycle(site.id, "deleted", this.deps.now())
        }
        return
      default:
        throw new Error(`Site operation type cannot be reconciled: ${operation.type}`)
    }
  }

  private async reconcileProvision(
    site: SiteProjectRow,
    client: CloudflareClient,
    payload: Record<string, unknown>
  ): Promise<void> {
    const kind = payload.kind
    const name = typeof payload.resourceName === "string" ? payload.resourceName : ""
    const bindingName = typeof payload.name === "string" ? payload.name : ""
    const ownership = payload.ownership
    if (
      (kind !== "d1" && kind !== "r2") ||
      !name ||
      !bindingName ||
      !["managed", "adopted", "shared"].includes(String(ownership))
    ) {
      throw new Error("Site provision reconciliation payload is invalid")
    }
    // Claiming by name is sound for a managed create only because the create
    // refused to run when the name was already taken.
    const providerId =
      kind === "d1"
        ? (await client.listD1Databases(site.providerConfig.accountId)).find(
            (row) => row.name === name && row.uuid
          )?.uuid
        : (await client.listR2Buckets(site.providerConfig.accountId)).find(
            (row) => row.name === name
          )?.name
    if (!providerId) throw new Error("Cloudflare binding has not converged")
    await recordSiteResource({
      id: resourceId(site.id, kind === "d1" ? "d1-database" : "r2-bucket", providerId),
      siteId: site.id,
      provider: "cloudflare",
      kind: kind === "d1" ? "d1-database" : "r2-bucket",
      providerResourceId: providerId,
      displayName: name,
      metadata: { bindingName },
      ownership: ownership as SiteResourceRow["ownership"],
      dependencies: [],
      now: this.deps.now(),
    })
  }

  private async reconcileUpload(
    site: SiteProjectRow,
    client: CloudflareClient,
    payload: Record<string, unknown>
  ): Promise<void> {
    const versionId = typeof payload.versionId === "string" ? payload.versionId : ""
    const version = await getSiteVersion(versionId)
    if (!version || version.siteId !== site.id || !version.artifactDigest) {
      throw new Error("Site upload reconciliation version is invalid")
    }
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    const removedSecrets = strings(payload.removedSecrets)
    const tag = typeof payload.tag === "string" ? payload.tag : `cognia-${version.id}`
    const providerId = await this.uploadedVersionId(site, client, tag, removedSecrets.length > 0)
    if (!providerId) throw new Error("Cloudflare version has not converged")
    await this.recordUpload(site, version, providerId, {
      bindingIds: strings(payload.bindingIds),
      secretKeys: strings(payload.secretKeys),
      removedSecrets,
    })
  }

  /**
   * Settle a deployment whose outcome was not seen.
   *
   * Cloudflare documents the FIRST deployment in the list as the one serving
   * traffic. Matching any deployment that ever contained the version marked a
   * historical deployment — or a 10 % split — as live.
   */
  private async reconcileDeploy(
    site: SiteProjectRow,
    client: CloudflareClient,
    payload: Record<string, unknown>
  ): Promise<void> {
    const deploymentId = typeof payload.deploymentId === "string" ? payload.deploymentId : ""
    const providerVersionId =
      typeof payload.providerVersionId === "string" ? payload.providerVersionId : ""
    const local = await getSiteDeployment(deploymentId)
    if (!local) throw new Error("Site deployment reconciliation payload is invalid")
    if (local.status !== "pending" && local.status !== "deploying") return
    const deployments = await client.listDeployments(
      site.providerConfig.accountId,
      site.providerConfig.workerName
    )
    const current = deployments[0]
    const servesVersion =
      !!current &&
      current.versions.length === 1 &&
      current.versions[0].version_id === providerVersionId &&
      current.versions[0].percentage === 100
    const isOurs = local.providerDeploymentId
      ? current?.id === local.providerDeploymentId
      : servesVersion
    if (current && isOurs) {
      const version = await getSiteVersion(local.versionId)
      if (!version) throw new Error("Site deployment reconciliation version is missing")
      const domains = await this.providerDomains(site, client)
      await this.openDeployedEntries(site, client, UNTRACKED, {
        routes: await this.planRoutes(site, client, version.build.routes),
        worker: await this.readWorker(site, client),
        domains,
      })
      const productionUrl = domains[0]
        ? `https://${domains[0].hostname}`
        : await this.workersDevUrl(site, client)
      await this.activateDeployment(site, client, UNTRACKED, local.id, current.id, productionUrl)
      return
    }
    if (
      local.providerDeploymentId &&
      deployments.some((deployment) => deployment.id === local.providerDeploymentId)
    ) {
      await failSiteDeployment(
        local.id,
        "A later deployment replaced this one before Cognia confirmed it",
        this.deps.now()
      )
      return
    }
    throw new Error("Cloudflare deployment has not converged")
  }

  private async reconcileDomain(
    site: SiteProjectRow,
    client: CloudflareClient,
    payload: Record<string, unknown>
  ): Promise<void> {
    const providerDomains = await client.listDomains(site.providerConfig.accountId)
    if (typeof payload.hostname === "string") {
      const match = providerDomains.find(
        (candidate) =>
          !!candidate &&
          typeof candidate === "object" &&
          (candidate as { hostname?: string }).hostname === payload.hostname
      ) as { id?: string } | undefined
      if (!match?.id) throw new Error("Cloudflare custom domain has not converged")
      await recordSiteResource({
        id: resourceId(site.id, "custom-domain", match.id),
        siteId: site.id,
        provider: "cloudflare",
        kind: "custom-domain",
        providerResourceId: match.id,
        displayName: payload.hostname,
        metadata: { zoneId: String(payload.zoneId ?? site.providerConfig.zoneId ?? "") },
        ownership: "managed",
        dependencies: [workerResourceId(site)],
        now: this.deps.now(),
      })
    } else if (typeof payload.resourceId === "string") {
      const resource = await getSiteResource(payload.resourceId)
      if (!resource) throw new Error("Site domain resource not found")
      const stillPresent = providerDomains.some(
        (candidate) =>
          !!candidate &&
          typeof candidate === "object" &&
          (candidate as { id?: string }).id === resource.providerResourceId
      )
      if (stillPresent) throw new Error("Cloudflare custom domain removal has not converged")
      await setSiteResourceStatus(resource.id, "deleted", this.deps.now())
    }
  }

  private async reconcileAccess(
    site: SiteProjectRow,
    client: CloudflareClient,
    payload: Record<string, unknown>
  ): Promise<void> {
    const policy = payload.policy as SiteVisitorPolicy | undefined
    if (!policy) throw new Error("Site access reconciliation payload is invalid")
    const accountId = site.providerConfig.accountId
    const application = (await listSiteResources(site.id)).find(
      (row) => row.kind === "access-application" && row.status === "active"
    )
    if (!restrictedPolicy(policy)) {
      if (application) {
        try {
          await client.getAccessApplication(accountId, application.providerResourceId)
          throw new Error("Cloudflare Access removal has not converged")
        } catch (error) {
          if (!providerNotFound(error)) throw error
        }
        await setSiteResourceStatus(application.id, "deleted", this.deps.now())
      }
      await updateSiteVisitorPolicy(site.id, policy, this.deps.now())
      return
    }
    const workerId = await this.workerId(site, client)
    if (!workerId) throw new Error("Cloudflare Worker has not converged")
    let appResource = application
    if (!appResource) {
      // The create's response was lost: find the application by what it protects.
      const created = (await client.listAccessApplications(accountId)).find(
        (candidate) =>
          coversWorker(candidate, workerId) &&
          (candidate as { name?: unknown }).name === accessApplicationName(site)
      )
      if (!created) throw new Error("Cloudflare Access application has not converged")
      appResource = await this.recordAccessApplication(
        site,
        objectId(created, "Cloudflare Access application"),
        workerId
      )
    }
    const gap = await this.accessNotInForce(site, client, policy)
    if (gap) throw new Error(`Cloudflare Access has not converged: ${gap}`)
    await this.recordAccessPolicies(
      site,
      appResource.id,
      (await client.listAccessPolicies(accountId, appResource.providerResourceId)).map(accessPolicy)
    )
    await updateSiteVisitorPolicy(site.id, policy, this.deps.now())
  }
}

function mintedCredentialPrefix(siteId: string, revisionId: string): string {
  return `environment:${siteId}:${revisionId}:`
}
