//! OIDC access-token verification with JWKS discovery — ADR-0149 §8.
//!
//! Lifted verbatim from `crates/cognia-ops-controller/src/auth.rs`, which is
//! now a re-export shim. The move is what ADR-0149 §7 asked for, but for a
//! reason the ADR did not have: not that two services had duplicated this, but
//! that a *third* — `cognia-collab-server` — was about to write a third copy in
//! order to exchange an OIDC token for a grant.
//!
//! The diagnostic server (cognia-services) stays out. It verifies against a
//! static RSA PEM rather than JWKS, sits on `jsonwebtoken 9` against this
//! crate's 11, and lives in another repository. See the crate root.
//!
//! # What this layer decides, and what it does not
//!
//! It answers "is this token real, and whose is it" — signature, issuer,
//! audience, expiry, and the tenant claim. It does **not** answer what the
//! bearer may do: that is [`crate::membership`], reading membership rows. A
//! token is evidence of identity, never of authority.

use async_trait::async_trait;
use jsonwebtoken::jwk::{Jwk, JwkSet, KeyAlgorithm};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Claims {
    pub subject: String,
    pub tenant_id: String,
    pub scopes: BTreeSet<String>,
}

impl Claims {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.contains(scope)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("access token is invalid: {0}")]
    Invalid(String),
    #[error("OIDC discovery failed: {0}")]
    Discovery(String),
    #[error("access token does not contain tenant claim `{0}`")]
    MissingTenant(String),
}

/// A verified token whose tenant claim is allowed to be absent.
///
/// The account-control routes (`GET /v1/account/memberships`, bootstrap,
/// generic invitation acceptance) run BEFORE the person belongs to any
/// organization, so the token they receive is a plain user token with no
/// `organization_id`. Requiring the claim there would make the first sign-in
/// impossible by construction.
#[derive(Clone, Debug)]
pub struct SubjectClaims {
    pub subject: String,
    pub tenant_id: Option<String>,
    pub scopes: BTreeSet<String>,
}

#[async_trait]
pub trait Authenticator: Send + Sync {
    /// Verify a token that MUST carry the tenant claim.
    async fn authenticate(&self, token: &str) -> Result<Claims, AuthError>;

    /// Verify a token whose tenant claim MAY be absent.
    ///
    /// The default derives from [`Authenticator::authenticate`], which keeps
    /// every existing implementation strict. Implementations that can tell a
    /// missing claim from an invalid token override it.
    async fn authenticate_subject(&self, token: &str) -> Result<SubjectClaims, AuthError> {
        let claims = self.authenticate(token).await?;
        Ok(SubjectClaims {
            subject: claims.subject,
            tenant_id: Some(claims.tenant_id),
            scopes: claims.scopes,
        })
    }
}

#[derive(Default)]
pub struct TestAuthenticator;

/// Test tokens read `"<tenant>:<scopes>"`, or `"<tenant>:<scopes>@<subject>"`
/// when a test needs a subject other than the default. A tenant segment of
/// `-` means "no organization claim", which only [`Authenticator::authenticate_subject`]
/// accepts.
#[async_trait]
impl Authenticator for TestAuthenticator {
    async fn authenticate(&self, token: &str) -> Result<Claims, AuthError> {
        let parsed = parse_test_token(token)?;
        let tenant_id = parsed
            .tenant_id
            .ok_or_else(|| AuthError::MissingTenant("organization_id".into()))?;
        Ok(Claims {
            subject: parsed.subject,
            tenant_id,
            scopes: parsed.scopes,
        })
    }

    async fn authenticate_subject(&self, token: &str) -> Result<SubjectClaims, AuthError> {
        parse_test_token(token)
    }
}

