//! Restart-only session-engine selection, separate from permission settings.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionEngineId {
    #[default]
    Native,
    AgentDesktop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineConfig {
    #[serde(default)]
    pub generation: String,
    pub schema_version: u32,
    pub revision: u64,
    pub desired_engine: SessionEngineId,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            generation: String::new(),
            schema_version: 1,
            revision: 0,
            desired_engine: SessionEngineId::Native,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub config_generation: String,
    pub configuration_error: bool,
    pub recovery_token: Option<String>,
    pub agent_desktop_available: bool,
    pub candidate_health: String,
    pub revision: u64,
    pub desired_engine: SessionEngineId,
    pub effective_engine: SessionEngineId,
    pub needs_restart: bool,
    pub health: String,
    pub reason_code: Option<String>,
    pub binary_version: Option<String>,
    pub profile: Option<String>,
}

pub struct ConfigSnapshot {
    pub config: EngineConfig,
    pub configuration_error: bool,
    pub recovery_token: Option<String>,
}

pub fn snapshot() -> ConfigSnapshot {
    match load() {
        Ok(config) => ConfigSnapshot {
            config,
            configuration_error: false,
            recovery_token: None,
        },
        Err(_) => ConfigSnapshot {
            config: EngineConfig::default(),
            configuration_error: true,
            recovery_token: path()
                .ok()
                .and_then(|path| open_regular(&path).ok())
                .and_then(|file| stream_digest(file, None).ok()),
        },
    }
}

fn open_regular(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok(file)
}

fn read_bytes(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    let file = open_regular(path)?;
    if file.metadata()?.len() > 64 * 1024 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok(bytes)
}

#[cfg(test)]
fn token(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Recovery may preserve a malformed file larger than the parser budget.
fn stream_digest(
    mut source: std::fs::File,
    mut backup: Option<&mut std::fs::File>,
) -> std::io::Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        if let Some(backup) = backup.as_mut() {
            backup.write_all(&buffer[..count])?;
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn path() -> Result<PathBuf, String> {
    super::persist::dir()
        .map(|dir| dir.join("session-engine.json"))
        .ok_or_else(|| "configError".into())
}

pub fn load() -> Result<EngineConfig, String> {
    read(&path()?)
}

fn read(path: &std::path::Path) -> Result<EngineConfig, String> {
    let bytes = match read_bytes(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EngineConfig::default())
        }
        Err(_) => return Err("configError".into()),
    };
    let config: EngineConfig =
        serde_json::from_slice(&bytes).map_err(|_| "configError".to_string())?;
    if config.schema_version != 1
        || (!config.generation.is_empty() && uuid::Uuid::parse_str(&config.generation).is_err())
    {
        return Err("configError".into());
    }
    Ok(config)
}

/// CAS is protected across processes; publication happens before acknowledging save.
pub fn save(
    expected_revision: u64,
    expected_generation: &str,
    desired_engine: SessionEngineId,
    recovery_token: Option<&str>,
) -> Result<EngineConfig, String> {
    let path = path()?;
    save_at(
        &path,
        expected_revision,
        expected_generation,
        desired_engine,
        recovery_token,
    )
}

