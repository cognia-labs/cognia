//! Generic OS-keyring-backed key/value secret store.
//!
//! Used by the workflow runtime (`SecretResolver`) and by per-plugin
//! credential stores (GitHub Delivery PAT / App key, E2B API key, …) that
//! need to keep tokens out of IndexedDB. Each entry is identified by a
//! `(namespace, key)` pair; the underlying keyring service name is
//! `com.cognia.<namespace>/v1` and the account is the key verbatim.
//!
//! The existing `anthropic_subscription` keyring module is left alone —
//! it has a specialised JSON shape and its own command surface. This module
//! is for plain string-valued secrets.
//!
//! Lookup / set / delete all swallow keyring `NoEntry` errors as `Ok(None)` /
//! no-ops so the caller can keep a single happy path. The thin
//! `keyring_secret_*` `#[tauri::command]` shells live app-side.

use crate::secret_store;
use serde::{Deserialize, Serialize};

/// The `(namespace, key[, value])` a secret-store command addresses, as the
/// desktop IPC shells and the companion RPC arms both receive it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreInput {
    pub namespace: String,
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// Optional guard for a set command. The primary input key is the revision;
/// related writes/deletions stay in that same namespace and one transaction.
/// Values are intentionally not Debug so tokens never enter diagnostic output.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreSetCondition {
    pub expected: Option<String>,
    #[serde(default)]
    pub changes: Vec<SecretStoreChange>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreChange {
    pub key: String,
    pub value: Option<String>,
}

/// Legacy input name retained for source compatibility.
pub type KeyringInput = SecretStoreInput;

const SERVICE_PREFIX: &str = "com.cognia.";
const SERVICE_SUFFIX: &str = "/v1";

fn service_name(namespace: &str) -> String {
    format!("{SERVICE_PREFIX}{namespace}{SERVICE_SUFFIX}")
}

/// Validate the `(namespace, key)` pair and return the resolved keyring
/// service name. Storage now goes through [`crate::secret_store`].
fn resolved_service(namespace: &str, key: &str) -> Result<String, String> {
    validate_namespace(namespace)?;
    validate_key(key)?;
    Ok(service_name(namespace))
}

/// A namespace may use `/` to separate its parts (`account-sync/v1`,
/// `mcp-credentials/v1`, `retrieval-profile-dek/v1`): every secret is a row in
/// one encrypted map keyed by `(service, account)` (`crate::secret_store`), so
/// a slash names nothing on disk, and `service_name` stays one-to-one because
/// it only wraps the namespace in a fixed prefix and suffix. What stays refused
/// is what still reads as a path or is ambiguous: empty parts (a leading,
/// trailing or doubled `/`), `.` / `..` parts, backslashes and control
/// characters.
fn validate_namespace(namespace: &str) -> Result<(), String> {
    if namespace.trim().is_empty() {
        return Err("keyring namespace must not be empty".into());
    }
    if namespace.trim() != namespace {
        return Err("keyring namespace must not have surrounding whitespace".into());
    }
    if namespace.chars().any(|ch| ch.is_control() || ch == '\\') {
        return Err("keyring namespace contains invalid characters".into());
    }
    if namespace
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("keyring namespace has an empty or relative path part".into());
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("keyring key must not be empty".into());
    }
    if key.trim() != key {
        return Err("keyring key must not have surrounding whitespace".into());
    }
    if key.chars().any(char::is_control) {
        return Err("keyring key contains invalid characters".into());
    }
    Ok(())
}

/// Read a single secret. Returns `Ok(None)` when nothing is stored under
/// `(namespace, key)`.
pub fn get(namespace: &str, key: &str) -> Result<Option<String>, String> {
    let service = resolved_service(namespace, key)?;
    secret_store::get(&service, key)
}

/// Upsert a secret. Empty `value` is rejected — call {@link clear} to remove.
pub fn set(namespace: &str, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("keyring set: value must not be empty".into());
    }
    let service = resolved_service(namespace, key)?;
    secret_store::set(&service, key, value)
}

