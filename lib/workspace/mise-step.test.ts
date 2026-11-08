import { createHash } from "node:crypto"

import {
  MISE_STEP_SCRIPT,
  MISE_STEP_VARIABLES,
  acceptedMiseDigests,
  miseStepId,
  miseStepNotices,
  planMiseStep,
  readMiseFiles,
} from "./mise-step"

const sha256Hex = async (value: string) => createHash("sha256").update(value).digest("hex")

function io(files: Record<string, string>) {
  return {
    readFile: jest.fn(async (_root: string, relPath: string) => {
      if (!(relPath in files)) throw new Error(`not found: ${relPath}`)
      return files[relPath]!
    }),
    sha256Hex,
  }
}

describe("readMiseFiles", () => {
  it("is null for a root without a mise config", async () => {
    expect(await readMiseFiles("/repo", io({ "package.json": "{}" }))).toBeNull()
  })

  it("digests the config and its lockfile, so editing either changes it", async () => {
    const base = await readMiseFiles(
      "/repo",
      io({ "mise.toml": '[tools]\nnode = "22"\n', "mise.lock": "a" })
    )
    expect(base?.files).toEqual(["mise.toml", "mise.lock"])
    expect(base?.digest).toMatch(/^[0-9a-f]{16}$/)
    const lockEdited = await readMiseFiles(
      "/repo",
      io({ "mise.toml": '[tools]\nnode = "22"\n', "mise.lock": "b" })
    )
    const configEdited = await readMiseFiles(
      "/repo",
      io({ "mise.toml": '[tools]\nnode = "24"\n', "mise.lock": "a" })
    )
    expect(lockEdited?.digest).not.toBe(base?.digest)
    expect(configEdited?.digest).not.toBe(base?.digest)
  })

  it("prefers mise.toml, and reads the dotted config with its own lockfile", async () => {
    expect(
      (await readMiseFiles("/repo", io({ ".mise.toml": "x", ".mise.lock": "y" })))?.files
    ).toEqual([".mise.toml", ".mise.lock"])
    expect(
      (await readMiseFiles("/repo", io({ "mise.toml": "x", ".mise.toml": "y" })))?.files
    ).toEqual(["mise.toml"])
  })
})

describe("consent ids", () => {
  it("binds an acceptance to one digest and ignores anything else", () => {
    expect(miseStepId("abc123")).toBe("setupStep:mise@abc123")
    expect(
      acceptedMiseDigests([
        "setupStep:mise@abc123",
        "cacheLink:node_modules",
        "setupStep:mise@NOT-HEX",
        "setupStep:mise@",
      ])
    ).toEqual(new Set(["abc123"]))
    expect(acceptedMiseDigests(undefined)).toEqual(new Set())
  })
})

describe("planMiseStep", () => {
  const files = { "mise.toml": '[tools]\nnode = "22"\n' }
  const deps = (accepted: readonly string[] | null, restricted = false) => ({
    ...io(files),
    acceptedIds: jest.fn(async () => accepted),
    restricted: jest.fn(async () => restricted),
  })
  const input = { executionRoot: "/wt/app", projectId: "p1" }

  it("does nothing, and says nothing, without mise files", async () => {
    expect(await planMiseStep(input, { ...deps([]), ...io({}) })).toEqual({
      step: null,
      notices: [],
    })
  })

  it("never runs before the files are accepted at this exact content", async () => {
    expect(await planMiseStep(input, deps([]))).toEqual({
      step: null,
      notices: ["miseNotApproved"],
    })
    expect(await planMiseStep(input, deps(null))).toEqual({
      step: null,
      notices: ["miseNotApproved"],
    })
    // Accepted for other content: an edit since then is not approved.
    expect(await planMiseStep(input, deps([miseStepId("0000000000000000")]))).toEqual({
      step: null,
      notices: ["miseNotApproved"],
    })
  })

  it("runs for accepted files in a trusted workspace only", async () => {
    const current = (await readMiseFiles("/wt/app", io(files)))!
    const accepted = [miseStepId(current.digest)]
    expect(await planMiseStep(input, deps(accepted))).toEqual({ step: current, notices: [] })
    expect(await planMiseStep(input, deps(accepted, true))).toEqual({
      step: null,
      notices: ["miseUntrusted"],
    })
    const failing = deps(accepted)
    failing.restricted.mockRejectedValueOnce(new Error("no store"))
    expect((await planMiseStep(input, failing)).step).toBeNull()
  })
})

describe("the step itself", () => {
  it("holds mise to safe mode and runs nothing but install", () => {
    expect(MISE_STEP_VARIABLES).toEqual({ MISE_SAFE: "1", MISE_NO_HOOKS: "1" })
    for (const script of [MISE_STEP_SCRIPT.default, MISE_STEP_SCRIPT.byOs.windows]) {
      expect(script).toContain("mise install")
      expect(script).toContain("mise settings get safe")
      expect(script).not.toMatch(/mise (run|exec|use|trust|activate|self-update)|curl|install\.sh/)
    }
  })

  it("reads the notices the step printed, once each", () => {
    expect(
      miseStepNotices(
        "cognia-setup-notice:miseMissing\r\nother\ncognia-setup-notice:miseMissing\n" +
          "cognia-setup-notice:somethingElse\n"
      )
    ).toEqual(["miseMissing"])
    expect(miseStepNotices("  cognia-setup-notice:miseNoSafeMode  ")).toEqual(["miseNoSafeMode"])
    expect(miseStepNotices(undefined)).toEqual([])
  })
})
