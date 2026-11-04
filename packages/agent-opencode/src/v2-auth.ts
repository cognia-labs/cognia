/** V2 authentication lifecycle, bound to one service client and project location.
 * Credentials and refresh tokens remain owned by OpenCode. This module only
 * reads public integration summaries and manages temporary OAuth attempts.
 */
import type {
  FormAnswer,
  FormField,
  IntegrationAttempt,
  IntegrationInfo,
  IntegrationOAuthMethod,
  OpenCodeClient,
} from "@opencode/client"

export type { FormAnswer, FormField, IntegrationOAuthMethod }
export type OpenCodeAuthClient = {
  integration: Pick<OpenCodeClient["integration"], "list" | "oauth">
}

export interface OpenCodeAuthIntegration {
  id: string
  name: string
  methods: IntegrationOAuthMethod[]
  connections: Array<{ id?: string; label: string; method: string; needsAuth: boolean }>
}

export type OpenCodeAuthError =
  "load" | "start" | "status" | "complete" | "cancel" | "expired" | "failed" | "invalidUrl"
export interface OpenCodeAuthSnapshot {
  integrations: OpenCodeAuthIntegration[]
  loading: boolean
  phase: "idle" | "starting" | "pending" | "submitting" | "cancelling" | "complete"
  attempt?: IntegrationAttempt & { integrationID: string }
  error?: OpenCodeAuthError
}

export function initialOAuthAnswers(fields: readonly FormField[]): FormAnswer {
  return Object.fromEntries(
    fields.flatMap((field) =>
      "default" in field && field.default !== undefined
        ? [[field.key, field.default]]
        : field.type === "boolean"
          ? [[field.key, false]]
          : []
    )
  )
}

export function visibleOAuthFields(fields: readonly FormField[], answer: FormAnswer): FormField[] {
  return fields.filter(
    (field) =>
      !("when" in field) ||
      !field.when?.length ||
      field.when.every((condition) =>
        condition.op === "eq"
          ? answer[condition.key] === condition.value
          : answer[condition.key] !== condition.value
      )
  )
}

export function summarizeOpenCodeIntegrations(
  entries: IntegrationInfo[]
): OpenCodeAuthIntegration[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    methods: entry.methods.filter(
      (method): method is IntegrationOAuthMethod => method.type === "oauth"
    ),
    connections: entry.connections.map((connection) => ({
      ...(connection.type === "credential" ? { id: connection.id } : {}),
      label: connection.type === "credential" ? connection.label : connection.name,
      method: connection.type === "credential" ? connection.method : "env",
      needsAuth: connection.status?.status === "needs_auth",
    })),
  }))
}

export function isHttpAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

export class OpenCodeV2Auth {
  private snapshot: OpenCodeAuthSnapshot = { integrations: [], loading: false, phase: "idle" }
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private revision = 0
  private reads = 0
  private disposed = false
  private cancelling?: Promise<boolean>
  private checking?: number
  private readonly location: { location?: { directory: string } }

  constructor(
    private readonly client: OpenCodeAuthClient,
    directory?: string
  ) {
    this.location = directory ? { location: { directory } } : {}
  }

