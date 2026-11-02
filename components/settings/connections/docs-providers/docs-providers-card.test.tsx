import { registerDocsProvider } from "@/lib/docs-providers/registry"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import type { GoogleLineage } from "@/lib/docs-providers/providers/google/state"

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn(async () => undefined) }))
jest.mock("@/lib/db/adapter-instances", () => ({ listAdapterInstancesByType: jest.fn() }))
jest.mock("@/lib/docs-providers", () => ({
  ...jest.requireActual("@/lib/docs-providers/types"),
  larkDocsProvider: {
    id: "lark",
    mentionPrefix: "lark:",
    hosts: ["tauri"],
    listAccounts: jest.fn(async () => {
      const rows = await jest
        .requireMock("@/lib/db/adapter-instances")
        .listAdapterInstancesByType("lark")
      return rows
        .filter((row: { enabled: boolean }) => row.enabled)
        .map((row: { id: string }) => ({ id: row.id, searchable: false }))
    }),
    subscribeAccounts: jest.fn(() => jest.fn()),
  },
  googleDocsProvider: { id: "google", mentionPrefix: "gdoc:", hosts: ["tauri"] },
}))
// The card asks `docsProviderReach`, which asks the host profile. Driving the
// profile (rather than a `hostSupported` boolean) is what lets these tests
// tell a standalone browser apart from a paired companion.
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: jest.fn(() => "desktop") }))
jest.mock("@/lib/docs-providers/providers/google/config", () => ({
  GOOGLE_DOCS_SCOPES: ["https://www.googleapis.com/auth/drive.readonly"],
  getGoogleDocsSettings: jest.fn(async () => ({})),
  saveGoogleClientSecret: jest.fn(async () => undefined),
  clearGoogleClientSecret: jest.fn(async () => undefined),
  updateGoogleDocsSettings: jest.fn(async () => ({})),
  clearGoogleConnection: jest.fn(async () => undefined),
  subscribeGoogleDocsSettings: jest.fn(() => () => undefined),
}))
jest.mock("@/lib/docs-providers/providers/google/state", () => ({
  googleState: jest.fn(),
  subscribeGoogleStateChanged: jest.fn(() => () => undefined),
}))
jest.mock("@/lib/auth-providers/google/host-auth", () => ({
  listGoogleConnections: jest.fn(async () => []),
  authorizeGoogleConnection: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  getHostConnectionDriver: () => ({
    reauthorize: (...args: unknown[]) =>
      jest.requireMock("@/lib/auth-providers/google/host-auth").authorizeGoogleConnection(...args),
  }),
}))
jest.mock("@/lib/docs-providers/providers/google/auth", () => ({
  beginGoogleDocsAuth: jest.fn(async () => ({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    redirectUri: "http://127.0.0.1:7842/oauth/docs/google/callback",
  })),
  disconnectGoogleDocs: jest.fn(async () => ({ revoked: true })),
}))

import { toast } from "sonner"
import { openUrl } from "@/lib/native/opener"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { DocsProviderError, larkDocsProvider } from "@/lib/docs-providers"
import { useHostProfile } from "@/hooks/use-host-profile"
import {
  getGoogleDocsSettings,
  subscribeGoogleDocsSettings,
  saveGoogleClientSecret,
  clearGoogleClientSecret,
  updateGoogleDocsSettings,
} from "@/lib/docs-providers/providers/google/config"
import {
  beginGoogleDocsAuth,
  disconnectGoogleDocs,
} from "@/lib/docs-providers/providers/google/auth"
import {
  googleState,
  subscribeGoogleStateChanged,
} from "@/lib/docs-providers/providers/google/state"
import {
  listGoogleConnections,
  authorizeGoogleConnection,
} from "@/lib/auth-providers/google/host-auth"
import { DocsProvidersCard } from "./docs-providers-card"

