//! Consented submission of a local crash report to a diagnostic service.
//!
//! The renderer owns *whether* and *what* to send — it holds the connection,
//! renders the redacted preview, and collects the consent checkboxes. This
//! module owns everything the renderer cannot do: reading the report files,
//! capturing a current-state screenshot, building and signing the
//! `.cognia-diagnostic` package, and pushing it to the service.
//!
//! Packaging and upload stay native for a reason beyond capability. A package
//! can reach a gigabyte; handing it to the WebView only for the WebView to
//! hand it back out is two copies of it through the IPC boundary, and the
//! desktop CSP would block the request at the far end anyway.
//!
//! The upload sequence itself is not implemented here — it is
//! `crate::diagnostic_submit`, shared with the CLI so both
//! speak the same protocol. This file supplies the transport (the app's proxy
//! policy) and the local bookkeeping.

use std::path::{Path, PathBuf};

use crate::{
    create_diagnostic_package, delete_incident, delete_incident_with_credential,
    exchange_installation_grant, fetch_receipt, installation_key_path, submit_package,
    withdraw_consent, AttachmentInput, AttachmentKind, DiagnosticPackageInput, DiagnosticTransport,
    HttpRequest, HttpResponse, InstallationIdentity, SubmissionRequest, SubmissionTarget,
    SubmitError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::crash::receipts::{self, SubmissionRecord};
use crate::crash::report::{self, NormalizedReport};
use crate::crash_privacy::CrashScrubber;

/// Frames a panic backtrace contributes to grouping, before the service's own
/// cap. Matches `MAX_GROUPING_FRAMES` on the service so neither side silently
/// truncates what the other counted on.
const MAX_BACKTRACE_FRAMES: usize = 64;

/// Connection the renderer resolved from its own settings.
///
/// Passed per call rather than held in native state: the renderer owns the
/// connection store (URL in per-account local state, session token in the
/// keyring), and duplicating it here would give the two halves two answers.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticConnectionInput {
    pub base_url: String,
    pub tenant_id: String,
    pub project_id: String,
}

impl DiagnosticConnectionInput {
    fn target(&self) -> SubmissionTarget {
        SubmissionTarget::new(&self.base_url, &self.tenant_id, &self.project_id)
    }
}

/// The consent decisions the submission preview collected.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionConsentInput {
    /// Unchecked by default. A minidump can hold process memory, which is why
    /// the service gates reading it back behind a separate tenant opt-in.
    #[serde(default)]
    pub include_minidump: bool,
    /// Captured *now*, after consent — never a crash-time frame, because none
    /// exists. The copy in the consent panel says exactly that.
    #[serde(default)]
    pub include_screenshot: bool,
    /// Free text the user typed. Travels as its own package attachment so the
    /// service's privacy pass scans it like anything else.
    #[serde(default)]
    pub description: Option<String>,
}

/// What the renderer gets back — the stored record plus what actually moved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionOutcome {
    #[serde(flatten)]
    pub record: SubmissionRecord,
    pub uploaded_parts: usize,
    pub resumed_parts: usize,
    /// True when a screenshot was asked for but the platform refused capture,
    /// so the UI can say so instead of implying one was sent.
    pub screenshot_unavailable: bool,
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// The desktop's `DiagnosticTransport`: async reqwest under the app's proxy
/// policy, driven synchronously.
///
/// `block_on` is safe here because every command below runs the submission on
/// a blocking task — a blocking thread is not an async context, so entering the
/// runtime from it does not panic. The alternative, an async transport trait,
/// would force a runtime into the CLI, which deliberately has none.
struct NativeTransport;

impl DiagnosticTransport for NativeTransport {
    fn execute(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
        let method: reqwest::Method = request
            .method
            .parse()
            .map_err(|_| format!("invalid HTTP method {}", request.method))?;
        let client = cognia_net::proxy_config::managed_client(
            reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)),
            &request.url,
        )
        .map_err(|error| error.to_string())?;

        let mut pending = client.request(method, &request.url);
        for (name, value) in &request.headers {
            pending = pending.header(*name, value.as_str());
        }
        if let Some(body) = request.body {
            pending = pending.body(body.to_vec());
        }

        tauri::async_runtime::block_on(async move {
            let response = pending.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?
                .to_vec();
            Ok(HttpResponse { status, body })
        })
    }
}

// ---------------------------------------------------------------------------
// Local inputs
// ---------------------------------------------------------------------------

fn validate_stem(stem: &str) -> Result<(), String> {
    if stem.is_empty()
        || stem.contains("..")
        || stem.contains('/')
        || stem.contains('\\')
        || stem.contains(':')
    {
        return Err("invalid_report_stem".to_owned());
    }
    Ok(())
}

/// The Cognia data directory, which is the crash directory's parent.
fn data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|dir| dir.join("Cognia"))
        .ok_or_else(|| "crash_dir_unavailable".to_owned())
}

/// The installation identity, shared byte-for-byte with the CLI.
///
/// Same file, so `cognia crash submit` and the desktop app are one
/// installation to the service: submissions made by either are readable and
/// deletable by the other.
fn identity() -> Result<InstallationIdentity, String> {
    let path = installation_key_path(&data_dir()?);
    InstallationIdentity::load_or_create(&path).map_err(|error| format!("identity:{error}"))
}

/// Split a Rust backtrace into the frame strings the service groups on.
///
/// The crash report stores its backtrace as one blob of text. Left that way,
/// the service finds no frames at all and every panic fingerprints on module
/// and exception alone — every crash in the app collapsing into one group.
pub fn backtrace_frames(backtrace: &str) -> Vec<String> {
    backtrace
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // Drop the numbered-index prefix (`  12: foo::bar`) so the same frame
        // at a different depth is the same string.
        .map(|line| match line.split_once(": ") {
            Some((index, rest)) if index.trim_start().chars().all(|c| c.is_ascii_digit()) => rest,
            _ => line,
        })
        .filter(|line| !line.starts_with("at "))
        .map(str::to_owned)
        .take(MAX_BACKTRACE_FRAMES)
        .collect()
}

