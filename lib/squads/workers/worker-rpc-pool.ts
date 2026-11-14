import {
  createCogniaClient,
  isAgentWorkerManifestV1,
  RpcFrameSink,
  RpcStreamSource,
  type CogniaClient,
  type RunOptions,
} from "@cognia/agent"
import type { StopProof } from "@cognia/agent-orchestration"
import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"

import {
  evaluateRemoteWorkerPlacement,
  type RemoteWorkerDescriptor,
  type RemoteWorkerOutcome,
  type RemoteWorkerRunInput,
  type RemoteWorkerRuntime,
  type RemoteWorkerLease,
} from "./remote-worker-runtime"

interface WorkerConnection {
  descriptor: RemoteWorkerDescriptor
  readable: RpcStreamSource
  writable: RpcFrameSink
  clientPromise: Promise<CogniaClient>
  detached: AbortController
  sendGuards: Map<
    string,
    {
      check(params: Record<string, unknown>): void
      reject(method: string, error: unknown): void
    }
  >
}

/** How long a strict stop waits for the stopped turn's event tail to project. */
export const STRICT_STOP_DRAIN_TIMEOUT_MS = 10_000

export class WorkerDetachedError extends Error {
  constructor(
    readonly connectionId: string,
    readonly reason: string
  ) {
    super(`Worker connection ${connectionId} detached: ${reason}`)
    this.name = "WorkerDetachedError"
  }
}

export interface WorkerRpcPoolOptions {
  /** Invoke finalize immediately before transport delivery; undefined drops the frame. */
  sendFrame(connectionId: string, frame: string, finalize: () => string | undefined): void
  onWorkersChanged?(workers: readonly RemoteWorkerDescriptor[]): void
  now?: () => number
  createClient?: typeof createCogniaClient
  /** Bound on draining a stopped turn's event tail. Defaults to {@link STRICT_STOP_DRAIN_TIMEOUT_MS}. */
  strictStopDrainTimeoutMs?: number
}

/**
 * Agent RPC stays the runtime protocol; the host only multiplexes frames.
 *
 * One pool serves both brains. The headless brain pushes frames over the bridge
 * socket and the desktop brain pushes them over a Tauri IPC channel, but
 * everything above the wire — session lifecycle, event replay, steering,
 * capacity accounting — is identical, so it lives here exactly once. The
 * transport differences are confined to the injected `sendFrame` and to
 * whichever caller feeds {@link WorkerRpcPool.receive}.
 */
export class WorkerRpcPool implements RemoteWorkerRuntime {
  private readonly workers = new Map<string, WorkerConnection>()
  private readonly now: () => number
  private readonly createClient: typeof createCogniaClient
  private readonly strictStopDrainTimeoutMs: number

  constructor(private readonly options: WorkerRpcPoolOptions) {
    this.now = options.now ?? Date.now
    this.createClient = options.createClient ?? createCogniaClient
    this.strictStopDrainTimeoutMs = options.strictStopDrainTimeoutMs ?? STRICT_STOP_DRAIN_TIMEOUT_MS
  }

