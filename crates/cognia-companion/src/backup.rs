//! Cloud-neutral, application-encrypted headless backups.
//!
//! The transport speaks the S3 HTTP contract directly with SigV4, so AWS,
//! MinIO, R2, and other S3-compatible endpoints share one implementation.

use aes_gcm::aead::{Aead, KeyInit as AeadKeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use chrono::{DateTime, Utc};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use hmac::{Hmac, KeyInit as HmacKeyInit, Mac};
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tar::{Archive, Builder};
use tempfile::Builder as TempBuilder;
use url::Url;

const ENVELOPE_MAGIC: &[u8; 5] = b"CGBK1";
const NONCE_LEN: usize = 12;
const BACKUP_SCHEMA: u32 = 1;

// The brain owns its codecs and recovery rules. Tests can inject the verifier
// while exercising the same archive, envelope and restore verification paths.
type BrainVerifier = dyn Fn(&Path) -> Result<(), String> + Send + Sync;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub schema: u32,
    pub build: String,
    pub backup_id: String,
    pub created_at: DateTime<Utc>,
    pub key_version: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPointReport {
    pub id: String,
    pub kind: String,
    pub manifest_sha256: String,
    pub size_bytes: i64,
    pub verified: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupResult {
    pub recovery_points: Vec<RecoveryPointReport>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreResult {
    pub recovery_point_id: String,
    pub destination: PathBuf,
    pub manifest_sha256: String,
    pub file_count: usize,
    pub read_only_smoke: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationResult {
    pub data_directory: PathBuf,
    pub file_count: usize,
    pub sqlite_integrity: bool,
    #[serde(default)]
    pub checks: Vec<String>,
}

#[derive(Clone)]
struct S3Config {
    endpoint: Url,
    region: String,
    bucket: String,
    path_style: bool,
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
    prefix: String,
}

impl S3Config {
    async fn from_env() -> Result<Option<Self>, String> {
        let Some(endpoint) = env_nonempty("COGNIA_S3_ENDPOINT") else {
            return Ok(None);
        };
        let endpoint = Url::parse(&endpoint).map_err(|error| format!("S3 endpoint: {error}"))?;
        if endpoint.scheme() != "https" && !endpoint.host_str().is_some_and(is_loopback_host) {
            return Err("S3 endpoint must use HTTPS except on loopback".into());
        }
        let access_key = read_required_secret_file("COGNIA_S3_ACCESS_KEY_FILE").await?;
        let secret_key = read_required_secret_file("COGNIA_S3_SECRET_KEY_FILE").await?;
        let session_token = match env_nonempty("COGNIA_S3_SESSION_TOKEN_FILE") {
            Some(path) => Some(read_secret_file(Path::new(&path)).await?),
            None => None,
        };
        Ok(Some(Self {
            endpoint,
            region: env_nonempty("COGNIA_S3_REGION").unwrap_or_else(|| "auto".into()),
            bucket: required_env("COGNIA_S3_BUCKET")?,
            path_style: env_nonempty("COGNIA_S3_PATH_STYLE")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
            access_key,
            secret_key,
            session_token,
            prefix: env_nonempty("COGNIA_BACKUP_PREFIX")
                .unwrap_or_else(|| "cognia".into())
                .trim_matches('/')
                .to_owned(),
        }))
    }

    fn object_key(&self, backup_id: &str) -> String {
        if self.prefix.is_empty() {
            format!("{backup_id}.cgbk")
        } else {
            format!("{}/{backup_id}.cgbk", self.prefix)
        }
    }

    fn object_url(&self, key: &str) -> Result<Url, String> {
        let mut url = self.endpoint.clone();
        let encoded_key = key
            .split('/')
            .map(percent_encode)
            .collect::<Vec<_>>()
            .join("/");
        let base_path = url.path().trim_end_matches('/').to_string();
        if self.path_style {
            url.set_path(&format!(
                "{base_path}/{}/{}",
                percent_encode(&self.bucket),
                encoded_key
            ));
        } else {
            let host = url
                .host_str()
                .ok_or_else(|| "S3 endpoint has no host".to_string())?;
            url.set_host(Some(&format!("{}.{}", self.bucket, host)))
                .map_err(|_| "S3 bucket cannot be used as a virtual host".to_string())?;
            url.set_path(&format!("{base_path}/{encoded_key}"));
        }
        Ok(url)
    }

    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), String> {
        let url = self.object_url(key)?;
        let response = self.signed_request(reqwest::Method::PUT, url, body).await?;
        if !response.status().is_success() {
            return Err(format!("S3 PUT failed with {}", response.status()));
        }
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        let url = self.object_url(key)?;
        let response = self
            .signed_request(reqwest::Method::GET, url, Vec::new())
            .await?;
        if !response.status().is_success() {
            return Err(format!("S3 GET failed with {}", response.status()));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("read S3 object: {error}"))
    }

    async fn signed_request(
        &self,
        method: reqwest::Method,
        url: Url,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, String> {
        let now = Utc::now();
        let body_hash = hex::encode(Sha256::digest(&body));
        let signed = sign_v4(
            &method,
            &url,
            &body_hash,
            now,
            &self.region,
            &self.access_key,
            &self.secret_key,
            self.session_token.as_deref(),
        )?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .no_proxy()
            .build()
            .map_err(|error| format!("build S3 client: {error}"))?;
        let mut request = client
            .request(method, url)
            .header("x-amz-date", signed.amz_date)
            .header("x-amz-content-sha256", body_hash)
            .header("authorization", signed.authorization)
            .body(body);
        if let Some(token) = &self.session_token {
            request = request.header("x-amz-security-token", token);
        }
        request
            .send()
            .await
            .map_err(|error| format!("S3 request: {error}"))
    }
}

struct SignedHeaders {
    amz_date: String,
    authorization: String,
}

#[allow(clippy::too_many_arguments)]
fn sign_v4(
    method: &reqwest::Method,
    url: &Url,
    body_hash: &str,
    now: DateTime<Utc>,
    region: &str,
    access_key: &str,
    secret_key: &str,
    session_token: Option<&str>,
) -> Result<SignedHeaders, String> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let host = canonical_host(url)?;
    let mut canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{body_hash}\nx-amz-date:{amz_date}\n");
    let mut signed_headers = "host;x-amz-content-sha256;x-amz-date".to_string();
    if let Some(token) = session_token {
        canonical_headers.push_str(&format!("x-amz-security-token:{}\n", token.trim()));
        signed_headers.push_str(";x-amz-security-token");
    }
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri(url),
        url.query().unwrap_or_default(),
        canonical_headers,
        signed_headers,
        body_hash
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let date_key = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes())?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, b"s3")?;
    let signing_key = hmac_sha256(&service_key, b"aws4_request")?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    Ok(SignedHeaders {
        amz_date,
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
        ),
    })
}

fn hmac_sha256(key: &[u8], input: &[u8]) -> Result<[u8; 32], String> {
    let mut mac = <Hmac<Sha256> as HmacKeyInit>::new_from_slice(key)
        .map_err(|_| "invalid HMAC key".to_string())?;
    mac.update(input);
    Ok(mac.finalize().into_bytes().into())
}

pub async fn create_backup(data_dir: &Path, backup_id: &str) -> Result<BackupResult, String> {
    validate_identifier(backup_id)?;
    let key_version = required_env("COGNIA_BACKUP_KEY_VERSION")?;
    validate_identifier(&key_version)?;
    let key = load_backup_key(&key_version).await?;
    let s3 = S3Config::from_env().await?;
    if s3.is_none()
        && env_nonempty("COGNIA_REQUIRE_OBJECT_BACKUP")
            .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Err("production backup requires an S3-compatible object store".into());
    }
    create_verified_backup(
        data_dir,
        backup_id,
        &key_version,
        &key,
        |envelope| async move {
            if let Some(s3) = s3 {
                let object_key = s3.object_key(backup_id);
                s3.put(&object_key, envelope).await?;
                Ok(Some(s3.get(&object_key).await?))
            } else {
                Ok(None)
            }
        },
    )
    .await
}