/// Build the structured events the package carries.
///
/// One event per report, shaped so the service's frame extractor recognizes
/// it: `stackFrames` is one of the keys it looks for, and the raw report rides
/// alongside for a human reading the package later.
fn events_for(report: &serde_json::Value) -> Vec<serde_json::Value> {
    let frames = report
        .get("backtrace")
        .and_then(serde_json::Value::as_str)
        .map(backtrace_frames)
        .unwrap_or_default();
    vec![serde_json::json!({
        "kind": "crash",
        "capturedAt": report.get("capturedAt").cloned().unwrap_or(serde_json::Value::Null),
        "message": report.get("message").cloned().unwrap_or(serde_json::Value::Null),
        "location": report.get("location").cloned().unwrap_or(serde_json::Value::Null),
        "stackFrames": frames,
        "report": report,
    })]
}

/// Captures the primary screen as PNG bytes, or `None` when the platform
/// refuses.
pub type ScreenshotCapture = fn() -> Option<Vec<u8>>;

/// The screen-capture backend. The desktop app installs one from
/// `cognia-automation` at boot, so this crate does not link the whole
/// UI-automation stack for a single call (ADR-0196). Left empty — the headless
/// server, a unit test — it behaves like a platform that refuses: the
/// submission goes out without a screenshot and says so.
pub static SCREENSHOT_CAPTURE: cognia_core::installed::Installed<ScreenshotCapture> =
    cognia_core::installed::Installed::new(
        "cognia_observability::crash::submit::SCREENSHOT_CAPTURE",
    );

/// Capture a screenshot of the current screen into `dir`.
///
/// Returns `None` when the platform refuses — screen recording permission is
/// not granted, no monitor is attached, a headless session, no capture
/// backend installed. A refused screenshot never fails the submission: the
/// report is worth more than the optional attachment, and the caller reports
/// the omission instead.
fn capture_screenshot(dir: &Path) -> Option<PathBuf> {
    capture_screenshot_with(SCREENSHOT_CAPTURE.try_get().copied(), dir)
}

fn capture_screenshot_with(capture: Option<ScreenshotCapture>, dir: &Path) -> Option<PathBuf> {
    let bytes = capture?()?;
    let path = dir.join("screenshot.png");
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

/// Staged packages live beside the reports, one directory per report stem.
///
/// A retry must send the *same* package: incident creation is idempotent on
/// the package hash and parts resume by checksum, but only if the bytes do not
/// change. Rebuilding on every attempt minted a fresh incident id, timestamp
/// and hash, so a retry after a create that had already landed opened a
/// second, partial incident instead of resuming the first.
const STAGED_DIR: &str = "staged";
const STAGED_PACKAGE: &str = "incident.cognia-diagnostic";
const STAGED_STATE: &str = "staged.json";

fn staged_dir(crash_dir: &Path, stem: &str) -> PathBuf {
    crash_dir.join(STAGED_DIR).join(stem)
}

/// Forget one report's staged package (after its receipt is stored, when the
/// report is deleted, or when the package proved unusable).
pub(crate) fn discard_staged(crash_dir: &Path, stem: &str) -> std::io::Result<()> {
    let dir = staged_dir(crash_dir, stem);
    match std::fs::remove_dir_all(&dir) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Drop staged packages whose report no longer exists. Returns how many went.
pub(crate) fn discard_orphan_staged(
    crash_dir: &Path,
    live_stems: &std::collections::BTreeSet<String>,
) -> usize {
    let Ok(entries) = std::fs::read_dir(crash_dir.join(STAGED_DIR)) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !live_stems.contains(name.as_ref())
        })
        .filter(|entry| std::fs::remove_dir_all(entry.path()).is_ok())
        .count()
}

/// What a staged package was built from, and what it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagedState {
    /// Hash of the consent decisions and the signing identity. A retry with
    /// different choices (or after a reinstall) is a different package.
    consent_key: String,
    screenshot_unavailable: bool,
    included_minidump: bool,
    included_screenshot: bool,
}

