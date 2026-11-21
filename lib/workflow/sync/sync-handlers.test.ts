jest.mock("./workflows", () => ({ syncWorkflows: jest.fn() }))

import { syncHandlers } from "./sync-handlers"
import { syncWorkflows } from "./workflows"

describe("workflow sync handlers", () => {
  it("contributes the workflows pull and leaves reading to the host", () => {
    expect(syncHandlers).toEqual({ workflows: { pull: syncWorkflows } })
  })
})
