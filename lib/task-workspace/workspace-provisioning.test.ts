import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { rememberHostClone, resetHostClones } from "./host-clone-roots"
import {
  provisioningForProject,
  provisioningForWorkspaceRoot,
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
