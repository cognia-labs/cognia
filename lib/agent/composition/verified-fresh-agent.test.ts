import type { UIMessage } from "ai"
import type { ChatSession, SendOptions } from "@cognia/agent-config-types"

import {
  VERIFICATION_DORMANT_PROFILES,
  VERIFIER_PROMPT,
  armVerifiedFreshAgentFollowup,
  buildVerificationPrompt,
  newAssistantReply,
  parseVerificationVerdict,
  verdictOfTurn,
  runVerifiedFreshAgentTurn,
  verificationAvailableOn,
  verificationSessionTitle,
  type VerificationFollowupDeps,
  type VerificationFollowupStore,
  type VerifiedFreshAgentTurnDeps,
} from "./verified-fresh-agent"
import { chatOrchestrationUnavailableReason } from "./chat-orchestrations"
import type { VerificationVerdictPart } from "@/lib/chat/parts-extensions"
import type { ChatStatus } from "@/stores/chat/chat-store"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

const MAIN_ID = "main-session"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

function text(id: string, role: "user" | "assistant", body: string): UIMessage {
  return { id, role, parts: [{ type: "text", text: body }] }
}

function turnDeps(overrides: Partial<VerifiedFreshAgentTurnDeps> = {}) {
  const calls: {
    createSession: unknown[]
    resolveCtx: unknown[]
    runArgs: unknown[]
  } = {
    createSession: [],
    resolveCtx: [],
    runArgs: [],
  }
  const deps: VerifiedFreshAgentTurnDeps = {
    createSession: jest.fn(async (partial) => {
      calls.createSession.push(partial)
      return { id: "fresh-session" }
    }),
    getSession: jest.fn(async (id) => ({ id, title: "Verify: x" }) as ChatSession),
    getSettings: jest.fn(async () => ({ theme: "dark" })),
    resolveSendOptions: jest.fn(async (ctx) => {
      calls.resolveCtx.push(ctx)
      return { permissionMode: "default", resumeSessionId: "stale" } as SendOptions
    }),
    runAndCapture: jest.fn(async (...args) => {
      calls.runArgs.push(args)
      return {
        text: '{"verdict":"fail","summary":"Tests were not run.","points":["No test output in the reply"]}',
        messageId: "verifier-reply",
      }
    }),
    readDiff: jest.fn(async () => ({ text: "+added line", fileCount: 1, truncated: false })),
    persistTranscript: jest.fn(async () => undefined),
    ...overrides,
  }
  return { deps, calls }
}

describe("buildVerificationPrompt", () => {
  it("carries the request, the reply and the diff, and nothing else", () => {
    const prompt = buildVerificationPrompt({
      request: "Add a test",
      reply: "Done, added it",
      diff: { text: "+it(...)", fileCount: 1, truncated: true },
    })
    expect(prompt).toContain("## The user's request\nAdd a test")
    expect(prompt).toContain("## The agent's final reply\nDone, added it")
    expect(prompt).toContain("(1 file, truncated)")
    expect(prompt).toContain("+it(...)")
  })

  it("says when there is no diff instead of omitting the section", () => {
    const prompt = buildVerificationPrompt({ request: "r", reply: "a", diff: null })
    expect(prompt).toContain("(no repository, or nothing changed)")
  })
})

describe("parseVerificationVerdict", () => {
  it("reads a well formed answer", () => {
    expect(
      parseVerificationVerdict(
        '```json\n{"verdict":"pass","summary":"ok","points":[" a ", ""]}\n```'
      )
    ).toEqual({ verdict: "pass", summary: "ok", points: ["a"] })
  })

  it("never turns an undecided or malformed answer into a pass", () => {
    expect(parseVerificationVerdict('{"summary":"hm"}').verdict).toBe("unsure")
    expect(parseVerificationVerdict('{"verdict":"yes"}').verdict).toBe("unsure")
    const plain = parseVerificationVerdict("I could not tell.")
    expect(plain.verdict).toBe("unsure")
    expect(plain.summary).toBe("I could not tell.")
  })
})

