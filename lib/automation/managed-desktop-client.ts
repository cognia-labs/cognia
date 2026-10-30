/** Host-bound managed desktop RPCs. No provider credential or traffic URL crosses this seam. */
import { localTransport, onTransportChange } from "@/lib/tauri/transport-instance"
import {
  acquireManagementChannel,
  withManagementChannel,
} from "@/lib/remote-host/management-channel"
import {
  HostConsentRequiredError,
  issueHostAdminLease,
  type HostAdminLease,
} from "@/lib/tauri/admin-lease"
import type { Transport } from "@/lib/tauri/transport-types"
import { effectiveConnectionState } from "@/hooks/companion/use-connection-state"
import {
  loadCompanionConfig,
  getCompanionConfigGeneration,
  type ConnectionState,
  type TransportTier,
} from "@/lib/tauri/transport-companion"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { pairedHostIdOf } from "@/lib/remote-host/target-transport"
import type { EgressTier, IsolationTier } from "@/types/sandbox/environment-spec"
import type {
  SandboxControlLease,
  SandboxDesktopFrame,
  SandboxDesktopSession,
  SandboxDesktopStatus,
} from "./sandbox-client"
import { useAccountStore } from "@/stores/account/account-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { E2bSandboxConfig, ManagedDesktopQualificationProjection } from "@/types/sandbox"

export type ManagedDesktopTarget = E2bSandboxConfig["target"]
export type ManagedDesktopTemplateState =
  "registering" | "registered" | "building" | "ready" | "unknown" | "failed" | "deleting"
/** One provider template; deletion is explicit and waits for confirmed absence (A7). */
export interface ManagedDesktopTemplateSummary {
  id: string
  providerConfigId: string
  state: ManagedDesktopTemplateState
  identity: {
    templateId: string
    buildId: string
    imageDigest: string
    recipeRevision: string
    protocol: string
  } | null
  desktopsInUse: number
  createdAt: number
  updatedAt: number
  errorCode: string | null
  cleanupAttempts: number
  nextRetryAt: number | null
}
export type ManagedDesktopAlertKind = "pastDeadline" | "cleanupStalled" | "templateCleanupStalled"
export interface ManagedDesktopAlert {
  kind: ManagedDesktopAlertKind
  /** Desktop or template ID; never a provider resource ID. */
  subjectId: string
  providerConfigId: string
  since: number
}
/** The caller's billing and cleanup picture on one Host (ADR-0233 §5, A7). */
export interface ManagedDesktopMonitor {
  observedAt: number
  billedDesktops: number
  maximumExposureMicros: Record<string, number>
  oldestPendingCreateAt: number | null
  oldestPendingDeleteAt: number | null
  alerts: ManagedDesktopAlert[]
}
/** Host event raised when any account's monitor changed; it carries no data. */
export const MANAGED_DESKTOP_MONITOR_CHANGED = "managed-desktop://monitor-changed"
/** Host event raised when any qualification run changed; it carries no data. */
export const MANAGED_DESKTOP_QUALIFICATION_CHANGED = "managed-desktop://qualification-changed"

/** One native qualification category (ADR-0233 A3). Each produces its own receipt. */
export type ManagedDesktopQualificationCategory =
  "lifecycle" | "control" | "authority" | "workload" | "commit" | "bundle"
/** Per-configuration switches (A4). The Host reports the effective value: a stale receipt reads off. */
export interface ManagedDesktopEnablement {
  manualGui: boolean
  agentControl: boolean
  acceptance: boolean
}
export interface ManagedDesktopCategoryReceipt {
  category: ManagedDesktopQualificationCategory
  /** Whether a receipt exists for this exact configuration revision and template. */
  current: boolean
  observedAt: number | null
}
/** `gui` qualifies manual GUI and agent control; `acceptance` adds both handoff modes. */
export type ManagedDesktopQualificationScope = "gui" | "acceptance"
export type ManagedDesktopQualificationRunState =
  | "running"
  | "awaitingApproval"
  | "passed"
  | "failed"
  | "cancelled"
  /** A Host restart ended the run; it is never resumed silently. */
  | "interrupted"