fn trimmed_description(consent: &SubmissionConsentInput) -> Option<&str> {
    consent
        .description
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn consent_key(consent: &SubmissionConsentInput, identity: &InstallationIdentity) -> String {
    let canonical = serde_json::json!({
        "includeMinidump": consent.include_minidump,
        "includeScreenshot": consent.include_screenshot,
        "description": trimmed_description(consent),
        "identity": identity.public_key_base64(),
    });
    hex::encode(Sha256::digest(canonical.to_string().as_bytes()))
}

#[derive(Debug)]
struct BuiltPackage {
    path: PathBuf,
    screenshot_unavailable: bool,
    included_minidump: bool,
    included_screenshot: bool,
}

fn read_staged(dir: &Path, key: &str) -> Option<BuiltPackage> {
    let state: StagedState =
        serde_json::from_slice(&std::fs::read(dir.join(STAGED_STATE)).ok()?).ok()?;
    let path = dir.join(STAGED_PACKAGE);
    (state.consent_key == key && path.is_file()).then_some(BuiltPackage {
        path,
        screenshot_unavailable: state.screenshot_unavailable,
        included_minidump: state.included_minidump,
        included_screenshot: state.included_screenshot,
    })
}

/// The package to send for one report: the staged one when it was built from
/// the same consent and identity, otherwise a fresh one, staged for retries.
///
/// The package is renamed into place and its state written only after it is
/// complete, so an interrupted build is rebuilt rather than half-reused.
fn stage_package(
    crash_dir: &Path,
    stem: &str,
    consent: &SubmissionConsentInput,
    identity: &InstallationIdentity,
) -> Result<BuiltPackage, String> {
    let dir = staged_dir(crash_dir, stem);
    let key = consent_key(consent, identity);
    if let Some(staged) = read_staged(&dir, &key) {
        return Ok(staged);
    }
    discard_staged(crash_dir, stem).map_err(|error| format!("staging:{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("staging:{error}"))?;
    let built = build_package(crash_dir, stem, consent, identity, &dir)?;
    let state = StagedState {
        consent_key: key,
        screenshot_unavailable: built.screenshot_unavailable,
        included_minidump: built.included_minidump,
        included_screenshot: built.included_screenshot,
    };
    let state_tmp = dir.join(format!("{STAGED_STATE}.tmp"));
    std::fs::write(
        &state_tmp,
        serde_json::to_vec(&state).map_err(|error| format!("staging:{error}"))?,
    )
    .and_then(|()| std::fs::rename(&state_tmp, dir.join(STAGED_STATE)))
    .map_err(|error| format!("staging:{error}"))?;
    Ok(built)
}

/// Every string in `value` passes the scrubber's fail-closed check.
fn value_is_clean(scrubber: &CrashScrubber, value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => scrubber.is_clean(text),
        serde_json::Value::Array(items) => items.iter().all(|item| value_is_clean(scrubber, item)),
        serde_json::Value::Object(entries) => {
            entries.values().all(|item| value_is_clean(scrubber, item))
        }
        _ => true,
    }
}

/// Assemble a signed package for one local report inside `out_dir`.
///
/// Every text part starts from [`report::read_normalized`] — the same scrubbed
/// view the preview renders — and is checked again before packaging. The
/// events part is zstd-compressed, so the service cannot scan it before it is
/// decompressed; the client is the only place it can be made safe.
fn build_package(
    crash_dir: &Path,
    stem: &str,
    consent: &SubmissionConsentInput,
    identity: &InstallationIdentity,
    out_dir: &Path,
) -> Result<BuiltPackage, String> {
    let NormalizedReport {
        json,
        txt,
        scrubber,
        ..
    } = report::read_normalized(crash_dir, stem)?;
    let report = json.ok_or_else(|| "report_not_found".to_owned())?;
    let events = events_for(&report);
    let description = trimmed_description(consent).map(|text| scrubber.scrub_text(text));

    // Fail closed: nothing the scrubber would still change, and no
    // high-confidence credential, leaves the machine.
    let clean = events.iter().all(|event| value_is_clean(&scrubber, event))
        && txt.as_deref().is_none_or(|text| scrubber.is_clean(text))
        && description
            .as_deref()
            .is_none_or(|text| scrubber.is_clean(text));
    if !clean {
        return Err("privacy_rejected".to_owned());
    }

    let mut attachments = Vec::new();
    // Loose copies are deleted once the package holds them.
    let mut loose = Vec::new();

    if let Some(text) = &txt {
        let path = out_dir.join("report.txt");
        std::fs::write(&path, text).map_err(|error| format!("staging:{error}"))?;
        loose.push(path.clone());
        attachments.push(AttachmentInput {
            name: "report.txt".to_owned(),
            path,
            media_type: "text/plain; charset=utf-8".to_owned(),
            kind: AttachmentKind::Metadata,
        });
    }

    let mut included_minidump = false;
    if consent.include_minidump {
        let dump_path = crash_dir.join(format!("{stem}.dmp"));
        if dump_path.exists() {
            included_minidump = true;
            attachments.push(AttachmentInput {
                name: "crash.dmp".to_owned(),
                path: dump_path,
                media_type: "application/x-dmp".to_owned(),
                kind: AttachmentKind::Minidump,
            });
        }
    }

    let mut screenshot_unavailable = false;
    let mut included_screenshot = false;
    if consent.include_screenshot {
        match capture_screenshot(out_dir) {
            Some(path) => {
                included_screenshot = true;
                loose.push(path.clone());
                attachments.push(AttachmentInput {
                    name: "screenshot.png".to_owned(),
                    path,
                    media_type: "image/png".to_owned(),
                    kind: AttachmentKind::Screenshot,
                });
            }
            None => screenshot_unavailable = true,
        }
    }

    if let Some(description) = &description {
        let path = out_dir.join("description.txt");
        std::fs::write(&path, description).map_err(|error| format!("description:{error}"))?;
        loose.push(path.clone());
        attachments.push(AttachmentInput {
            name: "description.txt".to_owned(),
            path,
            media_type: "text/plain; charset=utf-8".to_owned(),
            kind: AttachmentKind::UserDescription,
        });
    }

    // Same extension (the builder requires it), different name until complete.
    let partial = out_dir.join("incident.partial.cognia-diagnostic");
    let package = out_dir.join(STAGED_PACKAGE);
    let created = create_diagnostic_package(
        &partial,
        DiagnosticPackageInput {
            incident_id: Uuid::new_v4(),
            created_at: chrono::Utc::now(),
            build_id: build_id(&report),
            app_version: app_version(&report),
            platform: platform_label(&report),
            events,
            attachments,
            source_watermarks: Default::default(),
            missing_sources: Default::default(),
            redaction_version: "client-v1".to_owned(),
        },
        identity.signing_key(),
    );
    for path in loose {
        let _ = std::fs::remove_file(path);
    }
    created.map_err(|error| {
        let _ = std::fs::remove_file(&partial);
        format!("package:{error}")
    })?;
    std::fs::rename(&partial, &package).map_err(|error| format!("staging:{error}"))?;

    Ok(BuiltPackage {
        path: package,
        screenshot_unavailable,
        included_minidump,
        included_screenshot,
    })
}

fn app_version(report: &serde_json::Value) -> String {
    report
        .pointer("/extra/appVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_owned()
}

/// Build identity the service groups on.
///
/// Version plus architecture: the same release on x86_64 and aarch64 produces
/// different frames, so folding them into one build family would group two
/// genuinely different stacks together.
fn build_id(report: &serde_json::Value) -> String {
    let arch = report
        .pointer("/system/arch")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(std::env::consts::ARCH);
    format!("{}-{arch}", app_version(report))
}

fn platform_label(report: &serde_json::Value) -> String {
    report
        .pointer("/system/family")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(std::env::consts::OS)
        .to_owned()
}

/// The incident's `exception`, one of the two fields grouping keys on.
fn exception_for(report: &serde_json::Value) -> String {
    report
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

/// Translate a submission failure into a stable code the UI can translate.
///
/// Never the raw error text: the renderer shows a localized string, and a
/// service message is neither localized nor guaranteed to be free of detail
/// the user should not have to read.
pub fn submit_error_code(error: &SubmitError) -> String {
    if error.is_ingest_disabled() {
        return "ingest_disabled".to_owned();
    }
    if error.is_unauthorized() {
        return "unauthorized".to_owned();
    }
    match error {
        SubmitError::Service { code, .. } => code.clone(),
        SubmitError::Transport(_) => "network_unavailable".to_owned(),
        SubmitError::Malformed { .. } => "malformed_response".to_owned(),
        SubmitError::Package(_) => "package_invalid".to_owned(),
        _ => "submission_failed".to_owned(),
    }
}

/// Mint an uploader grant from the installation proof.
///
/// No user interaction: the machine proves it is the installation it claims to
/// be with the key that also signs its packages, which is what lets a crash be
/// submitted without asking anyone to paste a token.
fn uploader_grant(
    connection: &DiagnosticConnectionInput,
    identity: &InstallationIdentity,
) -> Result<String, String> {
    exchange_installation_grant(
        &NativeTransport,
        &connection.target(),
        identity,
        chrono::Utc::now().timestamp(),
    )
    .map_err(|error| submit_error_code(&error))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Package and submit one local crash report.
///
/// Everything here is blocking — file IO, zip, network — so it runs on a
/// blocking task rather than occupying an async worker for the length of an
/// upload.
#[tauri::command]
pub async fn crash_submit_report(
    connection: DiagnosticConnectionInput,
    stem: String,
    consent: SubmissionConsentInput,
) -> Result<SubmissionOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || submit_blocking(connection, stem, consent))
        .await
        .map_err(|_| "submission_task_failed".to_owned())?
}

fn submit_blocking(
    connection: DiagnosticConnectionInput,
    stem: String,
    consent: SubmissionConsentInput,
) -> Result<SubmissionOutcome, String> {
    validate_stem(&stem)?;
    let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
    let identity = identity()?;
    let built = stage_package(&crash_dir, &stem, &consent, &identity)?;
    let grant = uploader_grant(&connection, &identity)?;

    let exception = report::read_normalized(&crash_dir, &stem)?
        .json
        .as_ref()
        .map(exception_for)
        .unwrap_or_else(|| "unknown".to_owned());

    let receipt = submit_package(
        &NativeTransport,
        &connection.target(),
        &grant,
        SubmissionRequest {
            package: &built.path,
            module: "cognia-desktop",
            exception: &exception,
        },
    )
    .map_err(|error| {
        // A package the submitter cannot read will not get better on retry;
        // drop it so the next attempt rebuilds. Every other failure keeps it,
        // which is what lets the retry resume the same incident.
        if matches!(error, SubmitError::Package(_) | SubmitError::Zip(_)) {
            let _ = discard_staged(&crash_dir, &stem);
        }
        submit_error_code(&error)
    })?;

    // A resumed submission keeps the credential stored the first time: the
    // service withholds it precisely because a second one could never verify.
    let previous = receipts::load(&crash_dir, &stem);
    let record = SubmissionRecord {
        incident_id: receipt.incident_id,
        support_code: receipt.support_code,
        client_state: receipt.client_state,
        processing_state: receipt.processing_state,
        service_url: connection.base_url.clone(),
        submitted_at: chrono::Utc::now().to_rfc3339(),
        deletion_credential: receipt.deletion_credential.or_else(|| {
            previous
                .as_ref()
                .and_then(|old| old.deletion_credential.clone())
        }),
        withdrawn_at: None,
        included_minidump: built.included_minidump,
        included_screenshot: built.included_screenshot,
    };
    receipts::save(&crash_dir, &stem, &record).map_err(|error| format!("receipt:{error}"))?;
    // Only now is the staged package redundant: the receipt is what a later
    // refresh, withdrawal or deletion addresses.
    if let Err(error) = discard_staged(&crash_dir, &stem) {
        log::warn!("crash: submitted package for {stem} could not be removed: {error}");
    }

    Ok(SubmissionOutcome {
        record,
        uploaded_parts: receipt.uploaded_parts,
        resumed_parts: receipt.resumed_parts,
        screenshot_unavailable: built.screenshot_unavailable,
    })
}

/// Every stored submission record, keyed by report stem.
#[tauri::command]
pub async fn crash_submission_records(
) -> Result<std::collections::BTreeMap<String, SubmissionRecord>, String> {
    let Some(dir) = crate::crash::crash_reports_dir() else {
        return Ok(Default::default());
    };
    Ok(receipts::load_all(&dir))
}

/// Re-read the service's receipt so the local state stops being a snapshot.
#[tauri::command]
pub async fn crash_refresh_submission(
    connection: DiagnosticConnectionInput,
    stem: String,
) -> Result<SubmissionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_stem(&stem)?;
        let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
        let mut record = receipts::load(&crash_dir, &stem).ok_or("submission_not_found")?;
        let grant = uploader_grant(&connection, &identity()?)?;
        let receipt = fetch_receipt(
            &NativeTransport,
            &connection.target(),
            &grant,
            &record.incident_id,
        )
        .map_err(|error| submit_error_code(&error))?;
        if let Some(state) = receipt.get("clientState").and_then(|v| v.as_str()) {
            record.client_state = state.to_owned();
        }
        if let Some(state) = receipt.get("processingState").and_then(|v| v.as_str()) {
            record.processing_state = state.to_owned();
        }
        if let Some(code) = receipt.get("supportCode").and_then(|v| v.as_str()) {
            record.support_code = code.to_owned();
        }
        receipts::save(&crash_dir, &stem, &record).map_err(|error| format!("receipt:{error}"))?;
        Ok(record)
    })
    .await
    .map_err(|_| "submission_task_failed".to_owned())?
}

