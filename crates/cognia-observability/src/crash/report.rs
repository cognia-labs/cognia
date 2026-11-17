//! The crash report itself — MC-style human-readable `.txt` plus a structured
//! `.json` sidecar. Shared by the panic hook (in-process) and the crash
//! monitor (out-of-process), so both capture paths produce identical layouts.

use crate::crash::context::ContextSnapshot;
use crate::crash::system_info::{self, SystemDetails};
use crate::crash_privacy::CrashScrubber;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Envelope the app process ships to the out-of-process monitor via
/// `KIND_META`, so a later native crash can be rendered with the same context
/// and application state the in-process panic path would have used. The monitor
/// supplies `system` itself (same machine), so it isn't carried here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorMeta {
    pub context: ContextSnapshot,
    pub extra: serde_json::Value,
}

/// App-only extras the monitor can't compute for itself: native-logging
/// readiness and the resolved data/log/crash-report directories. Called in the
/// app process (panic hook + client-meta sender), never in the monitor.
pub fn app_extra() -> serde_json::Value {
    let log_dir = dirs::data_local_dir().map(|d| {
        d.join(super::APP_DIR_NAME)
            .join("logs")
            .to_string_lossy()
            .to_string()
    });
    serde_json::json!({
        "nativeLogging": crate::logging::native_bootstrap::get_native_logging_readiness(),
        "crashReportsDir": super::crash_reports_dir().map(|d| d.to_string_lossy().to_string()),
        "logDir": log_dir,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashKind {
    Panic,
    Native,
}

impl CrashKind {
    fn label(self) -> &'static str {
        match self {
            CrashKind::Panic => "panic",
            CrashKind::Native => "native",
        }
    }

    fn human(self) -> &'static str {
        match self {
            CrashKind::Panic => "Rust panic",
            CrashKind::Native => "Native crash (minidump)",
        }
    }
}

/// A fully-assembled crash report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub kind: CrashKind,
    pub captured_at: String,
    pub thread: Option<String>,
    pub message: String,
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backtrace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dump_path: Option<String>,
    pub system: SystemDetails,
    pub context: ContextSnapshot,
    /// App-only extras (native-logging readiness, data-dir paths) the monitor
    /// can't compute for itself — supplied by the app process.
    pub extra: serde_json::Value,
}

/// Where both report files landed.
#[derive(Debug, Clone)]
pub struct WrittenReport {
    pub stem: String,
    pub txt_path: PathBuf,
    pub json_path: PathBuf,
}

impl WrittenReport {
    /// Compact payload for the `crash://captured` webview event.
    pub fn summary_json(&self) -> serde_json::Value {
        serde_json::json!({
            "stem": self.stem,
            "txtPath": self.txt_path.to_string_lossy(),
            "jsonPath": self.json_path.to_string_lossy(),
        })
    }
}

/// Every report stem starts with this; anything else in the crash directory
/// (the `submissions.json` receipt store, staged packages) is not a report.
pub const REPORT_STEM_PREFIX: &str = "crash-";

/// Whether a file stem names a crash report rather than a sidecar that shares
/// the directory.
pub fn is_report_stem(stem: &str) -> bool {
    stem.starts_with(REPORT_STEM_PREFIX)
}

/// A filename-safe, timestamped, collision-safe stem like
/// `crash-2026-05-25_14-30-00-123-9f3a1c2e-panic`.
///
/// The leading 19 timestamp characters stay fixed-width (retention parses
/// them and listings sort on them); milliseconds plus a random suffix keep two
/// reports captured in the same second from sharing a stem. Second-resolution
/// stems used to let a second caught panic overwrite the first one's files.
pub fn timestamped_stem(kind: CrashKind) -> String {
    let now = chrono::Local::now();
    let ts = now.format("%Y-%m-%d_%H-%M-%S-%3f");
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    format!("{REPORT_STEM_PREFIX}{ts}-{}-{}", &nonce[..8], kind.label())
}

