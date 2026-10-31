//! Confidential OAuth exchange transport. Secrets are supplied by a trusted caller.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_TOKEN_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientSecretPlacement {
    None,
    Form,
    Json,
    Basic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenBodyEncoding {
    Form,
    Json,
}

// Deliberately no Debug/Serialize: a caller must not log the client secret.
pub struct ConfidentialExchangeRequest {
    pub token_url: String,
    pub params: BTreeMap<String, String>,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub placement: ClientSecretPlacement,
    pub body_encoding: TokenBodyEncoding,
    pub timeout: Duration,
}

#[derive(Debug, Serialize)]
pub struct ConfidentialExchangeResponse {
    pub status: u16,
    pub body: Map<String, Value>,
}

/// Static diagnostics only: reqwest/JSON errors can contain credential material.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfidentialExchangeError {
    #[error("OAuth token destination refused")]
    InvalidDestination,
    #[error("Invalid OAuth exchange request")]
    InvalidRequest,
    #[error("OAuth token redirect refused")]
    RedirectRefused,
    #[error("OAuth token response exceeds the byte limit")]
    ResponseTooLarge,
    #[error("OAuth token response must be a JSON object")]
    InvalidJson,
    #[error("OAuth token transport unavailable")]
    Transport,
    #[error("OAuth token request timed out")]
    Timeout,
}

fn form_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn validate_destination(url: &url::Url) -> Result<(), ConfidentialExchangeError> {
    let ip = match url.host() {
        Some(url::Host::Ipv4(ip)) => Some(std::net::IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(std::net::IpAddr::V6(ip)),
        _ => None,
    };
    let loopback = ip.is_some_and(|ip| ip.is_loopback()) || url.host_str() == Some("localhost");
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || ip.is_some_and(|ip| {
            !ip.is_loopback()
                && crate::egress::classify_dest(&ip) == crate::egress::DestClass::Forbidden
        })
    {
        return Err(ConfidentialExchangeError::InvalidDestination);
    }
    crate::http_client::admit_host(url).map_err(|_| ConfidentialExchangeError::InvalidDestination)
}

/// POST once through the managed proxy policy. No redirect, including a
/// same-origin redirect, may replay a credential-bearing request.
pub async fn confidential_token_exchange(
    req: ConfidentialExchangeRequest,
) -> Result<ConfidentialExchangeResponse, ConfidentialExchangeError> {
    use ConfidentialExchangeError as Error;
    let url = url::Url::parse(&req.token_url).map_err(|_| Error::InvalidDestination)?;
    validate_destination(&url)?;
    if req.client_id.is_empty()
        || req.params.contains_key("client_secret")
        || req.params.contains_key("client_id")
        || matches!(
            (req.placement, req.body_encoding),
            (ClientSecretPlacement::Form, TokenBodyEncoding::Json)
                | (ClientSecretPlacement::Json, TokenBodyEncoding::Form)
        )
        || (req.placement != ClientSecretPlacement::None
            && req.client_secret.as_deref().is_none_or(str::is_empty))
    {
        return Err(Error::InvalidRequest);
    }
    let timeout = req
        .timeout
        .clamp(Duration::from_millis(1), Duration::from_secs(120));
    crate::proxy_config::ensure_crypto_provider();
    let client = crate::proxy_config::managed_client(
        reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none()),
        url.as_str(),
    )
    .map_err(|_| Error::Transport)?;
    let mut params = req.params;
    let mut builder = client.post(url);
    match req.placement {
        ClientSecretPlacement::Form | ClientSecretPlacement::Json => {
            params.insert("client_id".into(), req.client_id);
            params.insert(
                "client_secret".into(),
                req.client_secret.clone().unwrap_or_default(),
            );
        }
        ClientSecretPlacement::Basic => {
            builder = builder.basic_auth(
                form_component(&req.client_id),
                req.client_secret.as_deref().map(form_component),
            );
        }
        ClientSecretPlacement::None => {
            params.insert("client_id".into(), req.client_id);
        }
    }
    builder = match req.body_encoding {
        TokenBodyEncoding::Form => builder
            .header("content-type", "application/x-www-form-urlencoded")
            .body(
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs(&params)
                    .finish(),
            ),
        TokenBodyEncoding::Json => builder.json(&params),
    };
    let result = tokio::time::timeout(timeout, async {
        let mut response = builder.send().await.map_err(|_| Error::Transport)?;
        if response.status().is_redirection() {
            return Err(Error::RedirectRefused);
        }
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Transport)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_TOKEN_RESPONSE_BYTES {
                return Err(Error::ResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidJson)?;
        if let Some(secret) = req
            .client_secret
            .as_deref()
            .filter(|secret| !secret.is_empty())
        {
            redact(&mut value, secret);
        }
        match value {
            Value::Object(body) => Ok(ConfidentialExchangeResponse { status, body }),
            _ => Err(Error::InvalidJson),
        }
    })
    .await;
    result.map_err(|_| Error::Timeout)?
}

