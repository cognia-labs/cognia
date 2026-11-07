// The `knowledge-base-revisions` capability port (ADR-0250 §14): pinning a
// workflow deployment to knowledge-base index generations. The workflow
// engine freezes a production deployment's dependency lock through it (an
// authored pin is checked, an unpinned knowledge base is bound to its current
// generations); the knowledge-base module (`lib/knowledge-base/module.ts`)
// provides it, so the engine does not import the knowledge base. With no
// provider, a deployment that binds a knowledge base fails to resolve rather
// than run unpinned.

export interface KnowledgeBaseRevisionsPort {
  /** Throws when a pinned generation is not one of the knowledge base's own. */
  assertBindings(knowledgeBaseId: string, generationIds: readonly string[]): Promise<void>
  /** The knowledge base's current generations, keyed as the dependency lock stores them. */
  resolveCurrentBindings(knowledgeBaseId: string): Promise<Record<string, string>>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "knowledge-base-revisions": KnowledgeBaseRevisionsPort
  }
}
