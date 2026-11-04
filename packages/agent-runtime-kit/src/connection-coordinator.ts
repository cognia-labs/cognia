import type { ProcessWriteScope } from "@cognia/agent-contracts/runtime-policy"
/** Shared ownership of connection work; teardown cannot race an unfinished spawn. */
export class AgentConnectionCoordinator {
  readonly connections = new Map<string, Promise<void>>()
  readonly disconnections = new Map<string, Promise<void>>()
  readonly writeScopes = new Map<string, ProcessWriteScope>()
  async connect(id: string, operation: () => Promise<void>, serialize: boolean): Promise<void> {
    if (!serialize) return operation()
    const stopping = this.disconnections.get(id)
    if (stopping) await stopping
    const existing = this.connections.get(id)
    if (existing) return existing
    const connecting = operation()
    this.connections.set(id, connecting)
    try {
      await connecting
    } finally {
      if (this.connections.get(id) === connecting) this.connections.delete(id)
    }
  }
  async disconnect(id: string, operation: () => Promise<void>, serialize: boolean): Promise<void> {
    if (!serialize) return operation()
    const existing = this.disconnections.get(id)
    if (existing) return existing
    const connecting = this.connections.get(id)
    const stopping = (async () => {
      if (connecting) await connecting.catch(() => undefined)
      await operation()
    })()
    this.disconnections.set(id, stopping)
    try {
      await stopping
    } finally {
      if (this.disconnections.get(id) === stopping) this.disconnections.delete(id)
    }
  }
}
