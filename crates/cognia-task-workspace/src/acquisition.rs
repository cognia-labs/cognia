//! One local acquisition's budget, the key it can be cancelled by, and the
//! record it leaves behind (ADR-0176 amendment, A1).
//!
//! Every way a managed checkout is produced (a task run, a bundle, a restore,
//! a remote supply) runs under one [`AcquisitionBudget`]: an overall deadline,
//! a ceiling per phase and a cancel that kills the git it is waiting on. When
//! the acquisition ends, its phases land in `workspace_acquisitions`, which the
//! performance page reads as "recent acquisitions".
//!
//! The record is its own table rather than a column on the registry row
//! because a failed acquisition discards its registry row, and the failures
//! are the records worth reading.
//!
//! Cancellation is keyed by an identity the caller already sends, so no
//! acquire input had to change: a task run by its run id, a bundle by its
//! owner, a restore by its workspace id. A remote supply has no caller-visible
//! identity and cannot be cancelled by key; it is still bounded by the budget.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use cognia_git_mirror::{AcquisitionBudget, AcquisitionReport, CancelToken, FailureClass};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::types::WorkspaceOwnerType;

/// How many acquisition records are kept. Old enough to compare today with
/// yesterday, small enough that the table never needs its own maintenance.
pub const ACQUISITION_RECORDS_KEPT: u32 = 200;

/// How long a cancel for a run that has not registered yet is remembered.
///
/// A client that aborts right after sending `task_workspace_begin` can reach
/// the host before the begin has registered its run id, because the begin
/// waits for a blocking-pool thread. Run ids are unique per run, so a
/// remembered cancel cannot catch a later, unrelated run.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);

/// Longest error text a record keeps.
const ERROR_TEXT_LIMIT: usize = 2_000;

/// What produced the checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceAcquisitionKind {
    /// `task_workspace_begin`.
    Run,
    /// `task_workspace_bundle_acquire`.
    Bundle,
    /// Restoring an archived managed workspace.
    Restore,
    /// Supplying a source checkout from a remote.
    RemoteSource,
}

impl WorkspaceAcquisitionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Bundle => "bundle",
            Self::Restore => "restore",
            Self::RemoteSource => "remoteSource",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "run" => Self::Run,
            "bundle" => Self::Bundle,
            "restore" => Self::Restore,
            "remoteSource" => Self::RemoteSource,
            _ => return None,
        })
    }
}

/// One timed step of an acquisition, as the wire carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspaceAcquisitionPhase {
    /// `fetch`, `clone`, `backfill`, `derive`, `worktreeAdd`, `sparse`,
    /// `checkout` or `provisioning`.
    pub phase: String,
    /// Milliseconds after the acquisition started.
    pub started_ms: u64,
    pub duration_ms: u64,
    pub ok: bool,
    /// Set when the step failed: `notFound`, `auth`, `network`, `timedOut`,
    /// `cancelled`, `lock`, `diskFull` or `other`.
    #[serde(default)]
    pub failure_class: Option<String>,
    /// 1 for the first attempt; a retried step has one entry per attempt.
    pub attempt: u32,
    /// A short fact about the step, such as a mirror `hit`.
    #[serde(default)]
    pub note: Option<String>,
}

/// What one acquisition recorded about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspaceAcquisition {
    pub acquisition_id: String,
    pub kind: WorkspaceAcquisitionKind,
    /// The checkout it was cut from, or the remote it was supplied from with
    /// any userinfo removed.
    pub subject: String,
    /// The run id, bundle owner or workspace id it was keyed by.
    #[serde(default)]
    pub key: Option<String>,
    /// Unix milliseconds.
    pub started_at: i64,
    pub total_ms: u64,
    pub ok: bool,
    /// The class of the step that failed it; `other` when it failed after its
    /// last step succeeded (a store write, a baseline capture).
    #[serde(default)]
    pub failure_class: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub phases: Vec<WorkspaceAcquisitionPhase>,
}

