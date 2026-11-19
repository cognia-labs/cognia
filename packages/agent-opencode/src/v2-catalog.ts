/** Progressive plugin discovery for OpenCode 2.2.7, shared by UI and OAuth.
 * model.list still waits for activation; list successes alone do not prove it.
 */
import type {
  AgentInfo,
  CommandInfo,
  IntegrationInfo,
  OpenCodeClient,
  ProviderInfo,
} from "@opencode/client"

export type OpenCodeDiscoveryState = "loading" | "partial" | "ready" | "error"
export type OpenCodeCatalogClient = {
  event: Pick<OpenCodeClient["event"], "subscribe">
  model: Pick<OpenCodeClient["model"], "list">
  integration: Pick<OpenCodeClient["integration"], "list">
} & Partial<Pick<OpenCodeClient, "agent" | "command" | "provider">>
type Surface = "agents" | "integrations" | "commands" | "providers"
export interface OpenCodeCatalogSnapshot {
  providers: ProviderInfo[]
  agents: AgentInfo[]
  integrations: IntegrationInfo[]
  commands: CommandInfo[]
  states: Record<Surface, OpenCodeDiscoveryState>
}

export class OpenCodeV2Catalog {
  private snapshot: OpenCodeCatalogSnapshot = {
    providers: [],
    agents: [],
    integrations: [],
    commands: [],
    states: {
      agents: "loading",
      integrations: "loading",
      commands: "loading",
      providers: "loading",
    },
  }
  private listeners = new Set<() => void>()
  private controller?: AbortController
  private disposed = false
  private activated = false
  private activation?: Promise<void>
  private connected?: Promise<void>
  private canonical?: string
  private revisions: Record<Surface, number> = {
    agents: 0,
    integrations: 0,
    commands: 0,
    providers: 0,
  }
  private readonly input: { location?: { directory: string } }

  constructor(
    private readonly client: OpenCodeCatalogClient,
    directory?: string
  ) {
    this.input = directory ? { location: { directory } } : {}
    this.canonical = directory
  }

  getSnapshot = (): OpenCodeCatalogSnapshot => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(update: Partial<OpenCodeCatalogSnapshot>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...update }
    this.listeners.forEach((listener) => listener())
  }

  private state(surface: Surface, value: OpenCodeDiscoveryState) {
    this.publish({ states: { ...this.snapshot.states, [surface]: value } })
  }

  private async read(surface: Surface): Promise<void> {
    const api =
      surface === "agents"
        ? this.client.agent
        : surface === "commands"
          ? this.client.command
          : surface === "providers"
            ? this.client.provider
            : this.client.integration
    if (!api || this.disposed) return
    const revision = ++this.revisions[surface]
    const activated = this.activated
    const controller = this.controller!
    try {
      const result = await api.list(this.input, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      })
      if (this.disposed || controller.signal.aborted || revision !== this.revisions[surface]) return
      this.canonical = result.location?.directory ?? this.canonical
      this.publish({ [surface]: result.data })
      this.state(surface, activated ? "ready" : "partial")
    } catch {
      if (!this.disposed && !controller.signal.aborted && revision === this.revisions[surface])
        this.state(surface, "error")
    }
  }

  private async readAll() {
    await Promise.all([
      this.read("agents"),
      this.read("integrations"),
      this.read("commands"),
      this.read("providers"),
    ])
  }

  private connect(): Promise<void> {
    if (this.connected) return this.connected
    const controller = new AbortController()
    this.controller = controller
    this.connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(new Error("OpenCode discovery subscription timed out"))
      }, 15_000)
      void (async () => {
        try {
          for await (const event of this.client.event.subscribe({ signal: controller.signal })) {
            if (controller.signal.aborted) break
            if (event.type === "server.connected") {
              clearTimeout(timer)
              resolve()
              continue
            }
            // The stream covers every Location. Credential events may be global.
            if (event.location && event.location.directory !== this.canonical) continue
            switch (event.type) {
              case "agent.updated":
                void this.read("agents")
                break
              case "command.updated":
                void this.read("commands")
                break
              case "integration.updated":
              case "credential.updated":
              case "credential.switched":
                void this.read("integrations")
                void this.read("providers")
                break
              case "provider.updated":
              case "model.updated":
                void this.read("providers")
                break
              case "plugin.updated":
                void this.readAll()
                break
            }
          }
          if (!controller.signal.aborted) throw new Error("OpenCode discovery stream ended")
        } catch (error) {
          reject(error)
          if (!this.disposed && !controller.signal.aborted) {
            controller.abort()
            this.connected = undefined
            this.activated = false
            if (this.controller === controller) this.activation = undefined
            this.publish({
              states: {
                agents: "error",
                integrations: "error",
                commands: "error",
                providers: "error",
              },
            })
          }
        } finally {
          clearTimeout(timer)
          reject(new Error("OpenCode discovery stream closed"))
        }
      })()
    })
    return this.connected
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      await this.connect()
      if (this.disposed) return
      const partial = this.readAll()
      const controller = this.controller!
      if (!this.activated && !this.activation) {
        this.activation = (async () => {
          try {
            await this.client.model.list(this.input, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
            })
            if (this.disposed || controller.signal.aborted) return
            this.activated = true
            await this.readAll()
          } catch {
            await partial
            if (!this.disposed && !controller.signal.aborted)
              this.publish({
                states: {
                  agents: "error",
                  integrations: "error",
                  commands: "error",
                  providers: "error",
                },
              })
          } finally {
            if (this.controller === controller) this.activation = undefined
          }
        })()
      }
      await partial
      await this.activation
    } catch {
      this.connected = undefined
      if (!this.disposed)
        this.publish({
          states: { agents: "error", integrations: "error", commands: "error", providers: "error" },
        })
    }
  }

  dispose() {
    this.disposed = true
    this.controller?.abort()
    this.listeners.clear()
  }
}
