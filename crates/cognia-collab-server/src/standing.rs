//! Standing changes and organization suspension — ADR-0253 §2 and §4.
//!
//! A Host acts for an organization's members, so it must learn when one of
//! them loses standing. Every mutation that can reduce or change a person's
//! standing writes one [`StandingChange`] in its own transaction, and
//! `GET /internal/v1/standing-changes?after=<seq>` streams them to the Hosts
//! whose service credential covers the organization.
//!
//! # Order
//!
//! Writers take one transaction-level advisory lock before inserting, so a
//! row's sequence is allocated and committed in order: once the stream has
//! read sequence N, no row below N can still appear. A rolled-back
//! transaction leaves a hole, and the per-credential filter leaves more, so
//! a raw sequence gap means nothing. Each frame instead names `prev`, the
//! sequence of the previous frame this connection sent (or the cursor the
//! Host asked from): a Host whose cursor differs from `prev` missed a frame.
//!
//! # Frames
//!
//! One JSON object per line (`application/x-ndjson`):
//!
//! - `{"type":"change","seq","prev","orgId","userId"?,"workspaceId"?,"kind","at"}`
//! - `{"type":"heartbeat","seq"}`: every row through `seq` has been read; the
//!   Host may store it as its cursor.
//! - `{"type":"resync","seq"}`: the cursor cannot be answered with rows (it is
//!   older than retention, newer than this server's history, or absent). The
//!   Host drops what it knows and continues from `seq`.
//!
//! # Suspension
//!
//! Only the deployment operator suspends or resumes an organization, through
//! `cognia-collab-server org suspend|resume`. The application role cannot
//! write `org_suspensions`, so an owner cannot lift their own suspension. While
//! suspended, [`refuse_suspended_orgs`] answers every request that names the
//! organization with `org_suspended`, and `Store::membership` refuses as well,
//! so a path that resolves standing some other way fails closed too.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::api::AppState;
use crate::store::StoreError;

/// The advisory lock every standing-change writer takes before its insert.
pub(crate) const STANDING_CHANGE_LOCK_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtextextended('cognia.collab.standing_changes', 0))";

/// How long rows are kept. A Host offline for longer reconnects to a
/// `resync` and re-checks everyone it serves.
pub const STANDING_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How often the server prunes rows past retention.
pub const STANDING_RETENTION_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How often an open stream looks for new rows.
pub const STANDING_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// How often an open stream says it is alive when nothing changed.
pub const STANDING_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// The most rows one read returns.
pub const STANDING_PAGE_LIMIT: usize = 500;
/// The most streams one server holds open at once.
pub const STANDING_STREAM_LIMIT: usize = 256;
/// How long a suspension lookup is reused by the request middleware.
pub const ORG_STATUS_TTL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandingChangeKind {
    Offboarded,
    RoleChanged,
    WorkspaceRemoved,
    OrgSuspended,
    OrgResumed,
}

impl StandingChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offboarded => "offboarded",
            Self::RoleChanged => "role_changed",
            Self::WorkspaceRemoved => "workspace_removed",
            Self::OrgSuspended => "org_suspended",
            Self::OrgResumed => "org_resumed",
        }
    }

    pub fn parse(value: &str) -> Result<Self, StoreError> {
        Ok(match value {
            "offboarded" => Self::Offboarded,
            "role_changed" => Self::RoleChanged,
            "workspace_removed" => Self::WorkspaceRemoved,
            "org_suspended" => Self::OrgSuspended,
            "org_resumed" => Self::OrgResumed,
            other => {
                return Err(StoreError::Corrupt(format!(
                    "unknown standing change kind {other:?}"
                )))
            }
        })
    }
}

/// One committed standing change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingChange {
    pub seq: i64,
    pub org_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub kind: StandingChangeKind,
    #[serde(rename = "at")]
    pub created_at: i64,
}

/// One read of the change log, across organizations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingChangePage {
    /// Rows after the cursor, in sequence order, at most the requested limit.
    pub rows: Vec<StandingChange>,
    /// The highest sequence committed when the read began.
    pub head: i64,
    /// The highest sequence retention has removed.
    pub pruned_through: i64,
}

impl StandingChangePage {
    /// Every row through this sequence has been read: all of them when the
    /// page was not cut off, otherwise through its last row.
    pub fn read_through(&self, after: i64, limit: usize) -> i64 {
        let last = self.rows.last().map_or(after, |row| row.seq);
        if self.rows.len() >= limit {
            last
        } else {
            last.max(self.head).max(after)
        }
    }
}