async fn create_verified_backup<F, Fut>(
    data_dir: &Path,
    backup_id: &str,
    key_version: &str,
    key: &[u8; 32],
    publish: F,
) -> Result<BackupResult, String>
where
    F: FnOnce(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<Option<Vec<u8>>, String>>,
{
    create_verified_backup_with_verifier(
        data_dir,
        backup_id,
        key_version,
        key,
        publish,
        &verify_brain_root,
    )
    .await
}

async fn create_verified_backup_with_verifier<F, Fut>(
    data_dir: &Path,
    backup_id: &str,
    key_version: &str,
    key: &[u8; 32],
    publish: F,
    verifier: &BrainVerifier,
) -> Result<BackupResult, String>
where
    F: FnOnce(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<Option<Vec<u8>>, String>>,
{
    let cache_dir = data_dir.join("backups");
    fs::create_dir_all(&cache_dir).map_err(|error| format!("create backup cache: {error}"))?;
    let archive = build_archive_with_verifier(data_dir, backup_id, key_version, verifier)?;
    let manifest_hash = hex::encode(Sha256::digest(&archive.manifest_bytes));
    let envelope = encrypt_archive(&archive.archive_bytes, key, key_version)?;
    let local_path = cache_dir.join(format!("{backup_id}.cgbk"));
    atomic_write(&local_path, &envelope)?;
    let local_bytes =
        fs::read(&local_path).map_err(|error| format!("read written backup: {error}"))?;
    verify_backup_envelope_with_verifier(&local_bytes, key, backup_id, &manifest_hash, verifier)?;
    let kind = if let Some(uploaded) = publish(envelope).await? {
        verify_backup_envelope_with_verifier(&uploaded, key, backup_id, &manifest_hash, verifier)?;
        "object-store"
    } else {
        "local"
    };

    let points = vec![RecoveryPointReport {
        id: backup_id.to_owned(),
        kind: kind.into(),
        manifest_sha256: manifest_hash,
        size_bytes: i64::try_from(local_bytes.len()).unwrap_or(i64::MAX),
        verified: true,
        created_at: archive.manifest.created_at,
    }];
    Ok(BackupResult {
        recovery_points: points,
    })
}

pub async fn restore_backup(
    data_dir: &Path,
    recovery_point_id: &str,
    destination: &Path,
    read_only_smoke: bool,
) -> Result<RestoreResult, String> {
    restore_backup_with_verifier(
        data_dir,
        recovery_point_id,
        destination,
        read_only_smoke,
        &verify_brain_root,
    )
    .await
}

async fn restore_backup_with_verifier(
    data_dir: &Path,
    recovery_point_id: &str,
    destination: &Path,
    read_only_smoke: bool,
    verifier: &BrainVerifier,
) -> Result<RestoreResult, String> {
    validate_identifier(recovery_point_id)?;
    validate_destination(data_dir, destination)?;
    let local_path = data_dir
        .join("backups")
        .join(format!("{recovery_point_id}.cgbk"));
    let envelope = match tokio::fs::read(&local_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let s3 = S3Config::from_env().await?.ok_or_else(|| {
                "recovery point is not cached and S3 is not configured".to_string()
            })?;
            s3.get(&s3.object_key(recovery_point_id)).await?
        }
        Err(error) => return Err(format!("read recovery point: {error}")),
    };
    let key_version = envelope_key_version(&envelope)?;
    let key = load_backup_key(&key_version).await?;
    let archive_bytes = decrypt_archive(&envelope, &key)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "restore destination must have a parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create restore parent: {error}"))?;
    let staging = TempBuilder::new()
        .prefix(".cognia-restore-")
        .tempdir_in(parent)
        .map_err(|error| format!("create restore staging: {error}"))?;
    let unpacked = staging.path().join("unpacked");
    fs::create_dir(&unpacked).map_err(|error| format!("create unpack directory: {error}"))?;
    Archive::new(GzDecoder::new(archive_bytes.as_slice()))
        .unpack(&unpacked)
        .map_err(|error| format!("unpack recovery point: {error}"))?;
    let manifest_bytes = fs::read(unpacked.join("manifest.json"))
        .map_err(|error| format!("read backup manifest: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("parse backup manifest: {error}"))?;
    if manifest.schema != BACKUP_SCHEMA || manifest.backup_id != recovery_point_id {
        return Err("backup manifest identity or schema does not match".into());
    }
    let restored_data = unpacked.join("data");
    verify_manifest(&restored_data, &manifest)?;
    if read_only_smoke {
        verify_data_directory_with_verifier(&restored_data, verifier)?;
    }
    if destination.exists() {
        copy_verified_restore(&restored_data, destination)?;
    } else {
        fs::rename(&restored_data, destination)
            .map_err(|error| format!("activate restored directory: {error}"))?;
    }
    verify_manifest(destination, &manifest)?;
    if read_only_smoke {
        verify_data_directory_with_verifier(destination, verifier)?;
    }
    Ok(RestoreResult {
        recovery_point_id: recovery_point_id.to_owned(),
        destination: destination.to_owned(),
        manifest_sha256: hex::encode(Sha256::digest(&manifest_bytes)),
        file_count: manifest.files.len(),
        read_only_smoke,
    })
}

pub fn verify_data_directory(data_directory: &Path) -> Result<VerificationResult, String> {
    verify_data_directory_with_verifier(data_directory, &verify_brain_root)
}

fn verify_data_directory_with_verifier(
    data_directory: &Path,
    verifier: &BrainVerifier,
) -> Result<VerificationResult, String> {
    if !data_directory.is_absolute() || !data_directory.is_dir() {
        return Err("verification target must be an existing absolute directory".into());
    }
    let mut file_count = 0;
    visit_files(data_directory, &mut |_| {
        file_count += 1;
        Ok(())
    })?;
    if file_count == 0 {
        return Err("verification target is empty".into());
    }
    let mut checks = vec!["Host store layout".to_owned()];
    checks.extend(sqlite_integrity_smoke(data_directory)?);
    for brain in brain_roots(data_directory)? {
        let binary = brain.join("binary");
        if binary.is_dir() {
            for entry in fs::read_dir(&binary)
                .map_err(|error| format!("read brain binaries: {error}"))?
            {
                let entry = entry.map_err(|error| format!("read brain binary: {error}"))?;
                if is_brain_binary(data_directory, &entry.path()) {
                    let mut file = File::open(entry.path())
                        .map_err(|error| format!("open brain binary: {error}"))?;
                    let mut hash = Sha256::new();
                    let mut buffer = [0_u8; 64 * 1024];
                    loop {
                        let count = file
                            .read(&mut buffer)
                            .map_err(|error| format!("hash brain binary: {error}"))?;
                        if count == 0 {
                            break;
                        }
                        hash.update(&buffer[..count]);
                    }
                    if hex::encode(hash.finalize()) != entry.file_name().to_string_lossy() {
                        return Err(format!(
                            "brain binary content hash mismatch: {}",
                            entry.path().display()
                        ));
                    }
                }
            }
        }
        verifier(&brain).map_err(|error| {
            format!("brain verification failed for {}: {error}", brain.display())
        })?;
        checks.push(format!(
            "{}: brain durability verify + binary content hashes",
            brain.strip_prefix(data_directory).unwrap_or(&brain).display()
        ));
    }
    Ok(VerificationResult {
        data_directory: data_directory.to_owned(),
        file_count,
        sqlite_integrity: true,
        checks,
    })
}

struct BuiltArchive {
    archive_bytes: Vec<u8>,
    manifest_bytes: Vec<u8>,
    manifest: BackupManifest,
}

fn build_archive_with_verifier(
    data_dir: &Path,
    backup_id: &str,
    key_version: &str,
    verifier: &BrainVerifier,
) -> Result<BuiltArchive, String> {
    let staging = tempfile::tempdir().map_err(|error| format!("create backup staging: {error}"))?;
    let staged_data = staging.path().join("data");
    fs::create_dir(&staged_data).map_err(|error| format!("create staged data: {error}"))?;
    // Fence GC before taking the brain's database snapshot. Binary bytes are
    // durable before their references commit, so copying them AFTER SQLite
    // includes every snapshot reference, even as ordinary writes continue.
    // The lease prevents GC from deleting a snapshot reference dropped later.
    let brain_fences = snapshot_brain_databases(data_dir, &staged_data)?;
    copy_consistent_tree(data_dir, data_dir, &staged_data)?;
    brain_fences.verify_accounts(data_dir)?;
    drop(brain_fences);
    verify_data_directory_with_verifier(&staged_data, verifier)?;
    let mut files = manifest_files(&staged_data)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = BackupManifest {
        schema: BACKUP_SCHEMA,
        build: env!("CARGO_PKG_VERSION").into(),
        backup_id: backup_id.to_owned(),
        created_at: Utc::now(),
        key_version: key_version.to_owned(),
        files,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("serialize manifest: {error}"))?;
    fs::write(staging.path().join("manifest.json"), &manifest_bytes)
        .map_err(|error| format!("write manifest: {error}"))?;
    let mut archive_bytes = Vec::new();
    {
        let encoder = GzEncoder::new(&mut archive_bytes, Compression::default());
        let mut tar = Builder::new(encoder);
        tar.append_path_with_name(staging.path().join("manifest.json"), "manifest.json")
            .map_err(|error| format!("archive manifest: {error}"))?;
        tar.append_dir_all("data", &staged_data)
            .map_err(|error| format!("archive data: {error}"))?;
        let encoder = tar
            .into_inner()
            .map_err(|error| format!("finish tar: {error}"))?;
        encoder
            .finish()
            .map_err(|error| format!("finish gzip: {error}"))?;
    }
    Ok(BuiltArchive {
        archive_bytes,
        manifest_bytes,
        manifest,
    })
}

fn copy_consistent_tree(root: &Path, current: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("read data directory: {error}"))? {
        let entry = entry.map_err(|error| format!("read data entry: {error}"))?;
        let source = entry.path();
        let relative = source
            .strip_prefix(root)
            .map_err(|_| "data path escaped backup root".to_string())?;
        if relative
            .components()
            .next()
            .is_some_and(|component| {
                let name = component.as_os_str();
                // ADR-0233: owner-private acceptance evidence has no implicit
                // backup/export destination, including encrypted Host backups.
                name == "backups" || name == "managed-desktop-evidence"
            })
        {
            continue;
        }
        let metadata = entry
            .file_type()
            .map_err(|error| format!("inspect data entry: {error}"))?;
        let target = destination.join(relative);
        if metadata.is_dir() {
            fs::create_dir_all(&target).map_err(|error| format!("stage directory: {error}"))?;
            copy_consistent_tree(root, &source, destination)?;
        } else if metadata.is_file() {
            if is_sqlite_sidecar(&source) || is_writer_lease(&source) || target.is_file() {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("stage parent: {error}"))?;
            }
            if !is_brain_binary(root, &source) && is_sqlite_database(&source)? {
                sqlite_online_copy(&source, &target)?;
            } else {
                fs::copy(&source, &target).map_err(|error| format!("stage file: {error}"))?;
            }
        }
    }
    Ok(())
}

