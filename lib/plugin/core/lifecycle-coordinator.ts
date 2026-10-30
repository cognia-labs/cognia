import type { PluginActualState, PluginDirtyDiagnostic, PluginIntent } from "./lifecycle-state"

export interface PluginActivationLease {
  managerId: string
  pluginId: string
  generation: number
}

export interface PluginLifecycleEffectSnapshot {
  active: number
  pending: number
  failed: number
  labels: string[]
}

export interface PluginLifecycleCoordinatorSnapshot {
  managerId: string
  pluginId: string
  generation: number
  intent: PluginIntent
  actual: PluginActualState
  stateSince: number
  requiredServices: string[]
  providedServices: string[]
  currentProviders: string[]
  effects: PluginLifecycleEffectSnapshot
  dirty?: PluginDirtyDiagnostic
  pendingTransition?: string
  lastError?: string
  packageRevision?: string
  source?: string
  configRevision?: number
}

type SnapshotListener = (snapshot: readonly PluginLifecycleCoordinatorSnapshot[]) => void

export interface PluginGraphReservation {
  managerId: string
  pluginId: string
  token: number
}

export interface PluginIntentPauseSnapshot {
  intent: PluginIntent
  resume: boolean
  suspended: boolean
}

export interface PluginIntentPauseOperations {
  snapshot(): Promise<PluginIntentPauseSnapshot>
  pause(): Promise<void>
  restore(snapshot: PluginIntentPauseSnapshot): Promise<void>
  commit(): void | Promise<void>
}

export interface PluginIntentPauseLease {
  isCurrent(): boolean
  willResume(): boolean
  pause(): Promise<void>
  restore(): Promise<void>
  commit(): Promise<void>
}

interface IntentPauseState {
  managerId: string
  pluginId: string
  snapshot?: PluginIntentPauseSnapshot
  operations: PluginIntentPauseOperations
  holders: Set<symbol>
  current: boolean
  committed: boolean
  paused: boolean
  failure?: AggregateError
}

export class PluginActivationConflictError extends Error {
  constructor(
    readonly pluginId: string,
    readonly ownerManagerId: string
  ) {
    super(`Plugin ${pluginId} is already active in manager ${ownerManagerId}`)
    this.name = "PluginActivationConflictError"
  }
}

export class PluginProviderDrainingError extends Error {
  constructor(readonly pluginId: string) {
    super(`Plugin dependency ${pluginId} is draining`)
    this.name = "PluginProviderDrainingError"
  }
}

export class PluginLifecycleCoordinator {
  private readonly leases = new Map<string, PluginActivationLease>()
  private readonly generations = new Map<string, number>()
  private readonly drainingProviders = new Map<string, PluginGraphReservation>()
  private readonly reservationDepth = new Map<string, number>()
  private readonly diagnosticSnapshots = new Map<string, PluginLifecycleCoordinatorSnapshot>()
  private readonly snapshotListeners = new Set<SnapshotListener>()
  private readonly intentQueues = new Map<string, Promise<void>>()
  private readonly intentOperations = new Map<string, Map<string, number>>()
  private readonly intentPauses = new Map<string, IntentPauseState>()
  private readonly activeIntentPauses = new Set<IntentPauseState>()
  private reservationSequence = 0

  /** Serialize decisions and their publication, not only runtime teardown. */
  async withIntentTransition<T>(
    managerId: string,
    pluginId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    let pending = this.intentOperations.get(managerId)
    if (!pending) {
      pending = new Map()
      this.intentOperations.set(managerId, pending)
    }
    pending.set(pluginId, (pending.get(pluginId) ?? 0) + 1)
    const run = (this.intentQueues.get(pluginId) ?? Promise.resolve()).then(operation)
    const tail = run.then(
      () => {},
      () => {}
    )
    this.intentQueues.set(pluginId, tail)
    try {
      return await run
    } finally {
      const count = (pending.get(pluginId) ?? 1) - 1
      if (count) pending.set(pluginId, count)
      else pending.delete(pluginId)
      if (!pending.size) this.intentOperations.delete(managerId)
      if (this.intentQueues.get(pluginId) === tail) this.intentQueues.delete(pluginId)
    }
  }

  /** A successful external intent write supersedes every older pause owner. */
  invalidateIntentPause(pluginId: string): void {
    const pause = this.intentPauses.get(pluginId)
    if (pause) pause.current = false
  }

