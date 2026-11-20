const mockLeakCheck = jest.fn<boolean | undefined, [string]>(() => undefined)
jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    // `undefined` defers to the real check; a test forces a verdict.
    hasNoLeakingPii: (text: string) => mockLeakCheck(text) ?? actual.hasNoLeakingPii(text),
  }
})

import { redactTeamTextForPersistence } from "./persisted-text"

describe("redactTeamTextForPersistence", () => {
  afterEach(() => mockLeakCheck.mockReset().mockReturnValue(undefined))

  it("redacts with @cognia/redact", () => {
    const redacted = redactTeamTextForPersistence("Contact operator@example.com now")
    expect(redacted).toBeDefined()
    expect(redacted).not.toContain("operator@example.com")
  })

  it("keeps clean text as it is", () => {
    expect(redactTeamTextForPersistence("Summarise the release notes")).toBe(
      "Summarise the release notes"
    )
  })

  it("refuses text that still leaks after redaction", () => {
    mockLeakCheck.mockReturnValue(false)
    expect(redactTeamTextForPersistence("anything")).toBeUndefined()
  })
})