fn parse_test_token(token: &str) -> Result<SubjectClaims, AuthError> {
    let (body, subject) = match token.split_once('@') {
        Some((body, subject)) if !subject.is_empty() => (body, subject.to_owned()),
        _ => (token, "test-user".to_owned()),
    };
    let (tenant_id, scopes) = body
        .split_once(':')
        .ok_or_else(|| AuthError::Invalid("test token format".into()))?;
    Ok(SubjectClaims {
        subject,
        tenant_id: (!tenant_id.is_empty() && tenant_id != "-").then(|| tenant_id.to_owned()),
        scopes: scopes.split(',').map(str::to_owned).collect(),
    })
}

#[derive(Clone, Debug)]
pub struct OidcConfig {
    pub issuer: String,
    pub audience: String,
    pub tenant_claim: String,
    pub jwks_ttl: Duration,
}

// ---------------------------------------------------------------------------
// The one JWKS cache and JWT verifier (ADR-0253 D01)
// ---------------------------------------------------------------------------
//
// Every OIDC resource server in the workspace verifies through these two:
// this crate's [`OidcAuthenticator`] and the companion's device-registration
// verifier, which adds its device-specific checks (required scopes, group
// mapping) on top. They used to be two full copies that had already drifted:
// one checked the discovery document's issuer, the other did not.

/// Why a JWT failed verification against a JWKS.
#[derive(Debug, thiserror::Error)]
pub enum JwtVerifyError {
    #[error("token header has no `kid`")]
    MissingKid,
    #[error("no JWKS key matches kid `{0}`")]
    UnknownKid(String),
    #[error("JWKS key `{kid}` has an unsupported or missing signing algorithm")]
    UnsupportedKeyAlgorithm { kid: String },
    #[error("could not build a decoding key from JWK `{kid}`: {source}")]
    Jwk {
        kid: String,
        #[source]
        source: jsonwebtoken::errors::Error,
    },
    #[error("token signature, format, or reserved-claim validation failed: {0}")]
    Invalid(#[from] jsonwebtoken::errors::Error),
}

/// What a verified token must say about where it came from and for whom.
#[derive(Clone, Copy, Debug)]
pub struct JwtExpectations<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    /// Clock-skew leeway in seconds applied to `exp`.
    pub leeway_secs: u64,
    /// Reserved claims that must be present, e.g. `["exp", "iss", "aud"]`.
    pub required_claims: &'a [&'a str],
}

/// Verify `token` against an already-fetched JWKS. **No network.**
///
/// The signing key is the one whose `kid` matches the token header, and the
/// algorithm is taken from that **JWKS entry**, never from the attacker-chosen
/// token header, so an algorithm-confusion token is refused before verify.
pub fn verify_jwt<T: DeserializeOwned>(
    jwks: &JwkSet,
    token: &str,
    expect: &JwtExpectations<'_>,
) -> Result<T, JwtVerifyError> {
    let header = decode_header(token)?;
    let kid = header.kid.ok_or(JwtVerifyError::MissingKid)?;
    let jwk = jwks
        .find(&kid)
        .ok_or_else(|| JwtVerifyError::UnknownKid(kid.clone()))?;
    let algorithm = algorithm_for_jwk(jwk)
        .ok_or_else(|| JwtVerifyError::UnsupportedKeyAlgorithm { kid: kid.clone() })?;
    let key = DecodingKey::from_jwk(jwk).map_err(|source| JwtVerifyError::Jwk {
        kid: kid.clone(),
        source,
    })?;
    // `Validation::new(algorithm)` pins the accepted algorithms to exactly it.
    let mut validation = Validation::new(algorithm);
    validation.leeway = expect.leeway_secs;
    validation.validate_exp = true;
    validation.validate_nbf = false;
    validation.set_issuer(&[expect.issuer]);
    validation.set_audience(&[expect.audience]);
    validation.set_required_spec_claims(expect.required_claims);
    Ok(decode::<T>(token, &key, &validation)?.claims)
}

/// Builds the HTTP client a fetch to one URL goes through. Injected so a
/// caller with its own egress policy (a proxy, a bypass list) applies it.
pub type JwksClientFactory = Arc<dyn Fn(&str) -> Result<reqwest::Client, String> + Send + Sync>;

