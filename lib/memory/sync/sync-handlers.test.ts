jest.mock("./memory-sync", () => ({
  readMemoriesDelta: jest.fn(),
  syncMemories: jest.fn(),
}))

import { readMemoriesDelta, syncMemories } from "./memory-sync"
import { syncHandlers } from "./sync-handlers"

describe("memory sync handlers", () => {
  it("owns both halves of the encrypted memories mirror", () => {
    expect(syncHandlers).toEqual({ memories: { pull: syncMemories, serve: readMemoriesDelta } })
  })
})
