//! Checked, reversible user-scope gateway configuration for external clients.
//! Kept beside the existing vendor paths and TOML owner; no gateway keyring or UI dependency.

use crate::paths::VendorRoots;
use cognia_core::fs_atomic::{
    atomic_write_private_with_mtime_check, AtomicWriteError, AtomicWritePlan,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GatewayClient {
    ClaudeCode,
    Codex,
    Gemini,
    Opencode,
}

impl GatewayClient {
    pub const ALL: [Self; 4] = [Self::ClaudeCode, Self::Codex, Self::Gemini, Self::Opencode];
    pub fn id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Opencode => "opencode",
        }
    }
    pub fn binary(self) -> &'static str {
        if self == Self::ClaudeCode {
            "claude"
        } else {
            self.id()
        }
    }
}

pub struct ConnectionSelection<'a> {
    pub origin: &'a str,
    pub model: &'a str,
    pub helper: Option<&'a str>,
    pub secret: &'a str,
    pub opencode_v2: bool,
}

#[derive(Clone)]
pub struct ConfigFile {
    pub path: PathBuf,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedFile {
    pub path: PathBuf,
    pub original_hash: Option<String>,
    pub applied_hash: String,
    pub backup_path: Option<PathBuf>,
}

pub fn digest(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn client_paths(client: GatewayClient, roots: &VendorRoots) -> Result<Vec<PathBuf>, String> {
    let directory = match client {
        GatewayClient::ClaudeCode => &roots.claude_config_dir,
        GatewayClient::Codex => &roots.codex_home,
        GatewayClient::Gemini => &roots.gemini_dir,
        GatewayClient::Opencode => &roots.opencode_config_dir,
    };
    if directory.is_empty() {
        return Err("gateway_client_path_unavailable".into());
    }
    let root = PathBuf::from(directory);
    Ok(match client {
        GatewayClient::ClaudeCode => vec![root.join("settings.json")],
        GatewayClient::Codex => vec![root.join("config.toml")],
        GatewayClient::Gemini => vec![root.join("settings.json"), root.join(".env")],
        GatewayClient::Opencode => {
            let jsonc = root.join("opencode.jsonc");
            vec![if jsonc.exists() {
                jsonc
            } else {
                root.join("opencode.json")
            }]
        }
    })
}

pub fn read_files(paths: &[PathBuf]) -> Result<Vec<ConfigFile>, String> {
    paths
        .iter()
        .map(|path| {
            match fs::symlink_metadata(path) {
                Ok(meta) if !meta.file_type().is_file() => {
                    return Err("gateway_client_unsafe_path".into())
                }
                Ok(meta) if meta.len() > 4 * 1024 * 1024 => {
                    return Err("gateway_client_config_too_large".into())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(ConfigFile {
                        path: path.clone(),
                        raw: None,
                    })
                }
                Err(error) => return Err(format!("gateway_client_read_failed: {error}")),
                _ => (),
            }
            let raw = fs::read_to_string(path).map_err(|_| "gateway_client_read_failed")?;
            if raw.len() > 4 * 1024 * 1024 {
                return Err("gateway_client_config_too_large".into());
            }
            Ok(ConfigFile {
                path: path.clone(),
                raw: Some(raw),
            })
        })
        .collect()
}

pub fn revision(files: &[ConfigFile]) -> String {
    let mut digestor = Sha256::new();
    for file in files {
        digestor.update(file.path.to_string_lossy().as_bytes());
        digestor.update([0]);
        digestor.update(if file.raw.is_some() {
            b"present"
        } else {
            b"missing"
        });
        if let Some(raw) = &file.raw {
            digestor.update(raw.as_bytes());
        }
        digestor.update([0]);
    }
    digestor
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn json_root(raw: Option<&str>) -> Result<Value, String> {
    let Some(raw) = raw.filter(|raw| !raw.trim().is_empty()) else {
        return Ok(json!({}));
    };
    let value: Value = serde_json::from_str(&crate::io::strip_jsonc(raw))
        .map_err(|_| "gateway_client_invalid_config")?;
    if !value.is_object() {
        return Err("gateway_client_invalid_config".into());
    }
    Ok(value)
}

fn branch<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Value, String> {
    if value.get(key).is_none() {
        value[key] = json!({});
    }
    if !value[key].is_object() {
        return Err("gateway_client_invalid_config".into());
    }
    Ok(&mut value[key])
}

fn env_patch(raw: &str, values: &[(&str, &str)]) -> Result<String, String> {
    let mut remaining = values
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut lines = Vec::new();
    for line in raw.lines() {
        let key = line
            .trim_start()
            .strip_prefix("export ")
            .unwrap_or(line.trim_start())
            .split_once('=')
            .map(|(key, _)| key.trim());
        if let Some(key) = key.filter(|key| values.iter().any(|(name, _)| name == key)) {
            if let Some(value) = remaining.remove(key) {
                lines.push(format!(
                    "{key}={}",
                    serde_json::to_string(&value).map_err(|_| "gateway_client_invalid_config")?
                ));
            }
        } else {
            lines.push(line.to_string());
        }
    }
    for (key, value) in remaining {
        lines.push(format!(
            "{key}={}",
            serde_json::to_string(&value).map_err(|_| "gateway_client_invalid_config")?
        ));
    }
    Ok(format!("{}\n", lines.join("\n")))
}

pub fn render(
    client: GatewayClient,
    files: &[ConfigFile],
    selection: &ConnectionSelection<'_>,
) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Err("gateway_client_path_unavailable".into());
    }
    let base = selection.origin.trim_end_matches('/');
    if selection.model.is_empty() || selection.model.chars().any(char::is_control) {
        return Err("gateway_client_invalid_model".into());
    }
    if client == GatewayClient::Codex {
        let mut doc = files[0]
            .raw
            .as_deref()
            .unwrap_or("")
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "gateway_client_invalid_config")?;
        doc["model_provider"] = toml_edit::value("cognia");
        doc["model"] = toml_edit::value(selection.model);
        doc["model_providers"]["cognia"] = toml_edit::Item::Table(toml_edit::Table::new());
        for (key, value) in [
            ("name", "Cognia gateway"),
            ("base_url", &format!("{base}/v1")),
            ("wire_api", "responses"),
            ("experimental_bearer_token", selection.secret),
        ] {
            doc["model_providers"]["cognia"][key] = toml_edit::value(value);
        }
        doc["model_providers"]["cognia"]["requires_openai_auth"] = toml_edit::value(false);
        if let Some(helper) = selection.helper {
            doc["agents"]["default_subagent_model"] = toml_edit::value(helper);
        }
        return Ok(vec![doc.to_string()]);
    }
    let mut root = json_root(files[0].raw.as_deref())?;
    match client {
        GatewayClient::ClaudeCode => {
            let env = branch(&mut root, "env")?;
            env["ANTHROPIC_BASE_URL"] = json!(base);
            env["ANTHROPIC_API_KEY"] = json!(selection.secret);
            env["ANTHROPIC_AUTH_TOKEN"] = Value::Null;
            env.as_object_mut()
                .ok_or("gateway_client_invalid_config")?
                .remove("ANTHROPIC_AUTH_TOKEN");
            env["ANTHROPIC_MODEL"] = json!(selection.model);
            if let Some(helper) = selection.helper {
                env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = json!(helper);
            }
        }
        GatewayClient::Gemini => {
            branch(branch(&mut root, "security")?, "auth")?["selectedType"] =
                json!("gemini-api-key");
            branch(&mut root, "model")?["name"] = json!(selection.model);
        }
        GatewayClient::Opencode => {
            let v2 = selection.opencode_v2 || root.get("providers").is_some();
            let providers = branch(&mut root, if v2 { "providers" } else { "provider" })?;
            providers["cognia"] = if v2 {
                json!({"name":"Cognia gateway", "package":"@opencode/ai/providers/openai-compatible", "settings":{"baseURL":format!("{base}/v1"),"apiKey":selection.secret},"models":{selection.model:{"name":selection.model}}})
            } else {
                json!({"name":"Cognia gateway", "npm":"@ai-sdk/openai-compatible", "options":{"baseURL":format!("{base}/v1"),"apiKey":selection.secret},"models":{selection.model:{"name":selection.model}}})
            };
            if let Some(helper) = selection.helper {
                providers["cognia"]["models"][helper] = json!({"name":helper});
            }
            root["model"] = json!(format!("cognia/{}", selection.model));
            if let Some(helper) = selection.helper.filter(|_| !v2) {
                root["small_model"] = json!(format!("cognia/{helper}"));
            }
        }
        GatewayClient::Codex => unreachable!(),
    }
    let text =
        serde_json::to_string_pretty(&root).map_err(|_| "gateway_client_invalid_config")? + "\n";
    if client == GatewayClient::Gemini {
        if files.len() != 2 {
            return Err("gateway_client_path_unavailable".into());
        }
        return Ok(vec![
            text,
            env_patch(
                files[1].raw.as_deref().unwrap_or(""),
                &[
                    ("GEMINI_API_KEY", selection.secret),
                    ("GOOGLE_GEMINI_BASE_URL", base),
                    ("GEMINI_MODEL", selection.model),
                ],
            )?,
        ]);
    }
    Ok(vec![text])
}

