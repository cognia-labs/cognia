/**
 * Who owns the workflow definitions this process is showing.
 *
 * A shell whose runtime target is a companion of a Host (a paired phone, a
 * browser paired to a headless Host) holds only a synced mirror of the Host's
 * workflows. Its editor writes still land in that mirror so the screen keeps
 * what the user typed, but the authoritative write goes to the Host, and a
 * run of what the user just saved has to execute there too, against the
 * Host's copy. Everything else owns its own definitions: the Tauri desktop
 * (its runtime target is null — it IS the Host), a standalone browser, and a
 * phone in standalone mode.
 *
 * Asked of the runtime target rather than of the platform for the same reason
 * `memoryWriteAuthority` is: "is this Capacitor" does not answer whether a
 * Host stands behind the phone.
 */

import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"

/** `local`: this process owns the definitions. `host`: a paired Host does. */
export type WorkflowWriteAuthority = "local" | "host"

export function workflowWriteAuthority(): WorkflowWriteAuthority {
  return getRuntimeSnapshot().target?.kind === "companion" ? "host" : "local"
}
