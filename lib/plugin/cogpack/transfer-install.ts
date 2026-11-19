/**
 * Install the plugins a paired device carried to this host in a cogpack
 * (ADR-0224 §Moving an item is a handoff, ADR-0209).
 *
 * The device uploaded the archive in chunks through
 * `plugin_cogpack_upload_*`; Rust staged it and checked that the device
 * uploading it is the one asking for it to be installed. Here the host decides
 * whether to install it at all, exactly as it would for a cogpack a user opened
 * by hand:
 *
 *   * the manifest is validated, and its signature verified;
 *   * the trust it earns is resolved under THIS host's plugin policy and
 *     trusted-publisher ledger. The device cannot vouch for itself: a policy
 *     that refuses the signer refuses the transfer, and nothing here adds the
 *     signer to the ledger;
 *   * every member must be embedded. A transfer carries files, never a
 *     pointer this host would go and fetch.
 *
 * The staged install then runs in Rust, anchored on the SHA-256 of the
 * canonical manifest verified here: the archive's `manifest.json` must hash to
 * it and every file must match its record, so what installs is what the
 * signature covers. It runs as one package replacement (ADR-0258,
 * `lib/plugin/lifecycle/replace-package.ts`): members this host already has
 * are stopped before their packages change and come back in the state they
 * were in, new ones start, and a member whose intent is disabled here stays
 * stopped. Desktop and headless hosts run the same steps; the brain skips the
 * `plugin://runtime-changed` events the install publishes for them.
 *
 * Idempotent by operation id: the device retries a transfer whose answer it
 * lost, and the second call answers what the first one installed.
 */

import { z } from "zod"

import { sha256Bytes } from "@/lib/utils/hash"
import type { HostPackageChangeDeps } from "@/lib/plugin/lifecycle/host-package-change"
import { packageOwnerOf, replacePluginPackages } from "@/lib/plugin/lifecycle/replace-package"
import { verifyEd25519PackageSignature } from "@/lib/packaging/signed-zip"
import { canonicalJsonBytes } from "@/lib/plugin/character-pack/canonical-json"
import type { CogpackManifestV1, CogpackProvenance } from "@/types/plugin/plugin-cogset"

import { COGPACK_LABEL, cogpackSignaturePayload, validateCogpackManifest } from "./manifest"
import type { CogpackTrustResult } from "./trust"

export const transferInstallSchema = z
  .object({
    uploadId: z.string().uuid(),
    operationId: z.string().uuid(),
    manifest: z.record(z.string(), z.unknown()),
    sourceLabel: z.string().min(1).max(200).optional(),
  })
  .strict()

export interface TransferInstallMember {
  pluginId: string
  version: string
}

export interface TransferInstallResult {
  /** SHA-256 of the cogpack file. */
  fingerprint: string
  installed: TransferInstallMember[]
  failed: Array<{ pluginId: string; message: string }>
}

/** Thrown with a stable code prefix the sending device turns into a message. */
export class TransferRefusedError extends Error {
  constructor(
    readonly code:
      | "cogpack_refused"
      | "cogpack_member_not_embedded"
      | "cogpack_signature_invalid"
      | "cogpack_manifest_invalid",
    detail: string
  ) {
    super(`${code}: ${detail}`)
    this.name = "TransferRefusedError"
  }
}

export interface TransferInstallDeps {
  resolveTrust: (signature: CogpackManifestV1["signature"]) => Promise<CogpackTrustResult>
  installStaged: (request: {
    uploadId: string
    manifestSha256: string
    members: Array<{ id: string; version: string }>
  }) => Promise<TransferInstallResult>
  recordOrigin: (member: TransferInstallMember, viaCogpack: CogpackProvenance) => Promise<void>
  /** This host's plugin manager and registration, for the replacement around the install. */
  packages: Pick<HostPackageChangeDeps, "manager" | "register" | "expectRuntimeEvent">
}

/** Bounded memory of answered operations, for a device retrying a lost answer. */
const ANSWERED_LIMIT = 64
const answered = new Map<string, TransferInstallResult>()

function remember(operationId: string, result: TransferInstallResult): void {
  answered.set(operationId, result)
  while (answered.size > ANSWERED_LIMIT) {
    const oldest = answered.keys().next().value
    if (oldest === undefined) break
    answered.delete(oldest)
  }
}

/** @internal */
export function __resetAnsweredTransfersForTests(): void {
  answered.clear()
}