export interface ManagedDesktopQualificationRun {
  runId: string
  providerConfigId: string
  configRevision: number
  scope: ManagedDesktopQualificationScope
  state: ManagedDesktopQualificationRunState
  currentCategory: ManagedDesktopQualificationCategory | null
  /** The billed step the run is paused on; nothing is spent until it is approved. */
  awaitingApproval: {
    quote: ManagedDesktopQuote
    purpose: "prepareTemplate" | "smoke"
    /** Template preparation may incur provider build charges beyond the quote. */
    templateBuildCharges: boolean
  } | null
  categories: {
    category: ManagedDesktopQualificationCategory
    state: "pending" | "running" | "passed" | "failed" | "skipped"
    errorCode: string | null
  }[]
  handoff: { deliveryId: string; script: string } | null
  errorCode: string | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
}
/** Host event raised when any delegation was created, revoked or ended; it carries no data. */
export const MANAGED_DESKTOP_DELEGATION_CHANGED = "managed-desktop://delegation-changed"

/** Who may drive the desktop (ADR-0233 A5): one chat session, every session of a character, or one acceptance run. */
export type ManagedDesktopDelegationGrantee =
  | { kind: "session"; sessionKey: string }
  | { kind: "character"; characterId: string }
  | { kind: "acceptance"; acceptanceId: string }
export type ManagedDesktopDelegationEndReason =
  "revoked" | "expired" | "destroyed" | "generationChanged" | "accountChanged"
/** A Host record that lets an agent drive one desktop generation, never longer than its deadline. */
export interface ManagedDesktopDelegation {
  id: string
  desktopId: string
  desktopGeneration: number
  providerConfigId: string
  grantee: ManagedDesktopDelegationGrantee
  mode: "computerUse" | "acceptance"
  state: "live" | "ended"
  endReason: ManagedDesktopDelegationEndReason | null
  expiresAt: number
  revision: number
  createdAt: number
  endedAt: number | null
}
export interface ManagedDesktopDelegationRequest {
  desktopId: string
  generation: number
  /** Only computer-use grantees are created here; acceptance delegations come from the runner. */
  grantee: Exclude<ManagedDesktopDelegationGrantee, { kind: "acceptance" }>
  /** Clamped by the Host to the desktop's hard deadline; omitted means the deadline. */
  expiresAt?: number
}

export interface ManagedDesktopQualificationStart {
  providerConfigId: string
  scope: ManagedDesktopQualificationScope
  /** Required for `acceptance`: an existing delivery and the npm script the guest runs. */
  handoff?: { deliveryId: string; script: string }
}

/** The account plan the Host administrator confirmed (ADR-0233 §3). */
export interface ManagedDesktopPlanBinding {
  maxLifetimeSeconds: number
  observedAt: number
  expiresAt: number
  source: string
  namespace: string
}
/** The provider rate the Host administrator confirmed (ADR-0233 §3). */
export interface ManagedDesktopPrice {
  currency: string
  hourlyRateMicros: number
  observedAt: number
  expiresAt: number
  source: string
}
export interface ManagedDesktopConfigSummary extends ManagedDesktopQualificationProjection {
  id: string
  ownerPrincipalId: string
  hostId: string
  /** Optimistic-concurrency token for saves and deletes. */
  revision: number
  credentialGeneration: number
  /** Whether a provider key is stored for the current generation. Never the key. */
  credentialPresent: boolean
  plan: ManagedDesktopPlanBinding
  price: ManagedDesktopPrice
  isolationMinimum: IsolationTier
  enabled: boolean
  canPrepareTemplate: boolean
  canCreate: boolean
  /** False until the Host records an authorized, measured GUI smoke receipt. */
  guiQualified?: boolean
  enablement: ManagedDesktopEnablement
  /** All six categories, in qualification order. */
  qualificationCategories: ManagedDesktopCategoryReceipt[]
  isolationTier: IsolationTier
  egressTier: EgressTier
  egressEnforcement: "provider-and-guest-kernel" | "unverified"
  templateState?: ManagedDesktopTemplateState | null
  reason?: string | null
  maxConcurrent: number
  maxLifetimeSeconds: number
  idleTimeoutSeconds: number
  region?: string | null
  cpuCount: number
  memoryMb: number
  template?: {
    templateId: string
    buildId: string
    imageDigest: string
    recipeRevision: string
    protocol: string
  } | null
}
/**
 * The editable part of a configuration (ADR-0233 amendment A1). The Host
 * derives owner, Host, release, revision and credential generation, and dates
 * the plan and price confirmation with its own clock when it saves.
 */
