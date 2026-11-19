import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState, type ComponentProps } from "react"

import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { buildDeviceRows } from "@/lib/devices/build-device-rows"
import type { DeviceRow } from "@/lib/devices/types"

import { DeviceListPane } from "./device-list-pane"

/**
 * Stories read against the wall clock, not a frozen instant.
 *
 * A pinned epoch makes every row say "3 years ago" and gets worse each year,
 * which defeats the point of a story you look at to judge how the surface
 * reads. Relative ages therefore reflect module evaluation time; keyboard,
 * filtering and accessibility checks do not snapshot the changing age text.
 */
const NOW = Date.now()

// One realistic fleet, built through the real `buildDeviceRows` rather than
// hand-written rows — a story that fakes the derivation stops catching the
// derivation's mistakes.
const FLEET: DeviceRow[] = buildDeviceRows({
  local: {
    ref: "local",
    label: "Max's MacBook Pro",
    platform: "tauri",
    appVersion: "1.4.2",
    capabilities: ["shell", "pty", "sidecar", "keyring", "browser", "pro-ide"],
    microvmAvailable: false,
    osSandboxAvailable: true,
  },
  pairedDevices: [
    {
      deviceId: "d1",
      label: "Max's iPhone 15",
      platform: "ios",
      pubkey: "k1",
      pairedAt: NOW - 30 * 86_400_000,
      lastSeenAt: NOW - 20_000,
      allowRemoteTerminal: false,
      allowRemoteControl: true,
      appVersion: "1.4.2",
      capabilities: ["camera", "webview", "push-display", "biometric", "barcode-scan"],
      capabilitiesReportedAt: NOW - 20_000,
      serverFingerprint: "a".repeat(56) + "deadbeef",
    },
    {
      // Never reported, and last seen days ago — the two "we do not know"
      // states the matrix has to keep apart.
      deviceId: "d2",
      label: "Old Pixel 6",
      platform: "android",
      pubkey: "k2",
      pairedAt: NOW - 200 * 86_400_000,
      lastSeenAt: NOW - 9 * 86_400_000,
      allowRemoteTerminal: false,
      appVersion: "0.9.1",
    },
    {
      deviceId: "d3",
      label: "Retired iPad",
      platform: "ios",
      pubkey: "k3",
      pairedAt: NOW - 400 * 86_400_000,
      lastSeenAt: NOW - 100 * 86_400_000,
      revokedAt: NOW - 50 * 86_400_000,
      allowRemoteTerminal: false,
      appVersion: "0.8.0",
    },
  ],
  remoteHosts: [
    {
      id: "h1",
      label: "Build box",
      connectionState: "ready",
      addedAt: NOW - 10 * 86_400_000,
      lastConnectedAt: NOW - 5_000,
      config: { baseUrl: "https://build.local:8443", serverVersion: "1.4.2" },
    },
    {
      id: "h2",
      label: "Cloud brain",
      connectionState: "degraded",
      connectionError: "host_capabilities reply had no capability array",
      addedAt: NOW - 3 * 86_400_000,
      lastConnectedAt: NOW - 40 * 60_000,
      config: { baseUrl: "https://cognia.example.com", serverVersion: "1.3.9" },
    },
  ],
  sshHosts: [
    {
      id: "s1",
      name: "prod-web-01",
      host: "10.0.4.21",
      port: 22,
      username: "deploy",
      authMethod: "privateKey",
    },
  ],
  workers: [
    {
      deviceId: "w1",
      hostRef: "worker-ci-1",
      displayName: "CI runner",
      role: "worker",
      status: "active",
      createdAt: NOW - 20 * 86_400_000,
      updatedAt: NOW - 3_000,
      capabilities: ["agent.run"],
    },
  ],
  sandboxConnections: [],
  activeHostId: null,
  holdsWanConnections: true,
  now: NOW,
})

