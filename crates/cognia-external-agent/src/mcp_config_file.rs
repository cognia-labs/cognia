//! Private per-process MCP configuration for an engine that reads its MCP
//! servers only from its own files (`EngineMcpConfigFile`, ADR-0217). The host
//! projects each session's servers into a copied configuration root for
//! deterministic discovery and isolation. Originals are never changed; the
//! guard owns every copy. Nothing here names an engine.
use crate::jsonc::{parse_jsonc, MAX_JSONC_BYTES as MAX_JSON_BYTES};
use crate::launch_descriptor::McpConfigFile;
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

pub const PAYLOAD_ENV: &str = "COGNIA_ENGINE_MCP_SERVERS";
/// Added after SpawnPolicy filtering, never accepted from a serialized caller.
pub(crate) const WRAPPED_ENV: &str = "COGNIA_INTERNAL_MCP_CONFIG_WRAPPED";
const UNSUPPORTED: &str = "This launch does not take MCP servers in its configuration files";

fn invalid(id: &str) -> String {
    format!("Invalid MCP configuration for {id}")
}

fn target(
    command: &str,
    args: &[String],
) -> Result<(&'static str, &'static McpConfigFile), String> {
    crate::launch_descriptor::mcp_config_file(command, args).ok_or_else(|| UNSUPPORTED.into())
}

pub fn validate_target(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<(), String> {
    if env.contains_key(PAYLOAD_ENV) {
        target(command, args)?;
    }
    Ok(())
}

fn read_config(id: &str, filename: &Path) -> Result<Map<String, Value>, String> {
    if !filename.exists() {
        return Ok(Map::new());
    }
    let metadata = fs::metadata(filename).map_err(|_| invalid(id))?;
    if !metadata.is_file() || metadata.len() > MAX_JSON_BYTES as u64 {
        return Err(invalid(id));
    }
    parse_jsonc(&fs::read_to_string(filename).map_err(|_| invalid(id))?).map_err(|_| invalid(id))
}

fn servers(id: &str, config: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    match config.get("mcpServers") {
        None => Ok(Map::new()),
        Some(value) => value.as_object().cloned().ok_or_else(|| invalid(id)),
    }
}

fn pairs(id: &str, value: Option<&Value>) -> Result<Map<String, Value>, String> {
    let Some(value) = value else {
        return Ok(Map::new());
    };
    let entries = value.as_array().ok_or_else(|| invalid(id))?;
    if entries.len() > 256 {
        return Err(invalid(id));
    }
    let mut result = Map::new();
    for entry in entries {
        let name = entry.get("name").and_then(Value::as_str).ok_or_else(|| invalid(id))?;
        let text = entry.get("value").and_then(Value::as_str).ok_or_else(|| invalid(id))?;
        if name.is_empty()
            || name.contains('\0')
            || text.contains('\0')
            || result
                .insert(name.into(), Value::String(text.into()))
                .is_some()
        {
            return Err(invalid(id));
        }
    }
    Ok(result)
}

/// The session's ACP `McpServer[]` as an `mcpServers` map.
fn injected(id: &str, raw: &str) -> Result<Map<String, Value>, String> {
    if raw.len() > MAX_JSON_BYTES {
        return Err(invalid(id));
    }
    let parsed: Value = serde_json::from_str(raw).map_err(|_| invalid(id))?;
    let list = parsed.as_array().ok_or_else(|| invalid(id))?;
    if list.len() > 64 {
        return Err(invalid(id));
    }
    let mut result = Map::new();
    for value in list {
        let entry = value.as_object().ok_or_else(|| invalid(id))?;
        let name = entry.get("name").and_then(Value::as_str).ok_or_else(|| invalid(id))?;
        if name.is_empty() || name.len() > 256 || name.contains('\0') || result.contains_key(name) {
            return Err(invalid(id));
        }
        let transport = entry.get("type").and_then(Value::as_str);
        let config = match transport {
            Some("http" | "sse") => {
                if entry
                    .keys()
                    .any(|key| !["name", "type", "url", "headers"].contains(&key.as_str()))
                {
                    return Err(invalid(id));
                }
                let url = entry.get("url").and_then(Value::as_str).ok_or_else(|| invalid(id))?;
                let parsed_url = url::Url::parse(url).map_err(|_| invalid(id))?;
                if !["http", "https"].contains(&parsed_url.scheme())
                    || parsed_url.host_str().is_none()
                {
                    return Err(invalid(id));
                }
                serde_json::json!({"url":url,"transport":transport,"headers":pairs(id, entry.get("headers"))?})
            }
            None | Some("stdio") => {
                if entry.contains_key("type") && transport.is_none() {
                    return Err(invalid(id));
                }
                if entry
                    .keys()
                    .any(|key| !["name", "type", "command", "args", "env"].contains(&key.as_str()))
                {
                    return Err(invalid(id));
                }
                let command = entry
                    .get("command")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid(id))?;
                let args = entry
                    .get("args")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid(id))?;
                if command.trim().is_empty()
                    || command.contains('\0')
                    || args.len() > 512
                    || args
                        .iter()
                        .any(|arg| arg.as_str().is_none_or(|arg| arg.contains('\0')))
                {
                    return Err(invalid(id));
                }
                serde_json::json!({"command":command,"args":args,"env":pairs(id, entry.get("env"))?})
            }
            _ => return Err(invalid(id)),
        };
        result.insert(name.into(), config);
    }
    Ok(result)
}

