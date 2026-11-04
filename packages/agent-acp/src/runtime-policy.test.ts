import type { ProtocolAdapter } from "@cognia/agent-contracts/adapter"
import { acpRuntimePolicy } from "./runtime-policy"
it("exposes passive child controls without starting or resuming a session", () => {
  const controls = { listChildren: jest.fn(), inspect: jest.fn(), recoveryPrompt: jest.fn() }
  const adapter = { gooseSessionControls: controls } as unknown as ProtocolAdapter
  expect(acpRuntimePolicy.nativeChildren?.(adapter)).toBe(controls)
  expect(acpRuntimePolicy.authoritativeSessions?.(adapter)).toBe(false)
  expect(controls.listChildren).not.toHaveBeenCalled()
})