export interface ManagedDesktopConfigDraft {
  id: string
  /** `null` creates; a revision replaces exactly that revision. */
  expectedRevision: number | null
  enabled: boolean
  shape: { cpuCount: number; memoryMb: number }
  limits: { maxConcurrent: number; maxLifetimeSeconds: number; idleTimeoutSeconds: number }
  plan: { maxLifetimeSeconds: number; source: string; namespace: string; validForMs: number }
  price: { currency: string; hourlyRateMicros: number; source: string; validForMs: number }
  /** Only egress Off is qualified (amendment A10). */
  egress: { mode: "off" }
  isolationMinimum: IsolationTier
  /** The Host refuses a switch whose receipts are not current for this revision. */
  enablement: ManagedDesktopEnablement
}
/** Where a new provider key comes from. A copied key never reaches the renderer. */
export type ManagedDesktopCredentialSource =
  { kind: "key"; key: string } | { kind: "remoteSandbox"; providerId: string }

/** Which trusted release manifest the Host loaded (ADR-0233 A2). Never a path. */
export interface ManagedDesktopReleaseStatus {
  state: "installed" | "absent" | "invalid"
  source: "data-directory" | "bundled" | null
  imageDigest: string | null
  recipeRevision: string | null
  protocol: string | null
  error: string | null
}
export interface ManagedDesktopQuote {
  id: string
  providerConfigId: string
  lifetimeSeconds: number
  expiresAt: number
  currency: string
  hourlyRateMicros: number
  maximumComputeCostMicros: number
  priceObservedAt: number
  region?: string | null
  cpuCount: number
  memoryMb: number
  configRevision: number
}
export interface ManagedDesktopResource {
  id: string
  providerConfigId: string
  generation: number
  state: "creating" | "running" | "deleting" | "destroyRetrying" | "destroyed" | "error"
  deadlineAt: number
  idleTimeoutSeconds: number
  createdAt: number
  updatedAt: number
  lastErrorCode?: string | null
  cleanupAttempts: number
  qualification: "unqualified" | "qualified" | "smoke"
}
export interface ManagedDesktopHealth {
  reachable: boolean
  state: ManagedDesktopResource["state"]
  desktop: ManagedDesktopResource
  errorCode?: string | null
}
export interface ManagedDesktopRef {
  desktopId: string
  generation: number
}
export interface ManagedDesktopCreation {
  providerConfigId: string
  quoteId: string
  authorizationId: string
  idempotencyKey: string
}
export interface ManagedDesktopAuthorization {
  id: string
  expiresAt: number
}

// Leases are tied to the actual authenticated management transport, never merely
// its display id. Re-pairing replaces the transport and cannot reuse the lease.
const adminLeases = new WeakMap<
  Transport,
  {
    lease: HostAdminLease
    account: ReturnType<typeof useAccountStore.getState>
    hostConfig: string | undefined
  }
>()
const ADMIN_OPERATIONS = [
  "managed_desktop_config_save",
  "managed_desktop_config_delete",
  "managed_desktop_config_set_credential",
  "managed_desktop_config_rotate_credential",
  "managed_desktop_template_delete",
  "managed_desktop_authorize",
  "managed_desktop_prepare_template",
  "managed_desktop_create",
  "managed_desktop_connect",
  "managed_desktop_delete",
  "managed_desktop_qualify_start",
  "managed_desktop_qualify_approve",
  "managed_desktop_qualify_cancel",
  "managed_desktop_delegate",
  "managed_desktop_delegation_revoke",
  "managed_desktop_acceptance_start",
  "managed_desktop_acceptance_attach",
  "managed_desktop_acceptance_cancel",
]

/** Public pairing projection shared by lifecycle and the settings identity boundary. */
export function managedDesktopTargetConfig(target: ManagedDesktopTarget): string | undefined {
  if (target.kind === "local") return "local"
  const account = useAccountStore.getState()
  if (account.locked || !account.unlockedAccountId) return undefined
  const paired = pairedHostIdOf(target.hostId)
  if (paired) {
    const active = getActiveRuntimeTargetContext()
    const config = loadCompanionConfig()
    if (
      active?.targetId !== paired ||
      config?.targetId !== paired ||
      config.accountId !== account.unlockedAccountId ||
      active.accountId !== account.unlockedAccountId
    )
      return undefined
    const publicConfig = { ...config }
    delete publicConfig.devicePrivateKeyJwk
    delete publicConfig.signalingPrivateKeyJwk
    delete publicConfig.signalingPrivateKey
    delete publicConfig.serviceToken
    return JSON.stringify(publicConfig)
  }
  const host = useRemoteHostStore
    .getState()
    .hosts.find(
      (candidate) =>
        candidate.id === target.hostId ||
        (candidate.featureManifest?.schemaVersion === 2 &&
          candidate.featureManifest.hostIdentity.id === target.hostId)
    )
  if (!host || host.config.accountId !== account.unlockedAccountId) return undefined
  return JSON.stringify(host.config)
}

