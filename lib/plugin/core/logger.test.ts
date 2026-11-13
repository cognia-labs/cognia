import { captureLogEgressSource } from "@cognia/logging/context"
import { createPluginSystemLogger } from "./logger"
import { withPluginExecutionContext, withPluginContentDispatch } from "./invocation-identity"
const seen: unknown[] = []
jest.mock("@cognia/plugin-contract/lib/plugin/core/logger", () => ({
  createPluginSystemLogger: () => ({
    info: () => seen.push(captureLogEgressSource()),
    child() {
      return this
    },
    withContext() {
      return this
    },
  }),
}))
it("S2 internal API loggers capture the current producer for every level call", async () => {
  const logger = createPluginSystemLogger("s2-logger")
  logger.info("background")
  await withPluginExecutionContext("s2-logger", { personalEgressBlocked: true }, async () =>
    logger.child("ocr").info("private provider name")
  )
  expect(seen).toEqual([undefined, { version: 1, runIds: [], blocked: true }])
})

it("F2 deferred logger entries retain instance exposure after callback release", async () => {
  seen.length = 0
  const logger = createPluginSystemLogger("f2-delayed-log")
  await withPluginContentDispatch(
    "f2-delayed-log",
    { personalEgressBlocked: true },
    async () => undefined
  )
  logger.info("deferred private stash")
  expect(seen).toEqual([{ version: 1, runIds: [], blocked: true }])
})
