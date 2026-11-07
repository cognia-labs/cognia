import { port } from "./file-links-port"

const mockCopy = jest.fn()
jest.mock("./copy-link", () => ({
  copyConversationFileLink: (...args: unknown[]) => mockCopy(...args),
}))

describe("the conversation-file-links port", () => {
  it("copies through the FileSpace link writer and passes its answer back", async () => {
    mockCopy.mockResolvedValueOnce("outside")
    const input = { sessionId: "s1", path: "src/a.ts", line: 3 }
    await expect(port.copyLink(input)).resolves.toBe("outside")
    expect(mockCopy).toHaveBeenCalledWith(input)
  })
})
