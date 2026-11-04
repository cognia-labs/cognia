import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OpencodeAuthPanel } from "./opencode-auth-panel"

jest.mock("@/lib/ai/agent/external/manager", () => ({ getExternalAgentManager: jest.fn() }))
jest.mock("@cognia/agent-opencode/v2-client", () => ({ openCodeV2Extension: "v2" }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn(async () => {}) }))
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages = jest.requireActual("@/i18n/messages/en/externalAgent.json").settings.opencode
      .auth
    return (key: string, values: Record<string, string> = {}) => {
      const message = key.split(".").reduce((value, part) => value[part], messages)
      if (typeof message !== "string") throw new Error(`Missing translation ${key}`)
      return message.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? name)
    }
  },
}))
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { openUrl } from "@/lib/native/opener"
import type { FormField } from "@cognia/agent-opencode/v2-auth"

function fixture(mode: "auto" | "code" = "auto", form?: FormField[]) {
  let signedIn = false
  const client = {
    integration: {
      list: jest.fn(async () => ({
        data: [
          {
            id: "opencode",
            name: "OpenCode",
            methods: [
              {
                id: "device",
                type: "oauth",
                label: "Console",
                form: form ?? [
                  { key: "server", type: "string", hidden: true, default: "https://opencode.ai" },
                ],
              },
            ],
            connections: signedIn
              ? [{ type: "credential", id: "account", label: "Work account", method: "oauth" }]
              : [],
          },
        ],
      })),
      oauth: {
        connect: jest.fn(async () => ({
          data: {
            attemptID: "a",
            url: "https://opencode.ai/device",
            mode,
            instructions: "Enter ABC",
            time: { created: Date.now(), expires: Date.now() + 60_000 },
          },
        })),
        status: jest.fn(async () => {
          signedIn = true
          return { data: { status: "complete" } }
        }),
        complete: jest.fn(async () => {}),
        cancel: jest.fn(async () => {}),
      },
    },
  }
  jest.mocked(getExternalAgentManager).mockReturnValue({
    getAdapterExtension: () => ({ getAuthClient: () => client }),
    addLifecycleListener: jest.fn(() => () => {}),
    getAgent: () => ({ config: { process: { cwd: "/repo" } } }),
  } as never)
  const onAuthenticated = jest.fn(async () => {})
  const view = render(<OpencodeAuthPanel agentId="a" connected onAuthenticated={onAuthenticated} />)
  return { client, onAuthenticated, ...view }
}

beforeEach(() => jest.clearAllMocks())

it("completes device authorization and discovers the service account", async () => {
  const user = userEvent.setup()
  const { client, onAuthenticated } = fixture()
  await user.click(await screen.findByRole("button", { name: "Sign in with Console" }))
  await user.click(screen.getByRole("button", { name: "Continue to authorization" }))
  const dialog = screen.getByRole("dialog")
  await user.click(await within(dialog).findByRole("button", { name: "Open authorization page" }))
  expect(openUrl).toHaveBeenCalledWith("https://opencode.ai/device")
  expect(client.integration.oauth.connect).toHaveBeenCalledWith(
    expect.objectContaining({ answer: { server: "https://opencode.ai" } }),
    expect.anything()
  )
  await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1), { timeout: 3_000 })
  expect(screen.getByText("Work account")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Done" }))
  await user.click(screen.getByRole("button", { name: "Sign in with Console" }))
  expect(screen.getByRole("button", { name: "Continue to authorization" })).toBeInTheDocument()
})

it("submits a pasted authorization code through the bound service", async () => {
  const user = userEvent.setup()
  const { client } = fixture("code")
  await user.click(await screen.findByRole("button", { name: "Sign in with Console" }))
  await user.click(screen.getByRole("button", { name: "Continue to authorization" }))
  await user.type(await screen.findByRole("textbox", { name: "Authorization code" }), "code-123")
  await user.click(screen.getByRole("button", { name: "Submit code" }))
  await waitFor(() =>
    expect(client.integration.oauth.complete).toHaveBeenCalledWith(
      {
        integrationID: "opencode",
        attemptID: "a",
        code: "code-123",
        location: { directory: "/repo" },
      },
      expect.anything()
    )
  )
  expect(
    await screen.findByText("Sign-in completed. The OpenCode service now manages this account.")
  ).toBeInTheDocument()
})

it("cancels on dismissal and preserves a retryable dialog when cancellation fails", async () => {
  const user = userEvent.setup()
  const { client } = fixture()
  await user.click(await screen.findByRole("button", { name: "Sign in with Console" }))
  await user.click(screen.getByRole("button", { name: "Continue to authorization" }))
  await screen.findByText("Waiting for authorization…")
  client.integration.oauth.cancel.mockRejectedValueOnce(new Error("offline"))
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not cancel authorization")
  expect(screen.getByRole("dialog")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
})

it("submits typed form answers and omits inactive or cleared optional fields", async () => {
  const user = userEvent.setup()
  const { client } = fixture("auto", [
    { key: "enterprise", title: "Enterprise", type: "boolean" },
    {
      key: "organization",
      title: "Organization",
      type: "string",
      required: true,
      when: [{ key: "enterprise", op: "eq", value: true }],
    },
    { key: "scopes", title: "Scopes", type: "multiselect", options: [], custom: true },
    { key: "count", title: "Count", type: "integer", default: 3 },
  ])
  await user.click(await screen.findByRole("button", { name: "Sign in with Console" }))
  expect(screen.queryByRole("textbox", { name: "Organization" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("checkbox", { name: "Enterprise" }))
  await user.type(screen.getByRole("textbox", { name: "Organization" }), "Example")
  await user.click(screen.getByRole("checkbox", { name: "Enterprise" }))
  await user.type(screen.getByRole("textbox", { name: "Scopes" }), "alpha\nbeta\n")
  await user.clear(screen.getByRole("spinbutton", { name: "Count" }))
  await user.click(screen.getByRole("button", { name: "Continue to authorization" }))
  await waitFor(() =>
    expect(client.integration.oauth.connect).toHaveBeenCalledWith(
      expect.objectContaining({ answer: { enterprise: false, scopes: ["alpha", "beta"] } }),
      expect.anything()
    )
  )
})

it("shows an empty state when no integration has OAuth methods or accounts", async () => {
  const { client } = fixture()
  client.integration.list.mockResolvedValue({
    data: [{ id: "key-only", name: "Key only", methods: [], connections: [] }],
  } as never)
  await screen.findByRole("button", { name: "Refresh sign-in status" })
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh sign-in status" }))
  expect(await screen.findByText("No sign-in methods or accounts reported.")).toBeInTheDocument()
})