describe("verdictOfTurn", () => {
  const PASS = '{"verdict":"pass","summary":"Looks right.","points":[]}'

  it("never accepts a pass from a turn that did not finish", () => {
    for (const reason of ["error_max_turns", "max_tokens", "error_max_budget_usd"]) {
      expect(verdictOfTurn(PASS, { kind: "incomplete", reason }).verdict).toBe("unsure")
    }
    expect(verdictOfTurn(PASS, { kind: "failed", reason: "api_error" }).verdict).toBe("unsure")
  })

  it("keeps a finished pass, and a fail either way", () => {
    expect(verdictOfTurn(PASS, { kind: "completed" }).verdict).toBe("pass")
    expect(verdictOfTurn(PASS, undefined).verdict).toBe("pass")
    expect(
      verdictOfTurn('{"verdict":"fail","summary":"No tests."}', {
        kind: "incomplete",
        reason: "error_max_turns",
      }).verdict
    ).toBe("fail")
  })
})

describe("runVerifiedFreshAgentTurn", () => {
  it("does not read a pass from a verifier turn that hit its ceiling", async () => {
    const { deps } = turnDeps({
      runAndCapture: jest.fn(async () => ({
        text: '{"verdict":"pass","summary":"All checked.","points":[]}',
        messageId: "verifier-reply",
        turnOutcome: { kind: "incomplete" as const, reason: "error_max_turns" },
      })),
    })
    const result = await runVerifiedFreshAgentTurn(
      { mainSessionId: MAIN_ID, request: "r", reply: "a", cwd: null },
      deps
    )
    expect(result.parsed.verdict).toBe("unsure")
    expect(result.parsed.summary).toBe("All checked.")
  })

  it("runs in a new session that is not the main one and shares no context", async () => {
    const { deps, calls } = turnDeps()
    const result = await runVerifiedFreshAgentTurn(
      {
        mainSessionId: MAIN_ID,
        mainSessionTitle: "Fix the flake",
        request: "Fix the flaky test",
        reply: "Fixed and tests pass",
        cwd: "/repo",
        projectId: "proj-1",
      },
      deps
    )

    // Acceptance: the verification session id differs from the main turn's.
    expect(result.verificationSessionId).toBe("fresh-session")
    expect(result.verificationSessionId).not.toBe(MAIN_ID)

    // A fresh session: no character, no history, read-only, pinned to the cwd.
    expect(calls.createSession).toEqual([
      {
        title: "Verify: Fix the flake",
        programmaticCreator: "verification-agent",
        systemPrompt: VERIFIER_PROMPT.defaultBody,
        permissionMode: "plan",
        workingDir: "/repo",
        projectId: "proj-1",
      },
    ])

    // Acceptance: no main-turn memory or context is handed to the option builder.
    const ctx = calls.resolveCtx[0] as Record<string, unknown>
    expect(ctx.character).toBeNull()
    expect((ctx.session as ChatSession).id).toBe("fresh-session")
    expect(ctx).not.toHaveProperty("memoryDeps")
    expect(ctx).not.toHaveProperty("memoryUserMessage")
    expect(ctx).not.toHaveProperty("twinDeps")
    expect(ctx).not.toHaveProperty("projectKnowledgeDeps")

    // The prompt is only request + reply + diff, and the turn is read-only.
    const [sessionId, prompt, options, cap] = calls.runArgs[0] as [
      string,
      string,
      SendOptions,
      { execution?: { sessionId: string } },
    ]
    expect(sessionId).toBe("fresh-session")
    expect(prompt).toBe(
      buildVerificationPrompt({
        request: "Fix the flaky test",
        reply: "Fixed and tests pass",
        diff: { text: "+added line", fileCount: 1, truncated: false },
      })
    )
    expect(prompt).not.toContain(MAIN_ID)
    expect(options.permissionMode).toBe("plan")
    expect(options.resumeSessionId).toBeUndefined()
    expect(cap.execution?.sessionId).toBe("fresh-session")

    expect(result.parsed).toEqual({
      verdict: "fail",
      summary: "Tests were not run.",
      points: ["No test output in the reply"],
    })
    expect(result.diffIncluded).toBe(true)
    expect(deps.persistTranscript).toHaveBeenCalledWith("fresh-session", [
      // The verifier's framed request is never the person's instruction (ADR-0239).
      expect.objectContaining({
        role: "user",
        metadata: { automatedTurn: { producer: "verifier" } },
      }),
      expect.objectContaining({ id: "verifier-reply", role: "assistant" }),
    ])
  })

  it("skips the diff reader when the turn had no working directory", async () => {
    const { deps } = turnDeps()
    const result = await runVerifiedFreshAgentTurn(
      { mainSessionId: MAIN_ID, request: "r", reply: "a", cwd: null },
      deps
    )
    expect(deps.readDiff).not.toHaveBeenCalled()
    expect(result.diffIncluded).toBe(false)
    expect(deps.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ workingDir: expect.anything() })
    )
  })

  it("gives the verifier session the main chat's published override", async () => {
    const body = `You are a strict verifier.\n{"verdict": "pass" | "fail" | "unsure", "summary": "", "points": []}`
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: VERIFIER_PROMPT.id,
          scope: "session",
          targetId: MAIN_ID,
          revisionId: "por-verifier-session",
          body,
          contractVersion: VERIFIER_PROMPT.contractVersion,
        },
      ])
    )
    const { deps, calls } = turnDeps()
    await runVerifiedFreshAgentTurn(
      { mainSessionId: MAIN_ID, request: "r", reply: "a", cwd: null },
      deps
    )
    expect(calls.createSession).toEqual([expect.objectContaining({ systemPrompt: body })])
  })

  it("refuses a session factory that hands back the main session", async () => {
    const { deps } = turnDeps({ createSession: jest.fn(async () => ({ id: MAIN_ID })) })
    await expect(
      runVerifiedFreshAgentTurn(
        { mainSessionId: MAIN_ID, request: "r", reply: "a", cwd: null },
        deps
      )
    ).rejects.toThrow(/must not be the main session/)
  })
})

