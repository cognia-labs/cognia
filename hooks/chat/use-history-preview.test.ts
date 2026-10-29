/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  clearAllHistoryPreviews,
  clearHistoryPreview,
  setHistoryPreview,
} from "@/lib/chat/history-preview"

import { useHistoryPreview } from "./use-history-preview"

describe("useHistoryPreview", () => {
  afterEach(() => clearAllHistoryPreviews())

  it("follows the preview for its session only", () => {
    const { result, rerender } = renderHook(({ id }) => useHistoryPreview(id), {
      initialProps: { id: "s1" as string | null },
    })
    expect(result.current).toBeNull()
    const preview = { messages: [], total: 90, activeBranchByGroup: {} }
    act(() => setHistoryPreview("s1", preview))
    expect(result.current).toBe(preview)
    act(() => setHistoryPreview("s2", { ...preview, total: 1 }))
    expect(result.current).toBe(preview)
    act(() => clearHistoryPreview("s1"))
    expect(result.current).toBeNull()
    rerender({ id: null })
    expect(result.current).toBeNull()
  })
})
