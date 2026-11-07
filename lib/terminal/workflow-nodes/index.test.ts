import { listRegisteredKinds } from "@/lib/workflow/nodes/registry"
import { workflowNodeKinds } from "."

describe("the terminal module's workflowNodes contribution", () => {
  it("registers exactly the kinds it declares", () => {
    expect([...listRegisteredKinds()].sort()).toEqual([...workflowNodeKinds].sort())
  })
})