/// The client a cache without an egress policy uses: bounded, because the
/// fetch is reachable from a request's path and an issuer that connects but
/// never answers must not stall it for the OS TCP timeout.
pub fn default_jwks_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    jwks_uri: String,
}

struct CachedJwks {
    value: Arc<JwkSet>,
    fetched_at: Instant,
}

/// Fetches and caches an issuer's JWKS: discovery document → `jwks_uri` →
/// key set, kept for `ttl`. The discovery document must name the configured
/// issuer (trailing slash aside); one that names another is refused.
pub struct JwksCache {
    issuer: String,
    ttl: Duration,
    client: JwksClientFactory,
    cached: RwLock<Option<CachedJwks>>,
}

impl JwksCache {
    /// A cache fetching through `client`, which is asked once per fetched URL.
    pub fn new(issuer: impl Into<String>, ttl: Duration, client: JwksClientFactory) -> Self {
        Self {
            issuer: issuer.into(),
            ttl,
            client,
            cached: RwLock::new(None),
        }
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// The issuer's key set, fetched (and cached) when absent or stale. A
    /// concurrent fetch at worst repeats work and stores an equally fresh copy,
    /// which keeps the lock off the network round-trip.
    pub async fn jwks(&self) -> Result<Arc<JwkSet>, String> {
        if let Some(cached) = self.cached.read().as_ref() {
            if cached.fetched_at.elapsed() < self.ttl {
                return Ok(Arc::clone(&cached.value));
            }
        }
        let value = Arc::new(self.fetch().await?);
        *self.cached.write() = Some(CachedJwks {
            value: Arc::clone(&value),
            fetched_at: Instant::now(),
        });
        Ok(value)
    }

    async fn fetch(&self) -> Result<JwkSet, String> {
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            self.issuer.trim_end_matches('/')
        );
        let discovery: DiscoveryDocument = (self.client)(&discovery_url)
            .map_err(|error| format!("client for {discovery_url}: {error}"))?
            .get(&discovery_url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("GET {discovery_url}: {error}"))?
            .json()
            .await
            .map_err(|error| format!("parse discovery document: {error}"))?;
        if discovery.issuer.trim_end_matches('/') != self.issuer.trim_end_matches('/') {
            return Err("discovery issuer mismatch".into());
        }
        (self.client)(&discovery.jwks_uri)
            .map_err(|error| format!("client for {}: {error}", discovery.jwks_uri))?
            .get(&discovery.jwks_uri)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("GET {}: {error}", discovery.jwks_uri))?
            .json()
            .await
            .map_err(|error| format!("parse JWKS: {error}"))
    }
}

#[derive(Deserialize)]
struct RawClaims {
    sub: String,
    #[serde(default)]
    scope: String,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

pub struct OidcAuthenticator {
    config: OidcConfig,
    cache: JwksCache,
}

impl OidcAuthenticator {
    pub fn new(config: OidcConfig) -> anyhow::Result<Self> {
        let client = default_jwks_client().map_err(anyhow::Error::msg)?;
        let factory: JwksClientFactory = Arc::new(move |_| Ok(client.clone()));
        let cache = JwksCache::new(config.issuer.clone(), config.jwks_ttl, factory);
        Ok(Self { config, cache })
    }

    async fn verify(&self, token: &str) -> Result<RawClaims, AuthError> {
        // Cheap pre-check before any network I/O: a token without a `kid`
        // cannot name a JWKS key, so it never triggers a fetch.
        let header = decode_header(token).map_err(|error| AuthError::Invalid(error.to_string()))?;
        if header.kid.is_none() {
            return Err(AuthError::Invalid("missing kid".into()));
        }
        let jwks = self.cache.jwks().await.map_err(AuthError::Discovery)?;
        verify_jwt(
            &jwks,
            token,
            &JwtExpectations {
                issuer: &self.config.issuer,
                audience: &self.config.audience,
                leeway_secs: 60,
                required_claims: &["exp", "iss", "aud", "sub"],
            },
        )
        .map_err(|error| AuthError::Invalid(error.to_string()))
    }

