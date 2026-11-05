import {
  formatTimestamp,
  formatBytesCompact,
  formatRate,
  formatTokens,
  formatUsd,
  formatPercent,
  formatMs,
} from "./format-utils"
import { formatTokens as canonicalFormatTokens } from "@/types/system/usage"

describe("formatTimestamp", () => {
  it("renders Date instances", () => {
    const d = new Date("2024-01-01T12:00:00Z")
    const out = formatTimestamp(d)
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
  })

  it("renders epoch ms numbers", () => {
    expect(typeof formatTimestamp(1704110400000)).toBe("string")
  })

  it("formats in the given locale with the given options", () => {
    const ts = Date.UTC(2026, 9, 3, 14, 3, 22)
    const options: Intl.DateTimeFormatOptions = {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
    expect(formatTimestamp(ts, "en-US", options)).toBe("10/03/2026, 14:03")
    expect(formatTimestamp(ts, "zh-CN", options)).toBe("2026/10/03 14:03")
    expect(formatTimestamp(new Date(ts), "en-US", { timeZone: "UTC", month: "short" })).toBe("Oct")
  })

  it("does not follow the browser locale when one is passed", () => {
    const ts = Date.UTC(2026, 9, 3, 14, 3, 22)
    const options: Intl.DateTimeFormatOptions = { timeZone: "UTC", month: "long" }
    expect(formatTimestamp(ts, "zh-CN", options)).toBe("十月")
    expect(formatTimestamp(ts, "en-US", options)).toBe("October")
  })

  it("falls back to the default locale (keeping the options) for a malformed tag", () => {
    const ts = Date.UTC(2026, 9, 3, 14, 3, 22)
    const options: Intl.DateTimeFormatOptions = { timeZone: "UTC", year: "numeric" }
    expect(() => formatTimestamp(ts, "not a locale!!", options)).not.toThrow()
    expect(formatTimestamp(ts, "not a locale!!", options)).toBe(
      new Date(ts).toLocaleString(undefined, options)
    )
  })
})

describe("formatBytesCompact", () => {
  it("returns em-dash for bad input", () => {
    expect(formatBytesCompact(NaN)).toBe("—")
    expect(formatBytesCompact(-1)).toBe("—")
  })

  it("formats sub-KB / KB / MB / GB ranges", () => {
    expect(formatBytesCompact(0)).toBe("0B")
    expect(formatBytesCompact(512)).toBe("512B")
    expect(formatBytesCompact(2048)).toBe("2.0KB")
    expect(formatBytesCompact(2 * 1024 * 1024)).toBe("2.0MB")
    expect(formatBytesCompact(3 * 1024 * 1024 * 1024)).toBe("3.00GB")
  })
})

describe("formatRate", () => {
  it("returns em-dash for non-finite", () => {
    expect(formatRate(NaN)).toBe("—")
    expect(formatRate(Infinity)).toBe("—")
  })

  it("formats with two decimals and optional suffix", () => {
    expect(formatRate(1.234)).toBe("1.23")
    expect(formatRate(0.5, "/s")).toBe("0.50/s")
  })
})

describe("formatTokens", () => {
  it("adr0253 d07 is the one token formatter", () => {
    expect(formatTokens).toBe(canonicalFormatTokens)
  })
})

describe("formatUsd", () => {
  it("returns em-dash for bad input", () => {
    expect(formatUsd(null)).toBe("—")
    expect(formatUsd(NaN)).toBe("—")
  })
  it("formats zero, sub-cent and normal amounts", () => {
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(0.0012)).toBe("$0.0012")
    expect(formatUsd(3.5)).toBe("$3.50")
  })
})

describe("formatPercent", () => {
  it("returns em-dash for bad input", () => {
    expect(formatPercent(undefined)).toBe("—")
  })
  it("formats fractions with configurable digits", () => {
    expect(formatPercent(0.5)).toBe("50%")
    expect(formatPercent(0.1234, 1)).toBe("12.3%")
  })
})

describe("formatMs", () => {
  it("returns em-dash for bad input", () => {
    expect(formatMs(null)).toBe("—")
  })
  it("formats µs / ms / s / m ranges", () => {
    expect(formatMs(0.5)).toBe("500µs")
    expect(formatMs(250)).toBe("250ms")
    expect(formatMs(1500)).toBe("1.50s")
    expect(formatMs(120_000)).toBe("2.0m")
  })
})
