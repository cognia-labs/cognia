/** @jest-environment jsdom */
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/workflow/runtime/tauri-bridge", () => ({ respondToWebhook: jest.fn() }))

import "./flow"
import { getExecutor } from "../registry"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { PersonalSinkWithheldError } from "@/lib/execution/personal-sink"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { respondToWebhook } from "@/lib/workflow/runtime/tauri-bridge"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

describe("flow-data-nodes registration", () => {
  it.each([
    ["data.aggregate", 1],
    ["data.code", 1],
    ["data.template", 1],
    ["data.transform", 1],
    ["flow.branch", 2],
    ["flow.break", 1],
    ["flow.catch", 1],
    ["flow.continue", 1],
    ["flow.join", 1],
    ["flow.set", 1],
    ["flow.split", 1],
    ["flow.subworkflow", 1],
    ["flow.switch", 2],
    ["flow.wait", 1],
    ["io.http", 1],
    ["io.output", 1],
    ["io.answer", 1],
    ["io.webhook.respond", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })

  it.each([
    ["flow.branch", 1],
    ["flow.switch", 1],
    ["flow.loop", 1],
    ["flow.loop", 2],
  ])("registers no %s@%s executor", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeUndefined()
  })
})

it.each(["io.http", "io.webhook.respond"])(
  "withholds the %s personal payload before its transport",
  async (kind) => {
    await startToolExecutionRun(undefined, {
      runId: "execution:workflow:workflow-run",
      localAuthorization: LOCAL_PERSON_RUN,
    })
    await getDb().executionRuns.update("execution:workflow:workflow-run", {
      personalMarks: [{ person: { kind: "local-person" }, source: "calendar", markedAt: 1 }],
    })
    const ctx = {
      runId: "workflow-run",
      workflowId: "workflow",
      stepId: "step",
      upstream: {},
      params:
        kind === "io.http"
          ? { url: "https://api.test/write", method: "POST", body: "private summary" }
          : { body: "private summary" },
      trigger: { payload: { correlationId: "inbound-request" } },
      log: jest.fn(),
    }
    await expect(getExecutor(kind as never, 1)!.execute(ctx as never)).rejects.toBeInstanceOf(
      PersonalSinkWithheldError
    )
    expect(proxyFetch).not.toHaveBeenCalled()
    expect(respondToWebhook).not.toHaveBeenCalled()
  }
)