describe("verificationSessionTitle", () => {
  it("names the verification after the conversation", () => {
    expect(verificationSessionTitle("  Refactor  ")).toBe("Verify: Refactor")
    expect(verificationSessionTitle(undefined)).toBe("Verify: untitled turn")
  })
})

describe("newAssistantReply", () => {
  it("returns only a reply that arrived after the arm point", () => {
    const known = new Set(["a0"])
    expect(
      newAssistantReply([text("a0", "assistant", "old"), text("u1", "user", "q")], known)
    ).toBe(null)
    expect(
      newAssistantReply(
        [text("a0", "assistant", "old"), text("u1", "user", "q"), text("a1", "assistant", "new")],
        known
      )
    ).toBe("new")
  })
})

// ---- follow-up trigger ------------------------------------------------------

interface FakeState {
  sessions: Record<
    string,
    {
      messages: UIMessage[]
      status: ChatStatus
      errorDiagnostic: unknown
    }
  >
  replaceSessionMessages: (sessionId: string, messages: UIMessage[]) => void
}

function fakeStore(initial: FakeState["sessions"]) {
  const listeners = new Set<() => void>()
  const state: FakeState = {
    sessions: initial,
    replaceSessionMessages: (sessionId, messages) => {
      state.sessions = {
        ...state.sessions,
        [sessionId]: { ...state.sessions[sessionId], messages },
      }
      listeners.forEach((listener) => listener())
    },
  }
  const store: VerificationFollowupStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const setStatus = (sessionId: string, status: ChatStatus, errorDiagnostic: unknown = null) => {
    state.sessions = {
      ...state.sessions,
      [sessionId]: { ...state.sessions[sessionId], status, errorDiagnostic },
    }
    listeners.forEach((listener) => listener())
  }
  return { store, setStatus, state: () => state, listenerCount: () => listeners.size }
}

function followupDeps(
  store: VerificationFollowupStore,
  overrides: Partial<VerificationFollowupDeps> = {}
): VerificationFollowupDeps {
  let clock = 1000
  return {
    store,
    persist: jest.fn(async () => undefined),
    run: jest.fn(async () => ({
      verificationSessionId: "fresh-session",
      parsed: { verdict: "pass" as const, summary: "Looks right.", points: ["Diff matches"] },
      diffIncluded: true,
      rawText: "{}",
    })),
    hostProfile: () => "desktop",
    now: () => (clock += 1),
    messageId: () => "verdict-message",
    ...overrides,
  }
}

function verdictPartIn(messages: UIMessage[]): VerificationVerdictPart | undefined {
  const message = messages.find((m) => m.id === "verdict-message")
  return message?.parts[0] as unknown as VerificationVerdictPart | undefined
}

