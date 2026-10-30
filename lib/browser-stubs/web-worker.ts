/** Keep browser-only decoder imports evaluable during static-export SSR. */
class UnavailableWorker {
  constructor(...args: ConstructorParameters<typeof Worker>) {
    void args
    throw new Error("Web Workers are unavailable in this environment")
  }
}

// Preserve the native constructor in browsers; defer SSR failure until use.
const WebWorker = globalThis.Worker ?? UnavailableWorker
export default WebWorker
