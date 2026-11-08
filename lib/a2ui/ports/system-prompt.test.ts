const mockCatalogSection = jest.fn()

jest.mock("../agent-catalog-prompt", () => ({
  buildAgentA2UICatalogSection: (catalogId: string | undefined) => mockCatalogSection(catalogId),
}))

import { A2UI_SYSTEM_PROMPT } from "../prompts"
import { port } from "./system-prompt"

describe("a2ui-system-prompt port", () => {
  beforeEach(() => mockCatalogSection.mockReset())

  it("is the protocol prompt alone for the standard catalog", () => {
    mockCatalogSection.mockReturnValue(undefined)
    expect(port.systemSection({})).toBe(A2UI_SYSTEM_PROMPT)
    expect(mockCatalogSection).toHaveBeenCalledWith(undefined)
  })

  it("adds the agent's catalog section under a blank line", () => {
    mockCatalogSection.mockReturnValue("## A2UI catalog\ncustom")
    expect(port.systemSection({ catalogId: "custom" })).toBe(
      `${A2UI_SYSTEM_PROMPT}\n\n## A2UI catalog\ncustom`
    )
    expect(mockCatalogSection).toHaveBeenCalledWith("custom")
  })
})
