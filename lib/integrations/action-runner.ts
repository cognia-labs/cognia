import type {
  ExecuteIntegrationActionInput,
  IntegrationActionHandler,
  IntegrationActionHandlerContext,
  IntegrationActionJob,
} from "@/types/plugin/plugin-integration"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { liveQuery } from "dexie"
import { loggers } from "@cognia/logging"
import {
  appendIntegrationAudit,
  cancelIntegrationActionJobRecord,
  claimIntegrationActionJob,
  enqueueIntegrationActionJob,
  findIntegrationActionJobByIdempotencyKey,
  getIntegrationAccount,
  getIntegrationActionJob,
  listRunnableIntegrationActionJobs,
  updateIntegrationAccount,
  updateIntegrationActionJob,
} from "@/lib/db/integrations"
import { getProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import {
  getIntegrationActionHandler,
  getRegisteredIntegration,
  integrationToolName,
  subscribeIntegrationRegistry,
} from "@/lib/integrations/registry"
import { runGithubIssueLoop } from "@/lib/integrations/github-issue-loop"
import { isTauri } from "@/lib/tauri"
import {
  assertBotIntegrationAction,
  canonicalIntegrationValue,
} from "@/lib/plugin/api/bot-integration-binding"
import {
  githubActionTargets,
  githubRequestApiBaseUrl,
  githubRequestTargets,
  githubWebHost,
  isGithubWriteAction,
} from "@/lib/policy/action-review/github-targets"
import type { OutboundTarget } from "@/lib/policy/action-review/outbound-targets"
import {
  heldJobAnswerReceipt,
  OUTBOUND_FENCED_ERROR,
  OUTBOUND_HELD_REQUEST_ERROR,
  planIntegrationWrite,
  type IntegrationAuthorization,
  type IntegrationReceipt,
  type IntegrationWriteDecision,
} from "@/lib/policy/action-review/plan-integration"
import { pushHeldIntegrationJob, withdrawHeldIntegrationJob } from "./outbound-hold"
import { isIntegrationRuntimeOwner } from "./runtime-owner"

/**
 * Who asks for an integration write, as the host knows it (ADR-0239 phase 2).
 * Host-only: never part of the plugin-facing `ExecuteIntegrationActionInput`,
 * so a plugin cannot claim to be a chat tool call or a workflow step. A Bot
 * binding is resolved by the host itself; anything else is the plugin's own
 * code.
 */
export type IntegrationActionCaller =
  | { kind: "tool-call"; sessionId?: string }
  | { kind: "workflow"; workflowId: string; runId: string }
  /**
   * A person confirmed this exact write by hand (a writeback or publish
   * dialog). Its human receipt is the write's authority; the outbound policy
   * does not hold it.
   */
  | { kind: "person"; surface: string; sessionId?: string }

/** Who answers a held job: only a person releases it (ADR-0239 phase 2). */
export interface IntegrationJobAnswer {
  actor?: "person"
  /** A person allowed the recipients for the rest of the request. */
  forRequest?: boolean
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/** An error the outbound policy raised: retrying cannot change it. */
class OutboundPolicyError extends Error {
  readonly outboundPolicy = true
}

async function recordIntegrationReceipt(receipt: IntegrationReceipt | undefined): Promise<void> {
  if (!receipt) return
  try {
    const { projectActionReviewSettled } = await import("@/lib/policy/action-review/projection")
    await projectActionReviewSettled(receipt.request, receipt.decision)
  } catch {
    // Audit is best-effort, as at the delivery gateway.
  }
}

/** The GitHub repositories a job writes to, or `[]` for any other job. */
async function githubJobTargets(job: IntegrationActionJob): Promise<OutboundTarget[]> {
  const registered = getRegisteredIntegration(job.pluginId, job.integrationId)
  const action = registered?.definition.actions.find((candidate) => candidate.id === job.actionId)
  if (!registered || !action || !isGithubWriteAction({ definition: registered.definition, action }))
    return []
  const account = await getIntegrationAccount(job.pluginId, job.accountId)
  const host = account ? githubWebHost(await integrationApiBaseUrl(account)) : undefined
  return githubActionTargets(action, job.input, host ? { host } : {})
}

/**
 * Plan every raw request that is not a read, and act on the plan: record its
 * receipt, and throw when the policy holds or refuses it. A synchronous
 * request cannot wait for a person.
 */
async function planAuthenticatedRequest(
  pluginId: string,
  connectorAccountId: string,
  input: string,
  method: string,
  authorization: IntegrationAuthorization
): Promise<void> {
  if (READ_METHODS.has(method)) return
  const account = await getIntegrationAccount(pluginId, connectorAccountId)
  const registered = account ? getRegisteredIntegration(pluginId, account.integrationId) : undefined
  if (!account || !registered) throw new Error("Integration request account is unavailable")
  let apiBaseUrl = githubRequestApiBaseUrl(input, await integrationApiBaseUrl(account))
  if (!apiBaseUrl) {
    // A plugin can reach a known Enterprise host through a different provider
    // account. Classification follows the destination, not that provider.
    const { configuredGithubHosts } = await import("./github-auth")
    apiBaseUrl = (await configuredGithubHosts())
      .map((host) => githubRequestApiBaseUrl(input, host.apiBaseUrl))
      .find((base) => base !== undefined)
  }
  const url = new URL(input)
  const requestUrl = `${url.origin}${url.pathname}`
  const category = apiBaseUrl ? "github" : "integration"
  const decision = await planIntegrationWrite({
    category,
    targets: apiBaseUrl
      ? githubRequestTargets(input, apiBaseUrl)
      : [
          {
            kind: "unknown",
            channel: "integration",
            // No generic recipient contract exists yet. Bind the fingerprint to
            // this exact account and request, without query, fragment or body.
            recipient: JSON.stringify([
              pluginId,
              account.integrationId,
              account.id,
              method,
              requestUrl,
            ]),
          },
        ],
    operation: method,
    ...(apiBaseUrl ? { host: githubWebHost(apiBaseUrl) } : {}),
    ...(category === "integration"
      ? { request: { integrationId: account.integrationId, method, url: requestUrl } }
      : {}),
    authorization,
    account: { pluginId, accountId: account.id },
  })
  await recordIntegrationReceipt(decision.receipt)
  if (decision.action === "deny") throw new OutboundPolicyError(OUTBOUND_FENCED_ERROR)
  if (decision.action === "park") throw new OutboundPolicyError(OUTBOUND_HELD_REQUEST_ERROR)
}

type AuthenticatedRequestExecutor = <T>(
  pluginId: string,
  connectorAccountId: string,
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    beforeSend?: () => Promise<void>
  }
) => Promise<{ status: number; headers: Record<string, string>; data: T }>

const runningControllers = new Map<string, AbortController>()
const runningPerAccount = new Map<string, number>()
const MAX_ACCOUNT_CONCURRENCY = 4
const claimOwner = crypto.randomUUID()
let requestOverride: AuthenticatedRequestExecutor | undefined
let githubIssueLoopExecutor: IntegrationActionHandler = runGithubIssueLoop
let githubIssueLoopDesktopHostOverride: boolean | undefined

export interface IntegrationActionAvailability {
  available: boolean
  reason?: string
}

export function resolveIntegrationActionAvailability(
  pluginId: string,
  integrationId: string,
  actionId: string
): IntegrationActionAvailability {
  if (
    pluginId === "github-delivery" &&
    integrationId === "github" &&
    actionId === "runIssueLoop" &&
    !(githubIssueLoopDesktopHostOverride ?? isTauri())
  ) {
    return {
      available: false,
      reason: "GitHub Issue Loop requires a desktop host.",
    }
  }
  return { available: true }
}

function retryDelayMs(error: unknown, attempts: number): number {
  if (error && typeof error === "object") {
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      return Math.max(0, Math.min(24 * 60 * 60 * 1000, retryAfterMs))
    }
    const retryAfter = (error as { retryAfter?: unknown }).retryAfter
    if (typeof retryAfter === "string") {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
      const at = Date.parse(retryAfter)
      if (Number.isFinite(at)) return Math.max(0, at - Date.now())
    }
  }
  return Math.min(60_000, 1000 * 2 ** (attempts - 1))
}

