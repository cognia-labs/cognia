// Native auth/OAuth provider contribution (C1). A plugin declares
// `manifest.authProviders[]` (declarations for validation + the consent UI) and
// supplies the live provider object imperatively at activation via
// `ctx.auth.registerProvider(...)` — mirroring `ctx.quickActions.register`.
// The richer provider/session/API types live in `lib/plugin/api/auth-api.ts`
// and `lib/plugin/auth/auth-provider-registry.ts`.

/** ADR-0243 credential lanes: user → delegated or bound person; bot/service → service. */
export type AuthPrincipalKind = "user" | "bot" | "service"

/** Authentication methods a provider may support.
 * API keys use Host connection storage without a refresh flow. Confidential
 * OAuth uses authorization code without PKCE and requires a trusted Host.
 * `device-code` is dormant for plugin providers (ADR-0246 §7, Later): the
 * Host always refuses it with `device-code-deferred`. Keep it visible and inert.
 */
export type AuthMethod =
  "oauth-pkce" | "oauth-confidential" | "client-credentials" | "device-code" | "api-key"

/** Provider ownership and contract version recorded on a Host connection. */
export interface AuthConnectionProviderIdentity {
  providerId: string
  /** `null` identifies a Host provider. */
  ownerPluginId: string | null
  publisher: string | null
  contractMajor: number
}

/** Stable remote identity of a Host-owned connection (ADR-0246 §2). */
export interface AuthConnectionIdentity {
  provider: AuthConnectionProviderIdentity
  issuer: string
  clientId: string
  tenantId?: string
  principal: { id: string; kind: AuthPrincipalKind }
}

/** Availability and lifecycle state of a Host-owned connection. */
export type AuthConnectionStatus =
  "connected" | "needs-reauth" | "provider-unavailable" | "revoked" | "tombstoned"

/** Opaque, Host-issued reference. Plugins never construct or parse it. */
export type AuthConnectionRef = string & { readonly __authConnectionRef: true }

/** The only connection shape business plugins see: no tokens or client id. */
export interface AuthConnectionMetadata {
  ref: AuthConnectionRef
  providerId: string
  accountLabel: string
  principalKind: AuthPrincipalKind
  issuer: string
  tenantLabel?: string
  scopes: string[]
  status: AuthConnectionStatus
  revision: number
}

/** Connection notifications expose metadata only. */
export interface AuthConnectionChangeEvent {
  added: AuthConnectionMetadata[]
  removed: AuthConnectionMetadata[]
  changed: AuthConnectionMetadata[]
}

/** Operations and optional scopes requested by a business plugin. */
export interface AuthConnectionGrantRequest {
  operations: string[]
  scopes?: string[]
}

/** Host decision authorizing one consumer at one connection revision. */
export type AuthConnectionGrantDecision =
  | {
      granted: true
      ref: AuthConnectionRef
      connectionRevision: number
      operations: string[]
      scopes: string[]
    }
  | {
      granted: false
      reason: "denied" | "dismissed" | "connection-unavailable" | "scopes-unavailable"
    }

/** Credential material visible only to the providing plugin, never business plugins. */
export interface AuthCredentialSet {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scopes: string[]
  extra?: Record<string, string>
}

/** Public client configuration used by the Host before creating a bound attempt. Never include a secret. */
export type AuthAuthorizationConfig = {
  issuer: string
  /** Defaults to the existing Host callback route for this runtime. */
  redirectUri?: string
} & (
  | { clientId: string; clientIdFrom?: never }
  | { clientId?: never; clientIdFrom: { configuration: string } }
)

/** Host-owned setup form. Secret values are written to the Host store, never plugin configuration. */
export interface AuthProviderConfigurationSchema {
  type: "object"
  properties: Record<
    string,
    {
      type: "string"
      format?: "secret" | "uri"
      minLength?: number
      enum?: string[]
    }
  >
  required?: string[]
}

/** Host-bound attempt supplied only to the providing plugin for authorization and exchange. */
export interface AuthAttemptContext {
  attemptId: string
  providerId: string
  method: AuthMethod
  clientId: string
  issuer: string
  redirectUri?: string
  codeVerifier?: string
  /** S256 challenge for authorize(); state is attemptId. */
  codeChallenge?: string
  scopes: string[]
}

/** Authorization callback supplied to the providing plugin after Host acceptance. */
export interface AuthCallbackParams {
  state: string
  code?: string
  error?: string
  errorDescription?: string
}

/** Credential lineage supplied only to the providing plugin by the Host. */
export interface AuthLineageContext {
  ref: AuthConnectionRef
  lineageId: string
  credentialRevision: number
  identity: AuthConnectionIdentity
  credentials: AuthCredentialSet
}

/** Remote identity described by the providing plugin for Host connection storage. */
export interface AuthIdentityDescription {
  issuer: string
  clientId: string
  tenantId?: string
  tenantLabel?: string
  principal: { id: string; kind: AuthPrincipalKind }
  accountLabel: string
  scopes: string[]
}

export interface PluginAuthProviderDef {
  /** Stable provider id, e.g. `"github"`, `"acme"`. */
  id: string
  /** Human-readable label shown in the consent UI. */
  label: string
  /** Public client/issuer binding for a Host-managed provider. Never include a client secret. */
  authorization?: AuthAuthorizationConfig
  /** Setup fields for AuthSessionOptions.configuration; never copied into ctx.config. */
  configurationSchema?: AuthProviderConfigurationSchema
  /** Authentication methods supported by this provider. */
  methods?: AuthMethod[]
  /** Remote principal kinds supported by this provider. */
  principals?: AuthPrincipalKind[]
  /**
   * Endpoints the Host may call on the provider's behalf for confidential exchanges.
   * They must also be allowed by networkAccess, checked by the runtime.
   */
  tokenEndpoints?: Array<{
    url: string
    clientSecret?: "none" | "form" | "json" | "basic"
    /**
     * Host-injected parameter names; defaults to client_id / client_secret.
     * Names match ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$ and must differ after defaults.
     * Unavailable with basic auth. Plugin params cannot contain the injected names.
     */
    credentialFields?: { clientId?: string; clientSecret?: string }
  }>
  /** Endpoints the Host may use to revoke credentials. */
  revocationEndpoints?: string[]
  /** Allowed HTTPS issuer origins. */
  issuers?: string[]
}

/** Public session metadata. Credentials are only returned by explicit session reads. */
export interface PluginAuthSessionMetadata {
  id: string
  account: { id: string; label: string }
  scopes: string[]
}

/** Plugin-facing change notification; never includes tokens or provider extension fields. */
export interface PluginAuthSessionChangeEvent {
  providerId: string
  added: PluginAuthSessionMetadata[]
  removed: PluginAuthSessionMetadata[]
  changed: PluginAuthSessionMetadata[]
}
