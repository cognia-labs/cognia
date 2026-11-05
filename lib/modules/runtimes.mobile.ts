/**
 * The module runtimes the Capacitor build starts: `./runtimes.ts` for the
 * phone, over `./generated/mobile.ts` (ADR-0250 §14, M2).
 */

import { MOBILE_RUNTIMES } from "./generated/mobile"
import type {
  ModuleRuntimeBoot,
  RendererRuntimeContext,
  RendererRuntimeEntry,
} from "./manifest-types"
import { isActiveModule } from "./registry"

/** The host this build's adapters are for. */
export const RENDERER_HOST: RendererRuntimeContext["host"] = "mobile"

/** As `rendererRuntimes` in `./runtimes.ts`, over the phone's registry. */
export function rendererRuntimes(
  boot?: ModuleRuntimeBoot,
  entries: readonly RendererRuntimeEntry[] = MOBILE_RUNTIMES
): RendererRuntimeEntry[] {
  return entries.filter((entry) => isActiveModule(entry) && entry.boot === boot)
}
