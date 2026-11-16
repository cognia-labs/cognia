/** Host-owned run-tree authority resolution (ADR-0243 phase 3A). */
import {
  meetRunAuthority,
  inheritableRunAuthority,
  type ActingIdentityV1,
  type ExecutionRun,
  type RunAuthorityV1,
} from "@cognia/plugin-contract/types/execution/run"
import { getDb } from "@/lib/db/schema"
import type { SendOptions } from "@cognia/agent-config-types"
import { runAuthorityAllowsMcpServer } from "@cognia/agent-config-types/claude-agent-sdk-options"
import { resolvePermissionProfile } from "@cognia/plugin-contract/types/agent-config/unattended-permission"
import { finalizeToolSurface } from "@/lib/claude/tool-surface-finalizer"
import { canonicalJson } from "@cognia/agent"
import { narrowAuthority } from "@cognia/agent-config-types/agent-composition"
import { subagentKeyMatches } from "@cognia/agent-config-types/agent-capability-grant"
import { appendRunObservation } from "@/lib/db/execution-runs"

export type RunAuthorityRefusal =
  | "parent_not_found"
  | "run_not_found"
  | "authority_unavailable"
  | "identity_mismatch"
  | "authority_persistence_failed"
  | "unsupported_authority"

export class RunAuthorityError extends Error {
  constructor(
    readonly reason: RunAuthorityRefusal,
    detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = "RunAuthorityError"
  }
}

export interface RunAuthorityInput {
  runId?: string
  parentRunId?: string
  /** Adoption must not make this run an ancestor of itself. */
  forbiddenAncestorRunId?: string
  requested?: RunAuthorityV1
  /** Host-read effective caps of the journaled attempt being recovered. */
  recoveryAuthority?: RunAuthorityV1
  /** A requested identity can confirm an inherited identity, never replace it. */
  actingIdentity?: ActingIdentityV1
}

export interface ResolvedRunAuthority {
  authority?: RunAuthorityV1
  /** Ancestors only: a run's own explicit caps are not an inherited ceiling. */
  inheritedAuthority?: RunAuthorityV1
  actingIdentity?: ActingIdentityV1
}

function fixedIdentity(identity: ActingIdentityV1) {
  return canonicalJson([
    identity.rootRunId,
    identity.lane,
    identity.actingPrincipal,
    identity.authorizingPrincipal,
    identity.bindingId,
  ])
}

