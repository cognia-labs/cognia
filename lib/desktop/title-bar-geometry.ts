/**
 * Where the title bar's projected column headers sit.
 *
 * The chat workspace projects its conversation-rail header into the bar's
 * start outlet and the artifact dock's header into its end outlet
 * (`components/shell/title-bar-outlets.tsx`). Each outlet is sized to the
 * measured width of the column beneath it, less the chrome that already
 * occupies that stretch of the bar (traffic lights, hamburger, window
 * buttons), so the centre is exactly the chat column.
 *
 * Pure so the arithmetic is testable without a layout engine; `TitleBar`
 * feeds it measured widths from `useShellColumnsStore` and its own refs.
 */

import type { SidebarSide } from "@/types/shell/sidebar"

/**
 * Smallest share of the bar the centre zone may be squeezed to by the column
 * outlets. Half: the centre carries the route history, the workspace pill, the
 * search / command-centre group *plus* the projected chat header — the outlets
 * carry one column header each and right-align it.
 */
export const TITLE_BAR_MIN_CENTRE_RATIO = 0.5

export interface TitleBarGeometryInput {
  /** The bar's measured width; 0 = not measured yet. */
  barPx: number
  /** The bar's leading padding (traffic-light reserve or the plain inset). */
  paddingLeftPx: number
  /** Width of the leading chrome cluster (start zone, plugins, menus). */
  leftChromePx: number
  /** Width of the trailing chrome cluster (actions, end zone, window buttons). */
  rightChromePx: number
  sidebarSide: SidebarSide
  /** The nav rail (0 while hidden or hosted by the sidebar). */
  railPx: number
  /** The conversation sidebar. */
  sidebarPx: number
  /** The artifact dock. */
  dockPx: number
  projectedStart: boolean
  projectedEnd: boolean
}

export interface TitleBarGeometry {
  startOutletPx: number
  endOutletPx: number
}

export function computeTitleBarGeometry(input: TitleBarGeometryInput): TitleBarGeometry {
  const {
    barPx,
    paddingLeftPx,
    leftChromePx,
    rightChromePx,
    sidebarSide,
    railPx,
    sidebarPx,
    dockPx,
    projectedStart,
    projectedEnd,
  } = input

  // The nav rail is the outermost column on `sidebarSide`, so the conversation
  // rail begins after it on the left and the dock ends before it on the right.
  const railLeftPx = sidebarSide === "left" ? railPx : 0
  const railRightPx = sidebarSide === "right" ? railPx : 0
  // On the right the conversation sidebar keeps its own header (the start
  // zone is the *leading* column's), so it projects nothing — but it still
  // sits under the end zone, which has to span it the way it spans the rail.
  const sidebarRightPx = sidebarSide === "right" && !projectedStart ? sidebarPx : 0

  const columnStartPx = projectedStart
    ? Math.max(0, railLeftPx + sidebarPx - paddingLeftPx - leftChromePx)
    : 0
  const columnEndPx = projectedEnd
    ? Math.max(0, railRightPx + sidebarRightPx + dockPx - rightChromePx)
    : 0

  // Tracking the columns exactly is right until a column is wide enough to
  // starve the bar's own row: a workbench at its `wide` preset is half the
  // window, and the end outlet then reserved half the bar for four
  // right-aligned icons while the conversation title truncated to a letter.
  // So the centre keeps a floor, and what it borrows comes off the outlets —
  // the end one first (its content is right-aligned against the trailing
  // chrome, so shrinking it only removes empty space), then the start one.
  if (barPx <= 0) return { startOutletPx: columnStartPx, endOutletPx: columnEndPx }

  const centreFloorPx = Math.round(barPx * TITLE_BAR_MIN_CENTRE_RATIO)
  const centrePx =
    barPx - paddingLeftPx - leftChromePx - rightChromePx - columnStartPx - columnEndPx
  const deficitPx = Math.max(0, centreFloorPx - centrePx)
  return {
    endOutletPx: Math.max(0, columnEndPx - deficitPx),
    startOutletPx: Math.max(0, columnStartPx - Math.max(0, deficitPx - columnEndPx)),
  }
}