/// Create a file that must not exist yet. A report is evidence: a name clash
/// is an error to surface, never a reason to replace an earlier report.
pub fn create_new_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = create_new_file(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Deterministic-but-varied banner line (MC flavour) — keyed off the timestamp
/// so a given report is stable across renders but reports differ over time.
fn banner_line(seed: &str) -> &'static str {
    const LINES: [&str; 8] = [
        "// Oops. Something went sideways.",
        "// Don't panic. (We already did.)",
        "// This wasn't supposed to happen.",
        "// We're sorry about that.",
        "// Well, that escalated quickly.",
        "// Saving what we could before the lights went out.",
        "// Here's everything we know.",
        "// Take a deep breath — the logs are below.",
    ];
    let idx = seed.bytes().fold(0u32, |acc, b| acc.wrapping_add(b as u32)) as usize % LINES.len();
    LINES[idx]
}

fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

impl CrashReport {
    /// Render the Minecraft-style human-readable report.
    pub fn render_txt(&self) -> String {
        let mut out = String::with_capacity(2048);
        out.push_str("---- Cognia Crash Report ----\n");
        out.push_str(banner_line(&self.captured_at));
        out.push_str("\n\n");

        out.push_str(&format!("Time: {}\n", self.captured_at));
        out.push_str(&format!("Kind: {}\n", self.kind.human()));
        if let Some(thread) = &self.thread {
            out.push_str(&format!("Thread: {thread}\n"));
        }
        out.push_str(&format!("Description: {}\n", self.message));
        if let Some(loc) = &self.location {
            out.push_str(&format!("Location: {loc}\n"));
        }
        if let Some(dump) = &self.dump_path {
            out.push_str(&format!("Minidump: {dump}\n"));
        }

        if let Some(bt) = &self.backtrace {
            out.push_str("\n-- Backtrace --\n");
            out.push_str(bt);
            if !bt.ends_with('\n') {
                out.push('\n');
            }
        }

        out.push_str("\n-- System Details --\n");
        let s = &self.system;
        out.push_str(&format!("Cognia Version: {}\n", s.app_version));
        out.push_str(&format!("Tauri Version: {}\n", s.tauri_version));
        out.push_str(&format!("Build Profile: {}\n", s.profile));
        let features = if s.enabled_features.is_empty() {
            "none".to_string()
        } else {
            s.enabled_features.join(", ")
        };
        out.push_str(&format!("Enabled Features: {features}\n"));
        out.push_str(&format!(
            "Operating System: {} ({}) version {}\n",
            s.os,
            s.arch,
            s.os_version.as_deref().unwrap_or("unknown")
        ));
        out.push_str(&format!(
            "Kernel: {}\n",
            s.kernel_version.as_deref().unwrap_or("unknown")
        ));
        out.push_str(&format!("Family: {}\n", s.family));
        if let Some(host) = &s.hostname {
            out.push_str(&format!("Host: {host}\n"));
        }
        out.push_str(&format!(
            "CPU: {} ({} cores)\n",
            s.cpu.as_deref().unwrap_or("unknown"),
            s.cpu_count
        ));
        out.push_str(&format!(
            "Memory: {}\n",
            system_info::format_memory(s.used_memory_bytes, s.total_memory_bytes)
        ));

        if !self.extra.is_null() {
            out.push_str("\n-- Application State --\n");
            out.push_str(&pretty(&self.extra));
            out.push('\n');
        }

        if !self.context.config.is_null() {
            out.push_str("\n-- Configuration (redacted) --\n");
            out.push_str(&pretty(&self.context.config));
            out.push('\n');
        }

        if !self.context.breadcrumbs.is_empty() {
            out.push_str("\n-- Breadcrumbs --\n");
            for crumb in &self.context.breadcrumbs {
                out.push_str(&format!(
                    "[{}] {}: {}\n",
                    crumb.at, crumb.level, crumb.message
                ));
            }
        }

        out
    }

    /// Structured sidecar — mirrors the frontend `NativeCrashReport` type.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    /// The report with every free-text field scrubbed and the hostname
    /// dropped (see [`crate::crash_privacy`]).
    pub fn scrubbed(&self, scrubber: &CrashScrubber) -> CrashReport {
        let text = |value: &Option<String>| value.as_deref().map(|v| scrubber.scrub_text(v));
        let mut report = self.clone();
        report.thread = text(&self.thread);
        report.message = scrubber.scrub_text(&self.message);
        report.location = text(&self.location);
        report.backtrace = text(&self.backtrace);
        report.dump_path = text(&self.dump_path);
        report.system.hostname = None;
        report.context.config = scrubber.scrub_value(&self.context.config);
        for crumb in &mut report.context.breadcrumbs {
            crumb.message = scrubber.scrub_text(&crumb.message);
        }
        report.extra = scrubber.scrub_value(&self.extra);
        report
    }

