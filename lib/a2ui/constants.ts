/**
 * A2UI Constants
 * Shared constants used across A2UI components
 */

// =============================================================================
// Category Constants (moved from hooks/a2ui/use-app-gallery-filter.ts)
// =============================================================================

export const CATEGORY_KEYS = ["productivity", "data", "form", "utility", "social"] as const

export const CATEGORY_I18N_MAP: Record<string, string> = {
  productivity: "categoryProductivity",
  data: "categoryData",
  form: "categoryForm",
  utility: "categoryUtility",
  social: "categorySocial",
}

// =============================================================================
// Surface Style Constants (moved from components/a2ui/a2ui-surface.tsx)
// =============================================================================

/**
 * Surface container styles by type
 */
export const surfaceStyles = {
  // @container lets renderer components respond to the surface width (chat
  // column, side panel) instead of the viewport
  inline: "@container w-full",
  dialog: "fixed inset-0 z-50 flex items-center justify-center bg-black/50",
  panel: "@container w-full max-w-md border-l bg-background",
  fullscreen: "@container fixed inset-0 z-50 bg-background",
}

/**
 * Surface content wrapper styles
 */
export const contentStyles = {
  inline: "",
  dialog:
    "@container bg-background rounded-lg shadow-lg max-w-lg w-full max-h-[90vh] overflow-auto p-4",
  panel: "h-full overflow-auto p-4",
  fullscreen: "h-full overflow-auto p-4",
}