  getIntentOperationPluginIds(managerId: string): string[] {
    return [
      ...new Set([
        ...(this.intentOperations.get(managerId)?.keys() ?? []),
        ...[...this.activeIntentPauses]
          .filter((pause) => pause.managerId === managerId && pause.holders.size > 0)
          .map((pause) => pause.pluginId),
      ]),
    ]
  }

  async acquireIntentPause(
    managerId: string,
    pluginId: string,
    operations: PluginIntentPauseOperations,
    options: { deferred?: boolean } = {}
  ): Promise<PluginIntentPauseLease> {
    return this.withIntentTransition(managerId, pluginId, async () => {
      let state = this.intentPauses.get(pluginId)
      if (state?.current && state.managerId !== managerId) {
        throw new PluginActivationConflictError(pluginId, state.managerId)
      }
      const token = Symbol(pluginId)
      if (state?.current) {
        state.holders.add(token)
      } else {
        state = {
          managerId,
          pluginId,
          operations,
          holders: new Set([token]),
          current: true,
          committed: false,
          paused: false,
        }
        this.intentPauses.set(pluginId, state)
        this.activeIntentPauses.add(state)
      }
      const pause = state
      if (!options.deferred) {
        try {
          await this.pauseIntentState(pause)
        } catch (error) {
          pause.holders.delete(token)
          if (!pause.holders.size) this.finishIntentPause(pause)
          throw error
        }
      }
      let released = false
      const owns = () => pause.current && this.intentPauses.get(pluginId) === pause
      const release = async (commit: boolean) => {
        if (released) return
        released = true
        await this.withIntentTransition(managerId, pluginId, async () => {
          pause.holders.delete(token)
          const errors: unknown[] = []
          try {
            if (commit && owns() && !pause.committed) {
              try {
                await this.pauseIntentState(pause)
                await pause.operations.commit()
                pause.committed = true
              } catch (error) {
                errors.push(error)
              }
            }
            if (
              !pause.holders.size &&
              owns() &&
              !pause.committed &&
              pause.paused &&
              pause.snapshot
            ) {
              try {
                await pause.operations.restore(pause.snapshot)
              } catch (error) {
                errors.push(error)
              }
            }
          } finally {
            if (!pause.holders.size) this.finishIntentPause(pause)
          }
          if (errors.length) throw new AggregateError(errors, "restoreFailed")
        })
      }
      return {
        isCurrent: () => !released && owns(),
        willResume: () =>
          !released && owns() && !pause.committed && Boolean(pause.snapshot?.resume),
        pause: () =>
          this.withIntentTransition(managerId, pluginId, async () => {
            if (!released && owns()) await this.pauseIntentState(pause)
          }),
        restore: () => release(false),
        commit: () => release(true),
      }
    })
  }

  private async pauseIntentState(pause: IntentPauseState): Promise<void> {
    if (!pause.current || this.intentPauses.get(pause.pluginId) !== pause) return
    if (pause.failure) throw pause.failure
    if (pause.paused) return
    const snapshot = await pause.operations.snapshot()
    pause.snapshot = snapshot
    pause.paused = true
    try {
      await pause.operations.pause()
    } catch (error) {
      try {
        await pause.operations.restore(snapshot)
        pause.paused = false
        pause.snapshot = undefined
      } catch (restoreError) {
        // Other holders must not treat a partially compensated pause as a
        // completed disabled decision. The last release may retry restoration.
        pause.failure = new AggregateError([error, restoreError], "restoreFailed")
        throw pause.failure
      }
      throw error
    }
  }

  private finishIntentPause(pause: IntentPauseState): void {
    this.activeIntentPauses.delete(pause)
    if (this.intentPauses.get(pause.pluginId) === pause) this.intentPauses.delete(pause.pluginId)
  }

  acquire(managerId: string, pluginId: string): PluginActivationLease {
    const current = this.leases.get(pluginId)
    if (current) {
      throw new PluginActivationConflictError(pluginId, current.managerId)
    }
    const generation = (this.generations.get(pluginId) ?? 0) + 1
    this.generations.set(pluginId, generation)
    const lease = { managerId, pluginId, generation }
    this.leases.set(pluginId, lease)
    return lease
  }

  isCurrent(lease: PluginActivationLease): boolean {
    const current = this.leases.get(lease.pluginId)
    return Boolean(
      current && current.managerId === lease.managerId && current.generation === lease.generation
    )
  }

  release(lease: PluginActivationLease): boolean {
    if (!this.isCurrent(lease)) return false
    this.leases.delete(lease.pluginId)
    return true
  }

