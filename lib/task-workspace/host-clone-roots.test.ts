import {
  forgetHostClone,
  hostCloneFor,
  hostCloneOwners,
  hostCloneRootOf,
  rememberHostClone,
  resetHostClones,
} from "./host-clone-roots"

describe("host clone roots", () => {
  afterEach(resetHostClones)

  it("maps a path in a clone, or the clone itself, back to its workspace", () => {
    rememberHostClone("p1", "/host/sources/app-1a2b/")
    expect(hostCloneFor("/host/sources/app-1a2b")).toEqual({
      projectId: "p1",
      root: "/host/sources/app-1a2b/",
    })
    expect(hostCloneFor("/host/sources/app-1a2b/apps/web")?.projectId).toBe("p1")
    expect(hostCloneRootOf("p1")).toBe("/host/sources/app-1a2b/")
  })

  it("does not match a sibling that only shares a prefix", () => {
    rememberHostClone("p1", "/host/sources/app")
    expect(hostCloneFor("/host/sources/app-other")).toBeNull()
    expect(hostCloneFor("/host/sources")).toBeNull()
  })

  it("prefers the deepest clone and follows a workspace's latest clone", () => {
    rememberHostClone("outer", "/host/sources")
    rememberHostClone("inner", "/host/sources/app")
    expect(hostCloneFor("/host/sources/app/src")?.projectId).toBe("inner")
    rememberHostClone("inner", "/host/sources/app-2")
    expect(hostCloneFor("/host/sources/app/src")?.projectId).toBe("outer")
  })

  it("attributes a clone two workspaces share to neither", () => {
    // One repository, two workspaces: one clone. Its declaration is approved
    // per workspace, so neither's approval may provision the other's worktrees.
    rememberHostClone("a", "/host/sources/app")
    rememberHostClone("b", "/host/sources/app/")
    expect(hostCloneOwners("/host/sources/app")).toEqual(["a", "b"])
    expect(hostCloneFor("/host/sources/app/src")).toBeNull()
    forgetHostClone("b")
    expect(hostCloneFor("/host/sources/app/src")?.projectId).toBe("a")
  })

  it("compares Windows separators like forward slashes", () => {
    rememberHostClone("p1", "C:\\host\\sources\\app")
    expect(hostCloneFor("C:/host/sources/app/src")?.projectId).toBe("p1")
  })

  it("ignores blank input", () => {
    rememberHostClone("", "/host/sources/app")
    rememberHostClone("p1", "  ")
    expect(hostCloneFor("/host/sources/app")).toBeNull()
    expect(hostCloneFor(undefined)).toBeNull()
    expect(hostCloneFor("  ")).toBeNull()
  })
})