fn is_brain_binary(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let Some(parts) = relative.iter().map(|part| part.to_str()).collect::<Option<Vec<_>>>() else {
        return false;
    };
    let parts = if parts.first() == Some(&"persons") && parts.len() >= 2 {
        &parts[2..]
    } else {
        &parts[..]
    };
    let ["serve", "durability", _, "binary", reference] = parts else {
        return false;
    };
    reference.len() == 64
        && reference
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn verify_brain_root(root: &Path) -> Result<(), String> {
    // Same deployment contract as cognia-server's brain supervisor: an
    // explicitly configured bundle and the shared Node runtime resolver.
    let entry = env_nonempty(crate::runtime::BRAIN_ENTRY_ENV)
        .map(PathBuf::from)
        .filter(|entry| entry.is_file())
        .ok_or("brain verifier unavailable: COGNIA_BRAIN_ENTRY must name the installed brain CLI bundle")?;
    let executable = cognia_core::node_runtime::node_executable()
        .map_err(|error| format!("brain verifier Node runtime unavailable: {error}"))?;
    let mut command = Command::new(executable);
    command.arg(entry);
    verify_brain_command(root, command)
}

fn verify_brain_command(root: &Path, mut command: Command) -> Result<(), String> {
    let output = command
        .args(["durability", "verify", "--root"])
        .arg(root)
        .arg("--json")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("brain verifier runtime could not be started: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "brain durability verify exited {}: {} {}",
            output.status,
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let record: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid brain verifier JSON: {error}"))?;
    if record["ok"] != true || record["root"].as_str() != root.to_str() {
        return Err(format!("brain verifier did not confirm the requested root: {record}"));
    }
    Ok(())
}

fn sqlite_online_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let source = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("open SQLite source {}: {error}", source.display()))?;
    source
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
        .map_err(|error| format!("checkpoint SQLite source: {error}"))?;
    let mut destination = Connection::open(destination)
        .map_err(|error| format!("open SQLite destination: {error}"))?;
    let backup = Backup::new(&source, &mut destination)
        .map_err(|error| format!("start SQLite backup: {error}"))?;
    backup
        .run_to_completion(128, Duration::from_millis(5), None)
        .map_err(|error| format!("copy SQLite database: {error}"))?;
    drop(backup);
    destination
        .execute_batch("PRAGMA journal_mode=DELETE;")
        .map_err(|error| format!("seal SQLite backup: {error}"))
}

// Server initialization creates the first two stores; serve creates the
// idempotency store before starting brains. The remaining stores are lazy.
const HOST_DATABASES: &[&str] = &[
    "cognia-server.sqlite",
    "companion-signaling.sqlite",
    "companion-idempotency.sqlite",
    ".cognia/provider-profiles.sqlite",
    "cognia/agent-sessions.sqlite",
    "cognia/jobs.sqlite",
    "task-workspaces/task-workspaces.sqlite",
];

/// Every initialized brain account store: `serve/durability/<account>` in the
/// Host home and in each person partition.
fn brain_roots(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut homes = vec![root.join("serve")];
    // Person brains receive their own COGNIA_DATA_DIR, not the Host's root.
    let persons = root.join("persons");
    if persons.exists() {
        for entry in
            fs::read_dir(&persons).map_err(|error| format!("read person partitions: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read person partition: {error}"))?;
            if entry
                .file_type()
                .map_err(|error| format!("inspect person partition: {error}"))?
                .is_dir()
            {
                homes.push(entry.path().join("serve"));
            }
        }
    }
    let mut roots = Vec::new();
    for home in homes {
        let durability = home.join("durability");
        if !durability.is_dir() {
            continue;
        }
        for account in fs::read_dir(&durability)
            .map_err(|error| format!("read brain durability {}: {error}", durability.display()))?
        {
            let account = account.map_err(|error| format!("read brain account: {error}"))?;
            if !account
                .file_type()
                .map_err(|error| format!("inspect brain account: {error}"))?
                .is_dir()
            {
                continue;
            }
            let brain = account.path();
            let mut initialized = false;
            for file in fs::read_dir(&brain)
                .map_err(|error| format!("read brain account store: {error}"))?
            {
                let file = file.map_err(|error| format!("read brain account file: {error}"))?;
                if !is_writer_lease(&file.path()) && !is_sqlite_sidecar(&file.path()) {
                    initialized = true;
                }
            }
            // Startup may have created only a directory and kernel leases.
            if initialized {
                roots.push(brain);
            }
        }
    }
    roots.sort();
    Ok(roots)
}

fn expected_databases(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut databases = Vec::new();
    let stores = brain_roots(root)?;
    for (index, name) in HOST_DATABASES.iter().enumerate() {
        let path = root.join(name);
        if index < 2 || path.exists() || (index == 2 && !stores.is_empty()) {
            if !path.is_file() {
                return Err(format!("missing expected Host database: {name}"));
            }
            databases.push(path);
        }
    }
    for brain in &stores {
        // serve keeps every account in one SQLite store; an initialized
        // account root without it is not a store this build can restore.
        let sqlite = brain.join("sqlite/store.sqlite");
        if !sqlite.is_file() {
            return Err(format!(
                "missing expected brain database: {}",
                sqlite.display()
            ));
        }
        databases.push(sqlite);
    }
    Ok(databases)
}

struct BrainCopyFences {
    accounts: Vec<PathBuf>,
    _ledgers: Vec<Connection>,
}

impl BrainCopyFences {
    fn verify_accounts(&self, root: &Path) -> Result<(), String> {
        if brain_roots(root)? != self.accounts {
            return Err("brain account stores changed during backup; retry the backup".into());
        }
        Ok(())
    }
}

fn snapshot_brain_databases(root: &Path, destination: &Path) -> Result<BrainCopyFences, String> {
    let mut leases = BrainCopyFences {
        accounts: brain_roots(root)?,
        _ledgers: Vec::new(),
    };
    for brain in &leases.accounts {
        // This is the exact writer-lock.ts kernel-lock protocol. The backup
        // lease keeps binary GC from deleting a side file the SQLite snapshot
        // references; SQLite writers use a different lease and remain online.
        let file = brain.join(".backup-writer.sqlite");
        let lease = Connection::open(&file)
            .map_err(|error| format!("open backup fence {}: {error}", file.display()))?;
        lease
            .busy_timeout(Duration::ZERO)
            .map_err(|error| format!("set backup fence timeout: {error}"))?;
        lease
            .execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;")
            .map_err(|error| {
                format!(
                    "brain account {} ({}) backup store is busy; wait for the other backup or GC sweep, then retry the backup: {error}",
                    brain.file_name().unwrap_or_default().to_string_lossy(),
                    brain.strip_prefix(root).unwrap_or(brain).display()
                )
            })?;
        leases._ledgers.push(lease);
        let source = brain.join("sqlite/store.sqlite");
        if source.exists() {
            let target = destination.join(
                source
                    .strip_prefix(root)
                    .map_err(|_| "brain path escaped backup root")?,
            );
            fs::create_dir_all(target.parent().ok_or("brain snapshot has no parent")?)
                .map_err(|error| format!("create brain snapshot directory: {error}"))?;
            sqlite_online_copy(&source, &target)?;
        }
    }
    Ok(leases)
}

