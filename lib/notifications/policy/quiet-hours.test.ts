// Coverage for quiet-hours evaluation (V2): same-day and cross-midnight
// windows, the deferred-release instant landing on the NEXT wall-clock `end`
// in the target's zone (DST-safe via Intl), critical-level bypass, malformed
// and zero-length windows. Pure functions — no Dexie.

import {
  isInQuietHours,
  isInQuietRange,
  msUntilQuietRangeEnd,
  quietHoursReleaseAt,
  evaluateQuietHours,
  type QuietHoursWindow,
} from "./quiet-hours"

const TZ = "America/New_York"

/**
 * Build the UTC instant of a New York wall-clock `date HH:mm`. Resolves the
 * zone's UTC offset at that wall-clock via `Intl` (longOffset), so it is
 * correct across DST — March 10 2026 is EDT (UTC-4), before March 8 EST (-5).
 */
function nyInstant(date: string, hhmm: string): number {
  const utcGuess = Date.parse(`${date}T${hhmm}:00Z`)
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(utcGuess))
    .find((p) => p.type === "timeZoneName")?.value
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(offsetName ?? "GMT-4")
  const sign = m?.[1] === "-" ? -1 : 1
  const offMin = sign * (Number(m?.[2] ?? 4) * 60 + Number(m?.[3] ?? 0))
  return utcGuess - offMin * 60 * 1000
}

const wrap: QuietHoursWindow = { enabled: true, start: "22:00", end: "08:00" }
const sameDay: QuietHoursWindow = { enabled: true, start: "13:00", end: "17:00" }

describe("isInQuietHours", () => {
  it("returns false when disabled", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    expect(isInQuietHours(instant, { ...wrap, enabled: false }, TZ)).toBe(false)
  })

  it("detects a cross-midnight window — late night side", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    expect(isInQuietHours(instant, wrap, TZ)).toBe(true)
  })

  it("detects a cross-midnight window — early morning side", () => {
    const instant = nyInstant("2026-03-10", "06:15")
    expect(isInQuietHours(instant, wrap, TZ)).toBe(true)
  })

  it("is outside a cross-midnight window during the day", () => {
    const instant = nyInstant("2026-03-10", "12:00")
    expect(isInQuietHours(instant, wrap, TZ)).toBe(false)
  })

  it("respects the window boundaries (start inclusive, end exclusive)", () => {
    expect(isInQuietHours(nyInstant("2026-03-10", "22:00"), wrap, TZ)).toBe(true)
    expect(isInQuietHours(nyInstant("2026-03-10", "08:00"), wrap, TZ)).toBe(false)
    expect(isInQuietHours(nyInstant("2026-03-10", "07:59"), wrap, TZ)).toBe(true)
  })

  it("handles a same-day window", () => {
    expect(isInQuietHours(nyInstant("2026-03-10", "14:00"), sameDay, TZ)).toBe(true)
    expect(isInQuietHours(nyInstant("2026-03-10", "18:00"), sameDay, TZ)).toBe(false)
    expect(isInQuietHours(nyInstant("2026-03-10", "09:00"), sameDay, TZ)).toBe(false)
  })

  it("treats a zero-length window as never quiet", () => {
    const zero: QuietHoursWindow = { enabled: true, start: "08:00", end: "08:00" }
    expect(isInQuietHours(nyInstant("2026-03-10", "08:00"), zero, TZ)).toBe(false)
    expect(isInQuietHours(nyInstant("2026-03-10", "20:00"), zero, TZ)).toBe(false)
  })

  it("returns false on malformed bounds", () => {
    const bad: QuietHoursWindow = { enabled: true, start: "bad", end: "08:00" }
    expect(isInQuietHours(nyInstant("2026-03-10", "23:00"), bad, TZ)).toBe(false)
  })
})

describe("quietHoursReleaseAt", () => {
  it("releases at the NEXT wall-clock end — same night", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const release = quietHoursReleaseAt(instant, wrap, TZ)
    // The release should be 08:00 the following day in New York.
    const releaseParts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(release))
    const hh = Number(releaseParts.find((p) => p.type === "hour")?.value)
    const mm = Number(releaseParts.find((p) => p.type === "minute")?.value)
    expect(hh).toBe(8)
    expect(mm).toBe(0)
    expect(release).toBeGreaterThan(instant)
  })

  it("releases at the NEXT wall-clock end — early morning", () => {
    const instant = nyInstant("2026-03-10", "06:00")
    const release = quietHoursReleaseAt(instant, wrap, TZ)
    expect(release).toBeGreaterThan(instant)
    // 08:00 same day.
    expect(release - instant).toBeLessThanOrEqual(3 * 60 * 60 * 1000)
  })
})

