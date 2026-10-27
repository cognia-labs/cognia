import { renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const pathRef = { value: "/" as string | null }
jest.mock("next/navigation", () => ({ usePathname: () => pathRef.value }))

const labelRef = { value: null as string | null }
jest.mock("@/hooks/chat/use-active-session-label", () => ({
  useActiveSessionLabel: () => ({ label: labelRef.value }),
}))

import { useBarTitle } from "./use-bar-title"

beforeEach(() => {
  pathRef.value = "/"
  labelRef.value = null
})

test("names the conversation on the chat home", () => {
  labelRef.value = "Refactor the parser"
  const { result } = renderHook(() => useBarTitle())
  expect(result.current.label).toBe("Refactor the parser")
  expect(result.current.title.kind).toBe("conversation")
})

test("names the page elsewhere, through the rail's label", () => {
  pathRef.value = "/workflows"
  labelRef.value = "Refactor the parser"
  const { result } = renderHook(() => useBarTitle())
  expect(result.current.label).toBe("desktop.guildRail.workflows")
})

test("prints nothing beyond the app name off every known page", () => {
  pathRef.value = "/onboarding"
  expect(renderHook(() => useBarTitle()).result.current.label).toBeNull()
})

test("treats a missing pathname as the chat home", () => {
  pathRef.value = null
  labelRef.value = "Chat"
  expect(renderHook(() => useBarTitle()).result.current.label).toBe("Chat")
})

test("followRoute: false keeps naming the conversation on any route", () => {
  pathRef.value = "/pet"
  labelRef.value = "Chat"
  const { result } = renderHook(() => useBarTitle({ followRoute: false }))
  expect(result.current.label).toBe("Chat")
})
