import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { buildDeviceRows } from "@/lib/devices/build-device-rows"
import type { HostVersionState } from "@/lib/remote-host/host-version"
import { HostUpdateUnsupportedError, type HostUpdateStatus } from "@/lib/remote-host/host-update"
import { APP_UPDATES_HREF, HostVersionNotice } from "./host-version-notice"

const status: HostUpdateStatus = {
  install: "native",
  currentVersion: "1.0.0",
  channel: "stable",
  autoUpdate: false,
  phase: "idle",
  installRequested: true,
}
function host(overrides: Partial<HostVersionState> = {}, revoked = false) {
  return buildDeviceRows({
    local: {
      ref: "local",
      label: "Workshop",
      platform: "web",
      appVersion: "1.0.0",
      capabilities: [],
      microvmAvailable: false,
      osSandboxAvailable: false,
    },
    pairedDevices: [],
    sshHosts: [],
    workers: [],
    sandboxConnections: [],
    activeHostId: null,
    holdsWanConnections: true,
    now: 1_700_000_000_000,
    remoteHosts: [
      {
        id: "storybook-host",
        label: "Synthetic host",
        connectionState: revoked ? "revoked" : "versionMismatch",
        addedAt: 1,
        config: { baseUrl: "https://host.invalid", serverVersion: "1.0.0" },
        version: {
          advice: "update-host",
          hostContractVersion: 2,
          appContractVersion: 3,
          brainRefusal: null,
          observedAt: 1,
          ...overrides,
        },
      },
    ],
  }).find((row) => row.kind === "remote-host")!
}
const meta = {
  title: "Devices/HostVersionNotice",
  component: HostVersionNotice,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Contract mismatch advice built through the real device-row derivation. Every scenario explicitly supplies an install spy: clicking can never call the host management channel. Callback completion is checked; global toast presentation belongs to the app shell and is not mounted here. The Update Center link is inspected without navigating.",
      },
    },
  },
  args: { row: host(), install: fn(async () => status) },
  argTypes: {
    install: {
      description:
        "Always injected; resolves a synthetic HostUpdateStatus or a deliberate unsupported error.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[42rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HostVersionNotice>
export default meta
type Story = StoryObj<typeof meta>

export const HostBehind: Story = {
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole("button")
    await userEvent.click(button)
    await expect(args.install).toHaveBeenCalledWith("storybook-host")
    await waitFor(() => expect(button).toBeEnabled())
  },
}
export const AppBehind: Story = {
  args: { row: host({ advice: "update-app", hostContractVersion: 4 }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("link")).toHaveAttribute("href", APP_UPDATES_HREF)
  },
}
export const Unversioned: Story = { args: { row: host({ hostContractVersion: null }) } }
export const HalfUpdated: Story = {
  args: {
    row: host({
      brainRefusal: {
        reason: "contract_mismatch",
        server: { version: "1.2.0", contractVersion: 3 },
        brain: { version: "1.1.0", contractVersion: 2 },
      },
    }),
  },
}
export const Unsupported: Story = {
  args: {
    install: fn(async () => {
      throw new HostUpdateUnsupportedError()
    }),
  },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole("button")
    await userEvent.click(button)
    await expect(args.install).toHaveBeenCalledOnce()
    await waitFor(() => expect(button).toBeEnabled())
  },
}
export const MatchingHidden: Story = {
  args: { row: host({ advice: "none" }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("status")).not.toBeInTheDocument()
  },
}
export const RevokedHidden: Story = { ...MatchingHidden, args: { row: host({}, true) } }
