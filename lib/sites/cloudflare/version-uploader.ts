import { isTauri } from "@/lib/tauri"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { assertApprovedSiteProviderTool } from "@/lib/sites/approved-tool"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

interface NativeSandboxResult {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
}

export interface CloudflareVersionUploadInput {
  wranglerBinaryPath: string
  /** As reported by detection (`wrangler 4.98.1`); gates the secret flags. */
  wranglerVersion?: string | null
  stagingRoot: string
  configPath: string
  entryPath: string
  assetsPath?: string
  workerName: string
  accountId: string
  apiToken: string
  tag: string
  message: string
  compatibilityDate: string
  compatibilityFlags: string[]
  /**
   * The environment revision's secret values, bound into this version.
   *
   * They used to be pushed at deploy time through `secrets-bulk`, which takes
   * the Worker's LATEST version, adds the secrets and deploys THAT. With a
   * freshly uploaded, undeployed version on top Cloudflare refuses (10215);
   * on a redeploy it moved traffic to a secret-change version and Cognia then
   * pointed traffic back at the old ID without the new values. A version that
   * carries its own secrets makes "deploy" a pure traffic switch.
   */
  secrets?: Record<string, string>
  /**
   * Keys the previous upload bound that this revision no longer has.
   * `--secrets-file` is additive (omitted keys are inherited from the latest
   * version), so they are dropped with a follow-up `versions secret bulk`,
   * which creates a further version carrying the same tag.
   */
  removedSecrets?: string[]
}

export interface CloudflareVersionUploadResult {
  exitCode: number
  stdout: string
  stderr: string
  durationSeconds: number
  timedOut: boolean
  /** From wrangler's `version-upload` output entry, when it wrote one. */
  versionId?: string
  /** The Worker's immutable ID (what a Worker-scoped Access app names). */
  workerTag?: string
  /** Present when `removedSecrets` was non-empty and the upload succeeded. */
  secretRemoval?: { exitCode: number; stderr: string; timedOut: boolean }
}

/** `--secrets-file` on `versions upload` (wrangler 4.74.0). */
const SECRETS_FILE_MIN = [4, 74, 0] as const
/** `null` deletes a key in a bulk secrets JSON (wrangler 4.97.0). */
const SECRET_DELETE_MIN = [4, 97, 0] as const

function parseVersion(value: string | null | undefined): [number, number, number] | null {
  const match = value?.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function atLeast(actual: [number, number, number], minimum: readonly [number, number, number]) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

function assertWranglerSupports(
  version: string | null | undefined,
  minimum: readonly [number, number, number],
  feature: string
): void {
  const parsed = parseVersion(version)
  const required = minimum.join(".")
  if (!parsed) {
    throw new Error(`Cannot confirm wrangler supports ${feature}; wrangler ${required}+ required`)
  }
  if (!atLeast(parsed, minimum)) {
    throw new Error(`${feature} requires wrangler ${required}+ (found ${parsed.join(".")})`)
  }
}

/**
 * The `version-upload` entry of wrangler's ND-JSON output file.
 *
 * The REST version list was the only source of the new version's ID, and it
 * does not document the tag annotation the lookup matched on. The output file
 * is wrangler's own machine-readable report of what it just created.
 */
export function parseWranglerVersionUpload(text: string): {
  versionId?: string
  workerTag?: string
} {
  let found: { versionId?: string; workerTag?: string } = {}
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== "object") continue
    const row = entry as { type?: unknown; version_id?: unknown; worker_tag?: unknown }
    if (row.type !== "version-upload") continue
    found = {
      ...(typeof row.version_id === "string" && row.version_id
        ? { versionId: row.version_id }
        : {}),
      ...(typeof row.worker_tag === "string" && row.worker_tag
        ? { workerTag: row.worker_tag }
        : {}),
    }
  }
  return found
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)
}

function parentPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  const index = normalized.lastIndexOf("/")
  return index <= 0 ? normalized.slice(0, Math.max(index, 1)) : normalized.slice(0, index)
}

function cleanOutput(value: string): string {
  const maxBytes = 1024 * 1024
  const bytes = new TextEncoder().encode(value)
  return bytes.byteLength <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes))
}