function assertActionInput(schema: Record<string, unknown>, value: unknown): void {
  const validation = validateAgainstJsonSchema(schema, value)
  if (!validation.ok) {
    throw new Error(`Integration action input is invalid: ${validation.errors.join("; ")}`)
  }
}

function integrationErrorDetail(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {}
  const candidate = error as Record<string, unknown>
  return {
    requestId: candidate.requestId,
    status: candidate.status,
    statusClass: candidate.category,
    retryAfter: candidate.retryAfter,
    rateLimitReset: candidate.rateLimitReset,
  }
}

async function defaultAuthenticatedRequest<T>(
  pluginId: string,
  connectorAccountId: string,
  input: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    beforeSend?: () => Promise<void>
  } = {}
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  const account = await getIntegrationAccount(pluginId, connectorAccountId)
  if (!account || !account.enabled)
    throw new Error(`Integration account "${connectorAccountId}" is disabled`)
  const registered = getRegisteredIntegration(pluginId, account.integrationId)
  if (!registered) throw new Error(`Integration "${account.integrationId}" is not registered`)
  const url = new URL(input)
  // ADR-0176. The third source is the deployment this account's own credential
  // belongs to. A plugin manifest can only declare the vendor's public origin,
  // so without this a GitHub Enterprise account is blocked here before it ever
  // reaches its own server. It widens nothing: the origin comes from the host
  // the user configured on this account, and the credential being sent is the
  // one that server issued.
  const accountOrigin = await integrationApiBaseUrl(account)
    .then((base) => (base ? new URL(base).origin : undefined))
    .catch(() => undefined)
  const allowed = [
    ...(registered.definition.allowedOrigins ?? []),
    ...(account.approvedOrigins ?? []),
    ...(accountOrigin ? [accountOrigin] : []),
  ]
  if (!allowed.includes(url.origin)) {
    throw new Error(`Integration request origin "${url.origin}" is not allowlisted`)
  }
  const provider = getProvider(account.providerId)
  if (!provider) throw new Error(`Auth provider "${account.providerId}" is not registered`)
  const sessions = await provider.getSessions(undefined, { silent: true })
  const session = sessions.find((candidate) => candidate.id === account.authSessionId)
  if (!session) {
    await updateIntegrationAccount(pluginId, connectorAccountId, { health: "revoked" })
    throw new Error(`Credential handle for account "${connectorAccountId}" is unavailable`)
  }

  const strategy = registered.definition.authStrategies.find(
    (candidate) => candidate.providerId === account.providerId
  )
  if (!strategy) {
    throw new Error(`Auth strategy for provider "${account.providerId}" is not registered`)
  }
  const headers = new Headers(init.headers)
  const requestAuth = strategy.requestAuth ?? { type: "bearer" as const }
  const credential = provider.resolveRequestCredential
    ? await provider.resolveRequestCredential(session.id, {
        connectorAccountId,
        origin: url.origin,
      })
    : { accessToken: session.accessToken }
  if (requestAuth.type === "bearer") {
    headers.set("authorization", `Bearer ${credential.accessToken}`)
  } else {
    headers.set(requestAuth.name, `${requestAuth.prefix ?? ""}${credential.accessToken}`)
  }
  await init.beforeSend?.()
  if (init.signal?.aborted) throw new Error("Action cancelled or timed out")
  const response = await proxyFetch(url, {
    method: init.method,
    headers,
    body: init.body,
    signal: init.signal,
  })
  const responseHeaders = Object.fromEntries(response.headers.entries())
  await updateIntegrationAccount(pluginId, connectorAccountId, {
    health: response.status === 401 || response.status === 403 ? "degraded" : "healthy",
  })
  const contentType = response.headers.get("content-type") ?? ""
  const data = contentType.includes("application/json")
    ? ((await response.json()) as T)
    : ((await response.text()) as T)
  return { status: response.status, headers: responseHeaders, data }
}