  get(pluginId: string): PluginActivationLease | undefined {
    return this.leases.get(pluginId)
  }

  reserveProviderDrain(managerId: string, pluginId: string): PluginGraphReservation {
    const current = this.drainingProviders.get(pluginId)
    if (current) {
      if (current.managerId !== managerId) throw new PluginProviderDrainingError(pluginId)
      this.reservationDepth.set(pluginId, (this.reservationDepth.get(pluginId) ?? 1) + 1)
      return current
    }
    this.reservationSequence += 1
    const reservation = { managerId, pluginId, token: this.reservationSequence }
    this.drainingProviders.set(pluginId, reservation)
    this.reservationDepth.set(pluginId, 1)
    return reservation
  }

  releaseProviderDrain(reservation: PluginGraphReservation): boolean {
    const current = this.drainingProviders.get(reservation.pluginId)
    if (
      !current ||
      current.managerId !== reservation.managerId ||
      current.token !== reservation.token
    ) {
      return false
    }
    const depth = this.reservationDepth.get(reservation.pluginId) ?? 1
    if (depth > 1) {
      this.reservationDepth.set(reservation.pluginId, depth - 1)
      return true
    }
    this.reservationDepth.delete(reservation.pluginId)
    this.drainingProviders.delete(reservation.pluginId)
    return true
  }

  isProviderDraining(pluginId: string): boolean {
    return this.drainingProviders.has(pluginId)
  }

  assertProvidersAccepting(pluginIds: Iterable<string>): void {
    for (const pluginId of pluginIds) {
      if (this.isProviderDraining(pluginId)) throw new PluginProviderDrainingError(pluginId)
    }
  }

  updateSnapshot(snapshot: PluginLifecycleCoordinatorSnapshot): boolean {
    const lease = this.leases.get(snapshot.pluginId)
    if (
      lease &&
      (lease.managerId !== snapshot.managerId || lease.generation !== snapshot.generation)
    ) {
      return false
    }
    const existing = this.diagnosticSnapshots.get(snapshot.pluginId)
    if (!lease && existing && existing.generation > snapshot.generation) return false
    this.diagnosticSnapshots.set(snapshot.pluginId, this.sanitizeSnapshot(snapshot))
    this.emitSnapshots()
    return true
  }

  getSnapshot(pluginId: string): PluginLifecycleCoordinatorSnapshot | undefined {
    const snapshot = this.diagnosticSnapshots.get(pluginId)
    return snapshot ? structuredClone(snapshot) : undefined
  }

  snapshot(): PluginLifecycleCoordinatorSnapshot[] {
    return Array.from(this.diagnosticSnapshots.values(), (snapshot) =>
      structuredClone(snapshot)
    ).sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  }

  subscribe(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  private sanitizeSnapshot(
    snapshot: PluginLifecycleCoordinatorSnapshot
  ): PluginLifecycleCoordinatorSnapshot {
    const bounded = (values: readonly string[], limit = 50): string[] =>
      values.slice(0, limit).map((value) => value.slice(0, 128))
    return {
      ...snapshot,
      requiredServices: bounded(snapshot.requiredServices),
      providedServices: bounded(snapshot.providedServices),
      currentProviders: bounded(snapshot.currentProviders),
      effects: {
        active: Math.max(0, snapshot.effects.active),
        pending: Math.max(0, snapshot.effects.pending),
        failed: Math.max(0, snapshot.effects.failed),
        labels: bounded(snapshot.effects.labels, 20),
      },
      ...(snapshot.dirty
        ? {
            dirty: {
              ...snapshot.dirty,
              message: snapshot.dirty.message.slice(0, 512),
              ...(snapshot.dirty.runtimeGeneration
                ? { runtimeGeneration: snapshot.dirty.runtimeGeneration.slice(0, 128) }
                : {}),
              ...(snapshot.dirty.labels ? { labels: bounded(snapshot.dirty.labels, 20) } : {}),
            },
          }
        : {}),
      ...(snapshot.lastError ? { lastError: snapshot.lastError.slice(0, 512) } : {}),
      ...(snapshot.pendingTransition
        ? { pendingTransition: snapshot.pendingTransition.slice(0, 128) }
        : {}),
    }
  }

  private emitSnapshots(): void {
    const snapshot = this.snapshot()
    for (const listener of this.snapshotListeners) listener(snapshot)
  }
}

export const pluginLifecycleCoordinator = new PluginLifecycleCoordinator()
