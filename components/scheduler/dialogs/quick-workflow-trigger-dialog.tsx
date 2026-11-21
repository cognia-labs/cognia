"use client"

/**
 * QuickWorkflowTriggerDialog — lightweight modal that adds a `trigger.cron`
 * node to an existing workflow's DRAFT without opening the full editor.
 * Workflow combobox + cron expression + timezone select.
 *
 * What runs is the published version, so the new schedule starts only once
 * the workflow is published; the dialog says so and the Scheduler lists the
 * trigger as awaiting publish until then (WF-07). It used to register the
 * draft natively, arming a cron that admission then refused (no such node in
 * the active version) or ran against the older graph. Publishing from here
 * is deliberately not offered: it would also ship every other unpublished
 * edit in the draft.
 *
 * Out of scope: editing existing triggers (use the workflow editor for
 * anything more involved); non-cron trigger kinds.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TimezoneSelect } from "../timezone-select"
import { getDb } from "@/lib/db/schema"
import { updateWorkflow } from "@/lib/db/workflows"
import { isWorkflowReadOnly } from "@/lib/workflow/definition/read-only"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

// Cron presets that align with the scheduler's BackupScheduleDialog visual
// pattern — copied (not extracted) per the plan; the two call sites diverge
// enough that a shared component isn't worth the extraction.
const CRON_PRESETS: Array<{ id: string; expression: string; labelKey: string }> = [
  { id: "every-hour", expression: "0 * * * *", labelKey: "hourly" },
  { id: "daily-9am", expression: "0 9 * * *", labelKey: "daily" },
  { id: "weekly-mon-9am", expression: "0 9 * * 1", labelKey: "weeklyMon" },
  { id: "custom", expression: "", labelKey: "custom" },
]

export interface QuickWorkflowTriggerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Invoked after a trigger is created. */
  onCreated?: (workflowId: string, triggerId: string) => void
  /** Override for `getDb()` — tests inject a stub. */
  db?: ReturnType<typeof getDb>
  /**
   * Save the draft's new node list. Defaults to `updateWorkflow`, the
   * ordinary draft-edit path (read-only refusal, publication preserved,
   * deployed-trigger projection). Tests and stories inject a spy.
   */
  saveDraft?: (workflowId: string, nodes: WorkflowNode[]) => Promise<unknown>
  /** Override for the unique id generator — tests inject a deterministic one. */
  newNodeId?: () => string
}

/**
 * Workflows the dialog may add a trigger to. A workflow compiled from a
 * playbook is read-only (ADR-0254): a trigger added here would be lost on the
 * next compile, so it is left out.
 */
export function selectableWorkflows(workflows: VisualWorkflow[]): VisualWorkflow[] {
  return workflows.filter((wf) => !isWorkflowReadOnly(wf))
}

/** The draft's node list with one new `trigger.cron` node appended. */
export function withCronTriggerNode(
  workflow: Pick<VisualWorkflow, "nodes">,
  input: { triggerId: string; cron: string; timezone: string; label: string }
): WorkflowNode[] {
  const node: WorkflowNode = {
    id: input.triggerId,
    type: "trigger.cron",
    typeVersion: 1,
    position: { x: 100, y: 100 + workflow.nodes.length * 80 },
    data: { label: input.label, params: { cron: input.cron.trim(), timezone: input.timezone } },
  }
  return [...workflow.nodes, node]
}