async function authenticatedRequest<T>(
  pluginId: string,
  connectorAccountId: string,
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    beforeSend?: () => Promise<void>
  }
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  if (
    !hasNoLeakingPiiDeep({
      url: input,
      headers: init?.headers,
      body: init?.body,
    })
  ) {
    throw new Error(
      "Integration authenticated request blocked by the PII gate; redact identifiers and retry."
    )
  }
  if (requestOverride) {
    await init?.beforeSend?.()
    if (init?.signal?.aborted) throw new Error("Action cancelled or timed out")
    return requestOverride<T>(pluginId, connectorAccountId, input, init)
  }
  return defaultAuthenticatedRequest<T>(pluginId, connectorAccountId, input, init)
}

/**
 * Host-owned authenticated fetch boundary used by `ctx.integrations`.
 *
 * Every non-read request is planned first (ADR-0239). GitHub API/web hosts use
 * GitHub policy; other services use the integration category. A write the
 * policy holds or refuses fails before the authenticated transport runs.
 */
export async function authenticatedIntegrationRequest<T>(
  pluginId: string,
  connectorAccountId: string,
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  await planAuthenticatedRequest(
    pluginId,
    connectorAccountId,
    input,
    (init?.method ?? "GET").toUpperCase(),
    { kind: "plugin", pluginId }
  )
  return authenticatedRequest<T>(pluginId, connectorAccountId, input, init)
}