/// Withdraw consent for a submitted report.
///
/// Blocks processing and schedules immediate deletion service-side. Kept
/// distinct from a plain delete because it is the route that stays available
/// while the service's intake switch is off — the one moment a withdrawal
/// matters most.
#[tauri::command]
pub async fn crash_withdraw_submission(
    connection: DiagnosticConnectionInput,
    stem: String,
) -> Result<SubmissionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_stem(&stem)?;
        let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
        let mut record = receipts::load(&crash_dir, &stem).ok_or("submission_not_found")?;
        let grant = uploader_grant(&connection, &identity()?)?;
        withdraw_consent(
            &NativeTransport,
            &connection.target(),
            &grant,
            &record.incident_id,
        )
        .map_err(|error| submit_error_code(&error))?;
        record.withdrawn_at = Some(chrono::Utc::now().to_rfc3339());
        record.client_state = "deleted".to_owned();
        record.processing_state = "deleted".to_owned();
        receipts::save(&crash_dir, &stem, &record).map_err(|error| format!("receipt:{error}"))?;
        Ok(record)
    })
    .await
    .map_err(|_| "submission_task_failed".to_owned())?
}

/// Delete one remote incident: with this installation's grant, falling back to
/// the incident's deletion credential when the grant cannot reach it.
///
/// The grant only reaches incidents this installation identity uploaded. After
/// a reinstall or a lost installation key the exchange fails or the service
/// answers `incident_not_found`; the credential stored with the receipt is the
/// one proof left. Without a credential the grant's error stands.
fn delete_remote_incident<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    grant: Result<String, String>,
    incident_id: &str,
    deletion_credential: Option<&str>,
) -> Result<(), String> {
    let grant_error = match grant {
        Ok(grant) => match delete_incident(transport, target, &grant, incident_id) {
            Ok(()) => return Ok(()),
            Err(error) if error.code() == Some("incident_not_found") => submit_error_code(&error),
            Err(error) => return Err(submit_error_code(&error)),
        },
        Err(error) => error,
    };
    let Some(credential) = deletion_credential else {
        return Err(grant_error);
    };
    delete_incident_with_credential(transport, target, incident_id, credential)
        .map_err(|error| submit_error_code(&error))
}

