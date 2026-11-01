import * as host from "./index"
import * as dispatch from "./dispatch"

it("exports the Host-bound dispatcher for every semantic", () => {
  for (const name of [
    "dispatchAround",
    "dispatchTransform",
    "dispatchGuard",
    "dispatchObserve",
    "requireGuardPass",
  ] as const)
    expect(host[name]).toBe(dispatch[name])
})