fn is_writer_lease(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(
            ".backup-writer.sqlite" | ".binary-writer.sqlite" | ".sqlite-writer.sqlite"
        )
    )
}

fn sqlite_integrity_smoke(root: &Path) -> Result<Vec<String>, String> {
    let mut databases = expected_databases(root)?;
    let mut checks = Vec::new();
    visit_files(root, &mut |path| {
        if !databases.iter().any(|known| known == path)
            && !is_writer_lease(path)
            && !is_sqlite_sidecar(path)
            && !is_brain_binary(root, path)
            && is_sqlite_database(path)?
        {
            databases.push(path.to_owned());
        }
        Ok(())
    })?;
    databases.sort();
    let staging = tempfile::tempdir()
        .map_err(|error| format!("create SQLite verification staging: {error}"))?;
    for (index, path) in databases.into_iter().enumerate() {
        if !is_sqlite_database(&path)? {
            return Err(format!("invalid SQLite header: {}", path.display()));
        }
        // Even a read-only connection can create WAL/SHM files. Check an exact
        // disposable copy (including pending WAL), never the operator's volume.
        let copy = staging.path().join(format!("{index}.sqlite"));
        fs::copy(&path, &copy)
            .map_err(|error| format!("stage verification database {}: {error}", path.display()))?;
        for suffix in ["-wal", "-journal"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
            if sidecar.exists() {
                fs::copy(
                    &sidecar,
                    PathBuf::from(format!("{}{suffix}", copy.display())),
                )
                .map_err(|error| format!("stage verification sidecar: {error}"))?;
            }
        }
        let connection = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("open restored SQLite {}: {error}", path.display()))?;
        let result: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| format!("integrity-check SQLite {}: {error}", path.display()))?;
        if result != "ok" {
            return Err(format!(
                "SQLite integrity check failed for {}",
                path.display()
            ));
        }
        checks.push(format!(
            "{}: SQLite header + integrity_check",
            path.strip_prefix(root).unwrap_or(&path).display()
        ));
    }
    Ok(checks)
}

#[cfg(test)]
fn verify_backup_envelope(
    envelope: &[u8],
    key: &[u8; 32],
    backup_id: &str,
    manifest_hash: &str,
) -> Result<(), String> {
    verify_backup_envelope_with_verifier(envelope, key, backup_id, manifest_hash, &verify_brain_root)
}

fn verify_backup_envelope_with_verifier(
    envelope: &[u8],
    key: &[u8; 32],
    backup_id: &str,
    manifest_hash: &str,
    verifier: &BrainVerifier,
) -> Result<(), String> {
    let bytes = decrypt_archive(envelope, key)?;
    let staging = tempfile::tempdir()
        .map_err(|error| format!("create backup verification staging: {error}"))?;
    Archive::new(GzDecoder::new(bytes.as_slice()))
        .unpack(staging.path())
        .map_err(|error| format!("unpack backup for verification: {error}"))?;
    let manifest_bytes = fs::read(staging.path().join("manifest.json"))
        .map_err(|error| format!("read verification manifest: {error}"))?;
    if hex::encode(Sha256::digest(&manifest_bytes)) != manifest_hash {
        return Err("backup verification manifest hash does not match".into());
    }
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("parse verification manifest: {error}"))?;
    if manifest.schema != BACKUP_SCHEMA || manifest.backup_id != backup_id {
        return Err("backup verification identity or schema does not match".into());
    }
    if manifest.key_version != envelope_key_version(envelope)? {
        return Err("backup envelope key version does not match the manifest".into());
    }
    let data = staging.path().join("data");
    verify_manifest(&data, &manifest)?;
    verify_data_directory_with_verifier(&data, verifier)?;
    Ok(())
}

fn manifest_files(root: &Path) -> Result<Vec<ManifestFile>, String> {
    let mut files = Vec::new();
    visit_files(root, &mut |path| {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "manifest path escaped staging root".to_string())?;
        let path_string = relative
            .to_str()
            .ok_or_else(|| "backup paths must be UTF-8".to_string())?
            .replace('\\', "/");
        let bytes = fs::read(path).map_err(|error| format!("hash staged file: {error}"))?;
        files.push(ManifestFile {
            path: path_string,
            sha256: hex::encode(Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
        });
        Ok(())
    })?;
    Ok(files)
}

fn verify_manifest(root: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let mut actual = manifest_files(root)?;
    actual.sort_by(|left, right| left.path.cmp(&right.path));
    let mut expected = manifest.files.clone();
    expected.sort_by(|left, right| left.path.cmp(&right.path));
    if actual != expected {
        return Err("restored files do not match the backup manifest".into());
    }
    Ok(())
}

fn visit_files(
    root: &Path,
    visitor: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("read directory: {error}"))? {
        let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect directory entry: {error}"))?;
        if file_type.is_dir() {
            visit_files(&entry.path(), visitor)?;
        } else if file_type.is_file() {
            visitor(&entry.path())?;
        }
    }
    Ok(())
}

fn is_sqlite_database(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|error| format!("inspect file: {error}"))?;
    let mut header = [0_u8; 16];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("inspect file header: {error}"))?;
    Ok(read == header.len() && &header == b"SQLite format 3\0")
}

fn is_sqlite_sidecar(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal")
}

fn encrypt_archive(archive: &[u8], key: &[u8; 32], key_version: &str) -> Result<Vec<u8>, String> {
    let version = key_version.as_bytes();
    let version_len = u16::try_from(version.len()).map_err(|_| "key version is too long")?;
    let mut nonce = [0_u8; NONCE_LEN];
    rand::fill(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "invalid backup key")?;
    let nonce_array = Nonce::from(nonce);
    let ciphertext = cipher
        .encrypt(&nonce_array, archive)
        .map_err(|_| "encrypt backup archive".to_string())?;
    let mut envelope =
        Vec::with_capacity(ENVELOPE_MAGIC.len() + 2 + version.len() + NONCE_LEN + ciphertext.len());
    envelope.extend_from_slice(ENVELOPE_MAGIC);
    envelope.extend_from_slice(&version_len.to_be_bytes());
    envelope.extend_from_slice(version);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

fn envelope_key_version(envelope: &[u8]) -> Result<String, String> {
    if !envelope.starts_with(ENVELOPE_MAGIC) || envelope.len() < ENVELOPE_MAGIC.len() + 2 {
        return Err("backup envelope has an unsupported format".into());
    }
    let offset = ENVELOPE_MAGIC.len();
    let len = u16::from_be_bytes([envelope[offset], envelope[offset + 1]]) as usize;
    let end = offset + 2 + len;
    let version = envelope
        .get(offset + 2..end)
        .ok_or_else(|| "backup envelope key version is truncated".to_string())?;
    std::str::from_utf8(version)
        .map(str::to_owned)
        .map_err(|_| "backup envelope key version is not UTF-8".to_string())
}

fn decrypt_archive(envelope: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let version = envelope_key_version(envelope)?;
    let nonce_start = ENVELOPE_MAGIC.len() + 2 + version.len();
    let nonce_end = nonce_start + NONCE_LEN;
    let nonce = envelope
        .get(nonce_start..nonce_end)
        .ok_or_else(|| "backup envelope nonce is truncated".to_string())?;
    let ciphertext = envelope
        .get(nonce_end..)
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| "backup envelope ciphertext is empty".to_string())?;
    let nonce = Nonce::try_from(nonce)
        .map_err(|_| "backup envelope nonce has an invalid length".to_string())?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| "invalid backup key")?
        .decrypt(&nonce, ciphertext)
        .map_err(|_| "backup authentication failed".to_string())
}