/// Delete the remote incident and forget the local record.
///
/// The local record is dropped only after the service confirms: forgetting it
/// first would strand an incident nothing on this machine can address again.
#[tauri::command]
pub async fn crash_delete_submission(
    connection: DiagnosticConnectionInput,
    stem: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_stem(&stem)?;
        let crash_dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
        let record = receipts::load(&crash_dir, &stem).ok_or("submission_not_found")?;
        let grant = identity().and_then(|identity| uploader_grant(&connection, &identity));
        delete_remote_incident(
            &NativeTransport,
            &connection.target(),
            grant,
            &record.incident_id,
            record.deletion_credential.as_deref(),
        )?;
        receipts::remove(&crash_dir, &stem).map_err(|error| format!("receipt:{error}"))?;
        Ok(())
    })
    .await
    .map_err(|_| "submission_task_failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Answers scripted responses in order and records method and URL.
    struct ScriptedTransport {
        responses: RefCell<Vec<(u16, &'static str)>>,
        seen: RefCell<Vec<(String, String)>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<(u16, &'static str)>) -> Self {
            Self {
                responses: RefCell::new(responses),
                seen: RefCell::new(Vec::new()),
            }
        }

        fn seen(&self) -> Vec<(String, String)> {
            self.seen.borrow().clone()
        }
    }

    impl DiagnosticTransport for ScriptedTransport {
        fn execute(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
            self.seen
                .borrow_mut()
                .push((request.method.to_owned(), request.url.clone()));
            let mut responses = self.responses.borrow_mut();
            if responses.is_empty() {
                return Err("unreachable".to_owned());
            }
            let (status, body) = responses.remove(0);
            Ok(HttpResponse {
                status,
                body: body.as_bytes().to_vec(),
            })
        }
    }

    fn delete_target() -> SubmissionTarget {
        SubmissionTarget::new("https://diag.test", "tenant", "project")
    }

    const NOT_FOUND: &str = r#"{"error":{"code":"incident_not_found"}}"#;

    #[test]
    fn the_installation_grant_deletes_when_it_reaches_the_incident() {
        let transport = ScriptedTransport::new(vec![(204, "")]);
        delete_remote_incident(
            &transport,
            &delete_target(),
            Ok("grant".to_owned()),
            "inc-1",
            Some("del_x"),
        )
        .unwrap();
        assert_eq!(
            transport.seen(),
            vec![(
                "DELETE".to_owned(),
                "https://diag.test/v1/incidents/inc-1".to_owned()
            )]
        );
    }

    #[test]
    fn a_new_installation_falls_back_to_the_deletion_credential() {
        let transport = ScriptedTransport::new(vec![(404, NOT_FOUND), (204, "")]);
        delete_remote_incident(
            &transport,
            &delete_target(),
            Ok("grant".to_owned()),
            "inc-1",
            Some("del_x"),
        )
        .unwrap();
        assert_eq!(
            transport.seen()[1],
            (
                "POST".to_owned(),
                "https://diag.test/v1/incidents/inc-1/delete-with-credential".to_owned()
            )
        );
    }

    #[test]
    fn a_failed_grant_exchange_still_deletes_with_the_credential() {
        let transport = ScriptedTransport::new(vec![(204, "")]);
        delete_remote_incident(
            &transport,
            &delete_target(),
            Err("identity:unreadable".to_owned()),
            "inc-1",
            Some("del_x"),
        )
        .unwrap();
        assert_eq!(transport.seen().len(), 1);
        assert_eq!(transport.seen()[0].0, "POST");
    }

    #[test]
    fn without_a_credential_the_grant_error_stands() {
        let transport = ScriptedTransport::new(vec![(404, NOT_FOUND)]);
        let error = delete_remote_incident(
            &transport,
            &delete_target(),
            Ok("grant".to_owned()),
            "inc-1",
            None,
        )
        .unwrap_err();
        assert_eq!(error, "incident_not_found");
        assert_eq!(
            delete_remote_incident(
                &ScriptedTransport::new(Vec::new()),
                &delete_target(),
                Err("identity:unreadable".to_owned()),
                "inc-1",
                None,
            )
            .unwrap_err(),
            "identity:unreadable"
        );
    }

    #[test]
    fn other_refusals_do_not_spend_the_credential() {
        // An intake or auth problem is not "this installation cannot see it";
        // retrying with the credential would only mask it.
        let transport =
            ScriptedTransport::new(vec![(503, r#"{"error":{"code":"ingest_disabled"}}"#)]);
        let error = delete_remote_incident(
            &transport,
            &delete_target(),
            Ok("grant".to_owned()),
            "inc-1",
            Some("del_x"),
        )
        .unwrap_err();
        assert_eq!(error, "ingest_disabled");
        assert_eq!(transport.seen().len(), 1);
    }

    #[test]
    fn screenshot_is_skipped_without_a_capture_backend_or_when_it_refuses() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(capture_screenshot_with(None, dir.path()), None);

        fn refuses() -> Option<Vec<u8>> {
            None
        }
        assert_eq!(capture_screenshot_with(Some(refuses), dir.path()), None);
        assert!(!dir.path().join("screenshot.png").exists());
    }

    #[test]
    fn screenshot_bytes_from_the_backend_land_as_screenshot_png() {
        let dir = tempfile::tempdir().unwrap();
        fn png() -> Option<Vec<u8>> {
            Some(b"\x89PNG fake".to_vec())
        }
        let path = capture_screenshot_with(Some(png), dir.path()).expect("written");
        assert_eq!(path, dir.path().join("screenshot.png"));
        assert_eq!(std::fs::read(path).unwrap(), b"\x89PNG fake");
    }

    #[test]
    fn rejects_report_stems_that_could_escape_the_crash_directory() {
        assert!(validate_stem("crash-2026-05-25_14-30-00-panic").is_ok());
        for invalid in ["", "../secrets", "a/b", "a\\b", "C:x"] {
            assert!(validate_stem(invalid).is_err(), "{invalid} must be refused");
        }
    }

    #[test]
    fn a_backtrace_becomes_frames_the_service_can_group_on() {
        let backtrace = "\
   0: cognia_next::crash::panic_hook::install::{{closure}}
             at /src/crash/panic_hook.rs:31:9
   1: core::panicking::panic_fmt
   2: cognia_next::workflow::run

";
        assert_eq!(
            backtrace_frames(backtrace),
            vec![
                "cognia_next::crash::panic_hook::install::{{closure}}",
                "core::panicking::panic_fmt",
                "cognia_next::workflow::run",
            ]
        );
    }

    #[test]
    fn frame_extraction_is_bounded_and_survives_unnumbered_output() {
        let numbered = (0..200)
            .map(|index| format!("  {index}: frame::{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(backtrace_frames(&numbered).len(), MAX_BACKTRACE_FRAMES);
        // A backtrace captured without indices still yields frames rather than
        // collapsing to nothing.
        assert_eq!(
            backtrace_frames("frame_one\nframe_two"),
            vec!["frame_one", "frame_two"]
        );
        assert!(backtrace_frames("").is_empty());
    }

    #[test]
    fn the_event_carries_frames_under_a_key_the_service_looks_for() {
        let report = serde_json::json!({
            "kind": "panic",
            "capturedAt": "2026-08-20T00:00:00Z",
            "message": "boom",
            "location": "src/lib.rs:1",
            "backtrace": "  0: alpha\n  1: beta",
        });
        let events = events_for(&report);
        assert_eq!(events.len(), 1);
        // `stackFrames` is one of the four keys `find_frame_value` searches;
        // the raw `backtrace` string is not, which is why it is reshaped.
        assert_eq!(
            events[0]["stackFrames"],
            serde_json::json!(["alpha", "beta"])
        );
        assert_eq!(events[0]["kind"], serde_json::json!("crash"));
        // The untouched report rides along for a human reading the package.
        assert_eq!(events[0]["report"]["message"], serde_json::json!("boom"));
    }

    #[test]
    fn a_report_without_a_backtrace_still_produces_one_event() {
        let events = events_for(&serde_json::json!({"kind": "native", "message": "sigsegv"}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["stackFrames"], serde_json::json!([]));
    }

    #[test]
    fn build_identity_separates_architectures_of_the_same_release() {
        let intel =
            serde_json::json!({"system": {"arch": "x86_64"}, "extra": {"appVersion": "1.2.3"}});
        let arm =
            serde_json::json!({"system": {"arch": "aarch64"}, "extra": {"appVersion": "1.2.3"}});
        assert_eq!(build_id(&intel), "1.2.3-x86_64");
        assert_ne!(build_id(&intel), build_id(&arm));
        // A report missing the fields still yields something groupable.
        assert!(!build_id(&serde_json::Value::Null).is_empty());
        assert_eq!(
            exception_for(&serde_json::json!({"kind": "panic"})),
            "panic"
        );
        assert_eq!(exception_for(&serde_json::Value::Null), "unknown");
    }

    #[test]
    fn platform_label_prefers_the_captured_family_over_the_building_host() {
        assert_eq!(
            platform_label(&serde_json::json!({"system": {"family": "windows"}})),
            "windows"
        );
        assert_eq!(
            platform_label(&serde_json::Value::Null),
            std::env::consts::OS
        );
    }

    #[test]
    fn failures_become_codes_the_ui_can_translate_rather_than_service_prose() {
        assert_eq!(
            submit_error_code(&SubmitError::Service {
                status: 503,
                code: "ingest_disabled".to_owned()
            }),
            "ingest_disabled"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Service {
                status: 401,
                code: "invalid_upload_grant".to_owned()
            }),
            "unauthorized"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Service {
                status: 413,
                code: "IncidentTooLarge".to_owned()
            }),
            "IncidentTooLarge"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Transport("dns".to_owned())),
            "network_unavailable"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Malformed { status: 502 }),
            "malformed_response"
        );
        assert_eq!(
            submit_error_code(&SubmitError::Invalid("no id")),
            "submission_failed"
        );
    }

    #[test]
    fn a_connection_target_tolerates_a_trailing_slash_from_the_settings_field() {
        let connection = DiagnosticConnectionInput {
            base_url: "https://diag.example.com/".to_owned(),
            tenant_id: "tenant".to_owned(),
            project_id: "project".to_owned(),
        };
        assert_eq!(connection.target().base_url, "https://diag.example.com");
    }

    #[test]
    fn packaging_carries_the_report_and_honours_each_consent_flag() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-00-panic";
        std::fs::write(
            crash_dir.path().join(format!("{stem}.json")),
            serde_json::to_vec(&serde_json::json!({
                "kind": "panic",
                "message": "boom",
                "backtrace": "  0: alpha",
                "system": {"arch": "x86_64", "family": "macos"},
                "extra": {"appVersion": "9.9.9"},
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(crash_dir.path().join(format!("{stem}.txt")), b"human text").unwrap();
        std::fs::write(crash_dir.path().join(format!("{stem}.dmp")), b"MDMP").unwrap();

        let identity = InstallationIdentity::from_seed(&[3_u8; 32]);

        // Minidump withheld by default.
        let out = tempfile::tempdir().unwrap();
        let without = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput::default(),
            &identity,
            out.path(),
        )
        .unwrap();
        assert!(!without.included_minidump);
        let (_, parts) = crate::read_package_parts(&without.path).unwrap();
        let kinds: Vec<&str> = parts.iter().map(|part| part.artifact_kind).collect();
        assert_eq!(kinds, vec!["manifest", "events", "attachment"]);

        // …and included only when the user says so.
        let out = tempfile::tempdir().unwrap();
        let with = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput {
                include_minidump: true,
                include_screenshot: false,
                description: Some("  ".to_owned()),
            },
            &identity,
            out.path(),
        )
        .unwrap();
        assert!(with.included_minidump);
        let (_, parts) = crate::read_package_parts(&with.path).unwrap();
        let kinds: Vec<&str> = parts.iter().map(|part| part.artifact_kind).collect();
        // A whitespace-only description contributes nothing rather than an
        // empty attachment.
        assert_eq!(kinds, vec!["manifest", "events", "attachment", "minidump"]);
    }

    #[test]
    fn a_typed_description_becomes_its_own_scannable_attachment() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-desc";
        std::fs::write(
            crash_dir.path().join(format!("{stem}.json")),
            br#"{"kind":"panic","message":"boom"}"#,
        )
        .unwrap();
        let identity = InstallationIdentity::from_seed(&[4_u8; 32]);
        let out = tempfile::tempdir().unwrap();
        let built = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput {
                include_minidump: false,
                include_screenshot: false,
                description: Some("I was exporting a workflow".to_owned()),
            },
            &identity,
            out.path(),
        )
        .unwrap();
        let (manifest, _) = crate::read_package_parts(&built.path).unwrap();
        assert!(manifest
            .inventory()
            .iter()
            .any(|entry| entry.path == "attachments/description.txt"));
    }

    #[test]
    fn packaging_refuses_a_report_that_is_not_there() {
        let crash_dir = tempfile::tempdir().unwrap();
        let identity = InstallationIdentity::from_seed(&[5_u8; 32]);
        let out = tempfile::tempdir().unwrap();
        let error = build_package(
            crash_dir.path(),
            "crash-missing",
            &SubmissionConsentInput::default(),
            &identity,
            out.path(),
        )
        .unwrap_err();
        assert_eq!(error, "report_not_found");
    }

    /// An unscrubbed report, as an older build would have left it on disk.
    fn write_sensitive_report(crash_dir: &Path, stem: &str) {
        std::fs::write(
            crash_dir.join(format!("{stem}.json")),
            serde_json::to_vec(&serde_json::json!({
                "kind": "panic",
                "message": "failed for jane.doe@example.com on jane-workstation",
                "backtrace": "  0: alpha\n      at /Users/someone-else/src/a.rs:1\n  1: key AKIAABCDEFGHIJKLMNOP",
                "system": {"arch": "x86_64", "family": "macos", "hostname": "jane-workstation"},
                "extra": {"appVersion": "9.9.9"},
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            crash_dir.join(format!("{stem}.txt")),
            "Host: jane-workstation\nDescription: failed for jane.doe@example.com",
        )
        .unwrap();
    }

    fn decoded_events(package: &Path) -> String {
        let (_, parts) = crate::read_package_parts(package).unwrap();
        let events = parts
            .iter()
            .find(|part| part.artifact_kind == "events")
            .unwrap();
        String::from_utf8(zstd::stream::decode_all(events.bytes.as_slice()).unwrap()).unwrap()
    }

    fn all_text_parts(package: &Path) -> Vec<String> {
        let (_, parts) = crate::read_package_parts(package).unwrap();
        let mut texts = vec![decoded_events(package)];
        texts.extend(
            parts
                .iter()
                .filter(|part| part.artifact_kind == "attachment")
                .map(|part| String::from_utf8_lossy(&part.bytes).into_owned()),
        );
        texts
    }

    #[test]
    fn the_compressed_events_and_every_text_part_are_scrubbed_before_packaging() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-00-panic";
        write_sensitive_report(crash_dir.path(), stem);
        let identity = InstallationIdentity::from_seed(&[6_u8; 32]);
        let out = tempfile::tempdir().unwrap();
        let built = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput {
                include_minidump: false,
                include_screenshot: false,
                description: Some(
                    "mail me at jane.doe@example.com, token Bearer abc.def".to_owned(),
                ),
            },
            &identity,
            out.path(),
        )
        .unwrap();
        for text in all_text_parts(&built.path) {
            for leaked in [
                "jane.doe@example.com",
                "jane-workstation",
                "someone-else",
                "AKIAABCDEFGHIJKLMNOP",
                "abc.def",
            ] {
                assert!(!text.contains(leaked), "{leaked} leaked into {text}");
            }
        }
        // Loose copies do not outlive the package.
        let leftovers: Vec<_> = std::fs::read_dir(out.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec![STAGED_PACKAGE.to_owned()]);
    }

    #[test]
    fn the_preview_and_the_package_carry_the_same_report_text() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-01-panic";
        write_sensitive_report(crash_dir.path(), stem);
        let preview = report::read_normalized(crash_dir.path(), stem)
            .unwrap()
            .preview()
            .unwrap();
        let out = tempfile::tempdir().unwrap();
        let built = build_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput::default(),
            &InstallationIdentity::from_seed(&[7_u8; 32]),
            out.path(),
        )
        .unwrap();
        let (_, parts) = crate::read_package_parts(&built.path).unwrap();
        let attached = parts
            .iter()
            .find(|part| part.artifact_kind == "attachment")
            .map(|part| String::from_utf8(part.bytes.clone()).unwrap())
            .unwrap();
        assert_eq!(attached, preview);
    }

    #[test]
    fn a_text_the_scrubber_cannot_make_clean_is_refused() {
        // A scrubber is a fixed point on its own output, so the only way to
        // reach the refusal is a value it does not touch: the check walks every
        // event string, so prove the walk sees nested values.
        let scrubber = CrashScrubber::new(None, Vec::<String>::new());
        assert!(!value_is_clean(
            &scrubber,
            &serde_json::json!({"a": [{"b": "jane.doe@example.com"}]})
        ));
        assert!(value_is_clean(
            &scrubber,
            &serde_json::json!({"a": [1, "ok"]})
        ));
    }

    #[test]
    fn a_retry_reuses_the_staged_package_so_the_incident_resumes() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-02-panic";
        write_sensitive_report(crash_dir.path(), stem);
        let identity = InstallationIdentity::from_seed(&[8_u8; 32]);
        let consent = SubmissionConsentInput {
            include_minidump: false,
            include_screenshot: false,
            description: Some("same words".to_owned()),
        };

        let first = stage_package(crash_dir.path(), stem, &consent, &identity).unwrap();
        let first_bytes = std::fs::read(&first.path).unwrap();
        let second = stage_package(crash_dir.path(), stem, &consent, &identity).unwrap();
        assert_eq!(std::fs::read(&second.path).unwrap(), first_bytes);
        let (manifest_a, _) = crate::read_package_parts(&first.path).unwrap();
        let (manifest_b, _) = crate::read_package_parts(&second.path).unwrap();
        assert_eq!(manifest_a.incident_id(), manifest_b.incident_id());

        // Different consent is a different package.
        let changed = SubmissionConsentInput {
            description: Some("other words".to_owned()),
            ..consent.clone()
        };
        let third = stage_package(crash_dir.path(), stem, &changed, &identity).unwrap();
        assert_ne!(std::fs::read(&third.path).unwrap(), first_bytes);

        // So is another installation identity.
        let other = InstallationIdentity::from_seed(&[9_u8; 32]);
        let fourth = stage_package(crash_dir.path(), stem, &changed, &other).unwrap();
        let (manifest_d, _) = crate::read_package_parts(&fourth.path).unwrap();
        assert_ne!(manifest_d.incident_id(), manifest_a.incident_id());
    }

    #[test]
    fn an_interrupted_build_is_rebuilt_not_reused() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-03-panic";
        write_sensitive_report(crash_dir.path(), stem);
        let identity = InstallationIdentity::from_seed(&[10_u8; 32]);
        let consent = SubmissionConsentInput::default();
        let first = stage_package(crash_dir.path(), stem, &consent, &identity).unwrap();
        // A package without its state file is what a crash mid-build leaves.
        std::fs::remove_file(staged_dir(crash_dir.path(), stem).join(STAGED_STATE)).unwrap();
        let (before, _) = crate::read_package_parts(&first.path).unwrap();
        let rebuilt = stage_package(crash_dir.path(), stem, &consent, &identity).unwrap();
        let (after, _) = crate::read_package_parts(&rebuilt.path).unwrap();
        assert_ne!(before.incident_id(), after.incident_id());
    }

    #[test]
    fn staged_packages_are_discarded_with_their_report() {
        let crash_dir = tempfile::tempdir().unwrap();
        let stem = "crash-2026-08-20_00-00-04-panic";
        write_sensitive_report(crash_dir.path(), stem);
        let identity = InstallationIdentity::from_seed(&[11_u8; 32]);
        stage_package(
            crash_dir.path(),
            stem,
            &SubmissionConsentInput::default(),
            &identity,
        )
        .unwrap();
        assert!(staged_dir(crash_dir.path(), stem).is_dir());

        let live = std::collections::BTreeSet::from([stem.to_owned()]);
        assert_eq!(discard_orphan_staged(crash_dir.path(), &live), 0);
        assert_eq!(
            discard_orphan_staged(crash_dir.path(), &Default::default()),
            1
        );
        assert!(!staged_dir(crash_dir.path(), stem).exists());
        // Discarding what is already gone is not an error.
        discard_staged(crash_dir.path(), stem).unwrap();
    }
}
