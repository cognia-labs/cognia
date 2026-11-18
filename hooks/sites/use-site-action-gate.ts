"use client"

/**
 * The single seam deciding whether a Sites control may act.
 *
 * Two independent things can stop an action, and the console has to say which:
 *
 *  - **Host.** Builds run through `sandbox_exec`, previews spawn a PTY,
 *    provider calls need the OS keyring and a non-CORS-blocked fetch, and the
 *    manifest lives on disk. None of that exists outside the Tauri shell. The
 *    console still renders everywhere — the panel used to blank itself behind
 *    one page-level `isTauri()`, which is why it looked like it had no
 *    features at all in the browser — but each host-privileged control is
 *    disabled with a reason instead.
 *  - **Authoring policy.** `CloudflareSitesService` asserts the policy on every
 *    mutation and throws. Without this gate a viewer sees enabled buttons that
 *    fail on click.
 *
 * Getting the host half wrong is worse than an error: outside Tauri the keyring
 * silently falls back to an in-memory store (a saved provider token would look
 * accepted and vanish on reload) and `readTextFile` falls back to `fetch`,
 * which turns a missing manifest into the dev server's 404 HTML. Those paths
 * must be closed here, not discovered downstream.
 *
 * A third thing closes everything at once: on a paired phone or browser the
 * Sites tables are a read-only mirror of the Host's
 * (`lib/sites/sync/sync-handlers.ts`). Even a `metadata` write there would
 * change only the copy, which the next pull overwrites or never corrects, so
 * every control answers `host-mirror` and names the Host as the place to act.
 */
import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { usePlatform, type Platform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { detectOsFamily, type OsFamily } from "@/lib/platform/os"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { canAuthorSite, type SiteAuthoringCapability } from "@/lib/sites/authoring-policy"
import type { SiteProjectRow } from "@/types/sites"

/**
 * What an action needs from the machine it runs on.
 *
 * `metadata` is the odd one out: creating a Site, editing its authoring policy,
 * and deleting its Cognia rows touch nothing but Dexie, so they work in every
 * shell against that shell's own local database.
 *
 * `recovery` is a provider call that must still work while a purge holds the
 * Site in `deleting` — reconciling and resuming are how a purge interrupted by
 * the host stopping gets finished. Locking them with everything else left the
 * Site in `deleting` with no control that could move it.
 */
export type SiteActionCapability =
  "provider" | "recovery" | "build" | "preview" | "filesystem" | "metadata"

export type SiteGateReason =
  | "ok"
  /**
   * This shell shows the paired Host's Sites as a read-only mirror. Paired
   * clients relay no Sites writes (no `hostWriteCommands`), so every change,
   * metadata included, is made in the desktop app on the Host. Labelled by the
   * console's banner and each control's title, pinned by
   * `use-site-action-gate.test.ts` and `components/sites/sites-console.test.tsx`.
   */
  | "host-mirror"
  | "requires-desktop"
  /** The host has no wrangler binary — upload cannot run, deploy still can. */
  | "requires-wrangler"
  /** Previews run in a sandboxed terminal, which Windows does not provide yet. */
  | "requires-preview-sandbox"
  | "requires-access"
  | "requires-owner"
  | "requires-editor"
  | "requires-deployer"
  | "lifecycle-locked"

export interface SiteGateDecision {
  allowed: boolean
  reason: SiteGateReason
}

export interface SiteGate extends SiteGateDecision {
  /** Localized explanation for the control's `title`, or undefined when allowed. */
  title: string | undefined
}

export type SiteActionGate = (
  capability: SiteActionCapability,
  authoring?: SiteAuthoringCapability
) => SiteGate

const REASON_FOR_CAPABILITY: Record<SiteAuthoringCapability, SiteGateReason> = {
  view: "requires-access",
  edit: "requires-editor",
  deploy: "requires-deployer",
  manage: "requires-owner",
}

export interface ResolveSiteGateInput {
  platform: Platform
  /** The Sites tables here mirror a paired Host's (see {@link isSitesHostMirror}). */
  mirror?: boolean
  site: SiteProjectRow | null
  actorAccountId: string
  capability: SiteActionCapability
  authoring?: SiteAuthoringCapability
  /** Defaults to this webview's own family. */
  osFamily?: OsFamily
}

/**
 * Pure gate decision. Order matters: the host answer is reported first because
 * it is the one the user can act on without anyone's permission.
 */
export function resolveSiteGate(input: ResolveSiteGateInput): SiteGateDecision {
  // Before the platform: a paired browser is also "not tauri", but telling its
  // user to open the desktop app here is wrong when the Sites are the Host's.
  if (input.mirror) return { allowed: false, reason: "host-mirror" }
  const needsHost = input.capability !== "metadata"
  if (needsHost && input.platform !== "tauri") {
    return { allowed: false, reason: "requires-desktop" }
  }
  if (input.capability === "preview" && (input.osFamily ?? detectOsFamily()) === "windows") {
    return { allowed: false, reason: "requires-preview-sandbox" }
  }
  const site = input.site
  if (!site) return { allowed: true, reason: "ok" }
  // `deleting` means a purge is mid-flight; only recovery may act on it.
  // `deleted` leaves only the metadata cleanup that `metadata` covers.
  const lifecycleLocked =
    (site.lifecycle === "deleting" && input.capability !== "recovery") ||
    (site.lifecycle === "deleted" && needsHost)
  if (lifecycleLocked) return { allowed: false, reason: "lifecycle-locked" }
  if (
    input.authoring &&
    !canAuthorSite(site.authoringPolicy, input.actorAccountId, input.authoring)
  ) {
    return { allowed: false, reason: REASON_FOR_CAPABILITY[input.authoring] }
  }
  return { allowed: true, reason: "ok" }
}

/**
 * Whether this shell's Sites tables are a paired Host's mirror.
 *
 * A companion target (a paired phone, or a browser paired with a Host) reads
 * the Host's account database, which companion sync fills. The desktop app and
 * the headless brain are hosts themselves (no target), and a standalone browser
 * or phone owns its database outright (ADR-0084).
 */
export function isSitesHostMirror(snapshot: Pick<RuntimeSnapshot, "target">): boolean {
  return snapshot.target?.kind === "companion"
}

/** {@link isSitesHostMirror} for the live runtime snapshot. */
export function useSitesHostMirror(): boolean {
  return isSitesHostMirror(useRuntimeSnapshot())
}

/**
 * Bind the gate to the current shell and actor.
 *
 * Call sites read as two props, which is the idiom already used across
 * settings: `disabled={busy || !gate.allowed}` and `title={gate.title}`.
 */
export function useSiteActionGate(
  site: SiteProjectRow | null,
  actorAccountId: string
): SiteActionGate {
  const platform = usePlatform()
  const mirror = useSitesHostMirror()
  const t = useTranslations("sites")
  return useCallback(
    (capability, authoring) => {
      const decision = resolveSiteGate({
        platform,
        mirror,
        site,
        actorAccountId,
        capability,
        authoring,
      })
      return {
        ...decision,
        title: decision.allowed ? undefined : t(`host.reason.${decision.reason}`),
      }
    },
    [platform, mirror, site, actorAccountId, t]
  )
}
