/**
 * @jest-environment jsdom
 */

import type { ChatSession } from "@cognia/agent-config-types"

const projectState = { activeProjectId: "p1", setActiveProject: jest.fn() }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => projectState },
}))
const uiState = { setSelectedGuild: jest.fn(), requestConversationReveal: jest.fn() }
jest.mock("@/stores/ui", () => ({ useUIStore: { getState: () => uiState } }))
const setActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => ({ setActiveSession }) } }))
const getSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => getSession(id) }))

import { focusSession, focusSessionInItsWorkspace, isOnChatRoute } from "./focus-session"

const teamSession = { id: "s2", projectId: "p2", kind: "team", teamId: "t1" } as ChatSession

beforeEach(() => {
  jest.clearAllMocks()
  projectState.activeProjectId = "p1"
})

describe("focusSession", () => {
  it("follows the workspace and the team before selecting, then asks for the row", () => {
    const select = jest.fn()
    focusSession(teamSession, "s2", select)
    expect(projectState.setActiveProject).toHaveBeenCalledWith("p2")
    expect(uiState.setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t1" })
    expect(select).toHaveBeenCalledWith("s2")
    expect(uiState.requestConversationReveal).toHaveBeenCalledWith("s2")
    expect(projectState.setActiveProject.mock.invocationCallOrder[0]).toBeLessThan(
      select.mock.invocationCallOrder[0]
    )
  })

  it("opens a direct conversation under Direct Messages and stays in its own workspace", () => {
    const select = jest.fn()
    focusSession({ projectId: "p1", kind: "direct" } as ChatSession, "s1", select)
    expect(projectState.setActiveProject).not.toHaveBeenCalled()
    expect(uiState.setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  })

  it("still focuses an id whose row is unknown, with nothing to follow", () => {
    const select = jest.fn()
    focusSession(undefined, "ghost", select)
    expect(projectState.setActiveProject).not.toHaveBeenCalled()
    expect(uiState.setSelectedGuild).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith("ghost")
    expect(uiState.requestConversationReveal).toHaveBeenCalledWith("ghost")
  })
})

describe("focusSessionInItsWorkspace", () => {
  it("reads the row, follows it, and focuses it in the chat store", async () => {
    getSession.mockResolvedValueOnce(teamSession)
    await focusSessionInItsWorkspace("s2")
    expect(projectState.setActiveProject).toHaveBeenCalledWith("p2")
    expect(uiState.setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t1" })
    expect(setActiveSession).toHaveBeenCalledWith("s2")
  })

  it("still focuses a conversation it could not load", async () => {
    getSession.mockRejectedValueOnce(new Error("gone"))
    await focusSessionInItsWorkspace("s-x")
    expect(projectState.setActiveProject).not.toHaveBeenCalled()
    expect(setActiveSession).toHaveBeenCalledWith("s-x")
  })
})

describe("isOnChatRoute", () => {
  it("is the root route only", () => {
    expect(isOnChatRoute("/")).toBe(true)
    expect(isOnChatRoute("/conversations")).toBe(false)
    expect(isOnChatRoute("/settings")).toBe(false)
  })
})