    /// The scrubber for a report captured on this machine.
    pub fn local_scrubber(&self) -> CrashScrubber {
        CrashScrubber::new(dirs::home_dir().as_deref(), self.system.hostname.clone())
    }

    /// Write `<stem>.json` and `<stem>.txt` into `dir`, scrubbed.
    ///
    /// The privacy gate is not optional here for the same reason it is not
    /// optional for the event spool: the report is a durable artifact, and the
    /// preview and the upload both start from it. Both files are created with
    /// create-new semantics, so an existing report is never overwritten.
    ///
    /// The JSON (the structured half submission reads) is written first. If
    /// the text half then fails, the error names it and the JSON stays on disk
    /// as evidence; listings already report each half separately.
    pub fn write_to(&self, dir: &Path, stem: &str) -> io::Result<WrittenReport> {
        self.write_scrubbed_to(dir, stem, &self.local_scrubber())
    }

    fn write_scrubbed_to(
        &self,
        dir: &Path,
        stem: &str,
        scrubber: &CrashScrubber,
    ) -> io::Result<WrittenReport> {
        fs::create_dir_all(dir)?;
        let clean = self.scrubbed(scrubber);
        let txt_path = dir.join(format!("{stem}.txt"));
        let json_path = dir.join(format!("{stem}.json"));
        write_new(&json_path, pretty(&clean.to_json()).as_bytes()).map_err(|error| {
            io::Error::new(error.kind(), format!("{}: {error}", json_path.display()))
        })?;
        write_new(&txt_path, clean.render_txt().as_bytes()).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "{}: {error} (the JSON half was written; the report is incomplete)",
                    txt_path.display()
                ),
            )
        })?;
        Ok(WrittenReport {
            stem: stem.to_string(),
            txt_path,
            json_path,
        })
    }
}

/// A report as it may be shown or sent: read from disk and normalized through
/// the scrubber, so the preview and the package are the same bytes even for a
/// report written before write-time scrubbing existed.
#[derive(Debug, Clone)]
pub struct NormalizedReport {
    pub json: Option<serde_json::Value>,
    pub txt: Option<String>,
    pub scrubber: CrashScrubber,
}

impl NormalizedReport {
    /// What the preview renders: the text report, or the JSON when there is
    /// no text half.
    pub fn preview(&self) -> Option<String> {
        self.txt.clone().or_else(|| self.json.as_ref().map(pretty))
    }
}

