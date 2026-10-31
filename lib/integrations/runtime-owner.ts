import { detectPlatform } from "@/lib/platform/detect"
import { WINDOW_LABELS } from "@/lib/native/utils"

/** The plugin bootstrap's main-window rule, shared by drains and approvals. */
export async function isIntegrationRuntimeOwner(): Promise<boolean> {
  if (detectPlatform() !== "tauri") return true
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow().label === WINDOW_LABELS.MAIN
}
