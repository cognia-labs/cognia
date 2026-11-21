/** @jest-environment node */

/**
 * Smoke test for the quick-workflow-trigger dialog. The full render path
 * pulls in Dexie + TimezoneSelect + Radix Select internals; the heavy
 * machinery would push Jest workers over the heap limit (mirrors the
 * unified-task-detail-view test's smoke-only approach).
 */

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/lib/db/workflows", () => ({
  updateWorkflow: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))
jest.mock("../timezone-select", () => ({
  TimezoneSelect: () => null,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Top-level import (replaces require() — eslint forbids require-style).
import * as mod from "./quick-workflow-trigger-dialog"
import type { VisualWorkflow } from "@/types/workflow/visual"

describe("QuickWorkflowTriggerDialog module", () => {
  it("exports a function component named QuickWorkflowTriggerDialog", () => {
    expect(typeof mod.QuickWorkflowTriggerDialog).toBe("function")
  })

  it("appends one cron node with the selected timezone to the draft graph only", () => {
    const existing = {
      id: "n_manual",
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "manual", params: {} },
    }
    const nodes = mod.withCronTriggerNode({ nodes: [existing] } as unknown as VisualWorkflow, {
      triggerId: "trigger-1",
      cron: " 0 9 * * * ",
      timezone: "Asia/Shanghai",
      label: "Cron trigger",
    })
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toBe(existing)
    expect(nodes[1]).toEqual({
      id: "trigger-1",
      type: "trigger.cron",
      typeVersion: 1,
      position: { x: 100, y: 180 },
      data: { label: "Cron trigger", params: { cron: "0 9 * * *", timezone: "Asia/Shanghai" } },
    })
  })

  it("leaves read-only workflows compiled from a playbook out of the picker", () => {
    const base = { nodes: [], edges: [] } as unknown as VisualWorkflow
    const editable = { ...base, id: "wf-a" }
    const derived = { ...base, id: "wf-b", readOnly: true }
    expect(mod.selectableWorkflows([editable, derived]).map((wf) => wf.id)).toEqual(["wf-a"])
  })
})
