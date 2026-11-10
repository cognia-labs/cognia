/** @jest-environment jsdom */
import type { ConnectorDraftRow } from "./connector-types"
import { createDraft, approveDraft, getDraft } from "./connector-drafts"
import { createDbTestFixture } from "./test-fixture"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("keeps the Host execution in the durable draft contract after approval", async () => {
  const row: ConnectorDraftRow = await createDraft({
    conversationKey: "lark:a:group",
    sessionId: "s",
    segments: [{ type: "text", text: "private summary" }],
    personalExecutionRunId: "host-execution",
  })
  await approveDraft(row.id)
  const approved = await getDraft(row.id)
  expect(approved?.status).toBe("approved")
  expect(approved?.personalExecutionRunId).toBe("host-execution")
})
