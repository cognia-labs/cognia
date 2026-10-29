/**
 * Which native receipts each managed desktop switch and qualification run
 * needs (ADR-0233 A3/A4, Q25 split). The Host enforces the same mapping; the
 * renderer only uses it to explain what is missing.
 */
import type {
  ManagedDesktopCategoryReceipt,
  ManagedDesktopEnablement,
  ManagedDesktopQualificationCategory,
  ManagedDesktopQualificationRun,
  ManagedDesktopQualificationScope,
} from "./managed-desktop-client"

const GUI_CATEGORIES = ["lifecycle", "control", "authority", "workload"] as const
const HANDOFF_CATEGORIES = ["commit", "bundle"] as const

/** Every category, in the order a run qualifies them. */
export const MANAGED_DESKTOP_QUALIFICATION_CATEGORIES: readonly ManagedDesktopQualificationCategory[] =
  [...GUI_CATEGORIES, ...HANDOFF_CATEGORIES]

/** GUI and agent control never wait for handoff receipts; acceptance needs all six. */
export const MANAGED_DESKTOP_GATE_CATEGORIES: Readonly<
  Record<keyof ManagedDesktopEnablement, readonly ManagedDesktopQualificationCategory[]>
> = {
  manualGui: GUI_CATEGORIES,
  agentControl: GUI_CATEGORIES,
  acceptance: MANAGED_DESKTOP_QUALIFICATION_CATEGORIES,
}

export const MANAGED_DESKTOP_SCOPE_CATEGORIES: Readonly<
  Record<ManagedDesktopQualificationScope, readonly ManagedDesktopQualificationCategory[]>
> = {
  gui: GUI_CATEGORIES,
  acceptance: MANAGED_DESKTOP_QUALIFICATION_CATEGORIES,
}

/**
 * The guest launch is `npm run <script>` at the repository root. Mirrors the
 * Host's `parse_launch`: a leading `-` or `.` would reach npm as an option.
 */
export const MANAGED_DESKTOP_HANDOFF_SCRIPT = /^[A-Za-z0-9_:][A-Za-z0-9_:.-]{0,99}$/

/** Categories without a current receipt for `gate`, in qualification order. */
export function missingQualification(
  receipts: readonly ManagedDesktopCategoryReceipt[],
  gate: keyof ManagedDesktopEnablement
): ManagedDesktopQualificationCategory[] {
  const current = new Set(
    receipts.filter((receipt) => receipt.current).map((receipt) => receipt.category)
  )
  return MANAGED_DESKTOP_GATE_CATEGORIES[gate].filter((category) => !current.has(category))
}

/** A run that still holds or may still create billed desktops. */
export function isQualificationRunActive(run: ManagedDesktopQualificationRun): boolean {
  return run.state === "running" || run.state === "awaitingApproval"
}

/** One configuration's runs, newest first as the Host lists them. */
export function qualificationRunsFor(
  runs: readonly ManagedDesktopQualificationRun[],
  providerConfigId: string
): ManagedDesktopQualificationRun[] {
  return runs.filter((run) => run.providerConfigId === providerConfigId)
}
