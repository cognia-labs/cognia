/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerSlashCommands } from "./use-composer-slash-commands"

let plugin: SlashCommand[] = []
jest.mock("@/hooks/chat/use-plugin-slash-commands", () => ({
  usePluginSlashCommands: () => plugin,
}))

const cmd = (name: string, extra: Partial<SlashCommand> = {}) =>
  ({ name, description: name, ...extra }) as SlashCommand
const tBestOfN = ((key: string) => `bestOfN.${key}`) as unknown as Parameters<
  typeof useComposerSlashCommands
>[0]["tBestOfN"]

function render(customCommands: SlashCommand[], session: Partial<ChatSession> | null = null) {
  return renderHook(() =>
    useComposerSlashCommands({
      customCommands,
      tBestOfN,
      props: { session: session as ChatSession | null },
    })
  ).result.current
}

beforeEach(() => {
  plugin = []
})

it("merges built-in, workspace and plugin commands once per name", () => {
  plugin = [cmd("record-skill"), cmd("plugin-only")]
  const { slashCommands } = render([cmd("deploy")])
  const names = slashCommands.map((c) => c.name)

  expect(names).toContain("deploy")
  expect(names).toContain("plugin-only")
  expect(names.filter((n) => n === "record-skill")).toHaveLength(1)
})

it("labels best-of-N from this locale", () => {
  const { slashCommands } = render([])
  expect(slashCommands.find((c) => c.name === "best-of-n")?.description).toBe("bestOfN.description")
})

it("resolves a typed command by name, scope included, and leaves side chats out of a workbench", () => {
  const { commandMap, commandScope } = render([cmd("deploy", { scope: "workspace" } as never)])
  expect(commandMap.get("deploy")?.name).toBe("deploy")
  expect(commandScope("deploy")).toBe("workspace")
  expect(commandScope("missing")).toBeUndefined()

  expect(commandMap.has("btw")).toBe(true)
  const aside = render([], { kind: "resource-workbench" } as Partial<ChatSession>)
  expect(aside.commandMap.has("btw")).toBe(false)
  expect(aside.slashCommands.some((c) => c.name === "side")).toBe(false)
})