function ControlledPane(args: ComponentProps<typeof DeviceListPane>) {
  const [search, setSearch] = useState(args.search)
  const [kindFilter, setKind] = useState(args.kindFilter)
  const [attentionOnly, setAttention] = useState(args.attentionOnly)
  const [selectedRef, setSelected] = useState(args.selectedRef)
  return (
    <DeviceListPane
      {...args}
      search={search}
      kindFilter={kindFilter}
      attentionOnly={attentionOnly}
      selectedRef={selectedRef}
      onSearchChange={(value) => {
        args.onSearchChange(value)
        setSearch(value)
      }}
      onKindFilterChange={(value) => {
        args.onKindFilterChange(value)
        setKind(value)
      }}
      onAttentionOnlyChange={(value) => {
        args.onAttentionOnlyChange(value)
        setAttention(value)
      }}
      onClearFilters={() => {
        args.onClearFilters()
        setSearch("")
        setKind("all")
        setAttention(false)
      }}
      onSelect={(value) => {
        args.onSelect(value)
        setSelected(value)
      }}
    />
  )
}

const meta = {
  title: "Devices/DeviceListPane",
  component: DeviceListPane,
  tags: ["quality"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The device rail uses real row derivation with synthetic identities, URLs and capabilities. Search, kind, attention and row selection update story-local controlled state and record spies. Loading waits for the real deferred skeleton. Relative ages use module evaluation time; no connection, pairing or host write is performed.",
      },
    },
  },
  argTypes: {
    loading: { control: "boolean" },
    search: { control: "text" },
    attentionOnly: { control: "boolean" },
    onSelect: { description: "Updates only the selected fixture row." },
  },
  render: (args) => (
    <ControlledPane
      key={`${args.search}:${args.kindFilter}:${args.attentionOnly}:${args.selectedRef}`}
      {...args}
    />
  ),
  args: {
    rows: FLEET,
    selectedRef: "local",
    search: "",
    kindFilter: "all" as const,
    attentionOnly: false,
    onSearchChange: fn(),
    onKindFilterChange: fn(),
    onAttentionOnlyChange: fn(),
    onClearFilters: fn(),
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-[320px] max-w-full border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeviceListPane>

export default meta
type Story = StoryObj<typeof meta>

/** Every kind at once: this machine, two hosts, three phones, one worker. */
export const MixedFleet: Story = {}

/** Nothing paired — the state a fresh install opens on. */
export const Empty: Story = { args: { rows: [] } }

/** A search that matches nothing must not read as "nothing is paired". */
export const NoSearchMatch: Story = { args: { search: "zzz" } }

/** Scoped to one kind, with a host selected. */
export const HostsOnly: Story = {
  args: { kindFilter: "remote-host", selectedRef: "host:h1" },
}

/** Only the rows that need a person, from the header badge or the chip. */
export const NeedsAttention: Story = { args: { attentionOnly: true } }

/** Initial reads keep empty-state copy out of the pending result. */
export const InitialLoading: Story = {
  args: { rows: [], loading: true },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("status")).toBeVisible()
  },
}
export const LoadingWithLocalDevice: Story = {
  args: { rows: FLEET.filter((row) => row.kind === "local"), loading: true },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("status")).toBeVisible()
    await expect(
      within(canvasElement).getByRole("button", { name: /Max's MacBook Pro/ })
    ).toBeVisible()
  },
}
export const ClearFilters: Story = {
  args: { search: "zzz", kindFilter: "remote-host", attentionOnly: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: /^(Clear filters|清除筛选)$/ }))
    await expect(args.onClearFilters).toHaveBeenCalledOnce()
    await expect(canvas.getByRole("searchbox")).toHaveValue("")
    await expect(canvas.getByRole("button", { name: /Max's MacBook Pro/ })).toBeVisible()
  },
}
export const KeyboardRows: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const group = canvas
      .getAllByRole("group")
      .find((entry) => entry.getAttribute("data-testid") === "device-rows")!
    const rows = within(group).getAllByRole("button")
    rows[0]!.focus()
    await userEvent.keyboard("{End}")
    await expect(rows.at(-1)).toHaveFocus()
    await userEvent.keyboard("{Home}")
    await waitFor(() => expect(rows[0]).toHaveFocus())
    await userEvent.keyboard("{ArrowDown}")
    await expect(rows[1]).toHaveFocus()
    await expect(args.onSelect).toHaveBeenCalledWith(rows[1]!.getAttribute("data-row-ref"))
  },
}
