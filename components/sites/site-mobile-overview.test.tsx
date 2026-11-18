import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: (date: Date) => `at ${date.getTime()}` }),
  useNow: () => new Date(10_000),
}))
jest.mock("@/hooks/sites/use-site-action-gate", () => ({
  useSitesHostMirror: jest.fn(() => false),
}))
jest.mock("@/hooks/sites/use-site-overview-details", () => ({
  useSiteOverviewDetails: jest.fn(() => ({
    versionsById: new Map(),
    operationsBySite: new Map(),
  })),
}))

import { useSitesHostMirror } from "@/hooks/sites/use-site-action-gate"
import {
  useSiteOverviewDetails,
  type SiteOverviewDetails,
} from "@/hooks/sites/use-site-overview-details"
import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteVersionRow,
} from "@/types/sites"
import { SiteMobileOverview, SiteMobileOverviewView } from "./site-mobile-overview"

const useSitesHostMirrorMock = useSitesHostMirror as jest.Mock
const useSiteOverviewDetailsMock = useSiteOverviewDetails as jest.Mock

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "a", workerName: "cognia-docs" },
    authoringPolicy: { ownerAccountId: "o", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const deployment = (over: Partial<SiteDeploymentRow> = {}) =>
  ({
    id: "d1",
    siteId: "site_1",
    versionId: "v1",
    environmentRevisionId: "e1",
    status: "active",
    productionUrl: "https://docs.example.com",
    createdAt: 1,
    updatedAt: 4_000,
    ...over,
  }) as SiteDeploymentRow

const operation = (over: Partial<SiteOperationRow> = {}) =>
  ({
    id: "op_1",
    siteId: "site_1",
    type: "deploy",
    executionTargetKey: "local",
    idempotencyKey: "k",
    inputDigest: "d",
    status: "succeeded",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 5_000,
    ...over,
  }) as SiteOperationRow

const NO_DETAILS: SiteOverviewDetails = { versionsById: new Map(), operationsBySite: new Map() }

function view(
  props: Partial<Parameters<typeof SiteMobileOverviewView>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <SiteMobileOverviewView
      sites={[]}
      activeDeployments={[]}
      loading={false}
      mirror={false}
      details={NO_DETAILS}
      {...props}
    />
  )
}

beforeEach(() => {
  useSitesHostMirrorMock.mockReturnValue(false)
  useSiteOverviewDetailsMock.mockReturnValue(NO_DETAILS)
})

describe("paired with a Host", () => {
  it("says these are the Host's Sites and that changes are made there", () => {
    view({ mirror: true })
    expect(screen.getByTestId("sites-mobile-host")).toHaveTextContent("mobile.host.title")
    expect(screen.getByTestId("sites-mobile-host")).toHaveTextContent("mobile.host.explain")
    expect(screen.getByTestId("sites-mobile-empty")).toHaveTextContent("mobile.host.empty")
    expect(screen.getByTestId("sites-mobile-empty")).toHaveTextContent("mobile.host.emptyExplain")
  })

  it("shows the version in production, when it went live and its entry check", () => {
    view({
      mirror: true,
      sites: [site()],
      activeDeployments: [
        deployment({
          entryVerification: { checkedAt: 4_100, state: "protected", entries: [] },
        }),
      ],
      details: {
        versionsById: new Map([["v1", { id: "v1", sequence: 7 } as SiteVersionRow]]),
        operationsBySite: new Map(),
      },
    })
    const production = screen.getByTestId("sites-mobile-production-site_1")
    expect(production).toHaveTextContent('overview.currentVersion:{"sequence":7}')
    expect(production).toHaveTextContent('overview.deployedAt:{"when":"at 4000"}')
    expect(production).toHaveTextContent("access.entries.state.protected")
    expect(screen.getByTestId("sites-mobile-url-site_1")).toHaveAttribute(
      "href",
      "https://docs.example.com"
    )
  })

  it("says nothing is deployed when no deployment is live", () => {
    view({ mirror: true, sites: [site()] })
    expect(screen.getByTestId("sites-mobile-production-site_1")).toHaveTextContent(
      "overview.noVersion"
    )
  })

  it("lists each Site's recent operations with their outcome", () => {
    view({
      mirror: true,
      sites: [site(), site({ id: "site_2", name: "Blog" })],
      details: {
        versionsById: new Map(),
        operationsBySite: new Map([
          [
            "site_1",
            [
              operation({ id: "op_2", type: "build", status: "failed", updatedAt: 6_000 }),
              operation(),
            ],
          ],
        ]),
      },
    })
    const journal = screen.getByTestId("sites-mobile-operations-site_1")
    expect(journal).toHaveAccessibleName("mobile.recentOperations")
    expect(journal).toHaveTextContent("operationType.build")
    expect(journal).toHaveTextContent("operationStatus.failed")
    expect(journal).toHaveTextContent("operationType.deploy")
    expect(journal).toHaveTextContent("operationStatus.succeeded")
    expect(journal).toHaveTextContent("at 6000")
    // A Site with no journal shows none, not an empty heading.
    expect(screen.queryByTestId("sites-mobile-operations-site_2")).not.toBeInTheDocument()
  })

  it("offers no action at all: every change is made on the Host", () => {
    view({ mirror: true, sites: [site()], activeDeployments: [deployment()] })
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})

describe("standalone", () => {
  it("says the device is read-only and why", () => {
    view()
    expect(screen.getByTestId("sites-mobile-standalone")).toHaveTextContent("mobile.readOnly")
    expect(screen.getByTestId("sites-mobile-standalone")).toHaveTextContent("mobile.explain")
  })

  it("points at pairing when the phone holds no Sites", () => {
    view()
    expect(screen.getByTestId("sites-mobile-empty")).toHaveTextContent("mobile.empty")
    expect(screen.getByTestId("sites-mobile-empty")).toHaveTextContent("mobile.pairToSee")
  })

  it("lists the Sites this device's own database holds", () => {
    view({ sites: [site(), site({ id: "site_2", name: "Marketing" })] })
    expect(screen.getByTestId("sites-mobile-row-site_1")).toHaveTextContent("Docs")
    expect(screen.getByTestId("sites-mobile-row-site_2")).toHaveTextContent("Marketing")
  })

  it("falls back to the worker name before anything is deployed", () => {
    view({ sites: [site()] })
    expect(screen.getByTestId("sites-mobile-row-site_1")).toHaveTextContent("cognia-docs")
    // A name is not an address; there is nothing to open yet.
    expect(screen.queryByTestId("sites-mobile-url-site_1")).not.toBeInTheDocument()
  })

  it("shows a skeleton while reading, not the empty explanation", () => {
    view({ loading: true })
    expect(screen.getByTestId("sites-mobile-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("sites-mobile-empty")).not.toBeInTheDocument()
  })
})

describe("SiteMobileOverview", () => {
  it("reads the mirror flag and the details for the live deployments", () => {
    useSitesHostMirrorMock.mockReturnValue(true)
    useSiteOverviewDetailsMock.mockReturnValue({
      versionsById: new Map([["v1", { id: "v1", sequence: 3 } as SiteVersionRow]]),
      operationsBySite: new Map(),
    })
    const live = [deployment()]
    render(<SiteMobileOverview sites={[site()]} activeDeployments={live} loading={false} />)
    expect(useSiteOverviewDetailsMock).toHaveBeenCalledWith(live)
    expect(screen.getByTestId("sites-mobile-host")).toBeInTheDocument()
    expect(screen.getByTestId("sites-mobile-production-site_1")).toHaveTextContent(
      'overview.currentVersion:{"sequence":3}'
    )
  })
})
