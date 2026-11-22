/** @jest-environment jsdom */

import { LogtoSignInCancelled } from "./capacitor-drivers"
import {
  createLogtoWebPopupDrivers,
  hasPendingLogtoCallbackState,
  readValidatedLogtoCallback,
  rememberLogtoCallbackState,
} from "./web-popup"

describe("Logto web popup", () => {
  afterEach(() => window.localStorage.clear())

  it("consumes a matching state exactly once", () => {
    rememberLogtoCallbackState("expected")
    expect(readValidatedLogtoCallback("?code=code-a&state=expected")).toEqual({
      __cogniaLogto: true,
      code: "code-a",
      state: "expected",
      error: null,
    })
    expect(readValidatedLogtoCallback("?code=replay&state=expected").error).toBe("state_mismatch")
  })

  it("rejects mismatched state without consuming or clobbering active pending states", () => {
    rememberLogtoCallbackState("expected")
    rememberLogtoCallbackState("parallel-tab")
    expect(readValidatedLogtoCallback("?code=stolen&state=other")).toMatchObject({
      code: null,
      error: "state_mismatch",
    })
    // Neither active flow was wiped by the stale/foreign callback.
    expect(readValidatedLogtoCallback("?code=code-a&state=expected")).toMatchObject({
      code: "code-a",
      state: "expected",
      error: null,
    })
    expect(readValidatedLogtoCallback("?code=code-b&state=parallel-tab")).toMatchObject({
      code: "code-b",
      state: "parallel-tab",
      error: null,
    })
  })

  describe("the popup window", () => {
    const AUTHORIZE = "https://id.test/authorize?state=s1"
    let open: jest.SpyInstance

    function fakeWindow(closed = false): Window & { replaced: string[]; closed: boolean } {
      const replaced: string[] = []
      const win = {
        closed,
        replaced,
        location: { replace: (url: string) => replaced.push(url) },
        close: jest.fn(() => {
          win.closed = true
        }),
      }
      return win as unknown as Window & { replaced: string[]; closed: boolean }
    }

    beforeEach(() => {
      open = jest.spyOn(window, "open")
    })
    afterEach(() => open.mockRestore())

    it("is opened only at openUrl time without a reservation", () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const drivers = createLogtoWebPopupDrivers()
      expect(open).not.toHaveBeenCalled()
      drivers.openUrl(AUTHORIZE)
      expect(open).toHaveBeenCalledWith(AUTHORIZE, "cognia-logto", "popup,width=520,height=720")
      expect(hasPendingLogtoCallbackState("s1")).toBe(true)
    })

    it("is reserved blank at creation, pointed at authorize URL, and closed on abandon or signal abort", async () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const controller = new AbortController()
      const drivers = createLogtoWebPopupDrivers(undefined, {
        reserveWindow: true,
        signal: controller.signal,
        closePollMs: 0,
      })
      expect(open).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith("about:blank", "cognia-logto", "popup,width=520,height=720")
      drivers.openUrl(AUTHORIZE)
      expect(open).toHaveBeenCalledTimes(1)
      expect(popup.replaced).toEqual([AUTHORIZE])

      const pending = drivers.waitForCode({ redirectUri: "/logto/callback", state: "s1" })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(popup.close).toHaveBeenCalledTimes(1)
      expect(hasPendingLogtoCallbackState("s1")).toBe(false)
    })

    it("settles with LogtoSignInCancelled when the user closes the popup window", async () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const drivers = createLogtoWebPopupDrivers(undefined, {
        closePollMs: 10,
        closeGraceMs: 10,
      })
      drivers.openUrl(AUTHORIZE)
      const pending = drivers.waitForCode({ redirectUri: "/logto/callback", state: "s1" })
      popup.closed = true
      await expect(pending).rejects.toBeInstanceOf(LogtoSignInCancelled)
      expect(hasPendingLogtoCallbackState("s1")).toBe(false)
    })

    it("opens afresh when the reservation was refused or closed", () => {
      open.mockReturnValueOnce(null)
      const refused = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      const second = fakeWindow()
      open.mockReturnValueOnce(second)
      refused.openUrl(AUTHORIZE)
      expect(open).toHaveBeenLastCalledWith(AUTHORIZE, "cognia-logto", "popup,width=520,height=720")

      const closed = fakeWindow(true)
      open.mockReturnValueOnce(closed)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      open.mockReturnValueOnce(fakeWindow())
      drivers.openUrl(AUTHORIZE)
      expect(closed.replaced).toEqual([])
      expect(open).toHaveBeenLastCalledWith(AUTHORIZE, "cognia-logto", "popup,width=520,height=720")
    })

    it("reports a blocked popup and forgets the state it stored", () => {
      open.mockReturnValue(null)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      expect(() => drivers.openUrl(AUTHORIZE)).toThrow("Logto popup was blocked")
      expect(hasPendingLogtoCallbackState("s1")).toBe(false)
    })

    it("closes the reserved window when the sign-in is abandoned first", () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      drivers.abandon?.()
      drivers.abandon?.()
      expect(popup.close).toHaveBeenCalledTimes(1)
    })
  })

  it("ignores messages for another state and resolves when the expected state arrives", async () => {
    const drivers = createLogtoWebPopupDrivers(undefined, { closePollMs: 0 })
    const pending = drivers.waitForCode({ redirectUri: "/logto/callback", state: "expected" })
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: { __cogniaLogto: true, code: null, state: "stale-attempt", error: "state_mismatch" },
      })
    )
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: { __cogniaLogto: true, code: "code-a", state: "expected", error: null },
      })
    )
    await expect(pending).resolves.toEqual({ code: "code-a", state: "expected" })
  })
})
