jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import {
  probeSiteEntries,
  probeSiteEntry,
  routeProbeUrl,
  summarizeSiteEntries,
} from "./entry-probe"

function answer(status: number, location?: string) {
  return jest.fn(async () => ({
    status,
    headers: new Headers(location ? { location } : {}),
  }))
}

describe("probeSiteEntry", () => {
  it("asks with no credentials and without following redirects", async () => {
    const fetcher = answer(403)
    await probeSiteEntry("https://docs.example.com/", fetcher)
    expect(fetcher).toHaveBeenCalledWith("https://docs.example.com/", {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      timeout: 10_000,
    })
  })

  it.each([401, 403])("counts a %s from Access as protected", async (status) => {
    await expect(probeSiteEntry("https://a.example.com/", answer(status))).resolves.toEqual({
      url: "https://a.example.com/",
      outcome: "protected",
      status,
    })
  })

  it("counts a redirect to the team's Access login as protected", async () => {
    const fetcher = answer(302, "https://acme.cloudflareaccess.com/cdn-cgi/access/login/x")
    await expect(probeSiteEntry("https://a.example.com/", fetcher)).resolves.toMatchObject({
      outcome: "protected",
      status: 302,
    })
  })

  it("counts a redirect anywhere else as exposed — the Worker answered", async () => {
    for (const location of [
      "https://a.example.com/login",
      "http://acme.cloudflareaccess.com/",
      "https://cloudflareaccess.com.evil.example/",
      "/relative",
    ]) {
      await expect(
        probeSiteEntry("https://a.example.com/", answer(302, location))
      ).resolves.toMatchObject({ outcome: "exposed" })
    }
    await expect(probeSiteEntry("https://a.example.com/", answer(301))).resolves.toMatchObject({
      outcome: "exposed",
    })
  })

  it.each([200, 404, 500])("counts a %s as exposed", async (status) => {
    await expect(probeSiteEntry("https://a.example.com/", answer(status))).resolves.toMatchObject({
      outcome: "exposed",
      status,
    })
  })

  it("never calls an entry protected when no answer came back", async () => {
    const failing = jest.fn(async () => {
      throw new Error("dns")
    })
    await expect(probeSiteEntry("https://a.example.com/", failing)).resolves.toEqual({
      url: "https://a.example.com/",
      outcome: "unverified",
    })
    // An opaque manual redirect in a browser surfaces as status 0.
    await expect(probeSiteEntry("https://a.example.com/", answer(0))).resolves.toMatchObject({
      outcome: "unverified",
    })
  })
})

describe("summarizeSiteEntries", () => {
  it("reports the worst entry", () => {
    expect(
      summarizeSiteEntries(
        [
          { url: "a", outcome: "protected" },
          { url: "b", outcome: "unverified" },
        ],
        1
      ).state
    ).toBe("unverified")
    expect(
      summarizeSiteEntries(
        [
          { url: "a", outcome: "unverified" },
          { url: "b", outcome: "exposed" },
          { url: "c", outcome: "protected" },
        ],
        1
      ).state
    ).toBe("exposed")
  })

  it("is unverified, not protected, when there was nothing to ask", () => {
    expect(summarizeSiteEntries([], 7)).toEqual({ checkedAt: 7, state: "unverified", entries: [] })
  })
})

describe("routeProbeUrl", () => {
  it("probes a route at the start of its path glob", () => {
    expect(routeProbeUrl("docs.example.com/api/*")).toBe("https://docs.example.com/api/")
    expect(routeProbeUrl("docs.example.com/*")).toBe("https://docs.example.com/")
    expect(routeProbeUrl("docs.example.com")).toBe("https://docs.example.com/")
  })

  it("has no single URL for a wildcard host", () => {
    expect(routeProbeUrl("*.example.com/*")).toBeUndefined()
  })
})

describe("probeSiteEntries", () => {
  it("asks every URL and keeps the patterns it could not ask as unverified", async () => {
    const fetcher = jest.fn(async (url: string) => ({
      status: url.includes("open") ? 200 : 403,
      headers: new Headers(),
    }))
    const result = await probeSiteEntries(
      {
        urls: ["https://docs.example.com/", "https://open.example.com/"],
        unprobeable: ["*.example.com/*"],
        now: 42,
      },
      fetcher
    )
    expect(result).toEqual({
      checkedAt: 42,
      state: "exposed",
      entries: [
        { url: "https://docs.example.com/", outcome: "protected", status: 403 },
        { url: "https://open.example.com/", outcome: "exposed", status: 200 },
        { url: "*.example.com/*", outcome: "unverified" },
      ],
    })
  })
})
