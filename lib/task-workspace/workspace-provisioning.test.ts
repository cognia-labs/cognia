import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { rememberHostClone, resetHostClones } from "./host-clone-roots"
import {
  bundleProvisioningForPath,
  bundleRootsForPath,
  provisioningForProject,
  provisioningForRepositoryRoot,
  provisioningForWorkspaceRoot,
  withRootProvisioning,
  type ProvisioningProject,
} from "./workspace-provisioning"
import type { Project } from "@/types"

const LOCAL: ProvisioningProject = {
  roots: [{ id: "r1", path: "/repos/app", isPrimary: true }],
  workspaceProvisioning: {
    accepted: ["cacheLink:node_modules", "include:.env"],
    reviewed: ["cacheLink:node_modules", "include:.env"],
  },
}

describe("provisioningForProject", () => {
  it("unions the repository's declaration with what this device accepted", async () => {
    const provisioning = await provisioningForProject(LOCAL, {
      declared: async () => ({ sparsePaths: ["apps/web"], include: ["config.local.json"] }),
    })
    expect(provisioning).toEqual({
      sparsePaths: ["apps/web"],
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: ["config.local.json", ".env"],
    })
  })

  it("returns the accepted set alone when the repository declares nothing", async () => {
    expect(await provisioningForProject(LOCAL, { declared: async () => undefined })).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("keeps the local acceptance when the declaration cannot be read", async () => {
    // The declaration is what failed. Dropping the user's own accepted set
    // because a file they never wrote is unreadable would be collateral.
    const provisioning = await provisioningForProject(LOCAL, {
      declared: async () => {
        throw new Error("EACCES")
      },
    })
    expect(provisioning).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("reads the declaration from another checkout when asked to", async () => {
    const declared = jest.fn(async () => ({ sparsePaths: ["apps/web"] }))
    await provisioningForProject(LOCAL, { declared }, { configRoot: "/host/sources/app" })
    expect(declared).toHaveBeenCalledWith(LOCAL, "/host/sources/app")
    await provisioningForProject(LOCAL, { declared })
    expect(declared).toHaveBeenLastCalledWith(LOCAL, undefined)
  })

  it("returns undefined when neither side asks for anything", async () => {
    expect(
      await provisioningForProject({ roots: [] }, { declared: async () => undefined })
    ).toBeUndefined()
  })
})

describe("provisioningForWorkspaceRoot", () => {
  const projects = [
    { id: "p1", roots: [{ id: "r1", path: "/repos/other", isPrimary: true }] },
    { id: "p2", ...LOCAL },
  ] as unknown as Project[]

  it("resolves the workspace that mounts the path", async () => {
    const provisioning = await provisioningForWorkspaceRoot("/repos/app", {
      projects: async () => projects,
      declared: async () => undefined,
    })
    expect(provisioning).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("returns undefined for a directory no workspace mounts", async () => {
    // An adopted folder or a bare `--cwd`: the same answer these call sites
    // had before provisioning reached them at all.
    expect(
      await provisioningForWorkspaceRoot("/tmp/scratch", {
        projects: async () => projects,
        declared: async () => undefined,
      })
    ).toBeUndefined()
  })

  describe("a clone an always-on Host made", () => {
    afterEach(resetHostClones)

    it("is provisioned as its workspace, from the declaration in the clone", async () => {
      // The clone sits at a path no workspace mounts. Without the recorded
      // pair this answered "nothing", so the worktree was a full checkout
      // while the supply had narrowed its backfill to the declared cone.
      rememberHostClone("p2", "/host/sources/app-1a2b")
      const declared = jest.fn(async (_project: ProvisioningProject, configRoot?: string) =>
        configRoot === "/host/sources/app-1a2b" ? { sparsePaths: ["apps/web"] } : undefined
      )
      const provisioning = await provisioningForWorkspaceRoot("/host/sources/app-1a2b/apps/web", {
        projects: async () => projects,
        declared,
      })
      expect(declared).toHaveBeenCalledWith(projects[1], "/host/sources/app-1a2b")
      expect(provisioning).toEqual({
        sparsePaths: ["apps/web"],
        cacheLinks: [{ source: "node_modules", target: "node_modules" }],
        include: [".env"],
      })
    })

    it("is nothing when the workspace it was made for is gone", async () => {
      rememberHostClone("deleted", "/host/sources/gone")
      expect(
        await provisioningForWorkspaceRoot("/host/sources/gone", {
          projects: async () => projects,
          declared: async () => ({ sparsePaths: ["x"] }),
        })
      ).toBeUndefined()
    })

    it("does not shadow a folder a workspace mounts", async () => {
      rememberHostClone("p1", "/repos")
      const declared = jest.fn(async () => undefined)
      await provisioningForWorkspaceRoot("/repos/app", {
        projects: async () => projects,
        declared,
      })
      expect(declared).toHaveBeenCalledWith(projects[1], undefined)
    })
  })

  it("returns undefined for an empty root without touching the store", async () => {
    const projectsDep = jest.fn(async () => projects)
    expect(await provisioningForWorkspaceRoot("  ", { projects: projectsDep })).toBeUndefined()
    expect(projectsDep).not.toHaveBeenCalled()
  })

  it("degrades to undefined when the workspace list is unreadable", async () => {
    // Headless shells have neither a hydrated store nor Dexie. A worktree with
    // a cold cache is slower; a throw here would mean no worktree at all.
    const provisioning = await provisioningForWorkspaceRoot("/repos/app", {
      projects: async () => {
        throw new Error("no database in this shell")
      },
    })
    expect(provisioning).toBeUndefined()
  })
})

describe("a workspace of several repositories (ADR-0147, 2026-11-08 amendment)", () => {
  const MULTI: Project = {
    id: "ws-multi",
    roots: [
      { id: "app", path: "/repos/app", isPrimary: true },
      { id: "app-pkg", path: "/repos/app/packages/ui" },
      { id: "sdk", path: "/repos/sdk" },
    ],
    workspaceProvisioning: LOCAL.workspaceProvisioning,
  } as Project

  it("reads another root's own file under its own approval, without the local set", async () => {
    const declared = jest.fn(async () => ({ sparsePaths: ["lib"] }))
    expect(await provisioningForRepositoryRoot(MULTI, "/repos/sdk", { declared })).toEqual({
      sparsePaths: ["lib"],
    })
    expect(declared).toHaveBeenCalledWith(MULTI, "/repos/sdk", "/repos/sdk")
    const failing = jest.fn(async () => {
      throw new Error("unreadable")
    })
    expect(
      await provisioningForRepositoryRoot(MULTI, "/repos/sdk", { declared: failing })
    ).toBeUndefined()
  })

  it("answers for a path with the declaration of the root it is in, and where it was read", async () => {
    const declared = jest.fn(async (_project: ProvisioningProject, configRoot?: string) =>
      configRoot ? { sparsePaths: [`own:${configRoot}`] } : { sparsePaths: ["web"] }
    )
    const deps = { declared, projects: async () => [MULTI] }
    expect(await bundleProvisioningForPath("/repos/sdk/src", deps)).toEqual({
      provisioning: { sparsePaths: ["own:/repos/sdk"] },
      provisioningSource: "/repos/sdk",
    })
    // A root inside the primary's folder may be a repository of its own; the
    // host decides that from git, so it is asked about its own file too.
    expect(await bundleProvisioningForPath("/repos/app/packages/ui", deps)).toEqual({
      provisioning: { sparsePaths: ["own:/repos/app/packages/ui"] },
      provisioningSource: "/repos/app/packages/ui",
    })
    // The primary root gets the workspace's provisioning, local set included.
    expect(await bundleProvisioningForPath("/repos/app/src", deps)).toEqual({
      provisioning: {
        sparsePaths: ["web"],
        cacheLinks: [{ source: "node_modules", target: "node_modules" }],
        include: [".env"],
      },
      provisioningSource: "/repos/app",
    })
    expect(await provisioningForWorkspaceRoot("/repos/sdk", deps)).toEqual({
      sparsePaths: ["own:/repos/sdk"],
    })
    expect(await bundleProvisioningForPath("/elsewhere", deps)).toEqual({})
  })

  it("names the clone as the source of a clone's declaration", async () => {
    resetHostClones()
    rememberHostClone("ws-multi", "/host/clones/app")
    const provisioning = await bundleProvisioningForPath("/host/clones/app", {
      declared: async () => ({ sparsePaths: ["web"] }),
      projects: async () => [MULTI],
    })
    expect(provisioning.provisioningSource).toBe("/host/clones/app")
    resetHostClones()
  })

  it("gives each root its own file, except the one the bundle's was read at", async () => {
    const resolve = jest.fn(async (sourceRoot: string) =>
      sourceRoot === "/repos/tools" ? undefined : { sparsePaths: [sourceRoot] }
    )
    const roots = await withRootProvisioning(
      [
        { logicalRootId: "app", role: "primary" as const, sourceRoot: "/repos/app/" },
        { logicalRootId: "app-pkg", role: "additional" as const, sourceRoot: "/repos/app/ui" },
        { logicalRootId: "sdk", role: "additional" as const, sourceRoot: "/repos/sdk" },
        { logicalRootId: "tools", role: "additional" as const, sourceRoot: "/repos/tools" },
        {
          logicalRootId: "given",
          role: "additional" as const,
          sourceRoot: "/repos/given",
          provisioning: { include: [".env"] },
        },
      ],
      resolve,
      "/repos/app"
    )
    expect(roots.map((root) => root.provisioning)).toEqual([
      undefined,
      { sparsePaths: ["/repos/app/ui"] },
      { sparsePaths: ["/repos/sdk"] },
      undefined,
      { include: [".env"] },
    ])
    expect(resolve.mock.calls.map(([path]) => path)).toEqual([
      "/repos/app/ui",
      "/repos/sdk",
      "/repos/tools",
    ])
  })

  it("mounts a run's directory with every other root of its workspace", async () => {
    const declared = jest.fn(async (_project: ProvisioningProject, configRoot?: string) =>
      configRoot ? { sparsePaths: [`own:${configRoot}`] } : { sparsePaths: ["web"] }
    )
    const deps = { declared, projects: async () => [MULTI], trusted: async () => true }
    const bundle = await bundleRootsForPath("/repos/sdk/src", deps)
    expect(bundle).toEqual({
      provisioning: { sparsePaths: ["own:/repos/sdk"] },
      provisioningSource: "/repos/sdk",
      roots: [
        { logicalRootId: "primary", role: "primary", sourceRoot: "/repos/sdk/src" },
        {
          logicalRootId: "app",
          role: "additional",
          sourceRoot: "/repos/app",
          provisioning: {
            sparsePaths: ["web"],
            cacheLinks: [{ source: "node_modules", target: "node_modules" }],
            include: [".env"],
          },
        },
        {
          logicalRootId: "app-pkg",
          role: "additional",
          sourceRoot: "/repos/app/packages/ui",
          provisioning: { sparsePaths: ["own:/repos/app/packages/ui"] },
        },
      ],
    })
    // The run's own root, the one it is inside, is not mounted twice.
    expect(bundle.roots.map((root) => root.sourceRoot)).not.toContain("/repos/sdk")
  })

  it("keeps a root id that would clash with the run's own a distinct one", async () => {
    const clashing = {
      id: "ws-clash",
      roots: [
        { id: "main", path: "/w/main", isPrimary: true },
        { id: "primary", path: "/w/other" },
      ],
    } as Project
    const bundle = await bundleRootsForPath("/w/main", {
      declared: async () => undefined,
      projects: async () => [clashing],
      trusted: async () => true,
    })
    expect(bundle.roots.map((root) => root.logicalRootId)).toEqual(["primary", "additional-1"])
  })

  it("leaves out a sibling the user has not trusted", async () => {
    const trusted = jest.fn(async (root: string) => root !== "/repos/app/packages/ui")
    const bundle = await bundleRootsForPath("/repos/sdk", {
      declared: async () => undefined,
      projects: async () => [MULTI],
      trusted,
    })
    expect(bundle.roots.map((root) => root.sourceRoot)).toEqual(["/repos/sdk", "/repos/app"])
    const failing = await bundleRootsForPath("/repos/sdk", {
      declared: async () => undefined,
      projects: async () => [MULTI],
      trusted: async () => {
        throw new Error("no store")
      },
    })
    expect(failing.roots.map((root) => root.sourceRoot)).toEqual(["/repos/sdk"])
  })

  it("is a bundle of one for a directory no workspace mounts", async () => {
    expect(
      await bundleRootsForPath("/elsewhere", {
        declared: async () => ({ sparsePaths: ["web"] }),
        projects: async () => [MULTI],
      })
    ).toEqual({
      roots: [{ logicalRootId: "primary", role: "primary", sourceRoot: "/elsewhere" }],
    })
    expect(
      await bundleRootsForPath("/repos/app", {
        declared: async () => undefined,
        projects: async () => {
          throw new Error("no store")
        },
      })
    ).toEqual({ roots: [{ logicalRootId: "primary", role: "primary", sourceRoot: "/repos/app" }] })
  })

  it("leaves a root alone when its lookup fails", async () => {
    const roots = await withRootProvisioning(
      [{ logicalRootId: "sdk", role: "additional" as const, sourceRoot: "/repos/sdk" }],
      async () => {
        throw new Error("no store")
      }
    )
    expect(roots[0]).toEqual({ logicalRootId: "sdk", role: "additional", sourceRoot: "/repos/sdk" })
  })
})

/**
 * The guard against this going dormant again.
 *
 * Provisioning existed and worked for a year while reaching exactly one of the
 * six places that acquire a workspace bundle, because nothing connected "a new
 * acquisition site" to "ask what it should be provisioned with". A seventh site
 * added without that call fails here.
 */
describe("every acquisition site asks for provisioning", () => {
  const callers = execFileSync(
    "git",
    ["grep", "-l", "acquireWorkspaceBundle\\|acquireBundle(", "--", "*.ts", "*.tsx"],
    { cwd: process.cwd(), encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
    // The client declares the function; the types file names it. Neither
    // acquires anything.
    .filter(
      (file) =>
        file !== "lib/task-workspace/client.ts" &&
        file !== "lib/task-workspace/types.ts" &&
        file !== "lib/task-workspace/workspace-provisioning.ts"
    )

  it("found the acquisition sites to check", () => {
    // A sweep that scanned nothing passes every assertion below it.
    expect(callers.length).toBeGreaterThanOrEqual(6)
  })

  it.each(callers)("%s passes provisioning to the bundle it acquires", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8")
    expect(source).toMatch(/provisioning/i)
  })
})
