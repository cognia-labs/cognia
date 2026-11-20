/**
 * Mirror a local settings edit up to the paired host.
 *
 * A paired client (Capacitor phone, or a browser pointed at a cloud
 * `cognia-server`) keeps its own `AppSettings` singleton. Editing a setting has
 * to do two things: write it locally so the UI updates immediately and the
 * standalone engine sees it, and enqueue an `app_settings_update` so the host
 * applies the same change when it is reachable.
 *
 * Only the second half used to be anyone's job in particular, so it was done
 * per-page: `hooks/use-settings-patch.ts` did both steps and nine `/me/*` pages
 * called it. Every mobile route that instead **embeds a desktop settings
 * section** — `/me/appearance` renders the desktop `<AppearanceSection />` — went
 * straight to `useSettingsStore`, which only ever wrote locally. So the phone's
 * theme, custom themes, accent colour, custom CSS and imported VSCode themes
 * never reached the desktop, no matter how long you waited. The server-side
 * allowlist had thirteen keys added specifically to stop those tabs from
 * 400-ing, and not one of them was ever exercised.
 *
 * `wallpapers` was in that list too and is no longer: it is an array of
 * references into one machine's storage (a `disk` path under that Tauri host's
 * appData, or an `indexeddb` key in that webview's blob store), and off Tauri
 * `saveImage()` can only produce the latter. Mirroring it filled the desktop's
 * gallery with rows it could not open. It is `device-local` now, so it is
 * dropped here like any other non-writable key.
 *
 * Hanging the mirror off the single persistence funnel (`saveSettings`) instead
 * of off each page fixes every embedded section at once, and means the next
 * reused desktop section is correct on arrival rather than one more silent gap.
 *
 * `saveSettings` writes the job in the same transaction as the settings row,
 * so a local edit never lands without the job that carries it to the Host.
 */

import type { CogniaDB } from "@/lib/db/schema"
import {
  captureOutboundQueueScope,
  enqueueInScope,
  type OutboundQueueScope,
} from "@/lib/db/mobile-outbound-queue"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import type { AppSettings } from "@cognia/agent-config-types"
import { MOBILE_WRITABLE_SETTING_KEYS } from "@cognia/agent-config-types/settings-sync"

const WRITABLE = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS as readonly string[])

/**
 * True when this runtime's settings row is a *mirror* of some host's rather
 * than the authority.
 *
 * The desktop is the authority for its own row, so it never mirrors — including
 * a desktop driving a remote host (ADR-0082), whose local preferences are still
 * its own. An unpaired standalone phone matches, which is harmless: the job
 * simply sits in the queue until a host exists, exactly as the outbound queue is
 * designed to behave.
 */
export function isMirroredSettingsClient(): boolean {
  return isCapacitor() || hasWebCompanionTarget()
}

/**
 * The host-writable subset of `patch`, as it goes on the wire, or `null` when
 * nothing in it is writable.
 *
 * Non-writable keys are dropped rather than sent-and-rejected: the host answers
 * a disallowed key with `400 validation_failed` for the whole patch, so posting
 * a mixed patch would lose the writable half too.
 *
 * A key the patch clears (`undefined`, as an appearance reset writes for the
 * optional colour preset) travels as `null`: JSON drops `undefined`, so the
 * clear used to vanish from the request and the Host kept the old value. The
 * Host reads `null` back as "cleared" (`desktop-write-source.ts`).
 */
export function hostSettingsPatch(
  patch: Partial<Omit<AppSettings, "id">>
): Record<string, unknown> | null {
  const writable: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (WRITABLE.has(key)) writable[key] = value === undefined ? null : value
  }
  return Object.keys(writable).length > 0 ? writable : null
}

export interface SettingsMirror {
  /** Queue the host-writable subset of `patch`; returns the keys queued. */
  enqueue(patch: Partial<Omit<AppSettings, "id">>): Promise<string[]>
}

export interface SettingsMirrorDeps {
  isMirrored?: () => boolean
  /** The active route's queue scope, or `null` when there is no Host route. */
  captureScope?: () => OutboundQueueScope | null
  enqueueJob?: typeof enqueueInScope
}

function activeQueueScope(): OutboundQueueScope | null {
  try {
    return captureOutboundQueueScope()
  } catch {
    // No active account and runtime target: nothing to mirror to.
    return null
  }
}

/**
 * The mirror a save of `db` writes through, or `null` when it has none: this
 * runtime owns its settings, no Host route is active, or `db` is not the
 * active route's database (its row mirrors no Host the queue could reach).
 *
 * Resolved before the save opens its transaction; `enqueue` is then called
 * inside it, so the job and the settings row commit together, and a queue
 * that cannot take the job fails the save instead of leaving a local value
 * the Host never hears of.
 */
export function prepareSettingsMirror(
  db: CogniaDB,
  deps: SettingsMirrorDeps = {}
): SettingsMirror | null {
  if (!(deps.isMirrored ?? isMirroredSettingsClient)()) return null
  const scope = (deps.captureScope ?? activeQueueScope)()
  if (!scope || scope.db !== db) return null
  const enqueueJob = deps.enqueueJob ?? enqueueInScope
  return {
    async enqueue(patch) {
      const writable = hostSettingsPatch(patch)
      if (!writable) return []
      const keys = Object.keys(writable)
      await enqueueJob(scope, {
        command: "app_settings_update",
        payload: { patch: writable },
        // Machine-readable on purpose. The old per-page enqueue called
        // `t("mobile.settingsPanel.queueLabel")`, whose message carries no
        // placeholder, so every settings edit queued the same sentence. Writing
        // this from the persistence funnel puts it outside React, where
        // resolving a locale would mean pulling the message bundle into a Dexie
        // write; and `MobileOutboundJobRow.label` has no renderer today (the
        // offline banner shows counts, not rows). So the row carries the keys
        // it will apply, which is what a queue UI would need to translate. That
        // key list is data, not a user-facing string.
        label: keys.join(", "),
      })
      return keys
    },
  }
}