  getSnapshot = (): OpenCodeAuthSnapshot => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(update: Partial<OpenCodeAuthSnapshot>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...update }
    this.listeners.forEach((listener) => listener())
  }

  private stopTimer() {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  async refresh(): Promise<void> {
    const read = ++this.reads
    this.publish({ loading: true })
    try {
      const result = await this.client.integration.list(this.location, {
        signal: AbortSignal.timeout(15_000),
      })
      if (read === this.reads)
        this.publish({
          integrations: summarizeOpenCodeIntegrations(result.data),
          error: this.snapshot.error === "load" ? undefined : this.snapshot.error,
        })
    } catch {
      if (read === this.reads) this.publish({ integrations: [], error: "load" })
    } finally {
      if (read === this.reads) this.publish({ loading: false })
    }
  }

  private reference(attempt: NonNullable<OpenCodeAuthSnapshot["attempt"]>) {
    return { ...this.location, integrationID: attempt.integrationID, attemptID: attempt.attemptID }
  }

  private cancelRemote(attempt: NonNullable<OpenCodeAuthSnapshot["attempt"]>) {
    return this.client.integration.oauth.cancel(this.reference(attempt), {
      signal: AbortSignal.timeout(15_000),
    })
  }

  async start(integrationID: string, methodID: string, answer: FormAnswer): Promise<void> {
    if (
      this.disposed ||
      ["starting", "pending", "submitting", "cancelling"].includes(this.snapshot.phase)
    )
      return
    const revision = ++this.revision
    this.publish({ phase: "starting", attempt: undefined, error: undefined })
    try {
      // Do not abort an in-flight begin on dismissal: its late attempt ID is
      // needed to cancel the server-side operation rather than orphan it.
      const result = await this.client.integration.oauth.connect(
        { ...this.location, integrationID, methodID, answer },
        { signal: AbortSignal.timeout(15_000) }
      )
      const attempt = { ...result.data, integrationID }
      if (this.disposed || revision !== this.revision) {
        await this.cancelRemote(attempt).catch(() => undefined)
        return
      }
      if (!isHttpAuthorizationUrl(attempt.url)) {
        this.publish({ attempt, phase: "pending", error: "invalidUrl" })
        await this.cancelRemote(attempt)
        if (revision === this.revision)
          this.publish({ attempt: undefined, phase: "idle", error: "invalidUrl" })
        return
      }
      this.publish({ attempt, phase: "pending" })
      this.schedule()
    } catch {
      if (revision === this.revision)
        this.publish({
          phase: this.snapshot.attempt ? "pending" : "idle",
          error: this.snapshot.attempt ? "cancel" : "start",
        })
    }
  }

  private schedule() {
    this.stopTimer()
    this.timer = setTimeout(() => {
      void this.check()
    }, 1_000)
  }

  async check(): Promise<void> {
    const attempt = this.snapshot.attempt
    if (
      !attempt ||
      this.disposed ||
      this.checking === this.revision ||
      this.snapshot.phase !== "pending"
    )
      return
    this.stopTimer()
    this.checking = this.revision
    const revision = this.revision
    try {
      const result = await this.client.integration.oauth.status(this.reference(attempt), {
        signal: AbortSignal.timeout(15_000),
      })
      if (this.disposed || revision !== this.revision) return
      const state = result.data.status
      if (state === "complete") {
        this.publish({ phase: "complete", attempt: undefined, error: undefined })
        await this.refresh()
      } else if (state === "failed" || state === "expired") {
        this.publish({ phase: "idle", attempt: undefined, error: state })
      } else if (Date.now() >= attempt.time.expires) {
        await this.cancelRemote(attempt)
        if (revision === this.revision)
          this.publish({ phase: "idle", attempt: undefined, error: "expired" })
      } else {
        this.publish({ error: undefined })
        this.schedule()
      }
    } catch {
      if (revision === this.revision) this.publish({ error: "status" })
    } finally {
      if (this.checking === revision) this.checking = undefined
    }
  }

  async complete(code: string): Promise<void> {
    const attempt = this.snapshot.attempt
    if (!attempt || this.disposed || this.snapshot.phase !== "pending" || !code.trim()) return
    this.stopTimer()
    const revision = ++this.revision
    this.publish({ phase: "submitting", error: undefined })
    try {
      await this.client.integration.oauth.complete(
        { ...this.reference(attempt), code: code.trim() },
        { signal: AbortSignal.timeout(15_000) }
      )
      if (revision !== this.revision || this.disposed) return
      this.publish({ phase: "pending" })
      await this.check()
    } catch {
      if (revision === this.revision) this.publish({ phase: "pending", error: "complete" })
    }
  }

  cancel(): Promise<boolean> {
    if (this.cancelling) return this.cancelling
    const operation = this.cancelAttempt()
    this.cancelling = operation
    void operation.finally(() => {
      if (this.cancelling === operation) this.cancelling = undefined
    })
    return operation
  }

  private async cancelAttempt(): Promise<boolean> {
    this.stopTimer()
    const revision = ++this.revision
    const attempt = this.snapshot.attempt
    if (!attempt) {
      this.publish({ phase: "idle", error: undefined })
      return true
    }
    this.publish({ phase: "cancelling" })
    try {
      await this.cancelRemote(attempt)
      if (revision === this.revision)
        this.publish({ phase: "idle", attempt: undefined, error: undefined })
      return true
    } catch {
      if (revision === this.revision) this.publish({ phase: "pending", error: "cancel" })
      return false
    }
  }

  dispose() {
    this.disposed = true
    ++this.revision
    this.stopTimer()
    this.listeners.clear()
    if (this.snapshot.attempt && !this.cancelling)
      void this.cancelRemote(this.snapshot.attempt).catch(() => undefined)
  }
}