/// Which in-flight acquisition to cancel. Exactly one of the three is named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CancelWorkspaceAcquisition {
    /// A `task_workspace_begin` in flight for this run id.
    #[serde(default)]
    pub run_id: Option<String>,
    /// A `task_workspace_bundle_acquire` in flight for this owner. Both
    /// `ownerType` and `ownerRef` are required together.
    #[serde(default)]
    pub owner_type: Option<WorkspaceOwnerType>,
    #[serde(default)]
    pub owner_ref: Option<String>,
    /// A restore in flight for this managed workspace.
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// Whether a cancel reached an acquisition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CancelWorkspaceAcquisitionOutcome {
    /// `true` when an acquisition was in flight under that key and was told to
    /// stop. A run that had not registered yet is remembered and also answers
    /// `true`; anything else answers `false` and changes nothing.
    pub cancelled: bool,
}

pub(crate) fn run_key(run_id: &str) -> String {
    format!("run:{run_id}")
}

pub(crate) fn bundle_key(owner_type: WorkspaceOwnerType, owner_ref: &str) -> String {
    format!("bundle:{}:{owner_ref}", owner_type_str(owner_type))
}

pub(crate) fn restore_key(workspace_id: &str) -> String {
    format!("workspace:{workspace_id}")
}

fn owner_type_str(owner_type: WorkspaceOwnerType) -> &'static str {
    match owner_type {
        WorkspaceOwnerType::User => "user",
        WorkspaceOwnerType::Imported => "imported",
        WorkspaceOwnerType::Session => "session",
        WorkspaceOwnerType::Team => "team",
        WorkspaceOwnerType::Scheduled => "scheduled",
    }
}

impl CancelWorkspaceAcquisition {
    /// The registry key this names, and whether it is a run key.
    /// Whether the target names exactly one acquisition key, so a caller can
    /// answer a malformed request as invalid input rather than a failure.
    pub fn validate(&self) -> Result<(), String> {
        self.key().map(|_| ())
    }

    fn key(&self) -> Result<(String, bool), String> {
        let named = [
            self.run_id.is_some(),
            self.owner_type.is_some() || self.owner_ref.is_some(),
            self.workspace_id.is_some(),
        ]
        .into_iter()
        .filter(|named| *named)
        .count();
        if named != 1 {
            return Err("name exactly one of runId, ownerType + ownerRef, or workspaceId".into());
        }
        let non_empty = |value: &str, field: &str| {
            if value.trim().is_empty() {
                Err(format!("{field} cannot be empty"))
            } else {
                Ok(())
            }
        };
        if let Some(run_id) = &self.run_id {
            non_empty(run_id, "runId")?;
            return Ok((run_key(run_id), true));
        }
        if let Some(workspace_id) = &self.workspace_id {
            non_empty(workspace_id, "workspaceId")?;
            return Ok((restore_key(workspace_id), false));
        }
        match (self.owner_type, self.owner_ref.as_deref()) {
            (Some(owner_type), Some(owner_ref)) => {
                non_empty(owner_ref, "ownerRef")?;
                Ok((bundle_key(owner_type, owner_ref), false))
            }
            _ => Err("ownerType and ownerRef are required together".into()),
        }
    }
}

#[derive(Default)]
struct InFlightState {
    /// The tokens of the acquisitions in flight under each key. Each has its
    /// own: a cancel stops every acquisition under the key at that moment,
    /// and one started after it (a retry) is not born cancelled.
    live: HashMap<String, Vec<(u64, CancelToken)>>,
    next: u64,
    /// Run keys cancelled before they registered.
    early: HashMap<String, Instant>,
}

/// The cancel tokens of the acquisitions in flight on this service.
#[derive(Default)]
pub(crate) struct InFlightAcquisitions {
    state: Mutex<InFlightState>,
}