export function subscribeManagedDesktopTargetChanges(listener: () => void): () => void {
  const detach = [
    useRemoteHostStore.subscribe(listener),
    subscribeRuntimeTargetContext(listener),
    onTransportChange(listener),
  ]
  if (typeof window !== "undefined")
    window.addEventListener("cognia:companion-config-changed", listener)
  return () => {
    detach.forEach((unsubscribe) => unsubscribe())
    if (typeof window !== "undefined")
      window.removeEventListener("cognia:companion-config-changed", listener)
  }
}

/** Capture before opening a channel; invalidation is sticky across account/pairing ABA. */
export function managedDesktopIdentityScope(
  target: ManagedDesktopTarget,
  onInvalidated = () => {}
) {
  const account = useAccountStore.getState()
  if (account.locked || !account.unlockedAccountId)
    throw new Error("managed_desktop_authentication_required")
  if (target.kind === "remote" && !target.hostId.trim())
    throw new Error("managed desktop host is required")
  const readHostConfig = () => managedDesktopTargetConfig(target)
  const pairedGeneration =
    target.kind === "remote" && pairedHostIdOf(target.hostId)
      ? getCompanionConfigGeneration()
      : undefined
  const hostConfig = readHostConfig()
  let invalidated = false
  const invalidate = () => {
    if (invalidated) return
    invalidated = true
    onInvalidated()
  }
  const check = () => {
    const current = useAccountStore.getState()
    if (
      current.locked ||
      current.unlockedAccountId !== account.unlockedAccountId ||
      readHostConfig() !== hostConfig ||
      (pairedGeneration !== undefined && pairedGeneration !== getCompanionConfigGeneration()) ||
      (target.kind === "remote" && hostConfig === undefined)
    )
      invalidate()
  }
  const detach = [
    useAccountStore.subscribe(check),
    subscribeManagedDesktopTargetChanges(check),
    onTransportChange(invalidate),
  ]
  return {
    account,
    hostConfig,
    assertActive: () => {
      check()
      if (invalidated) throw new Error("managed_desktop_session_invalidated")
    },
    assertChannel: (config: unknown) => {
      if (JSON.stringify(config) !== hostConfig) invalidate()
      check()
      if (invalidated) throw new Error("managed_desktop_session_invalidated")
    },
    dispose: () => detach.forEach((unsubscribe) => unsubscribe()),
  }
}

async function call<T>(
  target: ManagedDesktopTarget,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const identity = managedDesktopIdentityScope(target)
  try {
    identity.assertActive()
    if (target.kind === "local") {
      const result = await localTransport.call<T>("managed_desktop_local_call", { name, args })
      identity.assertActive()
      return result
    }
    return await withManagementChannel(target.hostId, async (channel) => {
      identity.assertChannel(channel.host.config)
      if (!ADMIN_OPERATIONS.includes(name)) {
        const result = await channel.transport.call<T>(name, args)
        identity.assertActive()
        return result
      }
      const cached = adminLeases.get(channel.transport)
      // An account-store transition also prevents reuse of a completed call's lease.
      let admin =
        cached?.account === identity.account && cached.hostConfig === identity.hostConfig
          ? cached.lease
          : undefined
      if (!admin || admin.expiresAt <= Date.now() || !admin.operations.includes(name)) {
        admin = await issueHostAdminLease([...ADMIN_OPERATIONS], 600, channel.transport)
        identity.assertActive()
        adminLeases.set(channel.transport, {
          lease: admin,
          account: identity.account,
          hostConfig: identity.hostConfig,
        })
      }
      identity.assertActive()
      try {
        const result = await channel.transport.call<T>(name, { ...args, adminLease: admin.token })
        identity.assertActive()
        return result
      } catch (error) {
        if (isInvalidAdminLease(error) && adminLeases.get(channel.transport)?.lease === admin) {
          adminLeases.delete(channel.transport)
        }
        throw error
      }
    })
  } finally {
    identity.dispose()
  }
}

