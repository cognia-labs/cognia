import { resolveDeclaredDependencies, unionRepositoryEdges } from "./declared-dependencies"

const REMOTES: Record<string, string | null> = {
  "/w/app": "git@github.com:org/app.git",
  "/w/sdk": "https://github.com/Org/SDK.git",
  "/w/ui": "https://ghe.corp.example/platform/ui",
  "/w/fork": "git@github.com:fork/sdk.git",
  "/w/local": null,
}

function deps(declared: Record<string, string[]>) {
  return {
    declared: jest.fn(async ({ id }: { id: string }) =>
      (declared[id] ?? []).map((repository) => ({ repository }))
    ),
    remoteOf: jest.fn(async (path: string) => REMOTES[path] ?? null),
  }
}

const repos = (...ids: string[]) => ids.map((id) => ({ id, path: `/w/${id}` }))

describe("resolveDeclaredDependencies (ADR-0147, 2026-11-08 amendment)", () => {
  it("turns a declaration that matches one repository's remote into an edge", async () => {
    const result = await resolveDeclaredDependencies(
      repos("app", "sdk", "ui"),
      deps({ app: ["github.com/org/sdk", "ghe.corp.example/platform/ui"] })
    )
    expect(result).toEqual({ edges: { app: ["sdk", "ui"] }, unresolved: {} })
  })

  it("never guesses: no match and several matches are returned as unresolved", async () => {
    const twoSdks = {
      declared: async ({ id }: { id: string }) =>
        id === "app" ? [{ repository: "github.com/org/sdk" }] : [],
      remoteOf: async (path: string) =>
        path === "/w/app" ? REMOTES["/w/app"]! : "https://github.com/org/sdk",
    }
    const ambiguous = await resolveDeclaredDependencies(repos("app", "sdk", "mirror"), twoSdks)
    expect(ambiguous.edges).toEqual({})
    expect(ambiguous.unresolved).toEqual({
      app: [{ repository: "github.com/org/sdk", reason: "ambiguous", matches: ["sdk", "mirror"] }],
    })

    // A fork has the same name and is another repository.
    const missing = await resolveDeclaredDependencies(
      repos("app", "fork", "local"),
      deps({ app: ["github.com/org/sdk"] })
    )
    expect(missing.unresolved).toEqual({
      app: [{ repository: "github.com/org/sdk", reason: "noMatch", matches: [] }],
    })
  })

  it("does not let a repository depend on itself, and reads nothing it cannot", async () => {
    const result = await resolveDeclaredDependencies(repos("sdk", "app"), {
      declared: async ({ id }) => {
        if (id === "app") throw new Error("unreadable")
        return [{ repository: "github.com/org/sdk" }]
      },
      remoteOf: async (path) => {
        if (path === "/w/app") throw new Error("git missing")
        return REMOTES[path] ?? null
      },
    })
    expect(result.edges).toEqual({})
    expect(result.unresolved.sdk?.[0]?.reason).toBe("noMatch")
  })
})

describe("unionRepositoryEdges", () => {
  it("merges binding and declared edges without duplicates", () => {
    expect(
      unionRepositoryEdges({ app: ["sdk"], api: [] }, undefined, {
        app: ["sdk", "ui"],
        ui: ["sdk"],
      })
    ).toEqual({ app: ["sdk", "ui"], ui: ["sdk"] })
  })
})
