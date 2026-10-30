//! Host policy for the isolated human document browser. Kept Tauri-free so
//! create, authorization and event decisions share one testable owner.

use serde_json::{json, Map, Value};

use crate::bridge::SessionKind;
use crate::client::ClientError;

pub const DOCUMENT_VIEWER_PROFILE: &str = "cognia-document-viewer";
pub const DOCUMENT_VIEWER_OP_REFUSED: &str = "browser_document_viewer_op_refused";
pub const DOCUMENT_VIEWER_WINDOW_MISMATCH: &str = "browser_document_viewer_window_mismatch";
pub const PROFILE_RESERVED: &str = "browser_profile_reserved";

/// Reserve filesystem aliases too: macOS commonly ignores case, and Windows
/// normalizes trailing dots/spaces in directory names.
pub fn is_document_viewer_profile(profile: &str) -> bool {
    profile
        .trim_end_matches(['.', ' '])
        .eq_ignore_ascii_case(DOCUMENT_VIEWER_PROFILE)
}

pub const DOCUMENT_VIEWER_OPS: &[&str] = &[
    "browser.session.close",
    "browser.navigate",
    "browser.back",
    "browser.forward",
    "browser.reload",
    "browser.stop",
    "browser.page",
    "browser.pages",
    "browser.page.create",
    "browser.page.activate",
    "browser.page.close",
    "browser.input",
    "browser.press-key",
    "browser.scroll",
    "browser.set-zoom",
    "browser.find",
    "browser.find.clear",
    "browser.dialog.handle",
    "browser.screencast.start",
    "browser.screencast.ack",
    "browser.cancel",
    "browser.wait.load",
    "browser.emulate",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPurpose {
    DocumentViewer,
}

pub fn session_purpose(payload: &Value) -> Result<Option<SessionPurpose>, ClientError> {
    match payload.get("purpose") {
        None => Ok(None),
        Some(Value::String(purpose)) if purpose == "document-viewer" => {
            Ok(Some(SessionPurpose::DocumentViewer))
        }
        _ => Err(ClientError::new(
            "browser_session_option_invalid",
            "unsupported browser session purpose",
        )),
    }
}

/// Called after stripping renderer host-owned fields and injecting defaults.
pub(crate) fn prepare_fields(
    kind: SessionKind,
    purpose: Option<SessionPurpose>,
    object: &mut Map<String, Value>,
) -> Result<(), ClientError> {
    if purpose == Some(SessionPurpose::DocumentViewer) {
        if kind != SessionKind::Local {
            return Err(ClientError::new(
                "browser_document_viewer_kind_refused",
                "document viewers require local Chromium",
            ));
        }
        if object
            .get("profileId")
            .is_some_and(|profile| profile.as_str() != Some(DOCUMENT_VIEWER_PROFILE))
        {
            return Err(ClientError::new(
                "browser_document_viewer_profile_mismatch",
                "document viewers require the reserved profile",
            ));
        }
        object.insert("profileId".into(), json!(DOCUMENT_VIEWER_PROFILE));
        object.insert("extensionPaths".into(), json!([]));
        object.insert("disableExtensions".into(), json!(true));
        object.insert("captureCredentials".into(), json!(false));
        object.insert("injectOverlay".into(), json!(false));
    } else if object
        .get("profileId")
        .and_then(Value::as_str)
        .is_some_and(is_document_viewer_profile)
    {
        return Err(ClientError::new(
            PROFILE_RESERVED,
            "the document viewer profile is reserved",
        ));
    }
    Ok(())
}

pub fn authorize_operation(
    purpose: Option<SessionPurpose>,
    op: &str,
    payload: &Value,
) -> Result<(), ClientError> {
    if purpose == Some(SessionPurpose::DocumentViewer)
        && (!DOCUMENT_VIEWER_OPS.contains(&op)
            || (op == "browser.emulate" && !viewport_only(payload)))
    {
        return Err(ClientError::new(
            DOCUMENT_VIEWER_OP_REFUSED,
            format!("{op} is unavailable in a document viewer"),
        ));
    }
    Ok(())
}

/// Viewer emulation can only resize its named page, never change identity or environment.
fn viewport_only(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "sessionId" | "pageId" | "viewport" | "synchronizeFrame"
        )
    }) || ["sessionId", "pageId"].iter().any(|key| {
        !object
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    }) || object
        .get("synchronizeFrame")
        .is_some_and(|value| !value.is_boolean())
    {
        return false;
    }
    let Some(viewport) = object.get("viewport").and_then(Value::as_object) else {
        return false;
    };
    !viewport.keys().any(|key| {
        !matches!(
            key.as_str(),
            "width" | "height" | "deviceScaleFactor" | "fitToWidth"
        )
    }) && ["width", "height"].iter().all(|key| {
        viewport
            .get(*key)
            .and_then(Value::as_f64)
            .is_some_and(|size| size.fract() == 0.0 && (1.0..=8192.0).contains(&size))
    }) && viewport
        .get("deviceScaleFactor")
        .and_then(Value::as_f64)
        .is_some_and(|density| (0.5..=4.0).contains(&density))
        && viewport.get("fitToWidth").is_none_or(Value::is_boolean)
}

