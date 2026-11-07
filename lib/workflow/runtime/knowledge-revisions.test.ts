import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import type { KnowledgeBaseRevisionsPort } from "@/types/modules/ports/knowledge-base-revisions"
import { knowledgeBaseRevisions } from "./knowledge-revisions"

afterEach(() => __resetPortsForTesting())

describe("knowledgeBaseRevisions", () => {
  it("returns the provider of the knowledge-base-revisions port", async () => {
    const provider: KnowledgeBaseRevisionsPort = {
      assertBindings: jest.fn(async () => undefined),
      resolveCurrentBindings: jest.fn(async () => ({})),
    }
    __setPortForTesting("knowledge-base-revisions", provider)
    await expect(knowledgeBaseRevisions()).resolves.toBe(provider)
  })

  it("fails closed when no module provides the port", async () => {
    __setPortForTesting("knowledge-base-revisions", null)
    await expect(knowledgeBaseRevisions()).rejects.toThrow(
      "No module provides knowledge-base revisions"
    )
  })
})
