//! Local client configuration, backed by scoped gateway keys and recovery receipts.
//! No provider key or full client configuration crosses the command boundary.

use crate::GatewayState;
use cognia_agents::{
    gateway_config::{self as config_io, AppliedFile, ConnectionSelection, GatewayClient},
    paths::{vendor_roots, VendorRoots},
};
use cognia_core::fs_atomic::{atomic_write_private_with_mtime_check, AtomicWritePlan};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

static CONNECTION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn on_blocking_worker<T: Send + 'static>(
    work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || runtime.block_on(work))
        .await
        .map_err(|_| "gateway_client_worker_unavailable".to_string())?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRecord {
    client: GatewayClient,
    owner_account_id: Option<String>,
    key_id: String,
    model_alias: String,
    helper_alias: Option<String>,
    origin: String,
    complete: bool,
    #[serde(default)]
    revocation_pending: bool,
    files: Vec<AppliedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConnectionStatus {
    pub client: GatewayClient,
    pub installed: bool,
    pub path: String,
    pub source_paths: Vec<String>,
    pub revision: String,
    pub state: String,
    pub model_alias: Option<String>,
    pub helper_alias: Option<String>,
    pub endpoint: Option<String>,
    pub backup_paths: Vec<String>,
    pub connection_verified: bool,
    pub supports_helper: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConnectionReport {
    pub owner_account_id: Option<String>,
    pub account_generation: u64,
    pub clients: Vec<ClientConnectionStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectClientRequest {
    pub client: GatewayClient,
    pub model_alias: String,
    pub helper_alias: Option<String>,
    pub expected_revision: String,
    pub owner_account_id: Option<String>,
    pub account_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackClientRequest {
    pub client: GatewayClient,
    pub expected_revision: String,
    pub owner_account_id: Option<String>,
    pub account_generation: u64,
}

struct Environment {
    roots: VendorRoots,
    manifest: PathBuf,
}

fn environment(state: &GatewayState) -> Result<Environment, String> {
    let path = state
        .inner
        .lock()
        .config_path
        .clone()
        .ok_or("gateway_client_storage_unavailable")?;
    let parent = path.parent().ok_or("gateway_client_storage_unavailable")?;
    Ok(Environment {
        roots: vendor_roots(),
        manifest: parent.join("gateway-client-connections.json"),
    })
}

fn read_records(path: &Path) -> Result<Vec<ConnectionRecord>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("gateway_client_unsafe_manifest".into())
        }
        Ok(metadata) if metadata.len() > 1024 * 1024 => {
            return Err("gateway_client_unsafe_manifest".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("gateway_client_storage_unavailable".into()),
        _ => (),
    }
    let raw = fs::read(path).map_err(|_| "gateway_client_storage_unavailable")?;
    if raw.len() > 1024 * 1024 {
        return Err("gateway_client_unsafe_manifest".into());
    }
    serde_json::from_slice(&raw).map_err(|_| "gateway_client_unsafe_manifest".into())
}

fn write_records(path: &Path, records: &[ConnectionRecord]) -> Result<(), String> {
    let raw =
        serde_json::to_vec_pretty(records).map_err(|_| "gateway_client_storage_unavailable")?;
    let expected_mtime = if path.exists() {
        Some(
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .map_err(|_| "gateway_client_storage_unavailable")?,
        )
    } else {
        None
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let plan = AtomicWritePlan {
        path: path.to_owned(),
        expected_mtime,
        tmp_suffix: format!("gateway-tmp-{nonce}"),
        backup_suffix: "gateway-bak".into(),
    };
    atomic_write_private_with_mtime_check(&plan, &raw)
        .map(|_| ())
        .map_err(|_| "gateway_client_storage_unavailable".into())
}

fn binary_path(client: GatewayClient) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path).find_map(|directory| {
            #[cfg(windows)]
            let names = vec![
                format!("{}.exe", client.binary()),
                format!("{}.cmd", client.binary()),
                client.binary().to_string(),
            ];
            #[cfg(not(windows))]
            let names = [client.binary().to_string()];
            names.iter().find_map(|name| {
                let path = directory.join(name);
                if !path.is_file() {
                    return None;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::metadata(&path)
                        .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
                        .then_some(path)
                }
                #[cfg(not(unix))]
                {
                    Some(path)
                }
            })
        })
    })
}

