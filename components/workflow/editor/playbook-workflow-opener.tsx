"use client"

/**
 * `/workflows/editor?playbook=<skillId>`: open a skill as a workflow
 * (ADR-0254 §2).
 *
 * A playbook (a skill with `references/flow.yaml`) opens its derived,
 * read-only workflow, compiled first when the stored copy is stale. Any other
 * skill gets a new, ordinary workflow that the Copilot drafts from the skill's
 * text; the person reviews and saves it. Either way the URL is then replaced
 * with the workflow's own `?id=`, so a reload opens the workflow rather than
 * repeating this step. A flow that does not compile is shown with its
 * problems instead.
 */

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { getSkill } from "@/lib/db/skills"
import { createWorkflow } from "@/lib/db/workflows"
import { syncPlaybookWorkflow, type PlaybookWorkflowResult } from "@/lib/playbooks/derived-workflow"
import { queueCopilotRequest } from "@/lib/workflow/editor/copilot-handoff"
import { buildSkillDraftPrompt } from "@/lib/workflow/editor/quick-action-prompts"

type Problem = { code: string; pointer: string; message: string; skillId?: string }

type OpenerState =
  | { kind: "opening" }
  | { kind: "missing" }
  | { kind: "problems"; problems: Problem[] }
  | { kind: "too-many"; limit: number }
  | { kind: "failed"; error: string }

export function workflowEditorHref(workflowId: string): string {
  return `/workflows/editor?id=${encodeURIComponent(workflowId)}`
}

export function PlaybookWorkflowOpener({ skillId }: { skillId: string }) {
  const t = useTranslations("workflows.playbook")
  const router = useRouter()
  const [state, setState] = useState<OpenerState>({ kind: "opening" })
  // Opening may create a draft workflow; a second run of the effect (Strict
  // Mode, a re-render) must not create another.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false
    const settle = (next: OpenerState) => {
      if (!cancelled) setState(next)
    }

    void (async () => {
      try {
        const result: PlaybookWorkflowResult = await syncPlaybookWorkflow(skillId)
        switch (result.status) {
          case "compiled":
          case "current":
            router.replace(workflowEditorHref(result.workflow.id))
            return
          case "not-a-playbook": {
            const skill = await getSkill(skillId)
            if (!skill) return settle({ kind: "missing" })
            const draft = await createWorkflow({
              name: skill.name,
              ...(skill.description ? { description: skill.description } : {}),
            })
            queueCopilotRequest(draft.id, buildSkillDraftPrompt(skill))
            toast.info(t("drafting", { name: skill.name }))
            router.replace(workflowEditorHref(draft.id))
            return
          }
          case "missing":
            return settle({ kind: "missing" })
          case "invalid":
          case "uncompilable":
            return settle({ kind: "problems", problems: result.problems })
          case "too-many-playbooks":
            return settle({ kind: "too-many", limit: result.limit })
        }
      } catch (error) {
        settle({ kind: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router, skillId, t])

  if (state.kind === "opening") {
    return (
      <div
        className="flex h-full w-full items-center justify-center gap-2 text-sm text-muted-foreground"
        data-testid="playbook-opener-opening"
      >
        <Spinner className="size-4" />
        {t("opening")}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6" data-testid="playbook-opener">
      {state.kind === "missing" ? (
        <>
          <h1 className="text-base font-medium">{t("missingTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("missingBody", { skillId })}</p>
        </>
      ) : state.kind === "failed" ? (
        <>
          <h1 className="text-base font-medium">{t("failedTitle")}</h1>
          <p className="text-sm text-muted-foreground">{state.error}</p>
        </>
      ) : (
        <>
          <h1 className="text-base font-medium">{t("problemsTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {state.kind === "too-many"
              ? t("tooManyBody", { limit: state.limit })
              : t("problemsBody")}
          </p>
          {state.kind === "problems" ? (
            <ul className="flex flex-col gap-2 text-sm" data-testid="playbook-opener-problems">
              {state.problems.map((problem, index) => (
                <li key={index} className="rounded-md border px-3 py-2">
                  <div className="font-mono text-xs text-muted-foreground">
                    {problem.skillId && problem.skillId !== skillId ? `${problem.skillId} · ` : ""}
                    {problem.code}
                    {problem.pointer ? ` · ${problem.pointer}` : ""}
                  </div>
                  <div>{problem.message}</div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href="/skills">{t("backToSkills")}</Link>
        </Button>
      </div>
    </div>
  )
}