fn hash_at(path: &Path) -> Result<Option<String>, String> {
    Ok(read_files(&[path.to_owned()])?[0]
        .raw
        .as_ref()
        .map(|raw| digest(raw.as_bytes())))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    modified: SystemTime,
    len: u64,
}

fn stamp_at(path: &Path) -> Result<Option<FileStamp>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some(FileStamp {
            modified: metadata
                .modified()
                .map_err(|_| "gateway_client_config_changed")?,
            len: metadata.len(),
        })),
        Ok(_) => Err("gateway_client_unsafe_path".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("gateway_client_read_failed".into()),
    }
}

fn checked_stamp(path: &Path, expected: Option<&str>) -> Result<Option<FileStamp>, String> {
    // The timestamp must describe the bytes whose hash we validate, never a
    // later writer's timestamp acquired after accepting the reviewed bytes.
    let observed = stamp_at(path)?;
    if hash_at(path)?.as_deref() != expected || stamp_at(path)? != observed {
        return Err("gateway_client_config_changed".into());
    }
    Ok(observed)
}

fn write_checked(
    path: &Path,
    expected: Option<&str>,
    text: &str,
) -> Result<Option<PathBuf>, String> {
    write_checked_with(path, expected, text, || {})
}

fn write_checked_with(
    path: &Path,
    expected: Option<&str>,
    text: &str,
    after_validation: impl FnOnce(),
) -> Result<Option<PathBuf>, String> {
    let observed = checked_stamp(path, expected)?;
    after_validation();
    if checked_stamp(path, expected)? != observed {
        return Err("gateway_client_config_changed".into());
    }
    let parent = path.parent().ok_or("gateway_client_path_unavailable")?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|_| "gateway_client_write_failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|_| "gateway_client_write_failed")?;
        }
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let plan = AtomicWritePlan {
        path: path.to_owned(),
        expected_mtime: observed.map(|stamp| stamp.modified),
        tmp_suffix: format!("gateway-tmp-{nonce}"),
        backup_suffix: "gateway-bak".into(),
    };
    atomic_write_private_with_mtime_check(&plan, text.as_bytes())
        .map(|result| result.backup_path)
        .map_err(|error| match error {
            AtomicWriteError::DriftDetected { .. } => "gateway_client_config_changed".into(),
            AtomicWriteError::Io(_) => "gateway_client_write_failed".into(),
        })
}

