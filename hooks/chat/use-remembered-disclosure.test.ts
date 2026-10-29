/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  readDisclosure,
  resetDisclosureMemory,
  writeDisclosure,
} from "@/lib/chat/disclosure-memory"

import { useRememberedDisclosure, useRememberedDisclosures } from "./use-remembered-disclosure"

describe("useRememberedDisclosure", () => {
  afterEach(() => resetDisclosureMemory())

  it("reports no choice until one is made, then survives a remount", () => {
    const first = renderHook(() => useRememberedDisclosure("s:m:fold"))
    expect(first.result.current[0]).toBeUndefined()
    act(() => first.result.current[1](true))
    expect(first.result.current[0]).toBe(true)
    first.unmount()

    const second = renderHook(() => useRememberedDisclosure("s:m:fold"))
    expect(second.result.current[0]).toBe(true)
  })

  it("follows writes made elsewhere", () => {
    const { result } = renderHook(() => useRememberedDisclosure("k"))
    act(() => writeDisclosure("k", false))
    expect(result.current[0]).toBe(false)
  })

  it("keeps a null key's choice local to the component", () => {
    const { result } = renderHook(() => useRememberedDisclosure(null))
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(readDisclosure("-")).toBeUndefined()
  })
})

describe("useRememberedDisclosures", () => {
  afterEach(() => resetDisclosureMemory())

  it("maps only keys with a choice and keeps identity across equal key arrays", () => {
    writeDisclosure("a", true)
    const { result, rerender } = renderHook(({ keys }) => useRememberedDisclosures(keys), {
      initialProps: { keys: ["a", "b"] },
    })
    const first = result.current[0]
    expect([...first]).toEqual([["a", true]])

    rerender({ keys: ["a", "b"] })
    expect(result.current[0]).toBe(first)

    act(() => result.current[1](["a", "b"], false))
    expect([...result.current[0]]).toEqual([
      ["a", false],
      ["b", false],
    ])
  })

  it("updates when one of its keys is written elsewhere", () => {
    const { result } = renderHook(() => useRememberedDisclosures(["x"]))
    act(() => writeDisclosure("x", true))
    expect(result.current[0].get("x")).toBe(true)
  })
})
