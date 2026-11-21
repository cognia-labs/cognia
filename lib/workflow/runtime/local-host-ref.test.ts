import { isLocalWorkflowHostRef, localWorkflowHostRef } from "./local-host-ref"

describe("local workflow host ref", () => {
  const original = process.env.COGNIA_HOST_ID

  afterEach(() => {
    if (original === undefined) delete process.env.COGNIA_HOST_ID
    else process.env.COGNIA_HOST_ID = original
  })

  it("falls back to `local` when the Host has no identity", () => {
    delete process.env.COGNIA_HOST_ID
    expect(localWorkflowHostRef()).toBe("local")
    process.env.COGNIA_HOST_ID = "   "
    expect(localWorkflowHostRef()).toBe("local")
  })

  it("uses the Host identity when one is set", () => {
    process.env.COGNIA_HOST_ID = " host-a "
    expect(localWorkflowHostRef()).toBe("host-a")
  })

  it("treats both `local` and this Host's own id as local, and nothing else", () => {
    process.env.COGNIA_HOST_ID = "host-a"
    expect(isLocalWorkflowHostRef("local")).toBe(true)
    expect(isLocalWorkflowHostRef("host-a")).toBe(true)
    expect(isLocalWorkflowHostRef("host-b")).toBe(false)
    expect(isLocalWorkflowHostRef("host-b", "host-b")).toBe(true)
  })
})