fn installed(client: GatewayClient) -> bool {
    binary_path(client).is_some()
}

async fn opencode_v2(
    client: GatewayClient,
    files: &[config_io::ConfigFile],
) -> Result<bool, String> {
    if client != GatewayClient::Opencode {
        return Ok(false);
    }
    let root = files[0]
        .raw
        .as_deref()
        .map(|raw| serde_json::from_str::<serde_json::Value>(&cognia_agents::io::strip_jsonc(raw)))
        .transpose()
        .map_err(|_| "gateway_client_invalid_config")?;
    let Some(binary) = binary_path(client) else {
        return Ok(root.is_some_and(|root| root.get("providers").is_some()));
    };
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::process::Command::new(binary)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "gateway_client_version_unknown")?
    .map_err(|_| "gateway_client_version_unknown")?;
    if !output.status.success() {
        return Err("gateway_client_version_unknown".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let major = text
        .split_whitespace()
        .find_map(|part| {
            part.trim_start_matches('v')
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .ok_or("gateway_client_version_unknown")?;
    if ![1, 2].contains(&major) {
        return Err("gateway_client_version_unknown".into());
    }
    if root.as_ref().is_some_and(|root| {
        if major == 2 {
            root.get("provider").is_some() && root.get("providers").is_none()
        } else {
            root.get("providers").is_some()
        }
    }) {
        return Err("gateway_client_schema_mismatch".into());
    }
    Ok(major == 2)
}

fn assert_authority(
    state: &GatewayState,
    owner: &Option<String>,
    generation: u64,
) -> Result<(), String> {
    let status = state.status();
    if status.account_generation != generation
        || status.owner_account_id != *owner
        || (status.account_required && owner.is_none())
    {
        return Err("gateway_account_changed".into());
    }
    Ok(())
}

fn revoke_owned_key(state: &GatewayState, id: &str, owner: &Option<String>) -> Result<(), String> {
    let mut keys = state.keys.write();
    if keys
        .iter()
        .any(|key| key.id == id && key.owner_account_id != *owner)
    {
        return Err("gateway_account_changed".into());
    }
    // Revoke live authority before durable cleanup. Retrying an already absent
    // key must still save, because a previous keychain write may have failed.
    crate::api_keys::delete_key(&mut keys, id);
    let persisted = crate::api_keys::save_keys(&keys);
    drop(keys);
    state.refresh_key_presence();
    persisted.map_err(|_| "gateway_client_key_cleanup_failed".into())
}

fn revoke_pending_with(state: &GatewayState, env: &Environment) -> Result<(), String> {
    for record in read_records(&env.manifest)?
        .iter()
        .filter(|record| !record.complete || record.revocation_pending)
    {
        revoke_owned_key(state, &record.key_id, &record.owner_account_id)?;
    }
    Ok(())
}

/// Run on a blocking worker before binding the listener. Recovery only revokes
/// recorded authority; restoring external files remains an explicit action.
pub(crate) fn revoke_pending_on_start(state: &GatewayState) -> Result<(), String> {
    let _guard = CONNECTION_LOCK.blocking_lock();
    if state.inner.lock().config_path.is_none() {
        return Ok(());
    }
    revoke_pending_with(state, &environment(state)?)
}

async fn verify_models(state: &GatewayState, origin: &str, key: &str, models: &[String]) -> bool {
    let status = state.status();
    if !status.running
        || status
            .bound_port
            .map(|port| format!("http://127.0.0.1:{port}"))
            != Some(origin.to_string())
    {
        return false;
    }
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let response = match client
        .get(format!("{origin}/v1/models"))
        .bearer_auth(key)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    let value = match response.json::<serde_json::Value>().await {
        Ok(value) => value,
        Err(_) => return false,
    };
    value
        .get("data")
        .and_then(|data| data.as_array())
        .is_some_and(|data| {
            models.iter().all(|model| {
                data.iter()
                    .any(|entry| entry.get("id").and_then(|id| id.as_str()) == Some(model))
            })
        })
}

async fn status_with(
    state: &GatewayState,
    env: &Environment,
) -> Result<ClientConnectionReport, String> {
    let authority = state.status();
    let records = read_records(&env.manifest)?;
    let mut clients = Vec::new();
    for client in GatewayClient::ALL {
        let paths = config_io::client_paths(client, &env.roots)?;
        let mut status = ClientConnectionStatus {
            client,
            installed: installed(client),
            path: paths[0].to_string_lossy().into(),
            source_paths: paths
                .iter()
                .map(|path| path.to_string_lossy().into())
                .collect(),
            revision: String::new(),
            state: "unmanaged".into(),
            model_alias: None,
            helper_alias: None,
            endpoint: None,
            backup_paths: Vec::new(),
            connection_verified: false,
            supports_helper: client != GatewayClient::Gemini,
            error_code: None,
        };
        let files = match config_io::read_files(&paths) {
            Ok(files) => files,
            Err(error) => {
                status.state = "unavailable".into();
                status.error_code = Some(error);
                clients.push(status);
                continue;
            }
        };
        status.revision = config_io::revision(&files);
        match opencode_v2(client, &files).await {
            Ok(v2) => status.supports_helper = client != GatewayClient::Gemini && !v2,
            Err(error) => {
                status.error_code = Some(error);
                status.state = "unavailable".into();
            }
        }
        if let Some(record) = records.iter().find(|record| record.client == client) {
            if record.owner_account_id != authority.owner_account_id {
                status.state = "other-account".into();
            } else {
                status.model_alias = Some(record.model_alias.clone());
                status.helper_alias = record.helper_alias.clone();
                status.endpoint = Some(record.origin.clone());
                status.backup_paths = record
                    .files
                    .iter()
                    .filter_map(|file| {
                        file.backup_path
                            .as_ref()
                            .map(|path| path.to_string_lossy().into())
                    })
                    .collect();
                status.state = if !record.complete {
                    "restore-needed"
                } else if config_io::matches_applied(&record.files)? {
                    "configured"
                } else {
                    "drifted"
                }
                .into();
                let secret = state
                    .keys
                    .read()
                    .iter()
                    .find(|key| {
                        key.id == record.key_id
                            && key.owner_account_id == record.owner_account_id
                            && key.is_usable(chrono::Utc::now().timestamp_millis())
                    })
                    .map(|key| key.secret.clone());
                if status.state == "configured" {
                    if let Some(secret) = secret {
                        let mut models = vec![record.model_alias.clone()];
                        if let Some(helper) = &record.helper_alias {
                            models.push(helper.clone());
                        }
                        status.connection_verified =
                            verify_models(state, &record.origin, &secret, &models).await;
                    } else {
                        status.error_code = Some("gateway_client_key_unavailable".into());
                    }
                }
            }
        }
        clients.push(status);
    }
    assert_authority(
        state,
        &authority.owner_account_id,
        authority.account_generation,
    )?;
    Ok(ClientConnectionReport {
        owner_account_id: authority.owner_account_id,
        account_generation: authority.account_generation,
        clients,
    })
}

pub async fn status(state: &GatewayState) -> Result<ClientConnectionReport, String> {
    let guard = CONNECTION_LOCK.lock().await;
    let state = state.clone();
    on_blocking_worker(async move {
        // Keep serialization alive even if the IPC caller disconnects while
        // its blocking worker is finishing a write or recovery operation.
        let _guard = guard;
        status_with(&state, &environment(&state)?).await
    })
    .await
}

async fn connect_with(
    state: &GatewayState,
    env: &Environment,
    request: ConnectClientRequest,
    installed_override: Option<bool>,
) -> Result<ClientConnectionReport, String> {
    assert_authority(state, &request.owner_account_id, request.account_generation)?;
    if !installed_override.unwrap_or_else(|| installed(request.client)) {
        return Err("gateway_client_not_installed".into());
    }
    let authority = state.status();
    if !authority.running {
        return Err("gateway_client_listener_stopped".into());
    }
    let mut aliases = vec![request.model_alias.clone()];
    if let Some(helper) = &request.helper_alias {
        aliases.push(helper.clone());
    }
    if aliases
        .iter()
        .any(|alias| !authority.model_aliases.contains(alias))
    {
        return Err("gateway_client_alias_unavailable".into());
    }
    let mut records = read_records(&env.manifest)?;
    if records.iter().any(|record| record.client == request.client) {
        return Err("gateway_client_already_managed".into());
    }
    let paths = config_io::client_paths(request.client, &env.roots)?;
    let files = config_io::read_files(&paths)?;
    if config_io::revision(&files) != request.expected_revision {
        return Err("gateway_client_config_changed".into());
    }
    let opencode_v2 = opencode_v2(request.client, &files).await?;
    if request.helper_alias.is_some() && (request.client == GatewayClient::Gemini || opencode_v2) {
        return Err("gateway_client_helper_not_supported".into());
    }
    let origin = format!(
        "http://127.0.0.1:{}",
        authority
            .bound_port
            .ok_or("gateway_client_listener_stopped")?
    );
    assert_authority(state, &request.owner_account_id, request.account_generation)?;
    let key = state
        .create_key(
            format!("{} client", request.client.id()),
            aliases.clone(),
            None,
            Some(60),
            None,
        )
        .map_err(|_| "gateway_client_key_failed")?;
    let operation = async {
        let selection = ConnectionSelection {
            origin: &origin,
            model: &request.model_alias,
            helper: request.helper_alias.as_deref(),
            secret: &key.secret,
            opencode_v2,
        };
        let rendered = config_io::render(request.client, &files, &selection)?;
        let receipts = config_io::prepare_recovery(&files, &rendered)?;
        let record = ConnectionRecord {
            client: request.client,
            owner_account_id: request.owner_account_id.clone(),
            key_id: key.id.clone(),
            model_alias: request.model_alias.clone(),
            helper_alias: request.helper_alias.clone(),
            origin: origin.clone(),
            complete: false,
            revocation_pending: false,
            files: receipts,
        };
        records.push(record);
        write_records(&env.manifest, &records)?;
        assert_authority(state, &request.owner_account_id, request.account_generation)?;
        config_io::apply(&files, &request.expected_revision, &rendered)?;
        if !verify_models(state, &origin, &key.secret, &aliases).await {
            return Err("gateway_client_verification_failed".into());
        }
        assert_authority(state, &request.owner_account_id, request.account_generation)?;
        records
            .last_mut()
            .ok_or("gateway_client_storage_unavailable")?
            .complete = true;
        write_records(&env.manifest, &records)?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = operation {
        if !records.iter().any(|record| record.key_id == key.id) {
            records.push(ConnectionRecord {
                client: request.client,
                owner_account_id: request.owner_account_id.clone(),
                key_id: key.id.clone(),
                model_alias: request.model_alias.clone(),
                helper_alias: request.helper_alias.clone(),
                origin,
                complete: false,
                revocation_pending: true,
                files: Vec::new(),
            });
            // No target was published if rendering/recovery preparation failed.
            // Keep a durable ID even when the keychain cleanup needs a retry.
            if let Err(storage_error) = write_records(&env.manifest, &records) {
                revoke_owned_key(state, &key.id, &request.owner_account_id)?;
                return Err(storage_error);
            }
        }
        let record = records.iter().find(|record| record.key_id == key.id);
        let restored = record.is_none_or(|record| config_io::rollback(&record.files).is_ok());
        revoke_owned_key(state, &key.id, &request.owner_account_id)?;
        if restored {
            records.retain(|record| record.key_id != key.id);
            write_records(&env.manifest, &records)?;
        }
        return Err(if restored {
            error
        } else {
            "gateway_client_restore_required".into()
        });
    }
    status_with(state, env).await
}

pub async fn connect(
    state: &GatewayState,
    request: ConnectClientRequest,
) -> Result<ClientConnectionReport, String> {
    let guard = CONNECTION_LOCK.lock().await;
    let state = state.clone();
    on_blocking_worker(async move {
        let _guard = guard;
        connect_with(&state, &environment(&state)?, request, None).await
    })
    .await
}

async fn rollback_with(
    state: &GatewayState,
    env: &Environment,
    request: RollbackClientRequest,
) -> Result<ClientConnectionReport, String> {
    assert_authority(state, &request.owner_account_id, request.account_generation)?;
    let mut records = read_records(&env.manifest)?;
    let index = records
        .iter()
        .position(|record| {
            record.client == request.client && record.owner_account_id == request.owner_account_id
        })
        .ok_or("gateway_client_not_managed")?;
    let record = records[index].clone();
    if !record.files.is_empty()
        && record
            .files
            .iter()
            .map(|file| &file.path)
            .ne(config_io::client_paths(request.client, &env.roots)?.iter())
    {
        return Err("gateway_client_path_changed".into());
    }
    let current = config_io::read_files(&config_io::client_paths(request.client, &env.roots)?)?;
    if config_io::revision(&current) != request.expected_revision {
        return Err("gateway_client_config_changed".into());
    }
    records[index].revocation_pending = true;
    write_records(&env.manifest, &records)?;
    config_io::rollback(&record.files)?;
    revoke_owned_key(state, &record.key_id, &record.owner_account_id)?;
    records.retain(|item| item.client != request.client);
    write_records(&env.manifest, &records)?;
    status_with(state, env).await
}

pub async fn rollback(
    state: &GatewayState,
    request: RollbackClientRequest,
) -> Result<ClientConnectionReport, String> {
    let guard = CONNECTION_LOCK.lock().await;
    let state = state.clone();
    on_blocking_worker(async move {
        let _guard = guard;
        rollback_with(&state, &environment(&state)?, request).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    fn fixture(root: &Path) -> Environment {
        let mut roots = vendor_roots();
        roots.claude_config_dir = root.join("claude").to_string_lossy().into();
        roots.codex_home = root.join("codex").to_string_lossy().into();
        roots.gemini_dir = root.join("gemini").to_string_lossy().into();
        roots.opencode_config_dir = root.join("opencode").to_string_lossy().into();
        Environment {
            roots,
            manifest: root.join("connections.json"),
        }
    }

    fn state(port: u16) -> GatewayState {
        let state = GatewayState::new();
        state.keys.write().clear();
        state.set_snapshot(serde_json::from_value(serde_json::json!({
            "generatedAtMs":1,
            "providers":[{"id":"provider","protocol":"openai","baseUrl":"https://provider.invalid/v1","apiKey":"test-only-upstream","enabled":true}],
            "aliases":[{"alias":"fast","entries":[{"providerId":"provider","modelId":"raw-model"}]},{"alias":"helper","entries":[{"providerId":"provider","modelId":"raw-model"}]}]
        })).unwrap());
        state.inner.lock().status.running = true;
        state.inner.lock().status.bound_port = Some(port);
        state
    }

    fn request(
        state: &GatewayState,
        env: &Environment,
        client: GatewayClient,
    ) -> ConnectClientRequest {
        let files =
            config_io::read_files(&config_io::client_paths(client, &env.roots).unwrap()).unwrap();
        let status = state.status();
        ConnectClientRequest {
            client,
            model_alias: "fast".into(),
            helper_alias: None,
            expected_revision: config_io::revision(&files),
            owner_account_id: status.owner_account_id,
            account_generation: status.account_generation,
        }
    }

    #[test]
    fn all_clients_verify_loopback_models_and_rollback_without_leaking_keys() {
        // Serialize the in-memory secret-store fixture without a production
        // lock held across an async command. No user homes or binaries are used.
        let _store = crate::api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let root = tempfile::tempdir().unwrap();
                let env = fixture(root.path());
                let gateway = state(0);
                let mut stale = request(&gateway, &env, GatewayClient::ClaudeCode);
                stale.account_generation += 1;
                assert_eq!(
                    connect_with(&gateway, &env, stale, Some(true))
                        .await
                        .unwrap_err(),
                    "gateway_account_changed"
                );
                assert!(gateway.keys.read().is_empty());
                assert!(!env.manifest.exists());
                let mut config = gateway.config();
                config.port = 0;
                config.enabled = true;
                gateway.update_config(config).unwrap();
                gateway
                    .create_key("fixture-admin".into(), vec![], None, None, None)
                    .unwrap();
                gateway
                    .start(std::sync::Arc::new(crate::host::NoopGatewayHost))
                    .await
                    .unwrap();
                for client in GatewayClient::ALL {
                    let mut connection = request(&gateway, &env, client);
                    connection.helper_alias =
                        (client != GatewayClient::Gemini).then(|| "helper".into());
                    let report = connect_with(&gateway, &env, connection, Some(true))
                        .await
                        .unwrap();
                    let status = report
                        .clients
                        .iter()
                        .find(|item| item.client == client)
                        .unwrap();
                    assert_eq!(status.state, "configured");
                    assert!(status.connection_verified);
                    let serialized = serde_json::to_string(&report).unwrap();
                    let secret = gateway.keys.read().last().unwrap().secret.clone();
                    assert_eq!(
                        gateway.keys.read().last().unwrap().model_allowlist,
                        if client == GatewayClient::Gemini {
                            vec!["fast"]
                        } else {
                            vec!["fast", "helper"]
                        }
                    );
                    assert!(!serialized.contains(&secret));
                    assert!(!fs::read_to_string(&env.manifest).unwrap().contains(&secret));
                    if client == GatewayClient::ClaudeCode {
                        let applied = fs::read_to_string(&status.path).unwrap();
                        fs::write(&status.path, "{\"external\":true}").unwrap();
                        let changed = rollback_with(
                            &gateway,
                            &env,
                            RollbackClientRequest {
                                client,
                                expected_revision: status.revision.clone(),
                                owner_account_id: report.owner_account_id.clone(),
                                account_generation: report.account_generation,
                            },
                        )
                        .await
                        .unwrap_err();
                        assert_eq!(changed, "gateway_client_config_changed");
                        assert_eq!(
                            fs::read_to_string(&status.path).unwrap(),
                            "{\"external\":true}"
                        );
                        assert_eq!(gateway.keys.read().len(), 2);
                        fs::write(&status.path, applied).unwrap();
                    }
                    let rollback = RollbackClientRequest {
                        client,
                        expected_revision: status.revision.clone(),
                        owner_account_id: report.owner_account_id,
                        account_generation: report.account_generation,
                    };
                    let report = rollback_with(&gateway, &env, rollback).await.unwrap();
                    assert_eq!(
                        report
                            .clients
                            .iter()
                            .find(|item| item.client == client)
                            .unwrap()
                            .state,
                        "unmanaged"
                    );
                    assert_eq!(gateway.keys.read().len(), 1);
                }
                gateway.stop().unwrap();
            });
    }

    #[test]
    fn failed_probe_restores_files_and_revokes_the_new_key() {
        let _store = crate::api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = listener.local_addr().unwrap().port();
                let server = tokio::spawn(async move {
                    axum::serve(
                        listener,
                        Router::new().route(
                            "/v1/models",
                            get(|| async { axum::http::StatusCode::UNAUTHORIZED }),
                        ),
                    )
                    .await
                    .unwrap()
                });
                let root = tempfile::tempdir().unwrap();
                let env = fixture(root.path());
                let gateway = state(port);
                let paths = config_io::client_paths(GatewayClient::ClaudeCode, &env.roots).unwrap();
                fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
                fs::write(&paths[0], "{\"unrelated\":true}\n").unwrap();
                let outcome = connect_with(
                    &gateway,
                    &env,
                    request(&gateway, &env, GatewayClient::ClaudeCode),
                    Some(true),
                )
                .await;
                assert!(outcome.unwrap_err().contains("verification_failed"));
                assert_eq!(
                    fs::read_to_string(&paths[0]).unwrap(),
                    "{\"unrelated\":true}\n"
                );
                assert!(gateway.keys.read().is_empty());
                assert!(read_records(&env.manifest).unwrap().is_empty());
                server.abort();
                let _ = server.await;
            });
    }

    #[test]
    fn failed_durable_cleanup_revokes_live_auth_and_retains_recovery_for_retry() {
        let _store = crate::api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let root = tempfile::tempdir().unwrap();
                let env = fixture(root.path());
                let gateway = state(0);
                let mut config = gateway.config();
                config.port = 0;
                config.enabled = true;
                gateway.update_config(config).unwrap();
                gateway
                    .create_key("fixture-admin".into(), vec![], None, None, None)
                    .unwrap();
                gateway
                    .start(std::sync::Arc::new(crate::host::NoopGatewayHost))
                    .await
                    .unwrap();
                let real_port = gateway.status().bound_port.unwrap();
                let captured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
                let capture = captured.clone();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                gateway.inner.lock().status.bound_port =
                    Some(listener.local_addr().unwrap().port());
                let server = tokio::spawn(async move {
                    axum::serve(
                        listener,
                        Router::new().route(
                            "/v1/models",
                            get(move |headers: axum::http::HeaderMap| {
                                let capture = capture.clone();
                                async move {
                                    *capture.lock().unwrap() = headers
                                        .get("authorization")
                                        .and_then(|value| value.to_str().ok())
                                        .and_then(|value| value.strip_prefix("Bearer "))
                                        .map(str::to_owned);
                                    cognia_secrets::secret_store::fail_next_mutation_for_test(
                                        "com.cognia.gateway",
                                        "api-keys",
                                    );
                                    axum::http::StatusCode::UNAUTHORIZED
                                }
                            }),
                        ),
                    )
                    .await
                    .unwrap();
                });
                let failure = connect_with(
                    &gateway,
                    &env,
                    request(&gateway, &env, GatewayClient::ClaudeCode),
                    Some(true),
                )
                .await
                .unwrap_err();
                assert_eq!(failure, "gateway_client_key_cleanup_failed");
                let records = read_records(&env.manifest).unwrap();
                assert_eq!(records.len(), 1);
                assert!(!records[0].complete);
                let key_id = records[0].key_id.clone();
                assert!(!gateway.keys.read().iter().any(|key| key.id == key_id));
                assert!(crate::api_keys::load_keys()
                    .unwrap()
                    .iter()
                    .any(|key| key.id == key_id));
                let secret = captured.lock().unwrap().clone().unwrap();
                let response = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .unwrap()
                    .get(format!("http://127.0.0.1:{real_port}/v1/models"))
                    .bearer_auth(secret)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
                // A process restart reloads the durable blob. Startup must
                // refuse readiness until that exact pending ID is revoked.
                *gateway.keys.write() = crate::api_keys::load_keys().unwrap();
                cognia_secrets::secret_store::fail_next_mutation_for_test(
                    "com.cognia.gateway",
                    "api-keys",
                );
                assert_eq!(
                    revoke_pending_with(&gateway, &env).unwrap_err(),
                    "gateway_client_key_cleanup_failed"
                );
                assert!(!gateway.keys.read().iter().any(|key| key.id == key_id));
                assert_eq!(read_records(&env.manifest).unwrap().len(), 1);
                revoke_pending_with(&gateway, &env).unwrap();
                assert!(!crate::api_keys::load_keys()
                    .unwrap()
                    .iter()
                    .any(|key| key.id == key_id));
                let current = request(&gateway, &env, GatewayClient::ClaudeCode);
                rollback_with(
                    &gateway,
                    &env,
                    RollbackClientRequest {
                        client: current.client,
                        expected_revision: current.expected_revision,
                        owner_account_id: current.owner_account_id,
                        account_generation: current.account_generation,
                    },
                )
                .await
                .unwrap();
                assert!(read_records(&env.manifest).unwrap().is_empty());
                assert!(!crate::api_keys::load_keys()
                    .unwrap()
                    .iter()
                    .any(|key| key.id == key_id));
                server.abort();
                let _ = server.await;
                gateway.stop().unwrap();
            });
    }

    #[tokio::test]
    async fn file_and_keychain_coordinator_runs_off_the_async_worker() {
        let async_worker = std::thread::current().id();
        let blocking_worker = on_blocking_worker(async move { Ok(std::thread::current().id()) })
            .await
            .unwrap();
        assert_ne!(async_worker, blocking_worker);
    }
}
