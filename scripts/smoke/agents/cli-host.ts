/**
 * Mark this process as the standalone CLI before any `@/lib` module loads, as
 * `cli/src/cli/entry.ts` does: shared code reads the marker to decide that
 * this process owns a process table (`lib/platform/detect.ts` `isCliHost`).
 * Import it first; it imports nothing but the marker.
 */
import { markCliHostProcess } from "@/cli/src/runtime/cli-host-marker"

markCliHostProcess()
