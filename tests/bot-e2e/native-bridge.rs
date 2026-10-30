//! Test-only stdio bridge to the production connector owners (no Tauri GUI).
//! Built as a normal binary, so dev-dependency `test-inmemory` is NOT enabled.
use cognia_connectors::{
    axum_app, commands, types::AdapterRegistration, ws_client, ConnectorsState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    sync::Arc,
};
use tokio::{net::TcpListener, sync::mpsc, task::JoinSet};

struct StdioEmitter;
fn output(value: Value) {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{value}").expect("fixture stdout");
    stdout.flush().expect("fixture stdout flush");
}
impl axum_app::EventEmitter for StdioEmitter {
    fn emit(&self, topic: &str, payload: Value) {
        output(json!({"event": topic, "payload": payload}));
    }
}

#[derive(Deserialize)]
struct Call {
    id: u64,
    name: String,
    #[serde(default)]
    args: Value,
}
fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|_| format!("invalid fixture argument: {key}"))
}
fn owned_url(raw: &str, allowed: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|_| "invalid fixture URL")?;
    let allowed = url::Url::parse(allowed).map_err(|_| "invalid fixture origin")?;
    if parsed.host_str() != Some("127.0.0.1")
        || parsed.port() != allowed.port()
        || !["http", "ws"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("fixture refused external destination".into());
    }
    Ok(())
}
async fn dispatch(
    call: &Call,
    state: &ConnectorsState,
    allowed: &str,
    profile: &std::path::Path,
) -> Result<Value, String> {
    let args = &call.args;
    match call.name.as_str() {
        "connectors_http_request" => {
            let req = arg(args, "req")?;
            owned_url(&req_url(&req), allowed)?;
            serde_json::to_value(commands::connectors_http_request(req).await?)
                .map_err(|e| e.to_string())
        }
        "connectors_bounded_http_request" => {
            let req = arg(args, "req")?;
            owned_url(&req_url(&req), allowed)?;
            serde_json::to_value(
                commands::connectors_bounded_http_request(req, arg(args, "maxResponseBytes")?)
                    .await?,
            )
            .map_err(|e| e.to_string())
        }
        "connectors_ws_open" => {
            let url: String = arg(args, "url")?;
            owned_url(&url, allowed)?;
            let headers = arg(args, "headers")?;
            let handle: Option<String> = arg(args, "handleId")?;
            let emitter = Arc::new(StdioEmitter);
            let id = match handle {
                Some(id) => ws_client::open_ws_with_handle(emitter, url, headers, id).await?,
                None => ws_client::open_ws(emitter, url, headers).await?,
            };
            Ok(json!(id))
        }
        "connectors_ws_send" => {
            commands::connectors_ws_send(
                arg(args, "handleId")?,
                arg(args, "data")?,
                arg(args, "binary")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "connectors_ws_close" => {
            commands::connectors_ws_close(arg(args, "handleId")?).await?;
            Ok(Value::Null)
        }
        "connectors_onebot_send" => {
            commands::connectors_onebot_send(arg(args, "adapterId")?, arg(args, "callJson")?)
                .await?;
            Ok(Value::Null)
        }
        "connectors_keyring_set" => {
            commands::connectors_keyring_set(
                arg(args, "adapterId")?,
                arg(args, "credential")?,
                arg(args, "value")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "connectors_keyring_delete" => {
            commands::connectors_keyring_delete(arg(args, "adapterId")?, arg(args, "credential")?)
                .await?;
            Ok(Value::Null)
        }
        "connectors_wechat_oa_inbound_list" => serde_json::to_value(
            commands::connectors_wechat_oa_inbound_list(arg(args, "adapterId")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_wechat_oa_inbound_claim" => Ok(json!(
            commands::connectors_wechat_oa_inbound_claim(arg(args, "adapterId")?, arg(args, "id")?)
                .await?
        )),
        "connectors_wechat_oa_inbound_ack" => {
            commands::connectors_wechat_oa_inbound_ack(arg(args, "adapterId")?, arg(args, "id")?)
                .await?;
            Ok(Value::Null)
        }
        "connectors_matrix_encrypted_media_upload" => {
            let req: cognia_connectors::types::MatrixEncryptedMediaUploadRequest =
                arg(args, "req")?;
            if req.local_path.is_some() {
                return Err("fixture refuses external local files".into());
            }
            owned_url(&req.upload_url, allowed)?;
            owned_url(
                req.source_url.as_deref().ok_or("missing media source")?,
                allowed,
            )?;
            serde_json::to_value(commands::connectors_matrix_encrypted_media_upload(req).await?)
                .map_err(|e| e.to_string())
        }
        "connectors_matrix_encrypted_media_fetch" => {
            private_cache(profile)?;
            let req: cognia_connectors::types::MatrixEncryptedMediaFetchRequest = arg(args, "req")?;
            owned_url(&req.source_url, allowed)?;
            serde_json::to_value(commands::connectors_matrix_encrypted_media_fetch(req).await?)
                .map_err(|e| e.to_string())
        }
        "connectors_attachment_read" => {
            private_cache(profile)?;
            serde_json::to_value(
                commands::connectors_attachment_read(
                    arg(args, "adapterId")?,
                    arg(args, "remoteRef")?,
                    arg(args, "maxBytes")?,
                )
                .await?,
            )
            .map_err(|e| e.to_string())
        }
        "fixture_cache_probe" => {
            use base64::Engine;
            let cache = private_cache(profile)?;
            let needle = base64::engine::general_purpose::STANDARD
                .decode(arg::<String>(args, "plaintextBase64")?)
                .map_err(|_| "invalid test bytes")?;
            if needle.is_empty() {
                return Err("empty test bytes".into());
            }
            let mut files = 0;
            let mut contains_plaintext = false;
            let mut unexpected_files = 0;
            if cache.exists() {
                for entry in std::fs::read_dir(cache).map_err(|e| e.to_string())? {
                    let path = entry.map_err(|e| e.to_string())?.path();
                    if !path.is_file() {
                        unexpected_files += 1;
                        continue;
                    }
                    if path.extension().is_some_and(|ext| ext == "enc") {
                        files += 1;
                    } else if path
                        .file_name()
                        .is_none_or(|name| name != ".envelope-v1-migrated")
                    {
                        unexpected_files += 1;
                    }
                    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                    contains_plaintext |= bytes.windows(needle.len()).any(|part| part == needle);
                }
            }
            Ok(
                json!({"files": files, "containsPlaintext": contains_plaintext, "unexpectedFiles": unexpected_files}),
            )
        }
        "connectors_matrix_crypto_init" | "fixture_matrix_wrong_passphrase" => {
            use sha2::{Digest, Sha256};
            let mut req: cognia_connectors::matrix_crypto::MatrixCryptoInitRequest =
                arg(args, "req")?;
            if req.store_dir.is_some() || req.store_passphrase.is_some() {
                return Err("fixture owns Matrix store directory and passphrase".into());
            }
            let mut hash = Sha256::new();
            hash.update(req.adapter_id.as_bytes());
            hash.update([0]);
            hash.update(req.device_id.as_bytes());
            req.store_dir = Some(
                profile
                    .join("matrix")
                    .join(hex::encode(hash.finalize()))
                    .to_string_lossy()
                    .into_owned(),
            );
            if call.name == "fixture_matrix_wrong_passphrase" {
                req.store_passphrase = Some("incorrect-fixture-passphrase".to_string());
            }
            commands::connectors_matrix_crypto_init(req).await?;
            Ok(Value::Null)
        }
        "connectors_matrix_crypto_verification" => {
            commands::connectors_matrix_crypto_verification(arg(args, "req")?).await
        }
        "connectors_matrix_crypto_cross_signing" => {
            commands::connectors_matrix_crypto_cross_signing(arg(args, "req")?).await
        }
        "connectors_matrix_crypto_backup" => {
            commands::connectors_matrix_crypto_backup(arg(args, "req")?).await
        }
        "connectors_matrix_crypto_close" => serde_json::to_value(
            commands::connectors_matrix_crypto_close(arg(args, "adapterId")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_outgoing_requests" => serde_json::to_value(
            commands::connectors_matrix_crypto_outgoing_requests(arg(args, "adapterId")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_mark_request_sent" => serde_json::to_value(
            commands::connectors_matrix_crypto_mark_request_sent(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_receive_sync_changes" => serde_json::to_value(
            commands::connectors_matrix_crypto_receive_sync_changes(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_decrypt_event" => serde_json::to_value(
            commands::connectors_matrix_crypto_decrypt_event(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_encrypt_event" => serde_json::to_value(
            commands::connectors_matrix_crypto_encrypt_event(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_share_room_key" => serde_json::to_value(
            commands::connectors_matrix_crypto_share_room_key(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_update_tracked_users" => serde_json::to_value(
            commands::connectors_matrix_crypto_update_tracked_users(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        "connectors_matrix_crypto_get_missing_sessions" => serde_json::to_value(
            commands::connectors_matrix_crypto_get_missing_sessions(arg(args, "req")?).await?,
        )
        .map_err(|e| e.to_string()),
        // Registry setup only: the Tauri wrapper requires State<AppHandle>.
        "fixture_register" => {
            let reg: AdapterRegistration = arg(args, "reg")?;
            if let Some(spec) = &reg.verification {
                spec.validate()?;
            }
            state
                .inner
                .lock()
                .registered_adapters
                .insert(reg.adapter_id.clone(), reg);
            Ok(Value::Null)
        }
        _ => Err("unknown native fixture command".into()),
    }
}
fn private_cache(profile: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let base = dirs::data_dir().ok_or("missing private data directory")?;
    if !base.starts_with(profile) {
        return Err("fixture media directory is not private".into());
    }
    Ok(base.join("cognia").join("connectors").join("cache"))
}
fn req_url(req: &cognia_connectors::types::TauriHttpRequest) -> String {
    req.url.clone()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let data_dir = args.next().ok_or("missing private data dir")?;
    let allowed = args.next().ok_or("missing owned loopback origin")?;
    cognia_net::proxy_config::apply_current(Default::default())?;
    cognia_secrets::secret_store::init_headless(std::path::Path::new(&data_dir))?;
    let state = ConnectorsState::new();
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let router = axum_app::build_router(state.clone(), Arc::new(StdioEmitter));
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    output(json!({"ready": true, "origin": origin, "pid": std::process::id()}));
    let mut calls = JoinSet::new();
    loop {
        tokio::select! {
            line = rx.recv() => {
                let Some(line) = line else { break; };
                let call: Call = serde_json::from_str(&line)?;
                if call.name == "fixture_shutdown" { break; }
                let state = state.clone();
                let allowed = allowed.clone();
                let profile = std::path::PathBuf::from(&data_dir);
                calls.spawn(async move {
                    let result = dispatch(&call, &state, &allowed, &profile).await;
                    output(match result {
                        Ok(value) => json!({"id": call.id, "result": value}),
                        Err(error) => json!({"id": call.id, "error": error}),
                    });
                });
            }
            result = calls.join_next(), if !calls.is_empty() => { result.transpose()?; }
        }
    }
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    let closed = ws_client::close_all().await;
    let _ = stop.send(());
    tokio::time::timeout(std::time::Duration::from_secs(2), server).await???;
    output(json!({"stopped": true, "closedSockets": closed}));
    Ok(())
}
