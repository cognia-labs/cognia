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
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import auth from "@/i18n/messages/en/plugins/auth.json"
import type { PluginManifest } from "@/types/plugin"
import { PluginRuntimeSupportSection } from "./plugin-runtime-support-section"
jest.mock("@/hooks/plugins/use-external-service-runtime-profile", () => ({
  useExternalServiceRuntimeProfile: () => ({ local: "tauri", gateway: "tauri" }),
}))
it("lists every declared provider and method, including dormant device-code on desktop", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth } }}>
      <PluginRuntimeSupportSection
        manifest={
          {
            id: "auth",
            authProviders: [
              { id: "vendor", label: "Vendor", methods: ["oauth-pkce", "api-key", "device-code"] },
            ],
          } as PluginManifest
        }
      />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByText("Runtime support (tauri)"))
  expect(screen.getAllByRole("listitem")).toHaveLength(3)
  expect(screen.getByText(/Device code.*Not available yet.*Unavailable/)).toBeVisible()
  expect(screen.getByText("Use another sign-in method")).toBeVisible()
})
