const mockLeakCheck = jest.fn<boolean | undefined, [string]>(() => undefined)
jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    // `undefined` defers to the real check; a test forces a verdict.
    hasNoLeakingPii: (text: string) => mockLeakCheck(text) ?? actual.hasNoLeakingPii(text),
  }
})

import type { TeamDelegationRecord } from "@/types/agent/agent-team"
import type { ParkedDelegationRun } from "@/lib/db/squad-parked-delegations"
import {
  isRestoredRedacted,
  parkedDelegationRow,
  restoredDelegationRecord,
} from "./parked-delegations"

const record = (overrides: Partial<TeamDelegationRecord> = {}): TeamDelegationRecord => ({
  id: "d1",
  sourceTeamId: "squad-1",
  sourceTaskId: "task-1",
  targetType: "background",
  targetId: "bg_1",
  status: "awaiting_approval",
  reason: "Draft the release mail",
  manual: true,
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
  ...overrides,
})

const run = (overrides: Partial<ParkedDelegationRun> = {}): ParkedDelegationRun => ({
  kind: "background",
  prompt: "Write the release mail",
  targetId: "bg_1",
  ...overrides,
})

beforeEach(() => mockLeakCheck.mockReset().mockReturnValue(undefined))

describe("parkedDelegationRow", () => {
  it("keeps clean text as it is and says nothing was redacted", () => {
    expect(
      parkedDelegationRow(
        record({ metadata: { quietHoursDeferred: true } }),
        run({ systemPrompt: "Be brief", parentRunId: "execution:workflow:w1", timeoutMs: 5 })
      )
    ).toEqual({
      id: "d1",
      sourceTeamId: "squad-1",
      sourceTaskId: "task-1",
      targetType: "background",
      targetId: "bg_1",
      reason: "Draft the release mail",
      manual: true,
      createdAt: 1_000,
      metadata: { quietHoursDeferred: true },
      run: {
        kind: "background",
        prompt: "Write the release mail",
        systemPrompt: "Be brief",
        targetId: "bg_1",
        parentRunId: "execution:workflow:w1",
        timeoutMs: 5,
      },
      redacted: false,
    })
  })

  it("puts placeholders where personal data was, in every text it keeps", () => {
    const row = parkedDelegationRow(
      record({ reason: "Reply to ana@example.com" }),
      run({ prompt: "Mail ana@example.com", systemPrompt: "Sign as bo@example.com" })
    )
    expect(JSON.stringify(row)).not.toMatch(/@example\.com/)
    expect(row.run?.prompt).toMatch(/^Mail <EMAIL_\d{3,}>$/)
    expect(row.run?.systemPrompt).toMatch(/^Sign as <EMAIL_\d{3,}>$/)
    expect(row.reason).toMatch(/^Reply to <EMAIL_\d{3,}>$/)
    expect(row.redacted).toBe(true)
  })

  it("keeps no run when its prompt still leaks after redaction", () => {
    mockLeakCheck.mockImplementation((text) => (text.includes("vault") ? false : undefined))
    const row = parkedDelegationRow(record(), run({ prompt: "Open the vault" }))
    expect(row.run).toBeUndefined()
    expect(row.redacted).toBe(false)
    expect(row.reason).toBe("Draft the release mail")
  })

  it("keeps no run when only its system prompt leaks", () => {
    mockLeakCheck.mockImplementation((text) => (text.includes("vault") ? false : undefined))
    expect(parkedDelegationRow(record(), run({ systemPrompt: "vault key" })).run).toBeUndefined()
  })

  it("blanks a reason that still leaks, and drops metadata that leaks", () => {
    mockLeakCheck.mockImplementation((text) => (text.includes("vault") ? false : undefined))
    const row = parkedDelegationRow(
      record({ reason: "vault", metadata: { contact: { email: "ana@example.com" } } }),
      run()
    )
    expect(row.reason).toBe("")
    expect(row).not.toHaveProperty("metadata")
    expect(row.run?.prompt).toBe("Write the release mail")
  })

  it("keeps only the plain part of metadata", () => {
    const row = parkedDelegationRow(
      record({ metadata: { twinId: "twin-1", nested: { ok: 1 }, skipped: () => 1 } }),
      run()
    )
    expect(row.metadata).toEqual({ twinId: "twin-1", nested: { ok: 1 } })
  })

  it("keeps a team delegation's empty prompt and its target settings", () => {
    const row = parkedDelegationRow(
      record({ targetType: "team", targetId: "squad-2" }),
      run({ kind: "team", prompt: "", targetId: "squad-2", ultracode: true })
    )
    expect(row.run).toEqual({ kind: "team", prompt: "", targetId: "squad-2", ultracode: true })
    expect(row.redacted).toBe(false)
  })
})

describe("restoredDelegationRecord", () => {
  it("comes back awaiting approval with the times it had", () => {
    const now = new Date(9_000)
    const restored = restoredDelegationRecord(parkedDelegationRow(record(), run()), now)
    expect(restored).toEqual({
      ...record(),
      createdAt: new Date(1_000),
      updatedAt: now,
    })
    expect(isRestoredRedacted(restored)).toBe(false)
  })

  it("is marked when the run it will hand over was redacted", () => {
    const restored = restoredDelegationRecord(
      parkedDelegationRow(
        record({ metadata: { quietHoursDeferred: true } }),
        run({ prompt: "Mail ana@example.com" })
      ),
      new Date(9_000)
    )
    expect(restored.metadata).toEqual({ quietHoursDeferred: true, restoredRedacted: true })
    expect(isRestoredRedacted(restored)).toBe(true)
  })
})
