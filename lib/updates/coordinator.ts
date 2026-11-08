/**
 * The Update Center coordinator.
 *
 * One engine drives every asset kind: it registers adapters, de-duplicates
 * concurrent checks, applies backoff with jitter and `Retry-After`, projects
 * adapter results into rows the UI renders, persists a snapshot per asset, and
 * reconciles that snapshot on the next launch.
 *
 * Two rules it enforces that no adapter may override:
 *  1. A critical update can be deferred but never permanently skipped, and it
 *     never blocks normal use of the app.
 *  2. Background download is available to first-party desktop packages only.
 *     Anything that widens permissions, changes skill content, goes through a
 *     store, or updates the CLI requires explicit consent first.
 */

import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  EXECUTOR_PRIMARY_ACTION,
  canTransitionUpdateState,
  isInAppExecutor,
  updateSnapshotKey,
  type UpdateAssetKind,
  type UpdateCandidate,
  type UpdateCenterSettings,
  type UpdateChannel,
  type UpdateFailure,
  type UpdateSnapshot,
  type UpdateState,
} from "@cognia/agent-config-types"

import {
  UpdateCheckError,
  type CatalogFetchResult,
  type UpdateAdapter,
  type UpdateApplyContext,
  type UpdateItem,
} from "./adapter"
import { backoffDelayMs, isCheckDue } from "./backoff"
import { normalizeRolloutBucket, rolloutVerdict } from "./rollout"
import {
  newAttemptId,
  sanitizeTelemetryEvent,
  type UpdateTelemetryEvent,
  type UpdateTelemetrySink,
} from "./telemetry"

/** Default gap between automatic sweeps. */
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How long "Remind me later" holds a routine update. */
export const DEFAULT_DEFER_MS = 24 * 60 * 60 * 1000

/** Critical updates come back sooner, because they are the ones that matter. */
export const CRITICAL_DEFER_MS = 4 * 60 * 60 * 1000

export interface UpdatePersistence {
  /** Current settings, read synchronously from an already-hydrated store. */
  read(): UpdateCenterSettings
  /** Persist a patch. Failures must not take the coordinator down. */
  write(patch: Partial<UpdateCenterSettings>): Promise<void>
  /** Merge only these keys into the latest persisted snapshot map. */
  writeSnapshots(patches: Record<string, UpdateSnapshot>): Promise<void>
}

export type { CatalogFetchResult } from "./adapter"

export interface CoordinatorDeps {
  adapters: readonly UpdateAdapter[]
  persistence: UpdatePersistence
  /** Resolve verified entries, missing configuration, or a source failure. */
  fetchCatalog: (options: {
    channel: UpdateChannel
    signal?: AbortSignal
  }) => Promise<CatalogFetchResult>
  now?: () => number
  random?: () => number
  checkIntervalMs?: () => number
  telemetry?: UpdateTelemetrySink
  /** Running app version, used to verify a desktop attempt after restart. */
  appVersion?: string
  onError?: (scope: string, error: unknown) => void
}

export interface CheckOptions {
  manual?: boolean
  /** Restrict the sweep to one asset kind. */
  kind?: UpdateAssetKind
  signal?: AbortSignal
}

interface InternalRow extends UpdateItem {
  snapshot: UpdateSnapshot
}

function classify(error: unknown): UpdateFailure {
  if (error instanceof UpdateCheckError) return error.failure
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes("abort") || message.includes("cancel")) {
    return { kind: "cancelled", code: "aborted" }
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return { kind: "timeout", code: "request_timeout", recoveryActionKey: "retry" }
  }
  if (message.includes("signature") || message.includes("minisign") || message.includes("pubkey")) {
    return { kind: "signature", code: "bad_signature", recoveryActionKey: "contactSupport" }
  }
  if (message.includes("expired")) {
    return { kind: "expired", code: "metadata_expired", recoveryActionKey: "retryLater" }
  }
  if (message.includes("rollback")) {
    return { kind: "rollback", code: "rollback_refused", recoveryActionKey: "contactSupport" }
  }
  if (message.includes("revoked")) {
    return { kind: "revoked", code: "release_revoked", recoveryActionKey: "retryLater" }
  }
  if (
    message.includes("permission") ||
    message.includes("not allowed") ||
    message.includes("acl")
  ) {
    return { kind: "permission", code: "permission_denied", recoveryActionKey: "reviewPermissions" }
  }
  if (message.includes("space") || message.includes("disk") || message.includes("enospc")) {
    return { kind: "disk", code: "insufficient_space", recoveryActionKey: "freeSpace" }
  }
  if (message.includes("incompatible") || message.includes("unsupported version")) {
    return { kind: "incompatible", code: "incompatible", recoveryActionKey: "updateHost" }
  }
  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("dns") ||
    message.includes("offline") ||
    message.includes("connection")
  ) {
    return { kind: "network", code: "network_unreachable", recoveryActionKey: "retry" }
  }
  return { kind: "unknown", code: "unknown", recoveryActionKey: "retry" }
}