async function assertApprovedPublicationHead(
  binding: Awaited<ReturnType<typeof assertBotIntegrationAction>>,
  requestInit?: { signal: AbortSignal; beforeSend: () => Promise<void> }
): Promise<void> {
  if (!binding.approvedPublication) return
  if (!binding.repository) throw new Error("Approved publication has no repository scope")
  const baseUrl = (await integrationApiBaseUrl(binding.account)) ?? "https://api.github.com"
  const current = await authenticatedRequest<{ sha?: string }>(
    binding.account.pluginId,
    binding.account.id,
    `${baseUrl}/repos/${binding.repository}/commits/${encodeURIComponent(binding.approvedPublication.branch)}`,
    requestInit
  )
  if (current.status !== 200 || current.data.sha !== binding.approvedPublication.headSha) {
    throw new Error("Approved pull request head SHA changed")
  }
}

/** Who approved a Bot's action: its installation's policy, or a person. */
async function botApprovalDecidedBy(interruptId: string | undefined): Promise<"person" | "policy"> {
  if (!interruptId) return "policy"
  const { getDb } = await import("@/lib/db/schema")
  const approval = await getDb().executionRunInterrupts.get(interruptId)
  return approval?.approvalDecisionMode === "policy" || !approval ? "policy" : "person"
}

/**
 * Execute an integration action through the broker.
 *
 * A GitHub write is planned by the outbound policy before it is queued
 * (ADR-0239 phase 2, `plan-integration.ts`), for `caller`, else as the Bot
 * its binding names, else as the plugin's own code. A write the policy holds
 * is queued `awaiting_approval` with `outbound.held` set, whatever it would
 * otherwise have been (a capability grant's automatic approval, a Bot's
 * approved action), and pushed to a person; only a person's answer releases
 * it. A write a person refused for the current request fails
 * `outbound_fenced`.
 */
