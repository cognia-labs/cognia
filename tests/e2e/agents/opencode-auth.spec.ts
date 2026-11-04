/** Browser journey against a deterministic V2 HTTP boundary, not a live OAuth provider. */
import { test, expect, type Page } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings } from "../helpers/db-reset"

const AGENT_ID = "opencode-auth-e2e"

async function arrange(page: Page, mode: "auto" | "code" = "auto") {
  let signedIn = false
  let authorized = false
  let cancelled = 0
  const requests: string[] = []
  await page.route("http://opencode.test/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push(`${request.method()} ${path}`)
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers })
      return
    }
    const wrap = (data: unknown) => ({ location: { directory: "/workspace" }, data })
    let body: unknown = wrap([])
    if (path === "/api/info") body = { version: "2.0.23", pid: 1234, urls: [] }
    else if (path === "/api/session") body = { data: [], cursor: {} }
    else if (path === "/api/location") body = { directory: "/workspace" }
    else if (path === "/api/integration")
      body = wrap([
        {
          id: "opencode",
          name: "OpenCode",
          methods: [{ id: "device", type: "oauth", label: "Console account" }],
          connections: signedIn
            ? [
                {
                  type: "credential",
                  id: "upstream-account",
                  label: "OpenCode test account",
                  method: "oauth",
                },
              ]
            : [],
        },
      ])
    else if (path === "/api/integration/opencode/connect/oauth" && request.method() === "POST") {
      authorized = false
      expect(request.postDataJSON()).toMatchObject({ methodID: "device" })
      body = wrap({
        attemptID: "attempt",
        url: "https://opencode.ai/device",
        instructions: "Enter TEST-CODE",
        mode,
        time: { created: Date.now(), expires: Date.now() + 60_000 },
      })
    } else if (path.endsWith("/complete")) {
      expect(request.postDataJSON()).toMatchObject({ code: "TEST-CODE" })
      authorized = true
      await route.fulfill({ status: 204, headers })
      return
    } else if (path.endsWith("/oauth/attempt")) {
      if (request.method() === "DELETE") {
        cancelled++
        await route.fulfill({ status: 204, headers })
        return
      }
      signedIn = authorized
      body = wrap({
        status: signedIn ? "complete" : "pending",
        time: { created: Date.now(), expires: Date.now() + 60_000 },
      })
    }
    await route.fulfill({ json: body, headers })
  })
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
  await ensureCogniaAccount(page)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-11-03T00:00:00.000Z" },
  })
  await page.evaluate(
    ({ id }) => {
      const time = "2026-11-03T00:00:00.000Z"
      localStorage.setItem(
        "cognia-external-agents",
        JSON.stringify({
          version: 7,
          state: {
            agents: {
              [id]: {
                id,
                name: "OpenCode OAuth test",
                protocol: "opencode-v2",
                transport: "sse",
                enabled: true,
                network: { endpoint: "http://opencode.test" },
                defaultPermissionMode: "default",
                createdAt: time,
                updatedAt: time,
              },
            },
            activeAgentId: id,
            autoConnectOnStartup: false,
          },
        })
      )
    },
    { id: AGENT_ID }
  )
  await page.goto("about:blank")
  await page.goto("/settings?section=agents", { waitUntil: "domcontentloaded" })
  await page.getByTestId(`agent-row-${AGENT_ID}`).click()
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sign in with Console account" })).toBeVisible()
  return {
    authorize: () => {
      authorized = true
    },
    cancellations: () => cancelled,
    requests,
  }
}

test("V2 Agent device login discovers the service-owned account after refresh and reconnect @critical", async ({
  page,
}, testInfo) => {
  const service = await arrange(page)
  await page.getByRole("button", { name: "Sign in with Console account" }).click()
  const dialog = page.getByRole("dialog", { name: "Sign in to OpenCode" })
  await dialog.getByRole("button", { name: "Continue to authorization" }).click()
  await expect(dialog.getByRole("status")).toHaveText("Waiting for authorization…")
  await dialog.getByRole("button", { name: "Open authorization page" }).click()
  service.authorize()
  await expect(dialog.getByRole("status")).toContainText("Sign-in completed")
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(page.getByText("OpenCode test account", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Refresh sign-in status" }).click()
  await expect(page.getByText("OpenCode test account", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Disconnect", exact: true }).click()
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByText("OpenCode test account", { exact: true })).toBeVisible()
  expect(service.requests.some((request) => request.includes("/credential"))).toBe(false)
  await page.screenshot({
    path: testInfo.outputPath("opencode-account-connected.png"),
    animations: "disabled",
  })
})

test("V2 Agent submits code and cancels a dismissed attempt @critical", async ({ page }) => {
  const service = await arrange(page, "code")
  await page.getByRole("button", { name: "Sign in with Console account" }).click()
  await page.getByRole("button", { name: "Continue to authorization" }).click()
  await page.getByRole("textbox", { name: "Authorization code" }).fill("TEST-CODE")
  await page.getByRole("button", { name: "Submit code" }).click()
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Sign-in completed")
  await page.getByRole("button", { name: "Done" }).click()
  await page.getByRole("button", { name: "Sign in with Console account" }).click()
  await page.getByRole("button", { name: "Continue to authorization" }).click()
  await expect(page.getByRole("textbox", { name: "Authorization code" })).toBeVisible()
  await page.getByRole("button", { name: "Cancel sign-in" }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect.poll(service.cancellations).toBe(1)
})
