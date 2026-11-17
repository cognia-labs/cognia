//! `cognia:plugin/logger` host import.
//!
//! One logger, two destinations. Every guest `log` call goes to the host's
//! structured tracing pipeline (where it is redacted with every other native
//! event), and, when the instance carries a [`WasmLogSink`], into a bounded
//! per-plugin history the desktop renderer drains for the plugin Dev Session's
//! Runtime logs card (`lib/plugin/wasm-bridge/log-buffer.ts`).
//!
//! # Generations
//!
//! A history belongs to one load of the plugin: [`WasmLogBuffer::begin_generation`]
//! runs when `WasmPluginHost::load` mints a generation and discards whatever the
//! previous load wrote. A line from an instance of an older generation (an
//! in-flight call that outlived a reload) is dropped instead of being filed
//! under the new one. Each record carries its generation and a sequence number
//! that starts at 1 per generation, so `(generation, sequence)` is unique and a
//! renderer can tell a missed event from a duplicate.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;

use super::super::bridge::WasmBridgeTransport;
use super::super::store::HostState;
use log::Level;

const MAX_SCOPE_CHARS: usize = 64;
const MAX_MESSAGE_CHARS: usize = 4_096;

/// Records kept per plugin. The oldest go first. Matches the renderer's own
/// bound (`WASM_LOG_LIMIT`), so a drain never returns more than it keeps.
pub const MAX_LOG_RECORDS_PER_PLUGIN: usize = 500;

/// Event the host emits for each recorded line (payload: [`WasmLogRecord`]).
pub const LOG_EVENT: &str = "plugin-wasm://log";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WasmLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl WasmLogLevel {
    pub fn as_log_level(self) -> Level {
        match self {
            Self::Trace => Level::Trace,
            Self::Debug => Level::Debug,
            Self::Info => Level::Info,
            Self::Warn => Level::Warn,
            Self::Error => Level::Error,
        }
    }
}

/// One guest log line as the renderer receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmLogRecord {
    pub plugin_id: String,
    pub generation: String,
    /// 1-based, per generation.
    pub sequence: u64,
    pub level: WasmLogLevel,
    pub scope: String,
    pub message: String,
    pub timestamp_ms: i64,
}

/// What `plugin_wasm_logs` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmLogDrain {
    /// The generation the host is recording for this plugin, or `None` when it
    /// has never been loaded in this process.
    pub generation: Option<String>,
    /// Records of that generation, oldest first.
    pub entries: Vec<WasmLogRecord>,
}

struct PluginLog {
    generation: String,
    last_sequence: u64,
    records: VecDeque<WasmLogRecord>,
}

impl PluginLog {
    fn new(generation: &str) -> Self {
        Self {
            generation: generation.to_string(),
            last_sequence: 0,
            records: VecDeque::new(),
        }
    }
}

/// Bounded per-plugin history of guest log lines. Owned by `WasmPluginState`.
pub struct WasmLogBuffer {
    capacity: usize,
    plugins: Mutex<HashMap<String, PluginLog>>,
    /// Where each new record is pushed. `None` on hosts without a renderer
    /// (headless), where the history is still kept for a drain.
    emitter: RwLock<Option<Arc<dyn WasmBridgeTransport>>>,
}

impl Default for WasmLogBuffer {
    fn default() -> Self {
        Self::with_capacity(MAX_LOG_RECORDS_PER_PLUGIN)
    }
}

