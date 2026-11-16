/**
 * Host Skills commands: native skill sync and scanning, the marketplace
 * registry, transactional bundle installs, trash and the security scanner.
 * Every call goes through the active transport, so a paired client reaches
 * its Host's skills directories.
 */
import { transport } from "@/lib/tauri"

export interface DiscoveredSkillFile {
  dirName: string
  filePath: string
  content: string
}

export async function scanClaudeSkills(): Promise<DiscoveredSkillFile[]> {
  const raw =
    await transport.call<Array<{ dir_name: string; file_path: string; content: string }>>(
      "scan_claude_skills"
    )
  return raw.map((r) => ({
    dirName: r.dir_name,
    filePath: r.file_path,
    content: r.content,
  }))
}

export interface NativeSkillResource {
  kind: "script" | "reference" | "asset"
  path: string
  name: string
  content: string
  encoding: "utf-8" | "base64"
  mimeType?: string
  size: number
}

export interface NativeSkill {
  dirName: string
  filePath: string
  content: string
  resources: NativeSkillResource[]
  /**
   * SKILL.md mtime in milliseconds since epoch. Zero when filesystem
   * metadata couldn't be read (handled as "unknown" by sync — pull
   * conservatively).
   */
  mtimeMs: number
}

export interface RegistrySkillEntry {
  id: string
  source: string
  sourceType: string
  skillPath?: string
  computedHash?: string
  displayName?: string
  description?: string
  category?: string
  tags?: string[]
  author?: string
  iconUrl?: string
  rawSkillUrl?: string
}

export interface InstallSkillRequest {
  dirName: string
  content: string
  resources: NativeSkillResource[]
  clean: boolean
}

export interface InstallSkillResponse {
  directory: string
  writtenFiles: string[]
}

export type SkillsTarget = "cognia" | "claude" | "codex"

/**
 * Bundle-import-aware install request. Wraps the legacy single-target
 * payload with a `targets` list (cognia + claude + codex toggleable) and
 * a `trashBeforeClean` flag that moves the prior cognia copy into
 * `<appData>/cognia/skills/.trash/` before overwriting.
 */
export interface InstallSkillMirroredRequest extends InstallSkillRequest {
  targets: SkillsTarget[]
  trashBeforeClean: boolean
}

export interface MirrorTargetOutcome {
  target: SkillsTarget
  directory: string
  writtenFiles: string[]
  /** Set when a target was requested but degraded (e.g. no home dir). */
  note?: string | null
}

export interface InstallSkillMirroredResponse {
  targets: MirrorTargetOutcome[]
  /** Path of the trashed prior cognia copy, when applicable. */
  trashedFrom?: string | null
}

export interface HostSkillsCatalog {
  cognia: NativeSkill[]
  claude: NativeSkill[]
  codex: NativeSkill[]
}

export interface SkillBundleUploadHandle {
  handleId: string
  chunkBytes: number
}

export interface SkillScanIssue {
  severity: "low" | "medium" | "high"
  kind: string
  message: string
  line?: number
}

export async function skillsScanNative(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_native")
}

export async function skillsCatalogGet(): Promise<HostSkillsCatalog> {
  return transport.call<HostSkillsCatalog>("skills_catalog_get")
}

export async function skillsBundleUploadOpen(
  expectedSize: number,
  expectedHash: string
): Promise<SkillBundleUploadHandle> {
  return transport.call<SkillBundleUploadHandle>("skills_bundle_upload_open", {
    request: { expectedSize, expectedHash },
  })
}

export async function skillsBundleUploadWrite(args: {
  handleId: string
  offset: number
  dataBase64: string
  chunkHash: string
}): Promise<number> {
  return transport.call<number>("skills_bundle_upload_write", args)
}

export async function skillsBundleUploadCommit(handleId: string): Promise<void> {
  return transport.call<void>("skills_bundle_upload_commit", { handleId })
}

export async function skillsBundleUploadAbort(handleId: string): Promise<void> {
  return transport.call<void>("skills_bundle_upload_abort", { handleId })
}

export async function skillsInstallAtomic(
  handleId: string,
  adminLease: string
): Promise<InstallSkillMirroredResponse> {
  return transport.call<InstallSkillMirroredResponse>("skills_install_atomic", {
    handleId,
    adminLease,
  })
}

export async function skillsUninstall(
  target: SkillsTarget,
  dirName: string,
  adminLease: string
): Promise<{ removed: boolean; directory: string }> {
  return transport.call<{ removed: boolean; directory: string }>("skills_uninstall", {
    target,
    dirName,
    adminLease,
  })
}

export async function skillsScanDir(path: string): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_dir", { path })
}

export async function skillsScanCodex(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_codex")
}

/** Scan OpenCode's environment-aware global `skills/` directory. */
export async function skillsScanOpencode(): Promise<NativeSkill[]> {
  const [{ resolveVendorRoots }, { joinPath }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/agents/instructions/paths"),
  ])
  const { opencodeConfigDir } = await resolveVendorRoots()
  if (!opencodeConfigDir) return []
  return skillsScanDir(joinPath(opencodeConfigDir, "skills"))
}

/** Scan Cursor's global `~/.cursor/skills` directory. */
export async function skillsScanCursor(): Promise<NativeSkill[]> {
  const [{ resolveVendorRoots }, { joinPath }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/agents/instructions/paths"),
  ])
  const { cursorDir } = await resolveVendorRoots()
  if (!cursorDir) return []
  return skillsScanDir(joinPath(cursorDir, "skills"))
}

export async function skillsMoveToTrash(dirName: string): Promise<string> {
  return transport.call<string>("skills_move_to_trash", { dirName })
}

export async function skillsListTrash(): Promise<string[]> {
  return transport.call<string[]>("skills_list_trash")
}

export async function skillsEmptyTrash(): Promise<number> {
  return transport.call<number>("skills_empty_trash")
}

export async function skillsInstallNative(
  request: InstallSkillRequest
): Promise<InstallSkillResponse> {
  return transport.call<InstallSkillResponse>("skills_install_native", { request })
}

export async function skillsInstallMirrored(
  request: InstallSkillMirroredRequest
): Promise<InstallSkillMirroredResponse> {
  return transport.call<InstallSkillMirroredResponse>("skills_install_mirrored", { request })
}

export async function skillsUninstallNative(
  dirName: string
): Promise<{ removed: boolean; directory: string }> {
  return transport.call<{ removed: boolean; directory: string }>("skills_uninstall_native", {
    dirName,
  })
}

export async function skillsFetchRemoteMd(url: string): Promise<string> {
  return transport.call<string>("skills_fetch_remote_md", { url })
}

/** Response of the Rust JSON GET proxy. Non-2xx statuses are returned (not thrown). */
export interface SkillsRemoteGetResponse {
  status: number
  body: string
  retryAfter?: string | null
}

export async function skillsFetchRemoteJson(req: {
  url: string
  bearerToken?: string
  accept?: string
}): Promise<SkillsRemoteGetResponse> {
  return transport.call<SkillsRemoteGetResponse>("skills_fetch_remote_json", { req })
}

export async function skillsLoadRegistry(): Promise<RegistrySkillEntry[]> {
  return transport.call<RegistrySkillEntry[]>("skills_load_registry")
}

export async function skillsScanSecurity(content: string): Promise<SkillScanIssue[]> {
  return transport.call<SkillScanIssue[]>("skills_scan_security", { content })
}

export async function skillsScanResources(
  resources: Array<[string, string]>
): Promise<SkillScanIssue[]> {
  return transport.call<SkillScanIssue[]>("skills_scan_resources", { resources })
}