fn project_collisions(
    id: &str,
    file: &McpConfigFile,
    cwd: &Path,
    names: &Map<String, Value>,
) -> Result<(), String> {
    for directory in cwd.ancestors() {
        for name in &file.project.files {
            let project = servers(
                id,
                &read_config(id, &directory.join(&file.project.directory).join(name))?,
            )?;
            if project.keys().any(|key| names.contains_key(key)) {
                return Err(format!(
                    "Project {id} MCP configuration shadows a Cognia session server"
                ));
            }
        }
    }
    Ok(())
}

fn private_mode(id: &str, path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|_| format!("Cannot secure {id} configuration"))?;
    }
    Ok(())
}

fn copy_private(
    id: &str,
    source: &Path,
    destination: &Path,
    budget: &mut (u64, usize),
    ancestors: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let unreadable = || format!("Cannot read {id} configuration");
    let canonical = source.canonicalize().map_err(|_| unreadable())?;
    if !ancestors.insert(canonical.clone()) {
        return Err(format!("{id} configuration contains a symlink cycle"));
    }
    let metadata = fs::metadata(&canonical).map_err(|_| unreadable())?;
    budget.1 += 1;
    if metadata.is_file() {
        budget.0 += metadata.len();
    }
    if budget.0 > 64 * MAX_JSON_BYTES as u64 || budget.1 > 10_000 {
        return Err(format!("{id} configuration exceeds the isolated copy limit"));
    }
    if metadata.is_dir() {
        fs::create_dir(destination).map_err(|_| format!("Cannot copy {id} configuration"))?;
        private_mode(id, destination, 0o700)?;
        for entry in fs::read_dir(&canonical).map_err(|_| unreadable())? {
            let entry = entry.map_err(|_| unreadable())?;
            copy_private(
                id,
                &entry.path(),
                &destination.join(entry.file_name()),
                budget,
                ancestors,
            )?;
        }
    } else if metadata.is_file() {
        fs::copy(&canonical, destination).map_err(|_| format!("Cannot copy {id} configuration"))?;
        private_mode(id, destination, 0o600)?;
    } else {
        return Err(format!("{id} configuration contains an unsupported file type"));
    }
    ancestors.remove(&canonical);
    Ok(())
}

fn dotted_scalar<'a>(map: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let mut value = map.get(parts.next()?)?;
    for part in parts {
        value = value.get(part)?;
    }
    (value.is_string() || value.is_number() || value.is_boolean()).then_some(value)
}