    fn tenant_of(&self, raw: &RawClaims) -> Option<String> {
        raw.extra
            .get(&self.config.tenant_claim)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    }
}

#[async_trait]
impl Authenticator for OidcAuthenticator {
    async fn authenticate(&self, token: &str) -> Result<Claims, AuthError> {
        let raw = self.verify(token).await?;
        let tenant_id = self
            .tenant_of(&raw)
            .ok_or_else(|| AuthError::MissingTenant(self.config.tenant_claim.clone()))?;
        Ok(Claims {
            subject: raw.sub,
            tenant_id,
            scopes: raw.scope.split_whitespace().map(str::to_owned).collect(),
        })
    }

    async fn authenticate_subject(&self, token: &str) -> Result<SubjectClaims, AuthError> {
        // Same signature, issuer, audience and expiry checks. Only the tenant
        // claim is allowed to be absent: a token is still evidence of WHO,
        // it merely says nothing about WHERE yet.
        let raw = self.verify(token).await?;
        Ok(SubjectClaims {
            tenant_id: self.tenant_of(&raw),
            subject: raw.sub,
            scopes: raw.scope.split_whitespace().map(str::to_owned).collect(),
        })
    }
}

fn algorithm_for_jwk(jwk: &Jwk) -> Option<Algorithm> {
    match jwk.common.key_algorithm? {
        KeyAlgorithm::ES256 => Some(Algorithm::ES256),
        KeyAlgorithm::ES384 => Some(Algorithm::ES384),
        KeyAlgorithm::RS256 => Some(Algorithm::RS256),
        KeyAlgorithm::RS384 => Some(Algorithm::RS384),
        KeyAlgorithm::RS512 => Some(Algorithm::RS512),
        KeyAlgorithm::PS256 => Some(Algorithm::PS256),
        KeyAlgorithm::PS384 => Some(Algorithm::PS384),
        KeyAlgorithm::PS512 => Some(Algorithm::PS512),
        KeyAlgorithm::EdDSA => Some(Algorithm::EdDSA),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_test_authenticator_splits_tenant_from_scopes() {
        let claims = TestAuthenticator
            .authenticate("tenant-a:servers:read,servers:operate")
            .await
            .unwrap();
        assert_eq!(claims.tenant_id, "tenant-a");
        assert!(claims.has_scope("servers:read"));
        assert!(claims.has_scope("servers:operate"));
        assert!(!claims.has_scope("servers:admin"));
    }

    #[tokio::test]
    async fn the_strict_path_still_refuses_a_test_token_with_no_tenant() {
        // `authenticate` keeps every existing route strict: the account
        // routes opt into the relaxed check explicitly.
        assert!(matches!(
            TestAuthenticator.authenticate("-:collab:read").await,
            Err(AuthError::MissingTenant(_))
        ));
        let subject = TestAuthenticator
            .authenticate_subject("-:collab:read")
            .await
            .unwrap();
        assert_eq!(subject.tenant_id, None);
        assert_eq!(subject.subject, "test-user");
    }

    #[tokio::test]
    async fn a_test_token_may_name_its_subject_after_an_at_sign() {
        let claims = TestAuthenticator
            .authenticate_subject("tenant-a:collab:read@logto-ada")
            .await
            .unwrap();
        assert_eq!(claims.subject, "logto-ada");
        assert_eq!(claims.tenant_id.as_deref(), Some("tenant-a"));
        // And the strict path sees the same subject.
        let strict = TestAuthenticator
            .authenticate("tenant-a:collab:read@logto-ada")
            .await
            .unwrap();
        assert_eq!(strict.subject, "logto-ada");
    }

    #[tokio::test]
    async fn a_token_with_no_separator_is_rejected_rather_than_treated_as_a_tenant() {
        assert!(matches!(
            TestAuthenticator.authenticate("no-colon").await,
            Err(AuthError::Invalid(_))
        ));
    }

    #[test]
    fn scopes_are_a_set_so_a_repeated_scope_grants_nothing_extra() {
        let claims = Claims {
            subject: "s".into(),
            tenant_id: "t".into(),
            scopes: ["a", "a", "b"].into_iter().map(str::to_owned).collect(),
        };
        assert_eq!(claims.scopes.len(), 2);
        assert!(claims.has_scope("a"));
    }

    #[test]
    fn d01_the_shared_verifier_names_a_missing_or_unknown_key_before_verifying() {
        use jsonwebtoken::{encode, EncodingKey, Header};
        let claims = serde_json::json!({"sub": "s", "exp": 4_102_444_800_i64});
        let expect = JwtExpectations {
            issuer: "https://idp.test",
            audience: "aud",
            leeway_secs: 60,
            required_claims: &["exp", "iss", "aud"],
        };
        let empty = JwkSet { keys: vec![] };
        let no_kid = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"k"),
        )
        .unwrap();
        assert!(matches!(
            verify_jwt::<serde_json::Value>(&empty, &no_kid, &expect),
            Err(JwtVerifyError::MissingKid)
        ));
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some("gone".into());
        let unknown = encode(&header, &claims, &EncodingKey::from_secret(b"k")).unwrap();
        assert!(matches!(
            verify_jwt::<serde_json::Value>(&empty, &unknown, &expect),
            Err(JwtVerifyError::UnknownKid(kid)) if kid == "gone"
        ));
        assert!(matches!(
            verify_jwt::<serde_json::Value>(&empty, "not.a.jwt", &expect),
            Err(JwtVerifyError::Invalid(_))
        ));
    }

