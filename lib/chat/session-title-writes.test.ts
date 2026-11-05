const enqueueMock = jest.fn()
const intentAvailableMock = jest.fn()
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (input: unknown) => enqueueMock(input),
  hostStateSessionIntentAvailable: (sessionId: string) => intentAvailableMock(sessionId),
}))

const getSessionMock = jest.fn()
const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getSessionMock(id),
  updateSession: (id: string, patch: unknown) => updateSessionMock(id, patch),
}))

import {
  autoSessionTitlesWrittenHere,
  renameSession,
  sessionTitleStillAuto,
  writeAutoSessionTitle,
} from "./session-title-writes"

beforeEach(() => {
  enqueueMock.mockReset().mockResolvedValue(null)
  intentAvailableMock.mockReset().mockResolvedValue(false)
  getSessionMock.mockReset().mockResolvedValue(undefined)
  updateSessionMock.mockReset().mockResolvedValue(undefined)
})

describe("session title writes (ADR-0253 D06)", () => {
  it("d06 sends a rename to the Host that owns the conversation", async () => {
    enqueueMock.mockResolvedValueOnce({ id: "job-1" })
    await renameSession("s1", "Plans")
    expect(enqueueMock).toHaveBeenCalledWith({
      sessionId: "s1",
      action: { kind: "session.rename", title: "Plans" },
    })
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("d06 writes a rename no Host takes onto the row, out of machine titles", async () => {
    await renameSession("s1", "Plans")
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { title: "Plans", titleAuto: false })
  })

  it("d06 drops a local rename once the scope it was made in is gone", async () => {
    await renameSession("s1", "Plans", { isCurrentScope: () => false })
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("d06 leaves machine titles of a Host-owned conversation to the Host", async () => {
    intentAvailableMock.mockResolvedValue(true)
    await expect(autoSessionTitlesWrittenHere("s1")).resolves.toBe(false)
    await expect(writeAutoSessionTitle("s1", "Model title")).resolves.toBe(false)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("d06 writes a machine title onto this device's own conversation", async () => {
    await expect(autoSessionTitlesWrittenHere("s1")).resolves.toBe(true)
    await expect(writeAutoSessionTitle("s1", "Model title")).resolves.toBe(true)
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { title: "Model title", titleAuto: true })
    // An empty title is never written.
    await expect(writeAutoSessionTitle("s1", "")).resolves.toBe(false)
    expect(updateSessionMock).toHaveBeenCalledTimes(1)
  })

  it("d06 writes the instant preview only over a placeholder, read fresh", async () => {
    getSessionMock.mockResolvedValueOnce({ id: "s1", title: "Chosen" })
    await expect(
      writeAutoSessionTitle("s1", "Preview", { overPlaceholderOnly: true })
    ).resolves.toBe(false)
    getSessionMock.mockResolvedValueOnce({ id: "s1", title: "" })
    await expect(
      writeAutoSessionTitle("s1", "Preview", { overPlaceholderOnly: true })
    ).resolves.toBe(true)
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { title: "Preview", titleAuto: true })
  })

  it("d06 writes through an injected row writer", async () => {
    const update = jest.fn().mockResolvedValue(undefined)
    await writeAutoSessionTitle("s1", "Room title", { update })
    expect(update).toHaveBeenCalledWith("s1", { title: "Room title", titleAuto: true })
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("d06 keeps a renamed title from machine writes", async () => {
    getSessionMock.mockResolvedValueOnce({ id: "s1", titleAuto: false })
    await expect(sessionTitleStillAuto("s1")).resolves.toBe(false)
    getSessionMock.mockResolvedValueOnce({ id: "s1", titleAuto: true })
    await expect(sessionTitleStillAuto("s1")).resolves.toBe(true)
    getSessionMock.mockRejectedValueOnce(new Error("closed"))
    await expect(sessionTitleStillAuto("s1")).resolves.toBe(true)
  })
})
