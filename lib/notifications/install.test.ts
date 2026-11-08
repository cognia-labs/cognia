jest.mock("./plugin-bridge", () => ({ installPluginNotificationBridge: jest.fn() }))
jest.mock("./inbound-push", () => ({ installPushNotificationBridge: jest.fn() }))

import { installPluginNotificationBridge } from "./plugin-bridge"
import { installPushNotificationBridge } from "./inbound-push"
import { installNotificationBridges, __resetNotificationBridgesForTesting } from "./install"

const plugin = installPluginNotificationBridge as jest.Mock
const push = installPushNotificationBridge as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  __resetNotificationBridgesForTesting()
})

// Connector inbound messages arrive through the connectors' own bridge, which
// their UI effect installs (`components/connectors/inbound-notification-bridge.tsx`).
it("installs the runtime-independent inbound bridges once", () => {
  installNotificationBridges()
  expect(plugin).toHaveBeenCalledTimes(1)
  expect(push).not.toHaveBeenCalled()
})

it("is idempotent across repeated calls", () => {
  installNotificationBridges()
  installNotificationBridges()
  expect(plugin).toHaveBeenCalledTimes(1)
})
