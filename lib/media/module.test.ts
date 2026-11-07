import { MEDIA_TOOL_NAMES, VIDEO_GENERATE_TOOL_NAME } from "./agent-tools"
import mediaModule from "./module"

describe("the media manifest", () => {
  const declare = mediaModule.tools!.declare

  it("declares exactly the video tools", () => {
    expect(Object.keys(declare).sort()).toEqual([...MEDIA_TOOL_NAMES].sort())
  })

  it("asks before starting a paid job, and reads a job back freely", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      const generate = name === VIDEO_GENERATE_TOOL_NAME
      expect(declaration.consent).toBe(generate ? "ask" : "allow")
      expect(declaration.effect).toBe(generate ? "write" : "read")
      // Neither runner takes a cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await mediaModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
  })
})
