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

pub fn authorize_operation(purpose: Option<SessionPurpose>, op: &str) -> Result<(), ClientError> {
    if purpose == Some(SessionPurpose::DocumentViewer) && !DOCUMENT_VIEWER_OPS.contains(&op) {
        return Err(ClientError::new(
            DOCUMENT_VIEWER_OP_REFUSED,
            format!("{op} is unavailable in a document viewer"),
        ));
    }
    Ok(())
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

    #[test]
    fn document_viewer_allowlist_contains_only_real_renderer_ops() {
        for op in DOCUMENT_VIEWER_OPS {
            assert!(RENDERER_OPS.contains(op), "unknown renderer op {op}");
            assert!(authorize_operation(Some(SessionPurpose::DocumentViewer), op).is_ok());
        }
        for op in RENDERER_OPS.iter().chain(crate::bridge::PRIVILEGED_OPS) {
            let result = authorize_operation(Some(SessionPurpose::DocumentViewer), op);
            assert_eq!(result.is_ok(), DOCUMENT_VIEWER_OPS.contains(op), "{op}");
            if let Err(error) = result {
                assert_eq!(error.code, DOCUMENT_VIEWER_OP_REFUSED);
            }
            assert!(authorize_operation(None, op).is_ok());
        }
        assert!(
            authorize_operation(Some(SessionPurpose::DocumentViewer), "browser.future").is_err()
        );
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