impl InFlightAcquisitions {
    /// Register an acquisition under `key`, running under `budget`.
    ///
    /// The guard unregisters it when dropped.
    pub(crate) fn begin(
        &self,
        kind: WorkspaceAcquisitionKind,
        key: Option<String>,
        subject: impl Into<String>,
        budget: AcquisitionBudget,
    ) -> Acquisition<'_> {
        let token = CancelToken::new();
        let mut registration = None;
        if let Some(key) = &key {
            let mut state = self.state.lock();
            prune_early(&mut state.early);
            if state.early.remove(key).is_some() {
                token.cancel();
            }
            let id = state.next;
            state.next += 1;
            state
                .live
                .entry(key.clone())
                .or_default()
                .push((id, token.clone()));
            registration = Some(id);
        }
        Acquisition {
            registry: self,
            kind,
            key,
            registration,
            subject: subject.into(),
            started_at: crate::service::now_ms(),
            budget: budget.with_cancel(token),
        }
    }

    /// Cancel the acquisitions in flight under the named key.
    pub(crate) fn cancel(&self, target: &CancelWorkspaceAcquisition) -> Result<bool, String> {
        let (key, is_run) = target.key()?;
        let mut state = self.state.lock();
        if let Some(tokens) = state.live.get(&key).filter(|tokens| !tokens.is_empty()) {
            for (_, token) in tokens {
                token.cancel();
            }
            return Ok(true);
        }
        if is_run {
            prune_early(&mut state.early);
            state.early.insert(key, Instant::now());
            return Ok(true);
        }
        Ok(false)
    }

    fn release(&self, key: &str, id: u64) {
        let mut state = self.state.lock();
        if let Some(tokens) = state.live.get_mut(key) {
            tokens.retain(|(held, _)| *held != id);
            if tokens.is_empty() {
                state.live.remove(key);
            }
        }
    }
}

fn prune_early(early: &mut HashMap<String, Instant>) {
    early.retain(|_, at| at.elapsed() < EARLY_CANCEL_TTL);
}

/// One acquisition in flight: its budget, and what it will record.
pub(crate) struct Acquisition<'a> {
    registry: &'a InFlightAcquisitions,
    kind: WorkspaceAcquisitionKind,
    key: Option<String>,
    registration: Option<u64>,
    subject: String,
    started_at: i64,
    budget: AcquisitionBudget,
}

impl Acquisition<'_> {
    pub(crate) fn budget(&self) -> &AcquisitionBudget {
        &self.budget
    }

    /// The record of this acquisition, or `None` when it did no acquiring
    /// work (an idempotent replay, a reused or borrowed root): those are not
    /// acquisitions a person comparing timings wants to see.
    pub(crate) fn record<T>(&self, result: &Result<T, String>) -> Option<WorkspaceAcquisition> {
        build_record(
            self.kind,
            self.key.as_deref(),
            &self.subject,
            self.started_at,
            &self.budget.report(),
            result.as_ref().err().map(String::as_str),
        )
    }
}

impl Drop for Acquisition<'_> {
    fn drop(&mut self) {
        if let (Some(key), Some(id)) = (&self.key, self.registration) {
            self.registry.release(key, id);
        }
    }
}

