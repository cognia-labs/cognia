/**
 * `cognia-agent host login`: turn this machine into a device the Host knows.
 *
 * The device wire is the only one that works off-loopback, and it is the only
 * one where the owner keeps control: an enrolled CLI shows up in the Device
 * Console with its own capability grants, and revoking it there is enough. So
 * pairing is the same flow a phone uses, not a private side door.
 *
 * The Host's public `/api/auth/config` supplies the host and tenant ids, so a
 * caller only has to know the endpoint and hold a pairing code.
 *
 * A multi-tenant Host has no owner pairing code: each member registers the
 * device as themselves, with the OIDC session of the local account the CLI
 * acts for (`cognia-agent logto login --account <id>`, against the issuer the
 * Host announces). The Host takes the tenant from that token's organization.
 */

import type { LogtoSession } from "@/lib/logto/client"
import {
  fetchCompanionAuthConfig,
  isMultiTenantAuthConfig,
  registerCompanionDevice,
  type AuthFetcher,
  type MultiTenantAuthConfig,
} from "@/lib/tauri/companion-auth"

import type { CliFailure } from "../cli/errors"
import { normalizeEndpoint, type HostRecord } from "./store"

/** The local account whose sign-in registers the device on a multi-tenant Host. */
export interface LoginAccount {
  id: string
  /** The account's fresh session, or null when it is not signed in. */
  session: () => Promise<LogtoSession | null>
  /** How messages and the saved record name the person the session signs in as. */
  describe: (session: LogtoSession) => string
}

export interface LoginInput {
  endpoint: string
  /**
   * The owner invitation code, read from Settings then Companion on the host.
   * A single-user Host needs it; a multi-tenant one pairs through `account`.
   */
  invitation?: string
  /** The local account a multi-tenant Host registers the device for. */
  account?: LoginAccount
  displayName?: string
  /** Pins the host's TLS SubjectPublicKeyInfo for every later call. */
  serverFingerprint?: string
  tenantId?: string
  fetcher?: AuthFetcher
  /** Injected in tests so no real pairing is attempted. */
  fetchConfig?: typeof fetchCompanionAuthConfig
  register?: typeof registerCompanionDevice
}

export type LoginResult = { ok: true; record: HostRecord } | { ok: false; failure: CliFailure }

export async function loginHost(input: LoginInput): Promise<LoginResult> {
  const endpoint = normalizeEndpoint(input.endpoint)
  const fetchConfig = input.fetchConfig ?? fetchCompanionAuthConfig
  const register = input.register ?? registerCompanionDevice

  let config: Awaited<ReturnType<typeof fetchCompanionAuthConfig>>
  try {
    config = await fetchConfig(endpoint, input.serverFingerprint, input.fetcher)
  } catch (error) {
    return {
      ok: false,
      failure: {
        error: `cannot read the pairing configuration from ${endpoint}`,
        details: [error instanceof Error ? error.message : String(error)],
        cause: "network",
        fix: [
          "check the endpoint, and that the Companion API server is running on the host",
          "a self-signed host needs --fingerprint <sha256 hex> from its pairing screen",
        ],
        inspect: [`cognia-agent api request GET /api/auth/config --endpoint ${endpoint}`],
      },
    }
  }

  if (isMultiTenantAuthConfig(config)) {
    return loginWithSession(endpoint, config, input, register)
  }
  if (config.deploymentMode !== "single-user") {
    return {
      ok: false,
      failure: {
        error: `${endpoint} is a multi-tenant deployment but announces no OIDC issuer to sign in with`,
        cause: "auth",
        fix: ["ask the Host's operator to configure its OIDC issuer"],
        inspect: [`cognia-agent api request GET /api/auth/config --endpoint ${endpoint}`],
      },
    }
  }
  if (!input.invitation) {
    return {
      ok: false,
      failure: {
        error: `${endpoint} pairs with the owner's pairing code`,
        cause: "invalid-request",
        fix: [
          "pass --pair-code <code> from the host's Settings then Companion, or its Device Console",
        ],
      },
    }
  }

  const tenantId = input.tenantId ?? config.tenantId
  if (!tenantId) {
    return {
      ok: false,
      failure: {
        error: `${endpoint} did not name a tenant, and none was given`,
        cause: "auth",
        fix: ["pass --tenant <id>"],
      },
    }
  }

  try {
    const paired = await register(
      {
        baseUrl: endpoint,
        mode: "owner-invitation",
        invitation: input.invitation,
        hostId: config.hostId,
        tenantId,
        displayName: input.displayName ?? "Cognia CLI",
        serverVersion: String(config.configVersion ?? "unknown"),
        ...(input.serverFingerprint ? { serverFingerprint: input.serverFingerprint } : {}),
      },
      input.fetcher
    )
    return { ok: true, record: deviceRecord(endpoint, tenantId, paired, input.serverFingerprint) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: {
        error: `pairing with ${endpoint} was refused`,
        details: [message],
        cause: "auth",
        fix: [
          "a pairing code is single-use and short-lived, so take a fresh one from the host",
          "Settings then Companion on the desktop, or the Device Console",
        ],
      },
    }
  }
}

type PairedDevice = Awaited<ReturnType<typeof registerCompanionDevice>>