  attach(input: { connectionId: string; hostRef: string; manifest: unknown }): boolean {
    if (!isAgentWorkerManifestV1(input.manifest)) return false
    this.detach(input.connectionId, "replaced")
    for (const [connectionId, worker] of this.workers) {
      if (worker.descriptor.hostRef === input.hostRef) this.detach(connectionId, "replaced")
    }
    const readable = new RpcStreamSource()
    const detached = new AbortController()
    const sendGuards: WorkerConnection["sendGuards"] = new Map()
    const writable = new RpcFrameSink((frame) => {
      try {
        const message = sendGuards.size ? JSON.parse(frame) : undefined
        // Retain this run's guard even if it settles before a queued frame leaves.
        const guard =
          message?.method === "turn/run" || message?.method === "dispatch/renew"
            ? sendGuards.get(message.params.sessionId)
            : undefined
        const finalize = () => {
          try {
            detached.signal.throwIfAborted()
            guard?.check(message.params)
            return guard ? JSON.stringify(message) : frame
          } catch (error) {
            // RpcFrameSink must return normally. An error emitted during its
            // write can precede RpcPeer's drain/error subscription and hang it.
            guard?.reject(message.method, error)
            return undefined
          }
        }
        const ready = finalize()
        if (ready !== undefined) this.options.sendFrame(input.connectionId, ready, finalize)
      } catch {
        this.detach(input.connectionId, "send_failed")
      }
    })
    const descriptor: RemoteWorkerDescriptor = {
      connectionId: input.connectionId,
      hostRef: input.hostRef,
      manifest: input.manifest,
      online: true,
      activeTurns: 0,
      lastSeenAt: this.now(),
    }
    const clientPromise = this.createClient({
      host: { kind: "streams", readable, writable },
      requestTimeoutMs: 30_000,
      client: { name: "cognia-worker-pool" },
    })
    clientPromise.catch(() => {
      if (this.workers.get(input.connectionId)?.clientPromise === clientPromise)
        this.detach(input.connectionId, "rpc_initialize_failed")
    })
    this.workers.set(input.connectionId, {
      descriptor,
      readable,
      writable,
      clientPromise,
      detached,
      sendGuards,
    })
    this.notifyWorkersChanged()
    return true
  }

  receive(connectionId: string, frame: string): void {
    const worker = this.workers.get(connectionId)
    if (!worker || frame.includes("\n")) return
    worker.descriptor.lastSeenAt = this.now()
    worker.readable.push(`${frame}\n`)
  }

  detach(connectionId: string, reason: string): void {
    const worker = this.workers.get(connectionId)
    if (!worker) return
    this.workers.delete(connectionId)
    worker.descriptor.online = false
    worker.detached.abort(new WorkerDetachedError(connectionId, reason))
    worker.readable.end()
    worker.writable.end()
    void worker.clientPromise.then((client) => client.close()).catch(() => undefined)
    this.notifyWorkersChanged()
  }

  listWorkers(): readonly RemoteWorkerDescriptor[] {
    return [...this.workers.values()].map(({ descriptor }) => ({
      ...descriptor,
      manifest: { ...descriptor.manifest },
    }))
  }

