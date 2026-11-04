import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

import {
  HostUnreachableNotice,
  MissingDeviceLinkNotice,
  StandaloneFleetCard,
} from "./fleet-notices"

describe("HostUnreachableNotice", () => {
  it("says the rows come from the local record", () => {
    render(<HostUnreachableNotice />)
    expect(screen.getByTestId("device-host-unreachable")).toHaveTextContent(
      /may still read as active/
    )
  })
})

describe("MissingDeviceLinkNotice", () => {
  it("names the link that did not resolve, and can be dismissed", async () => {
    const onDismiss = jest.fn()
    render(<MissingDeviceLinkNotice deviceRef="device:gone" onDismiss={onDismiss} />)
    expect(screen.getByTestId("device-link-missing")).toHaveTextContent("device:gone")
    expect(screen.getByText("That device is not in this fleet")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalled()
  })
})

describe("StandaloneFleetCard", () => {
  /**
   * `standalone: "explain"` is a convention each surface implements for
   * itself; an unimplemented one is a silent lie.
   */
  it("says which half is missing, and carries the surface contract's reason", () => {
    render(<StandaloneFleetCard />)
    expect(screen.getByTestId("devices-requires-host")).toHaveAttribute(
      "data-reason",
      standaloneDevicesRequiresHost.reason
    )
    expect(screen.getByText("Only this device")).toBeInTheDocument()
  })

  it("explains without repeating the header's pair and add-host actions", () => {
    render(<StandaloneFleetCard />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByTestId("devices-requires-host")).toHaveTextContent(
      "Pair a device or add a host"
    )
  })
})