const hostProfileMock = useHostProfile as jest.Mock
const listAdaptersMock = listAdapterInstancesByType as jest.Mock
const getSettingsMock = getGoogleDocsSettings as jest.Mock
const beginAuthMock = beginGoogleDocsAuth as jest.Mock
const disconnectMock = disconnectGoogleDocs as jest.Mock

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DocsProvidersCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  hostProfileMock.mockReturnValue("desktop")
  listAdaptersMock.mockResolvedValue([])
  getSettingsMock.mockResolvedValue({})
  beginAuthMock.mockResolvedValue({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
  })
  disconnectMock.mockResolvedValue({ revoked: true })
  ;(listGoogleConnections as jest.Mock).mockResolvedValue([])
  ;(googleState as jest.Mock).mockResolvedValue({
    lineages: [],
    clients: [],
    pending: [],
    migrationNeedsClientId: false,
    backupMigrationNeedsClientId: false,
  })
  ;(subscribeGoogleStateChanged as jest.Mock).mockImplementation(() => () => undefined)
  ;(subscribeGoogleDocsSettings as jest.Mock).mockImplementation(() => () => undefined)
})

describe("DocsProvidersCard — host gating", () => {
  it("keeps both rows and names the reason off the desktop shell", () => {
    hostProfileMock.mockReturnValue("mobile-companion")
    renderCard()
    // Rendered, not removed: hiding them told a paired phone nothing about
    // the desktop next to it that already holds both accounts.
    expect(screen.getByTestId("docs-provider-lark")).toBeInTheDocument()
    expect(screen.getByTestId("docs-provider-google")).toBeInTheDocument()
    expect(screen.getByTestId("docs-provider-google-notice")).toHaveAttribute(
      "data-cause",
      "runs-on-host"
    )
  })

  it("tells a standalone browser something different from a companion", () => {
    hostProfileMock.mockReturnValue("web-standalone")
    renderCard()
    expect(screen.getByTestId("docs-provider-lark-notice")).toHaveAttribute(
      "data-cause",
      "no-runtime"
    )
  })

  it("makes the Google controls inert rather than absent when blocked", () => {
    hostProfileMock.mockReturnValue("web-standalone")
    renderCard()
    expect(screen.getByTestId("docs-provider-google-connect")).toBeDisabled()
  })

  it("renders no notice on the desktop shell", () => {
    renderCard()
    expect(screen.queryByTestId("docs-provider-google-notice")).not.toBeInTheDocument()
    expect(screen.queryByTestId("docs-provider-lark-notice")).not.toBeInTheDocument()
  })
})

describe("DocsProvidersCard — Feishu row", () => {
  it("retains the latest native readiness when an older account read finishes late", async () => {
    let finish!: (accounts: unknown[]) => void
    ;(larkDocsProvider.listAccounts as jest.Mock)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValueOnce([{ id: "fresh", searchable: true }])
    let notify!: () => void
    const stop = jest.fn()
    ;(larkDocsProvider.subscribeAccounts as jest.Mock).mockImplementationOnce((listener) => {
      notify = listener
      return stop
    })
    const view = renderCard()
    act(() => notify())
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-lark-status")).toHaveTextContent(
        "1 configured · 1 with search permission"
      )
    )
    await act(async () => finish([]))
    expect(screen.getByTestId("docs-provider-lark-status")).toHaveTextContent(
      "1 configured · 1 with search permission"
    )
    view.unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("says no Feishu account is bound yet", async () => {
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-lark-status")).toHaveTextContent(
        "No Feishu account is connected yet."
      )
    )
  })

  it("counts only enabled Lark adapters", async () => {
    listAdaptersMock.mockResolvedValue([
      { id: "a", enabled: true },
      { id: "b", enabled: true },
      { id: "c", enabled: false },
    ])
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-lark-status")).toHaveTextContent(
        "2 configured · 0 with search permission"
      )
    )
  })

  it("never asks for Feishu credentials — it borrows the connector's", async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId("docs-provider-lark")).toBeInTheDocument())
    expect(screen.getByTestId("docs-provider-lark").querySelector("input")).toBeNull()
  })
})

