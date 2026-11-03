/** @jest-environment jsdom */
jest.mock("next-intl", () => {
  const messages = {
    plugins: { auth: jest.requireActual("@/i18n/messages/en/plugins/auth.json") },
    settings: {
      externalServices: jest.requireActual("@/i18n/messages/en/settings/externalServices.json"),
    },
  }
  return {
    useLocale: () => "en",
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      const value = `${namespace}.${key}`
        .split(".")
        .reduce<unknown>(
          (item, segment) =>
            item && typeof item === "object"
              ? (item as Record<string, unknown>)[segment]
              : undefined,
          messages
        )
      return Object.entries(values ?? {}).reduce(
        (text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)),
        typeof value === "string" ? value : key
      )
    },
    NextIntlClientProvider: ({ children }: { children: import("react").ReactNode }) => children,
  }
})
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/plugins/auth.json"
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import { PluginConnectionPromptHost } from "./plugin-connection-prompt-host"
import { requestConnectionPrompt } from "@/lib/plugin/auth/connection-prompts"
import manifest from "@/plugins/feishu-auth/plugin.json"
import type { AuthProviderConfigurationSchema } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { useExternalServiceRuntimeProfile } from "@/hooks/plugins/use-external-service-runtime-profile"
jest.mock("@/hooks/plugins/use-external-service-runtime-profile", () => ({
  useExternalServiceRuntimeProfile: jest.fn(() => ({ local: "tauri", gateway: "tauri" })),
}))
beforeEach(() =>
  jest
    .mocked(useExternalServiceRuntimeProfile)
    .mockReturnValue({ local: "tauri", gateway: "tauri" })
)

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

it("keeps blocked methods visible and disabled with their reason", async () => {
  jest
    .mocked(useExternalServiceRuntimeProfile)
    .mockReturnValue({ local: "browser", gateway: "browser" })
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  act(() => {
    void requestConnectionPrompt({
      kind: "configure",
      pluginId: "owner",
      pluginName: "Owner",
      providerLabel: "Keys",
      schema: { type: "object", properties: {} },
      methods: ["device-code", "client-credentials", "api-key"],
      issuers: [],
      defaults: {},
    })
  })
  expect(screen.getByRole("option", { name: /Device code.*Not available yet/ })).toBeDisabled()
  expect(screen.getByRole("option", { name: /Bot.*trusted Host/ })).toBeDisabled()
  expect(screen.getByRole("combobox", { name: "Principal" })).toHaveValue("api-key")
  expect(screen.getByLabelText(en.connections.apiKey)).toHaveAttribute("type", "password")
  expect(screen.getByRole("button", { name: "Unlock vault" })).toBeVisible()
})

it("submits an API key only to the Host prompt and does not require OAuth fields", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  let pending!: ReturnType<typeof requestConnectionPrompt>
  act(() => {
    pending = requestConnectionPrompt({
      kind: "configure",
      pluginId: "owner",
      pluginName: "Owner",
      providerLabel: "Keys",
      schema: {
        type: "object",
        properties: { clientSecret: { type: "string", format: "secret" } },
        required: ["clientSecret"],
      },
      methods: ["api-key"],
      issuers: [],
      defaults: {},
    })
  })
  await userEvent.type(screen.getByLabelText(en.connections.apiKey), "write-only-key")
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
  await expect(pending).resolves.toEqual({
    kind: "configured",
    method: "api-key",
    configuration: { apiKey: "write-only-key" },
  })
})

it("disables submission when every declared method is blocked", () => {
  jest
    .mocked(useExternalServiceRuntimeProfile)
    .mockReturnValue({ local: "headless", gateway: "headless" })
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth: en } }}>
      <PluginConnectionPromptHost />
    </NextIntlClientProvider>
  )
  act(() => {
    void requestConnectionPrompt({
      kind: "configure",
      pluginId: "owner",
      pluginName: "Owner",
      providerLabel: "Dormant",
      schema: { type: "object", properties: {} },
      methods: ["device-code"],
      issuers: [],
      defaults: {},
    })
  })
  expect(screen.getByRole("option", { name: /Not available yet/ })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled()
})
