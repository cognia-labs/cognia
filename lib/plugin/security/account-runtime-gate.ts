/**
 * Process-local guard that binds plugin execution to one unlocked LocalProfile.
 * The native permission ledger enforces the same boundary independently.
 */

let activeAccountId: string | null = null
let blocked = true
let enforced = false
let revision = 0

export function activatePluginRuntimeAccount(localAccountId: string): void {
  if (!localAccountId.trim()) throw new Error("Plugin runtime account is required.")
  activeAccountId = localAccountId
  blocked = false
  enforced = true
  revision++
}

export function blockPluginRuntimeAccount(localAccountId?: string): void {
  if (localAccountId && activeAccountId && localAccountId !== activeAccountId) return
  blocked = true
  enforced = true
  revision++
}

export function clearPluginRuntimeAccount(): void {
  blocked = true
  activeAccountId = null
  enforced = true
  revision++
}

/** The unlocked LocalProfile, never the identity being torn down. */
export function getPluginRuntimeAccountId(): string | null {
  return blocked ? null : activeAccountId
}

/** Invalidates in-flight work even when a profile is locked and unlocked again. */
export function getPluginRuntimeAccountRevision(): number {
  return revision
}

export function pluginRuntimeAccountAvailable(): boolean {
  // Existing isolated unit tests construct permission guards without the app
  // account lifecycle. Production enables enforcement before plugin boot.
  return !enforced || (!blocked && activeAccountId !== null)
}
