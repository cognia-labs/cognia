// Schema-version boundary for backup imports. Accepts:
//   • EncryptedEnvelopeV1   → throws IsEncryptedError so the caller can prompt
//   • v3 BackupPackage      → recomputes & validates the integrity checksum
//   • anything else         → throws UnsupportedSchemaVersionError
//
// The function intentionally accepts `unknown` so it can be called on raw
// `JSON.parse` output without first trusting the file.

import { sha256Hex } from "./crypto"
import {
  EXPORT_SCHEMA_VERSION,
  IntegrityCheckFailedError,
  IsEncryptedError,
  UnsupportedSchemaVersionError,
  type BackupPackageV3,
  type EncryptedEnvelopeV1,
} from "./types"

/** Cheap structural sniff for a `BackupPackageV3`. */
function isBackupPackageV3(input: unknown): input is BackupPackageV3 {
  if (!input || typeof input !== "object") return false
  const obj = input as { version?: unknown; manifest?: unknown; payload?: unknown }
  if (obj.version !== "3.0") return false
  if (!obj.manifest || typeof obj.manifest !== "object") return false
  if (!obj.payload || typeof obj.payload !== "object") return false
  const manifest = obj.manifest as { schemaVersion?: unknown; version?: unknown }
  return manifest.version === "3.0" && manifest.schemaVersion === EXPORT_SCHEMA_VERSION
}

/** Cheap structural sniff for an `EncryptedEnvelopeV1`. */
export function isEncryptedEnvelope(input: unknown): input is EncryptedEnvelopeV1 {
  if (!input || typeof input !== "object") return false
  const obj = input as { version?: unknown; ciphertext?: unknown; kdf?: unknown }
  return (
    obj.version === "enc-v1" &&
    typeof obj.ciphertext === "string" &&
    !!obj.kdf &&
    typeof obj.kdf === "object"
  )
}

/**
 * Stable JSON serialization for checksum computation. Keys are sorted
 * recursively so two payloads with the same content but different key
 * insertion order produce the same hash. The serialized form is what we
 * hash and what we sign on disk; the on-the-wire JSON file uses the same
 * canonical form so importers don't need to reorder keys before verifying.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key])
        return acc
      }, {})
  }
  return value
}

/**
 * Accept the raw `JSON.parse` of an import file as a `BackupPackageV3`,
 * validating the integrity checksum if present.
 */
export async function migrateEnvelope(input: unknown): Promise<BackupPackageV3> {
  if (isEncryptedEnvelope(input)) {
    throw new IsEncryptedError(input)
  }

  if (isBackupPackageV3(input)) {
    const pkg = input
    const expected = pkg.manifest.integrity.checksum
    const actual = await sha256Hex(canonicalStringify(pkg.payload))
    if (expected && actual !== expected) {
      throw new IntegrityCheckFailedError(expected, actual)
    }
    return pkg
  }

  throw new UnsupportedSchemaVersionError(input)
}

export const __TESTING__ = { sortKeys, isBackupPackageV3 }