describe("quietHoursReleaseAt across a DST change", () => {
  it("releases the same morning when the window opened the night before spring-forward", () => {
    // 2026-03-08 is New York's spring-forward day: 23:00 EST on the 7th is
    // released at 08:00 EDT on the 8th, not a day later.
    expect(quietHoursReleaseAt(nyInstant("2026-03-07", "23:00"), wrap, TZ)).toBe(
      nyInstant("2026-03-08", "08:00")
    )
  })

  it("releases the same morning when the window opened the night before fall-back", () => {
    // 2026-11-01 is New York's fall-back day.
    expect(quietHoursReleaseAt(nyInstant("2026-10-31", "23:00"), wrap, TZ)).toBe(
      nyInstant("2026-11-01", "08:00")
    )
  })
})

describe("evaluateQuietHours", () => {
  it("defers a non-critical fact inside the window", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "warning",
      allowCritical: true,
    })
    expect(r.deferred).toBe(true)
    expect(r.releaseAt).toBeGreaterThan(instant)
  })

  it("does not defer a critical fact when bypass is allowed", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "critical",
      allowCritical: true,
    })
    expect(r.deferred).toBe(false)
  })

  it("still defers a critical fact when bypass is disallowed", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "critical",
      allowCritical: false,
    })
    expect(r.deferred).toBe(true)
  })

  it("does not defer outside the window", () => {
    const instant = nyInstant("2026-03-10", "12:00")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "warning",
      allowCritical: true,
    })
    expect(r.deferred).toBe(false)
  })
})

// The range shape IM adapters, goals and Squad policies store. These vectors
// were the connectors outbound runner's own copy of the evaluator, which this
// file replaced; they hold against the one implementation.
describe("isInQuietRange", () => {
  const at = (iso: string) => new Date(iso).getTime()

  it("is inside a same-day range and outside after it", () => {
    expect(isInQuietRange(at("2024-05-01T14:00:00Z"), "09:00", "17:00", "UTC")).toBe(true)
    expect(isInQuietRange(at("2024-05-01T18:00:00Z"), "09:00", "17:00", "UTC")).toBe(false)
  })

  it("wraps past midnight on both sides", () => {
    expect(isInQuietRange(at("2024-05-01T23:00:00Z"), "22:00", "06:00", "UTC")).toBe(true)
    expect(isInQuietRange(at("2024-05-02T03:00:00Z"), "22:00", "06:00", "UTC")).toBe(true)
    expect(isInQuietRange(at("2024-05-01T12:00:00Z"), "22:00", "06:00", "UTC")).toBe(false)
  })

  it("reads the wall clock in the range's zone", () => {
    // 14:00 UTC is 09:00 in New York in January (EST, UTC-5).
    const ts = at("2024-01-15T14:00:00Z")
    expect(isInQuietRange(ts, "08:00", "10:00", "America/New_York")).toBe(true)
    expect(isInQuietRange(ts, "08:00", "10:00", "UTC")).toBe(false)
  })

  it("includes the start minute and excludes the end minute", () => {
    expect(isInQuietRange(at("2024-05-01T22:00:00Z"), "22:00", "06:00", "UTC")).toBe(true)
    expect(isInQuietRange(at("2024-05-02T06:00:00Z"), "22:00", "06:00", "UTC")).toBe(false)
  })

  it("quiets nothing for an empty or malformed range", () => {
    expect(isInQuietRange(at("2024-05-01T22:30:00Z"), "22:00", "22:00", "UTC")).toBe(false)
    expect(isInQuietRange(at("2024-05-01T22:30:00Z"), "22:00", "nope", "UTC")).toBe(false)
  })

  it("follows the zone across a DST change", () => {
    // 2026-03-08: New York springs forward. 23:30 local on the 8th is EDT.
    expect(isInQuietRange(nyInstant("2026-03-08", "23:30"), "22:00", "08:00", TZ)).toBe(true)
    expect(isInQuietRange(nyInstant("2026-03-09", "09:00"), "22:00", "08:00", TZ)).toBe(false)
  })
})

describe("msUntilQuietRangeEnd", () => {
  const at = (iso: string) => new Date(iso).getTime()
  const HOUR = 60 * 60 * 1000

  it("waits for the next occurrence of the end", () => {
    expect(msUntilQuietRangeEnd(at("2024-05-01T23:00:00Z"), "06:00", "UTC")).toBe(7 * HOUR)
    expect(msUntilQuietRangeEnd(at("2024-05-01T10:00:00Z"), "17:00", "UTC")).toBe(7 * HOUR)
  })

  it("rolls over a day when the end is exactly now", () => {
    expect(msUntilQuietRangeEnd(at("2024-05-01T06:00:00Z"), "06:00", "UTC")).toBe(24 * HOUR)
  })

  it("lands on the wall-clock end across a DST change", () => {
    // 23:00 EST on March 7 to 08:00 EDT on March 8 is eight real hours.
    const from = nyInstant("2026-03-07", "23:00")
    expect(from + msUntilQuietRangeEnd(from, "08:00", TZ)).toBe(nyInstant("2026-03-08", "08:00"))
    expect(msUntilQuietRangeEnd(from, "08:00", TZ)).toBe(8 * HOUR)
  })

  it("is zero for a malformed end", () => {
    expect(msUntilQuietRangeEnd(at("2024-05-01T23:00:00Z"), "6am", "UTC")).toBe(0)
  })
})