export async function executeIntegrationAction(
  pluginId: string,
  input: ExecuteIntegrationActionInput,
  caller?: IntegrationActionCaller
): Promise<IntegrationActionJob> {
  const callerPluginId = pluginId
  let botBinding: IntegrationActionJob["botBinding"]
  let botAuthorization: Extract<IntegrationAuthorization, { kind: "bot" }> | undefined
  if (input.binding) {
    const binding = await assertBotIntegrationAction(
      pluginId,
      input.binding,
      input,
      input.approval?.interruptId
    )
    await assertApprovedPublicationHead(binding)
    if (input.accountId && input.accountId !== binding.account.id)
      throw new Error("Bot action account does not match its binding")
    pluginId = binding.account.pluginId
    input = {
      ...input,
      accountId: binding.account.id,
      idempotencyKey: input.idempotencyKey
        ? `${callerPluginId}:${input.binding.runId}:${input.idempotencyKey}`
        : undefined,
    }
    botBinding = {
      ...input.binding!,
      pluginId: callerPluginId,
      approvalId: input.approval?.interruptId,
    }
    botAuthorization = {
      kind: "bot",
      installation: binding.installation,
      runId: input.binding!.runId,
      decidedBy: await botApprovalDecidedBy(input.approval?.interruptId),
      ...(binding.repository ? { scopeRepository: binding.repository } : {}),
    }
  }
  const registered = getRegisteredIntegration(pluginId, input.integrationId)
  if (!registered) throw new Error(`Integration "${input.integrationId}" is not registered`)
  const action = registered.definition.actions.find((candidate) => candidate.id === input.actionId)
  if (!action) throw new Error(`Integration action "${input.actionId}" is not registered`)
  const account = await getIntegrationAccount(pluginId, input.accountId)
  if (!account || account.integrationId !== input.integrationId) {
    throw new Error(`Integration account "${input.accountId}" does not belong to this integration`)
  }
  if (!account.enabled) throw new Error(`Integration account "${input.accountId}" is disabled`)
  if (action.idempotency === "required" && !input.idempotencyKey) {
    throw new Error(`Integration action "${input.actionId}" requires an idempotency key`)
  }
  assertActionInput(action.inputSchema, input.input)

  // A replay of an existing job keeps that job's plan.
  const existing = input.idempotencyKey
    ? await findIntegrationActionJobByIdempotencyKey(input.accountId, input.idempotencyKey)
    : undefined
  let planned: IntegrationWriteDecision | undefined
  let targets: OutboundTarget[] = []
  if (!existing && isGithubWriteAction({ definition: registered.definition, action })) {
    const host = githubWebHost(await integrationApiBaseUrl(account))
    targets = githubActionTargets(action, input.input, { host })
    const authorization: IntegrationAuthorization =
      botAuthorization ??
      (caller?.kind === "tool-call"
        ? {
            kind: "tool-call",
            pluginId,
            ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
          }
        : caller?.kind === "workflow"
          ? caller.workflowId && caller.runId
            ? { kind: "workflow", workflowId: caller.workflowId, runId: caller.runId }
            : { kind: "plugin", pluginId }
          : caller?.kind === "person"
            ? {
                kind: "person",
                surface: caller.surface,
                ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
              }
            : { kind: "plugin", pluginId: callerPluginId })
    planned = await planIntegrationWrite({
      targets,
      operation: `${input.integrationId}.${input.actionId}`,
      host,
      authorization,
      account: { pluginId, accountId: input.accountId },
      action: {
        actionId: action.id,
        ...(action.operationId ? { operationId: action.operationId } : {}),
        risk: action.risk,
      },
    })
    await recordIntegrationReceipt(planned.receipt)
  }
  const unplannedStatus = action.risk === "read" || botBinding ? "queued" : "awaiting_approval"

  const job = await enqueueIntegrationActionJob({
    pluginId,
    integrationId: input.integrationId,
    accountId: input.accountId,
    actionId: input.actionId,
    input: input.input,
    status:
      planned?.action === "park"
        ? "awaiting_approval"
        : planned?.action === "deny"
          ? "failed"
          : unplannedStatus,
    ...(planned?.action === "deny" ? { error: OUTBOUND_FENCED_ERROR } : {}),
    ...(botBinding ? { botBinding } : {}),
    ...(planned
      ? {
          outbound: {
            ...planned.outbound,
            ...(planned.action === "park"
              ? {
                  held: {
                    receiptId: planned.receipt.request.requestId,
                    heldAt: new Date().toISOString(),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(planned?.action === "proceed" && planned.authorizedBy
      ? { authorizedBy: planned.authorizedBy }
      : {}),
    risk: action.risk,
    idempotencyKey: input.idempotencyKey,
    attempts: 0,
    maxAttempts: action.idempotency === "none" ? 1 : 5,
    source: input.source ?? "manual",
  })
  if (
    botBinding &&
    (canonicalIntegrationValue(job.botBinding) !== canonicalIntegrationValue(botBinding) ||
      canonicalIntegrationValue(job.input) !== canonicalIntegrationValue(input.input) ||
      job.actionId !== input.actionId)
  ) {
    throw new Error("Bot integration idempotency key belongs to different approved content")
  }
  if (planned?.action === "deny" && !existing) {
    await appendIntegrationAudit({
      pluginId,
      integrationId: input.integrationId,
      accountId: input.accountId,
      kind: `action.${input.actionId}.fenced`,
      outcome: "denied",
      detail: { jobId: job.id },
    })
  }
  if (
    planned?.action === "park" &&
    job.outbound?.held?.receiptId === planned.receipt.request.requestId
  ) {
    void pushHeldIntegrationJob({
      jobId: job.id,
      toolName: integrationToolName(pluginId, input.integrationId, input.actionId),
      label: `${registered.definition.label}: ${action.label}`,
      origin: botBinding ? "bot" : "plugin",
      review: planned.review,
      onAnswer: (answer) =>
        answer.kind === "approved"
          ? approveIntegrationActionJob(job.id, {
              actor: "person",
              ...(answer.forRequest ? { forRequest: true } : {}),
            })
          : cancelIntegrationActionJob(job.id, { actor: "person" }),
    })
  }
  if (job.status !== "queued") return job
  await appendIntegrationAudit({
    pluginId,
    integrationId: input.integrationId,
    accountId: input.accountId,
    kind: `action.${input.actionId}.queued`,
    outcome: "allowed",
  })
  return runIntegrationActionJob(job.id)
}

/**
 * The receipt of a person's answer to a held job, and the job's outbound
 * record without the hold. A refusal fences the recipients for the rest of
 * the request (ADR-0239).
 */
async function answerHold(
  job: IntegrationActionJob,
  answer: "approved" | "denied",
  forRequest: boolean | undefined
): Promise<Pick<IntegrationActionJob, "outbound" | "authorizedBy">> {
  const { held: _held, ...outbound } = job.outbound!
  const receipt = heldJobAnswerReceipt({
    outbound,
    targets: await githubJobTargets(job),
    operation: `${job.integrationId}.${job.actionId}`,
    answer,
    ...(forRequest ? { forRequest: true } : {}),
  })
  await recordIntegrationReceipt(receipt)
  return {
    outbound,
    ...(answer === "approved"
      ? {
          authorizedBy: {
            receiptId: receipt.request.requestId,
            authority: "human" as const,
            grantScope: receipt.decision.grant?.scope ?? "once",
          },
        }
      : {}),
  }
}

/**
 * Approve a job waiting for approval and run it. A job the outbound policy
 * held is released only by a person (`answer.actor: "person"`): an automatic
 * approval (a capability grant, a workflow) leaves it held.
 */
export async function approveIntegrationActionJob(
  jobId: string,
  answer: IntegrationJobAnswer = {}
): Promise<IntegrationActionJob> {
  const job = await getIntegrationActionJob(jobId)
  if (!job) throw new Error(`Integration action job "${jobId}" was not found`)
  if (job.status !== "awaiting_approval") return job
  let hold: Partial<IntegrationActionJob> = {}
  if (job.outbound?.held) {
    if (answer.actor !== "person") return job
    withdrawHeldIntegrationJob(jobId)
    hold = await answerHold(job, "approved", answer.forRequest)
  }
  const approved = await updateIntegrationActionJob(
    jobId,
    { ...hold, status: "queued" },
    {
      statuses: ["awaiting_approval"],
      audit: {
        pluginId: job.pluginId,
        integrationId: job.integrationId,
        accountId: job.accountId,
        kind: `action.${job.actionId}.approved`,
        outcome: "allowed",
      },
    }
  )
  // Secondary windows do not have plugin handlers. The owner drain picks up
  // this durable approval; racing answers cannot queue a terminal job again.
  return approved.status === "queued" && (await isIntegrationRuntimeOwner())
    ? runIntegrationActionJob(jobId)
    : approved
}

export async function runIntegrationActionJob(jobId: string): Promise<IntegrationActionJob> {
  const candidate = await getIntegrationActionJob(jobId)
  if (!candidate) throw new Error(`Integration action job "${jobId}" was not found`)
  if (!(await isIntegrationRuntimeOwner())) return candidate
  const running = runningPerAccount.get(candidate.accountId) ?? 0
  if (running >= MAX_ACCOUNT_CONCURRENCY) return candidate
  const registered = getRegisteredIntegration(candidate.pluginId, candidate.integrationId)
  const action = registered?.definition.actions.find((entry) => entry.id === candidate.actionId)
  const job = await claimIntegrationActionJob(jobId, {
    owner: claimOwner,
    leaseMs: (action?.timeoutMs ?? 30_000) + 5_000,
    idempotent: action?.idempotency === "supported" || action?.idempotency === "required",
  })
  if (!job) return (await getIntegrationActionJob(jobId))!
  const claimToken = job.claimToken!
  const condition = { claimToken }
  const controller = new AbortController()
  runningControllers.set(jobId, controller)
  runningPerAccount.set(job.accountId, (runningPerAccount.get(job.accountId) ?? 0) + 1)
  const cancelClaim = (error: string) =>
    cancelIntegrationActionJobRecord(jobId, { error }, claimToken)
  const reportCancellationFailure = (error: unknown) =>
    loggers.plugin.error("Integration action cancellation failed", { jobId, error })
  const cancel = (reason: string) => {
    controller.abort()
    void cancelClaim(reason).catch(reportCancellationFailure)
  }
  const assertActiveClaim = async (write = false) => {
    if (getRegisteredIntegration(job.pluginId, job.integrationId) !== registered) {
      cancel("Integration plugin unregistered")
    }
    if (controller.signal.aborted) throw new Error("Action cancelled or timed out")
    const current = await updateIntegrationActionJob(
      jobId,
      write ? { remoteWriteStartedAt: new Date().toISOString() } : {},
      condition
    )
    if (
      controller.signal.aborted ||
      current.status !== "running" ||
      current.claimToken !== claimToken
    ) {
      controller.abort()
      throw new Error("Action execution claim is no longer active")
    }
  }
  const readRequestInit = { signal: controller.signal, beforeSend: () => assertActiveClaim() }
  // Dexie observes cancellations/reclaims from other windows as well.
  const subscription = liveQuery(() => getIntegrationActionJob(jobId)).subscribe({
    next: (current) => {
      if (!current || current.status !== "running" || current.claimToken !== claimToken) {
        controller.abort()
      }
    },
    error: () => cancel("Execution lease could not be verified"),
  })
  const unsubscribeRegistry = subscribeIntegrationRegistry(() => {
    if (getRegisteredIntegration(job.pluginId, job.integrationId) !== registered) {
      cancel("Integration plugin unregistered")
    }
  })
  const timeout = setTimeout(
    () => cancel("Action cancelled or timed out"),
    action?.timeoutMs ?? 30_000
  )
  const attempts = job.attempts
  try {
    let approvedHeadSha: string | undefined
    if (job.botBinding) {
      try {
        const binding = await assertBotIntegrationAction(
          job.botBinding.pluginId,
          job.botBinding,
          job,
          job.botBinding.approvalId
        )
        if (binding.account.id !== job.accountId || binding.account.pluginId !== job.pluginId) {
          throw new Error("Bot integration binding changed before publication")
        }
        await assertApprovedPublicationHead(binding, readRequestInit)
        approvedHeadSha = binding.approvedPublication?.headSha
      } catch (error) {
        return updateIntegrationActionJob(
          job.id,
          {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
          condition
        )
      }
    }
    const isGithubIssueLoop =
      job.pluginId === "github-delivery" &&
      job.integrationId === "github" &&
      job.actionId === "runIssueLoop"
    const handler = isGithubIssueLoop
      ? githubIssueLoopExecutor
      : getIntegrationActionHandler(job.pluginId, job.integrationId, job.actionId)
    if (!action || !handler) {
      return updateIntegrationActionJob(
        jobId,
        {
          status: "failed",
          error: `Integration action "${job.actionId}" is unavailable`,
        },
        condition
      )
    }
    const availability = resolveIntegrationActionAvailability(
      job.pluginId,
      job.integrationId,
      job.actionId
    )
    if (!availability.available) {
      return updateIntegrationActionJob(
        jobId,
        {
          status: "failed",
          error: availability.reason,
        },
        condition
      )
    }

    const jobAccount = await getIntegrationAccount(job.pluginId, job.accountId)
    const context: IntegrationActionHandlerContext = {
      pluginId: job.pluginId,
      integrationId: job.integrationId,
      accountId: job.accountId,
      jobId,
      signal: controller.signal,
      authenticatedRequest: async (input, init) => {
        if (controller.signal.aborted) throw new Error("Action cancelled or timed out")
        if (job.botBinding && !["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase())) {
          const binding = await assertBotIntegrationAction(
            job.botBinding.pluginId,
            job.botBinding,
            job,
            job.botBinding.approvalId
          )
          if (binding.account.id !== job.accountId || binding.account.pluginId !== job.pluginId)
            throw new Error("Bot integration binding changed before publication")
          await assertApprovedPublicationHead(binding, readRequestInit)
          if (controller.signal.aborted) throw new Error("Action cancelled or timed out")
        }
        // A write the job makes on its own (the Issue Loop's pull request):
        // covered when it goes to a repository the job was planned for, else
        // planned in the job's origin (ADR-0239 phase 2).
        const method = (init?.method ?? "GET").toUpperCase()
        if (!READ_METHODS.has(method)) {
          await planAuthenticatedRequest(job.pluginId, job.accountId, input, method, {
            kind: "job",
            jobId,
            ...(job.outbound ? { outbound: job.outbound } : {}),
            covers: await githubJobTargets(job),
          })
        }
        if (controller.signal.aborted) throw new Error("Action cancelled or timed out")
        return authenticatedRequest(job.pluginId, job.accountId, input, {
          ...init,
          signal: controller.signal,
          beforeSend: () => assertActiveClaim(!READ_METHODS.has(method)),
        })
      },
      ...(jobAccount ? { apiBaseUrl: await integrationApiBaseUrl(jobAccount) } : {}),
    }
    await assertActiveClaim()
    // Keep persisted/approved input immutable. This value comes only from the host publication.
    const output = await handler(
      approvedHeadSha ? { ...job.input, expectedHeadSha: approvedHeadSha } : job.input,
      context
    )
    if (controller.signal.aborted) return cancelClaim("Action cancelled or timed out")
    const outputValidation = action.outputSchema
      ? validateAgainstJsonSchema(action.outputSchema, output)
      : { ok: true as const }
    if (!outputValidation.ok) {
      throw new Error(`Integration action output is invalid: ${outputValidation.errors.join("; ")}`)
    }
    const completed = await updateIntegrationActionJob(
      jobId,
      {
        status: "succeeded",
        output,
        error: undefined,
        nextAttemptAt: undefined,
      },
      {
        ...condition,
        audit: {
          pluginId: job.pluginId,
          integrationId: job.integrationId,
          accountId: job.accountId,
          kind: `action.${job.actionId}`,
          outcome: "succeeded",
          detail: { jobId, attempts },
        },
      }
    )
    return completed
  } catch (error) {
    if (controller.signal.aborted) {
      return cancelClaim("Action cancelled or timed out")
    }
    const message = error instanceof Error ? error.message : String(error)
    const retryable =
      !(error instanceof OutboundPolicyError) &&
      action?.idempotency !== "none" &&
      attempts < job.maxAttempts
    const nextAttemptAt = retryable
      ? new Date(Date.now() + retryDelayMs(error, attempts)).toISOString()
      : undefined
    const failed = await updateIntegrationActionJob(
      jobId,
      {
        status: retryable ? "retry_wait" : attempts >= job.maxAttempts ? "deadlettered" : "failed",
        error: message,
        nextAttemptAt,
      },
      {
        ...condition,
        audit: {
          pluginId: job.pluginId,
          integrationId: job.integrationId,
          accountId: job.accountId,
          kind: `action.${job.actionId}`,
          outcome: "failed",
          detail: {
            jobId,
            attempts,
            retryable,
            error: message,
            nextRetryAt: nextAttemptAt,
            ...integrationErrorDetail(error),
          },
        },
      }
    )
    return failed
  } finally {
    clearTimeout(timeout)
    subscription.unsubscribe()
    unsubscribeRegistry()
    if (runningControllers.get(jobId) === controller) runningControllers.delete(jobId)
    runningPerAccount.set(
      job.accountId,
      Math.max(0, (runningPerAccount.get(job.accountId) ?? 1) - 1)
    )
  }
}

export async function drainIntegrationActionJobs(): Promise<IntegrationActionJob[]> {
  if (!(await isIntegrationRuntimeOwner())) return []
  const jobs = await listRunnableIntegrationActionJobs()
  return Promise.all(jobs.map((job) => runIntegrationActionJob(job.id)))
}

/**
 * Cancel a job. A person cancelling a job the outbound policy held refuses
 * its recipients for the rest of the request (ADR-0239): the next write to
 * them in that request fails `outbound_fenced` instead of asking again.
 */
export async function cancelIntegrationActionJob(
  jobId: string,
  answer: Pick<IntegrationJobAnswer, "actor"> = {}
): Promise<IntegrationActionJob> {
  const job = await getIntegrationActionJob(jobId)
  if (!job) throw new Error(`Integration action job "${jobId}" was not found`)
  if (["succeeded", "failed", "deadlettered", "cancelled"].includes(job.status)) return job
  let hold: Partial<IntegrationActionJob> = {}
  if (job.outbound?.held) {
    withdrawHeldIntegrationJob(jobId)
    hold =
      answer.actor === "person"
        ? await answerHold(job, "denied", false)
        : { outbound: { ...job.outbound, held: undefined } }
  }
  const cancelled = await cancelIntegrationActionJobRecord(jobId, {
    ...hold,
    error: "Cancelled by user",
  })
  if (cancelled.status === "cancelled") runningControllers.get(jobId)?.abort()
  return cancelled
}

/**
 * The REST root an account's credential belongs to (ADR-0176).
 *
 * Resolved from the auth session rather than stored on the account, so it can
 * never disagree with the credential it authenticates: one value, held where
 * the user configured it. `undefined` for every provider that is not
 * host-aware, which leaves the plugin's own default in place.
 *
 * Never throws. A plugin whose API origin cannot be resolved should run against
 * its default and fail on the request, with the request's own error, rather
 * than be refused here with an error about credential storage.
 */
export async function integrationApiBaseUrl(account: {
  providerId: string
  authSessionId: string
}): Promise<string | undefined> {
  if (account.providerId !== "github-app" && account.providerId !== "github-pat") return undefined
  try {
    const { githubHostForSession } = await import("./github-auth")
    return (await githubHostForSession(account.authSessionId))?.apiBaseUrl
  } catch {
    return undefined
  }
}

export function setIntegrationAuthenticatedRequestExecutorForTesting(
  executor?: AuthenticatedRequestExecutor
): void {
  requestOverride = executor
}

export function setGithubIssueLoopExecutorForTesting(
  executor: IntegrationActionHandler = runGithubIssueLoop
): void {
  githubIssueLoopExecutor = executor
}

export function setGithubIssueLoopDesktopHostAvailableForTesting(available?: boolean): void {
  githubIssueLoopDesktopHostOverride = available
}
