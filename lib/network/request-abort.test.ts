import { throwIfRequestAborted, withRequestAbort } from "./request-abort"

it("does not start an already cancelled operation", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  const operation = jest.fn()
  expect(() => throwIfRequestAborted(controller.signal)).toThrow("cancelled")
  await expect(withRequestAbort(controller.signal, operation)).rejects.toThrow("cancelled")
  expect(operation).not.toHaveBeenCalled()
})

it("releases one caller while the shared operation can finish", async () => {
  const controller = new AbortController()
  let finish!: (value: string) => void
  const shared = new Promise<string>((resolve) => {
    finish = resolve
  })
  const waiting = withRequestAbort(controller.signal, () => shared)
  controller.abort(new Error("cancelled"))
  await expect(waiting).rejects.toThrow("cancelled")
  finish("shared result")
  await expect(shared).resolves.toBe("shared result")
})

it("propagates failures and uncancelled results", async () => {
  await expect(withRequestAbort(undefined, async () => 42)).resolves.toBe(42)
  await expect(
    withRequestAbort(new AbortController().signal, () => {
      throw new Error("failed")
    })
  ).rejects.toThrow("failed")
  await expect(
    withRequestAbort(new AbortController().signal, async () => {
      throw new Error("failed")
    })
  ).rejects.toThrow("failed")
})

it.each([null, { cancelled: true }])(
  "preserves the exact cancellation reason %p",
  async (reason) => {
    const controller = new AbortController()
    const pending = withRequestAbort(controller.signal, () => new Promise(() => {}))
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    let thrown: unknown = Symbol("no rejection")
    try {
      throwIfRequestAborted(controller.signal)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(reason)
  }
)
