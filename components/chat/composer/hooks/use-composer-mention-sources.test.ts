/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerMentionSources } from "./use-composer-mention-sources"

const useTeamMembers = jest.fn((..._args: unknown[]) => [])
const useTeamMemberRoles = jest.fn((..._args: unknown[]) => new Map())
jest.mock("@/hooks/use-team-members", () => ({
  useTeamMembers: (...args: unknown[]) => useTeamMembers(...args),
  useTeamMemberRoles: (...args: unknown[]) => useTeamMemberRoles(...args),
}))
const subagents = [{ id: "reviewer", handle: "reviewer" }]
let markdown: { id: string; handle: string }[] = []
jest.mock("@/hooks/chat/use-mentionable-subagents", () => ({
  useMentionableSubagents: () => subagents,
}))
jest.mock("@/hooks/chat/use-markdown-chat-agents", () => ({
  useMarkdownChatAgents: () => markdown,
}))
jest.mock("@/hooks/chat/use-mentionable-skills", () => ({ useMentionableSkills: () => [] }))
jest.mock("@/hooks/chat/use-mentionable-presets", () => ({ useMentionablePresets: () => [] }))
jest.mock("@/hooks/chat/use-apply-preset", () => ({ useApplyPreset: () => jest.fn() }))
const useRouteTargets = jest.fn((..._args: unknown[]) => ({ targets: [] }))
jest.mock("@/hooks/chat/use-route-targets", () => ({
  useRouteTargets: (...args: unknown[]) => useRouteTargets(...args),
}))

function session(extra: Partial<ChatSession>): ChatSession {
  return { id: "s1", kind: "direct", ...extra } as ChatSession
}

beforeEach(() => {
  jest.clearAllMocks()
  markdown = []
})

it("gives a direct chat the combined panel and routes on the session's provider", () => {
  const { result } = renderHook(() =>
    useComposerMentionSources({
      cwd: "/repo",
      defaultProvider: "openai",
      props: { session: session({ providerOverride: "deepseek" }) },
    })
  )

  expect(result.current.resolvedMentionMode).toBe("combined")
  expect(result.current.isCombinedMention).toBe(true)
  expect(result.current.chatAgents).toEqual(subagents)
  expect(useRouteTargets).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: true,
      providerId: "deepseek",
      reservedHandles: ["reviewer"],
    })
  )
  expect(result.current.entityContext).toEqual({ projectId: null, sessionId: "s1" })
})

it("adds markdown agents without letting them shadow a registered subagent", () => {
  markdown = [
    { id: "reviewer", handle: "shadow" },
    { id: "writer", handle: "writer" },
  ]
  const { result } = renderHook(() =>
    useComposerMentionSources({
      cwd: "/repo",
      defaultProvider: undefined,
      props: { session: session({}) },
    })
  )

  expect(result.current.chatAgents).toEqual([...subagents, { id: "writer", handle: "writer" }])
})

it("makes `@` mean a workflow node in the copilot and turns routing off", () => {
  const { result } = renderHook(() =>
    useComposerMentionSources({
      cwd: null,
      defaultProvider: undefined,
      props: { session: session({}), workflowMention: { elements: [] } },
    })
  )

  expect(result.current.resolvedMentionMode).toBe("workflow")
  expect(result.current.chatAgents).toBeUndefined()
  expect(useRouteTargets).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
})

it("reads the members of a team room and keeps the file picker elsewhere", () => {
  const team = renderHook(() =>
    useComposerMentionSources({
      cwd: null,
      defaultProvider: undefined,
      props: { session: session({ kind: "team", teamId: "t1" } as Partial<ChatSession>) },
    })
  )
  expect(team.result.current.resolvedMentionMode).toBe("combined")
  expect(useTeamMembers).toHaveBeenCalledWith("t1")

  const other = renderHook(() =>
    useComposerMentionSources({
      cwd: null,
      defaultProvider: undefined,
      props: { session: session({ kind: "workflow-editor" } as Partial<ChatSession>) },
    })
  )
  expect(other.result.current.resolvedMentionMode).toBe("files")
  expect(useTeamMembers).toHaveBeenLastCalledWith(null)
})