async fn load_backup_key(version: &str) -> Result<[u8; 32], String> {
    let path = if let Some(directory) = env_nonempty("COGNIA_BACKUP_KEY_DIR") {
        PathBuf::from(directory).join(format!("{version}.key"))
    } else {
        PathBuf::from(required_env("COGNIA_BACKUP_KEY_FILE")?)
    };
    let raw = read_secret_file(&path).await?;
    let decoded = hex::decode(raw).map_err(|_| "backup key must be 64 hexadecimal characters")?;
    decoded
        .try_into()
        .map_err(|_| "backup key must decode to 32 bytes".to_string())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("cgbk.tmp");
    let mut file = File::create(&temporary).map_err(|error| format!("create backup: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("persist backup: {error}"))?;
    fs::rename(temporary, path).map_err(|error| format!("publish backup: {error}"))
}

fn validate_destination(data_dir: &Path, destination: &Path) -> Result<(), String> {
    if !destination.is_absolute() || destination.parent().is_none() || destination == Path::new("/")
    {
        return Err("restore destination must be a non-root absolute path".into());
    }
    if destination == data_dir
        || destination.starts_with(data_dir)
        || data_dir.starts_with(destination)
    {
        return Err("restore destination must be separate from the live data directory".into());
    }
    if destination.exists() {
        if !destination.is_dir() {
            return Err(
                "restore destination must be a new directory or empty mounted volume".into(),
            );
        }
        let mut entries = fs::read_dir(destination)
            .map_err(|error| format!("inspect restore destination: {error}"))?;
        if entries
            .next()
            .transpose()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("restore destination is not empty; in-place restore is forbidden".into());
        }
    }
    Ok(())
}

fn copy_verified_restore(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| format!("read restore staging: {error}"))? {
        let entry = entry.map_err(|error| format!("read restore entry: {error}"))?;
        let target = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect restore entry: {error}"))?;
        if file_type.is_dir() {
            fs::create_dir(&target)
                .map_err(|error| format!("create restored directory: {error}"))?;
            copy_verified_restore(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|error| format!("copy restored file: {error}"))?;
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || matches!(value, "." | "..")
    {
        return Err("backup identifier must be a safe stable identifier".into());
    }
    Ok(())
}

fn canonical_uri(url: &Url) -> String {
    if url.path().is_empty() {
        "/".into()
    } else {
        url.path().to_owned()
    }
}

fn canonical_host(url: &Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn required_env(name: &str) -> Result<String, String> {
    env_nonempty(name).ok_or_else(|| format!("{name} is required"))
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

async fn read_required_secret_file(env_name: &str) -> Result<String, String> {
    let path = PathBuf::from(required_env(env_name)?);
    read_secret_file(&path).await
}

async fn read_secret_file(path: &Path) -> Result<String, String> {
    let value = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| format!("read secret file {}: {error}", path.display()))?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(format!("secret file {} is empty", path.display()));
    }
    Ok(value)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // Exercise the current TS verifier without needing a rebuilt CLI bundle or
    // changing the operator's process environment. Production still resolves
    // COGNIA_BRAIN_ENTRY and Node through the Host's deployment contract.
    fn source_brain_verifier(root: &Path) -> Result<(), String> {
        let script = format!(
            "const c = await import({}); const a = await import({}); process.exitCode = await (c.default ?? c).durabilityCommand((a.default ?? a).parseArgv(process.argv.slice(1)), {{out:{{write: s => process.stdout.write(s), error: s => process.stderr.write(s), json: v => console.log(JSON.stringify(v))}},env:{{}}}});",
            brain_module("cli/src/cli/durability-command.ts"),
            brain_module("cli/src/cli/args.ts")
        );
        verify_brain_command(root, node_script_command(&script))
    }

    fn brain_module(file: &str) -> String {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        serde_json::to_string(&format!("file://{}", repo.join(file).display())).unwrap()
    }

    fn node_script_command(script: &str) -> Command {
        let mut command = Command::new(cognia_core::node_runtime::node_executable().unwrap());
        command.args(["--import", "tsx", "--input-type=module", "-e", script])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
        command
    }

    fn verify_data_directory(root: &Path) -> Result<VerificationResult, String> {
        verify_data_directory_with_verifier(root, &source_brain_verifier)
    }

    fn build_archive(root: &Path, id: &str, key: &str) -> Result<BuiltArchive, String> {
        build_archive_with_verifier(root, id, key, &source_brain_verifier)
    }

    async fn restore_backup(
        root: &Path, id: &str, destination: &Path, smoke: bool,
    ) -> Result<RestoreResult, String> {
        restore_backup_with_verifier(root, id, destination, smoke, &source_brain_verifier).await
    }

    struct BackupTestEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl BackupTestEnv {
        fn new() -> Self {
            let names = [
                "COGNIA_BACKUP_KEY_VERSION",
                "COGNIA_BACKUP_KEY_FILE",
                "COGNIA_BACKUP_KEY_DIR",
                "COGNIA_REQUIRE_OBJECT_BACKUP",
                "COGNIA_S3_ENDPOINT",
                "COGNIA_S3_BUCKET",
                "COGNIA_S3_ACCESS_KEY_FILE",
                "COGNIA_S3_SECRET_KEY_FILE",
                "COGNIA_S3_SESSION_TOKEN_FILE",
                "COGNIA_S3_PATH_STYLE",
                "COGNIA_BACKUP_PREFIX",
                crate::runtime::BRAIN_ENTRY_ENV,
            ];
            let values = names
                .into_iter()
                .map(|name| (name, std::env::var_os(name)))
                .collect();
            for name in names {
                std::env::remove_var(name);
            }
            Self(values)
        }
    }

    impl Drop for BackupTestEnv {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    fn seed_host(root: &Path) {
        for name in &HOST_DATABASES[..3] {
            Connection::open(root.join(name))
                .unwrap()
                .execute_batch("CREATE TABLE fixture(value TEXT);")
                .unwrap();
        }
    }

    fn seed_brain(root: &Path) -> PathBuf {
        seed_brain_account(root, "local-account")
    }

    fn seed_brain_account(root: &Path, account: &str) -> PathBuf {
        let brain = root.join("serve/durability").join(account);
        fs::create_dir_all(brain.join("sqlite")).unwrap();
        Connection::open(brain.join("sqlite/store.sqlite"))
            .unwrap()
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE rows(value TEXT);
                CREATE TABLE durability_schema(database TEXT PRIMARY KEY, version INTEGER, tables TEXT);
                CREATE TABLE durability_rows(database TEXT, table_name TEXT, row_key TEXT, value TEXT);")
            .unwrap();
        brain
    }

    /// Write one attachment row through the brain's own SQLite store, so the
    /// fixture is exactly what serve writes (row codec, binary side file).
    fn seed_attachment(brain: &Path, attachment: &Path) {
        fs::create_dir_all(brain).unwrap();
        let script = format!(
            "import fs from 'node:fs'; const v = await import({}); const s = await import({}); const root = {}; const value = (v.default ?? v).encodeDurableValue(new Uint8Array(fs.readFileSync({})), root); const store = (s.default ?? s).openSqliteBackend({{ root }}); await store.compact({{sequence:0,dbs:{{cognia:{{schema:{{version:1,tables:['messages']}},rows:{{messages:{{'s:attachment':{{id:'attachment',value}}}}}}}}}}}}); await store.close();",
            brain_module("cli/src/serve/persistence/value-codec.ts"),
            brain_module("cli/src/serve/persistence/sqlite.ts"),
            serde_json::to_string(brain).unwrap(),
            serde_json::to_string(attachment).unwrap(),
        );
        let output = node_script_command(&script).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn backup_preserves_sqlite_header_attachments_in_every_brain_layout() {
        let attachments = tempfile::tempdir().unwrap();
        let file = attachments.path().join("attachment.sqlite");
        Connection::open(&file).unwrap()
            .execute_batch("CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(24000));")
            .unwrap();
        let bytes = fs::read(&file).unwrap();
        assert!(bytes.len() > 16 * 1024);
        assert_eq!(&bytes[..16], b"SQLite format 3\0");
        let reference = hex::encode(Sha256::digest(&bytes));
        for partition in ["", "persons/member-A"] {
            {
                let source = tempfile::tempdir().unwrap();
                seed_host(source.path());
                let brain = source.path().join(partition).join("serve/durability/member-A");
                seed_attachment(&brain, &file);
                // Also prove that SQLite-looking bytes need not be a database.
                let mut opaque = vec![7_u8; 20000];
                opaque[..16].copy_from_slice(b"SQLite format 3\0");
                let opaque_ref = hex::encode(Sha256::digest(&opaque));
                fs::write(brain.join("binary").join(&opaque_ref), &opaque).unwrap();
                let built = build_archive(source.path(), "sqlite-attachment", "v1").unwrap();
                let staged = tempfile::tempdir().unwrap();
                Archive::new(GzDecoder::new(built.archive_bytes.as_slice())).unpack(staged.path()).unwrap();
                let staged_data = staged.path().join("data");
                let copy = staged_data.join(brain.strip_prefix(source.path()).unwrap());
                assert_eq!(fs::read(copy.join("binary").join(&reference)).unwrap(), bytes);
                assert_eq!(fs::read(copy.join("binary").join(&opaque_ref)).unwrap(), opaque);
                verify_data_directory(&staged_data).unwrap();
                fs::write(copy.join("binary").join(&opaque_ref), b"changed orphan").unwrap();
                assert!(verify_data_directory(&staged_data).unwrap_err().contains("content hash mismatch"));
            }
        }
    }

    #[test]
    fn backup_delegates_missing_references_and_damaged_rows_to_the_brain() {
        for fault in ["missing binary", "unlisted table"] {
            let source = tempfile::tempdir().unwrap();
            seed_host(source.path());
            let attachment = source.path().join("attachment");
            fs::write(&attachment, vec![1_u8; 20000]).unwrap();
            let brain = source.path().join("persons/member-A/serve/durability/member-A");
            seed_attachment(&brain, &attachment);
            verify_data_directory(source.path()).unwrap();
            if fault == "missing binary" {
                fs::remove_dir_all(brain.join("binary")).unwrap();
            } else {
                // SQLite's own integrity check passes; only the brain knows a
                // row must belong to a table its schema row lists.
                Connection::open(brain.join("sqlite/store.sqlite"))
                    .unwrap()
                    .execute_batch("INSERT INTO durability_rows_codec1 VALUES ('cognia', 'ghost', 's:x', '{}', 1);")
                    .unwrap();
            }
            let error = verify_data_directory(source.path()).unwrap_err();
            assert!(error.contains("brain verification failed"), "{error}");
            assert!(error.contains(if fault == "missing binary" { "is missing" } else { "does not list" }), "{error}");
            assert!(build_archive(source.path(), "damaged", "v1").is_err());
            // A valid archive manifest cannot conceal a brain recovery fault.
            let archive = previous_backup_archive(source.path(), "damaged");
            let unpacked = tempfile::tempdir().unwrap();
            Archive::new(GzDecoder::new(archive.as_slice())).unpack(unpacked.path()).unwrap();
            let hash = hex::encode(Sha256::digest(fs::read(unpacked.path().join("manifest.json")).unwrap()));
            let key = [1_u8; 32];
            let envelope = encrypt_archive(&archive, &key, "key-v1").unwrap();
            assert!(verify_backup_envelope_with_verifier(&envelope, &key, "damaged", &hash, &source_brain_verifier).is_err());
        }
    }

    #[test]
    fn backup_verifier_seam_requires_every_account_and_fails_closed_without_runtime() {
        let source = tempfile::tempdir().unwrap();
        seed_host(source.path());
        seed_brain(source.path());
        seed_brain_account(&source.path().join("persons/member-A"), "member-A");
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let calls = seen.clone();
        let pass = move |root: &Path| {
            calls.lock().unwrap().push(root.to_owned());
            Ok(())
        };
        verify_data_directory_with_verifier(source.path(), &pass).unwrap();
        assert_eq!(seen.lock().unwrap().len(), 2);
        let fail = |root: &Path| {
            if root.ends_with("member-A") { Err("injected brain fault".into()) } else { Ok(()) }
        };
        assert!(verify_data_directory_with_verifier(source.path(), &fail).unwrap_err().contains("injected brain fault"));
        assert!(build_archive_with_verifier(source.path(), "refused", "v1", &fail).is_err());
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = BackupTestEnv::new();
        assert!(super::verify_data_directory(source.path()).unwrap_err().contains("COGNIA_BRAIN_ENTRY"));
    }

    #[test]
    fn backup_verifier_requires_successful_json_for_the_requested_root() {
        let root = Path::new("/staged/account");
        for script in [
            "console.log(JSON.stringify({ok:true,root:process.argv[4]}))",
            "console.log(JSON.stringify({ok:false,root:process.argv[4]}))",
            "console.log(JSON.stringify({ok:true,root:'/other'}))",
            "console.log('not JSON')",
            "console.log(JSON.stringify({ok:true,root:process.argv[4]})); process.exitCode=1",
        ] {
            let mut command = Command::new(cognia_core::node_runtime::node_executable().unwrap());
            command.args(["-e", script]);
            let result = verify_brain_command(root, command);
            assert_eq!(result.is_ok(), script == "console.log(JSON.stringify({ok:true,root:process.argv[4]}))", "{result:?}");
        }
        assert!(verify_brain_command(root, Command::new("/missing/brain-node")).unwrap_err().contains("could not be started"));
    }

    #[test]
    fn backup_uses_configured_brain_entry_with_the_host_node_runtime() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = BackupTestEnv::new();
        let source = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        seed_host(source.path());
        seed_brain(source.path());
        let entry = runtime.path().join("brain verifier.mjs");
        std::env::set_var(crate::runtime::BRAIN_ENTRY_ENV, &entry);
        assert!(super::verify_data_directory(source.path())
            .unwrap_err()
            .contains("brain verifier unavailable"));
        // This fixture checks the production process boundary; codec and
        // recovery behavior are exercised by source_brain_verifier above.
        fs::write(&entry, r#"
            const args = process.argv.slice(2);
            const valid = args.length === 5 && args[0] === 'durability'
                && args[1] === 'verify' && args[2] === '--root' && args[4] === '--json';
            console.log(JSON.stringify({ok: valid, root: args[3]}));
            process.exitCode = valid ? 0 : 1;
        "#).unwrap();
        super::verify_data_directory(source.path()).unwrap();
        fs::write(&entry, "console.log(JSON.stringify({ok:false,root:process.argv[5]}))").unwrap();
        assert!(super::verify_data_directory(source.path())
            .unwrap_err()
            .contains("did not confirm the requested root"));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn backup_restore_and_publication_require_the_injected_brain_verifier() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = BackupTestEnv::new();
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let secrets = tempfile::tempdir().unwrap();
        seed_host(source.path());
        seed_brain(source.path());
        let key = [9_u8; 32];
        let key_file = secrets.path().join("backup.key");
        fs::write(&key_file, hex::encode(key)).unwrap();
        std::env::set_var("COGNIA_BACKUP_KEY_VERSION", "key-v1");
        std::env::set_var("COGNIA_BACKUP_KEY_FILE", key_file);
        let refused = create_verified_backup_with_verifier(
            source.path(), "refused", "key-v1", &key,
            |_| async { panic!("failed brain verification must prevent publication") },
            &|_| Err("injected brain fault".into()),
        ).await;
        assert!(refused.unwrap_err().contains("injected brain fault"));
        assert!(!source.path().join("backups/refused.cgbk").exists());
        let result = create_verified_backup_with_verifier(
            source.path(), "accepted", "key-v1", &key,
            |_| async { Ok(None) }, &source_brain_verifier,
        ).await.unwrap();
        assert!(result.recovery_points[0].verified);
        let target = destination.path().join("restored");
        assert!(restore_backup_with_verifier(
            source.path(), "accepted", &target, true,
            &|_| Err("injected restore fault".into()),
        ).await.unwrap_err().contains("injected restore fault"));
        assert!(!target.exists());
        let observed = std::sync::Arc::new(Mutex::new(Vec::new()));
        let calls = observed.clone();
        let verifier = move |root: &Path| {
            calls.lock().unwrap().push(root.to_owned());
            source_brain_verifier(root)
        };
        restore_backup_with_verifier(source.path(), "accepted", &target, true, &verifier).await.unwrap();
        let calls = observed.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].starts_with(destination.path()));
        assert_eq!(calls[1], target.join("serve/durability/local-account"));
    }

    // Schema-1 archive writer from before H09-H11. These fixtures contain
    // closed SQLite databases and stable table files, so no online copy is
    // needed. Do not call today's builder or its layout/fence verification.
    fn previous_backup_archive(data: &Path, id: &str) -> Vec<u8> {
        let mut files = manifest_files(data).unwrap();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest = BackupManifest {
            schema: 1,
            build: "0.1.0".into(),
            backup_id: id.into(),
            created_at: Utc::now(),
            key_version: "key-v1".into(),
            files,
        };
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let mut tar = Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        tar.append_data(&mut header, "manifest.json", bytes.as_slice())
            .unwrap();
        tar.append_dir_all("data", data).unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn backup_restores_previous_archives_without_a_brain_store() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = BackupTestEnv::new();
        let secrets = tempfile::tempdir().unwrap();
        let key = [9_u8; 32];
        let key_file = secrets.path().join("backup.key");
        fs::write(&key_file, hex::encode(key)).unwrap();
        std::env::set_var("COGNIA_BACKUP_KEY_VERSION", "key-v1");
        std::env::set_var("COGNIA_BACKUP_KEY_FILE", &key_file);
        for layout in ["no-brain", "not-booted"] {
            let source = tempfile::tempdir().unwrap();
            let destination = tempfile::tempdir().unwrap();
            seed_host(source.path());
            if layout == "not-booted" {
                fs::create_dir(source.path().join("serve")).unwrap();
                fs::remove_file(source.path().join("companion-idempotency.sqlite")).unwrap();
            }
            let archive = previous_backup_archive(source.path(), layout);
            fs::create_dir(source.path().join("backups")).unwrap();
            fs::write(
                source.path().join("backups").join(format!("{layout}.cgbk")),
                encrypt_archive(&archive, &key, "key-v1").unwrap(),
            )
            .unwrap();
            let target = destination.path().join("restored");
            let report = restore_backup(source.path(), layout, &target, true)
                .await
                .unwrap();
            assert!(report.read_only_smoke);
            let verified = verify_data_directory(&target).unwrap();
            assert!(verified.sqlite_integrity);
        }
    }

    #[test]
    fn backup_accepts_uninitialized_serve_without_a_store() {
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        fs::create_dir_all(root.path().join("serve")).unwrap();
        verify_data_directory(root.path()).unwrap();
        build_archive(root.path(), "not-booted", "v1").unwrap();
    }

    #[test]
    fn backup_discovers_person_and_host_accounts_and_notices_partition_changes() {
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        let host = seed_brain(root.path());
        let member = seed_brain_account(&root.path().join("persons/member-A"), "member-A");
        let before = brain_roots(root.path()).unwrap();
        assert_eq!(
            before.len(),
            2,
            "must discover both {} and {}",
            host.display(),
            member.display()
        );
        let staged = tempfile::tempdir().unwrap();
        let fences = snapshot_brain_databases(root.path(), staged.path()).unwrap();
        fences.verify_accounts(root.path()).unwrap();
        seed_brain_account(&root.path().join("persons/member-B"), "member-B");
        assert_ne!(brain_roots(root.path()).unwrap(), before);
        assert!(fences
            .verify_accounts(root.path())
            .unwrap_err()
            .contains("stores changed during backup"));
    }

    #[test]
    fn backup_verification_rejects_unrecognized_and_damaged_stores() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("readme.txt"), b"not a Host").unwrap();
        assert!(verify_data_directory(root.path()).is_err());
        fs::write(
            root.path().join("cognia-server.sqlite"),
            b"damaged SQLite header",
        )
        .unwrap();
        assert!(verify_data_directory(root.path()).is_err());
    }

    #[test]
    fn backup_verification_requires_host_databases_and_reports_checks_read_only() {
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        for name in &HOST_DATABASES[3..] {
            let file = root.path().join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            Connection::open(file)
                .unwrap()
                .execute_batch("CREATE TABLE lazy(value TEXT);")
                .unwrap();
        }
        let brain = seed_brain(root.path());
        let before = manifest_files(root.path()).unwrap();
        let report = verify_data_directory(root.path()).unwrap();
        assert!(report.sqlite_integrity);
        for name in HOST_DATABASES {
            assert!(report
                .checks
                .contains(&format!("{name}: SQLite header + integrity_check")));
        }
        assert!(report
            .checks
            .iter()
            .any(|check| check.contains("serve/durability/local-account/sqlite/store.sqlite")));
        assert_eq!(manifest_files(root.path()).unwrap(), before);
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol/companion-response-schemas.json"
        ))
        .unwrap();
        let serialized = serde_json::to_value(report).unwrap();
        for name in serialized.as_object().unwrap().keys() {
            assert!(
                schema["$defs"]["HostBackupVerificationResult"]["properties"]
                    .get(name)
                    .is_some()
            );
        }
        fs::remove_file(brain.join("sqlite/store.sqlite")).unwrap();
        assert!(verify_data_directory(root.path())
            .unwrap_err()
            .contains("missing expected brain database"));
    }

    #[test]
    fn backup_verification_rejects_missing_headers_and_corrupt_pages_in_known_databases() {
        for name in HOST_DATABASES {
            let root = tempfile::tempdir().unwrap();
            seed_host(root.path());
            let file = root.path().join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, b"damaged header").unwrap();
            let error = verify_data_directory(root.path()).unwrap_err();
            assert!(
                error.contains("invalid SQLite header") && error.contains(name),
                "{error}"
            );
        }
        for name in &HOST_DATABASES[..3] {
            let root = tempfile::tempdir().unwrap();
            seed_host(root.path());
            seed_brain(root.path());
            fs::remove_file(root.path().join(name)).unwrap();
            assert!(verify_data_directory(root.path())
                .unwrap_err()
                .contains(name));
        }
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        let brain = seed_brain(root.path());
        let file = brain.join("sqlite/store.sqlite");
        let mut bytes = fs::read(&file).unwrap();
        bytes[100] = 0xff;
        fs::write(&file, bytes).unwrap();
        assert!(is_sqlite_database(&file).unwrap());
        assert!(verify_data_directory(root.path())
            .unwrap_err()
            .contains("integrity-check SQLite"));
        fs::write(file, b"damaged brain header").unwrap();
        assert!(verify_data_directory(root.path())
            .unwrap_err()
            .contains("invalid SQLite header"));
    }

    #[test]
    fn backup_verification_checks_initialized_brain_layouts() {
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        fs::create_dir_all(root.path().join("serve/durability")).unwrap();
        verify_data_directory(root.path()).unwrap();
        let brain = seed_brain(root.path());
        fs::remove_dir_all(brain.join("sqlite")).unwrap();
        assert!(verify_data_directory(root.path())
            .unwrap_err()
            .contains("missing expected brain database"));
    }

    #[test]
    fn backup_verification_checks_pending_wal_without_modifying_the_target() {
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        let brain = seed_brain(root.path());
        let live = Connection::open(brain.join("sqlite/store.sqlite")).unwrap();
        live.execute_batch("PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=999999 WHERE name='rows';").unwrap();
        assert!(
            fs::metadata(brain.join("sqlite/store.sqlite-wal"))
                .unwrap()
                .len()
                > 0
        );
        let before = manifest_files(root.path()).unwrap();
        assert!(verify_data_directory(root.path()).is_err());
        assert_eq!(manifest_files(root.path()).unwrap(), before);
    }

    fn brain_gc(brain: &Path) -> Vec<String> {
        // Exercise the actual Node GC against Rust's SQLite kernel lock.
        let module = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../cli/src/serve/persistence/binary-store.ts");
        let script = format!(
            "const m = await import({}); const {{pruneBinaries}} = m.default ?? m; console.log(JSON.stringify(pruneBinaries({}, new Set(), Date.now(), 0)));",
            serde_json::to_string(&format!("file://{}", module.display())).unwrap(),
            serde_json::to_string(brain).unwrap(),
        );
        let output = std::process::Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "-e", &script])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    fn backup_snapshots_brain_before_side_files_and_fences_cross_process_gc() {
        backup_snapshot_interleaving("");
    }

    #[test]
    fn backup_snapshots_person_brain_before_side_files_and_fences_cross_process_gc() {
        backup_snapshot_interleaving("persons/member-A");
    }

    fn backup_snapshot_interleaving(partition: &str) {
        let root = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        seed_host(root.path());
        let account = if partition.is_empty() {
            "local-account"
        } else {
            "member-A"
        };
        let brain = seed_brain_account(&root.path().join(partition), account);
        fs::create_dir_all(brain.join("binary")).unwrap();
        let reference = hex::encode(Sha256::digest(b"snapshot bytes"));
        fs::write(brain.join("binary").join(&reference), b"snapshot bytes").unwrap();
        let live = Connection::open(brain.join("sqlite/store.sqlite")).unwrap();
        live.execute("INSERT INTO rows VALUES (?1)", [&reference])
            .unwrap();
        let leases = snapshot_brain_databases(root.path(), destination.path()).unwrap();
        // Drop the reference AFTER the snapshot, and try to collect its bytes.
        live.execute_batch("DELETE FROM rows;").unwrap();
        assert!(brain_gc(&brain).is_empty());
        // A commit after the snapshot must not enter the staged database.
        let next = hex::encode(Sha256::digest(b"new bytes"));
        fs::write(brain.join("binary").join(&next), b"new bytes").unwrap();
        live.execute("INSERT INTO rows VALUES (?1)", [&next])
            .unwrap();
        copy_consistent_tree(root.path(), root.path(), destination.path()).unwrap();
        verify_data_directory(destination.path()).unwrap();
        let staged_brain = destination
            .path()
            .join(brain.strip_prefix(root.path()).unwrap());
        let staged_db = Connection::open(staged_brain.join("sqlite/store.sqlite")).unwrap();
        let references: Vec<String> = staged_db
            .prepare("SELECT value FROM rows")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(references, vec![reference.clone()]);
        assert_eq!(
            fs::read(staged_brain.join("binary").join(&reference)).unwrap(),
            b"snapshot bytes"
        );
        assert!(!staged_brain.join(".backup-writer.sqlite").exists());
        drop(leases);
        assert!(brain_gc(&brain).contains(&reference));
    }

    #[test]
    fn backup_refuses_a_busy_fence_and_releases_it_on_copy_failure() {
        let root = tempfile::tempdir().unwrap();
        seed_host(root.path());
        let brain = seed_brain(root.path());
        let lease = Connection::open(brain.join(".backup-writer.sqlite")).unwrap();
        lease.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        assert!(build_archive(root.path(), "busy", "v1")
            .err()
            .unwrap()
            .contains("busy"));
        drop(lease);
        fs::write(brain.join("sqlite/store.sqlite"), b"broken").unwrap();
        assert!(build_archive(root.path(), "broken", "v1").is_err());
        let lease = Connection::open(brain.join(".backup-writer.sqlite")).unwrap();
        lease.execute_batch("BEGIN EXCLUSIVE;").unwrap();
    }

    #[test]
    fn archive_round_trip_uses_online_sqlite_copy_and_rejects_tampering() {
        let source = tempfile::tempdir().unwrap();
        seed_host(source.path());
        let db_path = source.path().join("cognia-server.sqlite");
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('durable');")
            .unwrap();
        fs::write(source.path().join("config.json"), b"{\"ok\":true}").unwrap();

        let built = build_archive(source.path(), "backup-1", "key-v1").unwrap();
        assert_eq!(built.manifest.schema, BACKUP_SCHEMA);
        assert_eq!(built.manifest.files.len(), 4);
        assert!(built
            .manifest
            .files
            .iter()
            .all(|file| !file.path.ends_with("-wal")));

        let key = [7_u8; 32];
        let envelope = encrypt_archive(&built.archive_bytes, &key, "key-v1").unwrap();
        assert_eq!(envelope_key_version(&envelope).unwrap(), "key-v1");
        assert_eq!(
            decrypt_archive(&envelope, &key).unwrap(),
            built.archive_bytes
        );
        let hash = hex::encode(Sha256::digest(&built.manifest_bytes));
        verify_backup_envelope(&envelope, &key, "backup-1", &hash).unwrap();
        let mut wrong_version = envelope.clone();
        wrong_version[ENVELOPE_MAGIC.len() + 2 + "key-v1".len() - 1] = b'2';
        assert!(verify_backup_envelope(&wrong_version, &key, "backup-1", &hash).is_err());
        assert!(verify_backup_envelope(&envelope, &key, "another-backup", &hash).is_err());
        assert!(verify_backup_envelope(&envelope, &key, "backup-1", "wrong hash").is_err());
        let mut tampered = envelope;
        *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt_archive(&tampered, &key).is_err());
        assert!(verify_backup_envelope(&tampered, &key, "backup-1", &hash).is_err());
    }

    #[test]
    fn archive_excludes_acceptance_metadata_images_and_pending_evidence_files() {
        let source = tempfile::tempdir().unwrap();
        seed_host(source.path());
        let evidence = source.path().join("managed-desktop-evidence");
        fs::create_dir_all(evidence.join("staging")).unwrap();
        fs::write(evidence.join("index.enc"), b"private decisions").unwrap();
        fs::write(evidence.join("staging/frame.enc"), b"private screenshot").unwrap();
        fs::write(source.path().join("config.json"), b"{}").unwrap();
        let built = build_archive(source.path(), "private-evidence", "key-v1").unwrap();
        assert_eq!(built.manifest.files.len(), 4);
        assert!(built.manifest.files.iter().any(|file| file.path == "config.json"));
        let decoder = flate2::read::GzDecoder::new(built.archive_bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        for entry in archive.entries().unwrap() {
            let entry = entry.unwrap();
            assert!(!entry.path().unwrap().to_string_lossy().contains("managed-desktop-evidence"));
        }
    }

    #[test]
    fn sigv4_is_deterministic_and_signs_session_tokens() {
        let url = Url::parse("https://bucket.s3.example.com/cognia/backup.cgbk").unwrap();
        let signed = sign_v4(
            &reqwest::Method::PUT,
            &url,
            &hex::encode(Sha256::digest(b"payload")),
            DateTime::parse_from_rfc3339("2026-08-01T10:11:12Z")
                .unwrap()
                .with_timezone(&Utc),
            "auto",
            "access",
            "secret",
            Some("session-token"),
        )
        .unwrap();
        assert_eq!(signed.amz_date, "20260801T101112Z");
        assert!(signed
            .authorization
            .contains("Credential=access/20260801/auto/s3/aws4_request"));
        assert!(signed.authorization.contains("x-amz-security-token"));
    }

    #[test]
    fn restore_never_targets_live_or_parent_directories() {
        let root = Path::new("/srv/cognia");
        assert!(validate_destination(root, Path::new("/srv/cognia")).is_err());
        assert!(validate_destination(root, Path::new("/srv")).is_err());
        assert!(validate_destination(root, Path::new("/srv/cognia/restore")).is_err());
        assert!(validate_destination(root, Path::new("relative")).is_err());
    }

    #[test]
    fn object_urls_support_path_style_and_virtual_host_endpoints() {
        let base = S3Config {
            endpoint: Url::parse("https://s3.example.com/base").unwrap(),
            region: "auto".into(),
            bucket: "cognia-backups".into(),
            path_style: true,
            access_key: "access".into(),
            secret_key: "secret".into(),
            session_token: None,
            prefix: "tenant one".into(),
        };
        assert_eq!(
            base.object_url(&base.object_key("backup-1"))
                .unwrap()
                .as_str(),
            "https://s3.example.com/base/cognia-backups/tenant%20one/backup-1.cgbk"
        );
        let virtual_host = S3Config {
            path_style: false,
            ..base
        };
        assert_eq!(
            virtual_host
                .object_url(&virtual_host.object_key("backup-1"))
                .unwrap()
                .as_str(),
            "https://cognia-backups.s3.example.com/base/tenant%20one/backup-1.cgbk"
        );
    }

    #[tokio::test]
    async fn backup_object_report_requires_verified_readback_and_propagates_upload_failure() {
        let source = tempfile::tempdir().unwrap();
        seed_host(source.path());
        let key = [9_u8; 32];
        let result = create_verified_backup(
            source.path(),
            "remote-1",
            "key-v1",
            &key,
            |uploaded| async { Ok(Some(uploaded)) },
        )
        .await
        .unwrap();
        assert_eq!(result.recovery_points[0].kind, "object-store");
        assert!(result.recovery_points[0].verified);
        let corrupt = create_verified_backup(
            source.path(),
            "remote-bad",
            "key-v1",
            &key,
            |mut uploaded| async move {
                *uploaded.last_mut().unwrap() ^= 1;
                Ok(Some(uploaded))
            },
        )
        .await;
        assert!(corrupt.is_err());
        let failed =
            create_verified_backup(source.path(), "upload-failed", "key-v1", &key, |_| async {
                Err("S3 PUT failed with 503".into())
            })
            .await
            .unwrap_err();
        assert!(failed.contains("S3 PUT failed with 503"));
        fs::write(source.path().join("cognia-server.sqlite"), b"bad header").unwrap();
        let published = std::cell::Cell::new(false);
        let invalid = create_verified_backup(source.path(), "invalid", "key-v1", &key, |_| {
            published.set(true);
            async { Ok(None) }
        })
        .await;
        assert!(invalid.is_err());
        assert!(!published.get());
    }

    #[tokio::test]
    // Backup configuration is read from process-global environment variables;
    // the guard covers the complete asynchronous backup/restore transaction.
    #[allow(clippy::await_holding_lock)]
    async fn complete_backup_and_new_directory_restore_preserve_verified_data() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = BackupTestEnv::new();
        let source = tempfile::tempdir().unwrap();
        seed_host(source.path());
        let destination_parent = tempfile::tempdir().unwrap();
        let secrets = tempfile::tempdir().unwrap();
        let key_file = secrets.path().join("backup.key");
        fs::write(&key_file, hex::encode([9_u8; 32])).unwrap();
        fs::write(source.path().join("state.json"), b"{\"durable\":true}").unwrap();
        let database = Connection::open(source.path().join("cognia-server.sqlite")).unwrap();
        database
            .execute_batch("CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('yes');")
            .unwrap();
        drop(database);

        std::env::set_var("COGNIA_BACKUP_KEY_VERSION", "key-v1");
        std::env::set_var("COGNIA_BACKUP_KEY_FILE", &key_file);
        std::env::remove_var("COGNIA_BACKUP_KEY_DIR");
        std::env::remove_var("COGNIA_S3_ENDPOINT");
        std::env::remove_var("COGNIA_REQUIRE_OBJECT_BACKUP");

        let backup = create_backup(source.path(), "recovery-1").await.unwrap();
        assert_eq!(backup.recovery_points.len(), 1);
        assert_eq!(backup.recovery_points[0].kind, "local");
        assert!(backup.recovery_points[0].verified);
        let destination = destination_parent.path().join("restored-data");
        let restored = restore_backup(source.path(), "recovery-1", &destination, true)
            .await
            .unwrap();
        assert!(restored.read_only_smoke);
        assert_eq!(
            fs::read(destination.join("state.json")).unwrap(),
            b"{\"durable\":true}"
        );
        let restored_db = Connection::open(destination.join("cognia-server.sqlite")).unwrap();
        let value: String = restored_db
            .query_row("SELECT value FROM durable", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "yes");

        std::env::set_var("COGNIA_REQUIRE_OBJECT_BACKUP", "true");
        assert!(create_backup(source.path(), "requires-object")
            .await
            .unwrap_err()
            .contains("requires an S3-compatible object store"));
        assert!(!source.path().join("backups/requires-object.cgbk").exists());
    }
}
