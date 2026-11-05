import { FEISHU_JSON_HEADERS } from "./transport"

describe("FEISHU_JSON_HEADERS", () => {
  it("declares a UTF-8 JSON body and cannot be mutated through the shared object", () => {
    expect(FEISHU_JSON_HEADERS).toEqual({ "Content-Type": "application/json; charset=utf-8" })
    expect(Object.isFrozen(FEISHU_JSON_HEADERS)).toBe(true)
  })
})
