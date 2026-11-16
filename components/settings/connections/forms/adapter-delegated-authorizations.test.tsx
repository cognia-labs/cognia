/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

let row: Record<string, unknown> | undefined
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => row }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

const alice = { kind: "platform", platform: "lark", adapterId: "bot-a", remoteUserId: "ou_a" }
const list = jest.fn()
const revoke = jest.fn(async (_row: unknown, _person: unknown) => undefined)
let vendorHasHook = true
jest.mock("@/lib/connectors/vendor-contribution", () => ({
  connectorVendor: () =>
    vendorHasHook
      ? {
          delegatedCredentials: {
            list: (r: unknown) => list(r),
            revoke: (r: unknown, p: unknown) => revoke(r, p),
          },
        }
      : {},
}))
const forgetAuthorizationOffer = jest.fn()
jest.mock("@/lib/connectors/delegated-authorization", () => ({
  forgetAuthorizationOffer: (id: string, p: unknown) => forgetAuthorizationOffer(id, p),
}))
let remote = false
jest.mock("@/lib/db/adapter-instance-remote-writer", () => ({
  hostAdapterInstanceWriter: () => (remote ? {} : null),
}))
const setAdapterCredentialLane = jest.fn(async (_id: string, _lane: string) => undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  setAdapterCredentialLane: (id: string, lane: string) => setAdapterCredentialLane(id, lane),
}))
const success = jest.fn()
const error = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => success(m), error: (m: string) => error(m) },
}))

import { AdapterDelegatedAuthorizations } from "./adapter-delegated-authorizations"

beforeEach(() => {
  row = { id: "bot-a", type: "lark", settings: {} }
  vendorHasHook = true
  remote = false
  list
    .mockReset()
    .mockResolvedValue([{ person: alice, name: "Alice", authorizedAt: 1_700_000_000_000 }])
  revoke.mockClear()
  forgetAuthorizationOffer.mockClear()
  setAdapterCredentialLane.mockClear()
  success.mockClear()
  error.mockClear()
})

describe("AdapterDelegatedAuthorizations", () => {
  it("renders nothing for a platform without per-person authorizations", () => {
    vendorHasHook = false
    const { container } = render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists who authorized the bot and revokes one person", async () => {
    render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    expect(await screen.findByText("Alice")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice's authorization" }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(row, alice))
    expect(forgetAuthorizationOffer).toHaveBeenCalledWith("bot-a", alice)
    expect(success).toHaveBeenCalledWith("Authorization revoked")
  })

  it("says how to authorize when nobody has", async () => {
    list.mockResolvedValue([])
    render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    expect(await screen.findByText(/sends \/auth in a direct chat/)).toBeInTheDocument()
  })

  it("switches the bot to the service lane", async () => {
    render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    await screen.findByText("Alice")
    const lane = screen.getByTestId("delegated-lane-switch")
    expect(lane).toBeChecked()
    fireEvent.click(lane)
    await waitFor(() => expect(setAdapterCredentialLane).toHaveBeenCalledWith("bot-a", "service"))
    expect(success).toHaveBeenCalledWith("Saved")
  })

  it("shows a saved service lane and switches back to delegated", async () => {
    row = { id: "bot-a", type: "lark", settings: {}, credentialLane: "service" }
    render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    await screen.findByText("Alice")
    fireEvent.click(screen.getByTestId("delegated-lane-switch"))
    await waitFor(() => expect(setAdapterCredentialLane).toHaveBeenCalledWith("bot-a", "delegated"))
  })

  it("leaves the lane to the Host on a paired shell", async () => {
    remote = true
    render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    await screen.findByText("Alice")
    expect(screen.getByTestId("delegated-lane-switch")).toBeDisabled()
    expect(screen.getByText("Only this connector's Host can change this.")).toBeInTheDocument()
  })

  it("reports a failed revoke", async () => {
    revoke.mockRejectedValueOnce(new Error("store_locked"))
    render(<AdapterDelegatedAuthorizations adapterId="bot-a" />)
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Alice's authorization" }))
    await waitFor(() => expect(error).toHaveBeenCalledWith("Could not revoke: store_locked"))
  })
})
