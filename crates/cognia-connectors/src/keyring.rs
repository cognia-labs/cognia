//! Storage helpers for platform connector credentials.
//!
//! Service: `"com.cognia.platforms"`.
//! Account naming: `"<adapterId>:<credentialName>"` — e.g. `"tg-personal:botToken"`.
//!
//! Backed by [`cognia_secrets::secret_store`] (single OS-keyring master key); a missing
//! entry maps to `None` on reads, and delete is idempotent.

use cognia_secrets::secret_store;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// One synchronous boundary for connector credential transitions on this host.
static USER_AUTH_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
const USER_EPOCH: &str = "user_authorization_epoch";

/// Owned by `host_secrets`, which indexes these entries for "Secrets on this
/// host" (ADR-0224 A6); one constant so the two cannot drift.
const SERVICE: &str = cognia_secrets::host_secrets::CONNECTOR_SERVICE;

/// The store account for `(adapter_id, credential)`, which is also the name
/// `host_secrets` lists the credential under.
pub fn account_key(adapter_id: &str, credential: &str) -> String {
    format!("{adapter_id}:{credential}")
}

/// Store `value` for `(adapter_id, credential)`.
pub fn set(adapter_id: &str, credential: &str, value: &str) -> Result<(), String> {
    set_with_writer(
        adapter_id,
        credential,
        value,
        None,
        chrono::Utc::now().timestamp_millis(),
    )
}

/// Seal a connector credential, write generation and its actual writer in
/// one transaction. Callers must not append a separate metadata-only write.
pub fn set_with_writer(
    adapter_id: &str,
    credential: &str,
    value: &str,
    writer: Option<cognia_secrets::host_secrets::SecretWriter>,
    now_ms: i64,
) -> Result<(), String> {
    let _guard = USER_AUTH_LOCK.lock();
    let write = || {
        cognia_secrets::host_secrets::set(
            cognia_secrets::host_secrets::HostSecretKind::Connector,
            &account_key(adapter_id, credential),
            value,
            writer,
            now_ms,
        )
    };
    if matches!(credential, "token" | "encodingAesKey" | "appId") {
        super::wechat_oa_ingress::replace_token(adapter_id, write)
    } else {
        write()
    }
}

/// Retrieve the stored value for `(adapter_id, credential)`.
///
/// Returns `Ok(None)` when no entry exists.
pub fn get(adapter_id: &str, credential: &str) -> Result<Option<String>, String> {
    secret_store::get(SERVICE, &account_key(adapter_id, credential))
}

/// Host-only atomic value/revision capture used to fence asynchronous work.
pub fn get_snapshot(
    adapter_id: &str,
    credential: &str,
) -> Result<Option<cognia_secrets::host_secrets::HostSecretSnapshot>, String> {
    cognia_secrets::host_secrets::snapshot(
        cognia_secrets::host_secrets::HostSecretKind::Connector,
        &account_key(adapter_id, credential),
    )
}

