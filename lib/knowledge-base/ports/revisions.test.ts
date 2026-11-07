import {
  assertKnowledgeBaseRevisionBindings,
  resolveCurrentKnowledgeBaseRevisionBindings,
} from "../revisions"
import { port } from "./revisions"

jest.mock("../revisions", () => ({
  assertKnowledgeBaseRevisionBindings: jest.fn(async () => undefined),
  resolveCurrentKnowledgeBaseRevisionBindings: jest.fn(async () => ({
    "knowledge:kb-1:src": "gen-1",
  })),
}))

describe("the knowledge-base-revisions port", () => {
  it("checks authored pins with the knowledge base's own check", async () => {
    await port.assertBindings("kb-1", ["gen-1"])
    expect(assertKnowledgeBaseRevisionBindings).toHaveBeenCalledWith("kb-1", ["gen-1"])
  })

  it("binds an unpinned knowledge base to its current generations", async () => {
    await expect(port.resolveCurrentBindings("kb-1")).resolves.toEqual({
      "knowledge:kb-1:src": "gen-1",
    })
    expect(resolveCurrentKnowledgeBaseRevisionBindings).toHaveBeenCalledWith("kb-1")
  })
})