fn build_record(
    kind: WorkspaceAcquisitionKind,
    key: Option<&str>,
    subject: &str,
    started_at: i64,
    report: &AcquisitionReport,
    error: Option<&str>,
) -> Option<WorkspaceAcquisition> {
    if report.phases.is_empty() {
        return None;
    }
    let phases = report
        .phases
        .iter()
        .map(|record| WorkspaceAcquisitionPhase {
            phase: record.phase.as_str().to_string(),
            started_ms: record.started_ms,
            duration_ms: record.duration_ms,
            ok: record.ok,
            failure_class: record.class.map(|class| class.as_str().to_string()),
            attempt: record.attempt,
            note: record.note.clone(),
        })
        .collect::<Vec<_>>();
    // The last step's class when the last step is what failed. A failure
    // after a step that succeeded (a store write, a capture) is `other`, even
    // when an earlier attempt of some step had failed and been retried.
    let failure_class = error.map(|_| {
        report
            .phases
            .last()
            .and_then(|record| record.class)
            .unwrap_or(FailureClass::Other)
            .as_str()
            .to_string()
    });
    Some(WorkspaceAcquisition {
        acquisition_id: uuid::Uuid::now_v7().to_string(),
        kind,
        subject: strip_userinfo(subject),
        key: key.map(str::to_string),
        started_at,
        total_ms: report.total_ms,
        ok: error.is_none(),
        failure_class,
        // Git's own output, kept for the person reading the record. A run with
        // the user's configuration has no host credential to redact, so any
        // URL in it loses its userinfo here: a remote configured as
        // `https://user:token@host/…` must not land in the table.
        error: error.map(|text| {
            truncate(
                &strip_userinfo_in_text(&drop_authorization_lines(text)),
                ERROR_TEXT_LIMIT,
            )
        }),
        phases,
    })
}

/// `https://user:token@host/repo?private_token=x` → `https://host/repo`. A
/// path is returned unchanged.
fn strip_userinfo(subject: &str) -> String {
    strip_userinfo_in_text(subject)
}

/// Remove what can carry a secret from every URL inside free text: userinfo,
/// the query and the fragment.
///
/// A URL runs to the next whitespace or quote. Its userinfo ends at the last
/// `@` before the first `/`, or, when a raw `/` sits inside the password, at
/// the last `@` that follows a `:`. The second rule can also cut a path that
/// merely contains `@` after a port (`https://h:8443/o/r@v2` → `v2`): losing
/// part of a path in an error message is the safe side to be wrong on.
fn strip_userinfo_in_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (before, after) = rest.split_at(at + 3);
        out.push_str(before);
        let end = after
            .find(|c: char| c == '\'' || c == '"' || c.is_whitespace())
            .unwrap_or(after.len());
        out.push_str(&clean_url_rest(&after[..end]));
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// The part of a URL after `scheme://`, without userinfo, query or fragment.
fn clean_url_rest(rest: &str) -> String {
    let first_slash = rest.find('/').unwrap_or(rest.len());
    let userinfo_end = rest[..first_slash]
        .rfind('@')
        .or_else(|| rest.rfind('@').filter(|&at| rest[..at].contains(':')));
    let rest = match userinfo_end {
        Some(at) => &rest[at + 1..],
        None => rest,
    };
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    rest[..end].to_string()
}

/// Git's curl traces print request headers. The runner turns them off, but a
/// line that names an `Authorization` header is dropped here too.
fn drop_authorization_lines(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.to_ascii_lowercase().contains("authorization:") {
                "[authorization header removed]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS workspace_acquisitions (
               acquisition_id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               ok INTEGER NOT NULL,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_workspace_acquisitions_started
               ON workspace_acquisitions(started_at DESC);",
        )
        .map_err(|error| format!("initialize workspace acquisitions: {error}"))
}

/// Store one record and drop all but the newest [`ACQUISITION_RECORDS_KEPT`].
pub(crate) fn insert(connection: &Connection, record: &WorkspaceAcquisition) -> Result<(), String> {
    let payload = serde_json::to_string(record)
        .map_err(|error| format!("encode workspace acquisition: {error}"))?;
    connection
        .execute(
            "INSERT OR REPLACE INTO workspace_acquisitions
               (acquisition_id, kind, started_at, ok, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                record.acquisition_id,
                record.kind.as_str(),
                record.started_at,
                record.ok,
                payload
            ],
        )
        .map_err(|error| format!("record workspace acquisition: {error}"))?;
    connection
        .execute(
            "DELETE FROM workspace_acquisitions WHERE acquisition_id NOT IN (
               SELECT acquisition_id FROM workspace_acquisitions
               ORDER BY started_at DESC, acquisition_id DESC LIMIT ?1)",
            params![ACQUISITION_RECORDS_KEPT],
        )
        .map_err(|error| format!("trim workspace acquisitions: {error}"))?;
    Ok(())
}

