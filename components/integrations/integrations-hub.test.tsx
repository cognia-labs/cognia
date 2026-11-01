import { getHostAuthSession } from "@/lib/plugin/api/auth-api"
import {
  checkIntegrationAccountHealth,
  listIntegrationResources,
} from "@/lib/integrations/providers"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { getNativeSelect, selectOption } from "@/lib/testing/select-option"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IntegrationsHub } from "./integrations-hub"
import { createAuthConnectionsAPI } from "@/lib/plugin/auth/connections-api"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import { feishuCalendarIntegration } from "@/plugins/feishu-calendar/src/index"
jest.mock("@/lib/plugin/auth/connections-api", () => ({ createAuthConnectionsAPI: jest.fn() }))
jest.mock("@/lib/plugin/api/integrations-api", () => ({ createIntegrationsAPI: jest.fn() }))

let mockPlatform = "tauri"
let mockHasEntries = true
let mockAccounts: unknown[] = []
let mockEntries: unknown[] | undefined
let mockJobs: unknown[] = []
const mockApproveJob = jest.fn()
const mockCancelJob = jest.fn()

const mockConfigureRepoWebhook = jest.fn()
const mockRotateAppWebhook = jest.fn()
const mockCreateSubscription = jest.fn()
const mockGetAccount = jest.fn()
const mockUpdateAccount = jest.fn()
const mockCreateAccount = jest.fn()

jest.mock("@/lib/plugin/api/auth-api", () => ({ getHostAuthSession: jest.fn() }))

jest.mock("@/lib/integrations/ingress-client", () => ({
  ...jest.requireActual("@/lib/integrations/ingress-client"),
  getIntegrationIngressPublicUrl: async (routeId: string) =>
    `http://127.0.0.1:4455/integration/${routeId}`,
  listIntegrationIngressDeadletters: async () => [],
  syncIntegrationIngressRoutes: async () => 0,
}))
jest.mock("@/lib/integrations/github-repo-webhook", () => ({
  ...jest.requireActual("@/lib/integrations/github-repo-webhook"),
  configureGithubRepoWebhook: (...args: unknown[]) => mockConfigureRepoWebhook(...args),
}))
jest.mock("@/lib/integrations/github-webhook", () => ({
  rotateGithubWebhookSecret: (...args: unknown[]) => mockRotateAppWebhook(...args),
}))
jest.mock("@/lib/integrations/providers", () => ({
  checkIntegrationAccountHealth: jest.fn(),
  listIntegrationResources: jest.fn(async () => ({
    items: [{ kind: "repository", id: "acme/app", name: "acme/app" }],
  })),
}))
jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: () => ({ save: async () => undefined }),
}))
jest.mock("@/lib/db/integrations", () => ({
  ...jest.requireActual("@/lib/db/integrations"),
  createIntegrationSubscription: (...args: unknown[]) => mockCreateSubscription(...args),
  createIntegrationAccount: (...args: unknown[]) => mockCreateAccount(...args),
  getIntegrationAccount: (...args: unknown[]) => mockGetAccount(...args),
  updateIntegrationAccount: (...args: unknown[]) => mockUpdateAccount(...args),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [mockAccounts, [], mockJobs, []],
}))
jest.mock("@/lib/integrations/action-runner", () => ({
  ...jest.requireActual("@/lib/integrations/action-runner"),
  approveIntegrationActionJob: (...args: unknown[]) => mockApproveJob(...args),
  cancelIntegrationActionJob: (...args: unknown[]) => mockCancelJob(...args),
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => mockPlatform,
}))
jest.mock("./account-outbound-recipients", () => ({
  IntegrationAccountOutboundRecipients: ({ account }: { account: { id: string } }) => (
    <div data-testid={`account-recipients-${account.id}`} />
  ),
}))
jest.mock("@/lib/integrations/registry", () => ({
  getIntegrationRegistryRevision: () => 1,
  subscribeIntegrationRegistry: () => () => undefined,
  listRegisteredIntegrationEntries: () => mockEntries ?? (mockHasEntries ? MOCK_ENTRIES : []),
}))

