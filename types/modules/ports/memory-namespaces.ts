// The `memory-namespaces` capability port (ADR-0069, ADR-0250 §14): retire
// the memories another module's agent wrote into its own namespace. The
// memory module (`lib/memory/module.ts`) provides it. The twin module asks
// for it when a twin is deleted, instead of importing `lib/memory/`, because
// memory already depends on the twin (its embedding deps and distiller
// client); with no provider there are no memories to retire.

export interface MemoryNamespacesPort {
  /**
   * Invalidate and de-index every memory in a twin's shared namespace
   * (`twin:<id>`). Returns how many active memories were invalidated.
   */
  invalidateTwinNamespace(twinId: string): Promise<number>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "memory-namespaces": MemoryNamespacesPort
  }
}
