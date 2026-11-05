import {
  LARK_PERMISSION_CODES,
  LarkApiError,
  TAT_INVALIDATION_CODES,
  USER_TOKEN_INVALIDATION_CODES,
  extractLarkCode,
  isLarkPermissionDenied,
  isLarkTatInvalidation,
  isLarkUserTokenInvalidation,
} from "./errors"

describe("LarkApiError", () => {
  it("captures status, code and message", () => {
    const err = new LarkApiError({ status: 401, code: 99991663, message: "boom" })
    expect(err.name).toBe("LarkApiError")
    expect(err.status).toBe(401)
    expect(err.code).toBe(99991663)
    expect(err.message).toBe("boom")
  })

  it("allows null code for HTTP-layer failures without a Lark body", () => {
    const err = new LarkApiError({ status: 502, code: null, message: "bad gateway" })
    expect(err.code).toBeNull()
  })
})

describe("isLarkTatInvalidation — LarkApiError instances", () => {
  it("detects HTTP 401", () => {
    const err = new LarkApiError({ status: 401, code: null, message: "Unauthorized" })
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("detects each documented invalidation code", () => {
    for (const code of TAT_INVALIDATION_CODES) {
      const err = new LarkApiError({ status: 200, code, message: `code=${code}` })
      expect(isLarkTatInvalidation(err)).toBe(true)
    }
  })

  it("does not treat unrelated HTTP 5xx as TAT invalidation", () => {
    const err = new LarkApiError({ status: 500, code: null, message: "Internal Server Error" })
    expect(isLarkTatInvalidation(err)).toBe(false)
  })

  it("does not treat unrelated Lark codes as TAT invalidation", () => {
    const err = new LarkApiError({ status: 200, code: 230002, message: "rate limited" })
    expect(isLarkTatInvalidation(err)).toBe(false)
  })
})

describe("isLarkTatInvalidation — plain Error fallback", () => {
  it("recognises 401 substring from Rust upload errors", () => {
    const err = new Error("connectors_lark_upload_file failed: HTTP 401 Unauthorized")
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("recognises Lark code substring from Rust upload errors", () => {
    const err = new Error("Lark API error: code=99991663, msg=invalid access_token")
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("recognises alternate code: <num> format", () => {
    const err = new Error("Upload rejected: code: 99991668 — token expired")
    expect(isLarkTatInvalidation(err)).toBe(true)
  })

  it("does not match unrelated error messages", () => {
    expect(isLarkTatInvalidation(new Error("network unreachable"))).toBe(false)
    expect(isLarkTatInvalidation(new Error("404 Not Found"))).toBe(false)
    expect(isLarkTatInvalidation(new Error("code=2034 — chat not found"))).toBe(false)
  })

  it("does not match accidental 401 substring inside a larger number", () => {
    // "1401" should not match — regex requires word-boundary or non-digit on the right
    // and start-of-string/whitespace on the left.
    expect(isLarkTatInvalidation(new Error("got status 140199 from upstream"))).toBe(false)
  })

  it("safely handles non-Error values", () => {
    expect(isLarkTatInvalidation(null)).toBe(false)
    expect(isLarkTatInvalidation(undefined)).toBe(false)
    expect(isLarkTatInvalidation("401")).toBe(false)
    expect(isLarkTatInvalidation({ status: 401 })).toBe(false)
  })
})

describe("LarkApiError retry delay", () => {
  it.each([undefined, "", " ", "no", "-1", "Infinity", "1e309"])(
    "rejects invalid reset %s",
    (reset) => {
      const error = new LarkApiError({
        status: 429,
        code: 99991400,
        message: "limited",
        ...(reset !== undefined ? { headers: { "x-ogw-ratelimit-reset": reset } } : {}),
      })
      expect(error.retryAfterMs).toBeUndefined()
    }
  )
  it("keeps zero and rounds fractional milliseconds up", () => {
    for (const [reset, expected] of [
      ["0", 0],
      ["0.0001", 1],
    ] as const) {
      expect(
        new LarkApiError({
          status: 400,
          code: 99991400,
          message: "limited",
          headers: { "X-Ogw-Ratelimit-Reset": reset },
        }).retryAfterMs
      ).toBe(expected)
    }
  })
  it("ignores rate-limit headers on unrelated failures", () => {
    expect(
      new LarkApiError({
        status: 403,
        code: 99991672,
        message: "denied",
        headers: { "x-ogw-ratelimit-reset": "52" },
      }).retryAfterMs
    ).toBeUndefined()
  })
})

describe("isLarkUserTokenInvalidation", () => {
  it("detects HTTP 401 and each user-token code, not tenant-only codes", () => {
    expect(
      isLarkUserTokenInvalidation(new LarkApiError({ status: 401, code: null, message: "x" }))
    ).toBe(true)
    for (const code of USER_TOKEN_INVALIDATION_CODES)
      expect(
        isLarkUserTokenInvalidation(new LarkApiError({ status: 200, code, message: "x" }))
      ).toBe(true)
    expect(
      isLarkUserTokenInvalidation(new LarkApiError({ status: 200, code: 99991663, message: "x" }))
    ).toBe(false)
  })

  it("reads the code from a plain Error message", () => {
    expect(isLarkUserTokenInvalidation(new Error("code=99991677 invalid user token"))).toBe(true)
    expect(isLarkUserTokenInvalidation(new Error("network unreachable"))).toBe(false)
  })
})

describe("extractLarkCode", () => {
  it("reads a numeric code from a JSON body, even on an HTTP error", () => {
    expect(extractLarkCode('{"code":99991663,"msg":"invalid"}')).toBe(99991663)
  })

  it("returns null for an empty, non-JSON or code-less body", () => {
    expect(extractLarkCode(undefined)).toBeNull()
    expect(extractLarkCode("")).toBeNull()
    expect(extractLarkCode("<html>")).toBeNull()
    expect(extractLarkCode('{"code":"0"}')).toBeNull()
  })
})

describe("isLarkPermissionDenied", () => {
  it("is true for HTTP 403 and each permission code", () => {
    expect(
      isLarkPermissionDenied(new LarkApiError({ status: 403, code: null, message: "x" }))
    ).toBe(true)
    for (const code of LARK_PERMISSION_CODES)
      expect(isLarkPermissionDenied(new LarkApiError({ status: 200, code, message: "x" }))).toBe(
        true
      )
  })

  it("is false for other failures and other error types", () => {
    expect(
      isLarkPermissionDenied(new LarkApiError({ status: 200, code: 230001, message: "x" }))
    ).toBe(false)
    expect(isLarkPermissionDenied(new Error("403"))).toBe(false)
  })
})
