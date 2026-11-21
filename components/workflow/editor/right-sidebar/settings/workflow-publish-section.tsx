"use client"

/**
 * WorkflowPublishSection — publish a workflow as a typed callable unit (D5).
 *
 * Publishing reads the SAVED workflow from Dexie, derives the interface from
 * the `trigger.manual` input schema + `io.output` output schema, stamps
 * `workflow.published`, and registers a `kind:"workflow"` skill that exposes
 * the graph as the `wf_run_workflow_typed` tool. Unpublishing reverses both.
 *
 * What gets published is exactly what is saved: unsaved edits are saved first
 * (`saveDraft`), and when an edit lands while that save is in flight nothing
 * is published, because the saved row would not be what the editor shows. The
 * publish gate (`assertWorkflowPublishable`) refuses graphs the Problems panel
 * reports errors for; the refusal is shown here and opens that panel.
 *
 * Version history stays available after unpublishing: the versions are kept,
 * and viewing, exporting or restoring one to the draft does not need an active
 * deployment. Putting a version back into production is its own action.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  publishWorkflow,
  rollbackWorkflow,
  unpublishWorkflow,
} from "@/lib/workflow/publish/publish-workflow"
import { isWorkflowPublishBlockedError } from "@/lib/workflow/publish/publish-validation"
import { getWorkflowDeployment, listWorkflowVersions } from "@/lib/db/workflow-deployments"
import {
  deleteWorkflowVersion,
  exportWorkflowVersion,
  getWorkflowVersionDetails,
  restoreWorkflowVersionToDraft,
  type WorkflowVersionDetails,
} from "@/lib/workflow/versioning/version-workbench"
import type {
  VisualWorkflow,
  WorkflowInterface,
  WorkflowPublication,
} from "@/types/workflow/visual"

export function WorkflowPublishSection({
  workflowId,
  published,
  dirty = false,
  saveDraft,
  onPublicationChange,
  onDraftRestored,
  onPublishBlocked,
}: {
  workflowId: string
  published?: WorkflowPublication
  /** The editor holds edits the saved row does not have. */
  dirty?: boolean
  /** Persist the editor; reports whether an edit landed during the write. */
  saveDraft?: () => Promise<{ editedDuringSave: boolean }>
  onPublicationChange: (
    published?: WorkflowPublication,
    workflowInterface?: WorkflowInterface
  ) => void
  onDraftRestored?: (workflow: VisualWorkflow) => void
  /** The publish gate refused the graph; the host shows where. */
  onPublishBlocked?: () => void
}) {
  const t = useTranslations("workflowEditor.settings.publish")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [versionName, setVersionName] = useState("")
  const [releaseNotes, setReleaseNotes] = useState("")
  const [filter, setFilter] = useState("")
  const [details, setDetails] = useState<WorkflowVersionDetails | null>(null)
  const deployment = useLiveQuery(() => getWorkflowDeployment(workflowId), [workflowId])
  const versions = useLiveQuery(
    async () => (await listWorkflowVersions(workflowId)).sort((a, b) => b.sequence - a.sequence),
    [workflowId]
  )

  /** Show a failure; a publish-gate refusal gets its own copy and the panel. */
  const showFailure = (e: unknown) => {
    if (isWorkflowPublishBlockedError(e)) {
      setError(t("blockedByProblems", { count: e.problems.length }))
      onPublishBlocked?.()
      return
    }
    setError(e instanceof Error ? e.message : String(e))
  }

  const applyPublication = (result: Awaited<ReturnType<typeof publishWorkflow>>, at: number) => {
    onPublicationChange(
      {
        at,
        toolName: result.toolName,
        versionId: result.versionId,
        deploymentId: result.deploymentId,
        deploymentRevision: result.deploymentRevision,
      },
      result.workflowInterface
    )
  }

  const onPublish = async () => {
    setBusy(true)
    setError(null)
    try {
      // Publish what is on screen, never an older saved row: save first, and
      // stop when the editor changed again while that save was writing.
      if (dirty && saveDraft) {
        const saved = await saveDraft()
        if (saved.editedDuringSave) {
          setError(t("changedWhileSaving"))
          return
        }
      }
      const at = Date.now()
      const result = await publishWorkflow(workflowId, at, {
        ...(versionName.trim() ? { versionName: versionName.trim() } : {}),
        ...(releaseNotes.trim() ? { releaseNotes: releaseNotes.trim() } : {}),
      })
      applyPublication(result, at)
      setVersionName("")
      setReleaseNotes("")
    } catch (e) {
      showFailure(e)
    } finally {
      setBusy(false)
    }
  }

  const onShowDetails = async (versionId: string) => {
    setBusy(true)
    setError(null)
    try {
      setDetails(await getWorkflowVersionDetails(workflowId, versionId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRestore = async (versionId: string) => {
    setBusy(true)
    setError(null)
    try {
      const restored = await restoreWorkflowVersionToDraft(workflowId, versionId)
      onDraftRestored?.(restored)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onExport = async (versionId: string, sequence: number) => {
    setBusy(true)
    setError(null)
    try {
      const bundle = await exportWorkflowVersion(workflowId, versionId)
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
      )
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `workflow-${workflowId}-v${sequence}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (versionId: string) => {
    setBusy(true)
    setError(null)
    try {
      await deleteWorkflowVersion(workflowId, versionId)
      setDetails(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const hasVersions = (versions?.length ?? 0) > 0
  // Only an active production pointer has a "current" version; after
  // unpublishing, the disabled deployment still names the last one.
  const activeVersionId =
    published && deployment?.status === "active" ? deployment.versionId : undefined

  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const filteredVersions = versions?.filter((version) => {
    if (!normalizedFilter) return true
    return [
      version.id,
      String(version.sequence),
      version.versionName,
      version.releaseNotes,
      version.createdBy,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedFilter))
  })

  const onRollback = async (versionId: string, at: number) => {
    setBusy(true)
    setError(null)
    try {
      const result = await rollbackWorkflow(workflowId, versionId, at)
      applyPublication(result, at)
    } catch (e) {
      showFailure(e)
    } finally {
      setBusy(false)
    }
  }

  const onUnpublish = async () => {
    setBusy(true)
    setError(null)
    try {
      await unpublishWorkflow(workflowId)
      onPublicationChange(undefined, undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="workflow-publish-section">
      <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
      <div className="space-y-1.5">
        <Input
          value={versionName}
          onChange={(event) => setVersionName(event.target.value)}
          placeholder={t("versionNamePlaceholder")}
          aria-label={t("versionName")}
        />
        <Textarea
          value={releaseNotes}
          onChange={(event) => setReleaseNotes(event.target.value)}
          placeholder={t("releaseNotesPlaceholder")}
          aria-label={t("releaseNotes")}
          rows={3}
        />
      </div>
      {published ? (
        <div className="space-y-2">
          <p className="text-xs">
            {t("publishedAs")}{" "}
            <code className="rounded bg-muted px-1 py-0.5">{published.toolName}</code>
          </p>
          {deployment ? (
            <p className="text-[11px] text-muted-foreground" data-testid="deployment-summary">
              {t("deploymentSummary", {
                sequence:
                  versions?.find((version) => version.id === deployment.versionId)?.sequence ?? 0,
                revision: deployment.revision,
                status: deployment.status,
              })}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onPublish} disabled={busy}>
              {t("republish")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onUnpublish} disabled={busy}>
              {t("unpublish")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {hasVersions ? (
            <p className="text-[11px] text-muted-foreground" data-testid="workflow-not-published">
              {t("notPublished")}
            </p>
          ) : null}
          <Button
            size="sm"
            onClick={onPublish}
            disabled={busy}
            data-testid="workflow-publish-button"
          >
            {t("publish")}
          </Button>
        </div>
      )}
      {hasVersions ? (
        <div className="space-y-1" data-testid="workflow-version-history">
          <p className="text-[11px] font-medium">{t("versionHistory")}</p>
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("filterPlaceholder")}
            aria-label={t("filter")}
          />
          {filteredVersions?.map((version) => {
            const current = activeVersionId === version.id
            return (
              <div key={version.id} className="space-y-1 rounded border px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {version.versionName ||
                      t("versionRow", {
                        sequence: version.sequence,
                        date: new Date(version.createdAt).toLocaleString(),
                      })}
                  </span>
                  {current ? <span className="text-muted-foreground">{t("current")}</span> : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() => void onShowDetails(version.id)}
                  >
                    {t("details")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() => void onRestore(version.id)}
                  >
                    {t("restoreDraft")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() => void onExport(version.id, version.sequence)}
                  >
                    {t("export")}
                  </Button>
                  {!current ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy}
                      onClick={() => void onRollback(version.id, Date.now())}
                    >
                      {published ? t("rollback") : t("publishVersion")}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
          {filteredVersions?.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("noVersions")}</p>
          ) : null}
          {details ? (
            <div
              className="space-y-1.5 rounded border bg-muted/30 p-2"
              data-testid="version-details"
            >
              <p className="font-medium">
                {details.version.versionName ||
                  t("unnamedVersion", { sequence: details.version.sequence })}
              </p>
              {details.version.releaseNotes ? <p>{details.version.releaseNotes}</p> : null}
              <p className="break-all text-muted-foreground">
                {t("digest", { digest: details.version.digest })}
              </p>
              <p className="text-muted-foreground">
                {t("versionComposition", {
                  nodes: details.version.definition.nodes.length,
                  dependencies: details.version.dependencyManifest.workflows.length,
                  secrets: details.version.configDefinition.secretRefs.length,
                })}
              </p>
              <p className="text-muted-foreground">
                {t("versionAuthor", {
                  author: details.version.createdBy || t("unknownAuthor"),
                  date: new Date(details.version.createdAt).toLocaleString(),
                })}
              </p>
              {details.deleteBlockers.length > 0 ? (
                <p className="text-muted-foreground">
                  {t("deleteBlocked", { reasons: details.deleteBlockers.join(", ") })}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-[11px]"
                disabled={busy || !details.deletable}
                onClick={() => void onDelete(details.version.id)}
              >
                {t("deleteVersion")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}
