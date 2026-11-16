import { RUNNER_LAUNCH_DESCRIPTORS } from "./launch-runners"
import { EXTERNAL_AGENT_NPX_ALLOWLIST } from "./security-policy"

it("covers the npx runner the security policy admits packages through", () => {
  expect(EXTERNAL_AGENT_NPX_ALLOWLIST.length).toBeGreaterThan(0)
  expect(RUNNER_LAUNCH_DESCRIPTORS).toEqual([
    { id: "npx", match: { kind: "base", values: ["npx"] }, stateRoots: [".npm"] },
  ])
})
