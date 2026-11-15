import { DEFAULT_NETWORK_PROXY_SETTINGS, type NetworkProxySettings } from "@/types/network/proxy"
import {
  isProxyActive,
  normalizeProxyHostForMatch,
  redactProxyUrl,
  shouldBypass,
  validateProxyHost,
  validateProxyPort,
} from "./proxy-config"

const make = (overrides: Partial<NetworkProxySettings> = {}): NetworkProxySettings => ({
  ...DEFAULT_NETWORK_PROXY_SETTINGS,
  ...overrides,
})

describe("isProxyActive", () => {
  it("returns false for undefined / null config", () => {
    expect(isProxyActive(undefined)).toBe(false)
    expect(isProxyActive(null)).toBe(false)
  })

  it("returns false when mode is off even with host/port", () => {
    expect(isProxyActive(make({ mode: "off", host: "127.0.0.1", port: 7890 }))).toBe(false)
  })

  it("returns false when host is empty or whitespace-only", () => {
    expect(isProxyActive(make({ mode: "manual", host: "", port: 7890 }))).toBe(false)
    expect(isProxyActive(make({ mode: "manual", host: "   ", port: 7890 }))).toBe(false)
  })

  it("returns false when port is 0 or negative", () => {
    expect(isProxyActive(make({ mode: "manual", host: "127.0.0.1", port: 0 }))).toBe(false)
    expect(isProxyActive(make({ mode: "manual", host: "127.0.0.1", port: -1 }))).toBe(false)
  })

  it("returns true for a fully populated manual config", () => {
    expect(isProxyActive(make({ mode: "manual", host: "127.0.0.1", port: 7890 }))).toBe(true)
  })

  it("returns true for an auto-detected config", () => {
    expect(isProxyActive(make({ mode: "auto", host: "127.0.0.1", port: 7890 }))).toBe(true)
  })
})

describe("shouldBypass", () => {
  const bypass = ["localhost", "127.0.0.1", "::1", ".internal"]

  it("returns false when bypass list is empty", () => {
    expect(shouldBypass("https://api.example.com", [])).toBe(false)
  })

  it("returns false for non-URL strings", () => {
    expect(shouldBypass("not-a-url", bypass)).toBe(false)
  })

  it("matches loopback hosts", () => {
    expect(shouldBypass("http://localhost/foo", bypass)).toBe(true)
    expect(shouldBypass("http://127.0.0.1:3000/x", bypass)).toBe(true)
  })

  it("matches an exact-host entry case-insensitively", () => {
    expect(shouldBypass("http://Localhost/foo", bypass)).toBe(true)
  })

  it("matches a domain suffix entry", () => {
    expect(shouldBypass("https://api.internal/foo", bypass)).toBe(true)
    expect(shouldBypass("https://internal/foo", bypass)).toBe(true)
  })

  it("matches IPv4 and IPv6 CIDR entries without matching adjacent networks", () => {
    expect(shouldBypass("https://10.42.8.9/path", ["10.42.0.0/16"])).toBe(true)
    expect(shouldBypass("https://10.43.8.9/path", ["10.42.0.0/16"])).toBe(false)
    expect(shouldBypass("https://[2001:db8:abcd::2]/path", ["2001:db8::/32"])).toBe(true)
    expect(shouldBypass("https://[2001:db9::2]/path", ["2001:db8::/32"])).toBe(false)
  })

  it("ignores malformed CIDR entries", () => {
    expect(shouldBypass("https://10.42.8.9/path", ["10.42.0.0/99", "bad/24"])).toBe(false)
  })

  it("does not match unrelated hosts", () => {
    expect(shouldBypass("https://api.anthropic.com", bypass)).toBe(false)
  })

  it("ignores empty/whitespace bypass entries", () => {
    expect(shouldBypass("https://api.anthropic.com", ["", "   "])).toBe(false)
  })
})

describe("redactProxyUrl", () => {
  it("removes userinfo without altering the endpoint", () => {
    expect(redactProxyUrl("http://alice:secret@proxy.example:8080")).toBe(
      "http://proxy.example:8080/"
    )
  })

  it("returns a safe marker for malformed values", () => {
    expect(redactProxyUrl("not a url")).toBe("<invalid-proxy-url>")
  })
})

