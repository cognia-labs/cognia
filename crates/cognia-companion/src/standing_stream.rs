//! The Host's subscription to the collaboration plane's standing changes —
//! ADR-0253 §2.
//!
//! `GET /internal/v1/standing-changes?after=<seq>` is NDJSON: `change` frames
//! chained by `prev`, `heartbeat` frames that move the cursor over rows this
//! Host's credential may not see, and `resync` when the cursor cannot be
//! answered. The cursor is kept in the Host's data directory, so a restart
//! resumes where it stopped.
//!
//! A `resync`, a `prev` that is not this Host's cursor, an unknown change kind
//! and a reconnect after an outage all flush the standing authority: it
//! forgets every cached answer and re-checks everyone active. While the
//! stream is down, the five-second cache and the 30-second sweep keep
//! correctness; the stream only makes a change land sooner.
use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::standing::{ChangeKind, StandingChange};

/// The plane heartbeats every 15 seconds; three missed ones end the stream.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(45);
/// One frame is a few hundred bytes; anything this long is not a frame.
const LINE_LIMIT: usize = 64 * 1024;
const BACKOFF_FIRST: Duration = Duration::from_secs(1);
const BACKOFF_LIMIT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Frame {
    Change {
        seq: i64,
        prev: i64,
        #[serde(rename = "orgId")]
        org_id: String,
        #[serde(rename = "userId", default)]
        user_id: Option<String>,
        #[serde(rename = "workspaceId", default)]
        workspace_id: Option<String>,
        kind: String,
    },
    Heartbeat {
        seq: i64,
    },
    Resync {
        seq: i64,
    },
    /// A frame type a newer plane added: skipped, so the stream keeps going.
    #[serde(other)]
    Unknown,
}

/// What one frame asks of the authority.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Notice(StandingChange),
    Flush,
}

/// Where this Host is in the plane's sequence.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StreamPosition {
    pub cursor: Option<i64>,
}

impl StreamPosition {
    /// Read one NDJSON line. An unreadable line is a fault in the stream:
    /// `Err` ends the connection, and the reconnect flushes.
    pub fn accept(&mut self, line: &[u8]) -> Result<Vec<Step>, String> {
        let frame: Frame = serde_json::from_slice(line).map_err(|error| error.to_string())?;
        Ok(match frame {
            Frame::Change { seq, prev, org_id, user_id, workspace_id, kind } => {
                let mut steps = Vec::new();
                // A frame between this Host's cursor and this one was missed.
                if self.cursor != Some(prev) {
                    steps.push(Step::Flush);
                }
                self.cursor = Some(seq);
                match ChangeKind::parse(&kind) {
                    Some(kind) => steps.push(Step::Notice(StandingChange { org: org_id, user: user_id, workspace: workspace_id, kind })),
                    // A kind this Host does not know may reduce standing in a
                    // way it cannot apply; forgetting everything is safe.
                    None if steps.is_empty() => steps.push(Step::Flush),
                    None => {}
                }
                steps
            }
            Frame::Heartbeat { seq } => {
                self.cursor = Some(seq);
                Vec::new()
            }
            Frame::Resync { seq } => {
                self.cursor = Some(seq);
                vec![Step::Flush]
            }
            Frame::Unknown => Vec::new(),
        })
    }
}

/// The cursor file, `<data>/companion/standing-cursor.json`.
pub struct CursorFile(PathBuf);

#[derive(Serialize, Deserialize)]
struct StoredCursor {
    seq: i64,
}

impl CursorFile {
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self(data_dir.join("companion").join("standing-cursor.json"))
    }

    /// A missing or unreadable cursor starts from a `resync`.
    pub fn load(&self) -> Option<i64> {
        let bytes = std::fs::read(&self.0).ok()?;
        serde_json::from_slice::<StoredCursor>(&bytes).ok().map(|cursor| cursor.seq).filter(|seq| *seq >= 0)
    }

    pub fn store(&self, seq: i64) -> std::io::Result<()> {
        let parent = self.0.parent().ok_or_else(|| std::io::Error::other("cursor path has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec(&StoredCursor { seq }).map_err(std::io::Error::other)?)?;
        file.as_file().sync_all()?;
        file.persist(&self.0).map_err(|error| error.error)?;
        Ok(())
    }
}

/// What the stream applies its steps to: the standing authority, or a test's
/// recorder.
#[async_trait::async_trait]
pub trait StandingSink: Send + Sync {
    async fn notice(&self, change: &StandingChange);
    async fn flush(&self);
}

#[async_trait::async_trait]
impl StandingSink for crate::standing::StandingAuthority {
    async fn notice(&self, change: &StandingChange) {
        crate::standing::StandingAuthority::notice(self, change).await;
    }
    async fn flush(&self) {
        crate::standing::StandingAuthority::flush(self).await;
    }
}

/// How one connection ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The plane closed the stream.
    Closed,
    /// Nothing arrived for [`SILENCE_LIMIT`].
    Silent,
    /// A transport error or an unreadable frame.
    Fault(String),
}

