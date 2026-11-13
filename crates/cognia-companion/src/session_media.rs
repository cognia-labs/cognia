//! Authenticated, session-scoped binary media reads for transcript V1.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::Response,
    Extension,
};
use serde::Deserialize;

use super::{
    data_plane::{DataPlane, PairedReader},
    middleware::DeviceContext,
    SharedState,
};

use super::desktop_messages_bridge::MAX_MEDIA_BYTES;

#[derive(Debug, Deserialize)]
pub struct MediaQuery {
    #[serde(default = "canonical_variant")]
    variant: String,
}

fn canonical_variant() -> String {
    "canonical".to_string()
}

fn valid_request(session_id: &str, hash: &str, variant: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 512
        && hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && matches!(variant, "thumbnail" | "canonical" | "original")
}

fn media_error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    retryable: bool,
) -> Response {
    super::api::public_error_response(status, code, message, retryable, serde_json::json!({}))
}

pub async fn session_media_handler(
    Path((session_id, hash)): Path<(String, String)>,
    Query(query): Query<MediaQuery>,
    State(state): State<SharedState>,
    Extension(principal): Extension<DeviceContext>,
) -> Response {
    if !valid_request(&session_id, &hash, &query.variant) {
        return media_error(
            StatusCode::BAD_REQUEST,
            "invalid_media_request",
            "session, hash, or variant is invalid",
            false,
        );
    }
    // A brain that does not announce `media` will never answer the request the
    // data plane is about to emit, and the caller would learn that only from a
    // thirty-second timeout reported as a retryable 503. Refuse now, with the
    // reason. Always true when the desktop serves media through Tauri IPC.
    if !super::ws_bridge::brain_serves_media() {
        return media_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_service_unavailable",
            "the connected brain does not serve session media; upgrade it",
            false,
        );
    }
    let reader = PairedReader::for_device(Some(&principal.tenant_id), &principal.device_id);
    // Binary HTTP has no person-fleet partition router. Never fall through
    // from a member identity to the operator brain.
    if reader == PairedReader::Member
        && crate::deployment::deployment_mode() == crate::deployment::DeploymentMode::MultiTenant
        && crate::person_partition::current().is_none()
    {
        return media_error(
            StatusCode::FORBIDDEN,
            "personal_visibility_unavailable",
            "person-partition media routing is unavailable",
            false,
        );
    }
    let Some(data_plane) = DataPlane::pick(&state) else {
        return media_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_service_unavailable",
            "the session media service is unavailable",
            true,
        );
    };
    let data_plane = match data_plane.for_paired_reader(reader) {
        Ok(plane) => plane,
        Err(_) => {
            return media_error(
                StatusCode::CONFLICT,
                "personal_visibility_unavailable",
                "the degraded store cannot filter personal media",
                false,
            )
        }
    };
    let media = match data_plane
        .session_media(session_id, hash, query.variant)
        .await
    {
        Ok(media) => media,
        Err(error) if error == "MEDIA_NOT_FOUND" => {
            return media_error(
                StatusCode::NOT_FOUND,
                "media_not_found",
                "the requested session media does not exist",
                false,
            )
        }
        Err(error) if error == "INVALID_PARAMS" => {
            return media_error(
                StatusCode::BAD_REQUEST,
                "invalid_media_request",
                "session, hash, or variant is invalid",
                false,
            )
        }
        Err(_) => {
            return media_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "media_service_unavailable",
                "the session media service is unavailable",
                true,
            )
        }
    };
    if media.bytes.len() > MAX_MEDIA_BYTES {
        return media_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "media_too_large",
            "the requested session media exceeds the response limit",
            false,
        );
    }

    let mut response = Response::new(Body::from(media.bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&media.media_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    if let Some(etag) = media
        .etag
        .and_then(|value| HeaderValue::from_str(&value).ok())
    {
        headers.insert(header::ETAG, etag);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_personal_visibility_is_a_typed_conflict() {
        let response = media_error(
            StatusCode::CONFLICT,
            "personal_visibility_unavailable",
            "filter unavailable",
            false,
        );
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn validates_hash_variant_and_session_bounds() {
        assert!(valid_request("s1", &"a".repeat(64), "thumbnail"));
        assert!(valid_request("s1", &"0".repeat(64), "canonical"));
        assert!(!valid_request("", &"a".repeat(64), "canonical"));
        assert!(!valid_request("s1", "short", "canonical"));
        assert!(!valid_request("s1", &"A".repeat(64), "canonical"));
        assert!(!valid_request("s1", &"a".repeat(64), "other"));
    }

    #[tokio::test]
    async fn media_errors_use_the_canonical_public_envelope() {
        let response = media_error(StatusCode::NOT_FOUND, "media_not_found", "missing", false);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON error");
        assert_eq!(body["code"], "media_not_found");
        assert_eq!(body["status"], 404);
        assert_eq!(body["retryable"], false);
        assert!(body["requestId"].as_str().is_some());
    }
}