impl WasmLogBuffer {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            plugins: Mutex::new(HashMap::new()),
            emitter: RwLock::new(None),
        }
    }

    pub fn set_emitter(&self, emitter: Option<Arc<dyn WasmBridgeTransport>>) {
        *self.emitter.write() = emitter;
    }

    /// Start the history of a new load. The previous generation's lines go.
    pub fn begin_generation(&self, plugin_id: &str, generation: &str) {
        let mut plugins = self.plugins.lock();
        let replace = plugins
            .get(plugin_id)
            .is_none_or(|log| log.generation != generation);
        if replace {
            plugins.insert(plugin_id.to_string(), PluginLog::new(generation));
        }
    }

    /// Append one line. Returns the stored record, or `None` when the line
    /// came from an instance of a generation that is no longer current.
    pub fn record(
        &self,
        plugin_id: &str,
        generation: &str,
        level: WasmLogLevel,
        scope: &str,
        message: &str,
    ) -> Option<WasmLogRecord> {
        let record = {
            let mut plugins = self.plugins.lock();
            let log = plugins
                .entry(plugin_id.to_string())
                .or_insert_with(|| PluginLog::new(generation));
            if log.generation != generation {
                return None;
            }
            log.last_sequence += 1;
            let record = WasmLogRecord {
                plugin_id: plugin_id.to_string(),
                generation: generation.to_string(),
                sequence: log.last_sequence,
                level,
                scope: scope.to_string(),
                message: message.to_string(),
                timestamp_ms: chrono::Utc::now().timestamp_millis(),
            };
            log.records.push_back(record.clone());
            while log.records.len() > self.capacity {
                log.records.pop_front();
            }
            record
        };
        // Emitted outside the history lock: a slow transport must not stall
        // another plugin's logging. A failed emit loses nothing, since the
        // renderer drains by sequence when it sees a gap.
        let emitter = self.emitter.read().clone();
        if let Some(emitter) = emitter {
            if let Ok(payload) = serde_json::to_value(&record) {
                let _ = emitter.emit(LOG_EVENT, payload);
            }
        }
        Some(record)
    }

    /// The current generation's records. `after_sequence` skips what the caller
    /// already holds, and applies only when `generation` names the current
    /// generation: a caller that asked about an older load gets the new one
    /// from its start.
    pub fn drain(
        &self,
        plugin_id: &str,
        generation: Option<&str>,
        after_sequence: Option<u64>,
    ) -> WasmLogDrain {
        let plugins = self.plugins.lock();
        let Some(log) = plugins.get(plugin_id) else {
            return WasmLogDrain {
                generation: None,
                entries: Vec::new(),
            };
        };
        let after = match generation {
            Some(requested) if requested == log.generation => after_sequence.unwrap_or(0),
            _ => 0,
        };
        WasmLogDrain {
            generation: Some(log.generation.clone()),
            entries: log
                .records
                .iter()
                .filter(|record| record.sequence > after)
                .cloned()
                .collect(),
        }
    }
}

/// The handle one instance logs through: the shared history plus the
/// generation that instance belongs to.
#[derive(Clone)]
pub struct WasmLogSink {
    buffer: Arc<WasmLogBuffer>,
    generation: String,
}

impl WasmLogSink {
    pub fn new(buffer: Arc<WasmLogBuffer>, generation: impl Into<String>) -> Self {
        Self {
            buffer,
            generation: generation.into(),
        }
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }
}

