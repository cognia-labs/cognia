/** @jest-environment jsdom */
// The broker unit suites mock the personal gate; this suite keeps the actual
// gate and receipts to prove raw read requests cannot bypass confidentiality.
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { PersonalSinkWithheldError } from "@/lib/execution/personal-sink"
import { authenticatedIntegrationRequest } from "./action-runner"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("withholds raw GET query/header content before account lookup, credential access, or fetch", async () => {
  const run = await startToolExecutionRun("chat", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [{ person: { kind: "local-person" }, source: "calendar", markedAt: 1 }],
  })
  const originalFetch = global.fetch
  const fetch = jest.fn()
  global.fetch = fetch
  try {
    await expect(
      authenticatedIntegrationRequest(
        "plugin",
        "nonexistent-account",
        "https://api.test/search?q=private-summary",
        { method: "GET", headers: { "X-Context": "private-summary" } },
        { sessionId: "chat", executionRunId: run.id }
      )
    ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
    expect(fetch).not.toHaveBeenCalled()
    const [receipt] = await getDb().actionReviewReceipts.toArray()
    expect(receipt.personal).toMatchObject({
      outcome: "withheld",
      originalTarget: "https://api.test/search?q=private-summary",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  } finally {
    global.fetch = originalFetch
  }
})

it("fails closed for an unresolvable raw-request execution before reading an account", async () => {
  await expect(
    authenticatedIntegrationRequest(
      "plugin",
      "nonexistent-account",
      "https://api.test/read",
      undefined,
      { executionRunId: "unresolvable-host-run" }
    )
  ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
})