describe("validateProxyHost", () => {
  it("accepts a hostname, an IPv4 literal, and IPv6 in either form", () => {
    expect(validateProxyHost("proxy.corp")).toEqual({ ok: true, host: "proxy.corp" })
    expect(validateProxyHost("  10.0.0.1 ")).toEqual({ ok: true, host: "10.0.0.1" })
    expect(validateProxyHost("::1")).toEqual({ ok: true, host: "::1" })
    // Brackets are normalized away; the native side brackets it when dialling.
    expect(validateProxyHost("[2001:db8::1]")).toEqual({ ok: true, host: "2001:db8::1" })
  })

  it("names the mistake instead of failing later as a connection error", () => {
    // Each of these used to be accepted and produce a broken proxy URL —
    // `http://http://proxy:8080`, a double port, or credentials in a URL the
    // renderer must never build.
    expect(validateProxyHost("")).toEqual({ ok: false, reason: "empty" })
    expect(validateProxyHost("   ")).toEqual({ ok: false, reason: "empty" })
    expect(validateProxyHost("http://proxy.corp")).toEqual({ ok: false, reason: "scheme" })
    expect(validateProxyHost("socks5://proxy.corp")).toEqual({ ok: false, reason: "scheme" })
    expect(validateProxyHost("user:pw@proxy.corp")).toEqual({ ok: false, reason: "userinfo" })
    expect(validateProxyHost("proxy.corp/path")).toEqual({ ok: false, reason: "path" })
    expect(validateProxyHost("proxy.corp?a=1")).toEqual({ ok: false, reason: "path" })
    expect(validateProxyHost("proxy.corp#frag")).toEqual({ ok: false, reason: "path" })
    expect(validateProxyHost("proxy.corp:8080")).toEqual({ ok: false, reason: "port-in-host" })
  })

  it("refuses the bytes that make a parser and a resolver disagree", () => {
    // The differential-bypass class: a host the allowlist reads as one string
    // and `getaddrinfo` resolves as another.
    expect(validateProxyHost("proxy\u0000.corp")).toEqual({
      ok: false,
      reason: "illegal-character",
    })
    expect(validateProxyHost("proxy\r\n.corp")).toEqual({
      ok: false,
      reason: "illegal-character",
    })
    expect(validateProxyHost("proxy .corp")).toEqual({ ok: false, reason: "illegal-character" })
    expect(validateProxyHost("proxy%2ecorp")).toEqual({ ok: false, reason: "illegal-character" })
  })

  it("rejects malformed dotted names and bracket abuse", () => {
    expect(validateProxyHost(".corp")).toEqual({ ok: false, reason: "malformed" })
    expect(validateProxyHost("proxy.")).toEqual({ ok: false, reason: "malformed" })
    expect(validateProxyHost("proxy..corp")).toEqual({ ok: false, reason: "malformed" })
    expect(validateProxyHost("[proxy.corp]")).toEqual({ ok: false, reason: "malformed" })
    expect(validateProxyHost("[::1")).toEqual({ ok: false, reason: "malformed" })
  })
})

describe("validateProxyPort", () => {
  it("accepts 1..65535 and nothing else", () => {
    expect(validateProxyPort(1)).toBe(true)
    expect(validateProxyPort(8080)).toBe(true)
    expect(validateProxyPort(65535)).toBe(true)
    // 0 is "unset", not "pick one"; the rest cannot be dialled at all.
    expect(validateProxyPort(0)).toBe(false)
    expect(validateProxyPort(-1)).toBe(false)
    expect(validateProxyPort(65536)).toBe(false)
    expect(validateProxyPort(8080.5)).toBe(false)
    expect(validateProxyPort(Number.NaN)).toBe(false)
  })
})

describe("IPv6 handling across the config surface", () => {
  it("bypasses an IPv6 target that matches a bare entry", () => {
    // `URL.hostname` returns `"[::1]"`, so the literal comparison used to test
    // `"[::1]" === "::1"` and never match — with `::1` in the DEFAULT bypass
    // list, loopback IPv6 was silently proxied.
    expect(shouldBypass("http://[::1]:3000/health", ["::1"])).toBe(true)
    expect(shouldBypass("http://[::1]:3000/health", ["[::1]"])).toBe(true)
    expect(shouldBypass("http://[2001:db8::1]/x", ["::1"])).toBe(false)
  })

  it("still matches an IPv6 CIDR entry", () => {
    expect(shouldBypass("http://[2001:db8::5]/x", ["2001:db8::/32"])).toBe(true)
    expect(shouldBypass("http://[2001:dead::5]/x", ["2001:db8::/32"])).toBe(false)
  })

  it("normalizes a bracketed hostname for matching", () => {
    expect(normalizeProxyHostForMatch("[::1]")).toBe("::1")
    expect(normalizeProxyHostForMatch(" PROXY.Corp ")).toBe("proxy.corp")
  })
})

describe("isProxyActive rejects a host the native side could never dial", () => {
  it("treats a host with an embedded port or scheme as inactive", () => {
    const withPortInHost: NetworkProxySettings = {
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      mode: "manual",
      host: "proxy.corp:8080",
      port: 8080,
    }
    expect(isProxyActive(withPortInHost)).toBe(false)

    const withScheme: NetworkProxySettings = {
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      mode: "manual",
      host: "http://proxy.corp",
      port: 8080,
    }
    expect(isProxyActive(withScheme)).toBe(false)
  })

  it("treats an out-of-range port as inactive", () => {
    const settings: NetworkProxySettings = {
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      mode: "manual",
      host: "proxy.corp",
      port: 70000,
    }
    expect(isProxyActive(settings)).toBe(false)
  })
})