const MOCK_ENTRIES = [
  {
    pluginId: "demo-delivery",
    definition: {
      id: "demo",
      label: "Demo Delivery",
      description: "Demo integration",
      authStrategies: [
        {
          id: "token",
          type: "personal-access-token",
          label: "Token",
          providerId: "demo-token",
          configSchema: {
            type: "object",
            required: ["token"],
            properties: {
              token: { type: "string", format: "secret" },
              hostUrl: { type: "string", title: "Enterprise server URL" },
            },
          },
        },
        {
          id: "pat",
          type: "personal-access-token",
          label: "Advanced token",
          providerId: "demo-pat",
        },
      ],
      resourceKinds: ["workspace"],
      eventTypes: [{ id: "issue.created", label: "Issue created" }],
      actions: [
        {
          id: "issue.create",
          label: "Create issue",
          risk: "write",
          inputSchema: { type: "object" },
          idempotency: "supported",
          handler: "createIssue",
        },
      ],
    },
  },
]

beforeEach(() => {
  mockPlatform = "tauri"
  mockHasEntries = true
  mockAccounts = []
  mockEntries = undefined
  mockJobs = []
  jest.clearAllMocks()
})

it("admits the person's account setup and health check only in the Host submit action", async () => {
  jest.mocked(getHostAuthSession).mockResolvedValueOnce({
    id: "host-connection",
    accessToken: "test-token",
    account: { id: "person", label: "Person" },
    scopes: [],
  })
  mockCreateAccount.mockResolvedValueOnce({ id: "new-account" })
  render(<IntegrationsHub />)
  await selectOption(screen.getByLabelText("Integration"), "demo-delivery:demo")
  fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))
  fireEvent.change(screen.getByLabelText("Personal access token"), {
    target: { value: "test-token" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Validate and add" }))
  await waitFor(() =>
    expect(getHostAuthSession).toHaveBeenCalledWith(
      "demo-token",
      [],
      { createIfNone: true, forceNewSession: true, configuration: { token: "test-token" } },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
  )
  await waitFor(() =>
    expect(checkIntegrationAccountHealth).toHaveBeenCalledWith("demo-delivery", "new-account", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
  )
})

describe("connection service consumers", () => {
  const account = {
    id: "calendar-account",
    pluginId: "feishu-calendar",
    integrationId: "feishu-calendar",
    connectionId: "calendar-ref",
    label: "Work calendar",
    enabled: true,
    health: "degraded",
    status: { code: "consumer-grant-required" },
  }
  it("labels inactive calendar features and connection recovery reasons", async () => {
    mockEntries = [{ pluginId: "feishu-calendar", definition: feishuCalendarIntegration }]
    mockAccounts = [account]
    await act(async () => {
      render(<IntegrationsHub />)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Review read access to resume sync")
    expect(screen.getAllByRole("note")).toHaveLength(2)
    expect(screen.getByText(/Read-only: recurring exceptions/)).toBeInTheDocument()
    expect(screen.getByText(/Unsupported: native push/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /exception|push/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Review write access" })).toBeEnabled()
  })

  it("uses the Host picker without credential fields and consents reads and writes separately", async () => {
    mockEntries = [{ pluginId: "feishu-calendar", definition: feishuCalendarIntegration }]
    mockAccounts = [account]
    const get = jest.fn(async () => ({ ref: "calendar-ref" }))
    const requestGrant = jest.fn(async () => ({ granted: true }))
    const health = jest.fn()
    jest.mocked(createAuthConnectionsAPI).mockReturnValue({ get, requestGrant } as never)
    jest
      .mocked(createIntegrationsAPI)
      .mockReturnValue({ listAccounts: async () => [account], checkAccountHealth: health } as never)
    render(<IntegrationsHub />)
    await selectOption(screen.getByLabelText("Integration"), "feishu-calendar:feishu-calendar")
    fireEvent.click(screen.getByRole("button", { name: /Host calendar connection/ }))
    expect(
      screen.queryByLabelText(/App Secret|App ID|redirect URI|Auth provider ID/i)
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Validate and add" }))
    await waitFor(() => expect(health).toHaveBeenCalledTimes(1))
    expect(get).toHaveBeenCalledWith({
      service: "auth.feishu",
      scopes: ["calendar:calendar:readonly"],
      interactive: true,
    })
    expect(requestGrant.mock.calls[0]).toEqual([
      "calendar-ref",
      {
        operations: feishuCalendarIntegration.authStrategies[0].consumerOperations!.read,
        scopes: ["calendar:calendar:readonly"],
      },
    ])
    fireEvent.click(screen.getByRole("button", { name: "Review write access" }))
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2))
    expect(requestGrant.mock.calls[1]).toEqual([
      "calendar-ref",
      {
        operations: feishuCalendarIntegration.authStrategies[0].consumerOperations!.write,
        scopes: ["calendar:calendar"],
      },
    ])
  })
})

describe("approvals and jobs", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: "job-1",
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "acc-gh",
    actionId: "commentPr",
    input: {},
    status: "awaiting_approval",
    risk: "write",
    attempts: 0,
    maxAttempts: 5,
    source: "chat",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...over,
  })

  it("approves and cancels a job as a person (ADR-0239)", () => {
    mockJobs = [job()]
    render(<IntegrationsHub />)
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(mockApproveJob).toHaveBeenCalledWith("job-1", { actor: "person" })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockCancelJob).toHaveBeenCalledWith("job-1", { actor: "person" })
    expect(screen.queryByText(/Held by outbound authorization/)).not.toBeInTheDocument()
  })

  it("says when outbound authorization holds a job", () => {
    mockJobs = [job({ outbound: { ownerRef: "bot:b1", held: { receiptId: "r1", heldAt: "now" } } })]
    render(<IntegrationsHub />)
    expect(screen.getByText(/Held by outbound authorization/)).toBeInTheDocument()
  })

  it("warns about an unknown remote outcome on a cancelled job", async () => {
    mockJobs = [job({ status: "cancelled", remoteOutcome: "unknown" })]
    await act(async () => {
      render(<IntegrationsHub />)
    })
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remote outcome unknown. Check the service before trying again."
    )
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })
})

const GITHUB_ENTRY = {
  pluginId: "github-delivery",
  definition: {
    id: "github",
    label: "GitHub",
    description: "GitHub",
    authStrategies: [],
    resourceKinds: ["repository"],
    resourceProvider: { handler: "listGithubResources", kinds: ["repository"] },
    eventTypes: [{ id: "issues.closed", label: "issues.closed" }],
    actions: [],
    ingress: {
      normalizer: "normalizeGithub",
      verification: { type: "hmac-sha256", signatureHeader: "x-hub-signature-256" },
    },
  },
}

function githubAccount(over: Record<string, unknown> = {}) {
  return {
    id: "acc-gh",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "s",
    label: "octocat",
    enabled: true,
    health: "healthy",
    ingressEndpoint: {
      id: "ep",
      accountId: "acc-gh",
      routeId: "route-1",
      secretHandle: "h",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    ...over,
  }
}

describe("unattended repository list (ADR-0239 phase 2)", () => {
  it("is offered on each GitHub account and on no other", () => {
    mockEntries = [GITHUB_ENTRY, ...MOCK_ENTRIES]
    mockAccounts = [
      githubAccount(),
      { ...githubAccount({ id: "acc-demo" }), pluginId: "demo-delivery", integrationId: "demo" },
    ]
    render(<IntegrationsHub />)
    expect(screen.getByTestId("account-recipients-acc-gh")).toBeInTheDocument()
    expect(screen.queryByTestId("account-recipients-acc-demo")).not.toBeInTheDocument()
  })
})

describe("IntegrationsHub webhook delivery", () => {
  it("says the listener is local-only until a public URL is configured", async () => {
    mockEntries = [GITHUB_ENTRY]
    mockAccounts = [githubAccount()]
    render(<IntegrationsHub />)
    expect(
      await screen.findByText("Local listener: http://127.0.0.1:4455/integration/route-1")
    ).toBeInTheDocument()
    expect(screen.getByText(/only accepts connections from this device/)).toBeInTheDocument()
    expect(screen.queryByText(/^Webhook URL:/)).not.toBeInTheDocument()
  })

  it("shows the public delivery URL once one is configured", async () => {
    mockEntries = [GITHUB_ENTRY]
    const account = githubAccount()
    mockAccounts = [
      {
        ...account,
        ingressEndpoint: { ...account.ingressEndpoint, publicBaseUrl: "https://hooks.example.com" },
      },
    ]
    render(<IntegrationsHub />)
    expect(
      await screen.findByText("Webhook URL: https://hooks.example.com/integration/route-1")
    ).toBeInTheDocument()
  })

  it("checks account health with the Host person's explicit admission", async () => {
    mockEntries = [GITHUB_ENTRY]
    mockAccounts = [githubAccount()]
    await act(async () => {
      render(<IntegrationsHub />)
    })
    fireEvent.click(screen.getByRole("button", { name: "Check account health" }))
    expect(checkIntegrationAccountHealth).toHaveBeenCalledWith("github-delivery", "acc-gh", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
  })

  it("configures the repository webhook for a PAT account at the public URL", async () => {
    mockEntries = [GITHUB_ENTRY]
    const account = githubAccount()
    mockAccounts = [account]
    const withBase = {
      ...account,
      ingressEndpoint: { ...account.ingressEndpoint, publicBaseUrl: "https://hooks.example.com" },
    }
    mockGetAccount.mockResolvedValueOnce(account).mockResolvedValueOnce(withBase)
    mockCreateSubscription.mockResolvedValue({})
    mockConfigureRepoWebhook.mockResolvedValue({ status: "created", hookId: 1, events: [] })
    render(<IntegrationsHub />)

    await selectOption(screen.getByRole("combobox", { name: "Account" }), "acc-gh")
    fireEvent.click(await screen.findByRole("button", { name: "Discover" }))
    await waitFor(() =>
      expect(listIntegrationResources).toHaveBeenCalledWith(
        "github-delivery",
        expect.objectContaining({ accountId: "acc-gh" }),
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    )
    await waitFor(() =>
      expect(getNativeSelect(screen.getByLabelText("Repository"))).toHaveTextContent("acme/app")
    )
    await selectOption(screen.getByLabelText("Repository"), "acme/app")
    fireEvent.click(screen.getByRole("checkbox", { name: "Issue closed" }))
    fireEvent.change(screen.getByLabelText("Webhook secret (required when ingress is enabled)"), {
      target: { value: "shh" },
    })
    fireEvent.change(screen.getByLabelText("Public webhook URL (tunnel or reverse proxy)"), {
      target: { value: "hooks.example.com" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add subscription" }))
    })

    await waitFor(() =>
      expect(mockConfigureRepoWebhook).toHaveBeenCalledWith({
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
        account: withBase,
        repoFullName: "acme/app",
        webhookUrl: "https://hooks.example.com/integration/route-1",
        eventTypes: ["issues.closed"],
      })
    )
    expect(mockUpdateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "acc-gh",
      expect.objectContaining({
        ingressEndpoint: expect.objectContaining({ publicBaseUrl: "https://hooks.example.com" }),
      })
    )
    expect(mockRotateAppWebhook).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        "The webhook for acme/app is configured and will deliver the selected events."
      )
    ).toBeInTheDocument()
  })

  it("refuses a private public-URL before saving anything", async () => {
    mockEntries = [GITHUB_ENTRY]
    mockAccounts = [githubAccount()]
    render(<IntegrationsHub />)
    await selectOption(screen.getByRole("combobox", { name: "Account" }), "acc-gh")
    fireEvent.click(screen.getByRole("checkbox", { name: "Issue closed" }))
    fireEvent.change(screen.getByLabelText("Public webhook URL (tunnel or reverse proxy)"), {
      target: { value: "http://192.168.1.2:8080" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add subscription" }))
    })
    expect(await screen.findByText(/must be an https address on a public host/)).toBeInTheDocument()
    expect(mockCreateSubscription).not.toHaveBeenCalled()
  })

  it("does not push anything to GitHub without a public URL", async () => {
    mockEntries = [GITHUB_ENTRY]
    const account = githubAccount({ providerId: "github-app", dedicatedAppConfirmed: true })
    mockAccounts = [account]
    mockGetAccount.mockResolvedValue(account)
    mockCreateSubscription.mockResolvedValue({})
    render(<IntegrationsHub />)
    await selectOption(screen.getByRole("combobox", { name: "Account" }), "acc-gh")
    fireEvent.click(screen.getByRole("checkbox", { name: "Issue closed" }))
    fireEvent.change(screen.getByLabelText("Webhook secret (required when ingress is enabled)"), {
      target: { value: "shh" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add subscription" }))
    })
    expect(await screen.findByText(/GitHub was not configured/)).toBeInTheDocument()
    expect(mockRotateAppWebhook).not.toHaveBeenCalled()
    expect(mockConfigureRepoWebhook).not.toHaveBeenCalled()
  })
})

describe("IntegrationsHub", () => {
  it("renders registered Marketplace integrations and host-owned management sections", () => {
    render(<IntegrationsHub />)
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument()
    expect(screen.getAllByText("Demo Delivery")).not.toHaveLength(0)
    expect(screen.getByText("Accounts")).toBeInTheDocument()
    expect(screen.getByText("Subscriptions")).toBeInTheDocument()
    expect(screen.getByText("Approvals and jobs")).toBeInTheDocument()
    expect(screen.getByText("Audit")).toBeInTheDocument()
  })

  it("gives the page one h1 and each management section a real h2", () => {
    // The four sections used to be `<Card>`s whose titles were spans wearing
    // `role="heading"`, and the page title was a hand-rolled <h1> in the
    // scroll body rather than the shared header band. The outline is what a
    // screen reader navigates by, so it is pinned here.
    render(<IntegrationsHub />)
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent?.trim())
    expect(sections).toEqual(["Accounts", "Subscriptions", "Approvals and jobs", "Audit"])
  })

  it("guides authentication configuration instead of asking for raw provider IDs", async () => {
    render(<IntegrationsHub />)
    await selectOption(screen.getByLabelText("Integration"), "demo-delivery:demo")
    expect(screen.getByRole("button", { name: /Token Recommended/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Advanced token Advanced/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))
    expect(screen.getByLabelText("Personal access token")).toHaveAttribute("type", "password")
    expect(screen.queryByPlaceholderText("Auth provider ID")).not.toBeInTheDocument()
  })

  it("offers the enterprise server field and says that leaving it empty is fine", async () => {
    // ADR-0176. The one field here where blank is the common, correct answer.
    // A bare label cannot say so, and a user who types github.com into it has
    // been given a worse account than one who left it alone.
    render(<IntegrationsHub />)
    await selectOption(screen.getByLabelText("Integration"), "demo-delivery:demo")
    fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))

    const field = screen.getByLabelText("Enterprise server URL")
    expect(field).toHaveAttribute("type", "text")
    expect(field).not.toBeRequired()
    expect(screen.getByText(/Leave empty for github\.com/)).toBeInTheDocument()
  })

  it("points at the marketplace instead of an account form with nothing to pick", () => {
    mockHasEntries = false
    render(<IntegrationsHub />)
    expect(screen.getByRole("link", { name: "Browse plugins" })).toHaveAttribute(
      "href",
      "/plugins?section=discover"
    )
    expect(screen.queryByLabelText("Integration")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Validate and add" })).not.toBeInTheDocument()
    expect(screen.getByText("Install an integration plugin to add an account.")).toBeInTheDocument()
  })

  it("asks for an account before offering a subscription form", () => {
    render(<IntegrationsHub />)
    expect(screen.queryByRole("button", { name: "Add subscription" })).not.toBeInTheDocument()
    expect(
      screen.getByText("Add an account first, then subscribe to its events.")
    ).toBeInTheDocument()
  })

  it("offers the subscription form once an account exists", () => {
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.getByRole("button", { name: "Add subscription" })).toBeEnabled()
    // No account picked yet: the events legend waits for one instead of
    // heading an empty list.
    expect(screen.queryByText("Events")).not.toBeInTheDocument()
  })

  // A browser or a phone with nothing recorded gets one statement of where
  // integrations live, not four empty sections under an install card whose
  // plugins cannot be installed here either.
  it("says where integrations live instead of an empty console where they cannot run", () => {
    mockPlatform = "web"
    mockHasEntries = false
    render(<IntegrationsHub />)
    expect(screen.getByTestId("integrations-unsupported")).toHaveTextContent(
      "Integration management requires the desktop app."
    )
    expect(screen.queryByRole("link", { name: "Browse plugins" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument()
  })

  it("keeps anything already recorded reachable, without the install card", () => {
    mockPlatform = "web"
    mockHasEntries = false
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.queryByTestId("integrations-unsupported")).not.toBeInTheDocument()
    expect(screen.getByText("Integration management requires the desktop app.")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Browse plugins" })).not.toBeInTheDocument()
  })

  it("makes the whole account form inert where it cannot be submitted", () => {
    mockPlatform = "web"
    // Something is recorded, so the console renders; its forms stay inert.
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.getByText("Integration management requires the desktop app.")).toBeInTheDocument()
    expect(screen.getByLabelText("Integration")).toBeDisabled()
    expect(screen.getByLabelText("Account label")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Validate and add" })).toBeDisabled()
  })

  it("names the authentication step only once an integration is picked", async () => {
    render(<IntegrationsHub />)
    expect(screen.queryByText("Authentication method")).not.toBeInTheDocument()
    await selectOption(screen.getByLabelText("Integration"), "demo-delivery:demo")
    expect(screen.getByText("Authentication method")).toBeInTheDocument()
  })
})
