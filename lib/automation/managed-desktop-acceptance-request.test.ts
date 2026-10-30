jest.mock("./managed-desktop-client", () => ({ managedDesktopIdentityScope: jest.fn() }))
import { managedDesktopIdentityScope } from "./managed-desktop-client"
import {
  requestAcceptancePanel,
  consumeAcceptancePanelRequest,
  subscribeAcceptancePanelRequest,
} from "./managed-desktop-acceptance-request"

const request = {
  deliveryId: "delivery",
  criteria: [{ description: "Page loads", screenshotRequired: true }],
}
beforeEach(() => {
  consumeAcceptancePanelRequest()
  jest
    .mocked(managedDesktopIdentityScope)
    .mockReturnValue({ assertActive: jest.fn(), dispose: jest.fn() } as never)
})
test("publishes an isolated one-shot prefill without a persistent or RPC write", () => {
  const listener = jest.fn()
  const unsubscribe = subscribeAcceptancePanelRequest(listener)
  const input = structuredClone(request)
  requestAcceptancePanel(input)
  input.criteria[0].description = "Changed by caller"
  expect(listener).toHaveBeenCalledTimes(1)
  expect(consumeAcceptancePanelRequest()).toEqual(request)
  expect(consumeAcceptancePanelRequest()).toBeUndefined()
  unsubscribe()
  requestAcceptancePanel(request)
  expect(listener).toHaveBeenCalledTimes(1)
})
test("rejects invalid criteria and clears a proposal across an account change", () => {
  expect(() => requestAcceptancePanel({ ...request, criteria: [] })).toThrow("invalid_proposal")
  let invalidate!: () => void
  jest.mocked(managedDesktopIdentityScope).mockImplementation((_target, listener) => {
    invalidate = listener!
    return { assertActive: jest.fn(), dispose: jest.fn() } as never
  })
  requestAcceptancePanel(request)
  invalidate()
  expect(consumeAcceptancePanelRequest()).toBeUndefined()
})