/// Pipe a guest log call into the host's structured tracing pipeline. Always
/// allowed (no capability required), but the host injects plugin identity,
/// bounds guest-controlled fields, and owns the only transport.
pub fn log(state: &HostState, level: WasmLogLevel, scope: &str, message: &str) {
    let scope = normalize_field(scope, MAX_SCOPE_CHARS);
    let message = normalize_field(message, MAX_MESSAGE_CHARS);
    let plugin_id = state.plugin_id.as_str();
    match level {
        WasmLogLevel::Trace => {
            tracing::trace!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Debug => {
            tracing::debug!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Info => {
            tracing::info!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Warn => {
            tracing::warn!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
        WasmLogLevel::Error => {
            tracing::error!(target: "cognia_plugin", plugin_id, plugin_scope = %scope, error_code = "plugin.log", message = %message)
        }
    }
    if let Some(sink) = &state.log_sink {
        sink.buffer
            .record(plugin_id, &sink.generation, level, &scope, &message);
    }
}

fn normalize_field(value: &str, max_chars: usize) -> String {
    let mut normalized = String::with_capacity(value.len().min(max_chars));
    for character in value.chars().take(max_chars) {
        normalized.push(if matches!(character, '\r' | '\n' | '\0') {
            ' '
        } else {
            character
        });
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::super::super::services::test_support::RecordingWasmBridgeTransport;
    use super::super::super::store::test_host_state;
    use super::*;

    #[test]
    fn log_levels_map_to_log_crate_levels() {
        assert_eq!(WasmLogLevel::Trace.as_log_level(), Level::Trace);
        assert_eq!(WasmLogLevel::Debug.as_log_level(), Level::Debug);
        assert_eq!(WasmLogLevel::Info.as_log_level(), Level::Info);
        assert_eq!(WasmLogLevel::Warn.as_log_level(), Level::Warn);
        assert_eq!(WasmLogLevel::Error.as_log_level(), Level::Error);
    }

    #[test]
    fn guest_fields_are_single_line_and_bounded_by_characters() {
        assert_eq!(normalize_field("a\r\nb\0c", 10), "a  b c");
        assert_eq!(normalize_field("日志事件", 2), "日志");
        assert_eq!(normalize_field(&"x".repeat(100), 64).len(), 64);
    }

    #[test]
    fn records_carry_generation_and_a_per_generation_sequence() {
        let buffer = WasmLogBuffer::default();
        buffer.begin_generation("demo", "g1");
        let first = buffer
            .record("demo", "g1", WasmLogLevel::Info, "init", "hello")
            .unwrap();
        let second = buffer
            .record("demo", "g1", WasmLogLevel::Warn, "init", "careful")
            .unwrap();
        assert_eq!((first.generation.as_str(), first.sequence), ("g1", 1));
        assert_eq!((second.generation.as_str(), second.sequence), ("g1", 2));
        assert_eq!(second.level, WasmLogLevel::Warn);
        assert!(second.timestamp_ms >= first.timestamp_ms);
    }

    #[test]
    fn a_new_generation_discards_the_previous_history_and_restarts_the_sequence() {
        let buffer = WasmLogBuffer::default();
        buffer.begin_generation("demo", "g1");
        buffer.record("demo", "g1", WasmLogLevel::Info, "", "old");
        buffer.begin_generation("demo", "g2");
        let drain = buffer.drain("demo", None, None);
        assert_eq!(drain.generation.as_deref(), Some("g2"));
        assert!(drain.entries.is_empty(), "g1 lines must not reach g2");
        let next = buffer
            .record("demo", "g2", WasmLogLevel::Info, "", "new")
            .unwrap();
        assert_eq!(next.sequence, 1);
    }

    #[test]
    fn beginning_the_current_generation_again_keeps_its_history() {
        let buffer = WasmLogBuffer::default();
        buffer.begin_generation("demo", "g1");
        buffer.record("demo", "g1", WasmLogLevel::Info, "", "kept");
        buffer.begin_generation("demo", "g1");
        assert_eq!(buffer.drain("demo", None, None).entries.len(), 1);
    }

    #[test]
    fn a_stale_instance_cannot_write_into_the_next_generation() {
        let buffer = WasmLogBuffer::default();
        buffer.begin_generation("demo", "g2");
        assert!(buffer
            .record("demo", "g1", WasmLogLevel::Error, "", "late line from g1")
            .is_none());
        assert!(buffer.drain("demo", None, None).entries.is_empty());
    }

    #[test]
    fn history_is_bounded_and_drops_the_oldest() {
        let buffer = WasmLogBuffer::with_capacity(3);
        buffer.begin_generation("demo", "g1");
        for index in 0..5 {
            buffer.record("demo", "g1", WasmLogLevel::Info, "", &format!("line {index}"));
        }
        let drain = buffer.drain("demo", Some("g1"), None);
        let sequences: Vec<u64> = drain.entries.iter().map(|r| r.sequence).collect();
        assert_eq!(sequences, vec![3, 4, 5]);
        assert_eq!(MAX_LOG_RECORDS_PER_PLUGIN, 500);
    }

    #[test]
    fn drain_skips_what_the_caller_holds_only_for_the_current_generation() {
        let buffer = WasmLogBuffer::default();
        buffer.begin_generation("demo", "g2");
        for _ in 0..3 {
            buffer.record("demo", "g2", WasmLogLevel::Info, "", "x");
        }
        let after = buffer.drain("demo", Some("g2"), Some(2));
        assert_eq!(after.entries.iter().map(|r| r.sequence).collect::<Vec<_>>(), vec![3]);
        // A caller still on g1 gets g2 from its start, not "after 2".
        let stale = buffer.drain("demo", Some("g1"), Some(2));
        assert_eq!(stale.generation.as_deref(), Some("g2"));
        assert_eq!(stale.entries.len(), 3);
    }

    #[test]
    fn drain_for_an_unknown_plugin_names_no_generation() {
        let buffer = WasmLogBuffer::default();
        assert_eq!(
            buffer.drain("never-loaded", None, None),
            WasmLogDrain {
                generation: None,
                entries: Vec::new()
            }
        );
    }

    #[test]
    fn histories_are_per_plugin() {
        let buffer = WasmLogBuffer::default();
        buffer.begin_generation("a", "ga");
        buffer.begin_generation("b", "gb");
        buffer.record("a", "ga", WasmLogLevel::Info, "", "from a");
        assert_eq!(buffer.drain("a", None, None).entries.len(), 1);
        assert!(buffer.drain("b", None, None).entries.is_empty());
    }

    #[test]
    fn each_record_is_emitted_with_its_identity() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let buffer = WasmLogBuffer::default();
        buffer.set_emitter(Some(transport.clone()));
        buffer.begin_generation("demo", "g1");
        buffer.record("demo", "g1", WasmLogLevel::Debug, "scope", "message");
        let frames = transport.frames_for(LOG_EVENT);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["pluginId"], "demo");
        assert_eq!(frames[0]["generation"], "g1");
        assert_eq!(frames[0]["sequence"], 1);
        assert_eq!(frames[0]["level"], "debug");
        assert_eq!(frames[0]["scope"], "scope");
        assert_eq!(frames[0]["message"], "message");
        assert!(frames[0]["timestampMs"].as_i64().is_some());
    }

    #[test]
    fn a_failing_emitter_still_keeps_the_record_for_a_drain() {
        let buffer = WasmLogBuffer::default();
        buffer.set_emitter(Some(Arc::new(RecordingWasmBridgeTransport::failing())));
        buffer.begin_generation("demo", "g1");
        assert!(buffer
            .record("demo", "g1", WasmLogLevel::Info, "", "kept")
            .is_some());
        assert_eq!(buffer.drain("demo", Some("g1"), None).entries.len(), 1);
    }

    #[test]
    fn a_guest_log_call_reaches_the_sink_bounded_and_single_line() {
        let buffer = Arc::new(WasmLogBuffer::default());
        buffer.begin_generation("demo", "g1");
        let mut state = test_host_state("demo", &[]);
        state.log_sink = Some(WasmLogSink::new(buffer.clone(), "g1"));
        log(&state, WasmLogLevel::Error, "io", &format!("a\nb{}", "x".repeat(5_000)));
        let drain = buffer.drain("demo", Some("g1"), None);
        assert_eq!(drain.entries.len(), 1);
        let record = &drain.entries[0];
        assert_eq!(record.level, WasmLogLevel::Error);
        assert_eq!(record.scope, "io");
        assert!(record.message.starts_with("a b"));
        assert_eq!(record.message.chars().count(), MAX_MESSAGE_CHARS);
    }

    #[test]
    fn a_guest_log_call_without_a_sink_records_nothing() {
        // Headless test stores and throw-away call stores that were built
        // without a sink still log to tracing; nothing else must panic.
        let state = test_host_state("demo", &[]);
        assert!(state.log_sink.is_none());
        log(&state, WasmLogLevel::Info, "", "tracing only");
    }
}
