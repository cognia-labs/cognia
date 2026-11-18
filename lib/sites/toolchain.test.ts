import {
  measureSiteToolchain,
  parseSiteToolchainSpec,
  parseToolVersion,
  type MeasureSiteToolchainInput,
} from "./toolchain"
import type { ConfinedSiteBuildInput, ConfinedSiteBuildResult } from "./confined-build"

function result(partial: Partial<ConfinedSiteBuildResult>): ConfinedSiteBuildResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationSeconds: 0,
    timedOut: false,
    outputTruncated: false,
    ...partial,
  }
}

function sandbox(versions: Record<string, ConfinedSiteBuildResult>) {
  return jest.fn(async (input: ConfinedSiteBuildInput) => {
    const answer = versions[input.argv[0] ?? ""]
    if (!answer) return result({ exitCode: 127, stderr: `${input.argv[0]}: command not found` })
    return answer
  })
}

const input: MeasureSiteToolchainInput = {
  runtime: "node@24",
  packageManager: "pnpm@10",
  sandbox: { cwd: "/repo/site", writableRoots: ["/repo/site"], readableRoots: ["/repo"] },
  packageManagerNetworkHosts: ["registry.npmjs.org"],
}

describe("parseSiteToolchainSpec", () => {
  it("reads a tool and its pinned major", () => {
    expect(parseSiteToolchainSpec("node@24", "runtime")).toEqual({ tool: "node", major: 24 })
    expect(parseSiteToolchainSpec("pnpm@10.12", "pm")).toEqual({ tool: "pnpm", major: 10 })
    expect(parseSiteToolchainSpec("bun", "pm")).toEqual({ tool: "bun" })
  })

  it("refuses anything that is not a plain command name", () => {
    expect(() => parseSiteToolchainSpec("../bin/node@24", "runtime")).toThrow("command name")
    expect(() => parseSiteToolchainSpec("node@24@1", "runtime")).toThrow("command name")
    expect(() => parseSiteToolchainSpec("node@latest", "runtime")).toThrow("major number")
  })
})

describe("parseToolVersion", () => {
  it("strips the v prefix and trailing noise", () => {
    expect(parseToolVersion("v24.3.0\n")).toBe("24.3.0")
    expect(parseToolVersion("10.12.1")).toBe("10.12.1")
    expect(parseToolVersion("no version here")).toBeUndefined()
  })
})

describe("measureSiteToolchain", () => {
  it("asks each tool for its version inside the build sandbox and records what it said", async () => {
    const run = sandbox({
      node: result({ stdout: "v24.3.0\n" }),
      pnpm: result({ stdout: "10.12.1\n" }),
    })
    await expect(measureSiteToolchain(input, run)).resolves.toEqual({
      runtime: "node@24.3.0",
      packageManager: "pnpm@10.12.1",
    })
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        argv: ["node", "--version"],
        cwd: "/repo/site",
        writableRoots: ["/repo/site"],
        readableRoots: ["/repo"],
        networkHosts: undefined,
      })
    )
    // A Corepack shim fetches the pinned release, so the probe gets the
    // install phase's allowance and nothing more.
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ argv: ["pnpm", "--version"], networkHosts: ["registry.npmjs.org"] })
    )
  })

  it("fails when the sandbox runs a different major than the version claims (F14)", async () => {
    const run = sandbox({
      node: result({ stdout: "v20.11.0\n" }),
      pnpm: result({ stdout: "10.12.1\n" }),
    })
    await expect(measureSiteToolchain(input, run)).rejects.toThrow(
      "Build runtime node@24 was requested, but the build sandbox runs node 20.11.0"
    )
  })

  it("fails on a package-manager major mismatch too", async () => {
    const run = sandbox({
      node: result({ stdout: "v24.3.0\n" }),
      pnpm: result({ stdout: "9.15.0\n" }),
    })
    await expect(measureSiteToolchain(input, run)).rejects.toThrow("pnpm@10 was requested")
  })

  it("names a tool the sandbox does not have", async () => {
    const run = sandbox({ node: result({ stdout: "v24.3.0" }) })
    await expect(measureSiteToolchain(input, run)).rejects.toThrow(
      "Package manager pnpm is not available in the build sandbox (pnpm: command not found)"
    )
  })

  it("accepts any version for an unpinned spec and still records it", async () => {
    const run = sandbox({
      node: result({ stdout: "v22.1.0" }),
      bun: result({ stdout: "1.1.30" }),
    })
    await expect(
      measureSiteToolchain({ ...input, runtime: "node", packageManager: "bun" }, run)
    ).resolves.toEqual({ runtime: "node@22.1.0", packageManager: "bun@1.1.30" })
  })

  it("reports a probe that timed out or printed nothing usable", async () => {
    await expect(
      measureSiteToolchain(input, sandbox({ node: result({ timedOut: true, exitCode: -1 }) }))
    ).rejects.toThrow("timed out")
    await expect(
      measureSiteToolchain(input, sandbox({ node: result({ stdout: "hello" }) }))
    ).rejects.toThrow("printed no version")
  })
})
