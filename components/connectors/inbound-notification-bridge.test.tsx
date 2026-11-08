import { render } from "@testing-library/react"

const mockInstall = jest.fn()
jest.mock("@/lib/connectors/notifications/inbound-bridge", () => ({
  installConnectorNotificationBridge: () => mockInstall(),
}))

import InboundNotificationBridge from "./inbound-notification-bridge"

describe("InboundNotificationBridge", () => {
  it("installs the bridge on mount, renders nothing, and leaves it on unmount", () => {
    const { container, unmount, rerender } = render(<InboundNotificationBridge />)
    expect(container).toBeEmptyDOMElement()
    rerender(<InboundNotificationBridge />)
    expect(mockInstall).toHaveBeenCalledTimes(1)
    unmount()
    expect(mockInstall).toHaveBeenCalledTimes(1)
  })
})
