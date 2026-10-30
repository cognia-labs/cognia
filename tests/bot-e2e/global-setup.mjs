import fs from "node:fs/promises"
import path from "node:path"
import { BUILD_MANIFEST, validateBuild } from "./prepare.mjs"

export default async function setup() {
  const selected = JSON.parse(
    await fs.readFile(BUILD_MANIFEST, "utf8").catch(() => {
      throw new Error("Bot E2E requires preparation: pnpm test:e2e:bots:prepare")
    })
  )
  const server = path.resolve(process.env.COGNIA_BOT_E2E_SERVER ?? selected.server)
  const brain = path.resolve(process.env.COGNIA_BOT_E2E_BRAIN ?? selected.brain)
  const build = await validateBuild(server, brain)
  process.env.COGNIA_BOT_E2E_SERVER = server
  process.env.COGNIA_BOT_E2E_BRAIN = brain
  process.env.COGNIA_BOT_E2E_BUILD_ID = build.inputDigest
}
