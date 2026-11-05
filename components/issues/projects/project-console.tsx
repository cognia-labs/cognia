"use client"

import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

/**
 * `/projects` — delivery containers.
 *
 * NAMING: these are `IssueProject` rows, not the repo's `Project` (workspace)
 * entity. The route is `/projects` because that is what the user calls them;
 * the workspace lives at `/workspace`. See the invariant block in
 * `types/issues/index.ts` before touching either.
 *
 * This page was a dead end. It rendered a card grid and offered exactly one
 * mutation — binding and unbinding resources. `createIssueProject` was only
 * reachable from the create-issue dialog, and only on the branch that fires
 * when a workspace has NO container; `updateIssueProject` and
 * `deleteIssueProject` had no caller anywhere. The net effect was that a
 * workspace got exactly one container, ever, and none of its eight editable
 * fields could be changed after creation.
 *
 * It is now a master-detail console: a table that can actually be compared
 * across rows, an inspector that writes every field, create and delete.
 *
 * Resources stay reference-only. A `workspace-root` resource points at a root
 * already mounted on the owning workspace — this surface never mounts a
 * directory itself, because that would create a second directory source of
 * truth and bypass `lib/workspace/trust-gate.ts`.
 */

import { useMemo, useState, useSyncExternalStore } from "react"
import {
  getIssueSyncProvidersRevision,
  subscribeIssueSyncProviders,
} from "@/lib/issues/sync/registry"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { FolderIcon, PlusIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { useTrackerHeaderTabs } from "@/components/issues/tracker-tabs"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useClientLiveQuery } from "@/hooks/data"
import { useIssueSyncAvailability } from "../kept-copy-source-state"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects, type IssueProjectUpdatePatch } from "@/lib/db/issue-projects"
import {
  deleteIssueProjectRecord,
  detachProjectResource,
  updateIssueProjectRecord,
} from "@/lib/issues/service"
import { computeProgressFromIssues } from "@/lib/issues/project-progress"
import { isSyncedResource } from "@/lib/issues/sync/bindings"
import { summarizeSync, syncSummaryMessage } from "@/lib/issues/sync/describe"
import { runWorkspaceIssueSync } from "@/lib/issues/sync/runner"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueProject, IssueProjectResource } from "@/types/issues"
import { ProjectResourceDialog } from "../project-resource-dialog"
import { CreateProjectDialog } from "./create-project-dialog"
import { DeleteProjectDialog } from "./delete-project-dialog"
import { ProjectInspector } from "./project-inspector"
import { ProjectTable } from "./project-table"

export interface ProjectConsoleProps {
  /** Deep-linked project (`/projects?id=…`) — static export has no `[id]`. */
  initialSelectedId?: string
}

