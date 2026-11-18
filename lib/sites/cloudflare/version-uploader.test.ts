/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
const readTextFileMock = jest.fn<Promise<string>, [string]>(
  async (_path) => "export default { fetch() { return new Response('ok') } }"
)
const readDirMock = jest.fn<Promise<never[]>, [string]>(async (_path) => [])
const readFileMock = jest.fn<Promise<Uint8Array>, [string]>(async (_path) => new Uint8Array())
// The control directory's files, by path: what the uploader writes, wrangler's
// output file, and what is left behind afterwards.
const written = new Map<string, { contents: string; mode?: number }>()
const mkdirMock = jest.fn(async (_path: string, _options?: unknown) => undefined)
jest.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: (path: string) =>
    written.has(path) ? Promise.resolve(written.get(path)!.contents) : readTextFileMock(path),
  readDir: (path: string) => readDirMock(path),
  readFile: (path: string) => readFileMock(path),
  mkdir: (path: string, options?: unknown) => mkdirMock(path, options),
  exists: async (path: string) => written.has(path),
  remove: async (path: string) => {
    written.delete(path)
  },
  writeTextFile: async (path: string, contents: string, options?: { mode?: number }) => {
    written.set(path, { contents, mode: options?.mode })
  },
}))
const assertApprovedToolMock = jest.fn(async (_path: string) => undefined)
jest.mock("@/lib/sites/approved-tool", () => ({
  assertApprovedSiteProviderTool: (path: string) => assertApprovedToolMock(path),
}))

import { invoke } from "@tauri-apps/api/core"
import {
  parseWranglerVersionUpload,
  uploadCloudflareWorkerVersion,
  type CloudflareVersionUploadInput,
} from "./version-uploader"

const mockInvoke = invoke as jest.Mock

const CONTROL = "/Users/me/Library/Caches/cognia/sites/site_1/.cognia-upload"

function sandboxResult(partial: Partial<Record<string, unknown>> = {}) {
  return { exit_code: 0, stdout: "", stderr: "", duration: 1, timed_out: false, ...partial }
}

function uploadInput(overrides: Partial<CloudflareVersionUploadInput> = {}) {
  return {
    wranglerBinaryPath: "/Applications/Cognia Tools/wrangler",
    wranglerVersion: "wrangler 4.98.1",
    stagingRoot: "/Users/me/Library/Caches/cognia/sites/site_1",
    configPath: "/Users/me/Library/Caches/cognia/sites/site_1/wrangler.json",
    entryPath: "/workspace/dist/server/index.js",
    assetsPath: "/workspace/dist/client",
    workerName: "docs-worker",
    accountId: "account_1",
    apiToken: "provider-secret",
    tag: "cognia-version-4",
    message: "Cognia Site version 4",
    compatibilityDate: "2026-07-18",
    compatibilityFlags: [],
    ...overrides,
  }
}

beforeEach(() => {
  written.clear()
  mkdirMock.mockClear()
  mockInvoke.mockReset()
  assertApprovedToolMock.mockClear()
  readTextFileMock
    .mockReset()
    .mockResolvedValue("export default { fetch() { return new Response('ok') } }")
  readDirMock.mockReset().mockResolvedValue([])
  readFileMock.mockReset().mockResolvedValue(new Uint8Array())
})