  async run(input: RemoteWorkerRunInput) {
    if (!hasNoLeakingPiiDeep({ prompt: input.prompt, handoff: input.handoff })) {
      throw new Error("Remote worker dispatch blocked by the PII redaction gate")
    }
    const worker = [...this.workers.values()].find(
      (candidate) => candidate.descriptor.hostRef === input.hostRef
    )
    if (!worker || !worker.descriptor.online) throw new Error(`Worker is offline: ${input.hostRef}`)
    if (worker.descriptor.activeTurns >= worker.descriptor.manifest.maxActiveTurns) {
      throw new Error(`Worker capacity is exhausted: ${input.hostRef}`)
    }
    const assertCompatible = (reserved = false) => {
      worker.detached.signal.throwIfAborted()
      if (!worker.descriptor.online) throw new Error(`Worker is offline: ${input.hostRef}`)
      if (
        worker.descriptor.activeTurns - (reserved ? 1 : 0) >=
        worker.descriptor.manifest.maxActiveTurns
      )
        throw new Error(`Worker capacity is exhausted: ${input.hostRef}`)
      if (input.placementRequirements) {
        const verdict = evaluateRemoteWorkerPlacement(
          { ...worker.descriptor, activeTurns: worker.descriptor.activeTurns - (reserved ? 1 : 0) },
          input.placementRequirements
        )
        if (!verdict.ready) throw new Error(`Worker placement changed: ${verdict.reason}`)
      }
      if (
        input.fence &&
        !worker.descriptor.manifest.hardCapabilities.includes("worker-self-fence-v1")
      )
        throw new Error("Worker placement changed: worker-self-fence-v1 missing")
    }
    assertCompatible()
    worker.descriptor.activeTurns += 1
    this.notifyWorkersChanged()
    const renewalLost = new AbortController()
    const frameRejected = new AbortController()
    const renewalFrameLost = new AbortController()
    const renewalFrameFailure = new Promise<never>((_resolve, reject) => {
      renewalFrameLost.signal.addEventListener(
        "abort",
        () => reject(renewalFrameLost.signal.reason),
        { once: true }
      )
    })
    void renewalFrameFailure.catch(() => undefined)
    const eventFailed = new AbortController()
    const lifetime = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      worker.detached.signal,
      renewalLost.signal,
      frameRejected.signal,
      eventFailed.signal,
    ])
    let rejectLost!: (error: unknown) => void
    const lost = new Promise<never>((_resolve, reject) => {
      rejectLost = reject
    })
    // Observe the shared rejection even when loss happens between operations.
    void lost.catch(() => undefined)
    const onLost = () => rejectLost(lifetime.reason)
    lifetime.addEventListener("abort", onLost, { once: true })
    if (lifetime.aborted) onLost()
    const live = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, lost])
    let eventAbort: AbortController | undefined
    let consumeEvents: Promise<void> | undefined
    /** Event ids whose projection (onEvent) has finished. */
    const projected = new Set<string>()
    let onProjected: (() => void) | undefined
    let guardedSessionId: string | undefined
    let finishTurn: ((clean: boolean) => void) | undefined
    let turnCompleted = false
    let dispatchEnded = false
    try {
      lifetime.throwIfAborted()
      const client = await live(worker.clientPromise)
      assertCompatible(true)
      const fenceCapable =
        worker.descriptor.manifest.hardCapabilities.includes("worker-self-fence-v1") &&
        client.runtime.supports("worker-self-fence-v1")
      if (input.fence && !fenceCapable)
        throw new Error("Worker RPC does not declare worker-self-fence-v1")
      const interruptCapable =
        worker.descriptor.manifest.hardCapabilities.includes("turn-interrupt-v1") &&
        client.runtime.supports("turn-interrupt-v1")
      const recoverySessionId = fenceCapable ? undefined : input.recoverySessionId
      const session = await live(
        recoverySessionId
          ? client.sessions.open(recoverySessionId)
          : client.sessions.create({ commandId: input.commandId, handoff: input.handoff })
      )
      lifetime.throwIfAborted()
      await live(Promise.resolve(input.onSession(session.id)))
      const turnEnded = new Promise<boolean>((resolve) => {
        finishTurn = resolve
      })
      let currentLease = input.fence
      guardedSessionId = session.id
      worker.sendGuards.set(session.id, {
        check: (params) => {
          lifetime.throwIfAborted()
          if (dispatchEnded) throw new Error("Remote dispatch ended before send")
          assertCompatible(true)
          if (currentLease && fenceCapable) {
            const remaining = Math.floor(
              currentLease.lastRenewalSentAt + currentLease.leaseTtlMs - this.now()
            )
            if (remaining <= 0) throw new Error("Remote dispatch lease expired before send")
            if (params.fence)
              params.fence = { ...this.remainingFence(currentLease), leaseTtlMs: remaining }
            else params.leaseTtlMs = remaining
          }
        },
        reject(method, error) {
          if (method === "dispatch/renew") {
            renewalFrameLost.abort(error)
            if (!turnCompleted) renewalLost.abort(error)
          } else frameRejected.abort(error)
        },
      })
      const epoch = input.dispatchEpoch ?? input.fence?.dispatchEpoch
      const drainEvents = async () => {
        eventAbort?.abort()
        if (consumeEvents) await live(consumeEvents)
      }
      // Cancelling the subscription discards events still queued on it, so a
      // consumer that ended is not a drained one. After a strict stop the
      // Worker is idle and its persisted head is final: drained means every
      // event through that head was projected, read before closing anything.
      const drainedThroughHead = async (): Promise<boolean> => {
        // Without a persisted head there is nothing to prove a drain against.
        if (!client.runtime.supports("event-replay-v2")) return false
        let onDetached: (() => void) | undefined
        const page = await Promise.race([
          session.entries({ limit: 1 }),
          new Promise<never>((_resolve, reject) => {
            onDetached = () => reject(worker.detached.signal.reason)
            if (worker.detached.signal.aborted) onDetached()
            else worker.detached.signal.addEventListener("abort", onDetached, { once: true })
          }),
        ]).finally(() => {
          if (onDetached) worker.detached.signal.removeEventListener("abort", onDetached)
        })
        const head = page.headEventId
        const start = recoverySessionId ? input.lastRemoteEventId : undefined
        if (head === undefined || head === start || projected.has(head)) return true
        return new Promise<boolean>((resolve) => {
          const done = (value: boolean) => {
            clearTimeout(timer)
            onProjected = undefined
            lifetime.removeEventListener("abort", fail)
            resolve(value)
          }
          const fail = () => done(false)
          const timer = setTimeout(fail, this.strictStopDrainTimeoutMs)
          lifetime.addEventListener("abort", fail, { once: true })
          if (lifetime.aborted) return fail()
          onProjected = () => {
            if (projected.has(head)) done(true)
          }
          void consumeEvents?.then(
            () => done(projected.has(head)),
            () => done(false)
          )
        })
      }
      // A verified receipt is proof on its own; whether this turn's events
      // drained is reported beside it, because only a pause checkpoint needs
      // them and a cancelled turn must not erase a confirmed stop.
      const stop = async (
        commandId: string,
        completed = false
      ): Promise<{ proof: StopProof; drained: boolean } | undefined> => {
        if (!interruptCapable || epoch === undefined) return undefined
        let onDetached: (() => void) | undefined
        try {
          // Stop RPCs must survive the turn's cancellation signal. Detach still
          // invalidates this control path; neither a close nor silence is proof.
          worker.detached.signal.throwIfAborted()
          const detached = new Promise<never>((_resolve, reject) => {
            onDetached = () => reject(worker.detached.signal.reason)
            worker.detached.signal.addEventListener("abort", onDetached, { once: true })
          })
          const receipt = await Promise.race([
            session.abort({
              commandId,
              targetTurnCommandId: input.commandId,
              dispatchEpoch: epoch,
              timeoutMs: 30_000,
            }),
            detached,
          ])
          worker.detached.signal.throwIfAborted()
          if (!("stopped" in receipt)) return undefined
          const strict = receipt
          if (
            strict.stopped !== true ||
            strict.targetTurnCommandId !== input.commandId ||
            strict.dispatchEpoch !== epoch ||
            strict.sessionStatus !== "idle" ||
            (completed && strict.turnStatus !== "completed")
          )
            return undefined
          const proof = { kind: "ack" as const, epoch, at: this.now() }
          const drained = await drainedThroughHead().catch(() => false)
          // A projection that never returns cannot be cancelled, so only a
          // drained consumer is awaited; an undrained one must not hold the proof.
          if (drained) await drainEvents().catch(() => undefined)
          else eventAbort?.abort()
          return { proof, drained }
        } catch {
          return undefined
        } finally {
          if (onDetached) worker.detached.signal.removeEventListener("abort", onDetached)
        }
      }
      await live(
        Promise.resolve(
          input.onControl({
            async steer(message, commandId) {
              if (!hasNoLeakingPii(message))
                throw new Error("Remote worker steering blocked by the PII redaction gate")
              lifetime.throwIfAborted()
              await live(session.steer(message, { commandId }))
            },
            renew: async (lease) => {
              if (!fenceCapable) return
              const fail = (error: unknown): never => {
                if (!turnCompleted) renewalLost.abort(error)
                throw error
              }
              try {
                lifetime.throwIfAborted()
                currentLease = lease
                const receipt = await live(
                  Promise.race([
                    session
                      .renew(this.remainingFence(lease), {
                        signal: AbortSignal.any([lifetime, renewalFrameLost.signal]),
                      })
                      .then((receipt) => {
                        if (!receipt.renewed) fail(new Error("Remote worker refused lease renewal"))
                        return receipt
                      }, fail),
                    renewalFrameFailure,
                  ])
                )
                if (!receipt.renewed) throw new Error("Remote worker refused lease renewal")
              } catch (error) {
                fail(error)
              }
            },
            async pause(commandId) {
              if (interruptCapable) {
                const stopped = await stop(commandId)
                // An unprojected tail of events makes the checkpoint unsafe,
                // but the confirmed stop is still this epoch's proof.
                if (!stopped) return false
                return stopped.drained
                  ? stopped.proof
                  : { proof: stopped.proof, checkpointSafe: false as const }
              }
              try {
                return await live(turnEnded)
              } catch {
                return false
              }
            },
            async terminate(commandId) {
              if (!interruptCapable) {
                await live(session.abort({ commandId }))
                return undefined
              }
              const proof = (await stop(commandId))?.proof
              if (proof) await live(session.close()).catch(() => undefined)
              return proof
            },
          })
        )
      )
      lifetime.throwIfAborted()
      assertCompatible(true)
      eventAbort = new AbortController()
      const eventsSignal = AbortSignal.any([eventAbort.signal, lifetime])
      consumeEvents = (async () => {
        for await (const event of session.events({
          ...(recoverySessionId && input.lastRemoteEventId
            ? { afterEventId: input.lastRemoteEventId }
            : {}),
          signal: eventsSignal,
        })) {
          lifetime.throwIfAborted()
          await input.onEvent(event)
          projected.add(event.eventId)
          onProjected?.()
        }
      })()
      // Event projection (including its PII gate) is part of dispatch health.
      void consumeEvents.catch((error) => eventFailed.abort(error))
      let outcome: RemoteWorkerOutcome
      try {
        outcome = await live(
          session.run(input.prompt, {
            commandId: input.commandId,
            ...(input.fence && fenceCapable ? { fence: this.remainingFence(input.fence) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            signal: lifetime,
          })
        )
        turnCompleted = outcome.status === "completed"
        if (turnCompleted) input.onTurnCompleted?.()
      } catch (error) {
        finishTurn?.(false)
        throw error
      }
      const recoveryRequired = await live(session.state()).then(
        (state) => state.status === "recovery_required"
      )
      const disposalProof =
        outcome.status === "completed" && !recoveryRequired
          ? (await stop(`${input.commandId}:disposal`, true))?.proof
          : undefined
      if (disposalProof) await input.onDisposalProof?.(disposalProof)
      await drainEvents()
      finishTurn?.(outcome.status === "completed" && !recoveryRequired)
      // Cleanup releases the SDK's session slot even on an old Worker. It is
      // never disposal evidence; only the matching strict receipt is proof.
      if (turnCompleted && !recoveryRequired) await live(session.close()).catch(() => undefined)
      return {
        ...outcome,
        ...(recoveryRequired ? { recoveryRequired: true } : {}),
        ...(disposalProof ? { disposalProof } : {}),
      } satisfies RemoteWorkerOutcome
    } finally {
      dispatchEnded = true
      finishTurn?.(false)
      if (guardedSessionId) worker.sendGuards.delete(guardedSessionId)
      eventAbort?.abort()
      // A disconnected peer is allowed to have an unresponsive event iterator.
      if (consumeEvents) await live(consumeEvents).catch(() => undefined)
      lifetime.removeEventListener("abort", onLost)
      worker.descriptor.activeTurns = Math.max(0, worker.descriptor.activeTurns - 1)
      worker.descriptor.lastSeenAt = this.now()
      this.notifyWorkersChanged()
    }
  }

  private remainingFence(lease: RemoteWorkerLease): NonNullable<RunOptions["fence"]> {
    const now = this.now
    return {
      childRunId: lease.childRunId,
      dispatchEpoch: lease.dispatchEpoch,
      // session.run reads an event cursor before constructing turn/run. A
      // getter defers this subtraction until RPC validation/serialization.
      get leaseTtlMs() {
        const remaining = lease.lastRenewalSentAt + lease.leaseTtlMs - now()
        // Keep RPC validation valid while the transport owns the authoritative
        // expiry check and final TTL subtraction at actual delivery time.
        return Math.max(1, Math.floor(remaining))
      },
    }
  }

  close(): void {
    for (const connectionId of [...this.workers.keys()]) this.detach(connectionId, "shutdown")
  }

  private notifyWorkersChanged(): void {
    this.options.onWorkersChanged?.(this.listWorkers())
  }
}