fn save_at(
    path: &std::path::Path,
    expected_revision: u64,
    expected_generation: &str,
    desired_engine: SessionEngineId,
    recovery_token: Option<&str>,
) -> Result<EngineConfig, String> {
    let parent = path.parent().ok_or("configError")?;
    std::fs::create_dir_all(parent).map_err(|_| "configError")?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let lock = options
        .open(parent.join("session-engine.lock"))
        .map_err(|_| "configError")?;
    lock.try_lock_exclusive().map_err(|_| "configBusy")?;
    let mut config = match read(path) {
        Ok(config) if recovery_token.is_none() => config,
        Ok(_) => return Err("revisionConflict".into()),
        Err(_) => {
            let source = open_regular(path).map_err(|_| "configError")?;
            let digest = stream_digest(source, None).map_err(|_| "configError")?;
            if expected_revision != 0
                || !expected_generation.is_empty()
                || desired_engine != SessionEngineId::Native
                || recovery_token != Some(digest.as_str())
            {
                return Err("revisionConflict".into());
            }
            // Recovery preserves the exact rejected file before replacing it.
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut backup = options
                .open(parent.join(format!(
                    "session-engine.invalid-{}.json",
                    uuid::Uuid::new_v4()
                )))
                .map_err(|_| "configError")?;
            let copied = stream_digest(
                open_regular(path).map_err(|_| "configError")?,
                Some(&mut backup),
            )
            .map_err(|_| "configError")?;
            backup.sync_all().map_err(|_| "configError")?;
            if copied != digest {
                return Err("revisionConflict".into());
            }
            EngineConfig::default()
        }
    };
    if config.revision != expected_revision || config.generation != expected_generation {
        return Err("revisionConflict".into());
    }
    config.revision = config.revision.checked_add(1).ok_or("configError")?;
    if config.generation.is_empty() {
        config.generation = uuid::Uuid::new_v4().to_string();
    }
    config.desired_engine = desired_engine;
    super::persist::write_json(path, &config).map_err(|_| "configError")?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_is_bound_to_exact_bad_bytes_and_preserves_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session-engine.json");
        std::fs::write(&path, b"invalid").unwrap();
        let stale = token(b"invalid");
        assert!(save_at(&path, 0, "", SessionEngineId::Native, None).is_err());
        assert!(save_at(&path, 0, "", SessionEngineId::AgentDesktop, Some(&stale)).is_err());
        std::fs::write(&path, b"new invalid").unwrap();
        assert!(save_at(&path, 0, "", SessionEngineId::Native, Some(&stale)).is_err());
        let current = token(b"new invalid");
        let config = save_at(&path, 0, "", SessionEngineId::Native, Some(&current)).unwrap();
        assert_eq!(config.revision, 1);
        assert_eq!(read(&path).unwrap().desired_engine, SessionEngineId::Native);
        let backup = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("session-engine.invalid-")
            })
            .unwrap();
        assert_eq!(std::fs::read(backup).unwrap(), b"new invalid");
        assert!(save_at(
            &path,
            1,
            &config.generation,
            SessionEngineId::Native,
            Some(&current)
        )
        .is_err());
    }

    #[test]
    fn recovery_rotates_generation_even_when_numeric_revision_repeats() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session-engine.json");
        let old = save_at(&path, 0, "", SessionEngineId::AgentDesktop, None).unwrap();
        std::fs::write(&path, b"broken").unwrap();
        let recovered = save_at(
            &path,
            0,
            "",
            SessionEngineId::Native,
            Some(&token(b"broken")),
        )
        .unwrap();
        assert_eq!(old.revision, recovered.revision);
        assert_ne!(old.generation, recovered.generation);
        assert!(save_at(
            &path,
            old.revision,
            &old.generation,
            SessionEngineId::AgentDesktop,
            None
        )
        .is_err());
    }

    #[test]
    fn oversized_corrupt_config_can_be_recovered_without_parsing_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session-engine.json");
        let bytes = vec![b'x'; 128 * 1024];
        std::fs::write(&path, &bytes).unwrap();
        assert!(read(&path).is_err());
        let digest = stream_digest(open_regular(&path).unwrap(), None).unwrap();
        assert_eq!(digest, token(&bytes));
        save_at(&path, 0, "", SessionEngineId::Native, Some(&digest)).unwrap();
        assert_eq!(read(&path).unwrap().desired_engine, SessionEngineId::Native);
    }
    #[test]
    fn unknown_selection_is_not_a_native_fallback() {
        assert!(serde_json::from_str::<EngineConfig>(
            r#"{"schemaVersion":1,"revision":2,"desiredEngine":"other"}"#
        )
        .is_err());
    }
}
