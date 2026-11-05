/**
 * The module runtimes this renderer build starts (ADR-0250 §14, M2).
 *
 * The desktop build (Tauri and the browser) reads `./generated/desktop.ts`;
 * the Capacitor build resolves `./runtimes.mobile.ts` instead, which reads
 * `./generated/mobile.ts`. Each build so holds only its own host's adapters.
 * The brain reads `./generated/brain.ts` through `lib/headless/runtimes/modules.ts`.
 *
 * Dormancy (Rule 7): an `experimental` module's runtimes are left out here,
 * as everywhere a registry is read (`isActiveModule`); `runtimes.test.ts`
 * pins it.
 */

import { DESKTOP_RUNTIMES } from "./generated/desktop"
import type {
  ModuleRuntimeBoot,
  RendererRuntimeContext,
  RendererRuntimeEntry,
} from "./manifest-types"
import { isActiveModule } from "./registry"

/** The host this build's adapters are for. */
export const RENDERER_HOST: RendererRuntimeContext["host"] = "desktop"

/**
 * The active runtimes that wait for `boot` (absent: the main boot cluster),
 * in registry order.
 */
export function rendererRuntimes(
  boot?: ModuleRuntimeBoot,
  entries: readonly RendererRuntimeEntry[] = DESKTOP_RUNTIMES
): RendererRuntimeEntry[] {
  return entries.filter((entry) => isActiveModule(entry) && entry.boot === boot)
}