/**
 * One Host managed-desktop RPC under the caller's identity scope. Writes in
 * `ADMIN_OPERATIONS` carry a short admin lease on a remote Host; the local
 * shell needs none. Other managed-desktop clients reuse this instead of
 * opening their own channel.
 */
export const callManagedDesktop = call

export const managedDesktopClient = {
  list: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopResource[]>(target, "managed_desktop_list", {}),
  releaseStatus: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopReleaseStatus>(target, "managed_desktop_release_status", {}),
  saveConfig: (target: ManagedDesktopTarget, draft: ManagedDesktopConfigDraft) =>
    call<ManagedDesktopConfigSummary>(target, "managed_desktop_config_save", { ...draft }),
  deleteConfig: (
    target: ManagedDesktopTarget,
    providerConfigId: string,
    expectedRevision: number
  ) => call<null>(target, "managed_desktop_config_delete", { providerConfigId, expectedRevision }),
  setCredential: (
    target: ManagedDesktopTarget,
    providerConfigId: string,
    expectedRevision: number,
    source: ManagedDesktopCredentialSource
  ) =>
    call<ManagedDesktopConfigSummary>(target, "managed_desktop_config_set_credential", {
      providerConfigId,
      expectedRevision,
      source,
    }),
  rotateCredential: (
    target: ManagedDesktopTarget,
    providerConfigId: string,
    expectedRevision: number,
    source: ManagedDesktopCredentialSource
  ) =>
    call<ManagedDesktopConfigSummary>(target, "managed_desktop_config_rotate_credential", {
      providerConfigId,
      expectedRevision,
      source,
    }),
  templateList: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopTemplateSummary[]>(target, "managed_desktop_template_list", {}),
  /** `null` once the provider confirmed the template is gone. */
  templateDelete: (target: ManagedDesktopTarget, templateId: string) =>
    call<ManagedDesktopTemplateSummary | null>(target, "managed_desktop_template_delete", {
      templateId,
    }),
  monitor: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopMonitor>(target, "managed_desktop_monitor", {}),
  listConfigs: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopConfigSummary[]>(target, "managed_desktop_list_configs", {}),
  quote: (target: ManagedDesktopTarget, providerConfigId: string, lifetimeSeconds: number) =>
    call<ManagedDesktopQuote>(target, "managed_desktop_quote", {
      providerConfigId,
      lifetimeSeconds,
    }),
  authorize: (
    target: ManagedDesktopTarget,
    providerConfigId: string,
    quoteId: string,
    action: "create" | "prepareTemplate"
  ) =>
    call<ManagedDesktopAuthorization>(target, "managed_desktop_authorize", {
      providerConfigId,
      quoteId,
      action,
    }),
  prepareTemplate: (target: ManagedDesktopTarget, request: ManagedDesktopCreation) =>
    call<ManagedDesktopConfigSummary>(target, "managed_desktop_prepare_template", { ...request }),
  create: (target: ManagedDesktopTarget, request: ManagedDesktopCreation) =>
    call<ManagedDesktopResource>(target, "managed_desktop_create", { ...request }),
  connect: (target: ManagedDesktopTarget, ref: ManagedDesktopRef) =>
    call<ManagedDesktopResource>(target, "managed_desktop_connect", { ...ref }),
  health: (target: ManagedDesktopTarget, ref: ManagedDesktopRef) =>
    call<ManagedDesktopHealth>(target, "managed_desktop_health", { ...ref }),
  delete: (target: ManagedDesktopTarget, ref: ManagedDesktopRef) =>
    call<ManagedDesktopResource>(target, "managed_desktop_delete", { ...ref }),
  qualifyStart: (target: ManagedDesktopTarget, request: ManagedDesktopQualificationStart) =>
    call<ManagedDesktopQualificationRun>(target, "managed_desktop_qualify_start", { ...request }),
  qualifyStatus: (target: ManagedDesktopTarget, runId: string) =>
    call<ManagedDesktopQualificationRun>(target, "managed_desktop_qualify_status", { runId }),
  /** Newest first; finished runs stay listed for a bounded history. */
  qualifyList: (target: ManagedDesktopTarget) =>
    call<{ runs: ManagedDesktopQualificationRun[] }>(target, "managed_desktop_qualify_list", {}),
  /** Approves exactly the quote the run is paused on. */
  qualifyApprove: (target: ManagedDesktopTarget, runId: string, quoteId: string) =>
    call<ManagedDesktopQualificationRun>(target, "managed_desktop_qualify_approve", {
      runId,
      quoteId,
    }),
  /** Ends the run and destroys any desktop it created. */
  qualifyCancel: (target: ManagedDesktopTarget, runId: string) =>
    call<ManagedDesktopQualificationRun>(target, "managed_desktop_qualify_cancel", { runId }),
  /** Idempotent per grantee and desktop generation; refused unless agent control is in effect. */
  delegate: (target: ManagedDesktopTarget, request: ManagedDesktopDelegationRequest) =>
    call<ManagedDesktopDelegation>(target, "managed_desktop_delegate", { ...request }),
  revokeDelegation: (
    target: ManagedDesktopTarget,
    delegationId: string,
    expectedRevision: number
  ) =>
    call<ManagedDesktopDelegation>(target, "managed_desktop_delegation_revoke", {
      delegationId,
      expectedRevision,
    }),
  /** Live delegations first, then recently ended ones. */
  listDelegations: (target: ManagedDesktopTarget) =>
    call<{ delegations: ManagedDesktopDelegation[] }>(
      target,
      "managed_desktop_delegation_list",
      {}
    ),
}
/**
 * Keep `onValue` current with one Host read: one read now, then one per
 * data-free `topic` event. A remote Host holds its management channel for as
 * long as the watch lives. Responses that arrive after a newer read, after
 * `stop`, or across an account or Host change are dropped.
 */
