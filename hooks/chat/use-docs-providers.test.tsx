import { act, renderHook } from "@testing-library/react"
import { useDocsProvidersRevision } from "./use-docs-providers"
import { getDocsProvidersRevision, registerDocsProvider } from "@/lib/docs-providers/registry"

it("notifies mounted consumers on registration and disposal and unsubscribes on unmount", () => {
  const { result, unmount } = renderHook(useDocsProvidersRevision)
  const initial = result.current
  let stop!: () => void
  act(() => {
    stop = registerDocsProvider({
      id: "hook-test",
      mentionPrefix: "hook-test:",
      kinds: ["doc"],
      hosts: ["web"],
      listAccounts: async () => [],
      matchRef: () => null,
      fetch: jest.fn(),
    })
  })
  expect(result.current).toBe(initial + 1)
  act(() => stop())
  expect(result.current).toBe(initial + 2)
  unmount()
  expect(getDocsProvidersRevision()).toBe(initial + 2)
})