/// What the operator asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgSuspensionChange {
    pub org_id: String,
    pub suspend: bool,
    pub reason: String,
    pub operation_id: String,
    pub principal: String,
    pub now: i64,
}

/// The organization's status after the change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSuspensionOutcome {
    pub org_id: String,
    pub suspended: bool,
    /// False when the organization was already in the requested state or the
    /// operation was a replay: no standing change was written.
    pub changed: bool,
}

pub(crate) fn validate_suspension_change(change: &OrgSuspensionChange) -> Result<(), StoreError> {
    cognia_tenant_auth::OrgId::parse(change.org_id.clone())
        .map_err(|error| StoreError::Policy(error.to_string()))?;
    let reason = change.reason.trim();
    if reason.is_empty() || reason.len() > 1024 {
        return Err(StoreError::Policy("reason must be 1 to 1024 bytes".into()));
    }
    if change.operation_id.trim().is_empty() || change.operation_id.len() > 256 {
        return Err(StoreError::Policy(
            "operation-id must be 1 to 256 bytes".into(),
        ));
    }
    Ok(())
}

// ── Writers ──────────────────────────────────────────────────────────────────

/// Record one change inside the caller's tenant-scoped transaction.
pub(crate) async fn pg_record(
    transaction: &deadpool_postgres::Transaction<'_>,
    org_id: &str,
    user_id: Option<&str>,
    workspace_id: Option<&str>,
    kind: StandingChangeKind,
    now: i64,
) -> Result<(), StoreError> {
    transaction
        .batch_execute(STANDING_CHANGE_LOCK_SQL)
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO standing_changes (org_id, user_id, workspace_id, kind, created_at) \
             VALUES ($1, $2, $3, $4, $5)",
            &[&org_id, &user_id, &workspace_id, &kind.as_str(), &now],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    Ok(())
}

/// The in-memory store's change log.
#[derive(Debug, Default)]
pub(crate) struct MemoryStandingLog {
    rows: Vec<StandingChange>,
    next_seq: i64,
    pruned_through: i64,
    pub(crate) suspensions: HashMap<String, (i64, String, String)>,
    /// `operation_id -> (org, suspend)`, for replays.
    operations: HashMap<String, (String, bool)>,
}

impl MemoryStandingLog {
    pub(crate) fn record(
        &mut self,
        org_id: &str,
        user_id: Option<&str>,
        workspace_id: Option<&str>,
        kind: StandingChangeKind,
        now: i64,
    ) {
        self.next_seq += 1;
        self.rows.push(StandingChange {
            seq: self.next_seq,
            org_id: org_id.to_owned(),
            user_id: user_id.map(str::to_owned),
            workspace_id: workspace_id.map(str::to_owned),
            kind,
            created_at: now,
        });
    }

    pub(crate) fn page(&self, after: i64, limit: usize) -> StandingChangePage {
        StandingChangePage {
            rows: self
                .rows
                .iter()
                .filter(|row| row.seq > after)
                .take(limit)
                .cloned()
                .collect(),
            head: self.rows.last().map_or(0, |row| row.seq),
            pruned_through: self.pruned_through,
        }
    }

    pub(crate) fn prune(&mut self, created_before: i64) -> u64 {
        let before = self.rows.len();
        let mut pruned = self.pruned_through;
        self.rows.retain(|row| {
            let keep = row.created_at >= created_before;
            if !keep {
                pruned = pruned.max(row.seq);
            }
            keep
        });
        self.pruned_through = pruned;
        (before - self.rows.len()) as u64
    }

    pub(crate) fn suspended(&self, org_id: &str) -> bool {
        self.suspensions.contains_key(org_id)
    }