export function watchHostTopic<T>(
  target: ManagedDesktopTarget,
  topic: string,
  read: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void
): () => void {
  const identity = managedDesktopIdentityScope(target)
  let stopped = false
  let latest = 0
  let unsubscribe: (() => void) | undefined
  let release: (() => void) | undefined
  const refresh = () => {
    const sequence = ++latest
    read().then(
      (value) => {
        if (stopped || sequence !== latest) return
        try {
          identity.assertActive()
        } catch {
          return
        }
        onValue(value)
      },
      (error) => {
        if (!stopped && sequence === latest) onError(error)
      }
    )
  }
  if (target.kind === "local") {
    unsubscribe = localTransport.subscribe(topic, refresh)
    refresh()
  } else {
    acquireManagementChannel(target.hostId).then(
      (lease) => {
        if (stopped) {
          lease.release()
          return
        }
        release = () => lease.release()
        unsubscribe = lease.transport.subscribe(topic, refresh)
        refresh()
      },
      (error) => {
        if (!stopped) onError(error)
      }
    )
  }
  return () => {
    stopped = true
    unsubscribe?.()
    release?.()
    identity.dispose()
  }
}

/** The caller's monitor on one Host, refreshed on `managed-desktop://monitor-changed`. */
export function watchManagedDesktopMonitor(
  target: ManagedDesktopTarget,
  onMonitor: (monitor: ManagedDesktopMonitor) => void,
  onError: (error: unknown) => void = () => {}
): () => void {
  return watchHostTopic(
    target,
    MANAGED_DESKTOP_MONITOR_CHANGED,
    () => managedDesktopClient.monitor(target),
    onMonitor,
    onError
  )
}

/** The caller's delegations on one Host, refreshed on every create, revoke or end. */
export function watchManagedDesktopDelegations(
  target: ManagedDesktopTarget,
  onDelegations: (delegations: ManagedDesktopDelegation[]) => void,
  onError: (error: unknown) => void = () => {}
): () => void {
  return watchHostTopic(
    target,
    MANAGED_DESKTOP_DELEGATION_CHANGED,
    async () => (await managedDesktopClient.listDelegations(target)).delegations,
    onDelegations,
    onError
  )
}

/** The caller's qualification runs on one Host, refreshed on every run change. */
export function watchManagedDesktopQualification(
  target: ManagedDesktopTarget,
  onRuns: (runs: ManagedDesktopQualificationRun[]) => void,
  onError: (error: unknown) => void = () => {}
): () => void {
  return watchHostTopic(
    target,
    MANAGED_DESKTOP_QUALIFICATION_CHANGED,
    async () => (await managedDesktopClient.qualifyList(target)).runs,
    onRuns,
    onError
  )
}

