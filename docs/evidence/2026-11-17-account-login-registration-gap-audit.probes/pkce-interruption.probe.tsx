/** @jest-environment jsdom */

import { act, waitFor } from "@testing-library/react"

import { loginToLogto } from "@/lib/logto/client"
import { createLogtoWebPopupDrivers } from "@/lib/logto/web-popup"

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  localStorage.clear()
})

it("the actual PKCE client also stays pending when its popup closes", async () => {
  const replace = jest.fn()
  const popup = { closed: false, location: { replace } }
  jest.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
  const tokenRequests: URLSearchParams[] = []
  const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: "https://issuer.example",
          authorization_endpoint: "https://issuer.example/authorize",
          token_endpoint: "https://issuer.example/token",
        }),
        { status: 200 }
      )
    }
    expect(url).toBe("https://issuer.example/token")
    tokenRequests.push(new URLSearchParams(String(init?.body)))
    return new Response(
      JSON.stringify({ access_token: "fixture-token", token_type: "Bearer", expires_in: 300 }),
      { status: 200 }
    )
  }) as typeof fetch
  const drivers = createLogtoWebPopupDrivers(fetchImpl, { reserveWindow: true })
  let settled = false
  let rejected: unknown
  const pending = loginToLogto(
    {
      issuer: "https://issuer.example",
      clientId: "cognia-web",
      redirectUri: `${window.location.origin}/logto/callback`,
      resource: "https://sync.example",
      issuerKind: "oidc",
      socialProvider: "github",
    },
    drivers
  )
  void pending.then(
    () => {
      settled = true
    },
    (cause) => {
      settled = true
      rejected = cause
    }
  )
  await waitFor(() => {
    if (rejected) throw rejected
    expect(replace).toHaveBeenCalledTimes(1)
  })
  const authorize = new URL(replace.mock.calls[0][0])
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
  expect(authorize.searchParams.get("prompt")).toBe("login")
  jest.useFakeTimers()
  popup.closed = true
  await act(async () => {
    jest.advanceTimersByTime(600_000)
  })
  expect(settled).toBe(false)
  expect(tokenRequests).toHaveLength(0)
  jest.useRealTimers()

  // Deliver a matching response solely to settle the isolated test's waiter.
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: {
        __cogniaLogto: true,
        state: authorize.searchParams.get("state"),
        code: "fixture-code",
      },
    })
  )
  await expect(pending).resolves.toMatchObject({ accessToken: "fixture-token" })
  expect(tokenRequests).toHaveLength(1)
  expect(tokenRequests[0].get("code_verifier")).toBeTruthy()
})
