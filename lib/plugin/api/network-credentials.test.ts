import { resolveNetworkCredentials } from "./network-credentials"
import { sanitizePluginNetworkEgress, type PluginNetworkEgressInput } from "./plugin-pii-gate"
import { secretRef } from "@cognia/plugin-sdk"
import { PluginGatewayError } from "../core/transport"

const resolve = (
  input: PluginNetworkEgressInput,
  readSecret: (key: string) => Promise<string | null>
) => resolveNetworkCredentials(sanitizePluginNetworkEgress("p", input), readSecret)

describe("resolveNetworkCredentials", () => {
  it("keeps a request and response without references byte-identical", async () => {
    const input = {
      url: "https://api.example.com/path?b=%2f&a=one+two",
      headers: { Accept: "application/json" },
      body: ' { "message" : "unchanged", "count" : 1 }\n',
    }
    const readSecret = jest.fn()
    const request = await resolveNetworkCredentials(input, readSecret)
    expect(request.url).toBe(input.url)
    expect(request.headers).toEqual(input.headers)
    expect(request.body).toBe(input.body)
    const response = { data: new Uint8Array([0, 255, 10, 13]).buffer }
    expect(await request.dispatch(async () => response)).toBe(response)
    const error = new Error("original transport error")
    await expect(
      request.dispatch(async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(readSecret).not.toHaveBeenCalled()
  })

  const encodings: Array<[string, (value: string) => string]> = [
    ["raw", (value) => value],
    ["JSON escapes", (value) => JSON.stringify(value).slice(1, -1)],
    ["JSON solidus escapes", (value) => JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/")],
    [
      "JSON Unicode escapes",
      (value) =>
        value
          .split("")
          .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
    ],
    ["URL component", encodeURIComponent],
    ["URL", encodeURI],
    [
      "lowercase URL escapes",
      (value) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()),
    ],
    ["form", (value) => new URLSearchParams({ v: value }).toString().slice(2)],
    ["base64", (value) => btoa(value)],
    [
      "base64url",
      (value) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    ],
  ]

  it.each(encodings)(
    "filters %s echoes from text, binary and error responses",
    async (_name, encode) => {
      const secret = 'stored "secret"\\line\n/+value?=yes'
      const echo = encode(secret)
      const request = await resolve(
        {
          url: "https://api.example.com",
          headers: { Authorization: secretRef("key") },
        },
        async () => secret
      )
      const response = await request.dispatch(async () => ({ headers: { echo }, data: [echo] }))
      expect(response).toEqual({ headers: { echo: "[REDACTED]" }, data: ["[REDACTED]"] })
      const bytes = new TextEncoder().encode(echo).buffer
      expect(new TextDecoder().decode(await request.dispatch(async () => bytes))).toBe("[REDACTED]")
      const error = new Error(echo, { cause: { secret: echo } })
      await expect(
        request.dispatch(async () => {
          throw error
        })
      ).rejects.toMatchObject({
        name: "Error",
        message: "[REDACTED]",
        cause: { secret: "[REDACTED]" },
      })
    }
  )

  it("filters alternate JSON escapes and nested URL-encoded values in gateway JSON text", async () => {
    const secret = 'a"/\\private\nvalue'
    const request = await resolve(
      {
        url: "https://api.example.com",
        headers: { Authorization: secretRef("key") },
      },
      async () => secret
    )
    const escaped = secret
      .split("")
      .map((char, index) =>
        index % 2
          ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
          : JSON.stringify(char).slice(1, -1)
      )
      .join("")
    const json = `{"echo":"${escaped}","encoded":${JSON.stringify(encodeURIComponent(secret))}}`
    const result = await request.dispatch(async () => ({ data: json }))
    expect(JSON.parse(result.data)).toEqual({ echo: "[REDACTED]", encoded: "[REDACTED]" })
    const binary = await request.dispatch(async () => new TextEncoder().encode(json).buffer)
    expect(JSON.parse(new TextDecoder().decode(binary))).toEqual({
      echo: "[REDACTED]",
      encoded: "[REDACTED]",
    })
  })

  it("never resolves reference-shaped JSON strings", async () => {
    const readSecret = jest.fn(async () => "stored-secret")
    const request = await resolve(
      {
        url: "https://api.example.com",
        body: JSON.stringify({ nested: { api_key: secretRef("key") } }),
      },
      readSecret
    )
    expect(request.body).toBe(JSON.stringify({ nested: { api_key: { $secretRef: "key" } } }))
    expect(readSecret).not.toHaveBeenCalled()
  })

  it("removes raw and encoded echoed secrets from responses and keys", async () => {
    const secret = "stored secret+/value"
    const request = await resolve(
      {
        url: "https://api.example.com",
        query: { access_token: secretRef("key") },
      },
      async () => secret
    )
    const response = await request.dispatch(async () => ({
      headers: { echo: secret },
      data: [{ [secret]: encodeURIComponent(secret) }],
    }))
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(JSON.stringify(response)).not.toContain(encodeURIComponent(secret))
    expect(response.data).toEqual([{ "[REDACTED]": "[REDACTED]" }])
  })

  it("removes echoed secrets from arraybuffer and blob responses", async () => {
    const request = await resolve(
      {
        url: "https://api.example.com",
        headers: { Authorization: secretRef("key") },
      },
      async () => "private-token"
    )
    const bytes = new TextEncoder().encode("prefix private-token suffix").buffer
    const array = await request.dispatch(async () => bytes)
    expect(new TextDecoder().decode(array)).toBe("prefix [REDACTED] suffix")
    const blob = await request.dispatch(async () => new Blob([bytes], { type: "text/plain" }))
    expect(await blob.text()).toBe("prefix [REDACTED] suffix")
    expect(blob.type).toBe("text/plain")
    const metadata = await request.dispatch(
      async () => new Blob(["safe"], { type: "application/private-token" })
    )
    expect(metadata.type).not.toContain("private-token")
    expect(await metadata.text()).toBe("safe")
  })

  it.each(encodings)("filters %s echoes in non-UTF-8 binary responses", async (_name, encode) => {
    const secret = 'stored "secret"\\line\n/+value?=yes'
    const echo = new TextEncoder().encode(encode(secret))
    const bytes = new Uint8Array(echo.length + 2)
    bytes.set([255])
    bytes.set(echo, 1)
    bytes[bytes.length - 1] = 254
    const request = await resolve(
      {
        url: "https://api.example.com",
        headers: { Authorization: secretRef("key") },
      },
      async () => secret
    )
    const result = new Uint8Array(await request.dispatch(async () => bytes.buffer))
    expect(result[0]).toBe(255)
    expect(result[result.length - 1]).toBe(254)
    expect(new TextDecoder().decode(result.slice(1, -1))).toBe("[REDACTED]")
  })

  it("refuses empty stored secrets before dispatch", async () => {
    await expect(
      resolve(
        {
          url: "https://api.example.com",
          headers: { Authorization: secretRef("key") },
        },
        async () => ""
      )
    ).rejects.toThrow(/secret not found/)
  })

  it.each(["a", "abc", "1234567"])(
    "does not filter short secret %s or any encoding",
    async (secret) => {
      const request = await resolve(
        {
          url: "https://api.example.com",
          headers: { Authorization: secretRef("key", { prefix: "long-prefix " }) },
        },
        async () => secret
      )
      const text = [
        secret,
        `long-prefix ${secret}`,
        ...encodings.map(([, encode]) => encode(secret)),
      ].join(" ")
      const bytes = new Uint8Array([255, ...new TextEncoder().encode(text), 254]).buffer
      const response = { text, bytes, blob: new Blob([bytes]) }
      expect(await request.dispatch(async () => response)).toBe(response)
      const error = new Error(text)
      await expect(
        request.dispatch(async () => {
          throw error
        })
      ).rejects.toBe(error)
    }
  )

  it("accepts only host-created snapshots, never plugin-owned branded references", async () => {
    const readSecret = jest.fn(async () => "stored-secret")
    await expect(
      resolveNetworkCredentials(
        {
          url: "https://api.example.com",
          headers: { Authorization: secretRef("key") },
        },
        readSecret
      )
    ).rejects.toThrow(/host-created snapshot/)
    expect(readSecret).not.toHaveBeenCalled()
  })

  it("only parses response text that starts like JSON", async () => {
    const request = await resolve(
      {
        url: "https://api.example.com",
        headers: { Authorization: secretRef("key") },
      },
      async () => "stored-secret"
    )
    const parse = jest.spyOn(JSON, "parse")
    try {
      expect(await request.dispatch(async () => "normal stored-secret text")).toBe(
        "normal [REDACTED] text"
      )
      expect(parse).not.toHaveBeenCalled()
      expect(await request.dispatch(async () => '  {"token":"stored-secret"}')).toBe(
        '{"token":"[REDACTED]"}'
      )
      expect(parse).toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it("preserves abort and gateway error identity metadata while scrubbing messages and causes", async () => {
    const request = await resolve(
      {
        url: "https://api.example.com",
        headers: { Authorization: secretRef("key") },
      },
      async () => "stored-secret"
    )
    for (const error of [
      Object.assign(new Error("aborted stored-secret", { cause: new Error("stored-secret") }), {
        name: "AbortError",
      }),
      new PluginGatewayError({
        message: "gateway stored-secret",
        code: "TIMEOUT",
        api: "network:fetch",
        pluginId: "p",
        requestId: "request-1",
        details: { nested: { url: "https://api.example.com?api_key=stored-secret" } },
      }),
      new DOMException("stored-secret", "AbortError"),
      Object.freeze(
        Object.assign(new Error("stored-secret", { cause: [new Error("stored-secret")] }), {
          name: "AbortError",
        })
      ),
      Object.freeze(
        new PluginGatewayError({
          message: "stored-secret",
          code: "UNAVAILABLE",
          requestId: "frozen-request",
          api: "network:fetch",
          pluginId: "p",
          details: { echo: "stored-secret" },
        })
      ),
      Object.freeze(new DOMException("stored-secret", "AbortError")),
    ]) {
      try {
        await request.dispatch(async () => {
          throw error
        })
        throw new Error("expected failure")
      } catch (clean) {
        expect(clean).toBeInstanceOf(error.constructor)
        expect(clean).toMatchObject({
          name: error.name,
          message: expect.stringContaining("[REDACTED]"),
        })
        if ("code" in error) expect((clean as { code: unknown }).code).toBe(error.code)
        if (error instanceof PluginGatewayError)
          expect(clean).toMatchObject({
            requestId: error.requestId,
            api: error.api,
            pluginId: error.pluginId,
          })
        expect(JSON.stringify(clean)).not.toContain("stored-secret")
        if ("cause" in error)
          expect(
            String(
              (clean as Error).cause instanceof Error
                ? ((clean as Error).cause as Error).message
                : JSON.stringify((clean as Error).cause)
            )
          ).not.toContain("stored-secret")
      }
    }
  })

  it("scans large binary bodies directly as bytes", async () => {
    const request = await resolve(
      { url: "https://api.example.com", headers: { Authorization: secretRef("key") } },
      async () => "stored-secret"
    )
    const bytes = new Uint8Array(1024 * 1024).fill(255)
    const needle = new TextEncoder().encode("stored-secret")
    bytes.set(needle, bytes.length - needle.length)
    const arrayFrom = jest.spyOn(Array, "from")
    try {
      const result = new Uint8Array(await request.dispatch(async () => bytes.buffer))
      expect(result.subarray(0, bytes.length - needle.length).every((byte) => byte === 255)).toBe(
        true
      )
      expect(new TextDecoder().decode(result.subarray(bytes.length - needle.length))).toBe(
        "[REDACTED]"
      )
      expect(arrayFrom).not.toHaveBeenCalled()
    } finally {
      arrayFrom.mockRestore()
    }
  })

  it("does not forward a transport error containing the resolved URL", async () => {
    const request = await resolve(
      {
        url: "https://api.example.com",
        query: { access_token: secretRef("key") },
      },
      async () => "private-token"
    )
    await expect(
      request.dispatch(async () => {
        throw new Error(request.url)
      })
    ).rejects.toThrow(/REDACTED/)
  })

  it("does not forward store errors or unresolved keys", async () => {
    const input = {
      url: "https://api.example.com",
      headers: { Authorization: secretRef("private-key-name") },
    }
    await expect(
      resolve(input, async () => {
        throw new Error("private-store-data")
      })
    ).rejects.toThrow(
      "Network credential reference could not be read from this plugin's secret store"
    )
    await expect(resolve(input, async () => null)).rejects.toThrow(/not found/)
  })
})
