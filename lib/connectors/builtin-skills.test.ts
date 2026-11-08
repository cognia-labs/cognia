import type { BuiltInSkillAvailability } from "@/lib/skills/built-in/types"
import { getSharedBuiltInSkillRegistry } from "@/lib/skills/built-in/registry"
import { availability, builtInSkillFamilies, register } from "./builtin-skills"
import { connectorVendors } from "./vendor-contribution"

// The fake catalog is built inside the factory: the module under test reads
// it while it is imported, before this file's own declarations run.
jest.mock("./vendor-contribution", () => {
  const gate = (prefix: string, available: boolean, key: string | null) => ({
    governs: (id: string) => id.startsWith(prefix),
    isAvailable: () => available,
    settle: jest.fn(async () => key),
  })
  const cli = gate("acme.", false, "cli-ready")
  const none = gate("other.", true, null)
  const vendors = [
    {
      platform: "acme",
      builtInSkills: { families: ["acme.docs"], load: async () => ({ availability: cli }) },
    },
    {
      platform: "other",
      builtInSkills: { families: [], load: async () => ({ availability: none }) },
    },
    { platform: "plain" },
  ]
  return { connectorVendors: () => vendors }
})

async function cliGate(): Promise<BuiltInSkillAvailability> {
  const loaded = await connectorVendors()[0].builtInSkills?.load()
  if (!loaded?.availability) throw new Error("fake catalog has no gate")
  return loaded.availability
}

describe("the connectors' built-in skill contribution", () => {
  it("declares the im family and every vendor's", () => {
    expect(builtInSkillFamilies).toEqual(["im", "acme.docs"])
  })

  it("registers the im family on import", () => {
    expect(
      getSharedBuiltInSkillRegistry()
        .list()
        .some((skill) => skill.family === "im")
    ).toBe(true)
  })

  it("answers from the vendors' gates once registered", async () => {
    expect(availability.governs("acme.docs.read")).toBe(false)
    await register()
    expect(availability.governs("acme.docs.read")).toBe(true)
    expect(availability.isAvailable("acme.docs.read")).toBe(false)
    expect(availability.governs("im.broadcast")).toBe(false)
    expect(availability.isAvailable("im.broadcast")).toBe(true)
    await expect(availability.settle({})).resolves.toBe("cli-ready")
    expect((await cliGate()).settle).toHaveBeenCalledWith({})
  })

  it("needs nothing when no vendor gate does", async () => {
    await register()
    jest.mocked((await cliGate()).settle).mockResolvedValueOnce(null)
    await expect(availability.settle({ platform: "telegram" })).resolves.toBeNull()
  })
})
