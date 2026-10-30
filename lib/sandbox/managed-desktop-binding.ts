/** Renderer projection of Host delegations into the existing connection registry (ADR-0233 A5). */
import {
  managedDesktopClient,
  managedDesktopIdentityScope,
  watchManagedDesktopDelegations,
  type ManagedDesktopDelegation,
  type ManagedDesktopDelegationRequest,
} from "@/lib/automation/managed-desktop-client"
import {
  createSandboxConnectionRow,
  deleteSandboxConnection,
  getSandboxConnection,
  listSandboxConnections,
  putSandboxConnection,
} from "@/lib/db/sandbox-connections"
import { SandboxRuntimeError } from "@cognia/plugin-sdk/api/sandbox"
import { getSession } from "@/lib/db/sessions"
import type { SandboxConnectionRow } from "@/types/sandbox"
import { managedDesktopCapabilities } from "./connection-capabilities"
import {
  managedDesktopHandoffClient,
  watchManagedDesktopAcceptance,
} from "@/lib/automation/managed-desktop-handoff-client"

const LOCAL = { kind: "local" } as const
export type ManagedDesktopGrantee = ManagedDesktopDelegationRequest["grantee"]

// Serialize projection writes, including event refreshes: an old event must
// never delete the row a newer delegate response just created.
let projectionTail: Promise<unknown> = Promise.resolve()
async function serialize<T>(operation: (assertActive: () => void) => Promise<T>): Promise<T> {
  // Capture before queueing: a click under account A must never run as account B.
  const identity = managedDesktopIdentityScope(LOCAL)
  const run = async () => {
    identity.assertActive()
    return operation(identity.assertActive)
  }
  const next = projectionTail.then(run, run).finally(() => identity.dispose())
  projectionTail = next.catch(() => undefined)
  return next
}

let projectionWatch: (() => void) | undefined
function stopProjectionWatch(): void {
  const stop = projectionWatch
  projectionWatch = undefined
  stop?.()
}

/** A live binding outlives transient picker/Popover mounts. */
function ensureProjectionWatch(): void {
  if (projectionWatch) return
  const identity = managedDesktopIdentityScope(LOCAL, stopProjectionWatch)
  try {
    const refresh = () => {
      void reconcileManagedDesktopBindings().catch(() => {
        /* The next Host event or bind retries. */
      })
    }
    const stop = watchManagedDesktopDelegations(LOCAL, refresh)
    const stopAcceptance = watchManagedDesktopAcceptance(LOCAL, refresh)
    projectionWatch = () => {
      stop()
      stopAcceptance()
      identity.dispose()
    }
  } catch (error) {
    identity.dispose()
    throw error
  }
}

export function __resetManagedDesktopBindingsForTesting(): void {
  stopProjectionWatch()
}

export function managedDesktopConnectionId(desktopId: string, generation: number): string {
  return `managed:${desktopId}:${generation}`
}

export function isLiveManagedDesktopDelegation(delegation: ManagedDesktopDelegation): boolean {
  return delegation.state === "live" && delegation.expiresAt > Date.now()
}

function sameGrantee(a: ManagedDesktopDelegation["grantee"], b: ManagedDesktopGrantee): boolean {
  return a.kind === "session" && b.kind === "session"
    ? a.sessionKey === b.sessionKey
    : a.kind === "character" && b.kind === "character" && a.characterId === b.characterId
}

function missingDelegation(): SandboxRuntimeError {
  return new SandboxRuntimeError("placement-unavailable", "managed_delegation_missing")
}

