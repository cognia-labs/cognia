/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import { syncMessages } from "./messages"

it("preserves portable marks and cannot erase known marks with an older paired row", async () => {
  const db = getDb()
  const personalMarks = [{ person: { kind: "local-person" }, source: "google-docs", markedAt: 10 }]
  const row = {
    id: "paired-marked",
    sessionId: "paired-session",
    role: "assistant" as const,
    parts: [],
    createdAt: 1,
  }
  const call = jest
    .fn()
    .mockResolvedValueOnce({
      rows: [{ ...row, metadata: { personalMarks, personalMarkVersion: 1 } }],
      deleted_ids: [],
      next_since: 1,
    })
    .mockResolvedValueOnce({ rows: [row], deleted_ids: [], next_since: 2 })
  const transport = { call, subscribe: () => () => {} } as Transport
  try {
    expect((await syncMessages(transport, { since: 0 })).ok).toBe(true)
    expect((await db.messages.get(row.id))?.metadata).toEqual({
      personalMarks,
      personalMarkVersion: 1,
    })
    expect((await syncMessages(transport, { since: 1 })).ok).toBe(true)
    expect((await db.messages.get(row.id))?.metadata).toEqual({
      personalMarks,
      personalMarkVersion: 1,
    })
  } finally {
    await db.messages.delete(row.id)
  }
})

it.each([undefined, { note: "legacy" }])(
  "cannot promote an existing paired legacy row (%j)",
  async (metadata) => {
    const db = getDb()
    const row = {
      id: "paired-legacy-version",
      sessionId: "paired-session",
      role: "assistant" as const,
      parts: [],
      createdAt: 1,
    }
    await db.messages.put({ ...row, metadata })
    const call = jest.fn().mockResolvedValue({
      rows: [{ ...row, metadata: { personalMarkVersion: 1 } }],
      deleted_ids: [],
      next_since: 1,
    })
    try {
      expect(
        (await syncMessages({ call, subscribe: () => () => {} } as Transport, { since: 0 })).ok
      ).toBe(true)
      expect((await db.messages.get(row.id))?.metadata ?? {}).not.toHaveProperty(
        "personalMarkVersion"
      )
    } finally {
      await db.messages.delete(row.id)
    }
  }
)
