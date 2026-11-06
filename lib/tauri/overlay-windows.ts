/**
 * Native show and reveal commands for the desktop app's windows: bring the main
 * window back, and reveal a transparent overlay (the pet's two, the fleet
 * island) once its first frame has painted.
 *
 * Shared by every secondary window, so they sit in the foundation layer
 * beside `lib/platform/window-role.ts` rather than in one feature's wrapper
 * (ADR-0250 §14). Same house style as the other `lib/tauri/*` wrappers: a
 * benign value off Tauri, and a rejected command is logged and swallowed.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

/** Window labels allowed to request a native pet-panel reveal. */
export type PetRevealTarget = "pet" | "pet-popup"

/**
 * Reveal a pet overlay after its first paint, on every platform. Rust checks
 * the window's open generation first, so a close that landed between the open
 * and the first frame wins over the reveal, and it records the sprite's first
 * paint. The target is explicit because an overlay can be hosted by a plain
 * Webview rather than a Tauri `WebviewWindow`; Rust resolves this label to its
 * native window.
 */
export async function revealPetWindow(
  focus = false,
  targetLabel: PetRevealTarget = "pet"
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("reveal_pet_window", { focus, targetLabel })
    return true
  } catch (err) {
    console.warn("revealPetWindow failed", err)
    return false
  }
}

/**
 * Reveal the fleet island overlay after its first paint. Mirrors
 * `revealPetWindow` but for the `"island"` window; on macOS it orders the
 * island NSPanel front without activating Cognia.
 */
export async function revealIslandWindow(focus = false): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("reveal_island_window", { focus })
    return true
  } catch (err) {
    console.warn("revealIslandWindow failed", err)
    return false
  }
}

/** Bring the main app window back to the foreground (overlay "show main"). */
export async function showMainWindow(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("show_main_window")
    return true
  } catch (err) {
    console.warn("showMainWindow failed", err)
    return false
  }
}