fn remove_checked(path: &Path, expected: &str) -> Result<(), String> {
    remove_checked_with(path, expected, || {})
}

fn remove_checked_with(
    path: &Path,
    expected: &str,
    after_validation: impl FnOnce(),
) -> Result<(), String> {
    let observed = checked_stamp(path, Some(expected))?;
    after_validation();
    if checked_stamp(path, Some(expected))? != observed {
        return Err("gateway_client_config_changed".into());
    }
    fs::remove_file(path).map_err(|_| "gateway_client_restore_failed".into())
}

pub fn apply(
    files: &[ConfigFile],
    expected_revision: &str,
    rendered: &[String],
) -> Result<Vec<AppliedFile>, String> {
    if revision(files) != expected_revision || files.len() != rendered.len() {
        return Err("gateway_client_config_changed".into());
    }
    let mut applied = Vec::new();
    for (file, text) in files.iter().zip(rendered) {
        let original_hash = file.raw.as_ref().map(|raw| digest(raw.as_bytes()));
        match write_checked(&file.path, original_hash.as_deref(), text) {
            Ok(backup_path) => applied.push(AppliedFile {
                path: file.path.clone(),
                original_hash,
                applied_hash: digest(text.as_bytes()),
                backup_path,
            }),
            Err(error) => {
                rollback(&applied).map_err(|_| "gateway_client_partial_write_restore_failed")?;
                return Err(error);
            }
        }
    }
    Ok(applied)
}