describe("armVerifiedFreshAgentFollowup", () => {
  it("waits for the turn to settle, then records a running card and the verdict", async () => {
    const fake = fakeStore({
      [MAIN_ID]: {
        status: "streaming",
        errorDiagnostic: null,
        messages: [text("u1", "user", "Fix it")],
      },
    })
    const deps = followupDeps(fake.store)
    const armed = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "Fix it", cwd: "/repo", mainSessionTitle: "T" },
      deps
    )
    if (!armed.armed) throw new Error("expected the follow-up to arm")
    expect(deps.run).not.toHaveBeenCalled()

    fake
      .state()
      .replaceSessionMessages(MAIN_ID, [
        text("u1", "user", "Fix it"),
        text("a1", "assistant", "Fixed."),
      ])
    fake.setStatus(MAIN_ID, "idle")
    await armed.settled

    expect(deps.run).toHaveBeenCalledWith({
      mainSessionId: MAIN_ID,
      mainSessionTitle: "T",
      request: "Fix it",
      reply: "Fixed.",
      cwd: "/repo",
    })
    const part = verdictPartIn(fake.state().sessions[MAIN_ID].messages)
    expect(part).toMatchObject({
      type: "verification-verdict",
      status: "completed",
      verdict: "pass",
      verificationSessionId: "fresh-session",
      mainSessionId: MAIN_ID,
      points: ["Diff matches"],
      diffIncluded: true,
    })
    expect(part?.verificationSessionId).not.toBe(MAIN_ID)
    // Persisted twice: once running, once with the verdict.
    expect(deps.persist).toHaveBeenCalledTimes(2)
    expect(fake.listenerCount()).toBe(0)
  })

  it("runs no verifier when the main turn failed or produced no reply", async () => {
    const fake = fakeStore({
      [MAIN_ID]: {
        status: "streaming",
        errorDiagnostic: null,
        messages: [text("u1", "user", "q")],
      },
    })
    const deps = followupDeps(fake.store)
    const armed = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null },
      deps
    )
    if (!armed.armed) throw new Error("expected the follow-up to arm")
    fake.setStatus(MAIN_ID, "idle", { code: "turnFailed" })
    await armed.settled
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.persist).not.toHaveBeenCalled()

    const quiet = fakeStore({
      [MAIN_ID]: {
        status: "streaming",
        errorDiagnostic: null,
        messages: [text("u1", "user", "q")],
      },
    })
    const quietDeps = followupDeps(quiet.store)
    const armedQuiet = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null },
      quietDeps
    )
    if (!armedQuiet.armed) throw new Error("expected the follow-up to arm")
    quiet.setStatus(MAIN_ID, "idle")
    await armedQuiet.settled
    expect(quietDeps.run).not.toHaveBeenCalled()
  })

  it("ignores a reply that was already there when it armed", async () => {
    const fake = fakeStore({
      [MAIN_ID]: {
        status: "idle",
        errorDiagnostic: null,
        messages: [text("u1", "user", "q"), text("a1", "assistant", "done")],
      },
    })
    // Already settled at arm time: the immediate check fires, but "a1" was
    // known when the follow-up armed, so it is not this turn's reply.
    const deps = followupDeps(fake.store)
    const armed = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null },
      deps
    )
    if (!armed.armed) throw new Error("expected the follow-up to arm")
    await armed.settled
    expect(deps.run).not.toHaveBeenCalled()
  })

  it("leaves a failed card when the verifier itself throws", async () => {
    const late = fakeStore({
      [MAIN_ID]: {
        status: "streaming",
        errorDiagnostic: null,
        messages: [text("u1", "user", "q")],
      },
    })
    const lateDeps = followupDeps(late.store, {
      run: jest.fn(async () => {
        throw new Error("sidecar offline")
      }),
    })
    const armedLate = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null },
      lateDeps
    )
    if (!armedLate.armed) throw new Error("expected the follow-up to arm")
    late
      .state()
      .replaceSessionMessages(MAIN_ID, [text("u1", "user", "q"), text("a1", "assistant", "done")])
    late.setStatus(MAIN_ID, "idle")
    await armedLate.settled
    expect(verdictPartIn(late.state().sessions[MAIN_ID].messages)).toMatchObject({
      status: "failed",
      error: "sidecar offline",
    })
  })

  it("stops watching when the session pane is closed before the turn settles", async () => {
    const fake = fakeStore({
      [MAIN_ID]: { status: "streaming", errorDiagnostic: null, messages: [] },
    })
    const deps = followupDeps(fake.store)
    const armed = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null },
      deps
    )
    if (!armed.armed) throw new Error("expected the follow-up to arm")
    fake.state().sessions = {}
    fake.setStatus("other", "idle")
    await armed.settled
    expect(deps.run).not.toHaveBeenCalled()
    expect(fake.listenerCount()).toBe(0)
  })

  it("refuses to arm without a session slice", async () => {
    const fake = fakeStore({})
    await expect(
      armVerifiedFreshAgentFollowup(
        { sessionId: MAIN_ID, request: "q", cwd: null },
        followupDeps(fake.store)
      )
    ).resolves.toEqual({ armed: false, reason: "noSession" })
  })

  it("verifies once when a fast main reply already settled before subscription installation (F08/T06)", async () => {
    // Main turn already wrote `a1` and flipped back to `idle` BEFORE arm ran,
    // while `knownMessageIds` captured the pre-turn state (`["u0"]`).
    const fake = fakeStore({
      [MAIN_ID]: {
        status: "idle",
        errorDiagnostic: null,
        messages: [text("u0", "user", "hi"), text("a1", "assistant", "fast answer")],
      },
    })
    const deps = followupDeps(fake.store)
    const armed = await armVerifiedFreshAgentFollowup(
      {
        sessionId: MAIN_ID,
        request: "hi",
        cwd: "/repo",
        knownMessageIds: new Set(["u0"]),
      },
      deps
    )
    if (!armed.armed) throw new Error("expected the follow-up to arm")
    await armed.settled

    expect(deps.run).toHaveBeenCalledTimes(1)
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({ request: "hi", reply: "fast answer" })
    )
  })

  it("supersedes a prior pending watcher on the same session so duplicate arms run at most once (F08/T06)", async () => {
    const fake = fakeStore({
      [MAIN_ID]: {
        status: "streaming",
        errorDiagnostic: null,
        messages: [text("u1", "user", "q")],
      },
    })
    const deps = followupDeps(fake.store)
    const first = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null, knownMessageIds: new Set(["u1"]) },
      deps
    )
    const second = await armVerifiedFreshAgentFollowup(
      { sessionId: MAIN_ID, request: "q", cwd: null, knownMessageIds: new Set(["u1"]) },
      deps
    )
    if (!first.armed || !second.armed) throw new Error("expected both calls to return armed")

    fake
      .state()
      .replaceSessionMessages(MAIN_ID, [text("u1", "user", "q"), text("a1", "assistant", "done")])
    fake.setStatus(MAIN_ID, "idle")
    await Promise.all([first.settled, second.settled])

    expect(deps.run).toHaveBeenCalledTimes(1)
  })
})