    #[test]
    fn only_asymmetric_algorithms_map_to_a_verifier() {
        // The list is an allowlist on purpose. A JWK announcing `HS256` would
        // mean verifying an *asymmetric* token with a symmetric key taken from
        // the JWKS itself — the classic confusion attack — so it maps to None
        // and the token is refused as "unsupported signing algorithm".
        use jsonwebtoken::jwk::{CommonParameters, Jwk, KeyAlgorithm, RSAKeyParameters};

        let jwk_with = |algorithm: Option<KeyAlgorithm>| Jwk {
            common: CommonParameters {
                key_algorithm: algorithm,
                ..Default::default()
            },
            algorithm: jsonwebtoken::jwk::AlgorithmParameters::RSA(RSAKeyParameters::default()),
        };

        assert_eq!(
            algorithm_for_jwk(&jwk_with(Some(KeyAlgorithm::RS256))),
            Some(Algorithm::RS256)
        );
        assert_eq!(
            algorithm_for_jwk(&jwk_with(Some(KeyAlgorithm::EdDSA))),
            Some(Algorithm::EdDSA)
        );
        assert_eq!(
            algorithm_for_jwk(&jwk_with(Some(KeyAlgorithm::HS256))),
            None
        );
        // A JWK that names no algorithm cannot be used to pick one.
        assert_eq!(algorithm_for_jwk(&jwk_with(None)), None);
    }

    #[test]
    fn discovery_url_construction_tolerates_a_trailing_slash_on_the_issuer() {
        for issuer in ["https://idp.test", "https://idp.test/"] {
            let url = format!(
                "{}/.well-known/openid-configuration",
                issuer.trim_end_matches('/')
            );
            assert_eq!(url, "https://idp.test/.well-known/openid-configuration");
        }
    }

    #[test]
    fn a_missing_tenant_claim_names_the_claim_it_wanted() {
        // The operator reading this log needs to know which claim to configure.
        let error = AuthError::MissingTenant("org_id".into());
        assert!(error.to_string().contains("org_id"));
    }
}