async function resolveInDatabase(
  db: ReturnType<typeof getDb>,
  input: RunAuthorityInput
): Promise<ResolvedRunAuthority> {
  const read = async (id: string, parent: boolean): Promise<ExecutionRun> => {
    const row = await db.executionRuns.get(id)
    if (!row) throw new RunAuthorityError(parent ? "parent_not_found" : "run_not_found")
    return row
  }
  const run = input.runId ? await read(input.runId, false) : undefined
  if (run && input.parentRunId && run.parentRunId !== input.parentRunId)
    throw new RunAuthorityError("identity_mismatch")
  const parentId = input.parentRunId ?? run?.parentRunId
  const parent = parentId ? await db.executionRuns.get(parentId) : undefined
  if (parentId && !parent && !run) throw new RunAuthorityError("parent_not_found")
  const visited = new Set<string>()
  const missing = new Set<string>()
  if (parentId && !parent) missing.add(parentId)
  let cursor = parent ?? run
  while (cursor) {
    if (cursor.id === input.forbiddenAncestorRunId)
      throw new RunAuthorityError("authority_unavailable", "prospective adoption cycle")
    if (visited.has(cursor.id) || visited.size >= 64)
      throw new RunAuthorityError("authority_unavailable", "cyclic or excessive ancestry")
    visited.add(cursor.id)
    const next = cursor.parentRunId
    cursor = next ? await db.executionRuns.get(next) : undefined
    if (next && !cursor) missing.add(next)
  }
  // The fixed identity root is Host state too, including for legacy rows whose
  // structural ancestry and explicit identity root are different segments.
  let identityOwner = run ?? parent
  const identityVisited = new Set<string>()
  while (identityOwner) {
    if (identityVisited.has(identityOwner.id) || identityVisited.size >= 64)
      throw new RunAuthorityError("authority_unavailable", "invalid identity root")
    identityVisited.add(identityOwner.id)
    const rootId = identityOwner.actingIdentity?.rootRunId
    if (rootId === identityOwner.id || (identityOwner.actingIdentity && !rootId)) break
    const nextId = rootId ?? identityOwner.parentRunId
    if (!nextId) break
    const nextOwner = await db.executionRuns.get(nextId)
    if (!nextOwner) {
      missing.add(nextId)
      identityOwner = parent ?? run
      break
    }
    if (nextOwner.id === input.forbiddenAncestorRunId)
      throw new RunAuthorityError("authority_unavailable", "prospective adoption cycle")
    identityOwner = nextOwner
  }
  const retainedIdentity =
    identityOwner?.actingIdentity ?? parent?.actingIdentity ?? run?.actingIdentity
  const liveIdentity = retainedIdentity
    ? {
        ...retainedIdentity,
        rootRunId: retainedIdentity.rootRunId ?? identityOwner?.id ?? parent?.id ?? run?.id,
      }
    : undefined
  const inheritedIdentity = parent?.actingIdentity ?? run?.actingIdentity
  if (parent && inheritedIdentity && !liveIdentity)
    throw new RunAuthorityError("authority_unavailable", "missing live identity")
  if (liveIdentity && inheritedIdentity && liveIdentity.lane !== inheritedIdentity.lane)
    throw new RunAuthorityError("identity_mismatch")
  const requestedIdentity = input.actingIdentity
  if (parent && requestedIdentity && liveIdentity) {
    const normalized = {
      ...requestedIdentity,
      rootRunId: requestedIdentity.rootRunId ?? liveIdentity.rootRunId,
    }
    if (fixedIdentity(normalized) !== fixedIdentity(liveIdentity))
      throw new RunAuthorityError("identity_mismatch")
  }
  // Each row already records inherited ∧ own caps. Retention of an older
  // ancestor must not be a prerequisite for dispatch or restart.
  let inheritedAuthority = inheritableRunAuthority(parent?.authority)
  const recoveryAuthority = inheritableRunAuthority(
    run?.recoveryAuthority ?? input.recoveryAuthority
  )
  if (recoveryAuthority)
    inheritedAuthority = inheritedAuthority
      ? meetRunAuthority(inheritedAuthority, recoveryAuthority)
      : recoveryAuthority
  const retainedAuthority = inheritableRunAuthority(run?.authority)
  // Re-entry retains the effective caps even if its direct parent was pruned.
  let authority = parentId && !parent ? retainedAuthority : inheritedAuthority
  // A preparation replaces its own caps. Only ancestors constrain a rebuild.
  if (!input.requested && retainedAuthority)
    authority = authority ? meetRunAuthority(authority, retainedAuthority) : retainedAuthority
  if (input.requested) {
    const requested = { ...input.requested, caps: "explicit-v1" as const }
    authority = authority ? meetRunAuthority(authority, requested) : requested
  }
  if (authority) authority = { ...authority, caps: "explicit-v1" }
  if (getDb() !== db) throw new RunAuthorityError("authority_unavailable", "database changed")
  for (const row of [parent, run]) {
    if (!row?.authority || row.authority.caps === "explicit-v1") continue
    await db.transaction("rw", db.executionRuns, db.executionRunEvents, async () => {
      const observed = await db.executionRunEvents
        .where("[runId+seq]")
        .equals([row.id, 0])
        .filter((event) => event.payload.operation === "legacy_authority_observed")
        .first()
      if (!observed)
        await appendRunObservation(row.id, {
          operation: "legacy_authority_observed",
        })
    })
  }
  if (missing.size && (run ?? parent))
    await appendRunObservation(
      (run ?? parent)!.id,
      {
        operation: "ancestor_unavailable",
        missingRunIds: [...missing],
      },
      { throttleMs: 60_000 }
    )
  return {
    ...(authority ? { authority } : {}),
    ...(parentId && !parent && retainedAuthority
      ? { inheritedAuthority: retainedAuthority }
      : inheritedAuthority
        ? { inheritedAuthority }
        : {}),
    ...(liveIdentity ? { actingIdentity: liveIdentity } : {}),
  }
}