it("uploads an already-built Worker version through a confined, provider-only Wrangler process", async () => {
  mockInvoke.mockResolvedValue({
    exit_code: 0,
    stdout: "Uploaded docs-worker",
    stderr: "",
    duration: 2,
    timed_out: false,
  })

  const result = await uploadCloudflareWorkerVersion({
    wranglerBinaryPath: "/Applications/Cognia Tools/wrangler",
    stagingRoot: "/Users/me/Library/Caches/cognia/sites/site_1",
    configPath: "/Users/me/Library/Caches/cognia/sites/site_1/wrangler.json",
    entryPath: "/workspace/dist/server/index.js",
    assetsPath: "/workspace/dist/client",
    workerName: "docs-worker",
    accountId: "account_1",
    apiToken: "provider-secret",
    tag: "cognia-version-4",
    message: "Cognia Site version 4",
    compatibilityDate: "2026-07-18",
    compatibilityFlags: ["nodejs_compat"],
  })

  expect(result.exitCode).toBe(0)
  expect(assertApprovedToolMock).toHaveBeenCalledWith("/Applications/Cognia Tools/wrangler")
  const payload = mockInvoke.mock.calls[0][1]
  expect(payload.command.argv).toEqual([
    "/Applications/Cognia Tools/wrangler",
    "versions",
    "upload",
    "/workspace/dist/server/index.js",
    "--config",
    "/Users/me/Library/Caches/cognia/sites/site_1/wrangler.json",
    "--name",
    "docs-worker",
    "--no-bundle",
    "--tag",
    "cognia-version-4",
    "--message",
    "Cognia Site version 4",
    "--compatibility-date",
    "2026-07-18",
    "--compatibility-flag",
    "nodejs_compat",
    "--assets",
    "/workspace/dist/client",
  ])
  expect(payload.command.argv.join(" ")).not.toContain("provider-secret")
  expect(payload.command.env).toMatchObject({
    CLOUDFLARE_API_TOKEN: "provider-secret",
    CLOUDFLARE_ACCOUNT_ID: "account_1",
    WRANGLER_SEND_METRICS: "false",
  })
  expect(payload.request).toMatchObject({
    writable: ["/Users/me/Library/Caches/cognia/sites/site_1"],
    network: "allowlist",
    networkHosts: ["api.cloudflare.com"],
    maxCpuSeconds: 300,
    maxMemoryMb: 2048,
  })
  expect(payload.command.env.WRANGLER_OUTPUT_FILE_PATH).toBe(`${CONTROL}/wrangler-output.ndjson`)
  expect(mkdirMock).toHaveBeenCalledWith(CONTROL, { recursive: true })
})

describe("version ID from wrangler's own report (F01)", () => {
  it("returns the version and Worker IDs wrangler wrote to its output file", async () => {
    mockInvoke.mockImplementation(async (_command, args) => {
      written.set(args.command.env.WRANGLER_OUTPUT_FILE_PATH, {
        contents: [
          JSON.stringify({ type: "wrangler-session", version: 1 }),
          JSON.stringify({
            type: "version-upload",
            version_id: "ver_new",
            worker_tag: "0123456789abcdef0123456789abcdef",
          }),
        ].join("\n"),
      })
      return sandboxResult()
    })
    await expect(uploadCloudflareWorkerVersion(uploadInput())).resolves.toMatchObject({
      exitCode: 0,
      versionId: "ver_new",
      workerTag: "0123456789abcdef0123456789abcdef",
    })
  })

  it("clears a stale output file before the run so an old ID is never reported", async () => {
    written.set(`${CONTROL}/wrangler-output.ndjson`, {
      contents: JSON.stringify({ type: "version-upload", version_id: "ver_stale" }),
    })
    mockInvoke.mockResolvedValue(sandboxResult({ exit_code: 1, stderr: "boom" }))
    const result = await uploadCloudflareWorkerVersion(uploadInput())
    expect(result.versionId).toBeUndefined()
  })

  it("parses only version-upload entries and ignores malformed lines", () => {
    expect(
      parseWranglerVersionUpload(
        [
          "not json",
          JSON.stringify({ type: "deploy", version_id: "x" }),
          JSON.stringify({ type: "version-upload", version_id: "v1" }),
        ].join("\n")
      )
    ).toEqual({ versionId: "v1" })
    expect(parseWranglerVersionUpload("")).toEqual({})
  })
})

