//! Isolated real Wry webview. Stdio schedules JavaScript, never dispatches Rust commands.
use cognia_connectors::commands;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    io::{BufRead, Write},
    path::PathBuf,
};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

fn output(value: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}").expect("fixture output");
    out.flush().expect("fixture flush");
}
#[tauri::command]
fn fixture_result(id: u64, result: Option<Value>, error: Option<String>) {
    output(json!({"id":id,"result":result,"error":error}));
}
#[tauri::command]
fn fixture_ready(origin: String) {
    output(
        json!({"ready":true,"origin":origin,"runtime":"wry","ipc":"webview-invoke","pid":std::process::id()}),
    );
}
struct Assets;
impl tauri::Assets<tauri::Wry> for Assets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Borrowed(b"<!doctype html><html><head><meta charset='utf-8'></head><body>Matrix IPC test</body></html>"))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
#[derive(Deserialize)]
struct Call {
    id: u64,
    name: String,
    #[serde(default)]
    args: Value,
}
fn prepare(call: &mut Call, profile: &std::path::Path, origin: &str) -> Result<(), String> {
    if !(call.name.starts_with("connectors_matrix_crypto_")
        || [
            "connectors_http_request",
            "connectors_bounded_http_request",
            "connectors_keyring_set",
            "connectors_keyring_delete",
        ]
        .contains(&call.name.as_str()))
    {
        return Err(format!("Command outside Matrix IPC fixture: {}", call.name));
    }
    if ["connectors_http_request", "connectors_bounded_http_request"].contains(&call.name.as_str())
    {
        let raw = call.args["req"]["url"]
            .as_str()
            .ok_or("Missing fixture URL")?;
        let url = url::Url::parse(raw).map_err(|_| "Invalid fixture URL")?;
        let allowed = url::Url::parse(origin).map_err(|_| "Invalid fixture origin")?;
        if url.origin() != allowed.origin()
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("External fixture destination".into());
        }
    }
    if call.name == "connectors_matrix_crypto_init" {
        use sha2::{Digest, Sha256};
        let req = call
            .args
            .get_mut("req")
            .and_then(Value::as_object_mut)
            .ok_or("Missing init request")?;
        if req.contains_key("storeDir") || req.contains_key("storePassphrase") {
            return Err("Fixture owns Matrix storage".into());
        }
        let id = req
            .get("adapterId")
            .and_then(Value::as_str)
            .ok_or("Missing adapter")?;
        let device = req
            .get("deviceId")
            .and_then(Value::as_str)
            .ok_or("Missing device")?;
        let key = hex::encode(Sha256::digest(format!("{id}\0{device}")));
        req.insert("storeDir".into(), json!(profile.join("matrix").join(key)));
    }
    Ok(())
}
fn main() {
    let mut args = std::env::args().skip(1);
    let profile = PathBuf::from(args.next().expect("private fixture profile"));
    let origin = args.next().expect("owned loopback origin");
    assert!(profile.is_absolute() && profile.join("master.key").is_file());
    // Isolate the real encrypted store; never probe the operator's Keychain.
    cognia_secrets::secret_store::init_headless(&profile).expect("private secret store");
    cognia_net::proxy_config::apply_current(Default::default()).expect("fixture proxy");
    let mut config = tauri::Config::default();
    config.identifier = "com.cognia.matrix-ipc-test".into();
    config.app.windows.clear();
    let context = tauri::Context::new(
        config,
        Box::new(Assets),
        None,
        None,
        tauri::PackageInfo {
            name: "matrix-ipc-test".into(),
            version: "0.1.0".parse().unwrap(),
            authors: "Cognia",
            description: "Isolated Matrix IPC tests",
            crate_name: "connector-tauri-fixture",
        },
        tauri::Pattern::Brownfield,
        tauri::runtime_authority!(Default::default(), Default::default()),
        None,
    );
    tauri::Builder::<tauri::Wry>::new()
        .enable_macos_default_menu(false)
        .invoke_handler(tauri::generate_handler![fixture_ready, fixture_result,
            commands::connectors_http_request,
            commands::connectors_bounded_http_request,
            commands::connectors_keyring_set, commands::connectors_keyring_delete,
            commands::connectors_matrix_crypto_init, commands::connectors_matrix_crypto_close,
            commands::connectors_matrix_crypto_outgoing_requests, commands::connectors_matrix_crypto_mark_request_sent,
            commands::connectors_matrix_crypto_receive_sync_changes, commands::connectors_matrix_crypto_update_tracked_users,
            commands::connectors_matrix_crypto_get_missing_sessions, commands::connectors_matrix_crypto_share_room_key,
            commands::connectors_matrix_crypto_encrypt_event, commands::connectors_matrix_crypto_decrypt_event,
            commands::connectors_matrix_crypto_verification, commands::connectors_matrix_crypto_cross_signing,
            commands::connectors_matrix_crypto_backup])
        .setup(move |app| {
            let ready = format!("window.__TAURI_INTERNALS__.invoke('fixture_ready',{{origin:{}}})", serde_json::to_string(&origin)?);
            let window = tauri::WebviewWindowBuilder::new(app, "matrix-ipc", tauri::WebviewUrl::App("index.html".into()))
                .title("Cognia Matrix IPC test").inner_size(360., 180.).incognito(true)
                .on_page_load(move |webview, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished { webview.eval(&ready).expect("ready invoke"); }
                }).build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let Ok(mut call) = serde_json::from_str::<Call>(&line) else { continue };
                    if let Err(error) = prepare(&mut call, &profile, &origin) { output(json!({"id":call.id,"error":error})); continue; }
                    let script = format!("(async()=>{{try{{const result=await window.__TAURI_INTERNALS__.invoke({name},{args});await window.__TAURI_INTERNALS__.invoke('fixture_result',{{id:{id},result:result??null}})}}catch(e){{await window.__TAURI_INTERNALS__.invoke('fixture_result',{{id:{id},error:String(e)}})}}}})()", name=serde_json::to_string(&call.name).unwrap(), args=call.args, id=call.id);
                    if window.eval(script).is_err() { output(json!({"id":call.id,"error":"Webview evaluation failed"})); }
                }
                handle.exit(0);
            });
            Ok(())
        }).run(context).expect("real Wry IPC fixture");
}