/// Delete the entry for `(adapter_id, credential)`.
///
/// Returns `Ok(())` even when the entry did not exist.
pub fn delete(adapter_id: &str, credential: &str) -> Result<(), String> {
    let _guard = USER_AUTH_LOCK.lock();
    let delete = || {
        cognia_secrets::host_secrets::delete(
            cognia_secrets::host_secrets::HostSecretKind::Connector,
            &account_key(adapter_id, credential),
        )
    };
    if credential == "token" {
        super::wechat_oa_ingress::delete_token_and_clear(adapter_id, delete)
    } else if matches!(credential, "encodingAesKey" | "appId") {
        super::wechat_oa_ingress::replace_token(adapter_id, delete)
    } else {
        delete()
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LarkUserAuthInput {
    Snapshot {
        adapter_id: String,
    },
    Authorize {
        adapter_id: String,
        expected_authorization_epoch: String,
        pending_state: String,
        account_label: Option<String>,
        scopes: Option<String>,
        access_token: String,
        refresh_token: String,
    },
    Refresh {
        adapter_id: String,
        expected_authorization_epoch: String,
        expected_refresh_revision: String,
        access_token: String,
        refresh_token: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkUserAuthState {
    pub authorization_epoch: String,
    pub configured: bool,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub refresh_revision: Option<String>,
    pub account_label: Option<String>,
    pub scopes: Vec<String>,
}

type RevisionExpectations = Vec<(String, Option<String>)>;

fn token_fingerprint(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn capture_user_auth(
    adapter_id: &str,
) -> Result<(LarkUserAuthState, RevisionExpectations, bool), String> {
    // Direct host-secret edits/revocation must invalidate the lineage too.
    // Register optional members before their first publication as well.
    let app_key = account_key(adapter_id, "appId");
    if secret_store::get(SERVICE, &app_key)?.is_some() {
        let access_key = account_key(adapter_id, "user_token");
        let refresh_key = account_key(adapter_id, "user_refresh_token");
        let dependencies = [cognia_secrets::host_secrets::SecretDependency {
            service: SERVICE.into(),
            account: account_key(adapter_id, USER_EPOCH),
            reset_on_write: true,
        }];
        let access_dependencies = [
            dependencies[0].clone(),
            cognia_secrets::host_secrets::SecretDependency {
                service: SERVICE.into(),
                account: refresh_key.clone(),
                reset_on_write: true,
            },
        ];
        let refresh_dependencies = [
            dependencies[0].clone(),
            cognia_secrets::host_secrets::SecretDependency {
                service: SERVICE.into(),
                account: access_key.clone(),
                reset_on_write: true,
            },
        ];
        cognia_secrets::host_secrets::with_secret_dependency_group(
            cognia_secrets::host_secrets::HostSecretKind::Connector,
            &app_key,
            &[],
            &[
                (&access_key, &access_dependencies),
                (&refresh_key, &refresh_dependencies),
            ],
            || Ok(()),
        )?;
    }
    let names = [
        "appId",
        "appSecret",
        "user_token",
        "user_refresh_token",
        USER_EPOCH,
    ];
    let mut snapshots = Vec::new();
    for name in names {
        snapshots.push(get_snapshot(adapter_id, name)?);
    }
    // Adopt a never-managed legacy pair once, while both revisions are
    // atomically current. The existing lineage record retains write history
    // after dependency invalidation, including deletion of both credentials.
    let legacy_lineage = format!(
        "legacy-{}-{}",
        snapshots[2]
            .as_ref()
            .map(|s| s.revision.as_str())
            .unwrap_or("bot"),
        snapshots[3]
            .as_ref()
            .map(|s| s.revision.as_str())
            .unwrap_or("absent")
    );
    if snapshots[4].is_none()
        && !cognia_secrets::host_secrets::has_recorded_write(
            cognia_secrets::host_secrets::HostSecretKind::Connector,
            &account_key(adapter_id, USER_EPOCH),
        )?
    {
        if let (Some(access), Some(refresh)) = (&snapshots[2], &snapshots[3]) {
            let lineage = serde_json::json!({"version":2,"lineage":legacy_lineage,
                "label":null,"scopes":[],"accessFingerprint":token_fingerprint(&access.value),
                "refreshFingerprint":token_fingerprint(&refresh.value)})
            .to_string();
            let keys: Vec<_> = names
                .iter()
                .map(|name| account_key(adapter_id, name))
                .collect();
            let guards: Vec<_> = keys
                .iter()
                .zip(&snapshots)
                .map(|(key, value)| {
                    (
                        key.as_str(),
                        value.as_ref().map(|value| value.revision.as_str()),
                    )
                })
                .collect();
            cognia_secrets::host_secrets::set_many_if_current(
                cognia_secrets::host_secrets::HostSecretKind::Connector,
                &[(keys[4].as_str(), lineage.as_str())],
                &guards,
                None,
                chrono::Utc::now().timestamp_millis(),
            )
            .map_err(|error| {
                if error == "host_secret_revision_changed" {
                    "lark_auth_stale".into()
                } else {
                    error
                }
            })?;
            snapshots[4] = get_snapshot(adapter_id, USER_EPOCH)?;
        }
    }
    let configured = snapshots[0].is_some() && snapshots[1].is_some();
    let epoch = snapshots[4]
        .as_ref()
        .map(|s| s.value.as_str())
        .unwrap_or("legacy");
    let metadata: Option<serde_json::Value> =
        serde_json::from_str(epoch)
            .ok()
            .filter(|metadata: &serde_json::Value| {
                // Markerless metadata predates refresh-credential dependencies:
                // fingerprints cannot prove it survived no same-value rewrite.
                metadata["version"].as_u64() == Some(2)
                    && snapshots[2].as_ref().is_some_and(|s| {
                        metadata["accessFingerprint"].as_str()
                            == Some(token_fingerprint(&s.value).as_str())
                    })
                    && snapshots[3].as_ref().is_some_and(|s| {
                        metadata["refreshFingerprint"].as_str()
                            == Some(token_fingerprint(&s.value).as_str())
                    })
            });
    let lineage = metadata
        .as_ref()
        .and_then(|m| m["lineage"].as_str())
        .unwrap_or(&legacy_lineage);
    let coherent_pair = metadata.is_some()
        || (snapshots[4].is_none()
            && !cognia_secrets::host_secrets::has_recorded_write(
                cognia_secrets::host_secrets::HostSecretKind::Connector,
                &account_key(adapter_id, USER_EPOCH),
            )?);
    let app_revision = |index: usize| {
        snapshots[index]
            .as_ref()
            .map(|s| s.revision.as_str())
            .unwrap_or("absent")
    };
    let authorization_epoch = format!(
        "{}:{}:{}:{}",
        app_revision(0),
        app_revision(1),
        lineage,
        if snapshots[2].is_some() {
            "user"
        } else {
            "bot"
        }
    );
    let expected = names
        .iter()
        .zip(&snapshots)
        .map(|(name, value)| {
            (
                account_key(adapter_id, name),
                value.as_ref().map(|s| s.revision.clone()),
            )
        })
        .collect();
    Ok((
        LarkUserAuthState {
            authorization_epoch,
            configured,
            access_token: snapshots[2].as_ref().map(|s| s.value.clone()),
            refresh_token: snapshots[3].as_ref().map(|s| s.value.clone()),
            refresh_revision: snapshots[3].as_ref().map(|s| s.revision.clone()),
            account_label: metadata
                .as_ref()
                .and_then(|m| m["label"].as_str())
                .map(str::to_string),
            scopes: metadata
                .as_ref()
                .and_then(|m| m["scopes"].as_array())
                .map(|s| {
                    s.iter()
                        .filter_map(|s| s.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        },
        expected,
        coherent_pair,
    ))
}

/// Token pairs stay in their existing keyring accounts. Only their publication
/// and conditional refresh are new. Picker identity/scopes share their lineage;
/// the adapter database remains a display projection.
pub fn lark_user_auth(input: LarkUserAuthInput) -> Result<LarkUserAuthState, String> {
    use cognia_secrets::host_secrets::{self, HostSecretKind};
    let _guard = USER_AUTH_LOCK.lock();
    let (adapter, epoch, pending, refresh_revision, access, refresh) = match &input {
        LarkUserAuthInput::Snapshot { adapter_id } => {
            return capture_user_auth(adapter_id).map(|s| s.0);
        }
        LarkUserAuthInput::Authorize {
            adapter_id,
            expected_authorization_epoch,
            pending_state,
            access_token,
            refresh_token,
            ..
        } => (
            adapter_id,
            expected_authorization_epoch,
            Some(pending_state),
            None,
            access_token,
            refresh_token,
        ),
        LarkUserAuthInput::Refresh {
            adapter_id,
            expected_authorization_epoch,
            expected_refresh_revision,
            access_token,
            refresh_token,
        } => (
            adapter_id,
            expected_authorization_epoch,
            None,
            Some(expected_refresh_revision),
            access_token,
            refresh_token,
        ),
    };
    let (current, mut expectations, coherent_pair) = capture_user_auth(adapter)?;
    if !current.configured
        || &current.authorization_epoch != epoch
        || (refresh_revision.is_some() && (current.access_token.is_none() || !coherent_pair))
        || refresh_revision.is_some_and(|r| current.refresh_revision.as_ref() != Some(r))
    {
        return Err("lark_auth_stale".into());
    }
    if let Some(state) = pending {
        let snapshot = get_snapshot(adapter, "oauth_pending")?.ok_or("lark_auth_stale")?;
        let record: serde_json::Value =
            serde_json::from_str(&snapshot.value).map_err(|_| "lark_auth_stale")?;
        let now = chrono::Utc::now().timestamp_millis();
        if record["state"].as_str() != Some(state)
            || record["authorizationEpoch"].as_str() != Some(epoch)
            || !record["ts"]
                .as_i64()
                .is_some_and(|ts| ts <= now && now - ts <= 600_000)
        {
            return Err("lark_auth_stale".into());
        }
        expectations.push((
            account_key(adapter, "oauth_pending"),
            Some(snapshot.revision),
        ));
    }
    let access_key = account_key(adapter, "user_token");
    let refresh_key = account_key(adapter, "user_refresh_token");
    let epoch_key = account_key(adapter, USER_EPOCH);
    let mut values = vec![
        (access_key.as_str(), access.as_str()),
        (refresh_key.as_str(), refresh.as_str()),
    ];
    let (lineage_id, label, scopes) = if let LarkUserAuthInput::Authorize {
        account_label,
        scopes,
        ..
    } = &input
    {
        (
            uuid::Uuid::new_v4().to_string(),
            account_label.clone(),
            scopes
                .as_deref()
                .unwrap_or("")
                .split(|c: char| c.is_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>(),
        )
    } else {
        (
            current
                .authorization_epoch
                .split(':')
                .nth(2)
                .unwrap_or("bot")
                .to_string(),
            current.account_label,
            current.scopes,
        )
    };
    // Fingerprints keep direct legacy/host-secret edits from inheriting the
    // label, scopes or lineage of a different pair. They never leave the host.
    let lineage = serde_json::json!({ "version": 2, "lineage": lineage_id, "label": label, "scopes": scopes,
        "accessFingerprint": token_fingerprint(access), "refreshFingerprint": token_fingerprint(refresh) }).to_string();
    values.push((&epoch_key, &lineage));
    let guards: Vec<_> = expectations
        .iter()
        .map(|(name, revision)| (name.as_str(), revision.as_deref()))
        .collect();
    host_secrets::set_many_if_current(
        HostSecretKind::Connector,
        &values,
        &guards,
        None,
        chrono::Utc::now().timestamp_millis(),
    )
    .map_err(|error| {
        if error == "host_secret_revision_changed" {
            "lark_auth_stale".into()
        } else {
            error
        }
    })?;
    if pending.is_some() {
        // Consume only the state checked under this same host lock. A later
        // begin cannot be erased by a renderer's delayed best-effort cleanup.
        let _ = host_secrets::delete(
            HostSecretKind::Connector,
            &account_key(adapter, "oauth_pending"),
        );
    }
    capture_user_auth(adapter).map(|s| s.0)
}

/// Probe each name in `accounts` for the given `adapter_id` and return the
/// subset that have an entry.
///
/// OS keyrings don't provide reliable enumeration, so the caller (TS side)
/// supplies the list of account names it knows about (from
/// `AdapterInstanceRow.credentialsRef.accounts`), and we probe each one.
pub fn list(adapter_id: &str, accounts: &[String]) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    for account in accounts {
        if get(adapter_id, account)?.is_some() {
            found.push(account.clone());
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lark_fixture(adapter: &str) -> LarkUserAuthState {
        set(adapter, "appId", "fixture-app").unwrap();
        set(adapter, "appSecret", "fixture-secret").unwrap();
        set(adapter, "user_token", "user-a").unwrap();
        set(adapter, "user_refresh_token", "refresh-a").unwrap();
        lark_user_auth(LarkUserAuthInput::Snapshot {
            adapter_id: adapter.into(),
        })
        .unwrap()
    }

    #[test]
    fn observed_legacy_pair_cannot_be_readopted_after_both_credentials_are_recreated() {
        use cognia_secrets::host_secrets::{self, HostSecretKind};
        for direct in [false, true] {
            let adapter = format!("legacy-pair-recreated-{direct}");
            lark_fixture(&adapter);
            for name in ["user_token", "user_refresh_token"] {
                if direct {
                    host_secrets::delete(HostSecretKind::Connector, &account_key(&adapter, name))
                        .unwrap();
                } else {
                    delete(&adapter, name).unwrap();
                }
            }
            for (name, value) in [
                ("user_token", "user-b"),
                ("user_refresh_token", "refresh-a"),
            ] {
                if direct {
                    host_secrets::set(
                        HostSecretKind::Connector,
                        &account_key(&adapter, name),
                        value,
                        None,
                        0,
                    )
                    .unwrap();
                } else {
                    set(&adapter, name, value).unwrap();
                }
            }
            let current = lark_user_auth(LarkUserAuthInput::Snapshot {
                adapter_id: adapter.clone(),
            })
            .unwrap();
            let result = lark_user_auth(LarkUserAuthInput::Refresh {
                adapter_id: adapter.clone(),
                expected_authorization_epoch: current.authorization_epoch,
                expected_refresh_revision: current.refresh_revision.unwrap_or_default(),
                access_token: "restored-a".into(),
                refresh_token: "rotated-a".into(),
            });
            assert_eq!(result.err().as_deref(), Some("lark_auth_stale"));
            assert_ne!(
                get(&adapter, "user_token").unwrap().as_deref(),
                Some("restored-a")
            );
        }
    }

    #[test]
    fn user_refresh_preserves_lineage_and_reauthorization_rejects_late_refresh() {
        let adapter = "lark-fenced-refresh";
        let first = lark_fixture(adapter);
        let refreshed = lark_user_auth(LarkUserAuthInput::Refresh {
            adapter_id: adapter.into(),
            expected_authorization_epoch: first.authorization_epoch.clone(),
            expected_refresh_revision: first.refresh_revision.unwrap(),
            access_token: "user-a-refreshed".into(),
            refresh_token: "refresh-a-new".into(),
        })
        .unwrap();
        assert_eq!(refreshed.authorization_epoch, first.authorization_epoch);
        set(
            adapter,
            "oauth_pending",
            &serde_json::json!({"state":"state-b", "ts":chrono::Utc::now().timestamp_millis(), "authorizationEpoch": refreshed.authorization_epoch})
                .to_string(),
        )
        .unwrap();
        let changed = lark_user_auth(LarkUserAuthInput::Authorize {
            adapter_id: adapter.into(),
            expected_authorization_epoch: refreshed.authorization_epoch.clone(),
            pending_state: "state-b".into(),
            access_token: "user-b".into(),
            refresh_token: "refresh-b".into(),
            account_label: Some("User B".into()),
            scopes: Some("drive:drive:readonly".into()),
        })
        .unwrap();
        assert_ne!(changed.authorization_epoch, first.authorization_epoch);
        assert_eq!(changed.account_label.as_deref(), Some("User B"));
        let current = lark_user_auth(LarkUserAuthInput::Refresh {
            adapter_id: adapter.into(),
            expected_authorization_epoch: changed.authorization_epoch.clone(),
            expected_refresh_revision: changed.refresh_revision.unwrap(),
            access_token: "user-b-refreshed".into(),
            refresh_token: "refresh-b-new".into(),
        })
        .unwrap();
        assert_eq!(current.authorization_epoch, changed.authorization_epoch);
        assert_eq!(current.account_label.as_deref(), Some("User B"));
        assert_eq!(current.scopes, vec!["drive:drive:readonly"]);
        assert!(get(adapter, "oauth_pending").unwrap().is_none());
        let stale = lark_user_auth(LarkUserAuthInput::Refresh {
            adapter_id: adapter.into(),
            expected_authorization_epoch: refreshed.authorization_epoch,
            expected_refresh_revision: refreshed.refresh_revision.unwrap(),
            access_token: "late-user-a".into(),
            refresh_token: "late-refresh-a".into(),
        });
        assert_eq!(stale.err().as_deref(), Some("lark_auth_stale"));
        assert_eq!(
            get(adapter, "user_token").unwrap().as_deref(),
            Some("user-b-refreshed")
        );
    }

    #[test]
    fn pending_authorization_cannot_adopt_an_epoch_created_after_revocation() {
        let adapter = "lark-revoked-pending";
        let first = lark_fixture(adapter);
        set(
            adapter,
            "oauth_pending",
            &serde_json::json!({"state":"old-state", "ts":chrono::Utc::now().timestamp_millis(),
                "authorizationEpoch": first.authorization_epoch})
            .to_string(),
        )
        .unwrap();
        delete(adapter, "user_token").unwrap();
        let revoked = lark_user_auth(LarkUserAuthInput::Snapshot {
            adapter_id: adapter.into(),
        })
        .unwrap();
        assert!(revoked.access_token.is_none());
        let error = lark_user_auth(LarkUserAuthInput::Authorize {
            adapter_id: adapter.into(),
            expected_authorization_epoch: revoked.authorization_epoch,
            pending_state: "old-state".into(),
            access_token: "resurrected".into(),
            refresh_token: "resurrected-refresh".into(),
            account_label: None,
            scopes: None,
        })
        .err();
        assert_eq!(error.as_deref(), Some("lark_auth_stale"));
        assert!(get(adapter, "user_token").unwrap().is_none());
        assert!(get(adapter, "user_refresh_token").unwrap().is_none());
    }

    #[test]
    fn refresh_cannot_recreate_a_deleted_access_identity() {
        let adapter = "lark-deleted-access-refresh";
        lark_fixture(adapter);
        delete(adapter, "user_token").unwrap();
        let revoked = lark_user_auth(LarkUserAuthInput::Snapshot {
            adapter_id: adapter.into(),
        })
        .unwrap();
        assert!(revoked.access_token.is_none());
        let result = lark_user_auth(LarkUserAuthInput::Refresh {
            adapter_id: adapter.into(),
            expected_authorization_epoch: revoked.authorization_epoch,
            expected_refresh_revision: revoked.refresh_revision.unwrap_or_default(),
            access_token: "must-not-restore".into(),
            refresh_token: "must-not-rotate".into(),
        });
        assert_eq!(result.err().as_deref(), Some("lark_auth_stale"));
        assert!(get(adapter, "user_token").unwrap().is_none());
        assert!(get(adapter, "user_refresh_token").unwrap().is_none());
    }

    #[test]
    fn refresh_credential_aba_cannot_restore_lineage_or_pending_authorization() {
        for (delete_first, legacy) in [(false, false), (true, false), (false, true), (true, true)] {
            let adapter_name = format!("lark-refresh-aba-{delete_first}-{legacy}");
            let adapter = adapter_name.as_str();
            let first = lark_fixture(adapter);
            set(
                adapter,
                "oauth_pending",
                &serde_json::json!({
                    "state": "connect", "ts": chrono::Utc::now().timestamp_millis(),
                    "authorizationEpoch": first.authorization_epoch,
                })
                .to_string(),
            )
            .unwrap();
            let connected = lark_user_auth(LarkUserAuthInput::Authorize {
                adapter_id: adapter.into(),
                expected_authorization_epoch: first.authorization_epoch,
                pending_state: "connect".into(),
                access_token: "connected-access".into(),
                refresh_token: "connected-refresh".into(),
                account_label: Some("Connected User".into()),
                scopes: Some("search:docs:read".into()),
            })
            .unwrap();
            set(
                adapter,
                "oauth_pending",
                &serde_json::json!({
                    "state": "before-aba", "ts": chrono::Utc::now().timestamp_millis(),
                    "authorizationEpoch": connected.authorization_epoch,
                })
                .to_string(),
            )
            .unwrap();
            if legacy {
                // Emulate the captured pre-repair persisted state: markerless
                // metadata and an index without the refresh-token dependency.
                let epoch_key = account_key(adapter, USER_EPOCH);
                let mut metadata: serde_json::Value =
                    serde_json::from_str(&get(adapter, USER_EPOCH).unwrap().unwrap()).unwrap();
                metadata.as_object_mut().unwrap().remove("version");
                secret_store::set(SERVICE, &epoch_key, &metadata.to_string()).unwrap();
                let index_service = "com.cognia.host-secret-index/v1";
                let index_account =
                    format!("connector/{}", account_key(adapter, "user_refresh_token"));
                let mut index: serde_json::Value = serde_json::from_str(
                    &secret_store::get(index_service, &index_account)
                        .unwrap()
                        .unwrap(),
                )
                .unwrap();
                index["dependentSecrets"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|dependency| dependency["account"] != epoch_key);
                secret_store::set(index_service, &index_account, &index.to_string()).unwrap();
            }
            if delete_first {
                delete(adapter, "user_refresh_token").unwrap();
                if !legacy {
                    let deleted = lark_user_auth(LarkUserAuthInput::Snapshot {
                        adapter_id: adapter.into(),
                    })
                    .unwrap();
                    assert_ne!(deleted.authorization_epoch, connected.authorization_epoch);
                }
            }
            set(adapter, "user_refresh_token", "connected-refresh").unwrap();
            let restored = lark_user_auth(LarkUserAuthInput::Snapshot {
                adapter_id: adapter.into(),
            })
            .unwrap();
            assert_ne!(restored.authorization_epoch, connected.authorization_epoch);
            assert!(restored.account_label.is_none());
            assert!(restored.scopes.is_empty());
            assert_eq!(
                lark_user_auth(LarkUserAuthInput::Authorize {
                    adapter_id: adapter.into(),
                    expected_authorization_epoch: connected.authorization_epoch,
                    pending_state: "before-aba".into(),
                    access_token: "pending-access".into(),
                    refresh_token: "pending-refresh".into(),
                    account_label: None,
                    scopes: None,
                })
                .err()
                .as_deref(),
                Some("lark_auth_stale")
            );
        }
    }

    #[test]
    fn failed_pair_write_cannot_publish_mixed_tokens_or_advance_authorization() {
        let adapter = "lark-atomic-pair";
        let first = lark_fixture(adapter);
        secret_store::fail_next_mutation_for_test(
            SERVICE,
            &account_key(adapter, "user_refresh_token"),
        );
        assert!(lark_user_auth(LarkUserAuthInput::Refresh {
            adapter_id: adapter.into(),
            expected_authorization_epoch: first.authorization_epoch.clone(),
            expected_refresh_revision: first.refresh_revision.unwrap(),
            access_token: "new-access".into(),
            refresh_token: "new-refresh".into(),
        })
        .is_err());
        let current = lark_user_auth(LarkUserAuthInput::Snapshot {
            adapter_id: adapter.into(),
        })
        .unwrap();
        assert_eq!(current.access_token.as_deref(), Some("user-a"));
        assert_eq!(current.refresh_token.as_deref(), Some("refresh-a"));
        assert_eq!(current.authorization_epoch, first.authorization_epoch);
    }

    #[test]
    fn direct_host_credential_replacement_and_delete_recreate_invalidate_identity() {
        use cognia_secrets::host_secrets::{self, HostSecretKind};
        let adapter = "lark-host-replacement";
        let first = lark_fixture(adapter);
        let refreshed = lark_user_auth(LarkUserAuthInput::Refresh {
            adapter_id: adapter.into(),
            expected_authorization_epoch: first.authorization_epoch,
            expected_refresh_revision: first.refresh_revision.unwrap(),
            access_token: "same".into(),
            refresh_token: "same-refresh".into(),
        })
        .unwrap();
        host_secrets::set(
            HostSecretKind::Connector,
            &account_key(adapter, "user_token"),
            "same",
            None,
            1,
        )
        .unwrap();
        let replaced = lark_user_auth(LarkUserAuthInput::Snapshot {
            adapter_id: adapter.into(),
        })
        .unwrap();
        assert_ne!(refreshed.authorization_epoch, replaced.authorization_epoch);
        delete(adapter, "user_token").unwrap();
        set(adapter, "user_token", "same").unwrap();
        let recreated = lark_user_auth(LarkUserAuthInput::Snapshot {
            adapter_id: adapter.into(),
        })
        .unwrap();
        assert_ne!(recreated.authorization_epoch, replaced.authorization_epoch);
    }

    #[test]
    fn partial_pair_edits_cannot_adopt_a_different_identity_on_refresh() {
        use cognia_secrets::host_secrets::{self, HostSecretKind};
        for credential in ["user_token", "user_refresh_token"] {
            for delete_first in [false, true] {
                for direct_host in [false, true] {
                    let adapter = format!("lark-partial-{credential}-{delete_first}-{direct_host}");
                    let first = lark_fixture(&adapter);
                    lark_user_auth(LarkUserAuthInput::Refresh {
                        adapter_id: adapter.clone(),
                        expected_authorization_epoch: first.authorization_epoch,
                        expected_refresh_revision: first.refresh_revision.unwrap(),
                        access_token: "access-a".into(),
                        refresh_token: "refresh-a".into(),
                    })
                    .unwrap();
                    let name = account_key(&adapter, credential);
                    if delete_first {
                        if direct_host {
                            host_secrets::delete(HostSecretKind::Connector, &name).unwrap();
                        } else {
                            delete(&adapter, credential).unwrap();
                        }
                    }
                    let replacement = if credential == "user_token" {
                        "access-b"
                    } else {
                        "refresh-b"
                    };
                    if direct_host {
                        host_secrets::set(HostSecretKind::Connector, &name, replacement, None, 1)
                            .unwrap();
                    } else {
                        set(&adapter, credential, replacement).unwrap();
                    }
                    let changed = lark_user_auth(LarkUserAuthInput::Snapshot {
                        adapter_id: adapter.clone(),
                    })
                    .unwrap();
                    let result = lark_user_auth(LarkUserAuthInput::Refresh {
                        adapter_id: adapter,
                        expected_authorization_epoch: changed.authorization_epoch,
                        expected_refresh_revision: changed.refresh_revision.unwrap_or_default(),
                        access_token: "wrong-identity-access".into(),
                        refresh_token: "wrong-identity-refresh".into(),
                    });
                    assert_eq!(
                        result.err().as_deref(),
                        Some("lark_auth_stale"),
                        "{credential}/{delete_first}/{direct_host}"
                    );
                }
            }
        }
    }

    #[test]
    fn indexed_connector_writes_keep_the_actual_owner_and_revision_together() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let adapter = "atomic-keyring-owner";
        let writer = |device: &str| {
            Some(SecretWriter {
                device_id: device.into(),
                label: None,
            })
        };
        set_with_writer(adapter, "token", "same", writer("keyring-owner-old"), 1).unwrap();
        let first = get_snapshot(adapter, "token").unwrap().unwrap();
        set_with_writer(adapter, "token", "same", writer("keyring-owner-new"), 2).unwrap();
        let fresh = get_snapshot(adapter, "token").unwrap().unwrap();
        assert_ne!(first.revision, fresh.revision);
        host_secrets::forget_device("keyring-owner-old").unwrap();
        assert_eq!(
            get_snapshot(adapter, "token").unwrap().unwrap().revision,
            fresh.revision
        );
        let entry = host_secrets::list()
            .unwrap()
            .into_iter()
            .find(|entry| {
                entry.kind == HostSecretKind::Connector
                    && entry.name == account_key(adapter, "token")
            })
            .unwrap();
        assert_eq!(entry.set_by, writer("keyring-owner-new"));
        delete(adapter, "token").unwrap();
        assert!(get_snapshot(adapter, "token").unwrap().is_none());
    }

    #[test]
    fn account_key_joins_adapter_and_credential() {
        assert_eq!(
            account_key("tg-personal", "botToken"),
            "tg-personal:botToken"
        );
        assert_eq!(
            account_key("", "attachment-master-key"),
            ":attachment-master-key"
        );
    }

    #[test]
    fn deleting_oa_token_purges_pending_callbacks_but_other_credentials_do_not() {
        let adapter = "oa-inbox-delete-token";
        set(adapter, "token", "verified-token").unwrap();
        set(adapter, "appSecret", "other").unwrap();
        super::super::wechat_oa_ingress::enqueue(adapter, "<xml>pending</xml>").unwrap();
        delete(adapter, "appSecret").unwrap();
        assert_eq!(
            super::super::wechat_oa_ingress::list(adapter)
                .unwrap()
                .len(),
            1
        );
        delete(adapter, "token").unwrap();
        assert!(super::super::wechat_oa_ingress::list(adapter)
            .unwrap()
            .is_empty());
        assert_eq!(get(adapter, "token").unwrap(), None);
    }

    #[test]
    fn set_get_delete_round_trip() {
        // Hermetic via the in-memory secret_store global under cfg(test).
        set("tg-sgrdt", "botTokenCK", "secret123").unwrap();
        assert_eq!(
            get("tg-sgrdt", "botTokenCK").unwrap(),
            Some("secret123".to_string())
        );
        delete("tg-sgrdt", "botTokenCK").unwrap();
        assert_eq!(get("tg-sgrdt", "botTokenCK").unwrap(), None);
    }

    #[test]
    fn delete_nonexistent_is_ok() {
        delete("ds-main-xvbq", "botTokenNE").unwrap();
    }

    #[test]
    fn list_returns_only_set_accounts() {
        set("slack-work-list", "userToken", "xoxp-abc").unwrap();
        set("slack-work-list", "botToken", "xoxb-def").unwrap();

        let accounts = vec![
            "userToken".to_string(),
            "botToken".to_string(),
            "signingSecret".to_string(),
        ];
        let found = list("slack-work-list", &accounts).unwrap();
        assert!(found.contains(&"userToken".to_string()));
        assert!(found.contains(&"botToken".to_string()));
        assert!(!found.contains(&"signingSecret".to_string()));
    }
}
