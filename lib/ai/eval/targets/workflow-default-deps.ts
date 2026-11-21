/**
 * Real desktop wiring for the Visual Workflow eval target. Loads the workflow
 * definition, drives `runWorkflow` with the case's `inputVars` as a manual
 * trigger payload, threading the run-scoped `traceId` so AI nodes emit their
 * LLM spans under it. Spans are read back by trace via `queryByTrace`.
 */

import { queryByTrace } from "@/lib/db/agent-traces"
import type { WorkflowTargetDeps } from "./workflow"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"
import Dexie from "dexie"

export function defaultWorkflowTargetDeps(scope?: EvalPersistenceScope): WorkflowTargetDeps {
  return {
    async runWorkflow({ workflowId, versionId, payload, traceId, signal }) {
      const assertActive = () => {
        scope?.assertActive()
        signal?.throwIfAborted()
      }
      assertActive()
      const [{ getWorkflow }, { getWorkflowVersion }, { runWorkflow }, { readFreshWorkflow }] =
        await Promise.all([
          import("@/lib/db/workflows"),
          import("@/lib/db/workflow-deployments"),
          import("@/lib/workflow/runtime/orchestrator"),
          import("@/lib/workflow/library/fresh-workflow"),
        ])
      assertActive()
      const version = versionId
        ? await (scope ? scope.db.workflowVersions.get(versionId) : getWorkflowVersion(versionId))
        : undefined
      assertActive()
      if (versionId && (!version || version.workflowId !== workflowId)) {
        throw new Error(
          `eval workflow target: version "${versionId}" does not belong to workflow "${workflowId}"`
        )
      }
      let workflow = version?.definition
      if (!workflow) {
        // A playbook-derived draft is evaluated as its playbook compiles now,
        // the same freshness every other runner applies (ADR-0254 §2).
        const fresh = await readFreshWorkflow(workflowId, {
          readWorkflow: (id) => (scope ? scope.db.workflows.get(id) : getWorkflow(id)),
          beforeWrite: assertActive,
        })
        assertActive()
        if (fresh.status === "not-found") {
          throw new Error(`eval workflow target: workflow "${workflowId}" not found`)
        }
        if (fresh.status === "source-unavailable") {
          throw new Error(
            `eval workflow target: workflow "${workflowId}" follows playbook "${fresh.workflow.derivedFrom?.skillId ?? workflowId}", which no longer compiles`
          )
        }
        if (fresh.dormantSteps > 0) {
          throw new Error(
            `eval workflow target: workflow "${workflowId}" has ${fresh.dormantSteps} playbook step(s) this version cannot run`
          )
        }
        workflow = fresh.workflow
      }
      const result = await runWorkflow({
        workflow,
        trigger: {
          workflowId,
          kind: "trigger.manual",
          payload,
          originAt: Date.now(),
        },
        traceId,
        ...(signal ? { signal } : {}),
      })
      assertActive()
      return {
        runId: result.runId,
        status: result.status,
        output: result.output,
        traceId,
      }
    },
    async fetchSpansByTrace(traceId: string) {
      scope?.assertActive()
      const spans = await (scope
        ? scope.db.agentTraces
            .where("[traceId+startTime]")
            .between([traceId, Dexie.minKey], [traceId, Dexie.maxKey])
            .toArray()
        : queryByTrace(traceId))
      scope?.assertActive()
      return spans
    },
  }
}
