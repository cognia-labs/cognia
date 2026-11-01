/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import { PluginConnectionPromptHost } from "./plugin-connection-prompt-host"
import { requestConnectionPrompt } from "@/lib/plugin/auth/connection-prompts"
import manifest from "@/plugins/feishu-auth/plugin.json"
import type { AuthProviderConfigurationSchema } from "@cognia/plugin-contract/types/plugin/plugin-auth"

jest.mock("@/lib/plugin/auth/callback-acceptor", () => ({
  startHostAuthCallbackListeners: () => jest.fn(),
}))

it("collects configuration only in the Host, selects deployment and bot method, and masks the secret", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  let pending!: ReturnType<typeof requestConnectionPrompt>
  act(() => {
    pending = requestConnectionPrompt({
      kind: "configure",
      pluginId: "feishu-auth",
      pluginName: "Feishu",
      providerLabel: "Feishu",
      schema: manifest.authProviders[0].configurationSchema as AuthProviderConfigurationSchema,
      methods: ["oauth-pkce", "client-credentials"],
      issuers: manifest.authProviders[0].issuers,
      defaults: { issuer: "https://accounts.feishu.cn" },
    })
  })
  await userEvent.type(screen.getByRole("textbox", { name: "App ID" }), "app-one")
  const secret = screen.getByLabelText("App secret")
  expect(secret).toHaveAttribute("type", "password")
  await userEvent.type(secret, "host-secret")
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Deployment" }),
    "https://accounts.larksuite.com"
  )
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Principal" }),
    "client-credentials"
  )
  expect(
    screen.queryByRole("textbox", { name: "Registered callback URI (optional)" })
  ).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
  await expect(pending).resolves.toEqual({
    kind: "configured",
    method: "client-credentials",
    configuration: {
      appId: "app-one",
      clientSecret: "host-secret",
      issuer: "https://accounts.larksuite.com",
    },
  })
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it.each(["tenant-scope-required", "identity-conflict"] as const)(
  "renders an i18n'd %s recovery reason",
  async (reason) => {
    render(
      <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
        <PluginConnectionPromptHost />
      </NextIntlClientProvider>
    )
    let pending!: ReturnType<typeof requestConnectionPrompt>
    act(() => {
      pending = requestConnectionPrompt({
        kind: "connect-error",
        pluginId: "feishu-auth",
        pluginName: "Feishu",
        reason,
      })
    })
    expect(screen.getByRole("dialog", { name: "Connection failed" })).toHaveTextContent(
      reason === "tenant-scope-required" ? "tenant:tenant:readonly" : "already have a connection"
    )
    await userEvent.keyboard("{Escape}")
    await expect(pending).resolves.toEqual({ kind: "dismissed" })
  }
)

it("has the same setup and failure keys in both locales", () => {
  expect(Object.keys(en.connections).sort()).toEqual(Object.keys(zh.connections).sort())
})
