/**
 * Platforms whose host ships a screen-off (virtual display) backend.
 *
 * One list, read by the Behavior panel (whether to show the block at all), the
 * diagnostics panel and the screen-off card's own guard, so a new backend
 * lights the feature up everywhere by adding its platform here. Backend readiness is separately checked by the health probe.
 */
export const SCREEN_OFF_PLATFORMS: readonly string[] = ["windows", "macos"]

export function screenOffSupported(platform: string | null | undefined): boolean {
  return platform != null && SCREEN_OFF_PLATFORMS.includes(platform)
}