export function QuickWorkflowTriggerDialog({
  open,
  onOpenChange,
  onCreated,
  db,
  saveDraft,
  newNodeId,
}: QuickWorkflowTriggerDialogProps) {
  const t = useTranslations("scheduler")
  const save =
    saveDraft ??
    ((workflowId: string, nodes: WorkflowNode[]) => updateWorkflow(workflowId, { nodes }))
  const idGen =
    newNodeId ??
    (() => "trigger_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))

  const workflows = useLiveQuery(async () => {
    const realDb = db ?? getDb()
    return selectableWorkflows(await realDb.workflows.toArray())
  }, [open])

  const [workflowId, setWorkflowId] = useState<string>("")
  const [presetId, setPresetId] = useState<string>("daily-9am")
  const [cron, setCron] = useState<string>("0 9 * * *")
  const [timezone, setTimezone] = useState<string>("UTC")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Reset on open transition. React's "adjust state during render" pattern —
  // safer than useEffect+setState (which the lint rule blocks because effect
  // setState triggers an extra render).
  const [openSnapshot, setOpenSnapshot] = useState(open)
  if (open !== openSnapshot) {
    setOpenSnapshot(open)
    if (open) {
      setError(null)
      setSubmitting(false)
    }
  }

  const selectedPreset = useMemo(
    () => CRON_PRESETS.find((p) => p.id === presetId) ?? CRON_PRESETS[0],
    [presetId]
  )

  const handlePresetChange = (id: string) => {
    setPresetId(id)
    const preset = CRON_PRESETS.find((p) => p.id === id)
    if (preset && preset.expression) setCron(preset.expression)
  }

  async function handleSubmit() {
    if (!workflowId) {
      setError(t("pickAWorkflow") || "Pick a workflow")
      return
    }
    if (!cron.trim()) {
      setError(t("cronRequired") || "Cron expression required")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const realDb = db ?? getDb()
      const workflow = await realDb.workflows.get(workflowId)
      if (!workflow) {
        setError(t("workflowNotFound") || "Workflow not found")
        return
      }
      if (isWorkflowReadOnly(workflow)) {
        setError(t("workflowReadOnly"))
        return
      }
      const triggerId = idGen()
      await save(
        workflowId,
        withCronTriggerNode(workflow, {
          triggerId,
          cron,
          timezone,
          label: t("cronTriggerLabel") || "Cron trigger",
        })
      )
      // Saved to the draft only: say plainly that nothing fires until a publish.
      toast.success(t("workflowTriggerAddedAwaitingPublish", { name: workflow.name }))
      onCreated?.(workflowId, triggerId)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid="quick-workflow-trigger-dialog">
        <DialogHeader>
          <DialogTitle>{t("quickCreateWorkflowTrigger") || "Create workflow trigger"}</DialogTitle>
          <DialogDescription>
            {t("quickCreateWorkflowTriggerDescription") ||
              "Add a cron trigger to an existing workflow without leaving the scheduler."}{" "}
            {t("quickCreateWorkflowTriggerPublishNote")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs" htmlFor="qwt-workflow">
              {t("workflow") || "Workflow"}
            </Label>
            <Select value={workflowId} onValueChange={setWorkflowId}>
              <SelectTrigger id="qwt-workflow" data-testid="qwt-workflow-trigger">
                <SelectValue placeholder={t("pickWorkflow") || "Pick a workflow"} />
              </SelectTrigger>
              <SelectContent>
                {workflows?.map((wf) => (
                  <SelectItem key={wf.id} value={wf.id} data-testid={`qwt-workflow-${wf.id}`}>
                    {wf.name ?? wf.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">{t("schedule") || "Schedule"}</Label>
            <Select value={presetId} onValueChange={handlePresetChange}>
              <SelectTrigger data-testid="qwt-preset-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {t(`cronPreset.${preset.labelKey}`) || preset.labelKey}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedPreset.id === "custom" || !selectedPreset.expression ? (
            <div>
              <Label className="text-xs" htmlFor="qwt-cron">
                {t("cronExpression") || "Cron expression"}
              </Label>
              <Input
                id="qwt-cron"
                data-testid="qwt-cron-input"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * *"
              />
            </div>
          ) : (
            <p
              className="rounded bg-muted px-2 py-1 text-[11px] font-mono text-muted-foreground"
              data-testid="qwt-cron-resolved"
            >
              {cron}
            </p>
          )}

          <div>
            <Label className="text-xs">{t("timezone") || "Timezone"}</Label>
            <TimezoneSelect value={timezone} onValueChange={setTimezone} />
          </div>

          {error && (
            <p className="text-xs text-red-500" data-testid="qwt-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("cancel") || "Cancel"}
          </Button>
          <Button
            data-testid="qwt-submit"
            disabled={submitting || !workflowId}
            onClick={() => void handleSubmit()}
          >
            {submitting ? t("creating") || "Creating…" : t("create") || "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