/// Apply one connection's frames until it ends, storing the cursor after
/// every frame that moved it.
pub async fn pump<S, E>(mut chunks: S, position: &mut StreamPosition, cursor: &CursorFile,
    sink: &dyn StandingSink, silence: Duration) -> Ended
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = match tokio::time::timeout(silence, chunks.next()).await {
            Err(_) => return Ended::Silent,
            Ok(None) => return Ended::Closed,
            Ok(Some(Err(error))) => return Ended::Fault(error.to_string()),
            Ok(Some(Ok(chunk))) => chunk,
        };
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = &line[..line.len() - 1];
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let before = position.cursor;
            let steps = match position.accept(line) {
                Ok(steps) => steps,
                Err(error) => return Ended::Fault(format!("unreadable standing frame: {error}")),
            };
            for step in steps {
                match step {
                    Step::Flush => sink.flush().await,
                    Step::Notice(change) => sink.notice(&change).await,
                }
            }
            if position.cursor != before {
                if let Some(seq) = position.cursor {
                    let file = cursor.0.clone();
                    let stored = tokio::task::spawn_blocking(move || CursorFile(file).store(seq)).await;
                    if let Err(error) = stored.map_err(std::io::Error::other).and_then(|stored| stored) {
                        log::warn!("standing stream: cursor not stored: {error}");
                    }
                }
            }
        }
        if buffer.len() > LINE_LIMIT {
            return Ended::Fault("standing frame exceeds its size bound".into());
        }
    }
}

/// Follow the plane's stream for the life of the process. Started by a
/// multi-tenant Host that has a collaboration plane configured.
pub fn spawn(data_dir: PathBuf) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let cursor = CursorFile::in_data_dir(&data_dir);
        let mut position = StreamPosition { cursor: cursor.load() };
        let authority = crate::standing::authority();
        let mut backoff = BACKOFF_FIRST;
        let mut connected_before = false;
        loop {
            match crate::workspace_access::open_standing_changes(position.cursor).await {
                Ok(response) => {
                    // Whatever changed while this Host was not listening may
                    // have been pruned before it reconnected.
                    if connected_before {
                        authority.flush().await;
                    }
                    connected_before = true;
                    let opened = tokio::time::Instant::now();
                    let before = position.cursor;
                    let ended = pump(response.bytes_stream(), &mut position, &cursor, authority, SILENCE_LIMIT).await;
                    log::info!("standing stream ended: {ended:?}");
                    // Only a connection that worked earns a quick retry: one
                    // that fails at once would otherwise reconnect, and flush,
                    // every second.
                    if position.cursor != before || opened.elapsed() >= SILENCE_LIMIT {
                        backoff = BACKOFF_FIRST;
                    }
                }
                Err(error) => log::warn!("standing stream unavailable: {error}"),
            }
            tokio::time::sleep(jittered(backoff)).await;
            backoff = (backoff * 2).min(BACKOFF_LIMIT);
        }
    })
}

fn jittered(delay: Duration) -> Duration {
    let spread = delay.as_millis() as u64 / 4;
    if spread == 0 {
        return delay;
    }
    delay + Duration::from_millis(rand_below(spread))
}