/** Open once per viewer. Authentication replacement invalidates, never silently rebinds control. */
export async function openManagedDesktop(
  target: ManagedDesktopTarget,
  ref: ManagedDesktopRef
): Promise<SandboxDesktopSession> {
  const account = useAccountStore.getState().unlockedAccountId
  if (!account || useAccountStore.getState().locked)
    throw new Error("managed_desktop_authentication_required")
  if (target.kind === "remote" && !target.hostId.trim())
    throw new Error("managed desktop host is required")
  const listeners = new Set<() => void>()
  let invalid = false
  const invalidate = () => {
    if (invalid) return
    invalid = true
    for (const handler of listeners) handler()
  }
  const identity = managedDesktopIdentityScope(target, invalidate)
  let channel: Awaited<ReturnType<typeof acquireManagementChannel>> | null = null
  try {
    identity.assertActive()
    channel = target.kind === "remote" ? await acquireManagementChannel(target.hostId) : null
    identity.assertActive()
    if (channel) identity.assertChannel(channel.host.config)
  } catch (error) {
    channel?.release()
    identity.dispose()
    throw error
  }
  const bound = channel?.transport ?? localTransport
  const detachers: Array<() => void> = [identity.dispose]
  let closed = false
  let controlAdmin: HostAdminLease | undefined
  const identityCurrent = () => {
    const current = useAccountStore.getState()
    return !current.locked && current.unlockedAccountId === account
  }
  if (channel) {
    const transport = bound as Transport & {
      onConnectionStateChange?: (handler: (state: ConnectionState) => void) => () => void
      onTierChange?: (handler: (tier: TransportTier) => void) => () => void
    }
    let tier: TransportTier | null = null
    let state: ConnectionState = "connected"
    // Reuse the companion's effective state: relay/RTC can work without a websocket.
    const checkConnection = () => {
      if (effectiveConnectionState(state, tier) !== "connected") invalidate()
    }
    if (transport.onTierChange)
      detachers.push(
        transport.onTierChange((next) => {
          tier = next
          checkConnection()
        })
      )
    if (transport.onConnectionStateChange)
      detachers.push(
        transport.onConnectionStateChange((next) => {
          state = next
          checkConnection()
        })
      )
  }
  async function callControl<T>(
    name: string,
    args: Record<string, unknown>,
    cleanup = false
  ): Promise<T> {
    identity.assertActive()
    if ((!cleanup && (invalid || closed)) || !identityCurrent())
      throw new Error("managed_desktop_session_invalidated")
    const request = { ...ref, ...args }
    const dispatch = async (command: string, payload: Record<string, unknown>): Promise<T> => {
      identity.assertActive()
      const result = await bound.call<T>(command, payload)
      identity.assertActive()
      if (!cleanup && (invalid || closed)) throw new Error("managed_desktop_session_invalidated")
      return result
    }
    if (target.kind === "local")
      return dispatch("managed_desktop_local_call", { name, args: request })
    if (name === "managed_desktop_control_acquire") {
      // A management lease is step-up only. It cannot replace the short input lease.
      const admin = await issueHostAdminLease(
        [
          "managed_desktop_control_acquire",
          "managed_desktop_control_renew",
          "managed_desktop_control_release",
          "managed_desktop_control_input",
        ],
        undefined,
        bound
      )
      if (invalid || closed || !identityCurrent())
        throw new Error("managed_desktop_session_invalidated")
      controlAdmin = admin
      return dispatch(name, { ...request, adminLease: admin.token })
    }
    if (
      [
        "managed_desktop_control_renew",
        "managed_desktop_control_release",
        "managed_desktop_control_input",
      ].includes(name)
    ) {
      if (!controlAdmin || controlAdmin.expiresAt <= Date.now())
        throw new Error("managed_desktop_admin_lease_expired")
      return dispatch(name, { ...request, adminLease: controlAdmin.token })
    }
    return dispatch(name, request)
  }
  const proof = (lease: SandboxControlLease) => {
    if (lease.fence === undefined) throw new Error("managed_desktop_missing_fence")
    return { token: lease.token, fence: lease.fence }
  }
  return {
    managed: true,
    status: () => callControl<SandboxDesktopStatus>("managed_desktop_control_status", {}),
    frame: () => callControl<SandboxDesktopFrame>("managed_desktop_control_frame", {}),
    acquire: (takeover) =>
      callControl<SandboxControlLease>("managed_desktop_control_acquire", { takeover }),
    renew: (lease) =>
      callControl<SandboxControlLease>("managed_desktop_control_renew", proof(lease)),
    release: (lease) => callControl<void>("managed_desktop_control_release", proof(lease), true),
    input: (lease, frame, point, action) => {
      if (!frame.frameId || frame.fence !== lease.fence)
        return Promise.reject(new Error("managed_desktop_missing_frame_proof"))
      return callControl<void>("managed_desktop_control_input", {
        ...proof(lease),
        frameId: frame.frameId,
        point,
        action,
      })
    },
    onInvalidated: (handler) => {
      listeners.add(handler)
      if (invalid) handler()
      return () => {
        listeners.delete(handler)
      }
    },
    close: () => {
      if (closed) return
      closed = true
      detachers.forEach((detach) => detach())
      channel?.release()
      listeners.clear()
    },
  }
}

