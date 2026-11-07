import { ARTIFACT_DELETE_TOOL_NAME, ARTIFACT_TOOL_NAMES, CANVAS_TOOL_NAMES } from "./agent-tools"
import artifactModule from "./module"

const READS = new Set(["artifact_read", "artifact_capture", "canvas_read"])

describe("the artifact manifest", () => {
  const declare = artifactModule.tools!.declare

  it("lives in lib/artifacts but takes its subsystem's id", () => {
    expect(artifactModule).toMatchObject({ id: "artifact", kind: "module", stage: "stable" })
  })

  it("declares exactly the artifact and canvas tools, none of the retired ones", () => {
    expect(Object.keys(declare).sort()).toEqual(
      [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES].sort()
    )
    // `artifact_search` folded into `artifact_read`'s `query`; `artifact_render`
    // had nothing to ask for; `artifact_export` would be a model-initiated
    // write to the user's disk for a button already on screen.
    for (const retired of ["artifact_search", "artifact_render", "artifact_export"])
      expect(declare).not.toHaveProperty(retired)
  })

  it("asks only before deleting, and reads only what it reads", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe(name === ARTIFACT_DELETE_TOOL_NAME ? "ask" : "allow")
      expect(declaration.effect).toBe(READS.has(name) ? "read" : "write")
      // The runner takes no cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("asks for filespace's link port without depending on filespace", () => {
    expect(artifactModule.requires).toEqual(["conversation-file-links?"])
    expect(artifactModule.dependsOn).not.toContain("filespace")
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await artifactModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
  })
})
