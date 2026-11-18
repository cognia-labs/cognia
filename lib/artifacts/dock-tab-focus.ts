"use client"

/**
 * Where keyboard focus goes after a dock tab is closed or switched.
 *
 * The dock draws one tab strip per surface — the conversation's and, while an
 * artifact is in front, the artifact's (`components/artifacts/artifact-dock.tsx`).
 * Activating a tab can swap which surface is on screen, so the tab element
 * that should take focus often does not exist yet when the key is pressed:
 * focusing it in the strip that handled the key left focus on a copy that was
 * about to be hidden and made inert, and closing a tab removed the focused
 * element outright, dropping focus to `<body>`.
 *
 * A request names the tab by its strip key. Every strip tries to honour it
 * after it renders; only a strip that is actually on screen may, so the strip
 * that ends up visible takes the focus. Requests expire quickly, so one that
 * nobody could honour (the tab vanished) cannot steal focus later.
 *
 * Closing the last tab collapses the dock. Focus then returns to whichever
 * dock toggle is on screen (`registerDockFocusReturn`), the control the user
 * would use to bring it back.
 */

/** How long a request stays valid. Covers a surface swap, not a user pause. */
const REQUEST_TTL_MS = 1_000

interface PendingFocus {
  scopeKey: string
  tabKey: string
  expiresAt: number
}

let pending: PendingFocus | null = null
const returnTargets = new Set<HTMLElement>()

/** Ask for `tabKey` in the strips of `scopeKey` to take focus once it is on screen. */
export function requestDockTabFocus(scopeKey: string, tabKey: string): void {
  pending = { scopeKey, tabKey, expiresAt: Date.now() + REQUEST_TTL_MS }
}

/** Whether an element can take focus: attached, and not inside a hidden or inert surface. */
export function isFocusableOnScreen(element: HTMLElement | null | undefined): boolean {
  if (!element || !element.isConnected) return false
  return element.closest("[hidden], [inert], [aria-hidden='true']") === null
}

/**
 * Honour a pending request for `scopeKey` if this strip holds the tab and is
 * on screen. Returns whether focus moved.
 */
export function takeDockTabFocus(
  scopeKey: string,
  resolve: (tabKey: string) => HTMLElement | undefined
): boolean {
  if (!pending || pending.scopeKey !== scopeKey) return false
  if (Date.now() > pending.expiresAt) {
    pending = null
    return false
  }
  const element = resolve(pending.tabKey)
  if (!isFocusableOnScreen(element)) return false
  element!.focus()
  pending = null
  return true
}

/** Drop any pending request, e.g. when the dock collapses instead. */
export function cancelDockTabFocus(): void {
  pending = null
}

/** Record a control focus can return to when the dock collapses. Returns a disposer. */
export function registerDockFocusReturn(element: HTMLElement): () => void {
  returnTargets.add(element)
  return () => {
    returnTargets.delete(element)
  }
}

/** Focus the dock toggle that is on screen, if any. Returns whether focus moved. */
export function returnFocusFromDock(): boolean {
  cancelDockTabFocus()
  // Most recently mounted first. A toggle hidden by CSS (the chat header's on
  // a phone) refuses focus, so the check is whether focus actually landed.
  for (const element of [...returnTargets].reverse()) {
    if (!isFocusableOnScreen(element)) continue
    element.focus()
    if (document.activeElement === element) return true
  }
  return false
}

/** Test seam. */
export function __resetDockTabFocusForTests(): void {
  pending = null
  returnTargets.clear()
}