async function verifiedManifest(raw: unknown): Promise<CogpackManifestV1> {
  let manifest: CogpackManifestV1
  try {
    manifest = validateCogpackManifest(raw)
  } catch (error) {
    throw new TransferRefusedError(
      "cogpack_manifest_invalid",
      error instanceof Error ? error.message : String(error)
    )
  }
  if (manifest.signature) {
    try {
      await verifyEd25519PackageSignature(
        manifest.signature,
        cogpackSignaturePayload(manifest),
        COGPACK_LABEL
      )
    } catch (error) {
      throw new TransferRefusedError(
        "cogpack_signature_invalid",
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return manifest
}

async function defaultDeps(): Promise<TransferInstallDeps> {
  const [{ resolveCogpackTrust }, { recordInstallOrigin }, { hostPackageChangeDeps }] =
    await Promise.all([
      import("./trust"),
      import("@/lib/plugin/origin/install-origin"),
      import("@/lib/plugin/lifecycle/host-package-change"),
    ])
  const packages = await hostPackageChangeDeps()
  return {
    resolveTrust: (signature) => resolveCogpackTrust(signature),
    // As this host: the desktop's Tauri command, the brain's service transport.
    installStaged: (request) =>
      packages.native<TransferInstallResult>("plugin_cogpack_install_staged", { ...request }),
    recordOrigin: (member, viaCogpack) =>
      recordInstallOrigin({
        pluginId: member.pluginId,
        version: member.version,
        origin: { kind: "local", via: "cogpack-embedded" },
        viaCogpack,
      }),
    packages,
  }
}

function notEnabled(pluginId: string, error: unknown): { pluginId: string; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    pluginId,
    message: message.startsWith("plugin_not_discovered")
      ? message
      : `plugin_not_enabled: ${message}`,
  }
}

/** The `plugin_cogpack_transfer_install` arm. */
export async function installTransferredCogpack(
  raw: unknown,
  deps?: TransferInstallDeps
): Promise<TransferInstallResult> {
  const {
    adminLease: _lease,
    admin_lease: _leaseSnake,
    callerDeviceId: _caller,
    ...rest
  } = (raw ?? {}) as Record<string, unknown>
  const request = transferInstallSchema.parse(rest)
  const previous = answered.get(request.operationId)
  if (previous) return previous

  const manifest = await verifiedManifest(request.manifest)
  const notEmbedded = manifest.members.filter((member) => member.source.kind !== "embedded")
  if (notEmbedded.length > 0) {
    throw new TransferRefusedError(
      "cogpack_member_not_embedded",
      notEmbedded.map((member) => member.id).join(", ")
    )
  }

  const d = deps ?? (await defaultDeps())
  const trust = await d.resolveTrust(manifest.signature)
  if (trust.refusedBy) throw new TransferRefusedError("cogpack_refused", trust.refusedBy)

  const manifestSha256 = await sha256Bytes(canonicalJsonBytes(manifest))
  const memberIds = manifest.members.map((member) => member.id)
  const expected = new Map<string, () => void>()
  const replacement = await replacePluginPackages(packageOwnerOf(d.packages.manager), {
    pluginIds: memberIds,
    commit: async () => {
      for (const pluginId of memberIds) {
        const cancel = d.packages.expectRuntimeEvent?.(pluginId)
        if (cancel) expected.set(pluginId, cancel)
      }
      try {
        const installed = await d.installStaged({
          uploadId: request.uploadId,
          manifestSha256,
          members: manifest.members.map((member) => ({ id: member.id, version: member.version })),
        })
        // Only installed members publish an event.
        const landed = new Set(installed.installed.map((member) => member.pluginId))
        for (const [pluginId, cancel] of expected) if (!landed.has(pluginId)) cancel()
        return installed
      } catch (error) {
        for (const cancel of expected.values()) cancel()
        throw error
      }
    },
    replaced: (installed) => installed.installed.map((member) => member.pluginId),
    register: (pluginId) => d.packages.register(pluginId),
    // A plugin carried here for an item is meant to run; a disabled one stays off.
    whenNew: "enabled",
    reason: "transfer",
  })
  const result = replacement.result
  const viaCogpack: CogpackProvenance = {
    cogpackId: manifest.id,
    version: manifest.version,
    fingerprint: result.fingerprint,
  }
  for (const member of result.installed) await d.recordOrigin(member, viaCogpack)
  const inactive = replacement.failures.map((failure) =>
    notEnabled(failure.pluginId, failure.error)
  )
  const inactiveIds = new Set(inactive.map((entry) => entry.pluginId))
  const answer: TransferInstallResult = {
    fingerprint: result.fingerprint,
    installed: result.installed.filter((member) => !inactiveIds.has(member.pluginId)),
    failed: [...result.failed, ...inactive],
  }
  remember(request.operationId, answer)
  return answer
}
