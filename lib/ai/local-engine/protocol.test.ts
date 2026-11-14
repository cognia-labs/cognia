import manifest from "@/protocol/companion-commands.json"
import { LOCAL_PROVIDER_NAMES } from "@cognia/provider-types/local-provider"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  LOCAL_ENGINE_MUTATE_COMMAND,
  LOCAL_ENGINE_READ_COMMAND,
  MAX_CAPABILITY_MODELS,
} from "./protocol"

function descriptor(name: string) {
  return (manifest.commands as Array<Record<string, unknown>>).find((c) => c.name === name)
}

it("declares both commands as Execution commands that follow the active Host", () => {
  expect(descriptor(LOCAL_ENGINE_READ_COMMAND)).toMatchObject({
    target: "execution",
    operation: "read",
    approval: "none",
  })
  expect(descriptor(LOCAL_ENGINE_MUTATE_COMMAND)).toMatchObject({
    target: "execution",
    operation: "side-effect",
    capability: "workspace.write",
    // The person managing the panel is the one asking; like other workspace
    // writes it carries no admin lease (an interactive command would need one).
    approval: "none",
  })
})

it("keeps the request contract's engine list and bounds in step with the client", () => {
  const contract = readFileSync(
    join(process.cwd(), "scripts/build/companion-request-schema-contracts.mjs"),
    "utf8"
  )
  const block = contract.slice(contract.indexOf("const localEngineProviderId"))
  const names = block.slice(0, block.indexOf("])")).match(/"([a-z]+)"/g)
  expect(names?.map((n) => n.slice(1, -1))).toEqual([...LOCAL_PROVIDER_NAMES])
  expect(contract).toContain(`.max(${MAX_CAPABILITY_MODELS})`)
})
