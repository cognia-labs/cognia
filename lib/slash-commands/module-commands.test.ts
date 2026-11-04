import type { SlashContext } from "@cognia/plugin-contract/lib/slash-commands/builtin"
import type { HostModuleManifest } from "@/lib/modules/manifest-types"

import { moduleSlashCommands } from "./module-commands"

const run = jest.fn()
const load = jest.fn(async () => ({ run }))

const manifest = (over: Partial<HostModuleManifest> = {}): HostModuleManifest => ({
  id: "crew",
  kind: "module",
  stage: "beta",
  slashCommands: [
    {
      name: "crew",
      description: "Talk to the crew.",
      category: "goal",
      argumentHint: "<status | run>",
      argumentOptions: ["status", "run"],
      load,
    },
  ],
  ...over,
})

beforeEach(() => jest.clearAllMocks())

describe("moduleSlashCommands", () => {
  it("turns each descriptor into a builtin-scope command without loading its handler", () => {
    const [command] = moduleSlashCommands([manifest()])
    expect(command).toMatchObject({
      name: "crew",
      description: "Talk to the crew.",
      scope: "builtin",
      category: "goal",
      argumentHint: "<status | run>",
      argumentOptions: ["status", "run"],
    })
    expect(load).not.toHaveBeenCalled()
  })

  it("loads the handler when the command runs and hands it the context", async () => {
    const [command] = moduleSlashCommands([manifest()])
    const ctx = { args: "status" } as unknown as SlashContext
    await command?.handler?.(ctx)
    expect(load).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(ctx)
  })

  it("lets a failing handler reject, so the composer reports it", async () => {
    run.mockRejectedValueOnce(new Error("boom"))
    const [command] = moduleSlashCommands([manifest()])
    await expect(command?.handler?.({} as SlashContext)).rejects.toThrow("boom")
  })

  it("contributes nothing for a module without commands", () => {
    expect(moduleSlashCommands([manifest({ slashCommands: undefined })])).toEqual([])
  })

  it("defaults to the active modules of the generated registry", () => {
    expect(moduleSlashCommands().map((command) => command.name)).toContain("squad")
  })
})