    pub(crate) fn set_suspension(
        &mut self,
        change: &OrgSuspensionChange,
        org_exists: bool,
    ) -> Result<OrgSuspensionOutcome, StoreError> {
        validate_suspension_change(change)?;
        if let Some((org, suspend)) = self.operations.get(&change.operation_id) {
            return if *org == change.org_id && *suspend == change.suspend {
                Ok(OrgSuspensionOutcome {
                    org_id: org.clone(),
                    suspended: *suspend,
                    changed: false,
                })
            } else {
                Err(StoreError::Policy(
                    "operation-id was already used for another change".into(),
                ))
            };
        }
        if !org_exists {
            return Err(StoreError::NotFound);
        }
        let was = self.suspended(&change.org_id);
        if change.suspend {
            self.suspensions.insert(
                change.org_id.clone(),
                (
                    change.now,
                    change.principal.clone(),
                    change.reason.trim().to_owned(),
                ),
            );
        } else {
            self.suspensions.remove(&change.org_id);
        }
        self.operations.insert(
            change.operation_id.clone(),
            (change.org_id.clone(), change.suspend),
        );
        let changed = was != change.suspend;
        if changed {
            let kind = if change.suspend {
                StandingChangeKind::OrgSuspended
            } else {
                StandingChangeKind::OrgResumed
            };
            self.record(&change.org_id, None, None, kind, change.now);
        }
        Ok(OrgSuspensionOutcome {
            org_id: change.org_id.clone(),
            suspended: change.suspend,
            changed,
        })
    }
}

// ── Retention ────────────────────────────────────────────────────────────────

/// Prune rows past retention once an interval, for as long as the server runs.
pub fn spawn_retention(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(STANDING_RETENTION_INTERVAL);
        loop {
            ticker.tick().await;
            let cutoff = (state.now)() - STANDING_RETENTION_MS;
            if let Err(error) = state.store.prune_standing_changes(cutoff).await {
                tracing::warn!(%error, "standing change retention failed; retrying next interval");
            }
        }
    })
}

// ── Suspension at the door ───────────────────────────────────────────────────

/// A short-lived view of which organizations are suspended. The operator
/// changes it from another process, so it is read from the store, at most
/// [`ORG_STATUS_TTL`] stale.
#[derive(Default)]
pub struct OrgStatusCache {
    entries: Mutex<HashMap<String, (Instant, bool)>>,
}

impl OrgStatusCache {
    pub async fn suspended(
        &self,
        store: &dyn crate::store::Store,
        org_id: &str,
    ) -> Result<bool, StoreError> {
        let now = Instant::now();
        if let Some((at, suspended)) = self.entries.lock().get(org_id) {
            if now.saturating_duration_since(*at) < ORG_STATUS_TTL {
                return Ok(*suspended);
            }
        }
        let suspended = store.org_suspended(org_id).await?;
        let mut entries = self.entries.lock();
        if entries.len() >= 4096 {
            entries.retain(|_, (at, _)| now.saturating_duration_since(*at) < ORG_STATUS_TTL);
        }
        entries.insert(org_id.to_owned(), (now, suspended));
        Ok(suspended)
    }
}

/// The refusal a suspended organization's members and Hosts receive.
pub fn org_suspended_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "org_suspended", "code": "org_suspended" })),
    )
        .into_response()
}

/// The organization a request names: its path (`/v1/orgs/{org}/…`,
/// `/internal/v1/orgs/{org}/…`) or, failing that, its verified grant.
fn requested_org(state: &AppState, path: &str, headers: &HeaderMap) -> Option<String> {
    let path_org = path
        .strip_prefix("/internal")
        .unwrap_or(path)
        .strip_prefix("/v1/orgs/")
        .and_then(|rest| rest.split('/').next())
        .filter(|org| !org.is_empty());
    if let Some(org) = path_org {
        return Some(org.to_owned());
    }
    let token = crate::auth::bearer_token(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
    )
    .ok()?;
    state
        .signer
        .verify::<cognia_tenant_auth::grant::GrantClaims>(token)
        .ok()
        .map(|claims| claims.org_id.to_string())
}

/// Refuse every request for a suspended organization before its route runs.
pub(crate) async fn refuse_suspended_orgs(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if let Some(org) = requested_org(&state, request.uri().path(), request.headers()) {
        match state.org_status.suspended(state.store.as_ref(), &org).await {
            Ok(false) => {}
            Ok(true) => return org_suspended_response(),
            Err(error) => {
                tracing::error!(%error, "organization status lookup failed");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({ "error": "storage unavailable" })),
                )
                    .into_response();
            }
        }
    }
    next.run(request).await
}

// ── The stream ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct StreamParams {
    after: Option<i64>,
}

/// Bounds the streams one server holds open.
#[derive(Default)]
pub struct StandingStreams {
    open: std::sync::atomic::AtomicUsize,
}