/** Human action only. No connection or target setting exists before the Host grants control. */
export function bindManagedDesktop(input: ManagedDesktopDelegationRequest): Promise<string> {
  return serialize(async (assertActive) => {
    const [desktops, configs] = await Promise.all([
      managedDesktopClient.list(LOCAL),
      managedDesktopClient.listConfigs(LOCAL),
    ])
    assertActive()
    const desktop = desktops.find(
      (item) =>
        item.id === input.desktopId &&
        item.generation === input.generation &&
        item.state === "running"
    )
    const config = configs.find((item) => item.id === desktop?.providerConfigId)
    const capabilities =
      config &&
      managedDesktopCapabilities({
        ...config,
        agentControl: config.enablement.agentControl,
      })
    if (!desktop || !config || !capabilities?.gui) throw missingDelegation()
    const id = managedDesktopConnectionId(desktop.id, desktop.generation)
    const existing = await getSandboxConnection(id)
    assertActive()
    const delegation = await managedDesktopClient.delegate(LOCAL, input)
    assertActive()
    if (
      !isLiveManagedDesktopDelegation(delegation) ||
      delegation.desktopId !== desktop.id ||
      delegation.desktopGeneration !== desktop.generation ||
      delegation.providerConfigId !== config.id ||
      delegation.mode !== "computerUse" ||
      !sameGrantee(delegation.grantee, input.grantee)
    )
      throw missingDelegation()
    const now = Date.now()
    try {
      const row = createSandboxConnectionRow({
        id,
        name: desktop.id,
        driver: "computer-server",
        now,
        config: {
          provider: "e2b",
          target: LOCAL,
          providerConfigId: config.id,
          desktopId: desktop.id,
          generation: desktop.generation,
          delegationId: delegation.id,
          ...{
            operationsQualified: config.operationsQualified === true,
            cpuCount: config.cpuCount,
            memoryMb: config.memoryMb,
          },
          agentControl: config.enablement.agentControl,
          qualification: config.qualification,
          qualificationEvidenceVersion: config.qualificationEvidenceVersion,
          workloadIsolationRevision: config.workloadIsolationRevision,
          egressEnforcement: config.egressEnforcement,
        },
      })
      await putSandboxConnection({
        ...row,
        createdAt: existing?.createdAt ?? now,
        state: "running",
        lastHealthStatus: "ok",
        capabilities,
      })
      assertActive()
      // Catch expiry/revocation that raced the projection write.
      const live = await reconcileNow(assertActive)
      assertActive()
      if (!live.some((item) => item.id === delegation.id)) throw missingDelegation()
      ensureProjectionWatch()
      return id
    } catch (error) {
      // Account changes revoke on the Host; never clean up through a new account's DB.
      assertActive()
      // A failed projection must not leave newly delegated control behind.
      if (existing?.config.provider !== "e2b" || existing.config.delegationId !== delegation.id)
        await managedDesktopClient.revokeDelegation(LOCAL, delegation.id, delegation.revision)
      assertActive()
      // Another grantee may already use the same desktop routing id.
      await reconcileNow(assertActive)
      throw error
    }
  })
}

/** Revoke this grantee before deleting its projection. A failed revoke leaves the target intact. */
export function unbindManagedDesktop(
  connectionId: string,
  grantee: ManagedDesktopGrantee
): Promise<void> {
  return serialize(async (assertActive) => {
    if (!connectionId.startsWith("managed:")) return
    const { delegations } = await managedDesktopClient.listDelegations(LOCAL)
    assertActive()
    for (const delegation of delegations) {
      if (
        isLiveManagedDesktopDelegation(delegation) &&
        sameGrantee(delegation.grantee, grantee) &&
        managedDesktopConnectionId(delegation.desktopId, delegation.desktopGeneration) ===
          connectionId
      ) {
        await managedDesktopClient.revokeDelegation(LOCAL, delegation.id, delegation.revision)
        assertActive()
      }
    }
    await reconcileNow(assertActive)
  })
}

async function reconcileNow(assertActive: () => void): Promise<ManagedDesktopDelegation[]> {
  const { delegations } = await managedDesktopClient.listDelegations(LOCAL)
  assertActive()
  const live = delegations.filter(isLiveManagedDesktopDelegation)
  const rows = await listSandboxConnections()
  const configsNow = live.length ? await managedDesktopClient.listConfigs(LOCAL) : []
  assertActive()
  // Acceptance grants are created by the Host runner, never by bindManagedDesktop.
  // Project them on discovery so the child can use the existing routing registry.
  const acceptance = live.filter(
    (item) => item.mode === "acceptance" && item.grantee.kind === "acceptance"
  )
  if (acceptance.length) {
    const [desktops, configs] = await Promise.all([
      managedDesktopClient.list(LOCAL),
      managedDesktopClient.listConfigs(LOCAL),
    ])
    assertActive()
    for (const grant of acceptance) {
      const desktop = desktops.find(
        (d) =>
          d.id === grant.desktopId &&
          d.generation === grant.desktopGeneration &&
          d.state === "running"
      )
      const config = configs.find((c) => c.id === grant.providerConfigId)
      const capabilities =
        config &&
        managedDesktopCapabilities({ ...config, agentControl: config.enablement.acceptance })
      if (!desktop || !config || !capabilities?.gui || desktop.providerConfigId !== config.id)
        continue
      const id = managedDesktopConnectionId(desktop.id, desktop.generation)
      const existing = rows.find((row) => row.id === id)
      const row = createSandboxConnectionRow({
        id,
        name: desktop.id,
        driver: "computer-server",
        now: Date.now(),
        config: {
          provider: "e2b",
          target: LOCAL,
          providerConfigId: config.id,
          desktopId: desktop.id,
          generation: desktop.generation,
          delegationId: grant.id,
          ...{
            operationsQualified: config.operationsQualified === true,
            cpuCount: config.cpuCount,
            memoryMb: config.memoryMb,
          },
          agentControl: config.enablement.acceptance,
          qualification: config.qualification,
          qualificationEvidenceVersion: config.qualificationEvidenceVersion,
          workloadIsolationRevision: config.workloadIsolationRevision,
          egressEnforcement: config.egressEnforcement,
        },
      })
      await putSandboxConnection({
        ...row,
        createdAt: existing?.createdAt ?? row.createdAt,
        state: "running",
        lastHealthStatus: "ok",
        capabilities,
      })
      assertActive()
    }
  }
  let retained = false
  for (const row of rows) {
    assertActive()
    if (row.config.provider !== "e2b" || !row.id.startsWith("managed:")) continue
    const config = row.config
    const current =
      config.target.kind === "local" &&
      live.find(
        (item) =>
          item.desktopId === config.desktopId &&
          item.desktopGeneration === config.generation &&
          item.providerConfigId === config.providerConfigId &&
          row.id === managedDesktopConnectionId(item.desktopId, item.desktopGeneration)
      )
    if (!current) await deleteSandboxConnection(row.id)
    // Several grantees can share the routing id. Keep a live representative
    // when one grantee revokes; runtime authorization still checks the caller.
    else {
      retained = true
      const hostConfig = configsNow.find((item) => item.id === current.providerConfigId)
      const projection = {
        ...config,
        delegationId: current.id,
        operationsQualified: hostConfig?.operationsQualified === true,
        cpuCount: hostConfig?.cpuCount,
        memoryMb: hostConfig?.memoryMb,
        agentControl:
          current.mode === "acceptance"
            ? hostConfig?.enablement.acceptance === true
            : hostConfig?.enablement.agentControl === true,
        qualification: hostConfig?.qualification ?? "unqualified",
        qualificationEvidenceVersion: hostConfig?.qualificationEvidenceVersion,
        workloadIsolationRevision: hostConfig?.workloadIsolationRevision,
        egressEnforcement: hostConfig?.egressEnforcement ?? "unverified",
      }
      await putSandboxConnection({
        ...row,
        config: projection,
        capabilities: managedDesktopCapabilities(projection),
      })
    }
  }
  assertActive()
  if (retained || acceptance.length) ensureProjectionWatch()
  else stopProjectionWatch()
  return live
}

