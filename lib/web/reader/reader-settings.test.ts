import {
  freshInstallWebReader,
  normalizeWebReaderSettings,
  readerPolicyFromSettings,
  toReaderPolicy,
  WEB_READER_MIN_TIMEOUT_MS,
} from "./reader-settings"
import type { AppSettings } from "@cognia/agent-config-types"

describe("starting profiles", () => {
  it("fresh installs keep every remote recipient off", () => {
    const fresh = freshInstallWebReader()
    expect(fresh.externalFallback).toBe("off")
    expect(fresh.distillation).toBe("off")
    expect(fresh.readers.direct?.enabled).toBe(true)
    expect(fresh.readers.platform?.enabled).toBe(true)
    for (const id of ["fxtwitter", "jina", "tavily", "exa", "deepseek", "tinyfish"] as const) {
      expect(fresh.readers[id]?.enabled).toBe(false)
    }
  })
})

describe("normalizeWebReaderSettings", () => {
  it("gives an absent or malformed record the fresh profile", () => {
    for (const raw of [undefined, null, "x", []]) {
      const r = normalizeWebReaderSettings(raw)
      expect(r.source).toBe("fresh")
      expect(r.effective).toEqual(freshInstallWebReader())
    }
  })

  it("treats an explicit record as authoritative and fills unlisted readers as off", () => {
    const r = normalizeWebReaderSettings({
      version: 1,
      defaultReader: "tavily",
      readers: { tavily: { enabled: true, priority: 3 } },
      externalFallback: "configured",
      distillation: "best-effort",
      timeoutMs: 1,
      maxAttempts: 99,
    })
    expect(r.source).toBe("explicit")
    expect(r.effective.defaultReader).toBe("tavily")
    expect(r.effective.distillation).toBe("best-effort")
    expect(r.effective.readers.tavily).toEqual({ enabled: true, priority: 3 })
    expect(r.effective.readers.jina?.enabled).toBe(false)
    expect(r.effective.readers.direct?.enabled).toBe(true)
    expect(r.effective.timeoutMs).toBe(WEB_READER_MIN_TIMEOUT_MS)
    expect(r.effective.maxAttempts).toBe(3)
  })

  it("rejects unknown enum values instead of activating them", () => {
    const r = normalizeWebReaderSettings({
      version: 1,
      defaultReader: "carrier-pigeon",
      distillation: "always",
      externalFallback: "yes",
    })
    expect(r.effective.defaultReader).toBe("auto")
    expect(r.effective.distillation).toBe("off")
    expect(r.effective.externalFallback).toBe("off")
  })

  it("preserves an unknown future version verbatim but never activates it", () => {
    const future = { version: 2, magic: true }
    const r = normalizeWebReaderSettings(future)
    expect(r.source).toBe("unsupported-version")
    expect(r.preserved).toBe(future)
    expect(r.effective).toEqual(freshInstallWebReader())
  })
})

describe("toReaderPolicy", () => {
  it("orders external readers by priority and excludes the platform-class FxTwitter", () => {
    const settings = freshInstallWebReader()
    settings.readers.exa = { enabled: true, priority: 1 }
    settings.readers.jina = { enabled: true, priority: 5 }
    settings.readers.fxtwitter = { enabled: true, priority: 0 }
    const policy = toReaderPolicy(settings)
    expect(policy.externalOrder).toEqual(["exa", "jina"])
    expect(policy.enabled.has("fxtwitter")).toBe(true)
  })

  it("changes its revision whenever routing could change", () => {
    const a = toReaderPolicy(freshInstallWebReader())
    const settings = freshInstallWebReader()
    settings.distillation = "required"
    expect(toReaderPolicy(settings).revision).not.toBe(a.revision)
  })

  it("reads a settings snapshot without a reader profile as the fresh profile", () => {
    const policy = readerPolicyFromSettings({ webTools: { enabled: true } } as AppSettings)
    expect(policy).toEqual(toReaderPolicy(freshInstallWebReader()))
    expect(policy.enabled.has("jina")).toBe(false)
  })
})
