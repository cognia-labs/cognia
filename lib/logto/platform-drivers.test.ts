/** @jest-environment jsdom */

jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
const createPopupDrivers = jest.fn((..._args: unknown[]) => ({ flavour: "popup" }))
const createCapacitorDrivers = jest.fn((..._args: unknown[]) => ({ flavour: "capacitor" }))
jest.mock("./web-popup", () => ({
  createLogtoWebPopupDrivers: (...args: unknown[]) => createPopupDrivers(...args),
}))
jest.mock("./capacitor-drivers", () => ({
  createLogtoCapacitorDrivers: (...args: unknown[]) => createCapacitorDrivers(...args),
}))

import { openUrl } from "@/lib/native/opener"

import { LOGTO_NATIVE_CALLBACK_URI, OIDC_NATIVE_CALLBACK_URI } from "./client"
import { publishLogtoDeepLinkCallback } from "./deep-link-callback"
import { platformSignInDrivers } from "./platform-drivers"

const callback = (state: string) => ({
  kind: "logto_callback" as const,
  code: "code-1",
  state,
  error: null,
  raw: `cn.cognia.app:/auth/callback?code=code-1&state=${state}`,
})

describe("platformSignInDrivers", () => {
  it("sends Capacitor to the in-app browser with the issuer's native callback and abort signal", () => {
    const controller = new AbortController()
    const result = platformSignInDrivers({
      issuerKind: "oidc",
      isCapacitor: () => true,
      signal: controller.signal,
    })
    expect(result).toEqual({
      drivers: { flavour: "capacitor" },
      redirectUri: OIDC_NATIVE_CALLBACK_URI,
      clientKind: "native",
    })
    expect(createCapacitorDrivers).toHaveBeenCalledWith({ signal: controller.signal })
  })

  it("uses a popup on this origin's callback in a browser and forwards abort signal", () => {
    const controller = new AbortController()
    const result = platformSignInDrivers({
      issuerKind: "logto",
      isCapacitor: () => false,
      profile: "web-standalone",
      signal: controller.signal,
    })
    expect(result).toEqual({
      drivers: { flavour: "popup" },
      redirectUri: `${window.location.origin}/logto/callback`,
      clientKind: "web",
    })
    // Reserved now, while the sign-in click still lets the page open a window.
    expect(createPopupDrivers).toHaveBeenCalledWith(undefined, {
      reserveWindow: true,
      signal: controller.signal,
    })
  })

  it("opens the system browser on the desktop and resolves from the deep link", async () => {
    const { drivers, redirectUri, clientKind } = platformSignInDrivers({
      issuerKind: undefined,
      isCapacitor: () => false,
      profile: "desktop",
    })
    expect(redirectUri).toBe(LOGTO_NATIVE_CALLBACK_URI)
    expect(clientKind).toBe("native")
    drivers.openUrl("https://issuer/authorize")
    expect(openUrl).toHaveBeenCalledWith("https://issuer/authorize")
    const pending = drivers.waitForCode({ state: "st", redirectUri })
    publishLogtoDeepLinkCallback(callback("st"))
    await expect(pending).resolves.toEqual({ code: "code-1", state: "st" })
  })

  it("races a pasted callback against the deep link on the desktop", async () => {
    const pasted = jest.fn(async (state: string) => ({ code: "pasted", state }))
    const { drivers } = platformSignInDrivers({
      issuerKind: "oidc",
      isCapacitor: () => false,
      profile: "desktop",
      pasted,
    })
    await expect(drivers.waitForCode({ state: "st", redirectUri: "x" })).resolves.toEqual({
      code: "pasted",
      state: "st",
    })
    expect(pasted).toHaveBeenCalledWith("st")
  })

  it("stops waiting for the deep link when the caller gives up, including before waitForCode starts", async () => {
    const controller = new AbortController()
    const { drivers } = platformSignInDrivers({
      issuerKind: "oidc",
      isCapacitor: () => false,
      profile: "desktop",
      signal: controller.signal,
    })
    const pending = drivers.waitForCode({ state: "st", redirectUri: "x" })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })

    const preAborted = new AbortController()
    preAborted.abort()
    const early = platformSignInDrivers({
      issuerKind: "oidc",
      isCapacitor: () => false,
      profile: "desktop",
      signal: preAborted.signal,
    })
    ;(openUrl as jest.Mock).mockClear()
    early.drivers.openUrl("https://issuer/authorize")
    expect(openUrl).not.toHaveBeenCalled()
    await expect(
      early.drivers.waitForCode({ state: "st", redirectUri: "x" })
    ).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})