/** Fetch inside the projection queue, never apply a possibly stale event snapshot. */
export async function reconcileManagedDesktopBindings(): Promise<ManagedDesktopDelegation[]> {
  return serialize(reconcileNow)
}

/** Mounted by target pickers; runtime checks also reconcile before every managed call. */
export function watchManagedDesktopBindings(
  onError: (error: unknown) => void = () => {}
): () => void {
  const refresh = () => {
    void reconcileManagedDesktopBindings().catch(onError)
  }
  const stop = watchManagedDesktopDelegations(LOCAL, refresh, onError)
  const stopAcceptance = watchManagedDesktopAcceptance(LOCAL, refresh, onError)
  return () => {
    stop()
    stopAcceptance()
  }
}

/** Host truth, including the bound grantee; never borrow another session's delegation. */
export async function requireManagedDesktopDelegation(
  row: SandboxConnectionRow,
  sessionKey: string,
  characterId?: string
): Promise<void> {
  if (row.config.provider !== "e2b") return
  const config = row.config
  if (
    config.target.kind !== "local" ||
    !config.desktopId ||
    !config.delegationId ||
    config.generation === undefined ||
    row.id !== managedDesktopConnectionId(config.desktopId, config.generation)
  )
    throw missingDelegation()
  await serialize(async (assertActive) => {
    const live = await reconcileNow(assertActive)
    const acceptanceGrants = live.filter(
      (item) => item.mode === "acceptance" && item.grantee.kind === "acceptance"
    )
    const runs = acceptanceGrants.length
      ? (await managedDesktopHandoffClient.acceptanceList(LOCAL)).runs
      : []
    // The Host never returns a child session key. A session is the child of a
    // run only if it was created for that run; the Host re-checks the key on
    // every desktop operation.
    const attachedTo = acceptanceGrants.length
      ? (await getSession(sessionKey))?.managedAcceptance?.acceptanceId
      : undefined
    assertActive()
    if (
      !live.some(
        (item) =>
          item.desktopId === config.desktopId &&
          item.desktopGeneration === config.generation &&
          item.providerConfigId === config.providerConfigId &&
          ((item.mode === "acceptance" &&
            item.grantee.kind === "acceptance" &&
            runs.some(
              (run) =>
                item.grantee.kind === "acceptance" &&
                run.acceptanceId === item.grantee.acceptanceId &&
                run.state === "running" &&
                run.childAttached &&
                attachedTo === run.acceptanceId &&
                run.delegationId === item.id &&
                run.desktopId === item.desktopId &&
                run.desktopGeneration === item.desktopGeneration &&
                run.providerConfigId === item.providerConfigId
            )) ||
            (item.mode === "computerUse" &&
              item.grantee.kind === "session" &&
              item.grantee.sessionKey === sessionKey) ||
            (item.grantee.kind === "character" &&
              !!characterId &&
              item.grantee.characterId === characterId))
      )
    )
      throw missingDelegation()
    assertActive()
    ensureProjectionWatch()
  }).catch(() => {
    throw missingDelegation()
  })
}
