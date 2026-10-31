import { generateCodeVerifier, generateCodeChallenge } from "@cognia/provider-core/providers/oauth"
import type {
  AuthAttemptContext,
  AuthMethod,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "@/lib/db/schema"
import {
  CredentialRevisionConflict,
  withAuthLock,
  accountAuthSecrets,
} from "./connection-credentials"

const ATTEMPT_TTL_MS = 10 * 60 * 1000
export type AttemptRejectionReason =
  | "unknown"
  | "already-consumed"
  | "expired"
  | "cancelled"
  | "provider-mismatch"
  | "client-mismatch"
  | "issuer-mismatch"
export class AuthAttemptRejected extends Error {
  constructor(readonly reason: AttemptRejectionReason) {
    super(`Auth attempt rejected: ${reason}`)
    this.name = "AuthAttemptRejected"
  }
}
export interface AuthAttempt extends AuthAttemptContext {
  state: string
  expiresAt: number
  codeChallenge?: string
  /** Attempts can operate in memory; callers can report this typed degraded state. */
  persistence: "persistent" | "non-persistent-until-vault-unlock"
}
export interface AttemptIndexRow {
  state: string
  expiresAt: number
  outcome?: "consumed" | "cancelled"
}
export interface AttemptIndex {
  get(state: string): Promise<AttemptIndexRow | undefined>
  put(row: AttemptIndexRow): Promise<unknown>
  expired(now: number): Promise<AttemptIndexRow[]>
  delete(state: string): Promise<unknown>
}
export interface AttemptBinding {
  providerId: string
  clientId: string
  issuer: string
}

function accountAttemptIndex(): AttemptIndex {
  const database = getDb()
  return {
    get: (state) => database.authAttempts.get(state),
    put: (row) => database.authAttempts.put(row),
    expired: (now) => database.authAttempts.where("expiresAt").belowOrEqual(now).toArray(),
    delete: (state) => database.authAttempts.delete(state),
  }
}

/** The index contains no verifier or credential, only a bounded cleanup/replay receipt. */
export class AuthAttemptStore {
  constructor(
    private readonly secrets = accountAuthSecrets("auth-attempts"),
    private readonly index: AttemptIndex = accountAttemptIndex(),
    private readonly now: () => number = Date.now,
    private readonly lock = withAuthLock
  ) {}
  async sweepExpired(): Promise<void> {
    for (const row of await this.index.expired(this.now())) {
      await this.lock(
        `cognia-auth-attempt:${row.state}`,
        async () => {
          await this.secrets.delete(row.state)
          await this.index.delete(row.state)
        },
        "attempts"
      )
    }
  }
  async createAttempt(
    input: AttemptBinding & { method: AuthMethod; redirectUri?: string; scopes: string[] }
  ): Promise<AuthAttempt> {
    await this.sweepExpired()
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    const codeVerifier = input.method === "oauth-pkce" ? generateCodeVerifier() : undefined
    const attempt: AuthAttempt = {
      ...input,
      scopes: [...input.scopes],
      state,
      attemptId: state,
      codeVerifier,
      codeChallenge: codeVerifier ? await generateCodeChallenge(codeVerifier) : undefined,
      expiresAt: this.now() + ATTEMPT_TTL_MS,
      persistence: this.secrets.isPersistent() ? "persistent" : "non-persistent-until-vault-unlock",
    }
    await this.index.put({ state, expiresAt: attempt.expiresAt })
    try {
      await this.secrets.compareAndSet(state, null, JSON.stringify(attempt))
    } catch (error) {
      await this.index.delete(state)
      throw error
    }
    return attempt
  }
  async consumeAttempt(state: string, binding: AttemptBinding): Promise<AuthAttempt> {
    // Read before sweeping so the requested expired attempt has a precise reason.
    const raw = await this.secrets.read(state)
    const receipt = await this.index.get(state)
    await this.sweepExpired()
    if (!raw)
      throw new AuthAttemptRejected(
        receipt?.outcome === "consumed"
          ? "already-consumed"
          : receipt?.outcome === "cancelled"
            ? "cancelled"
            : receipt && receipt.expiresAt <= this.now()
              ? "expired"
              : "unknown"
      )
    const record = JSON.parse(raw) as AuthAttempt & { consumed?: boolean }
    if (record.consumed) throw new AuthAttemptRejected("already-consumed")
    if (record.expiresAt <= this.now()) throw new AuthAttemptRejected("expired")
    if (record.providerId !== binding.providerId) throw new AuthAttemptRejected("provider-mismatch")
    if (record.clientId !== binding.clientId) throw new AuthAttemptRejected("client-mismatch")
    if (record.issuer !== binding.issuer) throw new AuthAttemptRejected("issuer-mismatch")
    try {
      await this.secrets.compareAndSet(
        state,
        raw,
        JSON.stringify({ consumed: true, expiresAt: record.expiresAt })
      )
    } catch (error) {
      if (error instanceof CredentialRevisionConflict)
        throw new AuthAttemptRejected("already-consumed")
      throw error
    }
    // CAS is the acceptance point. A receipt or cleanup failure cannot undo it
    // or leave a successfully accepted callback waiting until its timeout.
    try {
      await this.index.put({ state, expiresAt: record.expiresAt, outcome: "consumed" })
      await this.secrets.delete(state)
    } catch {
      console.warn("Auth attempt receipt cleanup failed")
    }
    return record
  }
  async cancelAttempt(state: string): Promise<void> {
    await this.lock(
      `cognia-auth-attempt:${state}`,
      async () => {
        const row = await this.index.get(state)
        if (row?.outcome === "consumed") return
        const raw = await this.secrets.read(state)
        if (raw && (JSON.parse(raw) as { consumed?: boolean }).consumed) return
        // CAS against consumers too, including the native path; no late callback wins.
        if (raw !== null) {
          try {
            await this.secrets.compareAndSet(
              state,
              raw,
              JSON.stringify({ consumed: true, expiresAt: row?.expiresAt ?? this.now() })
            )
          } catch (error) {
            if (!(error instanceof CredentialRevisionConflict)) throw error
            // A consumer won. Never replace its receipt using the stale row.
            return
          }
        }
        await this.secrets.delete(state)
        if (row) await this.index.put({ ...row, outcome: "cancelled" })
      },
      "attempts"
    )
  }
}

const stores = new WeakMap<object, AuthAttemptStore>()
export function getAuthAttemptStore(): AuthAttemptStore {
  const database = getDb()
  let attempts = stores.get(database)
  if (!attempts) {
    attempts = new AuthAttemptStore()
    stores.set(database, attempts)
  }
  return attempts
}
export const createAttempt = (input: Parameters<AuthAttemptStore["createAttempt"]>[0]) =>
  getAuthAttemptStore().createAttempt(input)
export const consumeAttempt = (state: string, binding: AttemptBinding) =>
  getAuthAttemptStore().consumeAttempt(state, binding)
export const cancelAttempt = (state: string) => getAuthAttemptStore().cancelAttempt(state)