function childPath(parent: string, name: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`
}

async function readTextAssets(root: string): Promise<string[]> {
  const fs = await import("@tauri-apps/plugin-fs")
  const contents: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readDir(dir)) {
      const path = childPath(dir, entry.name)
      if (entry.isDirectory) {
        await visit(path)
        continue
      }
      if (!entry.isFile) continue
      const bytes = await fs.readFile(path)
      try {
        contents.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      } catch {
        // Binary assets are not model-readable text and cannot contain a recognized text PII shape.
      }
    }
  }
  await visit(root)
  return contents
}

async function assertUploadPayloadPiiSafe(input: CloudflareVersionUploadInput): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs")
  const textualPayload = {
    entry: await fs.readTextFile(input.entryPath),
    config: await fs.readTextFile(input.configPath),
    assets: input.assetsPath ? await readTextAssets(input.assetsPath) : [],
    workerName: input.workerName,
    accountId: input.accountId,
    tag: input.tag,
    message: input.message,
    compatibilityFlags: input.compatibilityFlags,
  }
  if (!hasNoLeakingPiiDeep(textualPayload)) {
    throw new Error("Cloudflare upload payload failed the outbound PII gate")
  }
}

/**
 * Upload a pre-built Worker as a saved Cloudflare Version without deploying.
 *
 * This is intentionally separate from untrusted build execution. The provider
 * token is available only to a direct, absolute Wrangler binary running in the
 * existing fail-closed sandbox, against a Cognia-generated JSON config, with
 * egress restricted to Cloudflare's API.
 */
export async function uploadCloudflareWorkerVersion(
  input: CloudflareVersionUploadInput
): Promise<CloudflareVersionUploadResult> {
  if (!isTauri()) throw new Error("Cloudflare version upload requires the local Tauri host")
  for (const [label, path] of [
    ["Wrangler binary", input.wranglerBinaryPath],
    ["staging root", input.stagingRoot],
    ["config", input.configPath],
    ["entry", input.entryPath],
    ...(input.assetsPath ? [["assets", input.assetsPath] as const] : []),
  ] as const) {
    if (!isAbsolutePath(path)) throw new Error(`${label} path must be absolute`)
  }
  if (!isPathUnderRoot(input.configPath, input.stagingRoot)) {
    throw new Error("Cloudflare Wrangler config must stay inside the Sites staging root")
  }
  if (!input.apiToken.trim()) throw new Error("Cloudflare API token is required")
  await assertApprovedSiteProviderTool(input.wranglerBinaryPath)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.tag)) {
    throw new Error("Cloudflare version tag is invalid")
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.compatibilityDate)) {
    throw new Error("Cloudflare compatibility date must use YYYY-MM-DD")
  }
  const secrets = input.secrets ?? {}
  const removedSecrets = [...new Set(input.removedSecrets ?? [])].filter(
    (key) => !Object.hasOwn(secrets, key)
  )
  for (const key of [...Object.keys(secrets), ...removedSecrets]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Cloudflare secret name is invalid")
  }
  if (Object.keys(secrets).length > 0) {
    assertWranglerSupports(input.wranglerVersion, SECRETS_FILE_MIN, "binding secrets to a version")
  }
  if (removedSecrets.length > 0) {
    assertWranglerSupports(input.wranglerVersion, SECRET_DELETE_MIN, "removing a secret")
  }
  // Control files live in their own directory, and that directory must not be
  // anywhere wrangler uploads as public assets: a secrets file under the assets
  // root would be served to every visitor.
  const controlDir = childPath(input.stagingRoot, ".cognia-upload")
  if (
    input.assetsPath &&
    (isPathUnderRoot(controlDir, input.assetsPath) || isPathUnderRoot(input.assetsPath, controlDir))
  ) {
    throw new Error("Cloudflare upload assets cannot contain the Sites control directory")
  }
  await assertUploadPayloadPiiSafe(input)

  const fs = await import("@tauri-apps/plugin-fs")
  await fs.mkdir(controlDir, { recursive: true })
  const outputPath = childPath(controlDir, "wrangler-output.ndjson")
  const secretsPath = childPath(controlDir, "secrets.json")
  const removalPath = childPath(controlDir, "secret-removals.json")
  if (await fs.exists(outputPath)) await fs.remove(outputPath)

  const argv = [
    input.wranglerBinaryPath,
    "versions",
    "upload",
    input.entryPath,
    "--config",
    input.configPath,
    "--name",
    input.workerName,
    "--no-bundle",
    "--tag",
    input.tag,
    "--message",
    input.message,
    "--compatibility-date",
    input.compatibilityDate,
  ]
  for (const flag of input.compatibilityFlags) {
    argv.push("--compatibility-flag", flag)
  }
  if (input.assetsPath) argv.push("--assets", input.assetsPath)
  if (Object.keys(secrets).length > 0) argv.push("--secrets-file", secretsPath)

  const readable = [
    parentPath(input.wranglerBinaryPath),
    parentPath(input.entryPath),
    ...(input.assetsPath ? [input.assetsPath] : []),
  ]
  const env = {
    CLOUDFLARE_API_TOKEN: input.apiToken,
    CLOUDFLARE_ACCOUNT_ID: input.accountId,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_OUTPUT_FILE_PATH: outputPath,
  }
  const run = async (command: string[]): Promise<NativeSandboxResult> => {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<NativeSandboxResult>("sandbox_exec", {
      tool: "sandbox_bash",
      command: { argv: command, cwd: input.stagingRoot, env, stdin: null, timeout: 300 },
      request: {
        writable: [input.stagingRoot],
        readable,
        targetFiles: [],
        maxCpuSeconds: 300,
        maxMemoryMb: 2048,
        network: "allowlist",
        networkHosts: ["api.cloudflare.com"],
      },
    })
  }

  try {
    if (Object.keys(secrets).length > 0) {
      await fs.writeTextFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 })
    }
    const result = await run(argv)
    const reported = (await fs.exists(outputPath))
      ? parseWranglerVersionUpload(await fs.readTextFile(outputPath))
      : {}
    const upload: CloudflareVersionUploadResult = {
      exitCode: result.exit_code,
      stdout: cleanOutput(result.stdout),
      stderr: cleanOutput(result.stderr),
      durationSeconds: result.duration,
      timedOut: result.timed_out,
      ...reported,
    }
    if (removedSecrets.length === 0 || result.exit_code !== 0 || result.timed_out) return upload

    await fs.writeTextFile(
      removalPath,
      JSON.stringify(Object.fromEntries(removedSecrets.map((key) => [key, null]))),
      { mode: 0o600 }
    )
    const removal = await run([
      input.wranglerBinaryPath,
      "versions",
      "secret",
      "bulk",
      removalPath,
      "--config",
      input.configPath,
      "--name",
      input.workerName,
      "--tag",
      input.tag,
      "--message",
      input.message,
    ])
    return {
      ...upload,
      secretRemoval: {
        exitCode: removal.exit_code,
        stderr: cleanOutput(removal.stderr),
        timedOut: removal.timed_out,
      },
    }
  } finally {
    for (const path of [secretsPath, removalPath]) {
      if (await fs.exists(path)) await fs.remove(path)
    }
  }
}