describe("companion-shell dormancy (three axes)", () => {
  it("is refused at the trigger with a named reason on every companion / un-paired browser profile", async () => {
    for (const profile of VERIFICATION_DORMANT_PROFILES) {
      const fake = fakeStore({
        [MAIN_ID]: { status: "streaming", errorDiagnostic: null, messages: [] },
      })
      const deps = followupDeps(fake.store, { hostProfile: () => profile })
      await expect(
        armVerifiedFreshAgentFollowup({ sessionId: MAIN_ID, request: "q", cwd: null }, deps)
      ).resolves.toEqual({ armed: false, reason: "companionShell" })
      expect(fake.listenerCount()).toBe(0)
      expect(verificationAvailableOn(profile)).toBe(false)
    }
  })

  it("is available only on shells that own a local sidecar (desktop / headless), not web-standalone (F08/T06)", () => {
    expect(verificationAvailableOn("desktop")).toBe(true)
    expect(verificationAvailableOn("headless")).toBe(true)
    expect(verificationAvailableOn("web-standalone")).toBe(false)
  })

  it("is the same answer the picker gives", () => {
    expect(
      chatOrchestrationUnavailableReason("verified-fresh-agent", {
        hostProfile: "web-standalone",
      })
    ).toBe("companionShell")
    expect(
      chatOrchestrationUnavailableReason("verified-fresh-agent", {
        hostProfile: "mobile-companion",
      })
    ).toBe("companionShell")
    expect(
      chatOrchestrationUnavailableReason("verified-fresh-agent", { hostProfile: "cloud-companion" })
    ).toBe("companionShell")
    expect(
      chatOrchestrationUnavailableReason("verified-fresh-agent", { hostProfile: "desktop" })
    ).toBe(null)
  })
})
