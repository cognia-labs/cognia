/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import { collabSelfUserIdOf, useCollabSelf } from "./use-collab-self"

const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

describe("useCollabSelf", () => {
  it("is undefined until the first read, then the bound person", async () => {
    const read = jest.fn(async () => ({ userId: ADA, label: "Ada" }))
    const { result } = renderHook(() => useCollabSelf(read))
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toEqual({ userId: ADA, label: "Ada" }))
  })

  it("is null when nobody is signed in", async () => {
    const read = jest.fn(async () => null)
    const { result } = renderHook(() => useCollabSelf(read))
    await waitFor(() => expect(result.current).toBeNull())
  })
})

describe("collabSelfUserIdOf", () => {
  it("keeps unknown, nobody and somebody apart", () => {
    expect(collabSelfUserIdOf(undefined)).toBeUndefined()
    expect(collabSelfUserIdOf(null)).toBeNull()
    expect(collabSelfUserIdOf({ userId: ADA })).toBe(ADA)
  })
})