struct StreamSlot(Arc<StandingStreams>);
impl Drop for StreamSlot {
    fn drop(&mut self) {
        self.0
            .open
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl StandingStreams {
    fn take(self: &Arc<Self>) -> Option<StreamSlot> {
        let taken = self.open.try_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |open| (open < STANDING_STREAM_LIMIT).then_some(open + 1),
        );
        taken.ok().map(|_| StreamSlot(self.clone()))
    }
}

/// What one connection may see: the organizations its credential covers.
#[derive(Clone)]
pub(crate) struct StreamScope {
    hash: String,
    scopes: Option<crate::service_credentials::CredentialScopes>,
}

impl StreamScope {
    pub(crate) fn new(
        hash: String,
        scopes: Option<crate::service_credentials::CredentialScopes>,
    ) -> Self {
        Self { hash, scopes }
    }
    fn allows(&self, org: &str) -> bool {
        crate::service_credentials::allows(self.scopes.as_ref(), &self.hash, Some(org))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamFrame {
    Change {
        seq: i64,
        prev: i64,
        #[serde(flatten)]
        change: StandingChangeBody,
    },
    Heartbeat {
        seq: i64,
    },
    Resync {
        seq: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingChangeBody {
    pub org_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub kind: StandingChangeKind,
    pub at: i64,
}

/// One connection's position: what it has sent, and when it last spoke.
pub(crate) struct StreamCursor {
    /// The sequence of the last frame sent (or the cursor asked from).
    sent: i64,
    /// Every row through this sequence has been read.
    read_through: i64,
    started: bool,
}

impl StreamCursor {
    pub(crate) fn new(after: Option<i64>) -> Self {
        let after = after.filter(|after| *after >= 0);
        Self {
            sent: after.unwrap_or(-1),
            read_through: after.unwrap_or(-1),
            started: after.is_some(),
        }
    }

    /// The frames one read produces for this connection.
    pub(crate) fn advance(
        &mut self,
        page: &StandingChangePage,
        limit: usize,
        scope: &StreamScope,
    ) -> Vec<StreamFrame> {
        let mut frames = Vec::new();
        // A cursor that predates retention, is newer than this history (a
        // rebuilt database), or was never given cannot be answered with rows.
        if !self.started || self.read_through < page.pruned_through || self.read_through > page.head
        {
            self.started = true;
            self.sent = page.head;
            self.read_through = page.head;
            frames.push(StreamFrame::Resync { seq: page.head });
            return frames;
        }
        for row in &page.rows {
            if row.seq <= self.read_through {
                continue;
            }
            if scope.allows(&row.org_id) {
                frames.push(StreamFrame::Change {
                    seq: row.seq,
                    prev: self.sent,
                    change: StandingChangeBody {
                        org_id: row.org_id.clone(),
                        user_id: row.user_id.clone(),
                        workspace_id: row.workspace_id.clone(),
                        kind: row.kind,
                        at: row.created_at,
                    },
                });
                self.sent = row.seq;
            }
        }
        self.read_through = page
            .read_through(self.read_through, limit)
            .max(self.read_through);
        frames
    }

    /// A heartbeat that moves the Host's cursor over rows it was not shown.
    pub(crate) fn heartbeat(&mut self) -> StreamFrame {
        self.sent = self.read_through;
        StreamFrame::Heartbeat {
            seq: self.read_through,
        }
    }
}

fn frame_line(frame: &StreamFrame) -> bytes::Bytes {
    let mut line = serde_json::to_vec(frame).expect("standing frames serialize");
    line.push(b'\n');
    bytes::Bytes::from(line)
}

/// `GET /internal/v1/standing-changes?after=<seq>`.
pub(crate) async fn stream_standing_changes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<StreamParams>,
) -> Response {
    let hash = match crate::api::service_credential(&state, &headers) {
        Ok(hash) => hash,
        Err(response) => return response,
    };
    let Some(slot) = state.standing_streams.take() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "too many standing streams" })),
        )
            .into_response();
    };
    let scope = StreamScope::new(hash, state.internal_service_credential_scopes.clone());
    // The first read happens before the response starts, so a store outage
    // answers 503 instead of an empty stream.
    let mut cursor = StreamCursor::new(params.after);
    let first = match state
        .store
        .standing_changes_after(cursor_after(&cursor), STANDING_PAGE_LIMIT)
        .await
    {
        Ok(page) => page,
        Err(error) => {
            tracing::error!(%error, "standing change read failed");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "error": "storage unavailable" })),
            )
                .into_response();
        }
    };
    let opening: Vec<bytes::Bytes> = cursor
        .advance(&first, STANDING_PAGE_LIMIT, &scope)
        .iter()
        .map(frame_line)
        .collect();
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(64);
    tokio::spawn(async move {
        let _slot = slot;
        for line in opening {
            if sender.send(Ok(line)).await.is_err() {
                return;
            }
        }
        let mut last_spoke = Instant::now();
        loop {
            tokio::select! {
                _ = sender.closed() => return,
                _ = tokio::time::sleep(STANDING_POLL_INTERVAL) => {}
            }
            let page = match state
                .store
                .standing_changes_after(cursor_after(&cursor), STANDING_PAGE_LIMIT)
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    // End the stream: the Host reconnects and treats the gap
                    // as an outage.
                    tracing::warn!(%error, "standing change read failed; closing the stream");
                    return;
                }
            };
            let frames = cursor.advance(&page, STANDING_PAGE_LIMIT, &scope);
            let spoke = !frames.is_empty();
            for frame in &frames {
                if sender.send(Ok(frame_line(frame))).await.is_err() {
                    return;
                }
            }
            if spoke {
                last_spoke = Instant::now();
            } else if last_spoke.elapsed() >= STANDING_HEARTBEAT_INTERVAL {
                if sender
                    .send(Ok(frame_line(&cursor.heartbeat())))
                    .await
                    .is_err()
                {
                    return;
                }
                last_spoke = Instant::now();
            }
        }
    });
    let body = Body::from_stream(tokio_stream_from(receiver));
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/x-ndjson".parse().expect("static header"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response
}

