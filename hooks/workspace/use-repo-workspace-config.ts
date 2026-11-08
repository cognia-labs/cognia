"use client"

/**
 * The repository configuration a workspace is currently seeing, and the one
 * control that changes it.
 *
 * Approval is a decision only a person can make, so it needs a surface. This is
 * the read side of `lib/project-environment/workspace-config-trust`, wired to
 * the workspace list and the settings store so a panel can render the verdict
 * without re-deriving trust for itself — the failure mode being a panel that
 * says "approved" while the runtime says "restricted".
 *
 * It re-reads after approving rather than assuming success: the file can change
 * between the render and the click, and silently approving a digest the user
 * never looked at is the whole thing this gate exists to prevent.
 *
 * It does not try a read this runtime cannot make. A browser with no paired
 * host has no filesystem to read `.cognia/workspace.json` from; trying anyway
 * produced an "invalid: tauri-only command" verdict, which read as a broken
 * repository and lit the Environments tab's attention dot. The read is gated
 * per command (`useWorkspaceCommandGate`, as the worktree list is), and a
 * refusal is `unavailable` with the sentence that says why, not a verdict
 * about the file.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  useWorkspaceCommandGate,
  type WorkspaceCommandGate,
} from "@/hooks/workspace/use-workspace-command-gate"

import {
  approveWorkspaceConfig as persistApproval,
  getTrustedWorkspace,
  recordSeededDeclarations,
  type TrustedWorkspace,
} from "@/lib/db/trusted-workspaces"
import {
  approvalKeyFor,
  evaluateWorkspaceConfig,
  verdictNeedsAttention,
  type EvaluateWorkspaceConfigDeps,
  type WorkspaceConfigVerdict,
} from "@/lib/project-environment/workspace-config-trust"
import type { WorkspaceRepositoryConfigV1 } from "@/lib/project-environment/workspace-config"
import { declaredWorkspaceOf, seedDeclarations } from "@/lib/workspace/repo-declared"
import { additionalDirsOf } from "@/lib/workspace/roots"
import { isTauri } from "@/lib/tauri"
import type { Project } from "@/types"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface RepoWorkspaceConfigState {
  verdict: WorkspaceConfigVerdict
  /**
   * Why the file cannot be read from this runtime, or null when it can. While
   * set, `verdict` is a placeholder (`absent`) that says nothing about the
   * repository, and nothing was read.
   */
  unavailable: string | null
  loading: boolean
  approving: boolean
  /** Absolute path the approval is recorded against, or null. */
  approvalKey: string | null
  /** Record approval of the digest currently on screen. */
  approve: () => Promise<void>
  refresh: () => void
}

export interface UseRepoWorkspaceConfigDeps extends Partial<EvaluateWorkspaceConfigDeps> {
  approve: (path: string, digest: string, config?: WorkspaceRepositoryConfigV1) => Promise<boolean>
  /** Whether this runtime can read the file. Production asks the command gate. */
  readGate: WorkspaceCommandGate
  /** The trust row, for the declarations already offered on this device. */
  trustRecord: (path: string) => Promise<TrustedWorkspace | undefined>
  /** Persist the seeded set. Written together with the workspace change. */
  recordSeeded: (path: string, seeded: readonly string[]) => Promise<boolean>
  /** Apply the seeded roots and capability overlay to the workspace row. */
  applyToWorkspace: (projectId: string, patch: Partial<Project>) => void
}

const LOADING: WorkspaceConfigVerdict = { kind: "absent" }

export interface UseRepoWorkspaceConfigOptions {
  /**
   * Another repository of the workspace, whose file is read and approved at
   * its own root (ADR-0147, 2026-11-08 amendment). Absent is the workspace's
   * primary repository and its existing approval.
   */
  approvalRoot?: string | null
}

