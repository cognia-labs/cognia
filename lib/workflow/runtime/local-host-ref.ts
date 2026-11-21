/**
 * The placement ref that names THIS Host.
 *
 * `runOn: { mode: "pinned", ref }` names one machine. Two spellings mean "this
 * one": the literal `"local"` the Run Policy field writes for "this device",
 * and the Host's own identity (`COGNIA_HOST_ID`, the id a paired Host is known
 * by). Placement and trigger registration must agree on that answer — a file
 * watch that registered only for unpinned workflows refused a pin to this
 * very Host, so the watch never armed anywhere (WF-21).
 */

/** This Host's placement ref; `"local"` when it has no published identity. */
export function localWorkflowHostRef(): string {
  return process.env.COGNIA_HOST_ID?.trim() || "local"
}

/** Whether `ref` names this Host. */
export function isLocalWorkflowHostRef(
  ref: string,
  localHostRef: string = localWorkflowHostRef()
): boolean {
  return ref === "local" || ref === localHostRef
}
