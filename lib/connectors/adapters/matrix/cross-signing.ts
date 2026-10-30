import {
  connectorsMatrixCryptoCrossSigning,
  connectorsMatrixCryptoMarkRequestSent,
  type MatrixCrossSigningStatus,
} from "@/lib/connectors/tauri/commands"
import type { MatrixRequest } from "./e2ee"

export interface MatrixAuthChallenge {
  session: string
  flows: Array<{ stages: string[] }>
  params: Record<string, unknown>
}

/** Preserve only the server's public UIA challenge, never submitted auth. */
export function matrixAuthChallenge(
  body: Record<string, unknown>
): MatrixAuthChallenge | undefined {
  if (
    typeof body.session !== "string" ||
    body.session.length > 4096 ||
    !Array.isArray(body.flows) ||
    body.flows.length > 32
  )
    return undefined
  const flows: Array<{ stages: string[] }> = []
  for (const flow of body.flows) {
    if (
      !flow ||
      typeof flow !== "object" ||
      !Array.isArray(flow.stages) ||
      flow.stages.length > 16 ||
      flow.stages.some((stage: unknown) => typeof stage !== "string" || stage.length > 256)
    )
      return undefined
    flows.push({ stages: flow.stages })
  }
  return {
    session: body.session,
    flows,
    params:
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {},
  }
}

/** Explicit cross-signing never resets an existing identity or exports seeds. */
export class MatrixCrossSigning {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly options: {
      adapterId: string
      userId: string
      deviceId: string
      request: MatrixRequest
      capture: () => () => boolean
      refresh: (check: () => void) => Promise<void>
    }
  ) {}

  private run<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
    const active = this.options.capture()
    const check = () => {
      if (!active()) throw new Error("Matrix cross-signing adapter is not active")
    }
    const result = this.pending.then(async () => {
      check()
      return operation(check)
    })
    this.pending = result.catch(() => undefined)
    return result
  }

  status(userId?: string, deviceId?: string): Promise<MatrixCrossSigningStatus> {
    return this.run(async (check) => {
      const status = await connectorsMatrixCryptoCrossSigning({
        adapterId: this.options.adapterId,
        action: "status",
        userId,
        deviceId,
      })
      check()
      return status
    })
  }

  bootstrap(auth?: Record<string, unknown>): Promise<MatrixCrossSigningStatus> {
    return this.run(async (check) => {
      const response = await this.options.request(
        "POST",
        "/_matrix/client/v3/keys/query",
        {
          device_keys: { [this.options.userId]: [] },
        },
        { maxResponseBytes: 64 * 1024 }
      )
      check()
      const devices = response.device_keys
      const ownDevices =
        devices && typeof devices === "object" && !Array.isArray(devices)
          ? (devices as Record<string, unknown>)[this.options.userId]
          : undefined
      const ownDevice =
        ownDevices && typeof ownDevices === "object" && !Array.isArray(ownDevices)
          ? (ownDevices as Record<string, unknown>)[this.options.deviceId]
          : undefined
      if (
        !ownDevice ||
        typeof ownDevice !== "object" ||
        (ownDevice as { user_id?: unknown }).user_id !== this.options.userId ||
        (ownDevice as { device_id?: unknown }).device_id !== this.options.deviceId ||
        (response.failures !== undefined &&
          (!response.failures ||
            typeof response.failures !== "object" ||
            Array.isArray(response.failures) ||
            Object.keys(response.failures).length > 0)) ||
        (response.master_keys !== undefined &&
          (!response.master_keys ||
            typeof response.master_keys !== "object" ||
            Array.isArray(response.master_keys)))
      )
        throw new Error("Matrix own identity query is incomplete")
      const master = (response.master_keys as Record<string, unknown> | undefined)?.[
        this.options.userId
      ]
      let serverMasterKey: string | null = null
      if (master !== undefined) {
        if (!master || typeof master !== "object") throw new Error("Invalid Matrix server identity")
        const keys = Object.entries((master as { keys?: Record<string, unknown> }).keys ?? {})
        if (
          keys.length !== 1 ||
          !keys[0][0].startsWith("ed25519:") ||
          typeof keys[0][1] !== "string"
        )
          throw new Error("Invalid Matrix server master key")
        serverMasterKey = keys[0][1]
      }
      const prepared = await connectorsMatrixCryptoCrossSigning({
        adapterId: this.options.adapterId,
        action: "prepare",
        serverMasterKey,
      })
      check()
      for (const request of prepared.requests) {
        if (request.method !== "POST" && request.method !== "PUT")
          throw new Error("Invalid Matrix cross-signing request method")
        const payload =
          request.kind === "signingKeysUpload" && auth
            ? { ...(request.body as Record<string, unknown>), auth }
            : request.body
        const reply = await this.options.request(request.method, request.path, payload, {
          maxResponseBytes: 64 * 1024,
        })
        check()
        if (
          request.kind === "signatureUpload" &&
          reply.failures &&
          Object.keys(reply.failures as object).length
        )
          throw new Error("Matrix cross-signing signatures were rejected")
        await connectorsMatrixCryptoMarkRequestSent({
          adapterId: this.options.adapterId,
          requestId: request.requestId,
          kind: request.kind,
          response: reply,
        })
        check()
      }
      await this.options.refresh(check)
      check()
      const status = await connectorsMatrixCryptoCrossSigning({
        adapterId: this.options.adapterId,
        action: "status",
      })
      check()
      return status
    })
  }
}
