/**
 * Triage: turning a wall of findings into the ones still worth someone's time.
 *
 * Two independent mutes, and the difference matters:
 *
 *  - a **finding state** is a verdict on ONE vulnerability at one place;
 *  - a **suppression rule** mutes a whole vulnerability CLASS for a target,
 *    including instances the scanner has not reported yet. That is the point —
 *    a class already accepted should not re-open a triage task every time
 *    another instance of it turns up.
 *
 * `fixed` is a verdict but not a mute. A finding marked fixed that is still
 * being reported is a contradiction the panel should show, not hide.
 */

import {
  normalizeSeverity,
  targetKey,
  type ScanReport,
  type SecurityFinding,
} from "@cognia/plugin-sdk/api/security-findings"
import {
  SUPPRESSING_STATES,
  type FindingState,
  type FindingStateRow,
  type StrixFinding,
  type StrixRun,
  type SuppressionRule,
} from "../types"

/** The recorded verdict, or `open` when none was recorded. */
export function findingStateOf(
  states: readonly FindingStateRow[],
  fingerprint: string
): FindingState {
  return states.find((row) => row.fingerprint === fingerprint)?.state ?? "open"
}

export interface SuppressionInput {
  states: readonly FindingStateRow[]
  rules: readonly SuppressionRule[]
}

/** Whether this finding is muted, by either mechanism. */
export function isSuppressed(finding: StrixFinding, input: SuppressionInput): boolean {
  if (input.rules.some((rule) => rule.ruleId === finding.ruleId)) return true
  const state = findingStateOf(input.states, finding.fingerprint)
  return (SUPPRESSING_STATES as readonly string[]).includes(state)
}

/** Fingerprints to withhold from the gate. */
export function suppressedFingerprints(
  findings: readonly StrixFinding[],
  input: SuppressionInput
): Set<string> {
  const suppressed = new Set<string>()
  for (const finding of findings) {
    if (isSuppressed(finding, input)) suppressed.add(finding.fingerprint)
  }
  return suppressed
}

/**
 * Panel finding → the shared canonical shape.
 *
 * Proof-of-concept code, technical analysis and code snippets are dropped on
 * the way out. They are the most sensitive thing this plugin holds — working
 * exploits against a named target — and an exported SARIF log goes to CI logs,
 * code-scanning dashboards and pull requests. What leaves is what a reviewer
 * needs to locate and fix the issue.
 */
export function toSecurityFinding(finding: StrixFinding): SecurityFinding {
  return {
    fingerprint: finding.fingerprint,
    ruleId: finding.ruleId,
    title: finding.title,
    severity: normalizeSeverity(finding.severity),
    ...(finding.cvss !== undefined ? { cvss: finding.cvss } : {}),
    ...(finding.description ? { description: finding.description } : {}),
    ...(finding.remediationSteps ? { remediation: finding.remediationSteps } : {}),
    ...(finding.cwe ? { cwe: finding.cwe } : {}),
    ...(finding.cve ? { cve: finding.cve } : {}),
    locations: [
      ...(finding.codeLocations ?? [])
        .filter((location) => location.file)
        .map((location) => ({
          file: location.file as string,
          ...(location.startLine !== undefined ? { startLine: location.startLine } : {}),
          ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
        })),
      ...(finding.endpoint
        ? [
            {
              endpoint: finding.endpoint,
              ...(finding.method ? { method: finding.method.toUpperCase() } : {}),
            },
          ]
        : []),
    ],
  }
}

/**
 * A stored run → a report the shared gate and SARIF writer can consume.
 *
 * `completeness` is read from `run.reportUnreadable`, never inferred from the
 * finding count: a run with an unparseable report has zero findings and would
 * otherwise export as a clean scan.
 */
export function toScanReport(run: StrixRun, findings: readonly StrixFinding[]): ScanReport {
  const completeness = run.reportUnreadable
    ? "unreadable"
    : findings.length === 0
      ? "empty"
      : "complete"
  return {
    // Normalized, not the raw string the user typed. `ScanReport.target` is a
    // KEY: the same field the CLI derives from its own `--target`, and the same
    // one triage rows are stored under. Passing the raw value through would
    // make a SARIF log exported from the panel and one exported by the CLI
    // disagree about which system they describe.
    target: targetKey(run.target),
    completeness,
    findings: findings.map(toSecurityFinding),
    ...(run.reportUnreadable
      ? { unreadableReason: run.error ?? "the vulnerability report could not be parsed" }
      : {}),
    tool: { name: "strix" },
  }
}
