const original = Object.getOwnPropertyDescriptor(globalThis, "Worker")

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "Worker", original)
  else Reflect.deleteProperty(globalThis, "Worker")
})

it("permits SSR imports and inheritance but rejects worker construction", () => {
  Reflect.deleteProperty(globalThis, "Worker")
  jest.isolateModules(() => {
    const WebWorker = jest.requireActual("./web-worker").default
    class DecoderWorker extends WebWorker {
      constructor() {
        super("decoder.js")
      }
    }
    expect(() => new DecoderWorker()).toThrow("Web Workers are unavailable")
  })
})

it("preserves the actual browser Worker constructor", () => {
  const construct = jest.fn()
  class NativeWorker {
    constructor(...args: unknown[]) {
      construct(...args)
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: NativeWorker })
  jest.isolateModules(() => {
    const WebWorker = jest.requireActual("./web-worker").default
    expect(WebWorker).toBe(NativeWorker)
    expect(new WebWorker("decoder.js", { type: "module" })).toBeInstanceOf(NativeWorker)
    expect(construct).toHaveBeenCalledWith("decoder.js", { type: "module" })
  })
})
