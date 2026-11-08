/**
 * How a conversation-sidebar collapse/expand is carried out.
 *
 * `stores/ui/ui-store.ts` funnels every `sidebarCollapsed` write through
 * {@link runSidebarGesture}. On its own it applies the write at once. The
 * desktop shell installs its View Transition runner
 * (`lib/desktop/sidebar-edge-transition.ts`) when its chrome loads, so the
 * rail, the sidebar, the workspace and the title-bar outlets animate as one;
 * the store stays below the shell and never imports it.
 */

/**
 * @param apply commits the gesture's final state (the store write and its
 *   plugin event).
 * @param sidebarTargetPx the width the sidebar heads for: `0` when collapsing,
 *   the persisted width when expanding.
 */
export type SidebarGestureRunner = (apply: () => void, sidebarTargetPx: number) => void

const applyAtOnce: SidebarGestureRunner = (apply) => apply()

let runner: SidebarGestureRunner = applyAtOnce

/** Install the runner the shell animates gestures with; `null` restores applying at once. */
export function installSidebarGestureRunner(next: SidebarGestureRunner | null): void {
  runner = next ?? applyAtOnce
}

/** Carry out one sidebar gesture through the installed runner. */
export function runSidebarGesture(apply: () => void, sidebarTargetPx: number): void {
  runner(apply, sidebarTargetPx)
}