export function useRepoWorkspaceConfig(
  projectId: string | null | undefined,
  executionRoot: string | null | undefined,
  deps?: Partial<UseRepoWorkspaceConfigDeps>,
  options?: UseRepoWorkspaceConfigOptions
): RepoWorkspaceConfigState {
  const projects = useProjectStore((state) => state.projects)
  const trustEnabled = useSettingsStore(
    (state) => state.settings?.workspaceTrust?.enabled !== false
  )
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId]
  )

  const [nonce, setNonce] = useState(0)
  const approvalRoot = options?.approvalRoot?.trim() || null
  const approvalKey = useMemo(() => approvalKeyFor(project, approvalRoot), [project, approvalRoot])
  const gate = useWorkspaceCommandGate()
  const readGate = deps?.readGate ?? gate("fs_read_workspace_file")
  const unavailable = readGate.available ? null : readGate.reason

  // Everything the verdict depends on, as one string. The read is asynchronous,
  // so `loading` is derived from "the settled answer is for a different key"
  // rather than set at the top of an effect — a synchronous setState there
  // costs a cascading render and the lint rule that forbids it is right.
  const requestKey = useMemo(
    () =>
      [
        executionRoot ?? "",
        approvalRoot ?? "",
        trustEnabled ? "1" : "0",
        (project?.roots ?? []).map((root) => root.path).join(","),
        nonce,
      ].join("|"),
    [executionRoot, approvalRoot, trustEnabled, project, nonce]
  )

  const [settled, setSettled] = useState<{ key: string; verdict: WorkspaceConfigVerdict } | null>(
    null
  )
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    // Nothing to read from here. `unavailable` already says so; returning
    // without a setState keeps this effect off the cascading-render path.
    if (unavailable !== null) return
    let cancelled = false
    void evaluateWorkspaceConfig(
      {
        configRoot: executionRoot,
        project,
        ...(approvalRoot ? { approvalRoot } : {}),
        trustEnabled,
        onWeb: !isTauri(),
      },
      deps
    )
      .then((next) => {
        if (!cancelled) setSettled({ key: requestKey, verdict: next })
      })
      .catch((cause) => {
        if (cancelled) return
        // A panel that shows nothing when the read fails is how a user
        // concludes the repository ships no configuration at all.
        setSettled({
          key: requestKey,
          verdict: {
            kind: "invalid",
            message: cause instanceof Error ? cause.message : String(cause),
            field: "workspace.json",
          },
        })
      })
    return () => {
      cancelled = true
    }
    // `deps` is a test seam and stable in production; including it would make
    // an inline object re-read on every render. `requestKey` covers the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, unavailable])

  const fresh = settled?.key === requestKey
  const verdict = unavailable === null && fresh ? settled.verdict : LOADING
  const loading = unavailable === null && !fresh

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const approve = useCallback(async () => {
    if (verdict.kind !== "unapproved" || !approvalKey || !project) return
    setApproving(true)
    try {
      const persist = deps?.approve ?? persistApproval
      // The content goes with the digest, so the next change can be shown
      // as a change against exactly what was approved here.
      await persist(approvalKey, verdict.digest, verdict.config)
      // Another repository's file reaches its own worktrees only (its
      // provisioning and `dependsOn`). Its roots and capabilities would land
      // on the whole workspace, and its root ids could collide with the
      // primary's seeded ones, so nothing is seeded from it.
      if (approvalRoot) return
      // Approval is the moment the user says yes to THIS content, so it is also
      // the moment the repository's non-script declarations take effect. Seeded
      // once and recorded, so removing a seeded root or clearing a seeded
      // capability sticks rather than coming back on the next pull.
      const readTrust = deps?.trustRecord ?? getTrustedWorkspace
      const alreadySeeded = (await readTrust(approvalKey).catch(() => undefined))
        ?.seededDeclarations
      const seed = seedDeclarations({
        declared: declaredWorkspaceOf(verdict.config),
        overlay: project.capabilityOverlay,
        roots: project.roots ?? [],
        alreadySeeded: alreadySeeded ?? [],
        repositoryRoot: approvalKey,
      })
      if (seed.changed) {
        const apply =
          deps?.applyToWorkspace ??
          ((id: string, patch: Partial<Project>) =>
            useProjectStore.getState().updateProject(id, patch))
        apply(project.id, { capabilityOverlay: seed.overlay, roots: seed.roots })
        await (deps?.recordSeeded ?? recordSeededDeclarations)(approvalKey, seed.seeded)
      }
    } finally {
      setApproving(false)
      // Re-read rather than assume: the file can change between render and
      // click, and the panel must never claim an approval the gate would not
      // agree with.
      setNonce((n) => n + 1)
    }
  }, [verdict, approvalKey, approvalRoot, project, deps])

  return { verdict, unavailable, loading, approving, approvalKey, approve, refresh }
}

/**
 * Whether any other root of the workspace has a file waiting for the user
 * (ADR-0147, 2026-11-08 amendment).
 *
 * Until it is approved that repository's worktrees get no provisioning from
 * it, so the surfaces that flag the primary's pending file flag this too. One
 * read per root, at that root and under that root's own approval.
 */
export function useOtherRepositoriesNeedAttention(
  projectId: string | null | undefined,
  deps?: Partial<Pick<UseRepoWorkspaceConfigDeps, "readGate">> &
    Partial<EvaluateWorkspaceConfigDeps>
): boolean {
  const projects = useProjectStore((state) => state.projects)
  const trustEnabled = useSettingsStore(
    (state) => state.settings?.workspaceTrust?.enabled !== false
  )
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId]
  )
  // Every other root may be a repository with a file of its own; one with
  // none reads as absent and asks for nothing.
  const repositories = useMemo(() => (project ? additionalDirsOf(project) : []), [project])
  const gate = useWorkspaceCommandGate()
  const readable = (deps?.readGate ?? gate("fs_read_workspace_file")).available
  const requestKey = useMemo(
    () => [repositories.join(","), trustEnabled ? "1" : "0", readable ? "1" : "0"].join("|"),
    [repositories, trustEnabled, readable]
  )
  const [settled, setSettled] = useState<{ key: string; attention: boolean } | null>(null)

  useEffect(() => {
    if (!readable || repositories.length === 0) return
    let cancelled = false
    void Promise.all(
      repositories.map((root) =>
        evaluateWorkspaceConfig(
          { configRoot: root, approvalRoot: root, project, trustEnabled, onWeb: !isTauri() },
          deps
        ).catch(() => ({ kind: "absent" }) as WorkspaceConfigVerdict)
      )
    ).then((verdicts) => {
      if (!cancelled) {
        setSettled({ key: requestKey, attention: verdicts.some(verdictNeedsAttention) })
      }
    })
    return () => {
      cancelled = true
    }
    // `deps` is a test seam; `requestKey` covers what the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  return readable && repositories.length > 0 && settled?.key === requestKey
    ? settled.attention
    : false
}
