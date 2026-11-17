/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerSkillChips } from "./use-composer-skill-chips"

const toggleEphemeralSkill = jest.fn()
const idsBySession: Record<string, string[]> = { s1: ["a", "b"] }
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { toggleEphemeralSkill: typeof toggleEphemeralSkill }) => unknown) =>
    selector({ toggleEphemeralSkill }),
  useComposerEphemeralSkillIds: (id: string | null) => (id ? (idsBySession[id] ?? []) : []),
}))

it("reads and removes the skills of THIS pane's conversation", () => {
  const { result } = renderHook(() =>
    useComposerSkillChips({ props: { session: { id: "s1" } as ChatSession } })
  )
  expect(result.current.ephemeralSkillIds).toEqual(["a", "b"])

  result.current.removeEphemeralSkill("a")
  expect(toggleEphemeralSkill).toHaveBeenCalledWith("a", "s1")
})