/// Set the revision and related secrets only if the stored revision matches.
/// Validation completes before any member is changed; mismatch changes nothing.
pub fn set_if(
    namespace: &str,
    key: &str,
    value: &str,
    condition: &SecretStoreSetCondition,
) -> Result<(), String> {
    if value.is_empty() {
        return Err("keyring set: value must not be empty".into());
    }
    let service = resolved_service(namespace, key)?;
    let mut mutations = Vec::with_capacity(condition.changes.len() + 1);
    mutations.push(secret_store::SecretMutation::Set {
        service: &service,
        account: key,
        value,
    });
    for change in &condition.changes {
        validate_key(&change.key)?;
        if change.key == key {
            return Err("keyring condition: related change must not overwrite the revision".into());
        }
        mutations.push(match change.value.as_deref() {
            Some("") => return Err("keyring set: value must not be empty".into()),
            Some(value) => secret_store::SecretMutation::Set {
                service: &service,
                account: &change.key,
                value,
            },
            None => secret_store::SecretMutation::Delete {
                service: &service,
                account: &change.key,
            },
        });
    }
    secret_store::apply_batch_if(
        &mutations,
        secret_store::SecretCondition {
            service: &service,
            account: key,
            expected: condition.expected.as_deref(),
        },
    )
}

/// Check canonical auth metadata and retain its dedicated auth fence during a
/// synchronous identity publication. Ordinary receipt secret I/O remains free;
/// the operation must not invoke conditional batch APIs. Raw legacy setters and
/// unconditional batches do not participate, so auth revisions must be changed
/// through conditional sets.
pub fn with_value<T>(
    namespace: &str,
    key: &str,
    expected: Option<&str>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let service = resolved_service(namespace, key)?;
    secret_store::with_value(&service, key, expected, operation)
}

