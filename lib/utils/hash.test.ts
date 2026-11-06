import { sha256Blob, sha256Bytes, sha256DataUrl, sha256String } from "./hash"

// SHA-256("abc"), FIPS 180-2 appendix B.1.
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("hash", () => {
  it("hashes a string, bytes and a blob to the same hex digest", async () => {
    expect(await sha256String("abc")).toBe(ABC)
    expect(await sha256Bytes(new TextEncoder().encode("abc"))).toBe(ABC)
    expect(await sha256Blob(new Blob(["abc"]))).toBe(ABC)
  })

  it("hashes a data URL's payload, and nothing that is not one", async () => {
    expect(await sha256DataUrl("data:text/plain;base64,YWJj")).toBe(ABC)
    expect(await sha256DataUrl("not a data url")).toBeNull()
  })
})
