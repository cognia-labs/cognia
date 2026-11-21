/**
 * Single-use cryptographic bind codes for verifying an IM sender as the Host
 * owner (`F8`).
 *
 * Security invariants:
 *  - Plaintext code is returned once at issuance and never persisted; only its
 *    SHA-256 hex digest is kept in memory / local storage.
 *  - Short-lived (10 minutes default) and single-use.
 *  - Redemption is serialized and invalidates the active code after 3 failed
 *    guesses.
 *  - Non-private channels are rejected before inspecting or mutating the active
 *    challenge so group traffic cannot probe or burn an operator's code.
 */

import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import { bindPlatformUserAsHostOwner } from "@/lib/db/platform-identities"
import { sha256String } from "@/lib/utils/hash"
import type { PlatformKind } from "@/types/connectors/platform-kind"

export const HOST_OWNER_BIND_TTL_MS = 10 * 60 * 1000
export const HOST_OWNER_BIND_MAX_ATTEMPTS = 3

const STORAGE_KEY = "cognia:host-owner-bind-challenge:v1"
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export interface StoredHostOwnerBindChallenge {
  digestHex: string
  issuedAt: number
  expiresAt: number
  attemptsRemaining: number
}

export interface IssuedHostOwnerBindCode {
  code: string
  commandText: string
  issuedAt: number
  expiresAt: number
  attemptsRemaining: number
}

export type RedeemHostOwnerBindFailureReason =
  "not_private" | "missing_code" | "no_active_code" | "expired" | "invalid_code" | "locked_out"

export type RedeemHostOwnerBindResult =
  | { ok: true; identity: PlatformIdentityRow }
  | {
      ok: false
      reason: RedeemHostOwnerBindFailureReason
      attemptsRemaining?: number
    }

let memoryChallenge: StoredHostOwnerBindChallenge | null = null
let mutexTail: Promise<void> = Promise.resolve()

function withChallengeLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mutexTail
  let release!: () => void
  mutexTail = new Promise<void>((resolve) => {
    release = resolve
  })
  return prev.then(fn).finally(() => release())
}

function readStoredChallenge(): StoredHostOwnerBindChallenge | null {
  if (memoryChallenge) return memoryChallenge
  try {
    if (typeof localStorage === "undefined") return null
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredHostOwnerBindChallenge>
    if (
      typeof parsed.digestHex === "string" &&
      typeof parsed.issuedAt === "number" &&
      typeof parsed.expiresAt === "number" &&
      typeof parsed.attemptsRemaining === "number"
    ) {
      memoryChallenge = {
        digestHex: parsed.digestHex,
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
        attemptsRemaining: parsed.attemptsRemaining,
      }
      return memoryChallenge
    }
  } catch {
    // Ignore storage read errors in restricted environments.
  }
  return null
}

function writeStoredChallenge(challenge: StoredHostOwnerBindChallenge | null): void {
  memoryChallenge = challenge
  try {
    if (typeof localStorage === "undefined") return
    if (challenge === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(challenge))
  } catch {
    // Ignore storage write errors in restricted environments.
  }
}

export function normalizeHostOwnerBindCode(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  const withoutSlash = trimmed.startsWith("/BIND") ? trimmed.slice(5).trim() : trimmed
  return withoutSlash.replace(/\s+/g, "")
}

function generateBindCodeToken(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
  return `BIND-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`
}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}

export async function issueHostOwnerBindCode(options?: {
  now?: number
  ttlMs?: number
}): Promise<IssuedHostOwnerBindCode> {
  return withChallengeLock(async () => {
    const issuedAt = options?.now ?? Date.now()
    const ttlMs = Math.max(1_000, options?.ttlMs ?? HOST_OWNER_BIND_TTL_MS)
    const expiresAt = issuedAt + ttlMs
    const code = generateBindCodeToken()
    const digestHex = await sha256String(code)
    const stored: StoredHostOwnerBindChallenge = {
      digestHex,
      issuedAt,
      expiresAt,
      attemptsRemaining: HOST_OWNER_BIND_MAX_ATTEMPTS,
    }
    writeStoredChallenge(stored)
    return {
      code,
      commandText: `/bind ${code}`,
      issuedAt,
      expiresAt,
      attemptsRemaining: HOST_OWNER_BIND_MAX_ATTEMPTS,
    }
  })
}

export function getActiveHostOwnerBindCodeMeta(now = Date.now()): {
  expiresAt: number
  attemptsRemaining: number
} | null {
  const stored = readStoredChallenge()
  if (!stored) return null
  if (now >= stored.expiresAt) {
    writeStoredChallenge(null)
    return null
  }
  return {
    expiresAt: stored.expiresAt,
    attemptsRemaining: stored.attemptsRemaining,
  }
}

export function revokeHostOwnerBindCode(): void {
  writeStoredChallenge(null)
}

export async function redeemHostOwnerBindCode(input: {
  code: string
  platform: PlatformKind
  adapterId: string
  remoteUserId: string
  displayName?: string
  isPrivateChannel: boolean
  now?: number
}): Promise<RedeemHostOwnerBindResult> {
  if (!input.isPrivateChannel) {
    return { ok: false, reason: "not_private" }
  }
  const normalized = normalizeHostOwnerBindCode(input.code)
  if (!normalized) {
    return { ok: false, reason: "missing_code" }
  }
  return withChallengeLock(async () => {
    const now = input.now ?? Date.now()
    const stored = readStoredChallenge()
    if (!stored) {
      return { ok: false, reason: "no_active_code" }
    }
    if (now >= stored.expiresAt) {
      writeStoredChallenge(null)
      return { ok: false, reason: "expired" }
    }
    const candidateDigest = await sha256String(normalized)
    if (!constantTimeHexEquals(candidateDigest, stored.digestHex)) {
      const remaining = stored.attemptsRemaining - 1
      if (remaining <= 0) {
        writeStoredChallenge(null)
        return { ok: false, reason: "locked_out", attemptsRemaining: 0 }
      }
      writeStoredChallenge({ ...stored, attemptsRemaining: remaining })
      return { ok: false, reason: "invalid_code", attemptsRemaining: remaining }
    }

    // Consume single-use challenge before persisting identity binding.
    writeStoredChallenge(null)
    const identity = await bindPlatformUserAsHostOwner({
      platform: input.platform,
      adapterId: input.adapterId,
      remoteUserId: input.remoteUserId,
      displayName: input.displayName,
      via: "bind_code",
      now,
    })
    return { ok: true, identity }
  })
}

export function __resetHostOwnerBindCodeForTesting(): void {
  writeStoredChallenge(null)
}