fn rand_below(bound: u64) -> u64 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos() as u64;
    nanos % bound
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    #[async_trait::async_trait]
    impl StandingSink for Recorder {
        async fn notice(&self, change: &StandingChange) {
            self.0.lock().push(format!("{:?}:{}:{}", change.kind, change.org, change.user.clone().unwrap_or_default()));
        }
        async fn flush(&self) {
            self.0.lock().push("flush".into());
        }
    }

    fn chunks(parts: &[&str]) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Unpin {
        futures_util::stream::iter(parts.iter().map(|part| Ok(Bytes::from(part.to_string()))).collect::<Vec<_>>())
    }

    fn change(seq: i64, prev: i64, kind: &str) -> String {
        format!("{{\"type\":\"change\",\"seq\":{seq},\"prev\":{prev},\"orgId\":\"org_a\",\"userId\":\"usr_a\",\"kind\":\"{kind}\",\"at\":1}}\n")
    }

    #[tokio::test]
    async fn a_chained_stream_applies_in_order_and_stores_its_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let cursor = CursorFile::in_data_dir(directory.path());
        let recorder = Recorder::default();
        let mut position = StreamPosition { cursor: Some(4) };
        let first = change(5, 4, "offboarded");
        // A frame split across chunks, and two frames in one.
        let (head, tail) = first.split_at(20);
        let rest = format!("{}{}", change(9, 5, "role_changed"), "{\"type\":\"heartbeat\",\"seq\":12}\n");
        let ended = pump(chunks(&[head, tail, &rest]), &mut position, &cursor, &recorder, SILENCE_LIMIT).await;
        assert_eq!(ended, Ended::Closed);
        assert_eq!(recorder.0.lock().clone(), vec!["Offboarded:org_a:usr_a", "RoleChanged:org_a:usr_a"]);
        assert_eq!(position.cursor, Some(12));
        assert_eq!(cursor.load(), Some(12));
        // The next change chains from the heartbeat.
        let ended = pump(chunks(&[&change(13, 12, "workspace_removed"), "{\"type\":\"telemetry\",\"load\":1}\n"]), &mut position, &cursor, &recorder, SILENCE_LIMIT).await;
        assert_eq!(ended, Ended::Closed);
        assert_eq!(recorder.0.lock().last().unwrap(), "WorkspaceRemoved:org_a:usr_a");
        assert_eq!(cursor.load(), Some(13));
    }

    #[tokio::test]
    async fn a_gap_a_resync_or_an_unknown_kind_flushes() {
        let directory = tempfile::tempdir().unwrap();
        let cursor = CursorFile::in_data_dir(directory.path());
        let recorder = Recorder::default();
        let mut position = StreamPosition { cursor: Some(4) };
        let frames = format!("{}{}{}", change(8, 6, "offboarded"), "{\"type\":\"resync\",\"seq\":30}\n", change(31, 30, "mystery"));
        pump(chunks(&[&frames]), &mut position, &cursor, &recorder, SILENCE_LIMIT).await;
        assert_eq!(recorder.0.lock().clone(), vec!["flush", "Offboarded:org_a:usr_a", "flush", "flush"]);
        assert_eq!(cursor.load(), Some(31));
        // No cursor at all: the first change cannot chain.
        let mut fresh = StreamPosition::default();
        assert_eq!(fresh.accept(change(2, 1, "org_resumed").trim().as_bytes()).unwrap()[0], Step::Flush);
    }

    #[tokio::test]
    async fn silence_faults_and_oversized_lines_end_the_connection() {
        let directory = tempfile::tempdir().unwrap();
        let cursor = CursorFile::in_data_dir(directory.path());
        let recorder = Recorder::default();
        let mut position = StreamPosition { cursor: Some(1) };
        let silent = futures_util::stream::pending::<Result<Bytes, std::io::Error>>();
        assert_eq!(pump(silent, &mut position, &cursor, &recorder, Duration::from_millis(20)).await, Ended::Silent);
        assert!(matches!(pump(chunks(&["not json\n"]), &mut position, &cursor, &recorder, SILENCE_LIMIT).await, Ended::Fault(_)));
        let huge = "x".repeat(LINE_LIMIT + 1);
        assert!(matches!(pump(chunks(&[&huge]), &mut position, &cursor, &recorder, SILENCE_LIMIT).await, Ended::Fault(_)));
        let broken = futures_util::stream::iter(vec![Err::<Bytes, _>(std::io::Error::other("reset"))]);
        assert_eq!(pump(broken, &mut position, &cursor, &recorder, SILENCE_LIMIT).await, Ended::Fault("reset".into()));
        assert!(recorder.0.lock().is_empty());
        assert_eq!(cursor.load(), None);
    }

    #[test]
    fn the_cursor_survives_a_restart_and_a_damaged_file_starts_over() {
        let directory = tempfile::tempdir().unwrap();
        let cursor = CursorFile::in_data_dir(directory.path());
        assert_eq!(cursor.load(), None);
        cursor.store(77).unwrap();
        assert_eq!(CursorFile::in_data_dir(directory.path()).load(), Some(77));
        std::fs::write(directory.path().join("companion/standing-cursor.json"), b"{").unwrap();
        assert_eq!(cursor.load(), None);
        assert!(jittered(Duration::from_secs(4)) >= Duration::from_secs(4));
        assert!(jittered(Duration::from_secs(4)) < Duration::from_secs(5));
    }
}
