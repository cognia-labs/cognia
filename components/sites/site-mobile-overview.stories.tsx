import type { Meta, StoryObj } from "@storybook/nextjs"

import { SiteMobileOverviewView } from "./site-mobile-overview"
import {
  makeDeployment,
  makeOperationSet,
  makeSite,
  makeVersion,
} from "@/lib/storybook/fixtures/sites"

// The view, with its details passed in: the wired `SiteMobileOverview` reads
// them from the companion mirror, which a story does not have.
const meta = {
  title: "Sites/SiteMobileOverview",
  component: SiteMobileOverviewView,
  args: {
    sites: [makeSite(), makeSite({ id: "site_marketing", name: "Marketing" })],
    activeDeployments: [
      makeDeployment({
        entryVerification: {
          checkedAt: Date.now(),
          state: "protected",
          entries: [{ url: "https://docs.cognia.dev", outcome: "protected", status: 302 }],
        },
      }),
    ],
    loading: false,
    mirror: true,
    details: {
      versionsById: new Map([["ver_3", makeVersion({ id: "ver_3", sequence: 3 })]]),
      operationsBySite: new Map([["site_docs", makeOperationSet()]]),
    },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-[390px] border-x">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteMobileOverviewView>

export default meta
type Story = StoryObj<typeof meta>

/** A phone paired with a Host: the Host's Sites, read-only. */
export const PairedWithHost: Story = {}

/** The Host has no Sites yet. */
export const HostHasNoSites: Story = {
  args: { sites: [], activeDeployments: [] },
}

/** An unpaired phone: its own, normally empty, database. */
export const Standalone: Story = {
  args: {
    sites: [],
    activeDeployments: [],
    mirror: false,
    details: { versionsById: new Map(), operationsBySite: new Map() },
  },
}

export const Loading: Story = { args: { sites: [], activeDeployments: [], loading: true } }
