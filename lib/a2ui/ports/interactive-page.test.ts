jest.mock("@/components/a2ui/from-execution/interactive-page-dialog", () => ({
  InteractivePageDialog: () => null,
}))

import { InteractivePageDialog } from "@/components/a2ui/from-execution/interactive-page-dialog"
import { port } from "./interactive-page"

describe("interactive-page port", () => {
  it("provides the interactive page dialog", () => {
    expect(port.Dialog).toBe(InteractivePageDialog)
  })
})