fn redact(value: &mut Value, secret: &str) {
    let encoded = form_component(secret);
    let escaped = serde_json::to_string(secret).unwrap_or_default();
    let escaped = escaped
        .get(1..escaped.len().saturating_sub(1))
        .unwrap_or("");
    let mut variants = vec![
        secret.to_string(),
        encoded.clone(),
        encoded.replace('+', "%20"),
        encoded.to_ascii_lowercase(),
        encoded.replace('+', "%20").to_ascii_lowercase(),
        escaped.to_string(),
        escaped.replace('/', "\\/"),
    ];
    variants.sort_by_key(|value| std::cmp::Reverse(value.len()));
    variants.dedup();
    fn visit(value: &mut Value, variants: &[String]) {
        let replace = |text: &str| {
            variants
                .iter()
                .filter(|s| !s.is_empty())
                .fold(text.to_string(), |text, secret| {
                    text.replace(secret, "[REDACTED]")
                })
        };
        match value {
            Value::String(text) => *text = replace(text),
            Value::Array(items) => {
                for item in items {
                    visit(item, variants);
                }
            }
            Value::Object(map) => {
                *map = std::mem::take(map)
                    .into_iter()
                    .map(|(key, mut value)| {
                        visit(&mut value, variants);
                        (replace(&key), value)
                    })
                    .collect();
            }
            _ => {}
        }
    }
    visit(value, &variants);
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn request(url: String, placement: ClientSecretPlacement) -> ConfidentialExchangeRequest {
        ConfidentialExchangeRequest {
            token_url: url,
            params: [("grant_type".into(), "client_credentials".into())].into(),
            client_id: "id :+".into(),
            client_secret: Some("secret :+\"/".into()),
            placement,
            body_encoding: if placement == ClientSecretPlacement::Json {
                TokenBodyEncoding::Json
            } else {
                TokenBodyEncoding::Form
            },
            timeout: std::time::Duration::from_secs(2),
        }
    }

    #[tokio::test]
    async fn oauth_exchange_exact_wire_formats() {
        let _guard = crate::proxy_config::NETWORK_ENV_TEST.lock().await;
        crate::proxy_config::apply_current(Default::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(wiremock::matchers::method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .mount(&server)
            .await;
        for placement in [
            ClientSecretPlacement::Form,
            ClientSecretPlacement::Json,
            ClientSecretPlacement::Basic,
            ClientSecretPlacement::None,
        ] {
            let req = request(server.uri(), placement);
            let result = confidential_token_exchange(req).await.unwrap();
            assert_eq!(result.status, 200);
            assert_eq!(result.body["ok"], true);
        }
        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests[0].headers["content-type"],
            "application/x-www-form-urlencoded"
        );
        assert_eq!(
            requests[0].body,
            b"client_id=id+%3A%2B&client_secret=secret+%3A%2B%22%2F&grant_type=client_credentials"
        );
        assert_eq!(requests[1].headers["content-type"], "application/json");
        assert_eq!(requests[1].body, br#"{"client_id":"id :+","client_secret":"secret :+\"/","grant_type":"client_credentials"}"#);
        assert_eq!(
            requests[2].headers["authorization"],
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("id+%3A%2B:secret+%3A%2B%22%2F")
            )
        );
        assert_eq!(requests[2].body, b"grant_type=client_credentials");
        assert!(!requests[3].headers.contains_key("authorization"));
        assert_eq!(
            requests[3].body,
            b"client_id=id+%3A%2B&grant_type=client_credentials"
        );
    }

    #[tokio::test]
    async fn oauth_exchange_refuses_every_redirect_without_contacting_target() {
        let _guard = crate::proxy_config::NETWORK_ENV_TEST.lock().await;
        crate::proxy_config::apply_current(Default::default()).unwrap();
        let target = MockServer::start().await;
        for status in [300, 301, 302, 303, 304, 307, 308] {
            let source = MockServer::start().await;
            Mock::given(wiremock::matchers::any())
                .respond_with(ResponseTemplate::new(status).insert_header("Location", target.uri()))
                .mount(&source)
                .await;
            assert_eq!(
                confidential_token_exchange(request(source.uri(), ClientSecretPlacement::Basic))
                    .await
                    .unwrap_err(),
                ConfidentialExchangeError::RedirectRefused
            );
        }
        assert!(target.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn oauth_exchange_redacts_echo_and_rejects_invalid_or_large_json() {
        let _guard = crate::proxy_config::NETWORK_ENV_TEST.lock().await;
        crate::proxy_config::apply_current(Default::default()).unwrap();
        let server = MockServer::start().await;
        let secret = "secret :+\"/";
        Mock::given(wiremock::matchers::path("/echo"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({secret: [secret, "secret+%3A%2B%22%2F", "secret%20%3A%2B%22%2F", "secret :+\\\"\\/"]})))
            .mount(&server).await;
        let result = confidential_token_exchange(request(
            format!("{}/echo", server.uri()),
            ClientSecretPlacement::Form,
        ))
        .await
        .unwrap();
        assert_eq!(result.status, 400);
        assert_eq!(
            serde_json::to_value(result.body).unwrap(),
            serde_json::json!({"[REDACTED]": ["[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]"]})
        );
        for (path, body, expected) in [
            (
                "/text",
                secret.to_string(),
                ConfidentialExchangeError::InvalidJson,
            ),
            (
                "/array",
                "[]".into(),
                ConfidentialExchangeError::InvalidJson,
            ),
            (
                "/large",
                "x".repeat(MAX_TOKEN_RESPONSE_BYTES + 1),
                ConfidentialExchangeError::ResponseTooLarge,
            ),
        ] {
            Mock::given(wiremock::matchers::path(path))
                .respond_with(ResponseTemplate::new(200).set_body_string(body))
                .mount(&server)
                .await;
            let error = confidential_token_exchange(request(
                format!("{}{path}", server.uri()),
                ClientSecretPlacement::Form,
            ))
            .await
            .unwrap_err();
            assert_eq!(error, expected);
            assert!(!format!("{error:?} {error}").contains(secret));
        }
    }

    #[tokio::test]
    async fn oauth_exchange_rejects_metadata_insecure_urls_and_encoding_mismatches() {
        for url in [
            "https://169.254.169.254/token",
            "https://[fe80::1]/token",
            "https://100.100.100.200/token",
            "http://example.com/token",
            "https://user:secret@example.com/token",
        ] {
            assert_eq!(
                confidential_token_exchange(request(url.into(), ClientSecretPlacement::Form))
                    .await
                    .unwrap_err(),
                ConfidentialExchangeError::InvalidDestination
            );
        }
        let mut req = request("http://127.0.0.1/token".into(), ClientSecretPlacement::Json);
        req.body_encoding = TokenBodyEncoding::Form;
        assert_eq!(
            confidential_token_exchange(req).await.unwrap_err(),
            ConfidentialExchangeError::InvalidRequest
        );
    }
}
