/**
 * Where "Pair a device" and "Add host" lead, on every shell.
 *
 * Pairing a phone is a native flow on the desktop, where Settings → Companion
 * renders the QR. Everywhere else it is a route of its own, and that route is
 * the surface contract's remedy for a standalone console, so the header
 * action, the empty-fleet card and the standalone alert cannot disagree about
 * where pairing lives. The phone shell used to spell `/pair` out by hand,
 * which is how two copies of one decision start to drift.
 *
 * # "Add host" is two different acts, and only the desktop has both
 *
 * On the desktop, adding a host files it in the remote-host registry
 * (ADR-0082): the desktop is its own execution plane and may *drive* another
 * machine, so the add-host sheet asks for a label, always-on and "connect
 * after". A browser or a phone has no plane of its own: the Host it pairs
 * with is its runtime, which `/pair?mode=add` records in the companion
 * credential book and reconnects to on every launch.
 *
 * Both used to be offered off the desktop. The device console's sheet wrote
 * the registry while the status bar, the runtime menu and recovery wrote the
 * credential book, so the same "Add host" filed a Host in one of two stores
 * depending on which button was pressed — and a registry Host in a browser
 * has no active transport after a reload, because ADR-0082 never persists
 * the active host. Off the desktop every "Add host" now goes to `/pair`.
 */

import { isTauri } from "@/lib/platform/detect"
import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

export const DESKTOP_PAIR_HREF = "/settings?section=companion"

/** Pair this browser or phone with one more Host, keeping the current one. */
export const COMPANION_ADD_HOST_HREF = "/pair?mode=add"

export function devicePairHref(): string {
  return isTauri() ? DESKTOP_PAIR_HREF : standaloneDevicesRequiresHost.remedy
}

/**
 * Whether "Add host" opens the registry sheet here. Only the desktop drives
 * other machines; every other shell routes to {@link COMPANION_ADD_HOST_HREF}.
 */
export function addsHostsToRegistry(): boolean {
  return isTauri()
}