/// Read and normalize one report. `Err("report_not_found")` when neither half
/// exists; a half that exists but cannot be read is an error, not an absence.
pub fn read_normalized(dir: &Path, stem: &str) -> Result<NormalizedReport, String> {
    let json_path = dir.join(format!("{stem}.json"));
    let txt_path = dir.join(format!("{stem}.txt"));
    let raw_json = if json_path.exists() {
        let bytes = fs::read(&json_path).map_err(|error| format!("read_failed:{error}"))?;
        Some(
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| "report_unreadable".to_owned())?,
        )
    } else {
        None
    };
    let raw_txt = if txt_path.exists() {
        Some(fs::read_to_string(&txt_path).map_err(|error| format!("read_failed:{error}"))?)
    } else {
        None
    };
    if raw_json.is_none() && raw_txt.is_none() {
        return Err("report_not_found".to_owned());
    }
    let scrubber = raw_json
        .as_ref()
        .map(CrashScrubber::for_report)
        .unwrap_or_else(|| CrashScrubber::new(dirs::home_dir().as_deref(), None));
    Ok(NormalizedReport {
        json: raw_json.as_ref().map(|json| scrubber.scrub_report(json)),
        txt: raw_txt.as_deref().map(|txt| scrubber.scrub_text(txt)),
        scrubber,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crash::context::Breadcrumb;

    fn sample_system() -> SystemDetails {
        SystemDetails {
            os: "Windows".to_string(),
            os_version: Some("11".to_string()),
            kernel_version: Some("26200".to_string()),
            arch: "x86_64".to_string(),
            family: "windows".to_string(),
            hostname: Some("test-host".to_string()),
            cpu: Some("Test CPU".to_string()),
            cpu_count: 8,
            total_memory_bytes: 16 * 1024 * 1024 * 1024,
            used_memory_bytes: 8 * 1024 * 1024 * 1024,
            app_version: "0.1.0".to_string(),
            tauri_version: "2.0.0".to_string(),
            profile: "debug",
            enabled_features: vec!["ocr-windows".to_string()],
        }
    }

    fn sample_report() -> CrashReport {
        CrashReport {
            kind: CrashKind::Panic,
            captured_at: "2026-05-25T14:30:00+00:00".to_string(),
            thread: Some("main".to_string()),
            message: "boom".to_string(),
            location: Some("src/lib.rs:42:1".to_string()),
            backtrace: Some("0: do_thing\n1: main".to_string()),
            dump_path: None,
            system: sample_system(),
            context: ContextSnapshot {
                config: serde_json::json!({ "theme": "dark" }),
                breadcrumbs: vec![Breadcrumb {
                    at: "2026-05-25T14:29:00Z".to_string(),
                    level: "info".to_string(),
                    message: "opened settings".to_string(),
                }],
            },
            extra: serde_json::json!({ "nativeLogging": "healthy" }),
        }
    }

    #[test]
    fn render_txt_contains_all_sections() {
        let txt = sample_report().render_txt();
        assert!(txt.contains("---- Cognia Crash Report ----"));
        assert!(txt.contains("Kind: Rust panic"));
        assert!(txt.contains("Description: boom"));
        assert!(txt.contains("Location: src/lib.rs:42:1"));
        assert!(txt.contains("-- Backtrace --"));
        assert!(txt.contains("-- System Details --"));
        assert!(txt.contains("Cognia Version: 0.1.0"));
        assert!(txt.contains("Enabled Features: ocr-windows"));
        assert!(txt.contains("Memory: 8192 MiB / 16384 MiB"));
        assert!(txt.contains("-- Configuration (redacted) --"));
        assert!(txt.contains("-- Breadcrumbs --"));
        assert!(txt.contains("opened settings"));
    }

    #[test]
    fn native_kind_shows_minidump_not_backtrace() {
        let mut report = sample_report();
        report.kind = CrashKind::Native;
        report.backtrace = None;
        report.dump_path = Some("C:/x/crash.dmp".to_string());
        let txt = report.render_txt();
        assert!(txt.contains("Kind: Native crash (minidump)"));
        assert!(txt.contains("Minidump: C:/x/crash.dmp"));
        assert!(!txt.contains("-- Backtrace --"));
    }

    #[test]
    fn to_json_roundtrips_key_fields() {
        let json = sample_report().to_json();
        assert_eq!(json["kind"], "panic");
        assert_eq!(json["message"], "boom");
        assert_eq!(json["system"]["appVersion"], "0.1.0");
        assert_eq!(json["context"]["config"]["theme"], "dark");
    }

    fn jane() -> CrashScrubber {
        CrashScrubber::new(Some(Path::new("/Users/jane")), ["test-host".to_string()])
    }

    fn sensitive_report() -> CrashReport {
        let mut report = sample_report();
        report.message = "failed to open /Users/jane/secret.md for jane@example.com".to_string();
        report.location = Some("/Users/jane/.cargo/registry/src/x/lib.rs:1:1".to_string());
        report.backtrace =
            Some("0: x\n   at /Users/jane/src/main.rs:3\nhost test-host".to_string());
        report.context.breadcrumbs[0].message = "token Bearer abc.def".to_string();
        report.extra = serde_json::json!({ "logDir": "/Users/jane/Library/Logs" });
        report
    }

    #[test]
    fn write_to_produces_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let written = sample_report()
            .write_scrubbed_to(dir.path(), "crash-test-panic", &jane())
            .unwrap();
        assert!(written.txt_path.exists());
        assert!(written.json_path.exists());
        let txt = std::fs::read_to_string(&written.txt_path).unwrap();
        assert!(txt.contains("Description: boom"));
    }

    #[test]
    fn written_reports_are_scrubbed_and_carry_no_hostname() {
        let dir = tempfile::tempdir().unwrap();
        let written = sensitive_report()
            .write_scrubbed_to(dir.path(), "crash-scrub-panic", &jane())
            .unwrap();
        for path in [&written.txt_path, &written.json_path] {
            let text = std::fs::read_to_string(path).unwrap();
            assert!(!text.contains("jane"), "{}: {text}", path.display());
            assert!(!text.contains("test-host"), "{}: {text}", path.display());
            assert!(!text.contains("abc.def"), "{}: {text}", path.display());
            assert!(jane().is_clean(&text), "{}", path.display());
        }
        let txt = std::fs::read_to_string(&written.txt_path).unwrap();
        assert!(txt.contains("~/.cargo/registry/src/x/lib.rs:1:1"), "{txt}");
        assert!(!txt.contains("Host:"), "{txt}");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&written.json_path).unwrap()).unwrap();
        assert_eq!(json["system"]["hostname"], serde_json::Value::Null);
    }

    #[test]
    fn an_existing_report_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        sample_report()
            .write_scrubbed_to(dir.path(), "crash-same-panic", &jane())
            .unwrap();
        let mut second = sample_report();
        second.message = "second".to_string();
        let error = second
            .write_scrubbed_to(dir.path(), "crash-same-panic", &jane())
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        let txt = std::fs::read_to_string(dir.path().join("crash-same-panic.txt")).unwrap();
        assert!(txt.contains("Description: boom"), "first report survives");
    }

    #[test]
    fn a_failed_text_half_is_reported_rather_than_silent() {
        let dir = tempfile::tempdir().unwrap();
        // A directory squatting on the text path makes only that half fail.
        std::fs::create_dir(dir.path().join("crash-half-panic.txt")).unwrap();
        let error = sample_report()
            .write_scrubbed_to(dir.path(), "crash-half-panic", &jane())
            .unwrap_err();
        assert!(error.to_string().contains("incomplete"), "{error}");
        assert!(dir.path().join("crash-half-panic.json").is_file());
    }

    #[test]
    fn timestamped_stem_is_filename_safe() {
        let stem = timestamped_stem(CrashKind::Panic);
        assert!(stem.starts_with("crash-"));
        assert!(is_report_stem(&stem));
        assert!(stem.ends_with("-panic"));
        assert!(!stem.contains(':'));
        assert!(!stem.contains(' '));
        // Retention and listings read the fixed-width second timestamp.
        assert!(chrono::NaiveDateTime::parse_from_str(&stem[6..25], "%Y-%m-%d_%H-%M-%S").is_ok());
    }

    #[test]
    fn stems_captured_in_the_same_second_differ() {
        let stems: std::collections::BTreeSet<String> = (0..64)
            .map(|_| timestamped_stem(CrashKind::Panic))
            .collect();
        assert_eq!(stems.len(), 64);
    }

    #[test]
    fn sidecars_in_the_crash_directory_are_not_report_stems() {
        assert!(!is_report_stem("submissions"));
        assert!(is_report_stem("crash-2026-05-25_00-00-00-panic"));
    }

    #[test]
    fn a_report_written_before_scrubbing_is_normalized_on_read() {
        let dir = tempfile::tempdir().unwrap();
        // Simulate an older, unscrubbed report on disk.
        let raw = sensitive_report();
        std::fs::write(dir.path().join("crash-old-panic.txt"), raw.render_txt()).unwrap();
        std::fs::write(
            dir.path().join("crash-old-panic.json"),
            serde_json::to_vec(&raw.to_json()).unwrap(),
        )
        .unwrap();
        let normalized = read_normalized(dir.path(), "crash-old-panic").unwrap();
        let preview = normalized.preview().unwrap();
        assert!(!preview.contains("test-host"), "{preview}");
        assert!(!preview.contains("jane@example.com"), "{preview}");
        let json = normalized.json.unwrap();
        assert_eq!(json["system"]["hostname"], serde_json::Value::Null);
        assert!(!json.to_string().contains("test-host"));
    }

    #[test]
    fn reading_a_missing_report_says_so() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_normalized(dir.path(), "crash-none-panic").unwrap_err(),
            "report_not_found"
        );
    }
}