export class UpdateCoordinator {
  private readonly deps: Required<
    Pick<CoordinatorDeps, "adapters" | "persistence" | "fetchCatalog">
  > &
    CoordinatorDeps
  private readonly rows = new Map<string, InternalRow>()
  private readonly listeners = new Set<() => void>()
  private readonly applyInFlight = new Map<string, Promise<UpdateItem>>()
  private sweepInFlight: Promise<UpdateItem[]> | null = null
  private cachedView: UpdateItem[] = []
  private viewDirty = true
  private restored = false
  private disposed = false
  private bucket: number | undefined
  private readonly lifetime = new AbortController()
  private readonly adapterNextCheckAt = new Map<UpdateAssetKind, number>()

  constructor(deps: CoordinatorDeps) {
    this.deps = deps as UpdateCoordinator["deps"]
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private random(): number {
    return (this.deps.random ?? Math.random)()
  }

  private intervalMs(): number {
    return this.deps.checkIntervalMs?.() ?? DEFAULT_CHECK_INTERVAL_MS
  }

  private settings(): UpdateCenterSettings {
    try {
      return { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...this.deps.persistence.read() }
    } catch {
      return { ...DEFAULT_UPDATE_CENTER_SETTINGS }
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.viewDirty = true
    for (const listener of this.listeners) listener()
  }

  private track(event: UpdateTelemetryEvent): void {
    if (this.disposed) return
    try {
      this.deps.telemetry?.(sanitizeTelemetryEvent(event))
    } catch (error) {
      this.deps.onError?.("telemetry", error)
    }
  }

  private async persistSnapshot(row: InternalRow): Promise<void> {
    if (this.disposed) return
    try {
      await this.deps.persistence.writeSnapshots({ [row.key]: row.snapshot })
    } catch (error) {
      this.deps.onError?.("persist", error)
    }
  }

  /** Adapters that apply on this host. */
  supportedAdapters(): UpdateAdapter[] {
    return this.deps.adapters.filter((adapter) => {
      try {
        return adapter.isSupported()
      } catch {
        return false
      }
    })
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stable, memoized snapshot for `useSyncExternalStore`. */
  getItems(): UpdateItem[] {
    if (this.viewDirty) {
      this.cachedView = [...this.rows.values()].map(({ snapshot: _snapshot, ...item }) => item)
      this.viewDirty = false
    }
    return this.cachedView
  }

  getItem(key: string): UpdateItem | undefined {
    return this.rows.get(key)
  }

  /** Rollout bucket for this device, generated and persisted on first use. */
  rolloutBucket(): number {
    if (this.bucket !== undefined) return this.bucket
    const settings = this.settings()
    const normalized = normalizeRolloutBucket(settings.rolloutBucket, () => this.random())
    this.bucket = normalized
    if (!this.disposed && normalized !== settings.rolloutBucket) {
      void this.deps.persistence
        .write({ rolloutBucket: normalized })
        .catch((error) => this.deps.onError?.("persist", error))
    }
    return normalized
  }

  private ensureRow(
    kind: UpdateAssetKind,
    assetId: string,
    executor: UpdateItem["executor"]
  ): InternalRow {
    const key = updateSnapshotKey(kind, assetId)
    const existing = this.rows.get(key)
    if (existing) return existing
    const persisted = this.settings().snapshots?.[key]
    const snapshot: UpdateSnapshot = persisted ?? { assetId, kind, state: "current" }
    const row: InternalRow = {
      key,
      assetId,
      kind,
      executor,
      state: snapshot.state,
      candidate: null,
      currentVersion: null,
      action: null,
      externallyInstalled: !isInAppExecutor(executor),
      lastCheckedAt: snapshot.lastCheckedAt,
      skippedVersion: snapshot.skippedVersion,
      deferredUntil: snapshot.deferredUntil,
      failure: snapshot.failure,
      snapshot,
    }
    this.rows.set(key, row)
    return row
  }

  private setState(row: InternalRow, next: UpdateState, patch: Partial<InternalRow> = {}): boolean {
    if (this.disposed) return false
    if (!canTransitionUpdateState(row.state, next)) {
      this.deps.onError?.("transition", new Error(`illegal ${row.state} to ${next} for ${row.key}`))
      return false
    }
    row.state = next
    row.snapshot = { ...row.snapshot, state: next }
    Object.assign(row, patch)
    this.emit()
    return true
  }

  private isApplying(row: InternalRow): boolean {
    return (
      this.applyInFlight.has(row.key) || row.state === "installing" || row.state === "downloading"
    )
  }

  private isAwaitingRestart(row: InternalRow): boolean {
    return row.state === "awaiting-restart"
  }

  private adapterDue(adapter: UpdateAdapter, now: number): boolean {
    const rows = [...this.rows.values()].filter((row) => row.kind === adapter.kind)
    return rows.length > 0
      ? rows.some((row) => isCheckDue(now, row.snapshot.nextCheckAt))
      : isCheckDue(now, this.adapterNextCheckAt.get(adapter.kind))
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
  }

  /**
   * Reconcile persisted state at boot. A desktop attempt that was mid-install
   * when the process died is resolved here against the version actually
   * running, which is the only honest way to tell "installed" from "died".
   */
  async restore(): Promise<void> {
    if (this.disposed || this.restored) return
    this.restored = true
    const settings = this.settings()
    const snapshots = settings.snapshots ?? {}
    const patched: Record<string, UpdateSnapshot> = {}

    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (!snapshot || typeof snapshot !== "object") continue
      const adapter = this.deps.adapters.find((a) => a.kind === snapshot.kind)
      const row = this.ensureRow(snapshot.kind, snapshot.assetId, adapter?.executor ?? "tauri")
      row.snapshot = snapshot
      row.state = snapshot.state
      row.lastCheckedAt = snapshot.lastCheckedAt
      row.skippedVersion = snapshot.skippedVersion
      row.deferredUntil = snapshot.deferredUntil
      row.failure = snapshot.failure

      const unfinished =
        snapshot.state === "installing" ||
        snapshot.state === "downloading" ||
        snapshot.state === "awaiting-restart"
      if (!unfinished || snapshot.kind !== "desktop") continue

      const running = this.deps.appVersion
      if (running && snapshot.targetVersion && running === snapshot.targetVersion) {
        row.state = "verified"
        row.snapshot = { ...snapshot, state: "verified", attemptId: undefined, failure: undefined }
        this.track({
          attemptId: snapshot.attemptId ?? newAttemptId(),
          kind: snapshot.kind,
          executor: row.executor,
          channel: settings.channel,
          fromVersion: snapshot.fromVersion ?? null,
          toVersion: snapshot.targetVersion ?? null,
          phase: "verified",
          outcome: "succeeded",
          durationMs: snapshot.startedAt ? this.now() - snapshot.startedAt : undefined,
        })
      } else {
        const failure: UpdateFailure = {
          kind: "unknown",
          code: "install_interrupted",
          recoveryActionKey: "retryInstall",
        }
        row.state = "failed"
        row.failure = failure
        row.snapshot = { ...snapshot, state: "failed", failure }
        this.track({
          attemptId: snapshot.attemptId ?? newAttemptId(),
          kind: snapshot.kind,
          executor: row.executor,
          channel: settings.channel,
          fromVersion: snapshot.fromVersion ?? null,
          toVersion: snapshot.targetVersion ?? null,
          phase: "failed",
          outcome: "failed",
          errorKind: failure.kind,
          errorCode: failure.code,
        })
      }
      patched[key] = row.snapshot
    }

    if (!this.disposed && Object.keys(patched).length > 0) {
      try {
        await this.deps.persistence.writeSnapshots(patched)
      } catch (error) {
        this.deps.onError?.("persist", error)
      }
    }
    this.emit()
  }

  /**
   * Sweep every supported adapter. Concurrent callers share one sweep, so a
   * boot check and a user tapping Check cannot double-hit the endpoint.
   */
  check(options: CheckOptions = {}): Promise<UpdateItem[]> {
    if (this.disposed) return Promise.resolve(this.getItems())
    if (this.sweepInFlight && !options.manual) return this.sweepInFlight
    if (this.sweepInFlight) return this.sweepInFlight
    const task = this.runCheck(options).finally(() => {
      this.sweepInFlight = null
    })
    this.sweepInFlight = task
    return task
  }

  private async runCheck(options: CheckOptions): Promise<UpdateItem[]> {
    await this.restore()
    if (this.disposed) return this.getItems()
    const manual = options.manual ?? false
    const settings = this.settings()
    const now = this.now()
    const adapters = this.supportedAdapters().filter(
      (adapter) =>
        (!options.kind || adapter.kind === options.kind) &&
        (manual || this.adapterDue(adapter, now))
    )
    if (adapters.length === 0) return this.getItems()
    const bucket = this.rolloutBucket()
    const signal = this.signal(options.signal)

    let outcome: CatalogFetchResult
    try {
      outcome = await this.deps.fetchCatalog({
        channel: settings.channel,
        signal,
      })
    } catch (error) {
      this.deps.onError?.("catalog", error)
      outcome = { status: "unavailable", error }
    }
    if (this.disposed) return this.getItems()
    const retryAfterMs = outcome.status === "unconfigured" ? undefined : outcome.retryAfterMs

    // Mark known rows as checking so the UI can show progress. New rows appear
    // only once the adapter answers, which is why this cannot be the only way
    // into `available`.
    for (const row of this.rows.values()) {
      if (!adapters.some((adapter) => adapter.kind === row.kind)) continue
      if (this.isApplying(row) || this.isAwaitingRestart(row)) continue
      this.setState(row, "checking")
    }

    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          const candidates = await adapter.check({
            channel: settings.channel,
            rolloutBucket: bucket,
            manual,
            catalog: outcome.status === "ok" ? outcome.entries : null,
            catalogStatus: outcome.status,
            catalogError: outcome.status === "unavailable" ? outcome.error : undefined,
            signal,
          })
          if (this.disposed) return
          this.absorb(adapter, candidates, { manual, bucket, now: this.now(), settings })
        } catch (error) {
          if (this.disposed) return
          this.recordCheckFailure(adapter, error, { now: this.now(), retryAfterMs })
        }
      })
    )

    await this.flushSnapshots()
    this.emit()
    return this.getItems()
  }

  private absorb(
    adapter: UpdateAdapter,
    candidates: readonly UpdateCandidate[],
    context: { manual: boolean; bucket: number; now: number; settings: UpdateCenterSettings }
  ): void {
    if (this.disposed) return
    const { manual, bucket, now, settings } = context
    const seen = new Set<string>()

    for (const candidate of candidates) {
      const row = this.ensureRow(candidate.kind, candidate.assetId, candidate.executor)
      seen.add(row.key)
      if (this.isApplying(row) || this.isAwaitingRestart(row)) continue
      if (candidate.displayName) row.displayName = candidate.displayName
      row.currentVersion = candidate.currentVersion
      row.lastCheckedAt = now
      row.snapshot = {
        ...row.snapshot,
        lastCheckedAt: now,
        consecutiveFailures: 0,
        nextCheckAt: now + this.intervalMs(),
        failure: undefined,
      }
      row.failure = undefined

      if (candidate.provenance !== "verified" && candidate.source === "catalog") {
        const failure: UpdateFailure = {
          kind: candidate.provenance === "revoked" ? "revoked" : "signature",
          code: `provenance_${candidate.provenance}`,
          recoveryActionKey: "retryLater",
        }
        row.failure = failure
        row.snapshot = { ...row.snapshot, failure }
        this.setState(row, "failed", { candidate: null, action: null })
        continue
      }

      const verdict = rolloutVerdict(candidate.rollout, bucket, { manual })
      if (verdict !== "offered") {
        this.setState(row, "current", { candidate: null, action: null })
        continue
      }

      if (
        row.snapshot.skippedVersion === candidate.targetVersion &&
        candidate.criticality !== "critical"
      ) {
        this.setState(row, "current", { candidate: null, action: null })
        continue
      }

      const deferredActive =
        row.snapshot.deferredVersion === candidate.targetVersion &&
        (row.snapshot.deferredUntil ?? 0) > now
      if (deferredActive && !manual) {
        this.setState(row, "deferred", { candidate, action: null })
        continue
      }

      row.candidate = candidate
      row.action = candidate.action ?? EXECUTOR_PRIMARY_ACTION[candidate.executor]
      row.externalUrl = candidate.externalUrl
      row.externallyInstalled = !isInAppExecutor(candidate.executor)
      this.setState(row, "available", { candidate, action: row.action })

      const backgroundEligible =
        candidate.kind === "desktop" &&
        candidate.executor === "tauri" &&
        isInAppExecutor(candidate.executor) &&
        candidate.action !== "open-store" &&
        settings.backgroundDownloadDesktop &&
        !candidate.permissionsExpanded
      if (backgroundEligible) {
        void this.apply(row.key, { consented: true, downloadOnly: true }).catch((error) =>
          this.deps.onError?.("background-download", error)
        )
      }
    }

    // An asset the adapter no longer reports is current again.
    for (const row of this.rows.values()) {
      if (row.kind !== adapter.kind || this.isApplying(row)) continue
      if (this.isAwaitingRestart(row)) {
        row.lastCheckedAt = now
        row.snapshot = {
          ...row.snapshot,
          lastCheckedAt: now,
          consecutiveFailures: 0,
          nextCheckAt: now + this.intervalMs(),
        }
        continue
      }
      if (seen.has(row.key)) continue
      row.candidate = null
      row.action = null
      row.lastCheckedAt = now
      row.failure = undefined
      row.snapshot = {
        ...row.snapshot,
        lastCheckedAt: now,
        consecutiveFailures: 0,
        nextCheckAt: now + this.intervalMs(),
        failure: undefined,
      }
      this.setState(row, "current")
    }
    this.adapterNextCheckAt.set(adapter.kind, now + this.intervalMs())
  }

  private recordCheckFailure(
    adapter: UpdateAdapter,
    error: unknown,
    context: { now: number; retryAfterMs?: number }
  ): void {
    if (this.disposed) return
    const failure = classify(error)
    const rows = [...this.rows.values()].filter((row) => row.kind === adapter.kind)
    const targets =
      rows.length > 0 ? rows : [this.ensureRow(adapter.kind, adapter.kind, adapter.executor)]
    for (const row of targets) {
      if (this.isApplying(row)) continue
      const consecutiveFailures = (row.snapshot.consecutiveFailures ?? 0) + 1
      const delay = backoffDelayMs({
        consecutiveFailures,
        intervalMs: this.intervalMs(),
        retryAfterMs: context.retryAfterMs,
        random: () => this.random(),
      })
      row.snapshot = {
        ...row.snapshot,
        consecutiveFailures,
        lastCheckedAt: context.now,
        nextCheckAt: context.now + delay,
        failure: this.isAwaitingRestart(row) ? row.failure : failure,
      }
      row.lastCheckedAt = context.now
      if (this.isAwaitingRestart(row)) continue
      row.failure = failure
      this.setState(row, "failed")
    }
    this.deps.onError?.(`check:${adapter.kind}`, error)
  }

  /** True when the automatic sweep is allowed to run right now. */
  isSweepDue(): boolean {
    return (
      !this.disposed &&
      this.supportedAdapters().some((adapter) => this.adapterDue(adapter, this.now()))
    )
  }

  /**
   * Act on one row. `consented` is required for anything that is not a
   * first-party desktop package with unchanged permissions.
   */
  apply(key: string, options: UpdateApplyContext = { consented: false }): Promise<UpdateItem> {
    const inFlight = this.applyInFlight.get(key)
    if (inFlight) return inFlight
    const task = this.runApply(key, options).finally(() => this.applyInFlight.delete(key))
    this.applyInFlight.set(key, task)
    return task
  }

  private async runApply(key: string, options: UpdateApplyContext): Promise<UpdateItem> {
    const row = this.rows.get(key)
    if (!row) throw new Error(`unknown update row ${key}`)
    if (this.disposed) return row
    if (row.state === "awaiting-restart") {
      const desktop = this.supportedAdapters().find((adapter) => adapter.kind === "desktop")
      try {
        if (!desktop?.restart) throw new Error("desktop restart unavailable")
        await desktop.restart()
        if (this.disposed) return row
        row.failure = undefined
      } catch (error) {
        if (this.disposed) return row
        row.failure = { kind: "unknown", code: "relaunch", recoveryActionKey: "retry" }
        this.deps.onError?.("relaunch", error)
      }
      row.snapshot = { ...row.snapshot, failure: row.failure }
      this.emit()
      await this.persistSnapshot(row)
      return row
    }
    const candidate = row.candidate
    if (!candidate) return row

    const settings = this.settings()
    const requiresConsent =
      candidate.permissionsExpanded === true ||
      candidate.compatibility?.breaking === true ||
      candidate.kind === "skill" ||
      candidate.kind === "cli" ||
      candidate.action === "open-store" ||
      !isInAppExecutor(candidate.executor)

    if (requiresConsent && !options.consented) {
      this.setState(row, "awaiting-consent", {
        action: candidate.permissionsExpanded ? "review-permissions" : row.action,
      })
      return row
    }

    const adapter = this.deps.adapters.find(
      (a) => a.kind === candidate.kind && a.executor === candidate.executor
    )
    if (!adapter) {
      const failure: UpdateFailure = { kind: "unsupported", code: "no_adapter" }
      row.failure = failure
      row.snapshot = { ...row.snapshot, failure }
      this.setState(row, "failed")
      await this.persistSnapshot(row)
      return row
    }

    const nextState: UpdateState = options.downloadOnly ? "downloading" : "installing"
    if (!this.setState(row, nextState, { progress: undefined })) return row
    const attemptId = row.snapshot.attemptId ?? newAttemptId()
    const startedAt = this.now()
    row.snapshot = {
      ...row.snapshot,
      attemptId,
      fromVersion: candidate.currentVersion ?? undefined,
      targetVersion: candidate.targetVersion,
      startedAt,
    }
    // Written before any bytes move so a crash mid-install is recognisable.
    await this.persistSnapshot(row)
    if (this.disposed) return row

    this.track({
      attemptId,
      kind: candidate.kind,
      executor: candidate.executor,
      channel: settings.channel,
      fromVersion: candidate.currentVersion,
      toVersion: candidate.targetVersion,
      phase: nextState,
      outcome: "started",
    })

    try {
      let downloadedBytes: number | undefined
      const result = await adapter.apply(candidate, {
        consented: options.consented || !requiresConsent,
        downloadOnly: options.downloadOnly,
        signal: this.signal(options.signal),
        onProgress: (downloaded, total) => {
          if (this.disposed) return
          downloadedBytes = downloaded
          row.progress = { downloaded, total }
          options.onProgress?.(downloaded, total)
          this.emit()
        },
      })
      if (this.disposed) return row
      row.progress = undefined
      if (!this.setState(row, result.state)) {
        throw new UpdateCheckError({
          kind: "unknown",
          code: "illegal_result_state",
          recoveryActionKey: "retry",
        })
      }
      row.command = result.command
      row.externalUrl = result.externalUrl ?? row.externalUrl
      row.failure = result.failure
      row.snapshot = { ...row.snapshot, failure: result.failure }
      if (result.state === "verified") {
        row.candidate = null
        row.action = null
        row.currentVersion = candidate.targetVersion
        row.snapshot = { ...row.snapshot, attemptId: undefined }
      }
      if (result.state === "current") {
        row.candidate = null
        row.action = null
        row.snapshot = { ...row.snapshot, attemptId: undefined }
      }
      if (result.state === "awaiting-restart") {
        row.action = this.supportedAdapters().some((adapter) => adapter.kind === "desktop")
          ? "restart-desktop"
          : null
      }
      this.emit()
      await this.persistSnapshot(row)
      this.track({
        attemptId,
        kind: candidate.kind,
        executor: candidate.executor,
        channel: settings.channel,
        fromVersion: candidate.currentVersion,
        toVersion: candidate.targetVersion,
        phase: result.state,
        durationMs: this.now() - startedAt,
        // Read from the local tally: `row.progress` is cleared above, so
        // reading it here would always report nothing transferred.
        bytes: downloadedBytes,
        outcome: result.failure
          ? "failed"
          : isInAppExecutor(candidate.executor)
            ? "succeeded"
            : "handed-off",
        errorKind: result.failure?.kind,
        errorCode: result.failure?.code,
      })
      return row
    } catch (error) {
      if (this.disposed) return row
      const failure = classify(error)
      row.progress = undefined
      row.failure = failure
      row.snapshot = { ...row.snapshot, failure }
      this.setState(row, failure.kind === "cancelled" ? "cancelled" : "failed")
      await this.persistSnapshot(row)
      this.track({
        attemptId,
        kind: candidate.kind,
        executor: candidate.executor,
        channel: settings.channel,
        fromVersion: candidate.currentVersion,
        toVersion: candidate.targetVersion,
        phase: "failed",
        durationMs: this.now() - startedAt,
        outcome: failure.kind === "cancelled" ? "cancelled" : "failed",
        errorKind: failure.kind,
        errorCode: failure.code,
      })
      return row
    }
  }

  /**
   * Never be told about this version again. Refused for critical updates,
   * which may only be deferred.
   */
  async skip(key: string): Promise<boolean> {
    if (this.disposed) return false
    const row = this.rows.get(key)
    if (!row?.candidate) return false
    if (row.candidate.criticality === "critical") return false
    row.snapshot = { ...row.snapshot, skippedVersion: row.candidate.targetVersion }
    row.skippedVersion = row.candidate.targetVersion
    row.candidate = null
    row.action = null
    this.setState(row, "current")
    await this.persistSnapshot(row)
    return true
  }

  /** Postpone. Critical updates come back sooner than routine ones. */
  async defer(key: string, durationMs?: number): Promise<boolean> {
    if (this.disposed) return false
    const row = this.rows.get(key)
    if (!row?.candidate) return false
    const critical = row.candidate.criticality === "critical"
    const hold = durationMs ?? (critical ? CRITICAL_DEFER_MS : DEFAULT_DEFER_MS)
    const until = this.now() + hold
    row.snapshot = {
      ...row.snapshot,
      deferredVersion: row.candidate.targetVersion,
      deferredUntil: until,
    }
    row.deferredUntil = until
    this.setState(row, "deferred", { action: null })
    await this.persistSnapshot(row)
    return true
  }

  /** Undo a skip or a defer so the row is offered on the next check. */
  async clearHold(key: string): Promise<void> {
    if (this.disposed) return
    const row = this.rows.get(key)
    if (!row) return
    row.snapshot = {
      ...row.snapshot,
      skippedVersion: undefined,
      deferredVersion: undefined,
      deferredUntil: undefined,
      nextCheckAt: undefined,
    }
    row.skippedVersion = undefined
    row.deferredUntil = undefined
    this.emit()
    await this.persistSnapshot(row)
  }

  private async flushSnapshots(): Promise<void> {
    if (this.disposed) return
    const snapshots: Record<string, UpdateSnapshot> = {}
    for (const row of this.rows.values()) snapshots[row.key] = row.snapshot
    try {
      await this.deps.persistence.writeSnapshots(snapshots)
    } catch (error) {
      this.deps.onError?.("persist", error)
    }
  }

  /** Retire this account lifetime, including work whose backend ignores abort. */
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    this.listeners.clear()
    this.rows.clear()
    this.viewDirty = true
  }

  /** Test-only reset of in-memory state. */
  __reset(): void {
    this.rows.clear()
    this.applyInFlight.clear()
    this.sweepInFlight = null
    this.restored = false
    this.emit()
  }
}