fn set_dotted(map: &mut Map<String, Value>, path: &str, value: Value) {
    let (parents, leaf) = path.rsplit_once('.').map_or((None, path), |(a, b)| (Some(a), b));
    let mut current = map;
    for part in parents.into_iter().flat_map(|parents| parents.split('.')) {
        let entry = current
            .entry(part.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        current = entry.as_object_mut().expect("just made an object");
    }
    current.insert(leaf.to_string(), value);
}

/// What a private launch keeps of the engine's settings.
fn private_settings(file: &McpConfigFile, current: &Map<String, Value>) -> Map<String, Value> {
    let mut selected = Map::new();
    for path in &file.private_keep {
        if let Some(value) = dotted_scalar(current, path) {
            set_dotted(&mut selected, path, value.clone());
        }
    }
    for (path, value) in &file.private_set {
        set_dotted(&mut selected, path, value.clone());
    }
    selected
}

/// The TempDir guard must live until the child has exited, including kill paths.
pub struct McpConfigOverlay {
    root: tempfile::TempDir,
}
impl McpConfigOverlay {
    pub fn path(&self) -> &Path {
        self.root.path()
    }
}

/// Build the launch's private configuration root. `host_root` reads the
/// host's own value of the engine's root env.
pub fn prepare(
    config: &mut crate::process::ExternalAgentSpawnConfig,
    home: &Path,
    temp: &Path,
    host_root: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Option<McpConfigOverlay>, String> {
    let Some(raw) = config.env.get(PAYLOAD_ENV) else {
        return Ok(None);
    };
    // Desktop has already wrapped the validated target. Headless local-process
    // runs inside its host container and retains the bare validated command.
    // Only the launcher receives sandbox flags; the engine's own argv never does.
    let (separator, (id, file)) = if config.env.get(WRAPPED_ENV).map(String::as_str) == Some("1") {
        let separator = config
            .args
            .iter()
            .position(|arg| arg == "--")
            .ok_or(UNSUPPORTED)?;
        let command = config.args.get(separator + 1).ok_or(UNSUPPORTED)?;
        (Some(separator), target(command, &config.args[separator + 2..])?)
    } else {
        (None, target(&config.command, &config.args)?)
    };
    let injected = injected(id, raw)?;
    let cwd = config.cwd.as_deref().ok_or_else(|| invalid(id))?;
    let private = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    if private {
        let state = config
            .env
            .get("COGNIA_BOT_STATE_DIR")
            .filter(|value| Path::new(value).is_absolute())
            .ok_or("Bot isolation requires an owned state directory")?;
        for copy in &file.private_copy {
            let source = home.join(&copy.home);
            let destination = Path::new(state).join(&copy.state);
            if source.exists() && !destination.exists() {
                if !fs::symlink_metadata(&source)
                    .map_err(|_| format!("Cannot inspect {id} sign-in file"))?
                    .is_file()
                {
                    return Err(format!("{id} sign-in file must be a regular file"));
                }
                fs::create_dir_all(destination.parent().ok_or_else(|| invalid(id))?)
                    .map_err(|_| format!("Cannot prepare the Bot's {id} sign-in"))?;
                copy_private(id, &source, &destination, &mut (0, 0), &mut HashSet::new())?;
            }
        }
    }
    project_collisions(id, file, Path::new(cwd), &injected)?;
    let original = host_root(&file.root_env)
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(&file.root_default));
    if !original.is_absolute() {
        return Err(format!("{id} {} must be absolute", file.root_env));
    }
    let guard = McpConfigOverlay {
        root: tempfile::Builder::new()
            .prefix("cognia-mcp-config-")
            .tempdir_in(temp)
            .map_err(|_| format!("Cannot create isolated {id} configuration"))?,
    };
    private_mode(id, guard.path(), 0o700)?;
    let write_failed = || format!("Cannot write isolated {id} configuration");
    if original.exists() {
        for entry in fs::read_dir(&original).map_err(|_| format!("Cannot read {id} configuration"))? {
            let entry = entry.map_err(|_| format!("Cannot read {id} configuration"))?;
            let destination = guard.path().join(entry.file_name());
            if entry.file_name() == file.directory.as_str() && private {
                let current = read_config(id, &entry.path().join(&file.settings_file))?;
                fs::create_dir_all(&destination).map_err(|_| write_failed())?;
                fs::write(
                    destination.join(&file.settings_file),
                    serde_json::to_vec(&private_settings(file, &current)).map_err(|_| invalid(id))?,
                )
                .map_err(|_| write_failed())?;
            } else if entry.file_name() == file.directory.as_str() {
                copy_private(id, &entry.path(), &destination, &mut (0, 0), &mut HashSet::new())?;
            } else if !private {
                #[cfg(unix)]
                std::os::unix::fs::symlink(entry.path(), destination)
                    .map_err(|_| format!("Cannot preserve {} entries", file.root_env))?;
                #[cfg(not(unix))]
                return Err(format!("Isolated {id} configuration requires Unix"));
            }
        }
    }
    let directory = guard.path().join(&file.directory);
    fs::create_dir_all(&directory).map_err(|_| write_failed())?;
    private_mode(id, &directory, 0o700)?;
    let filename = directory.join(&file.servers_file);
    let mut dedicated = read_config(id, &filename)?;
    let settings_filename = directory.join(&file.settings_file);
    let mut settings = read_config(id, &settings_filename)?;
    let mut merged = if private {
        settings.remove("mcpServers");
        fs::write(
            &settings_filename,
            serde_json::to_vec(&settings).map_err(|_| invalid(id))?,
        )
        .map_err(|_| write_failed())?;
        dedicated.remove("mcpServers");
        Map::new()
    } else {
        let mut inherited = servers(id, &settings)?;
        inherited.extend(servers(id, &dedicated)?);
        inherited
    };
    merged.extend(injected);
    for value in merged.values_mut() {
        let server = value.as_object_mut().ok_or_else(|| invalid(id))?;
        if server.get("command").is_some_and(Value::is_string) {
            let mut env = match server.get("env") {
                None => Map::new(),
                Some(value) => value.as_object().cloned().ok_or_else(|| invalid(id))?,
            };
            if env.values().any(|value| !value.is_string()) {
                return Err(invalid(id));
            }
            env.entry(file.root_env.clone())
                .or_insert_with(|| Value::String(original.to_string_lossy().into_owned()));
            server.insert("env".into(), Value::Object(env));
        }
    }
    dedicated.insert("mcpServers".into(), Value::Object(merged));
    fs::write(
        &filename,
        serde_json::to_vec(&dedicated).map_err(|_| invalid(id))?,
    )
    .map_err(|_| write_failed())?;
    private_mode(id, &filename, 0o600)?;
    if let Some(separator) = separator {
        let mut scopes = vec![
            "--writable".into(),
            guard.path().to_string_lossy().into_owned(),
        ];
        if original.exists() && !private {
            scopes.extend(["--readable".into(), original.to_string_lossy().into_owned()]);
        }
        config.args.splice(separator..separator, scopes);
    }
    config.env.remove(PAYLOAD_ENV);
    config.env.remove(WRAPPED_ENV);
    config.env.insert(
        file.root_env.clone(),
        guard.path().to_string_lossy().into_owned(),
    );
    Ok(Some(guard))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(home: &Path, raw: Value) -> crate::process::ExternalAgentSpawnConfig {
        crate::process::ExternalAgentSpawnConfig {
            id: "devin".into(),
            command: "/bin/cognia-external-agent-launcher".into(),
            args: vec!["--".into(), "devin".into(), "acp".into()],
            cwd: Some(home.to_string_lossy().into_owned()),
            env: HashMap::from([
                (PAYLOAD_ENV.into(), raw.to_string()),
                (WRAPPED_ENV.into(), "1".into()),
            ]),
            framing: Default::default(),
            sandbox_policy: Default::default(),
            sandbox: None,
        }
    }
    fn payload(token: &str) -> Value {
        serde_json::json!([{"name":"cognia-tools","command":"node","args":["bridge"],"env":[{"name":"TOKEN","value":token}]}])
    }
    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn read(root: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(root.join("devin/mcp_config.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn headless_local_process_keeps_native_arguments_and_consumes_payload() {
        let home = tempfile::tempdir().unwrap();
        let mut input = config(home.path(), payload("headless"));
        input.command = "devin".into();
        input.env.remove(WRAPPED_ENV);
        input.args = vec!["acp".into(), "--model".into(), "swe2".into()];
        let original_args = input.args.clone();
        let guard = prepare(&mut input, home.path(), home.path(), |_| None)
            .unwrap()
            .unwrap();
        assert_eq!(input.args, original_args);
        assert_eq!(input.env["XDG_CONFIG_HOME"], guard.path().to_string_lossy());
        assert!(!input.env.contains_key(PAYLOAD_ENV));
        assert_eq!(
            read(guard.path())["mcpServers"]["cognia-tools"]["env"]["TOKEN"],
            "headless"
        );
    }

    #[test]
    fn bot_configuration_copies_only_model_credentials_and_drops_inherited_mcp() {
        let home = tempfile::tempdir().unwrap();
        write(
            home.path(),
            ".local/share/devin/credentials.toml",
            "token = 'model-only'",
        );
        write(
            home.path(),
            ".config/devin/config.json",
            r#"{"version":2,"devin":{"org_id":"org","token":"secret"},"agent":{"model":"m"},"mcpServers":{"github":{"command":"gh","env":{"GH_TOKEN":"secret"}}}}"#,
        );
        write(home.path(), ".config/gh/hosts.yml", "secret");
        let state = home.path().join("bot-state");
        let mut input = config(home.path(), payload("safe-host-tool"));
        input.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        input.env.insert(
            "COGNIA_BOT_STATE_DIR".into(),
            state.to_string_lossy().into_owned(),
        );
        let guard = prepare(&mut input, home.path(), home.path(), |_| None)
            .unwrap()
            .unwrap();
        assert!(read(guard.path())["mcpServers"].get("github").is_none());
        let settings: Value = serde_json::from_str(
            &fs::read_to_string(guard.path().join("devin/config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            settings,
            serde_json::json!({"version":2,"devin":{"org_id":"org"},"shell":{"setup_complete":true}})
        );
        assert!(!guard.path().join("gh").exists());
        assert_eq!(
            fs::read_to_string(state.join("data/devin/credentials.toml")).unwrap(),
            "token = 'model-only'"
        );
        assert!(!input
            .args
            .windows(2)
            .any(|pair| pair == ["--readable", &home.path().join(".config").to_string_lossy()]));
    }

    #[test]
    fn host_attestation_accepts_renamed_launcher_without_trusting_its_basename() {
        let home = tempfile::tempdir().unwrap();
        let mut input = config(home.path(), payload("wrapped"));
        input.command = "/opt/custom-launcher".into();
        let guard = prepare(&mut input, home.path(), home.path(), |_| None)
            .unwrap()
            .unwrap();
        assert!(input
            .args
            .contains(&guard.path().to_string_lossy().into_owned()));
        assert!(!input.env.contains_key(WRAPPED_ENV));
        let mut untrusted = config(home.path(), payload("untrusted"));
        untrusted.env.remove(WRAPPED_ENV);
        assert!(prepare(&mut untrusted, home.path(), home.path(), |_| None).is_err());
    }

    #[test]
    fn preserves_user_configuration_and_isolates_concurrent_tokens() {
        let home = tempfile::tempdir().unwrap();
        let original = "{// comment\n\"permissions\":{\"deny\":[\"shell(*)\"]},\"mcpServers\":{\"legacy\":{\"command\":\"old\"}},}";
        write(home.path(), ".config/devin/config.json", original);
        write(
            home.path(),
            ".config/devin/mcp_config.json",
            r#"{"mcpServers":{"custom":{"command":"custom","env":{"XDG_CONFIG_HOME":"/explicit"}}}}"#,
        );
        write(home.path(), ".config/devin/rules/a.md", "rules");
        write(home.path(), ".config/other/settings", "other");
        let mut first = config(home.path(), payload("one"));
        let a = prepare(&mut first, home.path(), home.path(), |_| None)
            .unwrap()
            .unwrap();
        let mut second = config(home.path(), payload("two"));
        let b = prepare(&mut second, home.path(), home.path(), |_| None)
            .unwrap()
            .unwrap();
        assert_ne!(a.path(), b.path());
        assert_eq!(
            read(a.path())["mcpServers"]["cognia-tools"]["env"]["TOKEN"],
            "one"
        );
        assert_eq!(
            read(b.path())["mcpServers"]["cognia-tools"]["env"]["TOKEN"],
            "two"
        );
        assert_eq!(
            read(a.path())["mcpServers"]["custom"]["env"]["XDG_CONFIG_HOME"],
            "/explicit"
        );
        assert_eq!(
            read(a.path())["mcpServers"]["legacy"]["env"]["XDG_CONFIG_HOME"],
            home.path().join(".config").to_string_lossy().as_ref()
        );
        assert_eq!(
            fs::read_to_string(a.path().join("devin/config.json")).unwrap(),
            original
        );
        assert_eq!(
            fs::read_to_string(a.path().join("devin/rules/a.md")).unwrap(),
            "rules"
        );
        assert_eq!(
            fs::read_to_string(a.path().join("other/settings")).unwrap(),
            "other"
        );
        assert!(!first.env.contains_key(PAYLOAD_ENV));
        assert!(!first.env.contains_key("HOME"));
        let owned = a.path().to_path_buf();
        assert!(first.args.contains(&owned.to_string_lossy().into_owned()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(a.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(a.path().join("devin/mcp_config.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(a);
        assert!(!owned.exists());
        assert!(b.path().exists());
        assert_eq!(
            fs::read_to_string(home.path().join(".config/devin/config.json")).unwrap(),
            original
        );
    }

    #[test]
    fn maps_remote_servers_and_empty_payload_with_original_xdg() {
        let home = tempfile::tempdir().unwrap();
        let xdg = home.path().join("custom");
        fs::create_dir(&xdg).unwrap();
        let mut input = config(
            home.path(),
            serde_json::json!([
                {"name":"http","type":"http","url":"https://example.com/mcp","headers":[{"name":"Authorization","value":"secret"}]},
                {"name":"sse","type":"sse","url":"http://localhost/sse","headers":[]}
            ]),
        );
        let guard = prepare(&mut input, home.path(), home.path(), |_| Some(xdg.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            read(guard.path())["mcpServers"]["http"]["transport"],
            "http"
        );
        assert_eq!(read(guard.path())["mcpServers"]["sse"]["transport"], "sse");
        let mut empty = config(home.path(), serde_json::json!([]));
        let guard = prepare(&mut empty, home.path(), home.path(), |_| None)
            .unwrap()
            .unwrap();
        assert_eq!(read(guard.path())["mcpServers"], serde_json::json!({}));
    }

    #[test]
    fn rejects_malformed_unsupported_shadowed_or_untargeted_payloads_without_echoing_tokens() {
        let home = tempfile::tempdir().unwrap();
        for raw in [
            "secret malformed".to_owned(),
            "{}".into(),
            r#"[{"name":"secret","type":"channel"}]"#.into(),
            " ".repeat(MAX_JSON_BYTES + 1),
        ] {
            let mut input = config(home.path(), Value::Null);
            input.env.insert(PAYLOAD_ENV.into(), raw);
            assert_eq!(
                prepare(&mut input, home.path(), home.path(), |_| None).err().unwrap(),
                "Invalid MCP configuration for devin"
            );
        }
        let mut wrong = config(home.path(), payload("one"));
        wrong.args[1] = "codex".into();
        assert_eq!(
            prepare(&mut wrong, home.path(), home.path(), |_| None).err().unwrap(),
            UNSUPPORTED
        );
        let mut no_subcommand = config(home.path(), payload("one"));
        no_subcommand.args.truncate(2);
        assert!(prepare(&mut no_subcommand, home.path(), home.path(), |_| None).is_err());
        write(
            home.path(),
            ".devin/mcp_config.local.json",
            "{/*comment*/\"mcpServers\":{\"cognia-tools\":{\"command\":\"other\",},},}",
        );
        let mut input = config(home.path(), payload("one"));
        assert!(prepare(&mut input, home.path(), home.path(), |_| None)
            .err()
            .unwrap()
            .contains("shadows"));
        assert!(!fs::read_dir(home.path()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cognia-mcp-config-")));
    }

    #[test]
    fn a_copy_failure_removes_the_partial_overlay() {
        let home = tempfile::tempdir().unwrap();
        write(home.path(), ".config/devin/config.json", "{broken secret");
        let mut input = config(home.path(), payload("one"));
        assert!(prepare(&mut input, home.path(), home.path(), |_| None).is_err());
        assert!(!fs::read_dir(home.path()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cognia-mcp-config-")));
        #[cfg(unix)]
        {
            write(home.path(), ".config/devin/config.json", "{}");
            std::os::unix::fs::symlink(
                home.path().join(".config/devin"),
                home.path().join(".config/devin/loop"),
            )
            .unwrap();
            assert!(prepare(&mut input, home.path(), home.path(), |_| None)
                .err()
                .unwrap()
                .contains("cycle"));
        }
    }
}
