import { secretRef } from "./secret-ref"

describe("secretRef", () => {
  it("brands references with a non-enumerable symbol that JSON cannot preserve", () => {
    const ref = secretRef("token")
    expect(
      Object.getOwnPropertyDescriptor(ref, Symbol.for("cognia.plugin.secretRef"))
    ).toMatchObject({
      value: true,
      enumerable: false,
    })
    expect(Object.keys(ref)).toEqual(["$secretRef"])
    expect(Reflect.ownKeys(JSON.parse(JSON.stringify(ref)))).toEqual(["$secretRef"])
  })

  it("creates a JSON credential reference without reading a secret", () => {
    expect(secretRef("token")).toEqual({ $secretRef: "token" })
    expect(JSON.parse(JSON.stringify(secretRef("token", { prefix: "Bearer " })))).toEqual({
      $secretRef: "token",
      prefix: "Bearer ",
    })
  })

  it.each(["", "   "])("rejects an empty secret key %p", (key) => {
    expect(() => secretRef(key)).toThrow(/key/)
  })

  it.each([undefined, null, 1, {}, []])("rejects a non-string key %p", (key) => {
    expect(() => secretRef(key as never)).toThrow(/key/)
  })

  it.each([null, 1, true, {}, []])("rejects a non-string prefix %p", (prefix) => {
    expect(() => secretRef("token", { prefix: prefix as never })).toThrow(/prefix/)
  })
})