fn cursor_after(cursor: &StreamCursor) -> i64 {
    cursor.read_through.max(0)
}

fn tokio_stream_from(
    mut receiver: tokio::sync::mpsc::Receiver<Result<bytes::Bytes, std::io::Error>>,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> {
    futures_util::stream::poll_fn(move |context| receiver.poll_recv(context))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(seq: i64, org: &str) -> StandingChange {
        StandingChange {
            seq,
            org_id: org.into(),
            user_id: Some("usr_a".into()),
            workspace_id: None,
            kind: StandingChangeKind::Offboarded,
            created_at: seq * 10,
        }
    }

    fn page(rows: Vec<StandingChange>, head: i64, pruned_through: i64) -> StandingChangePage {
        StandingChangePage {
            rows,
            head,
            pruned_through,
        }
    }

    fn all_orgs() -> StreamScope {
        StreamScope::new("h".into(), None)
    }

    #[test]
    fn kinds_round_trip_and_refuse_unknown_values() {
        for kind in [
            StandingChangeKind::Offboarded,
            StandingChangeKind::RoleChanged,
            StandingChangeKind::WorkspaceRemoved,
            StandingChangeKind::OrgSuspended,
            StandingChangeKind::OrgResumed,
        ] {
            assert_eq!(StandingChangeKind::parse(kind.as_str()).unwrap(), kind);
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::json!(kind.as_str())
            );
        }
        assert!(StandingChangeKind::parse("demoted").is_err());
    }

    #[test]
    fn a_new_or_unanswerable_cursor_resyncs_to_the_head() {
        let mut fresh = StreamCursor::new(None);
        assert_eq!(
            fresh.advance(&page(vec![row(4, "org_a")], 4, 0), 10, &all_orgs()),
            vec![StreamFrame::Resync { seq: 4 }]
        );
        // Older than retention.
        let mut old = StreamCursor::new(Some(2));
        assert_eq!(
            old.advance(&page(vec![row(6, "org_a")], 6, 3), 10, &all_orgs()),
            vec![StreamFrame::Resync { seq: 6 }]
        );
        // Newer than this history: the database was rebuilt.
        let mut ahead = StreamCursor::new(Some(90));
        assert_eq!(
            ahead.advance(&page(vec![], 5, 0), 10, &all_orgs()),
            vec![StreamFrame::Resync { seq: 5 }]
        );
        // A negative cursor is no cursor.
        let mut negative = StreamCursor::new(Some(-3));
        assert!(matches!(
            negative.advance(&page(vec![], 0, 0), 10, &all_orgs())[0],
            StreamFrame::Resync { seq: 0 }
        ));
    }

    #[test]
    fn rows_chain_by_prev_and_skip_other_orgs_without_breaking_the_chain() {
        let hash = "ab".repeat(32);
        let scopes: crate::service_credentials::CredentialScopes =
            [(hash.clone(), vec!["org_a".to_owned()])]
                .into_iter()
                .collect();
        let scope = StreamScope::new(hash, Some(scopes));
        let mut cursor = StreamCursor::new(Some(1));
        let frames = cursor.advance(
            &page(
                vec![row(2, "org_a"), row(3, "org_b"), row(5, "org_a")],
                5,
                0,
            ),
            10,
            &scope,
        );
        let chain: Vec<(i64, i64)> = frames
            .iter()
            .map(|frame| match frame {
                StreamFrame::Change { seq, prev, .. } => (*seq, *prev),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(chain, vec![(2, 1), (5, 2)]);
        // Rows another org owns move the read position, and a heartbeat
        // carries the Host's cursor over them.
        let quiet = cursor.advance(&page(vec![row(6, "org_b")], 6, 0), 10, &scope);
        assert!(quiet.is_empty());
        assert_eq!(cursor.heartbeat(), StreamFrame::Heartbeat { seq: 6 });
        let next = cursor.advance(&page(vec![row(7, "org_a")], 7, 0), 10, &scope);
        assert!(matches!(
            next[0],
            StreamFrame::Change {
                seq: 7,
                prev: 6,
                ..
            }
        ));
    }

    #[test]
    fn a_cut_off_page_reads_only_through_its_last_row() {
        let full = page(vec![row(2, "org_a"), row(3, "org_a")], 9, 0);
        assert_eq!(full.read_through(1, 2), 3);
        assert_eq!(full.read_through(1, 10), 9);
        let mut cursor = StreamCursor::new(Some(1));
        cursor.advance(&full, 2, &all_orgs());
        assert_eq!(cursor_after(&cursor), 3);
    }

    #[test]
    fn frames_are_one_json_object_per_line() {
        let line = frame_line(&StreamFrame::Change {
            seq: 3,
            prev: 1,
            change: StandingChangeBody {
                org_id: "org_a".into(),
                user_id: None,
                workspace_id: None,
                kind: StandingChangeKind::OrgSuspended,
                at: 7,
            },
        });
        assert_eq!(
            std::str::from_utf8(&line).unwrap(),
            "{\"type\":\"change\",\"seq\":3,\"prev\":1,\"orgId\":\"org_a\",\"kind\":\"org_suspended\",\"at\":7}\n"
        );
    }

    #[test]
    fn the_memory_log_records_prunes_and_replays_suspensions() {
        let mut log = MemoryStandingLog::default();
        log.record(
            "org_a",
            Some("usr_a"),
            None,
            StandingChangeKind::Offboarded,
            10,
        );
        log.record(
            "org_a",
            Some("usr_a"),
            Some("ws"),
            StandingChangeKind::WorkspaceRemoved,
            20,
        );
        assert_eq!(log.page(0, 10).rows.len(), 2);
        assert_eq!(log.prune(15), 1);
        assert_eq!(log.page(0, 10).pruned_through, 1);

        let change = |suspend: bool, op: &str| OrgSuspensionChange {
            org_id: "org_acme".into(),
            suspend,
            reason: "billing".into(),
            operation_id: op.into(),
            principal: "operator".into(),
            now: 30,
        };
        assert!(matches!(
            log.set_suspension(&change(true, "op-0"), false),
            Err(StoreError::NotFound)
        ));
        let suspended = log.set_suspension(&change(true, "op-1"), true).unwrap();
        assert!(suspended.suspended && suspended.changed && log.suspended("org_acme"));
        // A replay writes nothing; a reused id for another change is refused.
        assert!(
            !log.set_suspension(&change(true, "op-1"), true)
                .unwrap()
                .changed
        );
        assert!(log.set_suspension(&change(false, "op-1"), true).is_err());
        // Suspending twice records one change.
        assert!(
            !log.set_suspension(&change(true, "op-2"), true)
                .unwrap()
                .changed
        );
        let resumed = log.set_suspension(&change(false, "op-3"), true).unwrap();
        assert!(!resumed.suspended && resumed.changed && !log.suspended("org_acme"));
        let kinds: Vec<_> = log.page(0, 10).rows.iter().map(|row| row.kind).collect();
        assert_eq!(
            kinds,
            vec![
                StandingChangeKind::WorkspaceRemoved,
                StandingChangeKind::OrgSuspended,
                StandingChangeKind::OrgResumed
            ]
        );
        let mut bad = change(true, "op-4");
        bad.reason = " ".into();
        assert!(matches!(
            log.set_suspension(&bad, true),
            Err(StoreError::Policy(_))
        ));
    }
}
