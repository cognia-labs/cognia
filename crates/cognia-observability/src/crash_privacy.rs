//! Client-side scrubbing for crash reports before they are written, previewed
//! or packaged.
//!
//! A crash report is not a V1 event, so [`crate::privacy::apply_observability_privacy`]
//! never sees it, yet it carries the most identifying text the app produces: a
//! raw panic message, a backtrace full of home-directory paths, the machine's
//! hostname, and whatever the user typed into the description box. The
//! service scans uploads too, but it cannot scan inside the zstd events part
//! before decompression, and a scan after the bytes left the device is not a
//! privacy boundary anyway. So the client normalizes every text it will show
//! or send through one scrubber:
//!
//! 1. the home directory becomes `~` (keeps `~/.cargo/registry/...` frames
//!    useful for a reader while dropping the account name),
//! 2. known hostnames become `[REDACTED_HOST]`,
//! 3. high-confidence credentials are replaced
//!    ([`crate::privacy::redact_high_confidence_credentials`]),
//! 4. the shared free-text rules run ([`crate::privacy::redact_text`]: bearer
//!    tokens, emails, absolute paths outside the home directory).
//!
//! Every step is idempotent, so [`CrashScrubber::is_clean`] can serve as the
//! fail-closed final check: a text the scrubber would still change, or one the
//! credential scan still rejects, never leaves the machine.

use std::path::Path;

use regex::Regex;
use serde_json::Value;

use crate::privacy::{
    redact_high_confidence_credentials, redact_text, scan_high_confidence_credentials,
};

/// Replacement for a hostname. Distinct from the path/email tokens so a reader
/// can tell what was there.
pub const REDACTED_HOST: &str = "[REDACTED_HOST]";

/// Hostnames shorter than this are not replaced: a two-letter host would
/// shred ordinary words in a panic message, and is not identifying anyway.
const MIN_HOST_LEN: usize = 3;

/// A hostname that appears inside one of the replacement tokens would match
/// again on every pass, so the scrubber could never reach a fixed point and the
/// final check would refuse every report from that machine.
fn collides_with_a_replacement(host: &str) -> bool {
    let host = host.to_lowercase();
    [
        "[redacted_host]",
        "[redacted_path]",
        "[redacted_email]",
        "[redacted]",
    ]
    .iter()
    .any(|token| token.contains(host.as_str()))
}

/// One scrubber per report: the home directory of this machine plus every
/// hostname the report itself names.
#[derive(Debug, Clone)]
pub struct CrashScrubber {
    /// The home directory (native and forward-slash spellings), matched only
    /// up to a boundary so `/Users/ann` never eats the start of `/Users/anna`.
    home: Option<Regex>,
    host: Option<Regex>,
}

