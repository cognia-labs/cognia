import {
  CERTIFIED_LARK_CLI_VERSION,
  LARK_CLI_CAPABILITY_MANIFEST,
  LARK_CLI_REQUIRED_FLAGS,
  probeLarkCliCapabilities,
} from "./capabilities"

it("certifies all 43 registered Lark skill commands", () => {
  expect(CERTIFIED_LARK_CLI_VERSION).toBe("1.0.98")
  expect(Object.keys(LARK_CLI_CAPABILITY_MANIFEST)).toHaveLength(43)
  expect(Object.keys(LARK_CLI_REQUIRED_FLAGS)).toEqual(
    expect.arrayContaining(Object.keys(LARK_CLI_CAPABILITY_MANIFEST))
  )
})

it("fails closed on version mismatch and missing commands", async () => {
  const diagnostics = await probeLarkCliCapabilities(async (args) => {
    if (args[0] === "--version") return "lark-cli version 1.0.99"
    if (args.includes("+cells-get")) throw new Error("unknown command")
    const flags = Object.entries(LARK_CLI_CAPABILITY_MANIFEST)
      .filter(([, command]) => command.every((part, index) => args[index] === part))
      .flatMap(
        ([skillId]) => LARK_CLI_REQUIRED_FLAGS[skillId as keyof typeof LARK_CLI_REQUIRED_FLAGS]
      )
    return flags.join("\n") || "ok"
  })
  expect(diagnostics.ready).toBe(false)
  expect(diagnostics.detectedVersion).toBe("1.0.99")
  expect(diagnostics.affectedSkillIds).toHaveLength(43)
  expect(diagnostics.missingCommands).toContain("sheets +cells-get")
})

it("fails closed when a required flag is missing", async () => {
  const diagnostics = await probeLarkCliCapabilities(async (args) => {
    if (args[0] === "--version") return "lark-cli version 1.0.98"
    return "--unrelated"
  })
  expect(diagnostics.ready).toBe(false)
  expect(diagnostics.missingFlags["lark.sheets.create"]).toContain("--title")
})

it("passes only when the certified version exposes every command and required flag", async () => {
  const diagnostics = await probeLarkCliCapabilities(async (args) => {
    if (args[0] === "--version") return "lark-cli version 1.0.98"
    return Object.entries(LARK_CLI_CAPABILITY_MANIFEST)
      .filter(([, command]) => command.every((part, index) => args[index] === part))
      .flatMap(
        ([skillId]) => LARK_CLI_REQUIRED_FLAGS[skillId as keyof typeof LARK_CLI_REQUIRED_FLAGS]
      )
      .join("\n")
  })
  expect(diagnostics).toMatchObject({
    ready: true,
    detectedVersion: "1.0.98",
    missingCommands: [],
    missingFlags: {},
    affectedSkillIds: [],
  })
})

it("fails closed on the formerly certified version even when all capabilities exist", async () => {
  const diagnostics = await probeLarkCliCapabilities(async (args) => {
    if (args[0] === "--version") return "lark-cli version 1.0.83"
    return Object.entries(LARK_CLI_CAPABILITY_MANIFEST)
      .filter(([, command]) => command.every((part, index) => args[index] === part))
      .flatMap(
        ([skillId]) => LARK_CLI_REQUIRED_FLAGS[skillId as keyof typeof LARK_CLI_REQUIRED_FLAGS]
      )
      .join("\n")
  })
  expect(diagnostics).toMatchObject({
    ready: false,
    detectedVersion: "1.0.83",
    missingCommands: [],
    missingFlags: {},
  })
  expect(diagnostics.affectedSkillIds).toHaveLength(43)
})

it("fails closed on a missing command in the certified version", async () => {
  const diagnostics = await probeLarkCliCapabilities(async (args) => {
    if (args[0] === "--version") return "lark-cli version 1.0.98"
    if (args.includes("+cells-get")) throw new Error("unknown command")
    return Object.entries(LARK_CLI_CAPABILITY_MANIFEST)
      .filter(([, command]) => command.every((part, index) => args[index] === part))
      .flatMap(
        ([skillId]) => LARK_CLI_REQUIRED_FLAGS[skillId as keyof typeof LARK_CLI_REQUIRED_FLAGS]
      )
      .join("\n")
  })
  expect(diagnostics).toMatchObject({
    ready: false,
    detectedVersion: "1.0.98",
    missingCommands: ["sheets +cells-get"],
    missingFlags: {},
    affectedSkillIds: ["lark.sheets.read_range"],
  })
})
