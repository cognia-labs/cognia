/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { HostResolution, ResolvedHost } from "../host/resolve"
import {
  hostAnswer,
  hostTargetLabel,
  LOCAL_ANSWER,
  localWhileHostSelected,
  selectProviderTarget,
} from "./target"

const HOST: ResolvedHost = {
  name: "home",
  nameSource: { value: "home", source: "user-file", origin: "active in ~/.cognia/hosts.json" },
  kind: { value: "device", source: "user-file" },
  endpoint: { value: "https://10.0.0.2:27890", source: "user-file" },
}

const BASE = { env: {}, home: "/h", cwd: "/w" }

function resolving(resolution: HostResolution) {
  return jest.fn(() => resolution)
}

describe("selectProviderTarget", () => {
  it("answers here with --local, without resolving a Host", () => {
    const resolve = resolving({ host: HOST, skipped: [] })
    expect(selectProviderTarget({ ...BASE, local: true, resolve })).toEqual({
      ok: true,
      target: { kind: "local", why: "flag" },
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("refuses --local together with a named Host or endpoint", () => {
    for (const named of [{ profile: "home" }, { endpoint: "https://x" }]) {
      const result = selectProviderTarget({ ...BASE, local: true, ...named })
      expect(result).toMatchObject({ ok: false, failure: { cause: "invalid-request" } })
    }
  })

  it("passes the flags to the resolver and targets the Host it finds", () => {
    const resolve = resolving({ host: HOST, skipped: [] })
    const result = selectProviderTarget({
      ...BASE,
      profile: "home",
      endpoint: "https://10.0.0.2:27890",
      tenantId: "org_1",
      resolve,
    })
    expect(resolve).toHaveBeenCalledWith({
      endpoint: "https://10.0.0.2:27890",
      profile: "home",
      tenantId: "org_1",
      env: {},
      home: "/h",
      cwd: "/w",
    })
    expect(result).toEqual({
      ok: true,
      target: { kind: "host", host: HOST, label: 'Host "home" (https://10.0.0.2:27890)' },
    })
  })

  it("answers here when no Host is selected anywhere", () => {
    const resolve = resolving({
      skipped: [
        { leg: "saved host", reason: "no active host is configured" },
        { leg: "environment", reason: "neither COGNIA_ENDPOINT nor COGNIA_SERVER_URL is set" },
      ],
    })
    expect(selectProviderTarget({ ...BASE, resolve })).toEqual({
      ok: true,
      target: { kind: "local", why: "nothing-selected" },
    })
  })

  it("reports a named Host that does not exist instead of answering here", () => {
    const resolve = resolving({
      skipped: [{ leg: "named host", reason: 'no host named "work" (known: home)' }],
    })
    const result = selectProviderTarget({ ...BASE, profile: "work", resolve })
    expect(result).toMatchObject({
      ok: false,
      failure: { error: 'no host named "work" (known: home)', cause: "invalid-request" },
    })
  })

  it("reports a tenant conflict", () => {
    const resolve = resolving({
      skipped: [],
      conflict: { error: "host home is a device paired into tenant org_a", fix: ["drop --tenant"] },
    })
    const result = selectProviderTarget({ ...BASE, tenantId: "org_b", resolve })
    expect(result).toMatchObject({
      ok: false,
      failure: { error: "host home is a device paired into tenant org_a", fix: ["drop --tenant"] },
    })
  })

  it("follows the active host in the user's hosts.json (host use)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "provider-target-"))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "provider-target-cwd-"))
    try {
      fs.writeFileSync(
        path.join(home, "hosts.json"),
        JSON.stringify({
          version: 1,
          active: "lab",
          hosts: { lab: { kind: "headless", endpoint: "http://127.0.0.1:8787" } },
        })
      )
      const result = selectProviderTarget({ env: {}, home, cwd })
      expect(result).toMatchObject({
        ok: true,
        target: { kind: "host", label: 'Host "lab" (http://127.0.0.1:8787)' },
      })
      // --local still wins over the saved selection.
      expect(selectProviderTarget({ env: {}, home, cwd, local: true })).toMatchObject({
        ok: true,
        target: { kind: "local" },
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("labels and notes", () => {
  it("names an unnamed endpoint by its URL", () => {
    expect(hostTargetLabel({ ...HOST, name: undefined })).toBe("Host at https://10.0.0.2:27890")
  })

  it("marks a Host answer as the Host's", () => {
    expect(hostAnswer({ kind: "host", host: HOST, label: "Host x" })).toEqual({
      plane: "host",
      label: "Host x",
    })
    expect(LOCAL_ANSWER.plane).toBe("local")
  })

  it("explains a local answer only when a Host is selected", () => {
    expect(
      localWhileHostSelected({ kind: "host", host: HOST, label: "Host x" }, "a Host keeps none")
    ).toBe("Host x is selected, but a Host keeps none, so this machine answered")
    expect(localWhileHostSelected({ kind: "local", why: "flag" }, "anything")).toBeUndefined()
  })
})