/// Remove an entry. Idempotent — missing entries return `Ok(())`.
pub fn clear(namespace: &str, key: &str) -> Result<(), String> {
    let service = resolved_service(namespace, key)?;
    secret_store::delete(&service, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_store_input_reads_the_wire_shape_and_defaults_its_value() {
        let input: SecretStoreInput =
            serde_json::from_value(serde_json::json!({ "namespace": "webhooks", "key": "k" }))
                .expect("wire shape");
        assert_eq!(
            (input.namespace.as_str(), input.key.as_str()),
            ("webhooks", "k")
        );
        assert_eq!(input.value, None);
    }

    #[test]
    fn conditional_set_wire_shape_commits_related_changes_and_refuses_stale_writes() {
        let condition: SecretStoreSetCondition = serde_json::from_value(serde_json::json!({
            "expected": null,
            "changes": [{ "key": "session", "value": "token" }, { "key": "reauth", "value": null }]
        }))
        .unwrap();
        set_if("conditional-wire", "revision", "signed-in", &condition).unwrap();
        assert_eq!(
            get("conditional-wire", "session").unwrap().as_deref(),
            Some("token")
        );
        let logout = SecretStoreSetCondition {
            expected: Some("signed-in".into()),
            changes: vec![SecretStoreChange {
                key: "session".into(),
                value: None,
            }],
        };
        set_if("conditional-wire", "revision", "signed-out", &logout).unwrap();
        assert_eq!(
            set_if("conditional-wire", "revision", "late-signin", &logout).unwrap_err(),
            "secret-store condition mismatch"
        );
        assert_eq!(
            get("conditional-wire", "revision").unwrap().as_deref(),
            Some("signed-out")
        );
        assert_eq!(get("conditional-wire", "session").unwrap(), None);
    }

    #[test]
    fn guarded_identity_publication_validates_namespace_and_stored_revision() {
        set("person-side-effect", "revision", "current").unwrap();
        let mut published = false;
        with_value("person-side-effect", "revision", Some("current"), || {
            published = true;
            Ok(())
        })
        .unwrap();
        assert!(published);
        assert!(
            with_value::<()>("person-side-effect", "revision", Some("old"), || panic!(
                "stale publication"
            ))
            .is_err()
        );
        assert!(with_value::<()>("", "revision", Some("current"), || panic!(
            "invalid namespace"
        ))
        .is_err());
    }

    #[test]
    fn conditional_set_validates_every_change_before_publishing_revision() {
        let invalid = SecretStoreSetCondition {
            expected: None,
            changes: vec![
                SecretStoreChange {
                    key: "session".into(),
                    value: Some("token".into()),
                },
                SecretStoreChange {
                    key: "revision".into(),
                    value: None,
                },
            ],
        };
        assert!(set_if("conditional-invalid", "revision", "new", &invalid).is_err());
        assert_eq!(get("conditional-invalid", "revision").unwrap(), None);
        assert_eq!(get("conditional-invalid", "session").unwrap(), None);
    }

    #[test]
    fn service_name_includes_namespace() {
        assert_eq!(service_name("demo-delivery"), "com.cognia.demo-delivery/v1");
        assert_eq!(service_name("plugin:p"), "com.cognia.plugin:p/v1");
    }

    #[test]
    fn resolved_service_rejects_empty_namespace_and_key() {
        assert!(resolved_service("", "k").is_err());
        assert!(resolved_service("ns", "").is_err());
    }

    #[test]
    fn resolved_service_rejects_blank_or_untrimmed_namespace_and_key() {
        assert!(resolved_service("   ", "k").is_err());
        assert!(resolved_service(" ns", "k").is_err());
        assert!(resolved_service("ns ", "k").is_err());
        assert!(resolved_service("ns", "   ").is_err());
        assert!(resolved_service("ns", " key").is_err());
        assert!(resolved_service("ns", "key ").is_err());
    }

    #[test]
    fn resolved_service_rejects_backslashes_and_control_chars() {
        assert!(resolved_service("bad\\name", "k").is_err());
        assert!(resolved_service("bad\nname", "k").is_err());
        assert_eq!(
            resolved_service("plugin:p", "token").unwrap(),
            "com.cognia.plugin:p/v1"
        );
    }

    // The app's own namespaces use `/` between a name and its version; they
    // were refused here, so nothing under them could be stored on desktop or
    // a headless host (account sync keys, MCP credentials, retrieval keys).
    #[test]
    fn resolved_service_accepts_slash_separated_namespaces() {
        for namespace in [
            "account-sync/v1",
            "mcp-credentials/v1",
            "retrieval-profile-dek/v1",
        ] {
            assert_eq!(
                resolved_service(namespace, "k").unwrap(),
                format!("com.cognia.{namespace}/v1")
            );
        }
    }

    #[test]
    fn resolved_service_rejects_empty_or_relative_path_parts() {
        for namespace in [
            "/name", "name/", "a//b", ".", "..", "a/./b", "a/../b", "../a",
        ] {
            assert!(resolved_service(namespace, "k").is_err(), "{namespace}");
        }
    }

    #[test]
    fn slash_namespaces_round_trip_and_stay_apart_from_their_parent() {
        set("keyring-slash/v1", "tok", "child").unwrap();
        set("keyring-slash", "tok", "parent").unwrap();
        assert_eq!(
            get("keyring-slash/v1", "tok").unwrap(),
            Some("child".to_string())
        );
        assert_eq!(
            get("keyring-slash", "tok").unwrap(),
            Some("parent".to_string())
        );
        clear("keyring-slash/v1", "tok").unwrap();
        clear("keyring-slash", "tok").unwrap();
        assert_eq!(get("keyring-slash/v1", "tok").unwrap(), None);
    }

    #[test]
    fn set_rejects_empty_value() {
        let err = set("test-ns", "k", "").unwrap_err();
        assert!(err.contains("must not be empty"));
    }

    #[test]
    fn get_set_clear_round_trip() {
        // Hermetic via the in-memory secret_store global under cfg(test).
        let ns = "keyring-secrets-round-trip";
        assert_eq!(get(ns, "tok").unwrap(), None);
        set(ns, "tok", "s3cr3t").unwrap();
        assert_eq!(get(ns, "tok").unwrap(), Some("s3cr3t".to_string()));
        clear(ns, "tok").unwrap();
        assert_eq!(get(ns, "tok").unwrap(), None);
    }
}