pub fn authorize_window(
    purpose: Option<SessionPurpose>,
    creator: &str,
    caller: &str,
) -> Result<(), ClientError> {
    if purpose == Some(SessionPurpose::DocumentViewer) && creator != caller {
        return Err(ClientError::new(
            DOCUMENT_VIEWER_WINDOW_MISMATCH,
            "the document viewer belongs to another window",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventRoute<'a> {
    Broadcast,
    Window(&'a str),
    Drop,
}

/// Credential submissions from a viewer never reach the vault or a window.
pub fn event_route(
    purpose: Option<SessionPurpose>,
    creator: &str,
    credential_submitted: bool,
) -> EventRoute<'_> {
    match (purpose, credential_submitted) {
        (Some(SessionPurpose::DocumentViewer), true) => EventRoute::Drop,
        (Some(SessionPurpose::DocumentViewer), false) => EventRoute::Window(creator),
        (None, _) => EventRoute::Broadcast,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::RENDERER_OPS;

    fn viewport_payload() -> Value {
        json!({"sessionId": "viewer", "pageId": "page", "viewport": {
            "width": 420, "height": 700, "deviceScaleFactor": 2, "fitToWidth": false
        }, "synchronizeFrame": true})
    }

    #[test]
    fn document_viewer_allowlist_contains_only_real_renderer_ops() {
        for op in DOCUMENT_VIEWER_OPS {
            assert!(RENDERER_OPS.contains(op), "unknown renderer op {op}");
            assert!(authorize_operation(
                Some(SessionPurpose::DocumentViewer),
                op,
                &viewport_payload()
            )
            .is_ok());
        }
        for op in RENDERER_OPS.iter().chain(crate::bridge::PRIVILEGED_OPS) {
            let result = authorize_operation(
                Some(SessionPurpose::DocumentViewer),
                op,
                &viewport_payload(),
            );
            assert_eq!(result.is_ok(), DOCUMENT_VIEWER_OPS.contains(op), "{op}");
            if let Err(error) = result {
                assert_eq!(error.code, DOCUMENT_VIEWER_OP_REFUSED);
            }
            assert!(authorize_operation(None, op, &Value::Null).is_ok());
        }
        assert!(authorize_operation(
            Some(SessionPurpose::DocumentViewer),
            "browser.future",
            &Value::Null
        )
        .is_err());
    }

    #[test]
    fn document_viewer_emulation_accepts_only_viewport_payloads() {
        let purpose = Some(SessionPurpose::DocumentViewer);
        let op = "browser.emulate";
        assert!(authorize_operation(purpose, op, &viewport_payload()).is_ok());
        let mut minimal = viewport_payload();
        minimal.as_object_mut().unwrap().remove("synchronizeFrame");
        minimal["viewport"]
            .as_object_mut()
            .unwrap()
            .remove("fitToWidth");
        assert!(authorize_operation(purpose, op, &minimal).is_ok());
        for key in [
            "userAgent",
            "geolocation",
            "device",
            "locale",
            "timezone",
            "media",
            "colorScheme",
            "offline",
            "reset",
            "extra",
        ] {
            let mut payload = viewport_payload();
            payload[key] = Value::Null;
            assert_eq!(
                authorize_operation(purpose, op, &payload).unwrap_err().code,
                DOCUMENT_VIEWER_OP_REFUSED,
                "{key}"
            );
            assert!(authorize_operation(None, op, &payload).is_ok());
            let mut nested = viewport_payload();
            nested["viewport"][key] = Value::Null;
            assert!(
                authorize_operation(purpose, op, &nested).is_err(),
                "nested {key}"
            );
        }
        for payload in [
            Value::Null,
            json!({}),
            {
                let mut value = viewport_payload();
                value["viewport"] = Value::Null;
                value
            },
            {
                let mut value = viewport_payload();
                value["pageId"] = json!("");
                value
            },
            {
                let mut value = viewport_payload();
                value["viewport"]["width"] = json!(0);
                value
            },
            {
                let mut value = viewport_payload();
                value["viewport"]["height"] = json!(8193);
                value
            },
            {
                let mut value = viewport_payload();
                value["viewport"]["width"] = json!(1.5);
                value
            },
            {
                let mut value = viewport_payload();
                value["viewport"]["deviceScaleFactor"] = json!(0);
                value
            },
            {
                let mut value = viewport_payload();
                value["viewport"]["fitToWidth"] = json!("true");
                value
            },
            {
                let mut value = viewport_payload();
                value["synchronizeFrame"] = json!(1);
                value
            },
        ] {
            assert!(
                authorize_operation(purpose, op, &payload).is_err(),
                "{payload}"
            );
        }
        // Other allowlisted operations keep their existing payload semantics.
        assert!(authorize_operation(purpose, "browser.navigate", &Value::Null).is_ok());
    }

    #[test]
    fn document_viewer_events_target_creator_and_drop_credentials() {
        let purpose = Some(SessionPurpose::DocumentViewer);
        assert_eq!(
            event_route(purpose, "dock", false),
            EventRoute::Window("dock")
        );
        assert_eq!(event_route(purpose, "dock", true), EventRoute::Drop);
        assert_eq!(event_route(None, "dock", false), EventRoute::Broadcast);
        assert_eq!(event_route(None, "dock", true), EventRoute::Broadcast);
    }

    #[test]
    fn document_viewer_window_binding_refuses_other_windows() {
        let purpose = Some(SessionPurpose::DocumentViewer);
        assert!(authorize_window(purpose, "dock", "dock").is_ok());
        assert_eq!(
            authorize_window(purpose, "dock", "agent").unwrap_err().code,
            DOCUMENT_VIEWER_WINDOW_MISMATCH
        );
        assert!(authorize_window(None, "dock", "agent").is_ok());
    }
}
