import type {
  ManagedDesktopCategoryReceipt,
  ManagedDesktopQualificationRun,
} from "./managed-desktop-client"
import {
  MANAGED_DESKTOP_HANDOFF_SCRIPT,
  MANAGED_DESKTOP_QUALIFICATION_CATEGORIES,
  MANAGED_DESKTOP_SCOPE_CATEGORIES,
  isQualificationRunActive,
  missingQualification,
  qualificationRunsFor,
} from "./managed-desktop-qualification"

const receipts = (current: string[]): ManagedDesktopCategoryReceipt[] =>
  MANAGED_DESKTOP_QUALIFICATION_CATEGORIES.map((category) => ({
    category,
    current: current.includes(category),
    observedAt: current.includes(category) ? 1 : null,
  }))

test("GUI and agent control need only the four GUI receipts", () => {
  const gui = receipts(["lifecycle", "control", "authority", "workload"])
  expect(missingQualification(gui, "manualGui")).toEqual([])
  expect(missingQualification(gui, "agentControl")).toEqual([])
  expect(missingQualification(gui, "acceptance")).toEqual(["commit", "bundle"])
})

test("lists missing categories in qualification order", () => {
  expect(missingQualification(receipts(["control"]), "manualGui")).toEqual([
    "lifecycle",
    "authority",
    "workload",
  ])
  expect(missingQualification([], "acceptance")).toEqual(MANAGED_DESKTOP_QUALIFICATION_CATEGORIES)
})

test("a stale receipt counts as missing", () => {
  const all = receipts([...MANAGED_DESKTOP_QUALIFICATION_CATEGORIES])
  all[0] = { ...all[0], current: false }
  expect(missingQualification(all, "manualGui")).toEqual(["lifecycle"])
})

test("an acceptance run covers both handoff modes after the GUI categories", () => {
  expect(MANAGED_DESKTOP_SCOPE_CATEGORIES.gui).toEqual([
    "lifecycle",
    "control",
    "authority",
    "workload",
  ])
  expect(MANAGED_DESKTOP_SCOPE_CATEGORIES.acceptance.slice(4)).toEqual(["commit", "bundle"])
})

test("only running and paused runs are active", () => {
  const run = { state: "running" } as ManagedDesktopQualificationRun
  expect(isQualificationRunActive(run)).toBe(true)
  expect(isQualificationRunActive({ ...run, state: "awaitingApproval" })).toBe(true)
  for (const state of ["passed", "failed", "cancelled", "interrupted"] as const)
    expect(isQualificationRunActive({ ...run, state })).toBe(false)
})

test("filters runs by configuration and keeps the Host's order", () => {
  const runs = [
    { runId: "b", providerConfigId: "x" },
    { runId: "c", providerConfigId: "y" },
    { runId: "a", providerConfigId: "x" },
  ] as ManagedDesktopQualificationRun[]
  expect(qualificationRunsFor(runs, "x").map((run) => run.runId)).toEqual(["b", "a"])
})

test("script names are npm script identifiers, never shell text or npm options", () => {
  for (const script of ["test:e2e", "build.preview", "_private", ":x", "a".repeat(100)])
    expect(MANAGED_DESKTOP_HANDOFF_SCRIPT.test(script)).toBe(true)
  for (const script of ["", "test && rm -rf /", "-script", "--prefix", ".hidden", "a".repeat(101)])
    expect(MANAGED_DESKTOP_HANDOFF_SCRIPT.test(script)).toBe(false)
})