export function ProjectConsole({ initialSelectedId }: ProjectConsoleProps) {
  const t = useTranslations("issues")
  const trackerTabs = useTrackerHeaderTabs("projects")
  useSyncExternalStore(
    subscribeIssueSyncProviders,
    getIssueSyncProvidersRevision,
    getIssueSyncProvidersRevision
  )
  const router = useRouter()
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId)
  const [resourceForId, setResourceForId] = useState<string | null>(null)
  const [editingResource, setEditingResource] = useState<
    Extract<IssueProjectResource, { kind: "plugin" }> | undefined
  >()
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<IssueProject | null>(null)
  const [syncing, setSyncing] = useState(false)

  /**
   * Mounted directories of the active workspace — the ONLY ones a container may
   * reference. Mounting is `lib/workspace/trust-gate.ts`'s job; this surface
   * never gains a second way in.
   */
  const roots = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId)?.roots ?? [],
    [workspaces, workspaceId]
  )

  const projects = useClientLiveQuery(
    () => (workspaceId ? listIssueProjects({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    [] as IssueProject[]
  )
  const issues = useClientLiveQuery(
    () => (workspaceId ? listIssues({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    []
  )

  /**
   * One pass over the issues the page already holds, rather than one query per
   * container: the same tally (`lib/issues/project-progress.ts`) the issue
   * board's rail uses.
   */
  const progressById = useMemo(
    () =>
      computeProgressFromIssues(
        (projects ?? []).map((project) => project.id),
        issues ?? []
      ),
    [projects, issues]
  )

  const selected = (projects ?? []).find((project) => project.id === selectedId)

  /** Repos bound anywhere in this workspace — a repo may only be bound once. */
  const boundRepos = useMemo(
    () =>
      new Set(
        (projects ?? []).flatMap((project) =>
          project.resources
            .filter((resource) => resource.kind === "github-repo")
            .map((resource) => resource.repoFullName)
        )
      ),
    [projects]
  )
  const resourceTarget = (projects ?? []).find((project) => project.id === resourceForId)
  /** Anything the mirror or the sync engine refreshes: repos, tasklists, Bitables. */
  const hasSyncedBinding = (projects ?? []).some((project) =>
    project.resources.some(isSyncedResource)
  )
  const syncAvailability = useIssueSyncAvailability(projects)

  /**
   * Manual refresh. `full` bypasses the watermark, because the reason a user
   * reaches for this button is almost always that they suspect the incremental
   * path missed something.
   */
  async function syncNow() {
    if (!workspaceId || !syncAvailability.canSync) return
    setSyncing(true)
    try {
      const result = await runWorkspaceIssueSync({
        projectId: workspaceId,
        full: true,
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      })
      const { level, message } = syncSummaryMessage(summarizeSync(result), t)
      toast[level](message)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
    }
  }

  async function patchProject(id: string, patch: IssueProjectUpdatePatch) {
    try {
      await updateIssueProjectRecord(id, patch)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function removeResource(projectId: string, index: number) {
    const project = (projects ?? []).find((candidate) => candidate.id === projectId)
    const resource = project?.resources[index]
    if (!resource) return
    try {
      // Unbinding the last synced resource also retires the background refresh.
      await detachProjectResource(projectId, resource)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      // Also retires the refresh when the container held the last repo binding.
      await deleteIssueProjectRecord(deleteTarget.id)
      if (selectedId === deleteTarget.id) setSelectedId(undefined)
      toast.success(t("projects.deleted", { name: deleteTarget.name }))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <FeaturePageShell
      storageId="issue-projects"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<FolderIcon />}
          title={t("projects.title")}
          description={t("projects.pageDescription")}
          summary={t("projects.summary", { count: (projects ?? []).length })}
          tabs={trackerTabs}
          primaryAction={{
            id: "create",
            label: t("projects.create"),
            icon: PlusIcon,
            onSelect: () => setCreateOpen(true),
            disabled: !workspaceId,
            testId: "project-create-trigger",
          }}
          secondaryActions={[
            {
              id: "sync",
              label: syncAvailability.reason
                ? t(syncAvailability.reason)
                : syncing
                  ? t("sync.running")
                  : t("sync.now"),
              icon: RefreshCwIcon,
              onSelect: () => void syncNow(),
              disabled: !workspaceId || syncing || !hasSyncedBinding || !syncAvailability.canSync,
              testId: "project-sync-now",
            },
          ]}
        />
      }
      rightPane={
        selected
          ? {
              label: t("detail.properties"),
              // Below `lg` the inspector is a Sheet, and an uncontrolled Sheet
              // only opens from its own trigger, so a row click used to
              // highlight the row and show nothing. The pane exists only while
              // something is selected, so "selected" IS "open", and dismissing
              // the overlay is how that window says "done with this row".
              open: true,
              onOpenChange: (open: boolean) => {
                if (!open) setSelectedId(undefined)
              },
              defaultSize: 30,
              minSize: 22,
              maxSize: 46,
              content: (
                <ProjectInspector
                  project={selected}
                  progress={progressById.get(selected.id)}
                  onPatch={(patch) => void patchProject(selected.id, patch)}
                  onClose={() => setSelectedId(undefined)}
                  onAddResource={() => {
                    setEditingResource(undefined)
                    setResourceForId(selected.id)
                  }}
                  onEditResource={(index) => {
                    const resource = selected.resources[index]
                    if (resource?.kind === "plugin") {
                      setEditingResource(resource)
                      setResourceForId(selected.id)
                    }
                  }}
                  onRemoveResource={(index) => void removeResource(selected.id, index)}
                  onRequestDelete={() => setDeleteTarget(selected)}
                  onOpenIssues={() =>
                    router.push(`/issues?project=${encodeURIComponent(selected.id)}`)
                  }
                />
              ),
            }
          : undefined
      }
      centerClassName="min-h-0"
    >
      {(projects ?? []).length === 0 ? (
        <Empty data-testid="project-console-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>{t("projects.empty")}</EmptyTitle>
            <EmptyDescription>{t("projects.emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ProjectTable
          projects={projects ?? []}
          progressById={progressById}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {workspaceId ? (
        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={workspaceId}
          onCreated={(project) => setSelectedId(project.id)}
        />
      ) : null}

      <DeleteProjectDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        project={deleteTarget}
        issueCount={deleteTarget ? (progressById.get(deleteTarget.id)?.total ?? 0) : 0}
        onConfirm={confirmDelete}
      />

      {resourceTarget ? (
        <ProjectResourceDialog
          key={editingResource ? JSON.stringify(editingResource) : "new"}
          initialResource={editingResource}
          open
          onOpenChange={(next) => {
            if (!next) setResourceForId(null)
          }}
          issueProjectId={resourceTarget.id}
          roots={roots}
          boundRepos={boundRepos}
          boundRootIds={
            new Set(
              resourceTarget.resources
                .filter((resource) => resource.kind === "workspace-root")
                .map((resource) => resource.rootId)
            )
          }
        />
      ) : null}
    </FeaturePageShell>
  )
}
