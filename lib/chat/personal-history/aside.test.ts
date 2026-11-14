import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { readPersonalAsideHistory } from "./aside"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
afterAll(fixture.dispose)

it("removes withheld rows and their attachment identities before selection or listing", async () => {
  await getDb().sessions.bulkPut([
    { id: "main", title: "Main", createdAt: 1, updatedAt: 1 },
    { id: "aside", title: "Aside", createdAt: 1, updatedAt: 1 },
  ])
  await getDb().messages.bulkPut([
    {
      id: "public",
      sessionId: "main",
      role: "user",
      parts: [{ type: "text", text: "public fact" }],
      createdAt: 1,
    },
    {
      id: "private",
      sessionId: "main",
      role: "user",
      parts: [
        { type: "text", text: "WITHHELD_SECRET" },
        { type: "file", filename: "PRIVATE_FILENAME", url: "data:secret", mediaType: "image/png" },
      ],
      metadata: {
        personalMarks: [
          { person: { kind: "service", ref: "another-person" }, source: "test", markedAt: 1 },
        ],
      },
      createdAt: 2,
    },
  ])
  const result = await readPersonalAsideHistory("aside", "main")
  expect(result.messages.map((row) => row.id)).toEqual(["public"])
  expect(result.withheldMessageIds).toEqual(["private"])
  expect(JSON.stringify(result)).not.toContain("WITHHELD_SECRET")
  expect(JSON.stringify(result)).not.toContain("PRIVATE_FILENAME")
})