/// Persist recovery material BEFORE a coordinator publishes any client file.
/// The receipt contains hashes and private paths, never raw credentials.
pub fn prepare_recovery(
    files: &[ConfigFile],
    rendered: &[String],
) -> Result<Vec<AppliedFile>, String> {
    if files.len() != rendered.len() {
        return Err("gateway_client_invalid_config".into());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    files
        .iter()
        .zip(rendered)
        .enumerate()
        .map(|(index, (file, text))| {
            let original_hash = file.raw.as_ref().map(|raw| digest(raw.as_bytes()));
            let backup_path = if let Some(raw) = &file.raw {
                let name = file
                    .path
                    .file_name()
                    .ok_or("gateway_client_path_unavailable")?
                    .to_string_lossy();
                let path = file
                    .path
                    .with_file_name(format!("{name}.gateway-original-{nonce}-{index}"));
                write_checked(&path, None, raw)?;
                Some(path)
            } else {
                None
            };
            Ok(AppliedFile {
                path: file.path.clone(),
                original_hash,
                applied_hash: digest(text.as_bytes()),
                backup_path,
            })
        })
        .collect()
}

pub fn matches_applied(files: &[AppliedFile]) -> Result<bool, String> {
    for file in files {
        if hash_at(&file.path)?.as_deref() != Some(file.applied_hash.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn rollback(files: &[AppliedFile]) -> Result<(), String> {
    for file in files {
        let current = hash_at(&file.path)?;
        if current.as_deref() != Some(file.applied_hash.as_str()) && current != file.original_hash {
            return Err("gateway_client_config_changed".into());
        }
    }
    let mut originals = Vec::new();
    for file in files {
        let original = match (&file.original_hash, &file.backup_path) {
            (Some(expected), Some(path)) => {
                let raw = read_files(std::slice::from_ref(path))?
                    .remove(0)
                    .raw
                    .ok_or("gateway_client_backup_missing")?;
                if digest(raw.as_bytes()) != *expected {
                    return Err("gateway_client_backup_changed".into());
                }
                Some(raw)
            }
            (None, None) => None,
            _ => return Err("gateway_client_backup_missing".into()),
        };
        originals.push(original);
    }
    for (file, original) in files.iter().zip(originals) {
        if hash_at(&file.path)? == file.original_hash {
            continue;
        }
        if let Some(original) = original {
            write_checked(&file.path, Some(&file.applied_hash), &original)?;
        } else {
            remove_checked(&file.path, &file.applied_hash)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selection() -> ConnectionSelection<'static> {
        ConnectionSelection {
            origin: "http://127.0.0.1:8317",
            model: "fast",
            helper: Some("helper"),
            secret: "test-gateway-key",
            opencode_v2: false,
        }
    }

    #[test]
    fn concurrent_save_after_validated_read_never_adopts_the_external_timestamp() {
        for client in GatewayClient::ALL {
            let dir = tempfile::tempdir().unwrap();
            let original = if client == GatewayClient::Codex {
                "model = 'previous'\n"
            } else {
                "{\"unrelated\":\"original\"}\n"
            };
            let paths = if client == GatewayClient::Gemini {
                vec![dir.path().join("settings.json"), dir.path().join(".env")]
            } else {
                vec![dir.path().join(if client == GatewayClient::Codex {
                    "config.toml"
                } else {
                    "settings.json"
                })]
            };
            fs::write(&paths[0], original).unwrap();
            if paths.len() == 2 {
                fs::write(&paths[1], "OTHER=original\n").unwrap();
            }
            let files = read_files(&paths).unwrap();
            let rendered = render(client, &files, &selection()).unwrap();
            for (file, text) in files.iter().zip(rendered) {
                let expected = file.raw.as_ref().map(|raw| digest(raw.as_bytes()));
                fs::OpenOptions::new()
                    .write(true)
                    .open(&file.path)
                    .unwrap()
                    .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1000))
                    .unwrap();
                let external = if file.path.extension().is_none() {
                    "OTHER=external-save\n"
                } else if client == GatewayClient::Codex {
                    "model = 'external-save'\n"
                } else {
                    "{\"unrelated\":\"external-save\"}\n"
                };
                let result = write_checked_with(&file.path, expected.as_deref(), &text, || {
                    fs::write(&file.path, external).unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&file.path)
                        .unwrap()
                        .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(2000))
                        .unwrap();
                });
                assert!(
                    result.is_err(),
                    "{} must refuse an external save after validation",
                    client.id()
                );
                assert_eq!(fs::read_to_string(&file.path).unwrap(), external);
            }
        }
    }

    #[test]
    fn a_writer_preserving_mtime_still_fails_the_content_recheck() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{\"reviewed\":true}\n").unwrap();
        let expected = digest(&fs::read(&path).unwrap());
        let timestamp = fs::metadata(&path).unwrap().modified().unwrap();
        let external = "{\"external\":true}\n";
        let result = write_checked_with(&path, Some(&expected), "{\"ours\":true}\n", || {
            fs::write(&path, external).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(timestamp)
                .unwrap();
        });
        assert_eq!(
            result.err().as_deref(),
            Some("gateway_client_config_changed")
        );
        assert_eq!(fs::read_to_string(path).unwrap(), external);
    }

    #[test]
    fn rollback_deletion_rechecks_the_same_validated_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new-settings.json");
        let applied = "{\"ours\":true}\n";
        fs::write(&path, applied).unwrap();
        let external = "{\"external\":\"keep\"}\n";
        let result = remove_checked_with(&path, &digest(applied.as_bytes()), || {
            fs::write(&path, external).unwrap();
        });
        assert_eq!(
            result.err().as_deref(),
            Some("gateway_client_config_changed")
        );
        assert_eq!(fs::read_to_string(path).unwrap(), external);
    }
    #[test]
    fn all_clients_apply_read_back_and_restore_exactly() {
        for client in GatewayClient::ALL {
            let dir = tempfile::tempdir().unwrap();
            let paths = if client == GatewayClient::Gemini {
                vec![dir.path().join("settings.json"), dir.path().join(".env")]
            } else {
                vec![dir.path().join(if client == GatewayClient::Codex {
                    "config.toml"
                } else {
                    "settings.json"
                })]
            };
            let original = if client == GatewayClient::Codex {
                "# Keep comment\nmodel = 'previous'\n[projects.test]\ntrust_level = 'trusted'\n"
            } else {
                "{\"unrelated\":\"keep\",\"env\":{\"OTHER\":\"value\"}}\n"
            };
            fs::write(&paths[0], original).unwrap();
            if paths.len() == 2 {
                fs::write(&paths[1], "# private\nOTHER=keep\n").unwrap();
            }
            let files = read_files(&paths).unwrap();
            let texts = render(client, &files, &selection()).unwrap();
            let applied = apply(&files, &revision(&files), &texts).unwrap();
            assert!(matches_applied(&applied).unwrap());
            for (source, receipt) in files.iter().zip(&applied) {
                let backup = receipt.backup_path.as_ref().unwrap();
                assert_eq!(
                    fs::read_to_string(backup).unwrap(),
                    source.raw.as_deref().unwrap()
                );
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::metadata(&receipt.path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                    assert_eq!(
                        fs::metadata(backup).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }
            }
            assert!(fs::read_to_string(&paths[0]).unwrap().contains(
                if client == GatewayClient::Codex {
                    "Keep comment"
                } else {
                    "unrelated"
                }
            ));
            rollback(&applied).unwrap();
            assert_eq!(fs::read_to_string(&paths[0]).unwrap(), original);
            if paths.len() == 2 {
                assert_eq!(
                    fs::read_to_string(&paths[1]).unwrap(),
                    "# private\nOTHER=keep\n"
                );
            }
        }
    }
    #[test]
    fn stale_review_and_changed_rollback_do_not_clobber_other_writers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let files = read_files(std::slice::from_ref(&path)).unwrap();
        let texts = render(GatewayClient::ClaudeCode, &files, &selection()).unwrap();
        fs::write(&path, "{\"external\":true}").unwrap();
        assert!(apply(&files, &revision(&files), &texts).is_err());
        let files = read_files(std::slice::from_ref(&path)).unwrap();
        let texts = render(GatewayClient::ClaudeCode, &files, &selection()).unwrap();
        let applied = apply(&files, &revision(&files), &texts).unwrap();
        fs::write(&path, "{\"external\":\"new\"}").unwrap();
        assert!(rollback(&applied).is_err());
        assert!(fs::read_to_string(path).unwrap().contains("new"));
    }
    #[test]
    fn prepared_recovery_restores_a_partially_published_multi_file_config() {
        let dir = tempfile::tempdir().unwrap();
        let paths = vec![dir.path().join("settings.json"), dir.path().join(".env")];
        let original = "{\"model\":{\"name\":\"old\"}}\n";
        fs::write(&paths[0], original).unwrap();
        let files = read_files(&paths).unwrap();
        let rendered = render(GatewayClient::Gemini, &files, &selection()).unwrap();
        let recovery = prepare_recovery(&files, &rendered).unwrap();
        assert_eq!(fs::read_to_string(&paths[0]).unwrap(), original);
        assert!(!paths[1].exists());
        assert!(!serde_json::to_string(&recovery)
            .unwrap()
            .contains(selection().secret));
        apply(&files[..1], &revision(&files[..1]), &rendered[..1]).unwrap();
        assert!(!matches_applied(&recovery).unwrap());
        rollback(&recovery).unwrap();
        assert_eq!(fs::read_to_string(&paths[0]).unwrap(), original);
        assert!(!paths[1].exists());
        rollback(&recovery).unwrap();
    }
    #[test]
    fn oversized_config_is_rejected_before_reading_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::File::create(&path)
            .unwrap()
            .set_len(4 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(
            read_files(&[path]).err().as_deref(),
            Some("gateway_client_config_too_large")
        );
    }
    #[test]
    fn supports_both_confirmed_opencode_schemas_and_real_gemini_env_file() {
        let file = ConfigFile {
            path: PathBuf::from("opencode.json"),
            raw: None,
        };
        for v2 in [false, true] {
            let mut selected = selection();
            selected.opencode_v2 = v2;
            let text = render(
                GatewayClient::Opencode,
                std::slice::from_ref(&file),
                &selected,
            )
            .unwrap();
            let root: Value = serde_json::from_str(&text[0]).unwrap();
            assert!(root[if v2 { "providers" } else { "provider" }]["cognia"]
                [if v2 { "settings" } else { "options" }]["apiKey"]
                .as_str()
                .is_some());
        }
        let files = vec![
            ConfigFile {
                path: PathBuf::from("settings.json"),
                raw: None,
            },
            ConfigFile {
                path: PathBuf::from(".env"),
                raw: Some("export GEMINI_API_KEY=old\nOTHER=keep\n".into()),
            },
        ];
        let text = render(GatewayClient::Gemini, &files, &selection()).unwrap();
        assert!(text[0].contains("gemini-api-key"));
        assert!(text[1].contains("GOOGLE_GEMINI_BASE_URL=\"http://127.0.0.1:8317\""));
        assert!(!text[1].contains("=old"));
        assert!(text[1].contains("OTHER=keep"));
    }
}