/** Resolve only from canonical Host rows. A claimed but unreadable parent refuses. */
export async function resolveRunAuthority(input: RunAuthorityInput): Promise<ResolvedRunAuthority> {
  try {
    return await resolveInDatabase(getDb(), input)
  } catch (error) {
    if (error instanceof RunAuthorityError) throw error
    throw new RunAuthorityError("authority_unavailable")
  }
}

/** Await before dispatch. The stored value is the effective value returned to the engine. */
export async function persistRunAuthority(
  runId: string,
  requested: RunAuthorityV1
): Promise<ResolvedRunAuthority> {
  try {
    const db = getDb()
    return await db.transaction("rw", db.executionRuns, db.executionRunEvents, async () => {
      const resolved = await resolveInDatabase(db, { runId, requested })
      const previous = await db.executionRuns.get(runId)
      const patch = {
        authority: resolved.authority,
      }
      if (canonicalJson(previous?.authority) === canonicalJson(patch.authority)) return resolved
      const updated = await db.executionRuns.update(runId, patch)
      if (!updated || getDb() !== db) throw new RunAuthorityError("authority_persistence_failed")
      return resolved
    })
  } catch (error) {
    if (error instanceof RunAuthorityError) throw error
    throw new RunAuthorityError("authority_persistence_failed")
  }
}

/** Only explicit caps belong in the record; a resolved surface is not a cap. */
export function authorityForSendOptions(options: SendOptions): RunAuthorityV1 {
  return options.runAuthority ?? { schemaVersion: 1 }
}

const hostMcpServerIds = new WeakMap<SendOptions, Readonly<Record<string, string>>>()

/** Host registry/preload only. Serialized option fields cannot reproduce this proof. */
export function setRunAuthorityMcpServerIds(
  options: SendOptions,
  servers: readonly { name: string; id: string }[]
): void {
  const ids = Object.freeze(Object.fromEntries(servers.map((server) => [server.name, server.id])))
  hostMcpServerIds.set(options, ids)
  options.runAuthorityMcpServerIds = ids
}