export type ManagedDesktopClient = typeof managedDesktopClient

/** The exact refusal from cognia-companion-security::admin_lease::validate. */
function isInvalidAdminLease(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined
  return message === "REMOTE_CONSENT_REQUIRED: admin lease is invalid or expired"
}

/** Only known Host refusal codes become UI text; never render provider response bodies. */
export function managedDesktopErrorKey(error: unknown): string {
  if (error instanceof HostConsentRequiredError || isInvalidAdminLease(error))
    return "humanRequired"
  const codes: Record<string, string> = {
    managed_desktop_policy_limit: "policyLimit",
    managed_desktop_entitlement_limit: "entitlementLimit",
    managed_desktop_entitlement_unknown: "entitlementUnknown",
    managed_desktop_price_unknown: "priceUnknown",
    managed_desktop_unqualified: "unqualified",
    managed_desktop_egress_smoke_unsupported: "egressSmokeUnsupported",
    managed_desktop_human_authorization_required: "humanRequired",
    managed_desktop_host_consent_required: "humanRequired",
    managed_desktop_authorization_expired: "quoteExpired",
    managed_desktop_admin_required: "adminRequired",
    managed_desktop_release_unavailable: "releaseUnavailable",
    managed_desktop_config_exists: "configExists",
    managed_desktop_config_not_found: "configNotFound",
    managed_desktop_config_revision_conflict: "configRevisionConflict",
    managed_desktop_config_in_use: "configInUse",
    managed_desktop_config_invalid: "configInvalid",
    managed_desktop_secret_invalid: "secretInvalid",
    managed_desktop_secret_unavailable: "secretUnavailable",
    managed_desktop_credential_rotate_required: "credentialRotateRequired",
    managed_desktop_credential_source_not_found: "credentialSourceNotFound",
    managed_desktop_credential_source_unsupported: "credentialSourceUnsupported",
    managed_desktop_credential_source_empty: "credentialSourceEmpty",
    managed_desktop_credential_source_unavailable: "credentialSourceUnavailable",
    managed_desktop_template_in_use: "templateInUse",
    managed_desktop_template_not_found: "templateNotFound",
    managed_desktop_template_outcome_unknown: "templateOutcomeUnknown",
    managed_desktop_enablement_unqualified: "enablementUnqualified",
    managed_desktop_qualification_running: "qualificationRunning",
    managed_desktop_qualification_not_found: "qualificationNotFound",
    managed_desktop_qualification_quote_mismatch: "qualificationQuoteMismatch",
    managed_desktop_qualification_not_awaiting: "qualificationNotAwaiting",
    managed_desktop_handoff_delivery_unknown: "handoffDeliveryUnknown",
    managed_desktop_handoff_script_invalid: "handoffScriptInvalid",
    managed_desktop_agent_control_unqualified: "agentControlUnqualified",
    quote_expired: "quoteExpired",
    authorization_expired: "quoteExpired",
  }
  const candidates =
    typeof error === "string"
      ? [error]
      : error && typeof error === "object"
        ? ["code" in error ? error.code : undefined, "message" in error ? error.message : undefined]
        : []
  for (const candidate of candidates) {
    if (typeof candidate === "string" && codes[candidate]) return codes[candidate]
  }
  return "unknown"
}
