import { remapExactRoots, remapPathsIntoAliases } from "./root-aliases"

describe("remapExactRoots", () => {
  const aliases = new Map([
    ["/repo", "/bundle/primary"],
    ["/docs", "/bundle/docs"],
  ])

  it("maps each source root to its alias, keeping order", () => {
    expect(remapExactRoots(["/docs", "/repo"], aliases)).toEqual([
      "/bundle/docs",
      "/bundle/primary",
    ])
  })

  it("passes a root with no alias through unchanged", () => {
    expect(remapExactRoots(["/repo", "/elsewhere"], aliases)).toEqual([
      "/bundle/primary",
      "/elsewhere",
    ])
  })

  it("matches on the trimmed path", () => {
    expect(remapExactRoots(["  /repo  "], aliases)).toEqual(["/bundle/primary"])
  })

  it("never extends a mapping to a subdirectory of a source root", () => {
    expect(remapExactRoots(["/repo/packages/app"], aliases)).toEqual(["/repo/packages/app"])
  })

  it("returns an empty list for no values", () => {
    expect(remapExactRoots([], aliases)).toEqual([])
  })
})

describe("remapPathsIntoAliases", () => {
  const aliases = new Map([
    ["/repo", "/bundle/primary"],
    ["/repo/packages/web", "/bundle/web"],
    ["/docs", "/bundle/docs"],
  ])

  it("moves a source root and anything inside it into the alias", () => {
    expect(remapPathsIntoAliases(["/docs", "/repo/src/lib"], aliases)).toEqual([
      "/bundle/docs",
      "/bundle/primary/src/lib",
    ])
  })

  it("prefers the deepest source root when roots nest", () => {
    expect(remapPathsIntoAliases(["/repo/packages/web/app"], aliases)).toEqual(["/bundle/web/app"])
  })

  it("keeps a directory outside every aliased root, and does not match a name prefix", () => {
    expect(remapPathsIntoAliases(["/elsewhere/notes", "/repository"], aliases)).toEqual([
      "/elsewhere/notes",
      "/repository",
    ])
  })

  it("joins with the alias's own separator", () => {
    const windows = new Map([["C:/repo", "D:\\bundle\\primary"]])
    expect(remapPathsIntoAliases(["C:/repo/src"], windows)).toEqual(["D:\\bundle\\primary\\src"])
  })
})