describe("secrets bound into the version (F10)", () => {
  it("passes them as a 0600 secrets file and deletes the file afterwards", async () => {
    let fileDuringRun: { contents: string; mode?: number } | undefined
    mockInvoke.mockImplementation(async () => {
      fileDuringRun = written.get(`${CONTROL}/secrets.json`)
      return sandboxResult()
    })
    await uploadCloudflareWorkerVersion(uploadInput({ secrets: { API_KEY: "s3cret" } }))

    const argv: string[] = mockInvoke.mock.calls[0][1].command.argv
    expect(argv.slice(-2)).toEqual(["--secrets-file", `${CONTROL}/secrets.json`])
    expect(argv.join(" ")).not.toContain("s3cret")
    expect(fileDuringRun).toEqual({ contents: JSON.stringify({ API_KEY: "s3cret" }), mode: 0o600 })
    expect(written.has(`${CONTROL}/secrets.json`)).toBe(false)
  })

  it("deletes the secrets file even when the sandbox call throws", async () => {
    mockInvoke.mockRejectedValue(new Error("ipc down"))
    await expect(
      uploadCloudflareWorkerVersion(uploadInput({ secrets: { API_KEY: "s3cret" } }))
    ).rejects.toThrow("ipc down")
    expect(written.has(`${CONTROL}/secrets.json`)).toBe(false)
  })

  it("refuses a wrangler too old to bind secrets to a version", async () => {
    await expect(
      uploadCloudflareWorkerVersion(
        uploadInput({ wranglerVersion: "wrangler 4.60.0", secrets: { API_KEY: "x" } })
      )
    ).rejects.toThrow("requires wrangler 4.74.0+")
    await expect(
      uploadCloudflareWorkerVersion(
        uploadInput({ wranglerVersion: null, secrets: { API_KEY: "x" } })
      )
    ).rejects.toThrow("Cannot confirm")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("drops removed keys with a tagged follow-up secret bulk of nulls", async () => {
    let removal: string | undefined
    mockInvoke.mockImplementation(async (_command, args) => {
      if (args.command.argv.includes("bulk")) {
        removal = written.get(`${CONTROL}/secret-removals.json`)?.contents
      }
      return sandboxResult()
    })
    const result = await uploadCloudflareWorkerVersion(
      uploadInput({ secrets: { KEEP: "v" }, removedSecrets: ["GONE", "KEEP"] })
    )
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(mockInvoke.mock.calls[1][1].command.argv).toEqual([
      "/Applications/Cognia Tools/wrangler",
      "versions",
      "secret",
      "bulk",
      `${CONTROL}/secret-removals.json`,
      "--config",
      "/Users/me/Library/Caches/cognia/sites/site_1/wrangler.json",
      "--name",
      "docs-worker",
      "--tag",
      "cognia-version-4",
      "--message",
      "Cognia Site version 4",
    ])
    // A key the revision still binds is never removed.
    expect(removal).toBe(JSON.stringify({ GONE: null }))
    expect(result.secretRemoval).toEqual({ exitCode: 0, stderr: "", timedOut: false })
    expect(written.has(`${CONTROL}/secret-removals.json`)).toBe(false)
  })

  it("does not run the removal after a failed upload", async () => {
    mockInvoke.mockResolvedValue(sandboxResult({ exit_code: 1 }))
    const result = await uploadCloudflareWorkerVersion(uploadInput({ removedSecrets: ["GONE"] }))
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(result.secretRemoval).toBeUndefined()
  })

  it("refuses removal on a wrangler without null deletes", async () => {
    await expect(
      uploadCloudflareWorkerVersion(
        uploadInput({ wranglerVersion: "4.80.0", removedSecrets: ["GONE"] })
      )
    ).rejects.toThrow("requires wrangler 4.97.0+")
  })

  it("never lets the control directory sit inside the uploaded assets", async () => {
    await expect(
      uploadCloudflareWorkerVersion(
        uploadInput({ assetsPath: "/Users/me/Library/Caches/cognia/sites/site_1" })
      )
    ).rejects.toThrow("cannot contain the Sites control directory")
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

it("rejects a non-absolute Wrangler path and invalid tags before spawning", async () => {
  await expect(
    uploadCloudflareWorkerVersion({
      wranglerBinaryPath: "wrangler",
      stagingRoot: "/tmp/site",
      configPath: "/tmp/site/wrangler.json",
      entryPath: "/workspace/index.js",
      workerName: "docs",
      accountId: "account_1",
      apiToken: "token",
      tag: "bad tag",
      message: "message",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: [],
    })
  ).rejects.toThrow("absolute")
  expect(mockInvoke).not.toHaveBeenCalled()
})

it("fails closed before spawning when textual upload content contains PII", async () => {
  readTextFileMock.mockResolvedValueOnce("export const owner = 'alice@example.com'")

  await expect(
    uploadCloudflareWorkerVersion({
      wranglerBinaryPath: "/Applications/Cognia Tools/wrangler",
      stagingRoot: "/tmp/site",
      configPath: "/tmp/site/wrangler.json",
      entryPath: "/tmp/site/index.js",
      workerName: "docs",
      accountId: "account_1",
      apiToken: "provider-secret",
      tag: "safe-tag",
      message: "message",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: [],
    })
  ).rejects.toThrow("outbound PII gate")
  expect(mockInvoke).not.toHaveBeenCalled()
})
