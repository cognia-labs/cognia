import { sha256Hex, sha256Uuid } from "./hash"

describe("sha256Hex", () => {
  it("matches the known empty-string vector", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("produces 64 lowercase hex chars and is case-sensitive", async () => {
    expect(await sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/)
    expect(await sha256Hex("payload")).not.toBe(await sha256Hex("PAYLOAD"))
  })
})

describe("sha256Uuid", () => {
  it("lays the digest out as a stable version-8 UUID", async () => {
    const id = await sha256Uuid("anything")
    const hex = await sha256Hex("anything")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id.replace(/-/g, "")).toBe(
      hex.slice(0, 12) + "8" + hex.slice(13, 16) + "a" + hex.slice(17, 32)
    )
    expect(await sha256Uuid("anything")).toBe(id)
    expect(await sha256Uuid("other")).not.toBe(id)
  })
})