/// The newest records first.
pub(crate) fn list(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<WorkspaceAcquisition>, String> {
    let mut statement = connection
        .prepare(
            "SELECT kind, payload FROM workspace_acquisitions
             ORDER BY started_at DESC, acquisition_id DESC LIMIT ?1",
        )
        .map_err(|error| format!("read workspace acquisitions: {error}"))?;
    let rows = statement
        .query_map(params![limit.min(ACQUISITION_RECORDS_KEPT)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("read workspace acquisitions: {error}"))?;
    let mut records = Vec::new();
    for row in rows {
        let (kind, payload) =
            row.map_err(|error| format!("read workspace acquisition: {error}"))?;
        // A row a newer build wrote with a kind this build does not know is
        // skipped rather than failing the whole list.
        if WorkspaceAcquisitionKind::parse(&kind).is_none() {
            continue;
        }
        match serde_json::from_str::<WorkspaceAcquisition>(&payload) {
            Ok(record) => records.push(record),
            Err(_) => continue,
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_git_mirror::{Phase, PhaseRecord};

    fn report(phases: Vec<PhaseRecord>) -> AcquisitionReport {
        AcquisitionReport {
            total_ms: 42,
            phases,
        }
    }

    fn phase(phase: Phase, class: Option<FailureClass>) -> PhaseRecord {
        PhaseRecord {
            phase,
            started_ms: 1,
            duration_ms: 2,
            ok: class.is_none(),
            class,
            attempt: 1,
            note: None,
        }
    }

    fn record_at(started_at: i64, ok: bool) -> WorkspaceAcquisition {
        let mut record = build_record(
            WorkspaceAcquisitionKind::Run,
            Some("run:r"),
            "/repo",
            started_at,
            &report(vec![phase(Phase::WorktreeAdd, None)]),
            (!ok).then_some("boom"),
        )
        .unwrap();
        record.acquisition_id = format!("{started_at:020}");
        record
    }

    #[test]
    fn an_acquisition_that_did_no_work_leaves_no_record() {
        assert!(build_record(
            WorkspaceAcquisitionKind::Run,
            None,
            "/repo",
            0,
            &report(Vec::new()),
            None
        )
        .is_none());
    }

    #[test]
    fn a_failure_takes_the_class_of_the_last_failed_phase() {
        let record = build_record(
            WorkspaceAcquisitionKind::Bundle,
            Some("bundle:session:s"),
            "/repo",
            7,
            &report(vec![
                phase(Phase::Fetch, Some(FailureClass::Network)),
                phase(Phase::Fetch, Some(FailureClass::TimedOut)),
            ]),
            Some("refresh remote default failed: git timed out after 180s"),
        )
        .unwrap();
        assert!(!record.ok);
        assert_eq!(record.failure_class.as_deref(), Some("timedOut"));
        assert_eq!(record.phases.len(), 2);
        assert_eq!(record.phases[0].failure_class.as_deref(), Some("network"));
        assert_eq!(record.phases[1].phase, "fetch");
    }

    #[test]
    fn a_failure_outside_any_phase_is_other() {
        let record = build_record(
            WorkspaceAcquisitionKind::Run,
            None,
            "/repo",
            7,
            &report(vec![phase(Phase::WorktreeAdd, None)]),
            Some("managed workspace capacity reached"),
        )
        .unwrap();
        assert_eq!(record.failure_class.as_deref(), Some("other"));
    }

    #[test]
    fn a_remote_subject_loses_its_userinfo() {
        assert_eq!(
            strip_userinfo("https://x-access-token:ghp_secret@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(strip_userinfo("/Users/me/repo"), "/Users/me/repo");
        assert_eq!(
            strip_userinfo("https://github.com/o/r@v2"),
            "https://github.com/o/r@v2"
        );
    }

    #[test]
    fn a_credential_in_git_s_error_text_is_not_kept() {
        let record = build_record(
            WorkspaceAcquisitionKind::Run,
            None,
            "/repo",
            0,
            &report(vec![phase(Phase::Fetch, Some(FailureClass::Auth))]),
            Some(
                "refresh remote default failed: fatal: unable to access \
                 'https://x-access-token:ghp_secret@github.com/o/r.git/': 403",
            ),
        )
        .unwrap();
        let error = record.error.unwrap();
        assert!(!error.contains("ghp_secret"), "{error}");
        assert!(error.contains("'https://github.com/o/r.git/'"), "{error}");
        assert_eq!(
            strip_userinfo_in_text("see ssh://git@host:22/x and https://h/y"),
            "see ssh://host:22/x and https://h/y"
        );
    }

    #[test]
    fn query_strings_odd_passwords_and_auth_headers_are_not_kept() {
        assert_eq!(
            strip_userinfo("https://gitlab.example/o/r.git?private_token=glpat-secret#frag"),
            "https://gitlab.example/o/r.git"
        );
        // A raw `/` inside the password still loses the whole userinfo.
        let cleaned = strip_userinfo_in_text("fatal: 'https://user:pa/ss@host/o/r.git' failed");
        assert_eq!(cleaned, "fatal: 'https://host/o/r.git' failed");
        assert!(!cleaned.contains("pa"));
        let record = build_record(
            WorkspaceAcquisitionKind::Run,
            None,
            "/repo",
            0,
            &report(vec![phase(Phase::Fetch, Some(FailureClass::Auth))]),
            Some("=> Send header: Authorization: Basic eC1hY2Nlc3M6Z2hw\nfatal: denied"),
        )
        .unwrap();
        let error = record.error.unwrap();
        assert!(!error.contains("eC1hY2Nlc3M6Z2hw"), "{error}");
        assert!(error.ends_with("fatal: denied"), "{error}");
    }

    #[test]
    fn a_long_error_is_cut_on_a_character_boundary() {
        let text = "é".repeat(ERROR_TEXT_LIMIT);
        let cut = truncate(&text, ERROR_TEXT_LIMIT);
        assert!(cut.ends_with('…'));
        assert!(cut.len() <= ERROR_TEXT_LIMIT + '…'.len_utf8());
    }

    #[test]
    fn the_table_keeps_the_newest_records_and_lists_them_newest_first() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        migrate(&connection).expect("the migration is idempotent");
        let total = i64::from(ACQUISITION_RECORDS_KEPT) + 5;
        for at in 0..total {
            insert(&connection, &record_at(at, at % 2 == 0)).unwrap();
        }
        let listed = list(&connection, 1_000).unwrap();
        assert_eq!(listed.len(), ACQUISITION_RECORDS_KEPT as usize);
        assert_eq!(listed[0].started_at, total - 1);
        assert_eq!(listed.last().unwrap().started_at, 5);
        assert_eq!(list(&connection, 3).unwrap().len(), 3);
    }

    #[test]
    fn a_cancel_reaches_every_acquisition_under_its_key_and_only_those() {
        let registry = InFlightAcquisitions::default();
        let first = registry.begin(
            WorkspaceAcquisitionKind::Run,
            Some(run_key("a")),
            "/r",
            AcquisitionBudget::new(None),
        );
        let second = registry.begin(
            WorkspaceAcquisitionKind::Run,
            Some(run_key("a")),
            "/r",
            AcquisitionBudget::new(None),
        );
        let other = registry.begin(
            WorkspaceAcquisitionKind::Run,
            Some(run_key("b")),
            "/r",
            AcquisitionBudget::new(None),
        );
        let target = CancelWorkspaceAcquisition {
            run_id: Some("a".into()),
            owner_type: None,
            owner_ref: None,
            workspace_id: None,
        };
        assert!(registry.cancel(&target).unwrap());
        assert!(first.budget().is_cancelled());
        assert!(second.budget().is_cancelled());
        assert!(!other.budget().is_cancelled());
        // A retry under the same key, started while the cancelled ones are
        // still unwinding, is not born cancelled.
        let retry = registry.begin(
            WorkspaceAcquisitionKind::Run,
            Some(run_key("a")),
            "/r",
            AcquisitionBudget::new(None),
        );
        assert!(!retry.budget().is_cancelled());
        drop(first);
        assert!(
            registry.cancel(&target).unwrap(),
            "the retry and the second are in flight"
        );
        assert!(retry.budget().is_cancelled());
    }

    #[test]
    fn a_failure_after_a_successful_last_step_is_other() {
        let record = build_record(
            WorkspaceAcquisitionKind::Run,
            None,
            "/repo",
            0,
            &report(vec![
                phase(Phase::Fetch, Some(FailureClass::Network)),
                phase(Phase::Fetch, None),
                phase(Phase::WorktreeAdd, None),
            ]),
            Some("persist the capture baseline: disk I/O error"),
        )
        .unwrap();
        assert_eq!(record.failure_class.as_deref(), Some("other"));
    }

    #[test]
    fn a_finished_acquisition_is_unregistered() {
        let registry = InFlightAcquisitions::default();
        let target = CancelWorkspaceAcquisition {
            run_id: None,
            owner_type: Some(WorkspaceOwnerType::Session),
            owner_ref: Some("s1".into()),
            workspace_id: None,
        };
        {
            let _acquisition = registry.begin(
                WorkspaceAcquisitionKind::Bundle,
                Some(bundle_key(WorkspaceOwnerType::Session, "s1")),
                "/r",
                AcquisitionBudget::new(None),
            );
        }
        assert!(!registry.cancel(&target).unwrap(), "nothing is in flight");
        let next = registry.begin(
            WorkspaceAcquisitionKind::Bundle,
            Some(bundle_key(WorkspaceOwnerType::Session, "s1")),
            "/r",
            AcquisitionBudget::new(None),
        );
        assert!(
            !next.budget().is_cancelled(),
            "a cancel that reached nothing must not wait for the owner's next bundle"
        );
    }

    #[test]
    fn a_run_cancelled_before_it_registered_starts_cancelled_once() {
        let registry = InFlightAcquisitions::default();
        let target = CancelWorkspaceAcquisition {
            run_id: Some("early".into()),
            owner_type: None,
            owner_ref: None,
            workspace_id: None,
        };
        assert!(registry.cancel(&target).unwrap());
        let first = registry.begin(
            WorkspaceAcquisitionKind::Run,
            Some(run_key("early")),
            "/r",
            AcquisitionBudget::new(None),
        );
        assert!(first.budget().is_cancelled());
        drop(first);
        let replay = registry.begin(
            WorkspaceAcquisitionKind::Run,
            Some(run_key("early")),
            "/r",
            AcquisitionBudget::new(None),
        );
        assert!(
            !replay.budget().is_cancelled(),
            "the remembered cancel is used once"
        );
    }

    #[test]
    fn a_cancel_must_name_exactly_one_target() {
        let registry = InFlightAcquisitions::default();
        let none = CancelWorkspaceAcquisition {
            run_id: None,
            owner_type: None,
            owner_ref: None,
            workspace_id: None,
        };
        assert!(registry.cancel(&none).is_err());
        let two = CancelWorkspaceAcquisition {
            run_id: Some("a".into()),
            workspace_id: Some("w".into()),
            ..none.clone()
        };
        assert!(registry.cancel(&two).is_err());
        let half_owner = CancelWorkspaceAcquisition {
            owner_ref: Some("s".into()),
            ..none.clone()
        };
        assert!(registry.cancel(&half_owner).is_err());
        let blank = CancelWorkspaceAcquisition {
            run_id: Some("  ".into()),
            ..none
        };
        assert!(registry.cancel(&blank).is_err());
    }
}
