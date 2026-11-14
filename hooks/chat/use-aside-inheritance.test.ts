/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { COMPOSER_APPEND_EVENT, type ComposerAppendDetail } from "@/lib/chat/composer-append"
import { useAsideInheritance } from "./use-aside-inheritance"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
beforeEach(async () => {
  await fixture.restore()
  await getDb().sessions.bulkPut([
    { id: "main", title: "Main", createdAt: 1, updatedAt: 1 },
    {
      id: "aside",
      title: "Aside",
      kind: "resource-workbench",
      surfaceBinding: { kind: "session", sessionId: "main" },
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  await getDb().messages.put({
    id: "file",
    sessionId: "main",
    role: "user",
    parts: [
      {
        type: "file",
        filename: "photo.png",
        mediaType: "image/png",
        url: "data:image/png;base64,YQ==",
      },
    ],
    createdAt: 1,
  })
})

it("persists inclusion toggles and stages a File only through the addressed composer event", async () => {
  const listener = jest.fn((event: Event) => {
    ;(event as CustomEvent<ComposerAppendDetail>).detail.claimed = true
  })
  window.addEventListener(COMPOSER_APPEND_EVENT, listener)
  const { result, unmount } = renderHook(() => useAsideInheritance("aside", "main"))
  try {
    await waitFor(() =>
      expect(result.current.data?.messages.map((row) => row.id)).toEqual(["file"])
    )
    expect(listener).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.setIncluded("file", true)
    })
    expect((await getDb().sessions.get("aside"))?.asidePinnedParentMessageIds).toEqual(["file"])
    await waitFor(() => expect(result.current.data?.summary.pinnedIncluded).toEqual(["file"]))
    await act(async () => {
      expect(await result.current.attach("file", 0)).toBeUndefined()
    })
    const detail = (listener.mock.calls[0][0] as CustomEvent<ComposerAppendDetail>).detail
    expect(detail.sessionId).toBe("aside")
    expect(detail.files?.[0]).toBeInstanceOf(File)
    expect(detail.files?.[0].name).toBe("photo.png")
    expect(detail.files?.[0].size).toBe(1)
    expect(detail.text).toBeUndefined()
    await act(async () => {
      await result.current.setIncluded("file", false)
    })
    expect((await getDb().sessions.get("aside"))?.asidePinnedParentMessageIds).toBeUndefined()
  } finally {
    unmount()
    window.removeEventListener(COMPOSER_APPEND_EVENT, listener)
  }
})

it("does not expose withheld text or attachments, and rechecks visibility on a stale click", async () => {
  const { result, unmount } = renderHook(() => useAsideInheritance("aside", "main"))
  try {
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(1))
    await act(async () => {
      await getDb().messages.update("file", {
        metadata: {
          personalMarks: [
            { person: { kind: "service", ref: "other" }, source: "test", markedAt: 1 },
          ],
        },
      })
      expect(await result.current.attach("file", 0)).toBe("missingBytes")
      await result.current.setIncluded("file", true)
    })
    await waitFor(() => expect(result.current.data?.hidden).toBe(1))
    expect(result.current.data?.messages).toEqual([])
    expect(result.current.data?.summary.attachments).toEqual([])
    expect((await getDb().sessions.get("aside"))?.asidePinnedParentMessageIds).toBeUndefined()
  } finally {
    unmount()
  }
})

it("checks cached media availability without touching the store or retriggering the live query", async () => {
  await getDb().messages.update("file", {
    parts: [
      { type: "file", filename: "cached.png", mediaType: "image/png", url: "cognia-media:cached" },
    ],
  })
  await getDb().messageMedia.put({
    hash: "cached",
    mediaType: "image/png",
    blob: new Blob(["a"]),
    width: 1,
    height: 1,
    byteSize: 1,
    createdAt: 1,
    lastUsedAt: 1,
  })
  const { result, unmount } = renderHook(() => useAsideInheritance("aside", "main"))
  try {
    await waitFor(() => expect(result.current.data?.attachments[0]?.unavailable).toBeUndefined())
    await waitFor(() => expect(result.current.data?.attachments).toHaveLength(1))
    expect((await getDb().messageMedia.get("cached"))?.lastUsedAt).toBe(1)
  } finally {
    unmount()
  }
})

it("prunes a disappearing pin even when its message was withheld from the picker", async () => {
  await getDb().sessions.update("aside", { asidePinnedParentMessageIds: ["file"] })
  await getDb().messages.update("file", {
    metadata: {
      personalMarks: [{ person: { kind: "service", ref: "other" }, source: "test", markedAt: 1 }],
    },
  })
  const { result, unmount } = renderHook(() => useAsideInheritance("aside", "main"))
  try {
    await waitFor(() => expect(result.current.data?.hidden).toBe(1))
    expect(result.current.data?.messages).toEqual([])
    await act(async () => {
      await getDb().messages.delete("file")
    })
    await waitFor(async () =>
      expect((await getDb().sessions.get("aside"))?.asidePinnedParentMessageIds).toBeUndefined()
    )
  } finally {
    unmount()
  }
})
