import {
  connectorsMatrixCryptoVerification,
  connectorsMatrixCryptoMarkRequestSent,
  type MatrixVerificationInput,
  type MatrixVerificationState,
} from "@/lib/connectors/tauri/commands"
import type { MatrixRequest } from "./e2ee"

/** Explicit interactions only. Never confirm SAS or a QR scan automatically. */
export class MatrixVerification {
  private tail: Promise<unknown> = Promise.resolve()
  private deliveries = new Map<
    string,
    {
      active: () => boolean
      state: MatrixVerificationState
      input: string
    }
  >()
  private refreshed = new Set<string>()

  constructor(
    private readonly options: {
      adapterId: string
      request: MatrixRequest
      capture: () => () => boolean
      flush: () => Promise<void>
      refresh: (userId: string, check: () => void) => Promise<void>
    }
  ) {}

  async pending(userId: string): Promise<MatrixVerificationState[]> {
    const active = this.options.capture()
    if (!active()) throw new Error("Matrix verification adapter is not active")
    const { flows } = await connectorsMatrixCryptoVerification({
      adapterId: this.options.adapterId,
      action: "list",
      userId,
    })
    if (!active()) throw new Error("Matrix verification adapter is not active")
    return flows
  }

  /** Explicit key download after a peer completes asynchronously; never confirms a proof. */
  refreshTrust(userId: string, flowId: string): Promise<MatrixVerificationState> {
    const active = this.options.capture()
    const check = () => {
      if (!active()) throw new Error("Matrix verification adapter is not active")
    }
    const operation = this.tail.then(async () => {
      check()
      const input = { adapterId: this.options.adapterId, action: "status" as const, userId, flowId }
      const state = await connectorsMatrixCryptoVerification(input)
      check()
      if (state.state !== "done") throw new Error("Matrix verification is not complete")
      await this.options.refresh(userId, check)
      check()
      const current = await connectorsMatrixCryptoVerification(input)
      check()
      return { ...current, requests: [] }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  interact(input: MatrixVerificationInput): Promise<MatrixVerificationState> {
    const active = this.options.capture()
    const check = () => {
      if (!active()) throw new Error("Matrix verification adapter is not active")
    }
    const operation = this.tail.then(async () => {
      check()
      for (const [key, delivery] of this.deliveries) {
        if (!delivery.active()) this.deliveries.delete(key)
      }
      const inputKey = JSON.stringify([
        input.action,
        input.userId,
        input.deviceId ?? null,
        input.flowId ?? null,
        input.qrBytes ?? null,
      ])
      const previous = [...this.deliveries.values()].find(
        (delivery) =>
          delivery.state.userId === input.userId &&
          (delivery.state.flowId === input.flowId || delivery.input === inputKey)
      )
      // Reads and cancellation must not replay a failed older handshake.
      if (input.action === "status") {
        const state = await connectorsMatrixCryptoVerification({
          ...input,
          adapterId: this.options.adapterId,
        })
        check()
        return { ...state, requests: [] }
      }
      if (input.action === "cancel" && previous && previous.input !== inputKey) {
        this.deliveries.delete(`${previous.state.userId}\u0000${previous.state.flowId}`)
      } else if (previous) {
        await this.deliver(previous.state, check)
      }
      if (!previous && input.action !== "cancel" && this.deliveries.size >= 128)
        throw new Error("Too many pending Matrix verification deliveries")
      const state =
        previous?.input === inputKey
          ? previous.state
          : await connectorsMatrixCryptoVerification({
              ...input,
              adapterId: this.options.adapterId,
            })
      check()
      const flowKey = `${state.userId}\u0000${state.flowId}`
      this.deliveries.set(flowKey, { active, state, input: inputKey })
      await this.deliver(state, check)
      await this.options.flush()
      check()
      let current = await connectorsMatrixCryptoVerification({
        adapterId: this.options.adapterId,
        action: "status",
        userId: state.userId,
        flowId: state.flowId,
      })
      check()
      const key = `${state.userId}\u0000${state.flowId}`
      if (current.state === "done" && !this.refreshed.has(key)) {
        await this.options.refresh(state.userId, check)
        check()
        current = await connectorsMatrixCryptoVerification({
          adapterId: this.options.adapterId,
          action: "status",
          userId: state.userId,
          flowId: state.flowId,
        })
        check()
        this.refreshed.add(key)
        if (this.refreshed.size > 128) this.refreshed.delete(this.refreshed.values().next().value!)
      }
      this.deliveries.delete(flowKey)
      return { ...current, qrBytes: state.qrBytes, qrImage: state.qrImage, requests: [] }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  clear(): void {
    this.deliveries.clear()
    this.refreshed.clear()
  }

  private async deliver(state: MatrixVerificationState, check: () => void): Promise<void> {
    while (state.requests.length) {
      check()
      const outgoing = state.requests[0]
      if (outgoing.method !== "POST" && outgoing.method !== "PUT")
        throw new Error("Invalid Matrix verification method")
      const response = await this.options.request(outgoing.method, outgoing.path, outgoing.body, {
        maxResponseBytes: 64 * 1024,
      })
      check()
      if (
        outgoing.kind === "signatureUpload" &&
        response.failures &&
        Object.keys(response.failures as object).length
      )
        throw new Error("Matrix verification signatures were rejected")
      await connectorsMatrixCryptoMarkRequestSent({
        adapterId: this.options.adapterId,
        requestId: outgoing.requestId,
        kind: outgoing.kind,
        response,
      })
      check()
      state.requests.shift()
    }
  }
}
