import { readLarkEnvelope } from "./envelope"
import { LarkApiError } from "./errors"

const response = (status: number, body: string, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body,
})

describe("readLarkEnvelope", () => {
  it("returns data on code 0", () => {
    expect(readLarkEnvelope(response(200, '{"code":0,"data":{"id":"x"}}'), "/p")).toEqual({
      id: "x",
    })
  })

  it("throws LarkApiError with the business code on HTTP 200", () => {
    let error: unknown
    try {
      readLarkEnvelope(response(200, '{"code":1254043,"msg":"no access"}'), "/open-apis/x")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LarkApiError)
    expect(error).toMatchObject({
      status: 200,
      code: 1254043,
      message: "Lark /open-apis/x failed: code=1254043, msg=no access",
    })
  })

  it("throws on an HTTP error, keeping headers for the rate-limit hint", () => {
    expect(() =>
      readLarkEnvelope(
        response(429, '{"code":99991400,"msg":"limited"}', { "x-ogw-ratelimit-reset": "2" }),
        "/p"
      )
    ).toThrow(expect.objectContaining({ status: 429, retryAfterMs: 2000 }))
  })

  it("reports a non-JSON body with its first 200 characters", () => {
    const html = `<html>${"x".repeat(300)}`
    expect(() => readLarkEnvelope(response(502, html), "/p")).toThrow(
      expect.objectContaining({
        code: null,
        message: `Lark /p failed: code=?, msg=${html.slice(0, 200)}`,
      })
    )
  })
})
