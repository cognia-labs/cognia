import { readContextSessionState } from "@/lib/claude/context-session-state"
import {
  KNOWLEDGE_SESSION_STATE_KEY,
  captureKnowledgeSessionState,
  clearKnowledgeReaderForSession,
  liveKnowledgeSessionState,
  getKnowledgeReaderForSession,
  registerKnowledgeReaderForSession,
  registerKnowledgeAccessForSession,
  getKnowledgeAccessForSession,
} from "./session-reader"

afterEach(() => clearKnowledgeReaderForSession("session"))
it("fails closed for unregistered sessions and clears stale authority", () => {
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
  registerKnowledgeReaderForSession("session", {
    knowledgeBaseIds: ["kb"],
    settings: { enabled: true },
  })
  expect(getKnowledgeReaderForSession("session")?.settings.enabled).toBe(true)
  clearKnowledgeReaderForSession("session")
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
})
it("expires inactive registrations and rejects empty sessions", () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(0)
  registerKnowledgeReaderForSession("session", { knowledgeBaseIds: [] })
  now.mockReturnValue(3_600_001)
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
  expect(() => registerKnowledgeReaderForSession("", { knowledgeBaseIds: [] })).toThrow(
    "session_required"
  )
  now.mockRestore()
})

it("captures execution authority even when progressive tools are disabled and copies nested ceilings", () => {
  const knowledgeAccess = {
    entrypoint: "http" as const,
    revisionBindings: { kb: ["gen"] },
    allowedKnowledgeBaseIds: ["kb"],
  }
  registerKnowledgeAccessForSession("session", { knowledgeBaseIds: ["kb"], knowledgeAccess })
  knowledgeAccess.allowedKnowledgeBaseIds.push("other")
  const captured = getKnowledgeAccessForSession("session")!
  expect(captured.knowledgeAccess.allowedKnowledgeBaseIds).toEqual(["kb"])
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
  captured.knowledgeAccess.allowedKnowledgeBaseIds = []
  expect(getKnowledgeAccessForSession("session")!.knowledgeAccess.allowedKnowledgeBaseIds).toEqual([
    "kb",
  ])
})

it("keeps the capture in the kernel's conversation state under the reader contribution's key", () => {
  registerKnowledgeAccessForSession("session", { knowledgeBaseIds: ["kb"] })
  const state = readContextSessionState("session", KNOWLEDGE_SESSION_STATE_KEY)
  expect(KNOWLEDGE_SESSION_STATE_KEY).toBe("knowledge-base.reader")
  expect(liveKnowledgeSessionState(state)?.knowledgeBaseIds).toEqual(["kb"])
  expect(liveKnowledgeSessionState(undefined)).toBeUndefined()
  expect(liveKnowledgeSessionState({ knowledgeBaseIds: [] })).toBeUndefined()
})

it("captures a copy of what the contribution resolved", () => {
  const ids = ["kb"]
  const capture = captureKnowledgeSessionState({ knowledgeBaseIds: ids })
  ids.push("other")
  expect(capture.knowledgeBaseIds).toEqual(["kb"])
  expect(capture.knowledgeAccess).toEqual({})
  expect(capture.reader).toBeUndefined()
})