function deviceRecord(
  endpoint: string,
  tenantId: string,
  paired: PairedDevice,
  serverFingerprint: string | undefined
): HostRecord {
  return {
    kind: "device",
    endpoint,
    tenantId,
    deviceId: paired.deviceId,
    ...(paired.devicePrivateKeyJwk
      ? {
          devicePrivateKeyJwk: paired.devicePrivateKeyJwk as unknown as Record<string, unknown>,
        }
      : {}),
    ...(paired.deviceKeyThumbprint ? { deviceKeyThumbprint: paired.deviceKeyThumbprint } : {}),
    ...((paired.serverFingerprint ?? serverFingerprint)
      ? { serverFingerprint: paired.serverFingerprint ?? serverFingerprint }
      : {}),
    ...(paired.serverVersion ? { serverVersion: paired.serverVersion } : {}),
    // The CLI's own relay room (ADR-0224 A4). Kept so commands still reach
    // a host only the relay can: one paired from another network.
    ...(paired.rendezvousId && paired.signalingRoomDescriptor && paired.signalingPrivateKeyJwk
      ? {
          relay: {
            rendezvousId: paired.rendezvousId,
            roomDescriptor: paired.signalingRoomDescriptor as unknown as Record<string, unknown>,
            signalingPrivateKeyJwk: paired.signalingPrivateKeyJwk as unknown as Record<
              string,
              unknown
            >,
            ...(paired.signalingUrl ? { signalingUrl: paired.signalingUrl } : {}),
          },
        }
      : {}),
  }
}

const trimSlash = (value: string) => value.replace(/\/+$/, "")

/** The `logto login` that signs `accountId` in to the deployment a Host announces. */
function signInCommand(
  config: MultiTenantAuthConfig,
  accountId: string,
  tenantId: string | undefined
): string {
  const clientId = config.oidc.nativeClientId ?? config.oidc.webClientId
  return (
    `cognia-agent logto login --account ${accountId} --issuer ${config.oidc.issuer} ` +
    `--client-id ${clientId} --resource ${config.oidc.audience} --org ${tenantId ?? "<tenant>"}`
  )
}

/**
 * Register the device on a multi-tenant Host as the person the account is
 * signed in as. Everything the Host would refuse is checked first, so the
 * failure names the sign-in to run rather than an opaque 401.
 */
async function loginWithSession(
  endpoint: string,
  config: MultiTenantAuthConfig,
  input: LoginInput,
  register: typeof registerCompanionDevice
): Promise<LoginResult> {
  const account = input.account
  if (!account) {
    return {
      ok: false,
      failure: {
        error: `${endpoint} is a multi-tenant deployment, which pairs through a member's sign-in`,
        cause: "auth",
        fix: ["name the local account to pair as with --account <id>"],
      },
    }
  }
  let session: LogtoSession | null
  try {
    session = await account.session()
  } catch (error) {
    return {
      ok: false,
      failure: {
        error: `cannot read the sign-in of account ${account.id}`,
        details: [error instanceof Error ? error.message : String(error)],
        cause: "auth",
        fix: [`cognia-agent logto status --account ${account.id}`],
      },
    }
  }
  if (!session) {
    return {
      ok: false,
      failure: {
        error: `${endpoint} pairs through a member's sign-in, and account ${account.id} is not signed in`,
        cause: "auth",
        fix: [signInCommand(config, account.id, input.tenantId), "then run this host login again"],
      },
    }
  }
  const announcedClients = [config.oidc.webClientId, config.oidc.nativeClientId].filter(Boolean)
  if (
    trimSlash(session.issuer) !== trimSlash(config.oidc.issuer) ||
    trimSlash(session.resource) !== trimSlash(config.oidc.audience) ||
    !announcedClients.includes(session.clientId)
  ) {
    return {
      ok: false,
      failure: {
        error:
          `account ${account.id} is signed in to ${session.issuer} (resource ${session.resource}), ` +
          `but ${endpoint} signs people in through ${config.oidc.issuer} ` +
          `(resource ${config.oidc.audience})`,
        cause: "auth",
        fix: [
          `sign another account in to this Host's deployment: ${signInCommand(config, "<id>", input.tenantId)}`,
          `then pair as it: cognia-agent host login <name> --endpoint ${endpoint} --account <id>`,
        ],
      },
    }
  }
  const tenantId = input.tenantId ?? session.organizationId
  if (!tenantId) {
    return {
      ok: false,
      failure: {
        error: `account ${account.id} signed in without an organization, and no --tenant was given`,
        cause: "auth",
        fix: [signInCommand(config, account.id, undefined)],
      },
    }
  }
  if (session.organizationId !== tenantId) {
    return {
      ok: false,
      failure: {
        error:
          `account ${account.id} is signed in to organization ${session.organizationId ?? "(none)"}, ` +
          `not tenant ${tenantId}`,
        cause: "auth",
        fix: [signInCommand(config, account.id, tenantId)],
      },
    }
  }
  const person = account.describe(session)
  try {
    const paired = await register(
      {
        baseUrl: endpoint,
        mode: "oidc",
        hostId: config.hostId,
        tenantId,
        displayName: input.displayName ?? "Cognia CLI",
        serverVersion: String(config.configVersion ?? "unknown"),
        ...(input.serverFingerprint ? { serverFingerprint: input.serverFingerprint } : {}),
        oidc: {
          // The Host's own spelling: registration compares them exactly.
          issuer: config.oidc.issuer,
          resource: config.oidc.audience,
          clientId: session.clientId,
          organizationId: tenantId,
          accessToken: session.accessToken,
        },
      },
      input.fetcher
    )
    return {
      ok: true,
      record: {
        ...deviceRecord(endpoint, tenantId, paired, input.serverFingerprint),
        pairedAs: { account: account.id, person },
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: {
        error: `${endpoint} refused to register this device for ${person}`,
        details: [message],
        cause: "auth",
        fix: [
          `check that ${person} is a member of tenant ${tenantId} on this Host`,
          `sign in again if the session has lapsed: ${signInCommand(config, account.id, tenantId)}`,
        ],
      },
    }
  }
}
