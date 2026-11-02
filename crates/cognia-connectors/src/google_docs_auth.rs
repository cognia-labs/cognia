//! Google OAuth belongs to the Host: only access-token leases leave this module.
//! Lineage authorization nonces fence late exchanges/refreshes and revocation.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cognia_net::oauth_exchange::{
    confidential_token_exchange, ClientSecretPlacement, ConfidentialExchangeRequest,
    ConfidentialExchangeResponse, CredentialFields, TokenBodyEncoding,
};
use cognia_secrets::keyring_secrets::{self, SecretStoreSetCondition};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, RwLock};

const NAMESPACE: &str = "docs-providers";
const STATE_KEY: &str = "google-auth-lineages-v2";
const LEGACY_KEY: &str = "google-connection-v1";
const LEGACY_SECRET: &str = "google-client-secret";
const STALE: &str = "google_docs_state_stale";
const MISMATCH: &str = "google_docs_state_mismatch";
const TTL_MS: u64 = 600_000;
const CALLBACK_PATH: &str = "/oauth/docs/google/callback";
pub const CHANGED_EVENT: &str = "google-docs-connection-changed";

fn nonce() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
fn default_redirect() -> String {
    format!("http://127.0.0.1:7842{CALLBACK_PATH}")
}
fn scopes_with_identity(scopes: Vec<String>) -> Vec<String> {
    let mut result = scopes;
    result.extend(["openid".into(), "email".into()]);
    result.sort();
    result.dedup();
    result
}
fn validate_client(client: &str) -> Result<(), String> {
    if client.trim().is_empty() || client.len() > 1024 || client.chars().any(char::is_control) {
        return Err("invalid Google client id".into());
    }
    Ok(())
}
fn validate_redirect(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "invalid Google loopback redirect")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || url.port().is_none()
        || url.path() != CALLBACK_PATH
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("invalid Google loopback redirect".into());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
    scope: Option<String>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    LoopbackPkce,
    DeviceCode,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Connected,
    NeedsReauth,
    Disconnected,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lineage {
    id: String,
    client_id: String,
    method: Method,
    scopes: Vec<String>,
    sub: String,
    email: Option<String>,
    status: Status,
    authorization: String,
    credential_revision: String,
    needs_identity: bool,
    identity_attempted: bool,
    tokens: Option<Tokens>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    id: String,
    client_id: String,
    method: Method,
    scopes: Vec<String>,
    expires_at: u64,
    reauthorize_lineage: Option<String>,
    start_authorization: Option<String>,
    claimed: bool,
    state: String,
    verifier: String,
    redirect_uri: String,
    device_code: String,
    interval: u64,
    #[serde(default)]
    lineage_revisions: BTreeMap<String, String>,
    #[serde(default)]
    disconnect_generation: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyState {
    #[serde(default)]
    tokens: Option<Tokens>,
    #[serde(default)]
    account_email: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    version: u8,
    lineages: Vec<Lineage>,
    pending: Vec<Pending>,
    clients: BTreeMap<String, String>,
    legacy: Option<LegacyState>,
    legacy_secret_migrated: bool,
    #[serde(default)]
    secret_overrides: BTreeSet<String>,
    #[serde(default)]
    disconnect_generation: u64,
    /// Identity barriers survive lineage deletion and process restart.
    #[serde(default)]
    disconnect_barriers: BTreeMap<String, BTreeMap<String, u64>>,
}
impl State {
    fn empty() -> Self {
        Self {
            version: 2,
            lineages: vec![],
            pending: vec![],
            clients: BTreeMap::new(),
            legacy: None,
            legacy_secret_migrated: false,
            secret_overrides: BTreeSet::new(),
            disconnect_generation: 0,
            disconnect_barriers: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Input {
    Snapshot {
        #[serde(default)]
        legacy_client_id: Option<String>,
    },
    SetClientSecret {
        client_id: String,
        secret: String,
    },
    ClearClientSecret {
        client_id: String,
    },
    Begin {
        client_id: String,
        scopes: Vec<String>,
        #[serde(default)]
        reauthorize_lineage: Option<String>,
        #[serde(default)]
        redirect_uri: Option<String>,
    },
    BeginDevice {
        client_id: String,
        scopes: Vec<String>,
        #[serde(default)]
        reauthorize_lineage: Option<String>,
    },
    Complete {
        state: String,
        code: String,
        #[serde(default)]
        client_id: Option<String>,
    },
    PollDevice {
        attempt_id: String,
    },
    Cancel {
        attempt_id: String,
    },
    AccessToken {
        lineage_id: String,
        #[serde(default)]
        min_validity_ms: Option<u64>,
    },
    Disconnect {
        lineage_id: String,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageMetadata {
    pub id: String,
    pub client_id: String,
    pub method: Method,
    pub scopes: Vec<String>,
    pub sub: String,
    pub email: Option<String>,
    pub status: Status,
    pub revision: String,
    pub credential_revision: String,
    pub needs_identity: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMetadata {
    client_id: String,
    has_client_secret: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMetadata {
    attempt_id: String,
    client_id: String,
    method: Method,
    expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reauthorize_lineage: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    attempt_id: String,
    expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorize_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<u64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PollStatus {
    Pending,
    SlowDown,
    Denied,
    Expired,
    Connected,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    access_token: String,
    expires_at: u64,
    revision: String,
    credential_revision: String,
}
#[derive(Clone, Serialize)]
pub struct Outcome {
    revoked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub lineages: Vec<LineageMetadata>,
    pub clients: Vec<ClientMetadata>,
    pub pending: Vec<PendingMetadata>,
    pub migration_needs_client_id: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Attempt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll_status: Option<PollStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<Credential>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
}
impl Reply {
    fn snapshot(state: &State, legacy_secret: bool) -> Self {
        let mut clients: BTreeMap<String, bool> = state
            .lineages
            .iter()
            .map(|l| (l.client_id.clone(), false))
            .collect();
        for (client, secret) in &state.clients {
            clients.insert(client.clone(), !secret.is_empty());
        }
        Self {
            lineages: state
                .lineages
                .iter()
                .map(|l| LineageMetadata {
                    id: l.id.clone(),
                    client_id: l.client_id.clone(),
                    method: l.method,
                    scopes: l.scopes.clone(),
                    sub: l.sub.clone(),
                    email: l.email.clone(),
                    status: l.status,
                    revision: l.authorization.clone(),
                    credential_revision: l.credential_revision.clone(),
                    needs_identity: l.needs_identity,
                })
                .collect(),
            clients: clients
                .into_iter()
                .map(|(client_id, has_client_secret)| ClientMetadata {
                    client_id,
                    has_client_secret,
                })
                .collect(),
            pending: state
                .pending
                .iter()
                .filter(|p| !p.claimed && p.expires_at > now())
                .map(|p| PendingMetadata {
                    attempt_id: p.id.clone(),
                    client_id: p.client_id.clone(),
                    method: p.method,
                    expires_at: p.expires_at,
                    reauthorize_lineage: p.reauthorize_lineage.clone(),
                })
                .collect(),
            migration_needs_client_id: state.legacy.is_some() || legacy_secret,
            attempt: None,
            poll_status: None,
            credential: None,
            outcome: None,
        }
    }
}
struct Stored {
    state: State,
    expected: Option<String>,
}
trait Store: Send + Sync {
    fn load(&self) -> Result<Stored, String>;
    fn save(&self, state: &State, expected: Option<String>) -> Result<(), String>;
    fn legacy_secret(&self) -> Result<Option<String>, String>;
}
struct EncryptedStore;
impl Store for EncryptedStore {
    fn load(&self) -> Result<Stored, String> {
        let expected = keyring_secrets::get(NAMESPACE, STATE_KEY)?;
        let state = if let Some(raw) = &expected {
            let state: State =
                serde_json::from_str(raw).map_err(|_| "invalid Google lineage record")?;
            if state.version != 2 {
                return Err("unsupported Google lineage record".into());
            }
            state
        } else {
            let mut state = State::empty();
            state.legacy = if let Some(raw) = keyring_secrets::get(NAMESPACE, LEGACY_KEY)? {
                // The authoritative v1 tombstone takes precedence over older TS keys.
                let legacy: LegacyState =
                    serde_json::from_str(&raw).map_err(|_| "invalid legacy Google connection")?;
                legacy.tokens.as_ref().map(|_| legacy.clone())
            } else {
                keyring_secrets::get(NAMESPACE, "google-tokens")?.and_then(|raw| {
                    serde_json::from_str::<Tokens>(&raw)
                        .ok()
                        .map(|tokens| LegacyState {
                            tokens: Some(tokens),
                            account_email: None,
                        })
                })
            };
            state
        };
        Ok(Stored { state, expected })
    }
    fn save(&self, state: &State, expected: Option<String>) -> Result<(), String> {
        keyring_secrets::set_if(
            NAMESPACE,
            STATE_KEY,
            &serde_json::to_string(state).map_err(|_| "Google record serialization failed")?,
            &SecretStoreSetCondition {
                expected,
                changes: vec![],
            },
        )?;
        // Commit before cleanup: restarts can never re-import a revoked lineage.
        for key in [LEGACY_KEY, "google-tokens", "google-oauth-pending"] {
            if keyring_secrets::clear(NAMESPACE, key).is_err() {
                log::warn!("Google legacy cleanup deferred");
            }
        }
        if state.legacy_secret_migrated && keyring_secrets::clear(NAMESPACE, LEGACY_SECRET).is_err()
        {
            log::warn!("Google legacy client-secret cleanup deferred");
        }
        Ok(())
    }
    fn legacy_secret(&self) -> Result<Option<String>, String> {
        keyring_secrets::get(NAMESPACE, LEGACY_SECRET)
    }
}
type Notify = Arc<dyn Fn() + Send + Sync>;
#[derive(Clone)]
struct Endpoints {
    token: String,
    device: String,
    userinfo: String,
    revoke: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            token: "https://oauth2.googleapis.com/token".into(),
            device: "https://oauth2.googleapis.com/device/code".into(),
            userinfo: "https://openidconnect.googleapis.com/v1/userinfo".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
        }
    }
}
struct Controller {
    store: Arc<dyn Store>,
    mutation: Mutex<()>,
    refresh_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    blocked: Mutex<HashSet<String>>,
    disconnect_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    grants: RwLock<()>,
    endpoints: Endpoints,
}
impl Controller {
    fn new(store: Arc<dyn Store>, endpoints: Endpoints) -> Self {
        Self {
            store,
            mutation: Mutex::new(()),
            refresh_locks: Mutex::new(HashMap::new()),
            blocked: Mutex::new(HashSet::new()),
            disconnect_locks: Mutex::new(HashMap::new()),
            grants: RwLock::new(()),
            endpoints,
        }
    }
    fn edit<T>(&self, f: impl FnOnce(&mut State) -> Result<T, String>) -> Result<T, String> {
        let _guard = self.mutation.lock();
        let Stored {
            mut state,
            expected,
        } = self.store.load()?;
        let result = f(&mut state)?;
        let serialized =
            serde_json::to_string(&state).map_err(|_| "Google record serialization failed")?;
        if expected.as_deref() != Some(serialized.as_str()) {
            self.store.save(&state, expected)?;
        }
        Ok(result)
    }
    fn snapshot(&self) -> Result<Reply, String> {
        let _guard = self.mutation.lock();
        let state = self.store.load()?.state;
        let mut reply = Reply::snapshot(
            &state,
            !state.legacy_secret_migrated && self.store.legacy_secret()?.is_some(),
        );
        let blocked = self.blocked.lock();
        for lineage in &mut reply.lineages {
            if blocked.contains(&lineage.id) {
                lineage.status = Status::Disconnected;
            }
        }
        Ok(reply)
    }
    fn migrate(&self, client: Option<String>) -> Result<(), String> {
        if let Some(client) = &client {
            validate_client(client)?;
        }
        self.edit(|state| {
            if let Some(client) = client {
                if let Some(legacy) = state.legacy.take() {
                    if let Some(tokens) = legacy.tokens {
                        let id = nonce();
                        let scopes = tokens
                            .scope
                            .as_ref()
                            .map(|s| s.split_whitespace().map(str::to_owned).collect())
                            .unwrap_or_else(|| {
                                vec![
                                    "https://www.googleapis.com/auth/drive.readonly".into(),
                                    "https://www.googleapis.com/auth/documents.readonly".into(),
                                    "https://www.googleapis.com/auth/spreadsheets.readonly".into(),
                                ]
                            });
                        state.lineages.push(Lineage {
                            sub: format!("legacy:{id}"),
                            id,
                            client_id: client.clone(),
                            method: Method::LoopbackPkce,
                            scopes,
                            email: legacy.account_email,
                            status: Status::Connected,
                            authorization: nonce(),
                            credential_revision: nonce(),
                            needs_identity: true,
                            identity_attempted: false,
                            tokens: Some(tokens),
                        });
                    }
                }
                if !state.legacy_secret_migrated {
                    if !state.secret_overrides.contains(&client) {
                        if let Some(secret) = self.store.legacy_secret()? {
                            state.clients.entry(client).or_insert(secret);
                        }
                    }
                    state.legacy_secret_migrated = true;
                }
            }
            Ok(())
        })
    }
    async fn identify(
        &self,
        body: &Map<String, Value>,
        access: &str,
        client: &str,
    ) -> Result<(String, Option<String>), String> {
        if let Some(encoded) = body
            .get("id_token")
            .and_then(Value::as_str)
            .and_then(|t| t.split('.').nth(1))
        {
            // This id_token came directly from Google's token endpoint over TLS;
            // its signature is intentionally not verified here.
            if let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    let audience_matches = value.get("aud").is_none_or(|aud| {
                        aud.as_str() == Some(client)
                            || aud.as_array().is_some_and(|values| {
                                values.iter().any(|v| v.as_str() == Some(client))
                            })
                    });
                    if audience_matches {
                        if let Some(sub) = value
                            .get("sub")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            return Ok((
                                sub.into(),
                                value
                                    .get("email")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            ));
                        }
                    }
                }
            }
        }
        let response = crate::http_client::http_request(crate::types::TauriHttpRequest {
            url: self.endpoints.userinfo.clone(),
            method: "GET".into(),
            headers: Some([("Authorization".into(), format!("Bearer {access}"))].into()),
            body: None,
            timeout_ms: Some(30_000),
            allow_invalid_certificates: None,
        })
        .await
        .map_err(|_| "Google identity request failed")?;
        if !(200..300).contains(&response.status) {
            return Err("Google identity request failed".into());
        }
        let value: Value =
            serde_json::from_str(&response.body).map_err(|_| "invalid Google identity response")?;
        let sub = value
            .get("sub")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("missing Google identity")?;
        Ok((
            sub.into(),
            value
                .get("email")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ))
    }
    async fn resolve_legacy_identities(&self) -> Result<(), String> {
        let targets = self.edit(|state| {
            Ok(state
                .lineages
                .iter_mut()
                .filter(|l| l.needs_identity && !l.identity_attempted && l.tokens.is_some())
                .map(|l| {
                    l.identity_attempted = true;
                    l.clone()
                })
                .collect::<Vec<_>>())
        })?;
        for target in targets {
            if let Ok((sub, email)) = self
                .identify(
                    &Map::new(),
                    &target.tokens.as_ref().unwrap().access_token,
                    &target.client_id,
                )
                .await
            {
                self.edit(|state| {
                    // Identity probing is subject to the same disconnect/rotation CAS.
                    if let Some(index) = state.lineages.iter().position(|l| {
                        l.id == target.id
                            && l.authorization == target.authorization
                            && l.credential_revision == target.credential_revision
                            && l.status == Status::Connected
                    }) {
                        if self.blocked.lock().contains(&target.id) {
                            return Ok(());
                        }
                        if let Some(existing) = state.lineages.iter().position(|l| {
                            l.id != target.id
                                && l.client_id == target.client_id
                                && l.sub == sub
                                && !l.needs_identity
                        }) {
                            let scopes = state.lineages[index].scopes.clone();
                            state.lineages[existing].scopes.extend(scopes);
                            state.lineages[existing].scopes.sort();
                            state.lineages[existing].scopes.dedup();
                            state.lineages[existing].authorization = nonce();
                            let obsolete = &mut state.lineages[index];
                            obsolete.status = Status::Disconnected;
                            obsolete.tokens = None;
                            obsolete.authorization = nonce();
                            obsolete.credential_revision = nonce();
                        } else {
                            let lineage = &mut state.lineages[index];
                            lineage.sub = sub;
                            lineage.email = email.or(lineage.email.clone());
                            lineage.needs_identity = false;
                        }
                    }
                    Ok(())
                })?;
            }
        }
        Ok(())
    }
    async fn exchange(
        &self,
        url: &str,
        client: &str,
        params: BTreeMap<String, String>,
    ) -> Result<ConfidentialExchangeResponse, String> {
        let secret = self
            .store
            .load()?
            .state
            .clients
            .get(client)
            .cloned()
            .ok_or("Google client secret is not configured")?;
        confidential_token_exchange(ConfidentialExchangeRequest {
            token_url: url.into(),
            params,
            client_id: client.into(),
            client_secret: Some(secret),
            placement: ClientSecretPlacement::Form,
            body_encoding: TokenBodyEncoding::Form,
            credential_fields: CredentialFields::default(),
            timeout: Duration::from_secs(30),
        })
        .await
        .map_err(|e| e.to_string())
    }
    async fn begin(
        &self,
        client: String,
        scopes: Vec<String>,
        reauthorize: Option<String>,
        redirect: Option<String>,
        method: Method,
    ) -> Result<Reply, String> {
        validate_client(&client)?;
        let redirect = redirect.unwrap_or_else(default_redirect);
        validate_redirect(&redirect)?;
        if scopes
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().any(char::is_whitespace))
        {
            return Err("invalid Google OAuth scopes".into());
        }
        // A new consent cannot race a token-family revoke, even across renderers.
        let _barrier = self.grants.write().await;
        let pending = self.edit(|state| {
            if !state.clients.contains_key(&client) {
                return Err("Google client secret is not configured".into());
            }
            let start = if let Some(id) = &reauthorize {
                let l = state
                    .lineages
                    .iter()
                    .find(|l| &l.id == id && l.client_id == client)
                    .ok_or(MISMATCH)?;
                if self.blocked.lock().contains(id) {
                    return Err(STALE.into());
                }
                Some(l.authorization.clone())
            } else {
                None
            };
            let pending = Pending {
                id: nonce(),
                client_id: client.clone(),
                method,
                scopes: scopes_with_identity(scopes),
                expires_at: now().saturating_add(TTL_MS),
                reauthorize_lineage: reauthorize.clone(),
                start_authorization: start,
                claimed: false,
                state: format!("google:{}", nonce()),
                verifier: format!("{}{}", nonce(), nonce()).replace('-', ""),
                redirect_uri: redirect.clone(),
                device_code: String::new(),
                interval: 5,
                lineage_revisions: state
                    .lineages
                    .iter()
                    .filter(|l| l.client_id == client)
                    .map(|l| (l.id.clone(), l.authorization.clone()))
                    .collect(),
                disconnect_generation: state.disconnect_generation,
            };
            state.pending.retain(|p| {
                p.expires_at > now()
                    && (reauthorize.is_none() || p.reauthorize_lineage != reauthorize)
            });
            state.pending.push(pending.clone());
            Ok(pending)
        })?;
        let attempt = if method == Method::LoopbackPkce {
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.as_bytes()));
            let query = serde_urlencoded::to_string([
                ("client_id", client.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("scope", &pending.scopes.join(" ")),
                ("state", &pending.state),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("access_type", "offline"),
                ("prompt", "consent"),
                ("include_granted_scopes", "true"),
            ])
            .map_err(|_| "Google authorization URL failed")?;
            Attempt {
                attempt_id: pending.id,
                expires_at: pending.expires_at,
                authorize_url: Some(format!(
                    "https://accounts.google.com/o/oauth2/v2/auth?{query}"
                )),
                user_code: None,
                verification_url: None,
                interval: None,
            }
        } else {
            let result = self
                .exchange(
                    &self.endpoints.device,
                    &client,
                    [("scope".into(), pending.scopes.join(" "))].into(),
                )
                .await;
            let challenge = match result {
                Ok(r) if (200..300).contains(&r.status) => r.body,
                _ => {
                    self.cancel(&pending.id)?;
                    return Err("Google device authorization failed".into());
                }
            };
            let code = challenge
                .get("device_code")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("invalid Google device response")?;
            let user_code = challenge
                .get("user_code")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("invalid Google device response")?;
            let verification = challenge
                .get("verification_url")
                .or_else(|| challenge.get("verification_uri"))
                .and_then(Value::as_str)
                .unwrap_or("https://www.google.com/device");
            let interval = challenge
                .get("interval")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .max(5);
            let expires_at = now().saturating_add(
                challenge
                    .get("expires_in")
                    .and_then(Value::as_u64)
                    .unwrap_or(1800)
                    .saturating_mul(1000),
            );
            self.edit(|state| {
                let p = state
                    .pending
                    .iter_mut()
                    .find(|p| p.id == pending.id)
                    .ok_or(STALE)?;
                p.device_code = code.into();
                p.interval = interval;
                p.expires_at = expires_at;
                Ok(())
            })?;
            Attempt {
                attempt_id: pending.id,
                expires_at,
                authorize_url: None,
                user_code: Some(user_code.into()),
                verification_url: Some(verification.into()),
                interval: Some(interval),
            }
        };
        let mut reply = self.snapshot()?;
        reply.attempt = Some(attempt);
        Ok(reply)
    }
    fn claim(
        &self,
        requested: &str,
        client: Option<&str>,
        device: bool,
        at: u64,
    ) -> Result<Pending, String> {
        self.edit(|state| {
            let p = state
                .pending
                .iter_mut()
                .find(|p| {
                    if device {
                        p.id == requested
                    } else {
                        p.state == requested
                    }
                })
                .ok_or(MISMATCH)?;
            if p.claimed
                || p.expires_at <= at
                || (device != (p.method == Method::DeviceCode))
                || client.is_some_and(|c| c != p.client_id)
            {
                return Err(MISMATCH.into());
            }
            p.claimed = true;
            Ok(p.clone())
        })
    }
    fn cancel(&self, attempt: &str) -> Result<(), String> {
        self.edit(|state| {
            state.pending.retain(|p| p.id != attempt);
            Ok(())
        })
    }
    fn commit(
        &self,
        attempt: &Pending,
        tokens: Tokens,
        sub: String,
        email: Option<String>,
    ) -> Result<(), String> {
        self.edit(|state| {
            let target = (|| -> Result<Option<usize>, String> {
                if !state
                    .pending
                    .iter()
                    .any(|p| p.id == attempt.id && p.claimed && p.expires_at > now())
                {
                    return Err(STALE.into());
                }
                if state
                    .disconnect_barriers
                    .get(&attempt.client_id)
                    .and_then(|barriers| barriers.get(&sub))
                    .is_some_and(|generation| *generation > attempt.disconnect_generation)
                {
                    return Err(STALE.into());
                }
                if let Some(id) = &attempt.reauthorize_lineage {
                    let target = state.lineages.iter().find(|l| &l.id == id).ok_or(STALE)?;
                    if Some(&target.authorization) != attempt.start_authorization.as_ref()
                        || self.blocked.lock().contains(id)
                    {
                        return Err(STALE.into());
                    }
                    // Reauthorization is bound to the selected account, except a
                    // provisional legacy identity which has never had a Google sub.
                    if !target.needs_identity && target.sub != sub {
                        return Err(MISMATCH.into());
                    }
                }
                let target = state
                    .lineages
                    .iter()
                    .position(|l| {
                        l.client_id == attempt.client_id && l.sub == sub && !l.needs_identity
                    })
                    .or_else(|| {
                        attempt
                            .reauthorize_lineage
                            .as_ref()
                            .and_then(|id| state.lineages.iter().position(|l| &l.id == id))
                    });
                if let Some(index) = target {
                    let lineage = &state.lineages[index];
                    // Absence is stale too: another attempt may have created this
                    // lineage, then disconnected it, after this attempt's Begin.
                    if attempt.lineage_revisions.get(&lineage.id) != Some(&lineage.authorization)
                        || self.blocked.lock().contains(&lineage.id)
                    {
                        return Err(STALE.into());
                    }
                }
                Ok(target)
            })();
            let target = match target {
                Ok(target) => target,
                Err(error) => {
                    // Persist rejection and single-use consumption in one CAS.
                    // Returning Err from edit itself would roll this deletion back.
                    state.pending.retain(|p| p.id != attempt.id);
                    return Ok(Err(error));
                }
            };
            let index = if let Some(index) = target {
                index
            } else {
                state.lineages.push(Lineage {
                    id: nonce(),
                    client_id: attempt.client_id.clone(),
                    method: attempt.method,
                    scopes: vec![],
                    sub: sub.clone(),
                    email: None,
                    status: Status::Connected,
                    authorization: nonce(),
                    credential_revision: nonce(),
                    needs_identity: false,
                    identity_attempted: true,
                    tokens: None,
                });
                state.lineages.len() - 1
            };
            let committed_id = state.lineages[index].id.clone();
            if let Some(obsolete) = attempt.reauthorize_lineage.as_ref().and_then(|id| {
                state
                    .lineages
                    .iter_mut()
                    .find(|l| &l.id == id && l.id != committed_id)
            }) {
                obsolete.status = Status::Disconnected;
                obsolete.tokens = None;
                obsolete.authorization = nonce();
                obsolete.credential_revision = nonce();
            }
            let lineage = &mut state.lineages[index];
            let live_grant = lineage.status == Status::Connected && lineage.tokens.is_some();
            let previous = lineage
                .tokens
                .as_ref()
                .and_then(|t| t.refresh_token.clone());
            let mut tokens = tokens;
            if tokens.refresh_token.is_none() {
                tokens.refresh_token = previous;
            }
            // Google reports the grant's full scope set (loopback asks for
            // include_granted_scopes), so a reported scope replaces history. Only
            // a live grant can carry earlier scopes into a reply that omits it;
            // a disconnected or invalidated grant keeps nothing it had.
            lineage.scopes = match &tokens.scope {
                Some(scope) => scope.split_whitespace().map(str::to_owned).collect(),
                None if live_grant => {
                    let mut scopes = std::mem::take(&mut lineage.scopes);
                    scopes.extend(attempt.scopes.clone());
                    scopes
                }
                None => attempt.scopes.clone(),
            };
            lineage.scopes.sort();
            lineage.scopes.dedup();
            lineage.sub = sub;
            lineage.email = email.or(lineage.email.clone());
            lineage.method = attempt.method;
            lineage.needs_identity = false;
            lineage.identity_attempted = true;
            lineage.status = Status::Connected;
            lineage.authorization = nonce();
            lineage.credential_revision = nonce();
            lineage.tokens = Some(tokens);
            state.pending.retain(|p| p.id != attempt.id);
            Ok(Ok(()))
        })?
    }
    async fn complete(
        &self,
        state: String,
        code: String,
        client: Option<String>,
    ) -> Result<Reply, String> {
        if code.trim().is_empty() {
            return Err("missing Google authorization code".into());
        }
        let pending = self.claim(&state, client.as_deref(), false, now())?;
        let response = self
            .exchange(
                &self.endpoints.token,
                &pending.client_id,
                [
                    ("code".into(), code),
                    ("code_verifier".into(), pending.verifier.clone()),
                    ("redirect_uri".into(), pending.redirect_uri.clone()),
                    ("grant_type".into(), "authorization_code".into()),
                ]
                .into(),
            )
            .await?;
        if !(200..300).contains(&response.status) {
            self.cancel(&pending.id)?;
            return Err("Google authorization exchange failed".into());
        }
        let tokens = parse_tokens(&response.body, None)?;
        let (sub, email) = self
            .identify(&response.body, &tokens.access_token, &pending.client_id)
            .await?;
        self.commit(&pending, tokens, sub, email)?;
        self.snapshot()
    }
    async fn poll(&self, id: String) -> Result<Reply, String> {
        let expired = self
            .store
            .load()?
            .state
            .pending
            .iter()
            .any(|p| p.id == id && p.expires_at <= now());
        if expired {
            self.cancel(&id)?;
            let mut reply = self.snapshot()?;
            reply.poll_status = Some(PollStatus::Expired);
            return Ok(reply);
        }
        let p = self.claim(&id, None, true, now())?;
        let result = self
            .exchange(
                &self.endpoints.token,
                &p.client_id,
                [
                    ("device_code".into(), p.device_code.clone()),
                    (
                        "grant_type".into(),
                        "urn:ietf:params:oauth:grant-type:device_code".into(),
                    ),
                ]
                .into(),
            )
            .await;
        let response = match result {
            Ok(r) => r,
            Err(e) => {
                self.release_poll(&id, false)?;
                return Err(e);
            }
        };
        let status = match response.body.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {
                self.release_poll(&id, false)?;
                PollStatus::Pending
            }
            Some("slow_down") => {
                self.release_poll(&id, true)?;
                PollStatus::SlowDown
            }
            Some("access_denied") => {
                self.cancel(&id)?;
                PollStatus::Denied
            }
            Some("expired_token") => {
                self.cancel(&id)?;
                PollStatus::Expired
            }
            Some(_) => {
                self.cancel(&id)?;
                return Err("Google device authorization failed".into());
            }
            None if (200..300).contains(&response.status) => {
                let tokens = parse_tokens(&response.body, None)?;
                let (sub, email) = self
                    .identify(&response.body, &tokens.access_token, &p.client_id)
                    .await?;
                self.commit(&p, tokens, sub, email)?;
                PollStatus::Connected
            }
            _ => {
                self.release_poll(&id, false)?;
                return Err("Google device token request failed".into());
            }
        };
        let mut reply = self.snapshot()?;
        reply.poll_status = Some(status);
        Ok(reply)
    }
    fn release_poll(&self, id: &str, slow: bool) -> Result<(), String> {
        self.edit(|state| {
            let p = state.pending.iter_mut().find(|p| p.id == id).ok_or(STALE)?;
            p.claimed = false;
            if slow {
                p.interval = p.interval.saturating_add(5);
            }
            Ok(())
        })
    }
    async fn access(&self, id: String, min_validity: u64, notify: Notify) -> Result<Reply, String> {
        let lock = self
            .refresh_locks
            .lock()
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _refresh = lock.lock().await;
        if self.blocked.lock().contains(&id) {
            return Err(STALE.into());
        }
        let initial = self
            .store
            .load()?
            .state
            .lineages
            .iter()
            .find(|l| l.id == id)
            .cloned()
            .ok_or("Google connection unavailable")?;
        if initial.status != Status::Connected {
            return Err("Google connection needs reauthorization".into());
        }
        let current = initial
            .tokens
            .as_ref()
            .ok_or("Google connection needs reauthorization")?;
        if current.expires_at.saturating_sub(now()) < min_validity || current.expires_at <= now() {
            let refresh = current
                .refresh_token
                .clone()
                .ok_or("Google connection needs reauthorization")?;
            let response = self
                .exchange(
                    &self.endpoints.token,
                    &initial.client_id,
                    [
                        ("refresh_token".into(), refresh.clone()),
                        ("grant_type".into(), "refresh_token".into()),
                    ]
                    .into(),
                )
                .await?;
            if response.body.get("error").and_then(Value::as_str) == Some("invalid_grant") {
                self.edit(|state| {
                    let l = state
                        .lineages
                        .iter_mut()
                        .find(|l| {
                            l.id == id
                                && l.authorization == initial.authorization
                                && l.credential_revision == initial.credential_revision
                                && l.status == Status::Connected
                        })
                        .ok_or(STALE)?;
                    if self.blocked.lock().contains(&id) {
                        return Err(STALE.into());
                    }
                    l.status = Status::NeedsReauth;
                    l.authorization = nonce();
                    l.credential_revision = nonce();
                    l.tokens = None;
                    Ok(())
                })?;
                notify();
                return Err("Google connection needs reauthorization".into());
            }
            if !(200..300).contains(&response.status) {
                return Err("Google token refresh failed".into());
            }
            let tokens = parse_tokens(&response.body, Some(refresh))?;
            self.edit(|state| {
                let l = state
                    .lineages
                    .iter_mut()
                    .find(|l| {
                        l.id == id
                            && l.authorization == initial.authorization
                            && l.credential_revision == initial.credential_revision
                            && l.status == Status::Connected
                    })
                    .ok_or(STALE)?;
                if self.blocked.lock().contains(&id) {
                    return Err(STALE.into());
                }
                l.tokens = Some(tokens);
                l.credential_revision = nonce();
                Ok(())
            })?;
            notify();
        }
        let mut reply = self.snapshot()?;
        let state = self.store.load()?.state;
        let l = state
            .lineages
            .iter()
            .find(|l| {
                l.id == id
                    && l.authorization == initial.authorization
                    && l.status == Status::Connected
            })
            .ok_or(STALE)?;
        if self.blocked.lock().contains(&id) {
            return Err(STALE.into());
        }
        let tokens = l.tokens.as_ref().ok_or(STALE)?;
        reply.credential = Some(Credential {
            access_token: tokens.access_token.clone(),
            expires_at: tokens.expires_at,
            revision: l.authorization.clone(),
            credential_revision: l.credential_revision.clone(),
        });
        Ok(reply)
    }
    async fn disconnect(&self, id: String, notify: Notify) -> Result<Reply, String> {
        // Kept in memory even if persistence fails; stale jobs in this process
        // cannot publish a credential after a failed fence write.
        let lock = self
            .disconnect_locks
            .lock()
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _disconnect = lock.lock().await;
        self.blocked.lock().insert(id.clone());
        let _barrier = self.grants.read().await;
        let token = self.edit(|state| {
            let l = state
                .lineages
                .iter_mut()
                .find(|l| l.id == id)
                .ok_or("Google connection unavailable")?;
            let token = l.tokens.as_ref().map(|t| {
                t.refresh_token
                    .clone()
                    .unwrap_or_else(|| t.access_token.clone())
            });
            l.authorization = nonce();
            l.credential_revision = nonce();
            l.status = Status::Disconnected;
            let client_id = l.client_id.clone();
            let sub = l.sub.clone();
            let unresolved_identity = l.needs_identity;
            state.disconnect_generation = state
                .disconnect_generation
                .checked_add(1)
                .ok_or("Google disconnect generation exhausted")?;
            state
                .disconnect_barriers
                .entry(client_id.clone())
                .or_default()
                .insert(sub, state.disconnect_generation);
            // A provisional sub cannot key a barrier for the eventual real sub.
            // Consume this client's existing attempts while identity is unknown.
            state.pending.retain(|p| {
                p.reauthorize_lineage.as_ref() != Some(&id)
                    && (!unresolved_identity || p.client_id != client_id)
            });
            Ok(token)
        })?;
        notify(); // Durable fence precedes any network effect.
        let outcome = if let Some(token) = token {
            match crate::http_client::http_request(revocation_request(
                self.endpoints.revoke.clone(),
                token,
            )?)
            .await
            {
                Ok(response) => match classify_revocation(response.status, &response.body) {
                    Ok(revoked) => Outcome {
                        revoked,
                        reason: None,
                    },
                    Err(reason) => Outcome {
                        revoked: false,
                        reason: Some(reason),
                    },
                },
                Err(_) => Outcome {
                    revoked: false,
                    reason: Some("Google token revocation failed".into()),
                },
            }
        } else {
            Outcome {
                revoked: false,
                reason: Some("not-connected".into()),
            }
        };
        self.edit(|state| {
            if let Some(l) = state
                .lineages
                .iter_mut()
                .find(|l| l.id == id && l.status == Status::Disconnected)
            {
                l.tokens = None;
            }
            Ok(())
        })?;
        self.blocked.lock().remove(&id);
        let mut reply = self.snapshot()?;
        reply.outcome = Some(outcome);
        Ok(reply)
    }
    async fn run(self: Arc<Self>, input: Input, notify: Notify) -> Result<Reply, String> {
        // Access and disconnect signal their own commits (the disconnect fence
        // must be visible before revoke), so they skip the store comparison.
        let input = match input {
            Input::AccessToken {
                lineage_id,
                min_validity_ms,
            } => {
                return self
                    .access(lineage_id, min_validity_ms.unwrap_or(60_000), notify)
                    .await
            }
            Input::Disconnect { lineage_id } => return self.disconnect(lineage_id, notify).await,
            other => other,
        };
        // Every other action signals only when it actually moved the stored
        // revision: a refused callback or a no-op write is not a change.
        let before = self.store.load()?.expected;
        let reply = match input {
            Input::Snapshot { legacy_client_id } => {
                async {
                    self.migrate(legacy_client_id)?;
                    self.resolve_legacy_identities().await?;
                    self.snapshot()
                }
                .await
            }
            Input::SetClientSecret { client_id, secret } => {
                validate_client(&client_id)?;
                if secret.trim().is_empty() {
                    return Err("empty Google client secret".into());
                }
                self.edit(|state| {
                    state.secret_overrides.insert(client_id.clone());
                    state.clients.insert(client_id, secret);
                    Ok(())
                })?;
                self.snapshot()
            }
            Input::ClearClientSecret { client_id } => {
                validate_client(&client_id)?;
                self.edit(|state| {
                    state.secret_overrides.insert(client_id.clone());
                    state.clients.remove(&client_id);
                    Ok(())
                })?;
                self.snapshot()
            }
            Input::Begin {
                client_id,
                scopes,
                reauthorize_lineage,
                redirect_uri,
            } => {
                self.begin(
                    client_id,
                    scopes,
                    reauthorize_lineage,
                    redirect_uri,
                    Method::LoopbackPkce,
                )
                .await
            }
            Input::BeginDevice {
                client_id,
                scopes,
                reauthorize_lineage,
            } => {
                self.begin(
                    client_id,
                    scopes,
                    reauthorize_lineage,
                    None,
                    Method::DeviceCode,
                )
                .await
            }
            Input::Complete {
                state,
                code,
                client_id,
            } => self.complete(state, code, client_id).await,
            Input::PollDevice { attempt_id } => self.poll(attempt_id).await,
            Input::Cancel { attempt_id } => self.cancel(&attempt_id).and_then(|()| self.snapshot()),
            Input::AccessToken { .. } | Input::Disconnect { .. } => unreachable!("handled above"),
        };
        if self
            .store
            .load()
            .map_or(true, |stored| stored.expected != before)
        {
            notify();
        }
        reply
    }
}
fn parse_tokens(body: &Map<String, Value>, previous: Option<String>) -> Result<Tokens, String> {
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("invalid Google token response")?
        .into();
    Ok(Tokens {
        access_token,
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(previous),
        expires_at: now().saturating_add(
            body.get("expires_in")
                .and_then(Value::as_u64)
                .unwrap_or(3600)
                .saturating_mul(1000),
        ),
        scope: body.get("scope").and_then(Value::as_str).map(str::to_owned),
    })
}
fn revocation_request(
    url: String,
    token: String,
) -> Result<crate::types::TauriHttpRequest, String> {
    Ok(crate::types::TauriHttpRequest {
        url,
        method: "POST".into(),
        headers: Some(
            [(
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            )]
            .into(),
        ),
        body: Some(
            serde_urlencoded::to_string([("token", token)])
                .map_err(|_| "Google revoke request failed")?,
        ),
        timeout_ms: Some(30_000),
        allow_invalid_certificates: None,
    })
}
fn classify_revocation(status: u16, body: &str) -> Result<bool, String> {
    let parsed = serde_json::from_str::<Value>(body).ok();
    if (200..300).contains(&status)
        || parsed
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
            == Some("invalid_token")
    {
        return Ok(true);
    }
    // Remote error descriptions can echo tokens. Only a static diagnostic leaves
    // the credential owner, never the arbitrary response body.
    Err(format!("Google returned HTTP {status}"))
}
fn controller() -> &'static Arc<Controller> {
    static OWNER: OnceLock<Arc<Controller>> = OnceLock::new();
    OWNER.get_or_init(|| {
        Arc::new(Controller::new(
            Arc::new(EncryptedStore),
            Endpoints::default(),
        ))
    })
}
/// The host task survives RPC/WebView cancellation and has bounded HTTP waits.
pub async fn execute_with_notify(input: Input, notify: Notify) -> Result<Reply, String> {
    let owner = controller().clone();
    tokio::spawn(async move { owner.run(input, notify).await })
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    struct MemoryStore {
        raw: Mutex<Option<String>>,
        legacy_secret: Mutex<Option<String>>,
        fail: AtomicBool,
        saves: AtomicUsize,
    }
    impl Store for MemoryStore {
        fn load(&self) -> Result<Stored, String> {
            let expected = self.raw.lock().clone();
            let state = expected
                .as_ref()
                .map(|r| serde_json::from_str(r).unwrap())
                .unwrap_or_else(State::empty);
            Ok(Stored { state, expected })
        }
        fn save(&self, state: &State, expected: Option<String>) -> Result<(), String> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err("fixture write failure".into());
            }
            let mut raw = self.raw.lock();
            if *raw != expected {
                return Err(STALE.into());
            }
            *raw = Some(serde_json::to_string(state).unwrap());
            if state.legacy_secret_migrated {
                self.legacy_secret.lock().take();
            }
            self.saves.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn legacy_secret(&self) -> Result<Option<String>, String> {
            Ok(self.legacy_secret.lock().clone())
        }
    }
    fn quiet() -> Notify {
        Arc::new(|| {})
    }
    fn memory(state: State) -> Arc<MemoryStore> {
        Arc::new(MemoryStore {
            raw: Mutex::new(Some(serde_json::to_string(&state).unwrap())),
            legacy_secret: Mutex::new(None),
            fail: AtomicBool::new(false),
            saves: AtomicUsize::new(0),
        })
    }
    fn fixture() -> (Arc<Controller>, Arc<MemoryStore>) {
        let mut state = State::empty();
        state
            .clients
            .insert("client-a".into(), "private-secret-a".into());
        state
            .clients
            .insert("client-b".into(), "private-secret-b".into());
        let store = memory(state);
        (
            Arc::new(Controller::new(store.clone(), Endpoints::default())),
            store,
        )
    }
    fn tokens(access: &str) -> Tokens {
        Tokens {
            access_token: access.into(),
            refresh_token: Some(format!("refresh-{access}")),
            expires_at: now() + 3_600_000,
            scope: None,
        }
    }
    fn pending(client: &str) -> Pending {
        Pending {
            id: nonce(),
            client_id: client.into(),
            method: Method::LoopbackPkce,
            scopes: vec!["openid".into(), "email".into(), "docs".into()],
            expires_at: now() + TTL_MS,
            reauthorize_lineage: None,
            start_authorization: None,
            claimed: false,
            state: format!("google:{}", nonce()),
            verifier: "private-code-verifier".into(),
            redirect_uri: default_redirect(),
            device_code: "private-device-code".into(),
            interval: 5,
            lineage_revisions: BTreeMap::new(),
            disconnect_generation: 0,
        }
    }
    fn staged(owner: &Controller, mut attempt: Pending) -> Pending {
        owner
            .edit(|state| {
                attempt.disconnect_generation = state.disconnect_generation;
                attempt.lineage_revisions = state
                    .lineages
                    .iter()
                    .filter(|l| l.client_id == attempt.client_id)
                    .map(|l| (l.id.clone(), l.authorization.clone()))
                    .collect();
                state.pending.push(attempt.clone());
                Ok(())
            })
            .unwrap();
        let device = attempt.method == Method::DeviceCode;
        owner
            .claim(
                if device { &attempt.id } else { &attempt.state },
                Some(&attempt.client_id),
                device,
                now(),
            )
            .unwrap()
    }
    fn connected(owner: &Controller, client: &str, sub: &str) -> Lineage {
        let p = staged(owner, pending(client));
        owner
            .commit(
                &p,
                tokens("access-private"),
                sub.into(),
                Some("user@example.test".into()),
            )
            .unwrap();
        owner
            .store
            .load()
            .unwrap()
            .state
            .lineages
            .into_iter()
            .find(|l| l.client_id == client && l.sub == sub)
            .unwrap()
    }
    fn init_proxy() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        });
    }
    async fn network_fixture() -> (Arc<Controller>, Arc<MemoryStore>, MockServer) {
        init_proxy();
        let server = MockServer::start().await;
        let (_, store) = fixture();
        let base = server.uri();
        let endpoints = Endpoints {
            token: format!("{base}/token"),
            device: format!("{base}/device"),
            userinfo: format!("{base}/userinfo"),
            revoke: format!("{base}/revoke"),
        };
        (
            Arc::new(Controller::new(store.clone(), endpoints)),
            store,
            server,
        )
    }
    fn token_body() -> Value {
        serde_json::json!({"access_token":"rotated-access", "refresh_token":"rotated-refresh", "expires_in":3600, "id_token":format!("header.{}.signature", URL_SAFE_NO_PAD.encode(br#"{"sub":"principal-a","email":"user@example.test","aud":"client-a"}"#))})
    }
    #[test]
    fn google_loopback_claim_is_single_use_expiring_and_bound_to_client() {
        let (owner, _) = fixture();
        let p = pending("client-a");
        owner
            .edit(|s| {
                s.pending.push(p.clone());
                Ok(())
            })
            .unwrap();
        assert!(owner
            .claim(&p.state, Some("client-b"), false, now())
            .is_err());
        assert!(owner
            .claim("google:unknown", Some("client-a"), false, now())
            .is_err());
        assert!(owner.claim(&p.state, None, false, p.expires_at).is_err());
        assert!(owner
            .claim(&p.state, Some("client-a"), false, now())
            .is_ok());
        assert!(owner
            .claim(&p.state, Some("client-a"), false, now())
            .is_err());
        assert!(validate_redirect("https://example.com/oauth/docs/google/callback").is_err());
        assert!(validate_redirect("http://127.0.0.1:7842/wrong").is_err());
        assert!(validate_redirect(&default_redirect()).is_ok());
    }
    #[test]
    fn google_same_client_principal_adds_scopes_different_client_creates_lineage() {
        let (owner, _) = fixture();
        let original = connected(&owner, "client-a", "principal-a");
        let mut p = pending("client-a");
        p.scopes.push("drive".into());
        let p = staged(&owner, p);
        owner
            .commit(&p, tokens("new"), "principal-a".into(), None)
            .unwrap();
        let s = owner.store.load().unwrap().state;
        assert_eq!(s.lineages.len(), 1);
        let updated = &s.lineages[0];
        assert_eq!(updated.id, original.id);
        assert_ne!(updated.authorization, original.authorization);
        assert!(updated.scopes.contains(&"drive".into()));
        connected(&owner, "client-b", "principal-a");
        assert_eq!(owner.store.load().unwrap().state.lineages.len(), 2);
    }
    #[test]
    fn google_explicit_scopes_do_not_grant_scopes_the_vendor_omitted() {
        let (owner, _) = fixture();
        let p = staged(&owner, pending("client-a"));
        let mut t = tokens("narrow");
        t.scope = Some("openid email".into());
        owner.commit(&p, t, "principal-a".into(), None).unwrap();
        assert_eq!(
            owner.snapshot().unwrap().lineages[0].scopes,
            vec!["email", "openid"]
        );
    }
    #[test]
    fn google_reauthorizing_a_dead_grant_keeps_none_of_its_old_scopes() {
        let (owner, _) = fixture();
        let mut wide = pending("client-a");
        wide.scopes.push("drive".into());
        let wide = staged(&owner, wide);
        owner
            .commit(&wide, tokens("wide"), "principal-a".into(), None)
            .unwrap();
        for status in [Status::Disconnected, Status::NeedsReauth] {
            owner
                .edit(|s| {
                    s.lineages[0].status = status;
                    s.lineages[0].tokens = None;
                    Ok(())
                })
                .unwrap();
            let p = staged(&owner, pending("client-a"));
            let mut narrow = tokens("narrow");
            narrow.scope = Some("openid email".into());
            owner
                .commit(&p, narrow, "principal-a".into(), None)
                .unwrap();
            assert_eq!(
                owner.snapshot().unwrap().lineages[0].scopes,
                vec!["email", "openid"]
            );
            owner
                .edit(|s| {
                    s.lineages[0].status = status;
                    s.lineages[0].tokens = None;
                    s.lineages[0].scopes.push("drive".into());
                    Ok(())
                })
                .unwrap();
            let p = staged(&owner, pending("client-a"));
            owner
                .commit(&p, tokens("unreported"), "principal-a".into(), None)
                .unwrap();
            assert_eq!(
                owner.snapshot().unwrap().lineages[0].scopes,
                vec!["docs", "email", "openid"],
                "an omitted scope falls back to the request, not the dead grant"
            );
        }
    }
    #[test]
    fn google_snapshot_never_serializes_token_secret_or_pending_verifier() {
        let (owner, _) = fixture();
        connected(&owner, "client-a", "principal-a");
        let p = pending("client-a");
        owner
            .edit(|s| {
                s.pending.push(p);
                Ok(())
            })
            .unwrap();
        let wire = serde_json::to_string(&owner.snapshot().unwrap()).unwrap();
        for private in [
            "access-private",
            "refresh-access-private",
            "private-secret-a",
            "private-secret-b",
            "private-code-verifier",
            "private-device-code",
        ] {
            assert!(!wire.contains(private), "snapshot leaked {private}");
        }
        assert!(wire.contains("hasClientSecret"));
        assert!(!wire.contains("accessToken"));
        assert!(!wire.contains("refreshToken"));
        assert!(!wire.contains("codeVerifier"));
    }
    #[tokio::test]
    async fn google_secrets_are_write_only_and_clear_cannot_be_undone_by_legacy_import() {
        let (owner, store) = fixture();
        *store.legacy_secret.lock() = Some("old-secret".into());
        let reply = owner
            .clone()
            .run(
                Input::SetClientSecret {
                    client_id: "client-a".into(),
                    secret: "new-private".into(),
                },
                quiet(),
            )
            .await
            .unwrap();
        assert!(!serde_json::to_string(&reply)
            .unwrap()
            .contains("new-private"));
        owner
            .clone()
            .run(
                Input::ClearClientSecret {
                    client_id: "client-a".into(),
                },
                quiet(),
            )
            .await
            .unwrap();
        owner.migrate(Some("client-a".into())).unwrap();
        assert!(!owner
            .store
            .load()
            .unwrap()
            .state
            .clients
            .contains_key("client-a"));
        assert!(store.legacy_secret.lock().is_none());
        assert!(!owner
            .snapshot()
            .unwrap()
            .clients
            .iter()
            .any(|c| c.client_id == "client-a" && c.has_client_secret));
    }
    #[tokio::test]
    async fn google_snapshot_noop_has_no_write_or_changed_event_loop() {
        let (owner, store) = fixture();
        let called = Arc::new(AtomicUsize::new(0));
        let observed = called.clone();
        let notify: Notify = Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        owner
            .clone()
            .run(
                Input::Snapshot {
                    legacy_client_id: None,
                },
                notify.clone(),
            )
            .await
            .unwrap();
        owner
            .clone()
            .run(
                Input::Snapshot {
                    legacy_client_id: None,
                },
                notify,
            )
            .await
            .unwrap();
        assert_eq!(store.saves.load(Ordering::SeqCst), 0);
        assert_eq!(called.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn google_refused_callback_signals_nothing_but_a_secret_write_signals_once() {
        let (owner, store) = fixture();
        let called = Arc::new(AtomicUsize::new(0));
        let observed = called.clone();
        let notify: Notify = Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let refused = owner
            .clone()
            .run(
                Input::Complete {
                    state: "google:deliberate-mismatch".into(),
                    code: "unused".into(),
                    client_id: None,
                },
                notify.clone(),
            )
            .await;
        assert!(refused.is_err());
        assert_eq!(store.saves.load(Ordering::SeqCst), 0);
        assert_eq!(called.load(Ordering::SeqCst), 0);
        owner
            .clone()
            .run(
                Input::SetClientSecret {
                    client_id: "client.apps.googleusercontent.com".into(),
                    secret: "deliberate-secret-value".into(),
                },
                notify,
            )
            .await
            .unwrap();
        assert_eq!(called.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn google_legacy_lineage_and_secret_migrate_once_and_require_client_hint() {
        for key in [STATE_KEY, LEGACY_KEY, LEGACY_SECRET, "google-tokens"] {
            keyring_secrets::clear(NAMESPACE, key).unwrap();
        }
        keyring_secrets::set(NAMESPACE, LEGACY_KEY, r#"{"version":1,"connection":"old-credential","authorization":"old-auth","tokens":{"accessToken":"legacy-access","refreshToken":"legacy-refresh","expiresAt":10000,"scope":"docs"},"accountEmail":"legacy@example.test","legacyMetadata":false}"#).unwrap();
        keyring_secrets::set(NAMESPACE, LEGACY_SECRET, "legacy-secret").unwrap();
        let owner = Controller::new(Arc::new(EncryptedStore), Endpoints::default());
        owner.migrate(None).unwrap();
        assert!(owner.snapshot().unwrap().migration_needs_client_id);
        assert!(keyring_secrets::get(NAMESPACE, LEGACY_SECRET)
            .unwrap()
            .is_some());
        owner.migrate(Some("client-a".into())).unwrap();
        owner.migrate(Some("client-b".into())).unwrap();
        let state = owner.store.load().unwrap().state;
        assert_eq!(state.lineages.len(), 1);
        let l = &state.lineages[0];
        assert_eq!(l.client_id, "client-a");
        assert!(l.sub.starts_with("legacy:"));
        assert!(l.needs_identity);
        assert_eq!(
            l.tokens.as_ref().unwrap().refresh_token.as_deref(),
            Some("legacy-refresh")
        );
        assert_eq!(state.clients["client-a"], "legacy-secret");
        assert!(!state.clients.contains_key("client-b"));
        assert!(keyring_secrets::get(NAMESPACE, LEGACY_KEY)
            .unwrap()
            .is_none());
        assert!(keyring_secrets::get(NAMESPACE, LEGACY_SECRET)
            .unwrap()
            .is_none());
        // A leftover pre-v1 TS key cannot resurrect a disconnected lineage.
        owner
            .edit(|s| {
                s.lineages[0].tokens = None;
                s.lineages[0].status = Status::Disconnected;
                Ok(())
            })
            .unwrap();
        keyring_secrets::set(
            NAMESPACE,
            "google-tokens",
            r#"{"accessToken":"resurrected","expiresAt":1}"#,
        )
        .unwrap();
        assert!(owner.store.load().unwrap().state.lineages[0]
            .tokens
            .is_none());
        for key in [STATE_KEY, LEGACY_KEY, LEGACY_SECRET, "google-tokens"] {
            keyring_secrets::clear(NAMESPACE, key).unwrap();
        }
    }
    #[test]
    fn google_nonce_cas_rejects_late_attempt_for_disconnected_identity_only() {
        let (owner, _) = fixture();
        let original = connected(&owner, "client-a", "principal-a");
        let late = staged(&owner, pending("client-a"));
        let other = staged(&owner, pending("client-a"));
        owner
            .edit(|s| {
                s.lineages[0].authorization = nonce();
                s.lineages[0].status = Status::Disconnected;
                s.lineages[0].tokens = None;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            owner
                .commit(&late, tokens("late"), "principal-a".into(), None)
                .err()
                .as_deref(),
            Some(STALE)
        );
        owner
            .commit(&other, tokens("other"), "principal-b".into(), None)
            .unwrap();
        let s = owner.store.load().unwrap().state;
        assert_eq!(s.lineages.len(), 2);
        assert!(s
            .lineages
            .iter()
            .find(|l| l.id == original.id)
            .unwrap()
            .tokens
            .is_none());
    }
    async fn late_attempt_after_new_lineage_disconnect(method: Method) {
        for remove_lineage in [false, true] {
            let (owner, store) = fixture();
            let mut attempt = pending("client-a");
            attempt.method = method;
            let attempt = staged(&owner, attempt);
            assert!(attempt.lineage_revisions.is_empty());
            let created = connected(&owner, "client-a", "principal-a");
            // No revoke HTTP request is needed to exercise the real durable
            // disconnect transaction and its post-revoke state in this test.
            owner
                .edit(|s| {
                    s.lineages[0].tokens = None;
                    Ok(())
                })
                .unwrap();
            owner.disconnect(created.id, quiet()).await.unwrap();
            if remove_lineage {
                owner
                    .edit(|s| {
                        s.lineages.clear();
                        Ok(())
                    })
                    .unwrap();
            }
            // A process restart must not discard the disconnect barrier.
            let restarted = Controller::new(store.clone(), Endpoints::default());
            assert_eq!(
                restarted
                    .commit(&attempt, tokens("late-access"), "principal-a".into(), None)
                    .err()
                    .as_deref(),
                Some(STALE)
            );
            let state = store.load().unwrap().state;
            assert!(state.pending.iter().all(|p| p.id != attempt.id));
            assert!(state.lineages.iter().all(|l| l.tokens.is_none()));
            assert!(state
                .lineages
                .iter()
                .all(|l| l.status == Status::Disconnected));
        }
    }
    #[tokio::test]
    async fn google_disconnect_barrier_rejects_late_complete_for_new_or_missing_lineage() {
        late_attempt_after_new_lineage_disconnect(Method::LoopbackPkce).await;
    }
    #[tokio::test]
    async fn google_disconnect_barrier_rejects_late_device_poll_for_new_or_missing_lineage() {
        late_attempt_after_new_lineage_disconnect(Method::DeviceCode).await;
    }
    #[tokio::test]
    async fn google_disconnect_barrier_preserves_unrelated_attempts() {
        for method in [Method::LoopbackPkce, Method::DeviceCode] {
            for (client, sub) in [("client-a", "principal-b"), ("client-b", "principal-a")] {
                let (owner, store) = fixture();
                let mut attempt = pending("client-a");
                attempt.method = method;
                let attempt = staged(&owner, attempt);
                let unrelated = connected(&owner, client, sub);
                owner
                    .edit(|s| {
                        s.lineages[0].tokens = None;
                        Ok(())
                    })
                    .unwrap();
                owner
                    .disconnect(unrelated.id.clone(), quiet())
                    .await
                    .unwrap();
                owner
                    .commit(&attempt, tokens("new-access"), "principal-a".into(), None)
                    .unwrap();
                let state = store.load().unwrap().state;
                let connected = state
                    .lineages
                    .iter()
                    .find(|l| l.client_id == "client-a" && l.sub == "principal-a")
                    .unwrap();
                assert!(connected.status == Status::Connected);
                assert_eq!(
                    connected.tokens.as_ref().unwrap().access_token,
                    "new-access"
                );
                assert!(
                    state
                        .lineages
                        .iter()
                        .find(|l| l.id == unrelated.id)
                        .unwrap()
                        .status
                        == Status::Disconnected
                );
                assert!(state.pending.is_empty());
            }
        }
    }
    #[test]
    fn google_disconnect_barrier_refuses_existing_lineage_absent_from_begin_snapshot() {
        let (owner, store) = fixture();
        let attempt = staged(&owner, pending("client-a"));
        let created = connected(&owner, "client-a", "principal-a");
        assert_eq!(
            owner
                .commit(&attempt, tokens("late-access"), "principal-a".into(), None)
                .err()
                .as_deref(),
            Some(STALE)
        );
        let state = store.load().unwrap().state;
        assert!(state.pending.is_empty());
        assert_eq!(state.lineages.len(), 1);
        assert_eq!(state.lineages[0].authorization, created.authorization);
        assert_eq!(
            state.lineages[0].tokens.as_ref().unwrap().access_token,
            "access-private"
        );
    }
    #[tokio::test]
    async fn google_disconnect_barrier_allows_a_fresh_begin_after_disconnect() {
        let (owner, store) = fixture();
        let original = connected(&owner, "client-a", "principal-a");
        owner
            .edit(|state| {
                state.lineages[0].tokens = None;
                Ok(())
            })
            .unwrap();
        owner
            .disconnect(original.id.clone(), quiet())
            .await
            .unwrap();
        owner
            .begin(
                "client-a".into(),
                vec!["docs".into()],
                Some(original.id.clone()),
                None,
                Method::LoopbackPkce,
            )
            .await
            .unwrap();
        let attempt = store.load().unwrap().state.pending[0].clone();
        assert_eq!(attempt.disconnect_generation, 1);
        let claimed = owner.claim(&attempt.state, None, false, now()).unwrap();
        owner
            .commit(&claimed, tokens("fresh-access"), "principal-a".into(), None)
            .unwrap();
        let state = store.load().unwrap().state;
        assert_eq!(state.lineages.len(), 1);
        assert_eq!(state.lineages[0].id, original.id);
        assert!(state.lineages[0].status == Status::Connected);
        assert_eq!(
            state.lineages[0].tokens.as_ref().unwrap().access_token,
            "fresh-access"
        );
        assert!(state.pending.is_empty());
    }
    #[tokio::test]
    async fn google_disconnect_barrier_consumes_attempts_for_unresolved_legacy_identity() {
        for method in [Method::LoopbackPkce, Method::DeviceCode] {
            let (owner, store) = fixture();
            let original = connected(&owner, "client-a", "principal-a");
            owner
                .edit(|state| {
                    let lineage = &mut state.lineages[0];
                    lineage.sub = format!("legacy:{}", original.id);
                    lineage.needs_identity = true;
                    lineage.tokens = None;
                    Ok(())
                })
                .unwrap();
            let mut attempt = pending("client-a");
            attempt.method = method;
            let attempt = staged(&owner, attempt);
            let other_client = staged(&owner, pending("client-b"));
            owner
                .disconnect(original.id.clone(), quiet())
                .await
                .unwrap();
            let restarted = Controller::new(store.clone(), Endpoints::default());
            assert_eq!(
                restarted
                    .commit(&attempt, tokens("late-access"), "principal-a".into(), None)
                    .err()
                    .as_deref(),
                Some(STALE)
            );
            assert!(store
                .load()
                .unwrap()
                .state
                .pending
                .iter()
                .all(|p| p.id != attempt.id));
            restarted
                .commit(
                    &other_client,
                    tokens("other-client-access"),
                    "principal-a".into(),
                    None,
                )
                .unwrap();
            let state = store.load().unwrap().state;
            assert!(
                state
                    .lineages
                    .iter()
                    .find(|l| l.id == original.id)
                    .unwrap()
                    .status
                    == Status::Disconnected
            );
            assert!(!state
                .lineages
                .iter()
                .any(|l| l.client_id == "client-a" && l.status == Status::Connected));
            assert!(state
                .lineages
                .iter()
                .any(|l| l.client_id == "client-b" && l.status == Status::Connected));
            assert!(state.pending.is_empty());
        }
    }
    async fn late_result_via_auth_action(method_kind: Method, unrelated: bool) {
        let (owner, store, server) = network_fixture().await;
        if method_kind == Method::DeviceCode {
            Mock::given(method("POST"))
                .and(path("/device"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "device_code": "device-private", "user_code": "ABCD",
                    "verification_uri": "https://www.google.com/device",
                    "interval": 5, "expires_in": 1800
                })))
                .expect(1)
                .mount(&server)
                .await;
        }
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(token_body()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        owner
            .begin(
                "client-a".into(),
                vec!["docs".into()],
                None,
                None,
                method_kind,
            )
            .await
            .unwrap();
        let attempt = store.load().unwrap().state.pending[0].clone();
        assert!(attempt.lineage_revisions.is_empty());
        let created = connected(
            &owner,
            "client-a",
            if unrelated {
                "principal-b"
            } else {
                "principal-a"
            },
        );
        owner.disconnect(created.id.clone(), quiet()).await.unwrap();
        let input = if method_kind == Method::LoopbackPkce {
            Input::Complete {
                state: attempt.state,
                code: "late-code".into(),
                client_id: Some("client-a".into()),
            }
        } else {
            Input::PollDevice {
                attempt_id: attempt.id.clone(),
            }
        };
        let result = owner.clone().run(input, quiet()).await;
        if unrelated {
            let reply = result.unwrap();
            assert!(reply.lineages.iter().any(|l| {
                l.client_id == "client-a" && l.sub == "principal-a" && l.status == Status::Connected
            }));
        } else {
            assert_eq!(result.err().as_deref(), Some(STALE));
        }
        let state = store.load().unwrap().state;
        assert!(state.pending.iter().all(|p| p.id != attempt.id));
        let disconnected = state.lineages.iter().find(|l| l.id == created.id).unwrap();
        assert!(disconnected.status == Status::Disconnected);
        assert!(disconnected.tokens.is_none());
        if !unrelated {
            assert_eq!(state.lineages.len(), 1);
        }
    }
    #[tokio::test]
    async fn google_disconnect_barrier_complete_action_rejects_late_authorization() {
        late_result_via_auth_action(Method::LoopbackPkce, false).await;
    }
    #[tokio::test]
    async fn google_disconnect_barrier_device_poll_action_rejects_late_authorization() {
        late_result_via_auth_action(Method::DeviceCode, false).await;
    }
    #[tokio::test]
    async fn google_disconnect_barrier_auth_actions_preserve_unrelated_authorizations() {
        for method in [Method::LoopbackPkce, Method::DeviceCode] {
            late_result_via_auth_action(method, true).await;
        }
    }
    #[tokio::test]
    async fn google_loopback_exchange_uses_host_secret_form_and_never_returns_refresh() {
        let (owner, _, server) = network_fixture().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(token_body()))
            .expect(1)
            .mount(&server)
            .await;
        let begun = owner
            .clone()
            .run(
                Input::Begin {
                    client_id: "client-a".into(),
                    scopes: vec!["docs".into()],
                    reauthorize_lineage: None,
                    redirect_uri: None,
                },
                quiet(),
            )
            .await
            .unwrap();
        let url =
            url::Url::parse(begun.attempt.unwrap().authorize_url.as_deref().unwrap()).unwrap();
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["code_challenge_method"], "S256");
        assert!(query["scope"].contains("openid"));
        assert!(query["scope"].contains("email"));
        let p = owner.store.load().unwrap().state.pending[0].clone();
        let reply = owner
            .clone()
            .run(
                Input::Complete {
                    state: p.state.clone(),
                    code: "authorization-code".into(),
                    client_id: Some("client-a".into()),
                },
                quiet(),
            )
            .await
            .unwrap();
        assert_eq!(reply.lineages.len(), 1);
        assert_eq!(reply.lineages[0].sub, "principal-a");
        assert!(!serde_json::to_string(&reply).unwrap().contains("rotated-"));
        let requests = server.received_requests().await.unwrap();
        let form: HashMap<String, String> =
            serde_urlencoded::from_bytes(&requests[0].body).unwrap();
        assert_eq!(form["client_secret"], "private-secret-a");
        assert_eq!(form["client_id"], "client-a");
        assert_eq!(form["code_verifier"], p.verifier);
        assert!(owner
            .clone()
            .run(
                Input::Complete {
                    state: p.state,
                    code: "replay".into(),
                    client_id: Some("client-a".into())
                },
                quiet()
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn google_device_begin_and_poll_all_states() {
        for (error, expected) in [
            ("authorization_pending", "pending"),
            ("slow_down", "slow_down"),
            ("access_denied", "denied"),
            ("expired_token", "expired"),
            ("", "connected"),
        ] {
            let (owner, _, server) = network_fixture().await;
            Mock::given(method("POST")).and(path("/device")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"device_code":"device-private", "user_code":"ABCD", "verification_uri":"https://www.google.com/device", "interval":5, "expires_in":1800}))).expect(1).mount(&server).await;
            let body = if error.is_empty() {
                token_body()
            } else {
                serde_json::json!({"error": error})
            };
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(
                    ResponseTemplate::new(if error.is_empty() { 200 } else { 400 })
                        .set_body_json(body),
                )
                .expect(1)
                .mount(&server)
                .await;
            let begun = owner
                .clone()
                .run(
                    Input::BeginDevice {
                        client_id: "client-a".into(),
                        scopes: vec!["drive.file".into()],
                        reauthorize_lineage: None,
                    },
                    quiet(),
                )
                .await
                .unwrap();
            let attempt = begun.attempt.unwrap();
            assert_eq!(attempt.user_code.as_deref(), Some("ABCD"));
            assert_eq!(attempt.interval, Some(5));
            let reply = owner
                .clone()
                .run(
                    Input::PollDevice {
                        attempt_id: attempt.attempt_id.clone(),
                    },
                    quiet(),
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(reply.poll_status.unwrap()).unwrap(),
                expected
            );
            let s = owner.store.load().unwrap().state;
            if expected == "pending" || expected == "slow_down" {
                assert!(!s.pending[0].claimed);
                assert_eq!(
                    s.pending[0].interval,
                    if expected == "slow_down" { 10 } else { 5 }
                );
            } else {
                assert!(s.pending.is_empty());
            }
            let requests = server.received_requests().await.unwrap();
            let form: HashMap<String, String> =
                serde_urlencoded::from_bytes(&requests[1].body).unwrap();
            assert_eq!(form["device_code"], "device-private");
            assert_eq!(form["client_secret"], "private-secret-a");
        }
        let (owner, _, server) = network_fixture().await;
        let mut p = pending("client-a");
        p.method = Method::DeviceCode;
        p.expires_at = now() - 1;
        let id = p.id.clone();
        owner
            .edit(|s| {
                s.pending.push(p);
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            owner.poll(id).await.unwrap().poll_status,
            Some(PollStatus::Expired)
        ));
        assert!(server.received_requests().await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn google_refresh_singleflight_rotates_credentials_without_authorization_revision() {
        let (owner, _, server) = network_fixture().await;
        let original = connected(&owner, "client-a", "principal-a");
        owner
            .edit(|s| {
                s.lineages[0].tokens.as_mut().unwrap().expires_at = 0;
                Ok(())
            })
            .unwrap();
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(token_body())
                    .set_delay(Duration::from_millis(30)),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut jobs = Vec::new();
        for _ in 0..5 {
            let owner = owner.clone();
            let id = original.id.clone();
            jobs.push(tokio::spawn(async move {
                owner.access(id, 60_000, quiet()).await
            }));
        }
        for job in jobs {
            let reply = job.await.unwrap().unwrap();
            let c = reply.credential.unwrap();
            assert_eq!(c.access_token, "rotated-access");
            assert_eq!(c.revision, original.authorization);
            assert_ne!(c.credential_revision, original.credential_revision);
        }
        let l = &owner.store.load().unwrap().state.lineages[0];
        assert_eq!(l.authorization, original.authorization);
        assert_eq!(
            l.tokens.as_ref().unwrap().refresh_token.as_deref(),
            Some("rotated-refresh")
        );
    }
    #[tokio::test]
    async fn google_refresh_invalid_grant_keeps_lineage_needs_reauth() {
        let (owner, _, server) = network_fixture().await;
        let original = connected(&owner, "client-a", "principal-a");
        owner
            .edit(|s| {
                s.lineages[0].tokens.as_mut().unwrap().expires_at = 0;
                Ok(())
            })
            .unwrap();
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error":"invalid_grant"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        assert!(owner
            .access(original.id.clone(), 60_000, quiet())
            .await
            .is_err());
        let s = owner.store.load().unwrap().state;
        assert_eq!(s.lineages.len(), 1);
        assert_eq!(s.lineages[0].id, original.id);
        assert!(s.lineages[0].status == Status::NeedsReauth);
        assert_ne!(s.lineages[0].authorization, original.authorization);
        assert!(s.lineages[0].tokens.is_none());
    }
    #[tokio::test]
    async fn google_disconnect_persists_fence_before_revoke_and_drops_late_refresh() {
        let (owner, store, server) = network_fixture().await;
        let original = connected(&owner, "client-a", "principal-a");
        owner
            .edit(|s| {
                s.lineages[0].tokens.as_mut().unwrap().expires_at = 0;
                Ok(())
            })
            .unwrap();
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(token_body())
                    .set_delay(Duration::from_millis(150)),
            )
            .expect(1)
            .mount(&server)
            .await;
        let observed = store.clone();
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .respond_with(move |req: &wiremock::Request| {
                let s = observed.load().unwrap().state;
                let l = &s.lineages[0];
                assert!(l.status == Status::Disconnected);
                assert!(l.tokens.is_some());
                let form: HashMap<String, String> =
                    serde_urlencoded::from_bytes(&req.body).unwrap();
                assert_eq!(form["token"], "refresh-access-private");
                ResponseTemplate::new(200)
            })
            .expect(1)
            .mount(&server)
            .await;
        let refreshing = {
            let owner = owner.clone();
            let id = original.id.clone();
            tokio::spawn(async move { owner.access(id, 60_000, quiet()).await })
        };
        for _ in 0..100 {
            if !server.received_requests().await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let result = owner.disconnect(original.id, quiet()).await.unwrap();
        assert!(result.outcome.unwrap().revoked);
        assert_eq!(refreshing.await.unwrap().err().as_deref(), Some(STALE));
        assert!(store.load().unwrap().state.lineages[0].tokens.is_none());
    }
    #[tokio::test]
    async fn google_duplicate_disconnect_revokes_once_and_cancelled_waiter_keeps_host_job() {
        let (owner, store, server) = network_fixture().await;
        let original = connected(&owner, "client-a", "principal-a");
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(50)))
            .expect(1)
            .mount(&server)
            .await;
        let first = {
            let owner = owner.clone();
            let id = original.id.clone();
            tokio::spawn(async move { owner.disconnect(id, quiet()).await })
        };
        for _ in 0..100 {
            if !server.received_requests().await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!server.received_requests().await.unwrap().is_empty());
        let second = {
            let owner = owner.clone();
            let id = original.id.clone();
            tokio::spawn(async move { owner.disconnect(id, quiet()).await })
        };
        drop(first); // Dropping a JoinHandle cannot cancel the Host-owned job.
        second.await.unwrap().unwrap();
        assert!(store.load().unwrap().state.lineages[0].tokens.is_none());
        assert!(owner.blocked.lock().is_empty());
    }
    #[tokio::test]
    async fn google_legacy_identity_probe_once_retains_provisional_on_failure() {
        let (owner, _, server) = network_fixture().await;
        owner
            .edit(|s| {
                s.legacy = Some(LegacyState {
                    tokens: Some(tokens("legacy")),
                    account_email: None,
                });
                Ok(())
            })
            .unwrap();
        owner.migrate(Some("client-a".into())).unwrap();
        Mock::given(method("GET"))
            .and(path("/userinfo"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1)
            .mount(&server)
            .await;
        owner.resolve_legacy_identities().await.unwrap();
        owner.resolve_legacy_identities().await.unwrap();
        let l = &owner.store.load().unwrap().state.lineages[0];
        assert!(l.sub.starts_with("legacy:"));
        assert!(l.needs_identity);
        assert!(l.tokens.is_some());
    }
    #[tokio::test]
    async fn google_legacy_identity_collision_never_creates_two_real_lineages() {
        let (owner, _, server) = network_fixture().await;
        connected(&owner, "client-a", "principal-a");
        owner
            .edit(|s| {
                s.legacy = Some(LegacyState {
                    tokens: Some(tokens("legacy")),
                    account_email: None,
                });
                Ok(())
            })
            .unwrap();
        owner.migrate(Some("client-a".into())).unwrap();
        Mock::given(method("GET"))
            .and(path("/userinfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"sub":"principal-a", "email":"user@example.test"}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        owner.resolve_legacy_identities().await.unwrap();
        let s = owner.store.load().unwrap().state;
        assert_eq!(
            s.lineages.iter().filter(|l| l.sub == "principal-a").count(),
            1
        );
        assert_eq!(
            s.lineages
                .iter()
                .filter(|l| l.status == Status::Connected)
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn google_failed_disconnect_fence_blocks_cached_and_late_credentials() {
        let (owner, store) = fixture();
        let original = connected(&owner, "client-a", "principal-a");
        let attempt = staged(&owner, pending("client-a"));
        store.fail.store(true, Ordering::SeqCst);
        assert!(owner
            .disconnect(original.id.clone(), quiet())
            .await
            .is_err());
        assert!(owner.snapshot().unwrap().lineages[0].status == Status::Disconnected);
        assert_eq!(
            owner.access(original.id, 0, quiet()).await.err().as_deref(),
            Some(STALE)
        );
        assert_eq!(
            owner
                .commit(&attempt, tokens("late"), "principal-a".into(), None)
                .err()
                .as_deref(),
            Some(STALE)
        );
        assert_eq!(
            store.load().unwrap().state.lineages[0]
                .tokens
                .as_ref()
                .unwrap()
                .access_token,
            "access-private"
        );
    }
    #[test]
    fn google_store_cas_mismatch_never_overwrites_another_host_write() {
        let (_, store) = fixture();
        let stale = store.load().unwrap();
        let mut current = stale.state.clone();
        current
            .clients
            .insert("client-c".into(), "host-secret".into());
        store.save(&current, stale.expected.clone()).unwrap();
        assert!(store.save(&stale.state, stale.expected).is_err());
        assert!(store.load().unwrap().state.clients.contains_key("client-c"));
    }
    #[test]
    fn google_revoke_classifier_and_wire_inputs_are_bounded() {
        let request = revocation_request(Endpoints::default().revoke, "rt & =".into()).unwrap();
        assert_eq!(request.body.as_deref(), Some("token=rt+%26+%3D"));
        assert_eq!(request.timeout_ms, Some(30_000));
        assert!(classify_revocation(200, "").unwrap());
        assert!(classify_revocation(400, r#"{"error":"invalid_token"}"#).unwrap());
        assert_eq!(
            classify_revocation(500, r#"{"error_description":"secret-token"}"#)
                .err()
                .as_deref(),
            Some("Google returned HTTP 500")
        );
        let input: Input = serde_json::from_value(
            serde_json::json!({"action":"accessToken", "lineageId":"id", "minValidityMs":60000}),
        )
        .unwrap();
        assert!(matches!(input, Input::AccessToken { .. }));
        assert!(serde_json::from_value::<Input>(
            serde_json::json!({"action":"commit", "tokens":{}})
        )
        .is_err());
    }
}
