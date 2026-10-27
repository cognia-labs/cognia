import { AUDIT_SUMMARY_WINDOW_MS, relativeAge, summarizeAuditWindow } from "./audit-summary"

const NOW = 1_800_000_000_000

function row(
  minutesAgo: number,
  decision: "allow" | "deny" | "consent",
  command = "click"
): { ts: number; decision: "allow" | "deny" | "consent"; command: string } {
  return { ts: NOW - minutesAgo * 60_000, decision, command }
}

describe("summarizeAuditWindow", () => {
  it("counts only rows inside the window", () => {
    const summary = summarizeAuditWindow(
      [row(1, "allow"), row(2, "deny"), row(3, "consent"), row(24 * 60 + 1, "allow")],
      NOW
    )
    expect(summary).toMatchObject({ total: 3, allow: 1, deny: 1, consent: 1 })
  })

  it("ranks denied commands, most frequent first, capped at topN", () => {
    const rows = [
      row(1, "deny", "type"),
      row(2, "deny", "type"),
      row(3, "deny", "click"),
      row(4, "deny", "scroll"),
      row(5, "allow", "type"),
    ]
    expect(summarizeAuditWindow(rows, NOW, { topN: 2 }).topFailing).toEqual([
      { command: "type", count: 2 },
      { command: "click", count: 1 },
    ])
  })

  it("takes the newest allowed screenshot and ignores denied ones", () => {
    const rows = [
      row(10, "allow", "screenshot"),
      row(5, "allow", "screenshot"),
      row(1, "deny", "screenshot"),
    ]
    expect(summarizeAuditWindow(rows, NOW).lastScreenshotTs).toBe(NOW - 5 * 60_000)
  })

  it("reports no screenshot when none was allowed", () => {
    expect(summarizeAuditWindow([row(1, "allow", "click")], NOW).lastScreenshotTs).toBeNull()
  })

  it("defaults to a 24 hour window", () => {
    expect(AUDIT_SUMMARY_WINDOW_MS).toBe(86_400_000)
  })
})

describe("relativeAge", () => {
  it("picks the coarsest whole unit", () => {
    expect(relativeAge(NOW - 30_000, NOW)).toEqual({ unit: "seconds", value: 30 })
    expect(relativeAge(NOW - 5 * 60_000, NOW)).toEqual({ unit: "minutes", value: 5 })
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toEqual({ unit: "hours", value: 3 })
  })

  it("never reports a negative age for a clock skewed into the future", () => {
    expect(relativeAge(NOW + 10_000, NOW)).toEqual({ unit: "seconds", value: 0 })
  })
})
