// The memory module's implementation of the `memory-namespaces` port
// (`types/modules/ports/memory-namespaces.ts`, ADR-0250 §14).

import type { MemoryNamespacesPort } from "@/types/modules/ports/memory-namespaces"
import { invalidateTwinMemoryNamespace } from "./twin-lifecycle"

export const port: MemoryNamespacesPort = {
  invalidateTwinNamespace: (twinId) => invalidateTwinMemoryNamespace(twinId),
}
