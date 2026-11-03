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
import zh from "@/i18n/messages/zh-CN/plugins/auth.json"
import { useAccountStore } from "@/stores/account/account-store"
import { RuntimeSupportNotice } from "./runtime-support-notice"
import { EXTERNAL_SERVICE_RUNTIME_SUPPORT } from "@/lib/external-services/runtime-support"
jest.mock("@/stores/account/account-store", () => {
  const useAccountStore = Object.assign(
    (selector: (state: { unlockedAccountId: string }) => unknown) =>
      selector({ unlockedAccountId: "account" }),
    { getState: () => ({ lock: jest.fn() }) }
  )
  return { useAccountStore }
})
jest.mock("@/lib/runtime/browser-vault", () => ({ getActiveBrowserVault: jest.fn(() => null) }))
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
it("opens the existing AccountGate unlock path and links to pairing", async () => {
  const lock = jest.fn(async () => {})
  jest.spyOn(useAccountStore, "getState").mockReturnValue({ lock } as never)
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth } }}>
      <RuntimeSupportNotice
        support={{
          availability: "degraded",
          reason: "non-persistent-until-vault-unlock",
          recovery: ["unlock-vault", "pair-with-desktop", "use-always-on-host"],
        }}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("link", { name: "Pair with desktop" })).toHaveAttribute("href", "/pair")
  await userEvent.click(screen.getByRole("button", { name: "Unlock vault" }))
  expect(lock).toHaveBeenCalledTimes(1)
  expect(screen.getByText("Use an always-on Host")).toBeVisible()
})
it("translates every matrix reason and recovery in both locales", () => {
  for (const messages of [auth, zh])
    for (const facets of Object.values(EXTERNAL_SERVICE_RUNTIME_SUPPORT))
      for (const cell of Object.values(facets)) {
        expect(messages.runtimeSupport.reasons[cell.reason]).toEqual(expect.any(String))
        for (const recovery of cell.recovery)
          expect(messages.runtimeSupport.recovery[recovery]).toEqual(expect.any(String))
      }
})

it("reports an unlock failure and clears it when retry succeeds", async () => {
  const lock = jest
    .fn()
    .mockRejectedValueOnce(new Error("private-store-error"))
    .mockResolvedValueOnce(undefined)
  jest.spyOn(useAccountStore, "getState").mockReturnValue({ lock } as never)
  render(
    <NextIntlClientProvider locale="en" messages={{ plugins: { auth } }}>
      <RuntimeSupportNotice
        support={{
          availability: "degraded",
          reason: "non-persistent-until-vault-unlock",
          recovery: ["unlock-vault"],
        }}
      />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "Unlock vault" }))
  expect(screen.getByRole("alert")).toHaveTextContent(auth.runtimeSupport.recoveryFailed)
  expect(screen.queryByText("private-store-error")).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Unlock vault" }))
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it("shows no vault notice or unlock action once the Browser Vault is unlocked", () => {
  const lock = jest.fn(async () => {})
  jest.spyOn(useAccountStore, "getState").mockReturnValue({ lock } as never)
  jest.mocked(getActiveBrowserVault).mockReturnValue({} as never)
  try {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={{ plugins: { auth } }}>
        <RuntimeSupportNotice
          support={{
            availability: "degraded",
            reason: "non-persistent-until-vault-unlock",
            recovery: ["unlock-vault"],
          }}
        />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole("button", { name: "Unlock vault" })).not.toBeInTheDocument()
    expect(lock).not.toHaveBeenCalled()
  } finally {
    jest.mocked(getActiveBrowserVault).mockReturnValue(null)
  }
})
