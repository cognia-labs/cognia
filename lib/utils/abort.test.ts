import { unlessAborted } from "./abort"

describe("unlessAborted", () => {
  it("passes the work through when there is no signal", async () => {
    await expect(unlessAborted(Promise.resolve(1), undefined)).resolves.toBe(1)
  })

  it("settles with the work when it finishes first", async () => {
    const controller = new AbortController()
    await expect(unlessAborted(Promise.resolve("done"), controller.signal)).resolves.toBe("done")
    await expect(
      unlessAborted(Promise.reject(new Error("boom")), controller.signal)
    ).rejects.toThrow("boom")
  })

  it("rejects with the abort reason while the work is still pending", async () => {
    const controller = new AbortController()
    const never = new Promise<number>(() => undefined)
    const waiting = unlessAborted(never, controller.signal)
    controller.abort(new Error("stopped"))
    await expect(waiting).rejects.toThrow("stopped")
  })

  it("rejects at once when the signal already aborted", async () => {
    const controller = new AbortController()
    controller.abort(new Error("already"))
    await expect(unlessAborted(Promise.resolve(1), controller.signal)).rejects.toThrow("already")
  })

  it("uses the caller's reason when one is supplied", async () => {
    const controller = new AbortController()
    const waiting = unlessAborted(
      new Promise<number>(() => undefined),
      controller.signal,
      () => new TypeError("custom")
    )
    controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(TypeError)
  })

  it("stops listening once the work settles", async () => {
    const controller = new AbortController()
    const remove = jest.spyOn(controller.signal, "removeEventListener")
    await unlessAborted(Promise.resolve(1), controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})