impl CrashScrubber {
    pub fn new(home: Option<&Path>, hosts: impl IntoIterator<Item = String>) -> Self {
        let mut homes = Vec::new();
        if let Some(home) = home.and_then(Path::to_str) {
            let trimmed = home.trim_end_matches(['/', '\\']);
            // A root or drive-letter "home" is no account name; replacing it
            // would turn every absolute path into `~`.
            if trimmed.len() > 3 {
                homes.push(trimmed.to_owned());
                let forward = trimmed.replace('\\', "/");
                if forward != trimmed {
                    homes.push(forward);
                }
            }
        }
        homes.sort_by_key(|home| std::cmp::Reverse(home.len()));
        let home = (!homes.is_empty()).then(|| {
            let alternation = homes
                .iter()
                .map(|home| regex::escape(home))
                .collect::<Vec<_>>()
                .join("|");
            Regex::new(&format!(r#"(?:{alternation})(?P<tail>[/\\\s"':)\]]|$)"#))
                .expect("escaped home directories form a valid pattern")
        });

        let mut hosts: Vec<String> = hosts
            .into_iter()
            .map(|host| host.trim().to_owned())
            .filter(|host| host.chars().count() >= MIN_HOST_LEN)
            .filter(|host| !collides_with_a_replacement(host))
            .collect();
        // `name.local` and `name` both appear in macOS output; the longer one
        // must win the alternation.
        let mut short_names: Vec<String> = hosts
            .iter()
            .filter_map(|host| host.split_once('.').map(|(short, _)| short.to_owned()))
            .filter(|short| short.chars().count() >= MIN_HOST_LEN)
            .filter(|short| !collides_with_a_replacement(short))
            .collect();
        hosts.append(&mut short_names);
        hosts.sort_by_key(|host| std::cmp::Reverse(host.len()));
        hosts.dedup();
        let host = (!hosts.is_empty()).then(|| {
            let alternation = hosts
                .iter()
                .map(|host| regex::escape(host))
                .collect::<Vec<_>>()
                .join("|");
            // Whole names only: a host called `mac` must not eat `machine`.
            Regex::new(&format!(r"(?i)\b(?:{alternation})\b"))
                .expect("escaped hostnames form a valid pattern")
        });

        Self { home, host }
    }

    /// The scrubber for a report read from disk: this machine's home directory
    /// plus the hostname the report recorded (`system.hostname`).
    pub fn for_report(report: &Value) -> Self {
        let hosts = report
            .pointer("/system/hostname")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Self::new(dirs::home_dir().as_deref(), hosts)
    }

    pub fn scrub_text(&self, text: &str) -> String {
        let mut out = text.to_owned();
        if let Some(home) = &self.home {
            out = home.replace_all(&out, "~${tail}").into_owned();
        }
        if let Some(host) = &self.host {
            out = host.replace_all(&out, REDACTED_HOST).into_owned();
        }
        let out = redact_high_confidence_credentials(&out);
        redact_text(&out)
    }

    /// Scrub every string in a JSON value. Keys are left alone: they are the
    /// report's own field names (and the renderer's config keys, which it
    /// redacted before sending).
    pub fn scrub_value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.scrub_text(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.scrub_value(item)).collect())
            }
            Value::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(key, nested)| (key.clone(), self.scrub_value(nested)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Normalize a structured crash report: scrub every string and drop the
    /// hostname field outright (it identifies the machine and groups nothing).
    pub fn scrub_report(&self, report: &Value) -> Value {
        let mut scrubbed = self.scrub_value(report);
        if let Some(system) = scrubbed.get_mut("system").and_then(Value::as_object_mut) {
            if system.contains_key("hostname") {
                system.insert("hostname".to_owned(), Value::Null);
            }
        }
        scrubbed
    }

    /// The fail-closed check: true only when scrubbing would change nothing
    /// and no high-confidence credential remains.
    pub fn is_clean(&self, text: &str) -> bool {
        self.scrub_text(text) == text && !scan_high_confidence_credentials(text.as_bytes()).reject
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scrubber() -> CrashScrubber {
        CrashScrubber::new(
            Some(&PathBuf::from("/Users/jane")),
            ["Janes-MacBook-Pro.local".to_owned()],
        )
    }

    #[test]
    fn home_paths_keep_their_tail_while_the_account_name_goes() {
        let out = scrubber().scrub_text(
            "at /Users/jane/.cargo/registry/src/foo-1.0/src/lib.rs:12:5\nat /Users/janet/x.rs",
        );
        assert!(
            out.contains("~/.cargo/registry/src/foo-1.0/src/lib.rs:12:5"),
            "{out}"
        );
        assert!(!out.contains("jane"), "{out}");
        // Another account's absolute path falls to the generic path rule.
        assert!(out.contains("[REDACTED_PATH]"), "{out}");
    }

    #[test]
    fn hostnames_are_redacted_in_long_and_short_form_case_insensitively() {
        let out =
            scrubber().scrub_text("connect janes-macbook-pro.local / Janes-MacBook-Pro failed");
        assert_eq!(out, "connect [REDACTED_HOST] / [REDACTED_HOST] failed");
    }

    #[test]
    fn a_hostname_is_replaced_only_as_a_whole_word() {
        let scrubber = CrashScrubber::new(None, ["mac".to_owned()]);
        assert_eq!(
            scrubber.scrub_text("machine mac crashed on MAC"),
            "machine [REDACTED_HOST] crashed on [REDACTED_HOST]"
        );
    }

    #[test]
    fn credentials_emails_and_bearer_tokens_are_redacted() {
        let out = scrubber().scrub_text(
            "user jane.doe@example.com sent Bearer abc.def and key sk-abcdefghijklmnopqrstuvwxyz0123",
        );
        assert!(!out.contains("jane.doe@example.com"));
        assert!(!out.contains("abc.def"));
        assert!(!out.contains("sk-abcdefghijklmnopqrstuvwxyz0123"));
        assert!(scrubber().is_clean(&out));
    }

    #[test]
    fn scrubbing_is_idempotent_so_the_final_check_passes_on_its_own_output() {
        let raw = "panic at /Users/jane/src/a.rs on Janes-MacBook-Pro: AKIAABCDEFGHIJKLMNOP";
        let once = scrubber().scrub_text(raw);
        assert_eq!(scrubber().scrub_text(&once), once);
        assert!(scrubber().is_clean(&once));
        assert!(!scrubber().is_clean(raw));
    }

    #[test]
    fn a_report_loses_its_hostname_field_and_every_string_is_scrubbed() {
        let report = serde_json::json!({
            "message": "boom for jane.doe@example.com",
            "backtrace": "0: x\n   at /Users/jane/src/main.rs:1",
            "system": {"hostname": "Janes-MacBook-Pro.local", "arch": "aarch64"},
            "context": {"breadcrumbs": [{"message": "opened /Users/jane/doc.md"}]},
            "extra": {"crashReportsDir": "/Users/jane/Library/Application Support/Cognia/crash-reports"},
        });
        let scrubbed = scrubber().scrub_report(&report);
        assert_eq!(scrubbed["system"]["hostname"], Value::Null);
        assert_eq!(scrubbed["system"]["arch"], "aarch64");
        let text = scrubbed.to_string();
        assert!(!text.contains("jane"), "{text}");
        assert!(text.contains("~/src/main.rs:1"), "{text}");
        assert!(text.contains("~/doc.md"), "{text}");
    }

    #[test]
    fn a_hostname_inside_a_replacement_token_cannot_loop_the_check() {
        let scrubber = CrashScrubber::new(None, ["redacted".to_owned(), "HOST".to_owned()]);
        let out = scrubber.scrub_text("bearer Bearer abc and redacted");
        assert!(scrubber.is_clean(&out), "{out}");
    }

    #[test]
    fn a_root_home_or_a_tiny_hostname_does_not_shred_the_report() {
        let scrubber = CrashScrubber::new(Some(&PathBuf::from("/")), ["ab".to_owned()]);
        assert_eq!(scrubber.scrub_text("about tab"), "about tab");
    }

    #[test]
    fn windows_homes_match_both_slash_styles() {
        let scrubber =
            CrashScrubber::new(Some(&PathBuf::from(r"C:\Users\jane")), Vec::<String>::new());
        assert_eq!(
            scrubber.scrub_text(r"C:\Users\jane\app\x.rs"),
            r"~\app\x.rs"
        );
        assert_eq!(scrubber.scrub_text("C:/Users/jane/app/x.rs"), "~/app/x.rs");
    }
}