function connection(overrides: Partial<AuthConnectionRow> = {}): AuthConnectionRow {
  return {
    id: "connection-ada" as AuthConnectionRow["id"],
    providerId: "google",
    ownerPluginId: null,
    publisher: "cognia",
    contractMajor: 1,
    issuer: "https://accounts.google.com",
    clientId: "cid",
    principalId: "ada",
    principalKind: "user",
    accountLabel: "ada@example.com",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    revision: 1,
    credentialRevision: 1,
    lineageId: "host-lineage",
    identityKey: "identity-ada",
    status: "connected",
    createdAt: 0,
    updatedAt: 0,
    hostMetadata: { adapterId: "native-ada", authorizationEpoch: "nonce-1", bot: false },
    ...overrides,
  }
}
function showConnections(rows: AuthConnectionRow[], lineages: Partial<GoogleLineage>[] = []) {
  ;(listGoogleConnections as jest.Mock).mockResolvedValue(rows)
  ;(googleState as jest.Mock).mockResolvedValue({
    lineages: lineages.map((lineage) => ({ id: "native-ada", needsIdentity: false, ...lineage })),
    clients: [],
    pending: [],
    migrationNeedsClientId: false,
    backupMigrationNeedsClientId: false,
  })
}

describe("DocsProvidersCard — Google connections", () => {
  it("shows the disconnected state and the requested read scopes", async () => {
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-google-status")).toHaveTextContent("Not connected")
    )
    expect(screen.getByText("drive.readonly")).toBeInTheDocument()
  })

  it("lists accounts, clients and reauthorization status while allowing another connection", async () => {
    showConnections([
      connection(),
      connection({
        id: "connection-grace" as AuthConnectionRow["id"],
        clientId: "other-client",
        accountLabel: "grace@example.com",
        status: "needs-reauth",
      }),
      connection({
        id: "retired" as AuthConnectionRow["id"],
        accountLabel: "retired@example.com",
        status: "tombstoned",
      }),
    ])
    renderCard()
    await screen.findByText("ada@example.com")
    expect(screen.getByText("grace@example.com")).toBeVisible()
    expect(screen.getByText("Client: other-client")).toBeVisible()
    expect(screen.getByText("Needs reauthorization")).toBeVisible()
    expect(screen.queryByText("retired@example.com")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument()
    expect(screen.getByTestId("docs-provider-google-status")).toHaveTextContent("2 connections")
  })

  it("keeps Connect disabled until a client id is supplied", async () => {
    renderCard()
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled())
  })

  it("writes the secret for the selected client, clears the draft and opens the system browser", async () => {
    const user = userEvent.setup()
    renderCard()
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled())
    await user.type(screen.getByLabelText("OAuth client ID"), "cid.apps.googleusercontent.com")
    await user.type(screen.getByLabelText("OAuth client secret"), "shh")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(beginAuthMock).toHaveBeenCalledWith({ clientId: "cid.apps.googleusercontent.com" })
    )
    expect(updateGoogleDocsSettings).toHaveBeenCalledWith({
      clientId: "cid.apps.googleusercontent.com",
    })
    expect(saveGoogleClientSecret).toHaveBeenCalledWith("shh", "cid.apps.googleusercontent.com")
    expect(screen.getByLabelText("OAuth client secret")).toHaveValue("")
    expect(openUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1")
  })

  it("shows saved secret metadata without reading its value and clears only that client's secret", async () => {
    getSettingsMock.mockResolvedValue({ clientId: "cid" })
    ;(googleState as jest.Mock).mockResolvedValue({
      lineages: [],
      clients: [{ clientId: "cid", hasClientSecret: true }],
      pending: [],
      migrationNeedsClientId: false,
      backupMigrationNeedsClientId: false,
    })
    const user = userEvent.setup()
    renderCard()
    await screen.findByText("Secret saved in the Host")
    expect(screen.getByLabelText("OAuth client secret")).toHaveValue("")
    ;(googleState as jest.Mock).mockResolvedValue({
      lineages: [],
      clients: [],
      pending: [],
      migrationNeedsClientId: false,
      backupMigrationNeedsClientId: false,
    })
    await user.click(screen.getByRole("button", { name: "Clear saved secret" }))
    await waitFor(() => expect(clearGoogleClientSecret).toHaveBeenCalledWith("cid"))
    await waitFor(() =>
      expect(screen.queryByText("Secret saved in the Host")).not.toBeInTheDocument()
    )
    expect(screen.getByLabelText("OAuth client secret")).toHaveValue("")
  })

  it("can save a replacement secret without beginning authorization", async () => {
    getSettingsMock.mockResolvedValue({ clientId: "cid" })
    const user = userEvent.setup()
    renderCard()
    await waitFor(() => expect(screen.getByLabelText("OAuth client ID")).toHaveValue("cid"))
    await user.type(screen.getByLabelText("OAuth client secret"), "replacement")
    await user.click(screen.getByRole("button", { name: "Save secret" }))
    await waitFor(() => expect(saveGoogleClientSecret).toHaveBeenCalledWith("replacement", "cid"))
    expect(screen.getByLabelText("OAuth client secret")).toHaveValue("")
    expect(beginAuthMock).not.toHaveBeenCalled()
  })

  it("prompts legacy identities to reauthorize the exact Host connection", async () => {
    showConnections([connection()], [{ needsIdentity: true }])
    const user = userEvent.setup()
    renderCard()
    await screen.findByText("Reauthorize to confirm this Google account's identity.")
    await user.click(screen.getByRole("button", { name: "Reauthorize" }))
    await waitFor(() =>
      expect(authorizeGoogleConnection).toHaveBeenCalledWith("connection-ada", {})
    )
    expect(beginAuthMock).not.toHaveBeenCalled()
  })

  it("reauthorizes the clicked device-code row with two accounts through the shared dialog", async () => {
    const ada = connection()
    const bob = connection({
      id: "connection-bob" as AuthConnectionRow["id"],
      accountLabel: "bob@example.com",
      hostMetadata: { adapterId: "native-bob", authorizationEpoch: "nonce-bob", bot: false },
    })
    showConnections(
      [ada, bob],
      [{ method: "device-code" }, { id: "native-bob", method: "device-code" }]
    )
    const pollAda = jest.fn(async () => ({ status: "pending" }))
    const pollBob = jest.fn(async () => ({ status: "pending" }))
    const cancelBob = jest.fn(async () => {})
    ;(authorizeGoogleConnection as jest.Mock).mockImplementation(async (ref) => ({
      kind: "device-code",
      userCode: ref === bob.id ? "BOB-CODE" : "ADA-CODE",
      verificationUrl: "https://google.com/device",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 5,
      poll: ref === bob.id ? pollBob : pollAda,
      cancel: cancelBob,
    }))
    const view = renderCard()
    const label = await screen.findByText("bob@example.com")
    const row = label.closest("li")!
    jest.useFakeTimers()
    try {
      fireEvent.click(within(row).getByRole("button", { name: "Reauthorize" }))
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByRole("dialog", { name: "Authorize connection" })).toBeVisible()
      expect(screen.getByText("BOB-CODE")).toBeVisible()
      expect(authorizeGoogleConnection).toHaveBeenCalledWith("connection-bob", {})
      expect(authorizeGoogleConnection).toHaveBeenCalledTimes(1)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000)
      })
      expect(pollBob).toHaveBeenCalledTimes(1)
      expect(pollAda).not.toHaveBeenCalled()
      await act(async () => view.unmount())
      expect(cancelBob).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
    expect(screen.queryByRole("link", { name: "Google Drive backup" })).not.toBeInTheDocument()
  })

  it("explains when a legacy saved secret still needs its client id", async () => {
    ;(googleState as jest.Mock).mockResolvedValue({
      lineages: [],
      clients: [],
      pending: [],
      migrationNeedsClientId: true,
      backupMigrationNeedsClientId: false,
    })
    renderCard()
    expect(
      await screen.findByText(
        "Enter the OAuth client ID associated with your saved secret to finish setup."
      )
    ).toBeVisible()
  })

  it("reports a localized reason when authorization cannot start", async () => {
    const user = userEvent.setup()
    beginAuthMock.mockRejectedValue(new DocsProviderError("hostUnsupported"))
    renderCard()
    await user.type(screen.getByLabelText("OAuth client ID"), "cid")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("desktop app only"))
    )
  })

  it("disconnects the selected native lineage and reports successful revocation", async () => {
    showConnections([connection()])
    const user = userEvent.setup()
    renderCard()
    await screen.findByRole("button", { name: "Disconnect" })
    showConnections([])
    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(disconnectMock).toHaveBeenCalledWith("native-ada"))
    await waitFor(() => expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith(
      "Disconnected. The Google authorization has been revoked."
    )
  })

  it("keeps the local disconnect and warns when Google revocation fails", async () => {
    showConnections([connection()])
    disconnectMock.mockResolvedValue({ revoked: false, reason: "backend error" })
    const user = userEvent.setup()
    renderCard()
    await screen.findByRole("button", { name: "Disconnect" })
    showConnections([])
    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument())
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("backend error"))
  })

  it("reports disconnect storage failures and keeps the connection available", async () => {
    showConnections([connection()])
    disconnectMock.mockRejectedValueOnce(new Error("keyring unavailable"))
    const user = userEvent.setup()
    renderCard()
    await user.click(await screen.findByRole("button", { name: "Disconnect" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("keyring unavailable"))
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled()
  })

  it("keeps the disconnecting status while revocation continues after a Host change", async () => {
    getSettingsMock.mockResolvedValue({ clientId: "cid" })
    showConnections([connection()])
    let notify!: () => void
    ;(subscribeGoogleStateChanged as jest.Mock).mockImplementation((listener) => {
      notify = listener
      return () => undefined
    })
    let finish!: (outcome: { revoked: true }) => void
    disconnectMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const user = userEvent.setup()
    renderCard()
    await user.click(await screen.findByRole("button", { name: "Disconnect" }))
    showConnections([])
    act(() => notify())
    await waitFor(() => expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument())
    expect(screen.getByRole("status")).toHaveTextContent("Disconnecting…")
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled()
    await act(async () => finish({ revoked: true }))
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()
  })

  it("keeps a newer Host snapshot when an initial read resolves late and unsubscribes", async () => {
    let finish!: (rows: AuthConnectionRow[]) => void
    ;(listGoogleConnections as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    let notify!: () => void
    const unsubscribe = jest.fn()
    ;(subscribeGoogleStateChanged as jest.Mock).mockImplementation((listener) => {
      notify = listener
      return unsubscribe
    })
    const view = renderCard()
    showConnections([connection()])
    act(() => notify())
    await screen.findByText("ada@example.com")
    await act(async () => finish([]))
    expect(screen.getByText("ada@example.com")).toBeVisible()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

it("lists a newly registered plugin by its manifest label and removes it on disable", async () => {
  renderCard()
  expect(screen.queryByText("Acme Documents")).toBeNull()
  let dispose!: () => void
  await act(async () => {
    dispose = registerDocsProvider({
      id: "plugin:settings/docs",
      label: "Acme Documents",
      mentionPrefix: "settings.docs:",
      kinds: ["doc"],
      hosts: ["tauri"],
      listAccounts: async () => [{ id: "host-ref", label: "Alice", authorizationEpoch: "2" }],
      matchRef: () => null,
      fetch: jest.fn(),
    })
  })
  expect(screen.getByText("Acme Documents")).toBeInTheDocument()
  expect(screen.getByText("Alice")).toBeInTheDocument()
  act(() => dispose())
  expect(screen.queryByText("Acme Documents")).toBeNull()
})