/** Final clamp, including empty allowlists, after any option override. */
export function applyRunAuthorityToSendOptions(
  options: SendOptions,
  ceiling: RunAuthorityV1
): RunAuthorityV1 {
  const effective = ceiling
  if (!Object.keys(effective).some((key) => !["schemaVersion", "caps"].includes(key)))
    return effective
  const surface = meetRunAuthority(effective, {
    schemaVersion: 1,
    tools: { allow: options.allowedTools, deny: options.disallowedTools },
    permissionProfile: options.permissionProfile,
  })
  if (effective.permissionMode)
    options.permissionMode = narrowAuthority(
      effective.permissionMode,
      options.permissionMode ?? "default"
    )
  if (surface.tools?.allow) options.allowedTools = [...surface.tools.allow]
  if (surface.tools?.deny) options.disallowedTools = [...surface.tools.deny]
  Object.assign(options, finalizeToolSurface(options, undefined))
  if (effective.maxTurns !== undefined)
    options.maxTurns = Math.min(options.maxTurns ?? Infinity, effective.maxTurns)
  if (surface.permissionProfile)
    options.permissionProfile = resolvePermissionProfile(surface.permissionProfile)
  const servers = effective.mcpServers?.only
  if (servers) {
    options.mcpServers = Object.fromEntries(
      Object.entries(options.mcpServers ?? {}).filter(([name, config]) =>
        runAuthorityAllowsMcpServer(name, config, options.runAuthorityMcpServerIds, servers)
      )
    )
    options.strictMcpConfig = true
  }
  if (effective.skills?.only) {
    const nativeTrusted =
      Boolean(options.trustedWorkspaceRoots?.length) &&
      (!options.cwd || options.trustedWorkspaceRoots!.includes(options.cwd)) &&
      (options.additionalDirectories ?? []).every((root) =>
        options.trustedWorkspaceRoots!.includes(root)
      )
    options.settingSources = []
    options.runtimeExtensions = options.runtimeExtensions?.filter(
      (extension) =>
        nativeTrusted &&
        extension.id !== undefined &&
        effective.skills!.only!.includes(extension.id)
    )
    const skills = options.claudeAgentSdk?.skills
    options.claudeAgentSdk = {
      ...options.claudeAgentSdk,
      version: 1,
      skills: !nativeTrusted
        ? []
        : Array.isArray(skills)
          ? skills.filter((id) => effective.skills!.only!.includes(id))
          : [...effective.skills.only],
    }
  }
  if (options.agents) {
    options.agents = Object.fromEntries(
      Object.entries(options.agents)
        .filter(
          ([name]) =>
            !effective.subagents?.only ||
            effective.subagents.only.some((id) => subagentKeyMatches(name, id))
        )
        .map(([name, definition]) => {
          const sub = meetRunAuthority(effective, {
            schemaVersion: 1,
            permissionMode: definition.permissionMode,
            tools: { allow: definition.tools, deny: definition.disallowedTools },
            maxTurns: definition.maxTurns,
          })
          const mcpNames = Object.keys(options.mcpServers ?? {})
          return [
            name,
            {
              ...definition,
              ...(effective.permissionMode
                ? {
                    permissionMode: narrowAuthority(
                      effective.permissionMode,
                      definition.permissionMode ?? "default"
                    ),
                  }
                : {}),
              ...(sub.tools?.allow ? { tools: sub.tools.allow } : {}),
              ...(sub.tools?.deny ? { disallowedTools: sub.tools.deny } : {}),
              ...(sub.maxTurns !== undefined ? { maxTurns: sub.maxTurns } : {}),
              ...(effective.skills?.only
                ? {
                    skills: (definition.skills ?? []).filter((id) =>
                      effective.skills!.only!.includes(id)
                    ),
                  }
                : {}),
              ...(servers
                ? {
                    mcpServers: (definition.mcpServers ?? mcpNames).flatMap((entry) =>
                      typeof entry === "string" &&
                      runAuthorityAllowsMcpServer(
                        entry,
                        options.mcpServers?.[entry],
                        options.runAuthorityMcpServerIds,
                        servers
                      ) &&
                      mcpNames.includes(entry)
                        ? [entry]
                        : []
                    ),
                  }
                : {}),
            },
          ]
        })
    )
    if (options.agent && !options.agents[options.agent]) delete options.agent
  }
  return effective
}

/** Re-resolve at dispatch and persist the same complete ceiling the engine consumes. */
export async function enforceRunAuthorityOnSendOptions(
  runId: string,
  options: SendOptions,
  skillIds?: readonly string[]
): Promise<void> {
  const resolved = await persistRunAuthority(runId, authorityForSendOptions(options))
  if (
    skillIds &&
    resolved.inheritedAuthority?.skills?.only &&
    skillIds.some((id) => !resolved.inheritedAuthority!.skills!.only!.includes(id))
  )
    throw new RunAuthorityError(
      "unsupported_authority",
      "skills.only changed during preparation; rebuild required"
    )
  options.runAuthority = resolved.authority
  options.inheritedRunAuthority = resolved.inheritedAuthority
  if (resolved.inheritedAuthority?.mcpServers?.only) {
    // Adopted/plugin options can carry a forged mapping. Rebuild from Host
    // registry rows before the final clamp; unknown servers have no authority.
    const registryIds = hostMcpServerIds.get(options)
    if (registryIds) options.runAuthorityMcpServerIds = registryIds
    else {
      try {
        const servers = await getDb().mcpServers.toArray()
        setRunAuthorityMcpServerIds(
          options,
          servers.filter((server) => Object.hasOwn(options.mcpServers ?? {}, server.name))
        )
      } catch {
        throw new RunAuthorityError("authority_unavailable", "MCP server identities unavailable")
      }
    }
  }
  if (resolved.inheritedAuthority)
    applyRunAuthorityToSendOptions(options, resolved.inheritedAuthority)
}
