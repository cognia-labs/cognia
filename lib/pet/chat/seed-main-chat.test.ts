import { formatPetHandoffSeed, seedMainChat } from "./seed-main-chat"

describe("formatPetHandoffSeed (F7)", () => {
  it("carries recent user messages and pet replies into an editable handoff block", () => {
    const seed = formatPetHandoffSeed({
      petName: "Boba",
      recentTurns: [
        { userText: "How should we split this?", reply: "Start with the DB boundary." },
        { userText: "Any pitfalls?", reply: "Watch concurrent resets." },
      ],
      pending: "Let's draft the patch.",
    })
    expect(seed).toContain("Context from pet chat (Boba):")
    expect(seed).toContain("You: How should we split this?")
    expect(seed).toContain("Boba: Start with the DB boundary.")
    expect(seed).toContain("Boba: Watch concurrent resets.")
    expect(seed).toContain("Let's draft the patch.")
  })

  it("returns just the pending text when there is no prior history", () => {
    expect(formatPetHandoffSeed({ pending: "  hello  ", recentTurns: [] })).toBe("hello")
  })
})

describe("seedMainChat", () => {
  it("creates a session, seeds the trimmed draft, activates it, and returns the id", async () => {
    const createSession = jest.fn(() => ({ id: "s1" }))
    const setActiveSession = jest.fn()
    const setDraft = jest.fn().mockResolvedValue(undefined)

    const id = await seedMainChat("  hello there  ", { createSession, setActiveSession, setDraft })

    expect(id).toBe("s1")
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith("s1", "hello there")
    expect(setActiveSession).toHaveBeenCalledWith("s1")
  })

  it("forwards characterId sessionOptions when provided (F7)", async () => {
    const createSession = jest.fn(() => ({ id: "s_char" }))
    const setActiveSession = jest.fn()
    const setDraft = jest.fn().mockResolvedValue(undefined)

    await seedMainChat("continue", {
      createSession,
      setActiveSession,
      setDraft,
      sessionOptions: { characterId: "char-7" },
    })
    expect(createSession).toHaveBeenCalledWith({ characterId: "char-7" })
  })

  it("still activates the session when the seed text is empty (no draft write)", async () => {
    const setActiveSession = jest.fn()
    const setDraft = jest.fn().mockResolvedValue(undefined)
    const id = await seedMainChat("   ", {
      createSession: () => ({ id: "s2" }),
      setActiveSession,
      setDraft,
    })
    expect(id).toBe("s2")
    expect(setDraft).not.toHaveBeenCalled()
    expect(setActiveSession).toHaveBeenCalledWith("s2")
  })

  it("still activates even if the draft write fails", async () => {
    const setActiveSession = jest.fn()
    const id = await seedMainChat("hi", {
      createSession: () => ({ id: "s3" }),
      setActiveSession,
      setDraft: jest.fn().mockRejectedValue(new Error("db down")),
    })
    expect(id).toBe("s3")
    expect(setActiveSession).toHaveBeenCalledWith("s3")
  })
})
