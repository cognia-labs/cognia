//! P5 server-only process fleet. Reuses BrainSupervisor, including its crash
//! backoff and shutdown. The companion owns admission and the task-local;
//! this module owns keys, capacity, process lifetime and operator purge.
use std::{collections::BTreeMap, sync::{Arc, atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering}}, time::Duration};
use cognia_companion::{person_partition::{PersonPartition, PersonBrainAuthority, PersonBrainFleet, PersonBrainStatus, PersonReceiptScope, PersonRequest}, ws_bridge, SharedState};
use tokio::{sync::{watch, Mutex}, task::JoinHandle};
use crate::brain::{BrainConfig, BrainSupervisor};

const METADATA_SERVICE: &str = "com.cognia.person-brains";
const CONTENT_KEY_SERVICE: &str = "com.cognia.account-content";

#[derive(serde::Serialize, serde::Deserialize)]
struct Metadata {
    org: String, user: String, #[serde(default)] data_generation: Option<String>,
    /// ADR-0253 §6: set before a purge removes anything, cleared only by the
    /// purge's last step. A Host that restarts mid-purge resumes it at boot,
    /// and nothing starts the person meanwhile.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")] purging: bool,
}
struct Usage {
    in_flight: AtomicUsize,
    last_used_ms: AtomicI64,
    /// When the brain last reported a run of its own (not persisted). A member
    /// agent turn outlives the request that started it, so `in_flight` alone
    /// would let the reaper or an eviction stop the brain mid-turn.
    last_busy_ms: AtomicI64,
}
impl Usage {
    fn last_active_ms(&self) -> i64 {
        self.last_used_ms.load(Ordering::SeqCst).max(self.last_busy_ms.load(Ordering::SeqCst))
    }
}
struct RequestGuard(Arc<Usage>, PersonReceiptScope);
impl PersonRequest for RequestGuard { fn receipt_scope(&self) -> PersonReceiptScope { self.1.clone() } }
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.last_used_ms.store(now_ms(), Ordering::SeqCst);
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}
struct Entry {
    person: PersonPartition,
    usage: Arc<Usage>,
    supervisor: Option<Arc<BrainSupervisor>>,
    task: Option<JoinHandle<()>>,
    persisted_last_used_ms: i64,
    /// Flips to `true` once a stopped brain's process has been joined. Until
    /// then its data directory and socket slot are still its own.
    stopped: Option<watch::Receiver<bool>>,
    /// Set while an operator purge removes this person; nothing starts them.
    purging: Arc<AtomicBool>,
}
impl Entry {
    /// Signal the brain to stop and join it in the background, so no caller
    /// waits for a child process while holding the fleet's lock. The returned
    /// receiver turns `true` when the brain is gone.
    fn begin_stop(&mut self) -> Option<watch::Receiver<bool>> {
        if let Some(supervisor) = self.supervisor.take() { supervisor.shutdown(); }
        if let Some(task) = self.task.take() {
            let (done, stopped) = watch::channel(false);
            let account = self.person.account_id.clone();
            tokio::spawn(async move {
                let _ = task.await;
                ws_bridge::disconnect_account(&account);
                let _ = done.send(true);
            });
            self.stopped = Some(stopped);
        }
        self.pending_stop()
    }
    /// The stop still in progress, if any.
    fn pending_stop(&self) -> Option<watch::Receiver<bool>> {
        self.stopped.as_ref().filter(|stopped| !*stopped.borrow()).cloned()
    }
    /// Whether this entry still holds a brain: running, or stopping.
    fn occupies_slot(&self) -> bool { self.task.is_some() || self.pending_stop().is_some() }
}
async fn wait_stopped(stopped: Option<watch::Receiver<bool>>) {
    // A joiner that went away with the runtime has nothing left to wait for.
    if let Some(mut stopped) = stopped { let _ = stopped.wait_for(|done| *done).await; }
}
/// Clears a purge's marker however the purge ends, including cancellation,
/// until the purge has recorded itself durably: from then on only a finished
/// purge (which removes the entry) lets the person start again.
struct PurgeMarker { flag: Arc<AtomicBool>, durable: bool }
impl Drop for PurgeMarker { fn drop(&mut self) { if !self.durable { self.flag.store(false, Ordering::SeqCst); } } }
/// What one locked pass of `acquire` decided.
enum Admission { Ready(RequestGuard), Wait(watch::Receiver<bool>) }

pub struct Fleet {
    template: BrainConfig,
    state: SharedState,
    ledger: Arc<cognia_companion::security_store::SecurityStore>,
    entries: Mutex<BTreeMap<String, Entry>>,
    // Snapshots never block an HTTP /healthz reader on lifecycle I/O.
    snapshots: parking_lot::RwLock<Vec<PersonBrainStatus>>,
    people: parking_lot::RwLock<BTreeMap<String, PersonPartition>>,
    active_accounts: parking_lot::RwLock<BTreeMap<String, Arc<PersonBrainAuthority>>>,
    data_scopes: parking_lot::RwLock<BTreeMap<String, PersonReceiptScope>>,
    /// People whose purge a previous run of the Host recorded but did not
    /// finish; [`Fleet::resume_interrupted_purges`] takes them once.
    interrupted_purges: parking_lot::Mutex<Vec<PersonPartition>>,
    idle: Duration,
    maximum: usize,
    stopping: AtomicBool,
    person_exec: Arc<dyn cognia_external_agent::exec_backend::ExecBackend>,
    /// Tests stand in for the wired runtime's binding root.
    #[cfg(test)]
    records_root: parking_lot::Mutex<Option<std::path::PathBuf>>,
}
fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }
/// Whether the account's brain says it is running something: its member agent
/// turns hold execution-broker leases, and the count rides each heartbeat pong.
/// A report gone stale reads as not running, so a hung brain is still reaped.
fn reports_runs(account_id: &str, now: i64) -> bool {
    ws_bridge::account_activity(account_id).and_then(|report| report.fresh_runs(now)).is_some_and(|runs| runs > 0)
}
fn positive_env(name: &str, default: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Ok(value) => value.parse::<u64>().ok().filter(|n| *n > 0).ok_or_else(|| format!("{name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(_) => Err(format!("{name} is not valid Unicode")),
    }
}
fn valid_account(id: &str) -> bool {
    id.len() == 27 && id.starts_with("pb_") && id[3..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Fleet {
    /// Where the spawn path persisted execution records and workspace mounts:
    /// the runtime's binding root (`<data>/.cognia` on the server), not the
    /// brain template's data dir. None means no binding store, so no person
    /// run was ever admitted and only the backend scan can find one.
    fn execution_records_root(&self) -> Option<std::path::PathBuf> {
        #[cfg(test)]
        if let Some(root) = self.records_root.lock().clone() { return Some(root); }
        self.state.runtime.execution_binding_root(&self.state)
    }
    pub fn new(template: BrainConfig, state: SharedState) -> Result<Arc<Self>, String> {
        cognia_external_agent::person_workspace::person_workspace_max_bytes()?;
        Self::with_limits(template, state, Duration::from_secs(positive_env("COGNIA_PERSON_BRAIN_IDLE_SECS", 900)?),
            usize::try_from(positive_env("COGNIA_PERSON_BRAINS_MAX", 8)?).map_err(|_| "person brain cap is too large")?,
            cognia_companion::security_store::security_store().ok_or("person receipt ledger unavailable")?,
            cognia_companion_rpc::headless::headless_services().ok_or("person execution backend unavailable")?.exec.clone())
    }
    fn with_limits(template: BrainConfig, state: SharedState, idle: Duration, maximum: usize,
        ledger: Arc<cognia_companion::security_store::SecurityStore>,
        person_exec: Arc<dyn cognia_external_agent::exec_backend::ExecBackend>) -> Result<Arc<Self>, String> {
        if valid_account(&template.account_id) { return Err("operator account uses the reserved person namespace".into()); }
        let mut entries = BTreeMap::new();
        let mut data_scopes = BTreeMap::new();
        let mut interrupted_purges = Vec::new();
        let root = template.data_dir.join("persons");
        if root.exists() {
            for directory in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
                let directory = directory.map_err(|e| e.to_string())?;
                let account = directory.file_name().to_string_lossy().into_owned();
                if !valid_account(&account) { continue; }
                if let Some(value) = cognia_secrets::secret_store::get(METADATA_SERVICE, &account)? {
                    let metadata: Metadata = serde_json::from_str(&value).map_err(|e| e.to_string())?;
                    let person = PersonPartition::new(metadata.org, metadata.user);
                    if person.account_id != account { return Err("person partition identity mismatch".into()); }
                    if let Some(generation) = metadata.data_generation {
                        uuid::Uuid::parse_str(&generation).map_err(|_| "invalid person data generation")?;
                        data_scopes.insert(account.clone(), PersonReceiptScope { account_id: account.clone(), data_generation: generation });
                    }
                    let last = std::fs::read_to_string(directory.path().join("last-used"))
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
                    let entry = Self::entry(person.clone(), last);
                    if metadata.purging {
                        entry.purging.store(true, Ordering::SeqCst);
                        interrupted_purges.push(person);
                    }
                    entries.insert(account, entry);
                }
            }
        }
        let people = entries.iter().map(|(account, entry)| (account.clone(), entry.person.clone())).collect();
        let fleet = Arc::new(Self { template, state, ledger, entries: Mutex::new(entries), snapshots: Default::default(),
            people: parking_lot::RwLock::new(people), active_accounts: Default::default(), data_scopes: parking_lot::RwLock::new(data_scopes),
            interrupted_purges: parking_lot::Mutex::new(interrupted_purges), idle, maximum, stopping: AtomicBool::new(false), person_exec,
            #[cfg(test)] records_root: Default::default() });
        Ok(fleet)
    }
    fn entry(person: PersonPartition, last: i64) -> Entry {
        Entry { person, usage: Arc::new(Usage { in_flight: AtomicUsize::new(0), last_used_ms: AtomicI64::new(last), last_busy_ms: AtomicI64::new(0) }), supervisor: None, task: None, persisted_last_used_ms: last,
            stopped: None, purging: Arc::new(AtomicBool::new(false)) }
    }
    pub fn start_idle_reaper(self: &Arc<Self>) -> JoinHandle<()> {
        let fleet = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(fleet) = fleet.upgrade() else { break; };
                if fleet.stopping.load(Ordering::SeqCst) { break; }
                fleet.reap().await;
            }
        })
    }
    /// Finish the purges a previous run of the Host recorded but did not
    /// complete (ADR-0253 §6). Each runs on its own task; one that fails again
    /// stays recorded, keeps its person from starting, and is retried at the
    /// next boot or by the operator.
    pub fn resume_interrupted_purges(self: &Arc<Self>) {
        let people = std::mem::take(&mut *self.interrupted_purges.lock());
        for person in people {
            let fleet = Arc::clone(self);
            tokio::spawn(async move {
                match fleet.purge(&person).await {
                    Ok(()) => log::info!("resumed person partition purge finished: {}", person.account_id),
                    Err(code) => log::error!("resumed person partition purge failed ({code}): {}", person.account_id),
                }
            });
        }
    }
    /// Record the purge durably before anything is removed.
    fn record_purge(&self, person: &PersonPartition) -> Result<(), &'static str> {
        let root = self.template.data_dir.join("persons").join(&person.account_id);
        // The boot scan finds a recorded purge through the partition directory.
        std::fs::create_dir_all(&root).map_err(|_| "person_storage_failed")?;
        let data_generation = self.data_scopes.read().get(&person.account_id).map(|scope| scope.data_generation.clone());
        let metadata = serde_json::to_string(&Metadata { org: person.org_id.clone(), user: person.user_id.clone(), data_generation, purging: true })
            .map_err(|_| "person_storage_failed")?;
        cognia_secrets::secret_store::set(METADATA_SERVICE, &person.account_id, &metadata).map_err(|_| "person_storage_failed")
    }
    fn refresh(&self, entries: &BTreeMap<String, Entry>) {
        *self.snapshots.write() = entries.values().map(|entry| PersonBrainStatus {
            account_id: entry.person.account_id.clone(), last_used_ms: entry.usage.last_used_ms.load(Ordering::SeqCst),
            running: entry.supervisor.as_ref().is_some_and(|sup| sup.status().running),
            parked: entry.supervisor.as_ref().is_some_and(|sup| sup.status().parked),
            restart_count: entry.supervisor.as_ref().map_or(0, |sup| sup.status().restart_count),
            ready: ws_bridge::account_connected(&entry.person.account_id), in_flight: entry.usage.in_flight.load(Ordering::SeqCst),
            rss_bytes: ws_bridge::account_rss_bytes(&entry.person.account_id),
        }).collect();
    }
    /// Revoke the brain's bridge authority now and begin stopping it; await
    /// the result with [`wait_stopped`] after releasing the lock.
    fn stop_entry(&self, entry: &mut Entry) -> Option<watch::Receiver<bool>> {
        if let Some(authority) = self.active_accounts.write().remove(&entry.person.account_id) { authority.stop(); }
        entry.begin_stop()
    }

    fn persist_usage(&self, entry: &mut Entry) {
        let last = entry.usage.last_used_ms.load(Ordering::SeqCst);
        if last == entry.persisted_last_used_ms { return; }
        let path = self.template.data_dir.join("persons").join(&entry.person.account_id).join("last-used");
        match std::fs::write(path, last.to_string()) {
            Ok(()) => entry.persisted_last_used_ms = last,
            Err(error) => log::warn!("person last-use persistence failed: {error}"),
        }
    }

    async fn reap(&self) {
        let stopping: Vec<_> = {
            let mut entries = self.entries.lock().await;
            let mut stopping = Vec::new();
            for entry in entries.values_mut() {
                self.persist_usage(entry);
                let now = now_ms();
                if entry.task.is_some() && reports_runs(&entry.person.account_id, now) {
                    // Idle time counts from the end of the brain's last run.
                    entry.usage.last_busy_ms.store(now, Ordering::SeqCst);
                    continue;
                }
                if entry.task.is_some() && entry.usage.in_flight.load(Ordering::SeqCst) == 0
                    && now.saturating_sub(entry.usage.last_active_ms()) as u128 >= self.idle.as_millis() { stopping.push(self.stop_entry(entry)); }
            }
            self.refresh(&entries);
            stopping
        };
        for stopped in stopping { wait_stopped(stopped).await; }
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        for authority in self.active_accounts.read().values() { authority.stop(); }
        let mut entries = self.entries.lock().await;
        // Server drain precedes this call. Remaining requests are allowed to
        // finish before their children are stopped.
        loop {
            if entries.values().all(|entry| entry.usage.in_flight.load(Ordering::SeqCst) == 0) { break; }
            drop(entries);
            tokio::time::sleep(Duration::from_millis(25)).await;
            entries = self.entries.lock().await;
        }
        let mut stopping = Vec::new();
        for entry in entries.values_mut() { self.persist_usage(entry); stopping.push(self.stop_entry(entry)); }
        self.refresh(&entries);
        drop(entries);
        for stopped in stopping { wait_stopped(stopped).await; }
    }

    /// One pass of `acquire` under the fleet lock. It never waits: a brain
    /// that must stop first is signalled here and awaited by the caller with
    /// the lock released, after which the pass runs again on fresh state.
    fn admit_locked(&self, entries: &mut BTreeMap<String, Entry>, person: &PersonPartition) -> Result<Admission, &'static str> {
        if let Some(entry) = entries.get(&person.account_id) {
            if entry.purging.load(Ordering::SeqCst) { return Err("person_purging"); }
            // The person's previous brain is still going; its data is in use.
            if let Some(stopped) = entry.pending_stop() { return Ok(Admission::Wait(stopped)); }
        }
        let running = entries.get(&person.account_id).is_some_and(|entry| entry.task.is_some()
            && entry.supervisor.as_ref().is_some_and(|sup| !sup.is_stopping()));
        if !running {
            if let Some(entry) = entries.get_mut(&person.account_id) {
                if entry.task.is_some() {
                    if let Some(stopped) = self.stop_entry(entry) { return Ok(Admission::Wait(stopped)); }
                }
            }
            if entries.values().filter(|entry| entry.occupies_slot()).count() >= self.maximum {
                let now = now_ms();
                let oldest = entries.iter().filter(|(key, entry)| entry.task.is_some() && entry.usage.in_flight.load(Ordering::SeqCst) == 0
                        && !reports_runs(key, now))
                    .min_by_key(|(_, entry)| entry.usage.last_active_ms()).map(|(key, _)| key.clone());
                // A brain that is already stopping frees its slot soon.
                let stopped = match oldest {
                    Some(oldest) => self.stop_entry(entries.get_mut(&oldest).expect("selected entry")),
                    None => entries.values().find_map(Entry::pending_stop),
                };
                return stopped.map(Admission::Wait).ok_or("person_brain_capacity");
            }
            let root = self.template.data_dir.join("persons").join(&person.account_id);
            std::fs::create_dir_all(&root).map_err(|_| "person_storage_failed")?;
            let key_existed = cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &person.account_id).map_err(|_| "person_storage_failed")?.is_some();
            let key = cognia_companion_rpc::headless::get_or_create_account_content_key(&person.account_id).map_err(|_| "person_storage_failed")?;
            let receipt_scope = if key_existed { self.data_scopes.read().get(&person.account_id).cloned() } else { None }
                .unwrap_or_else(|| PersonReceiptScope { account_id: person.account_id.clone(), data_generation: uuid::Uuid::new_v4().to_string() });
            let metadata = serde_json::to_string(&Metadata { org: person.org_id.clone(), user: person.user_id.clone(), data_generation: Some(receipt_scope.data_generation.clone()), purging: false }).map_err(|_| "person_storage_failed")?;
            cognia_secrets::secret_store::set(METADATA_SERVICE, &person.account_id, &metadata).map_err(|_| "person_storage_failed")?;
            self.data_scopes.write().insert(person.account_id.clone(), receipt_scope);
            let mut config = self.template.clone();
            config.account_id = person.account_id.clone(); config.account_content_key = key; config.data_dir = root;
            let supervisor = BrainSupervisor::new_person(config, self.state.clone());
            self.people.write().insert(person.account_id.clone(), person.clone());
            self.active_accounts.write().insert(person.account_id.clone(), supervisor.person_authority().expect("person supervisor authority"));
            let task = supervisor.start();
            let entry = entries.entry(person.account_id.clone()).or_insert_with(|| Self::entry(person.clone(), now_ms()));
            entry.supervisor = Some(supervisor); entry.task = Some(task); entry.stopped = None;
            entry.persisted_last_used_ms = 0;
        }
        let entry = entries.get(&person.account_id).expect("started entry");
        entry.usage.in_flight.fetch_add(1, Ordering::SeqCst);
        entry.usage.last_used_ms.store(now_ms(), Ordering::SeqCst);
        let guard = RequestGuard(entry.usage.clone(), self.data_scopes.read().get(&person.account_id).expect("persisted person data generation").clone());
        self.refresh(entries);
        Ok(Admission::Ready(guard))
    }
}

#[cognia_companion::person_partition::async_trait]
impl PersonBrainFleet for Fleet {
    async fn acquire(&self, person: &PersonPartition) -> Result<Box<dyn PersonRequest>, &'static str> {
        if self.stopping.load(Ordering::SeqCst) { return Err("person_brain_stopping"); }
        let guard = loop {
            let stopped = {
                let mut entries = self.entries.lock().await;
                if self.stopping.load(Ordering::SeqCst) { return Err("person_brain_stopping"); }
                match self.admit_locked(&mut entries, person)? {
                    Admission::Ready(guard) => break guard,
                    Admission::Wait(stopped) => stopped,
                }
            };
            wait_stopped(Some(stopped)).await;
        };
        let deadline = tokio::time::Instant::now() + self.template.ready_timeout;
        loop {
            if ws_bridge::account_connected(&person.account_id) { return Ok(Box::new(guard)); }
            if self.stopping.load(Ordering::SeqCst) { return Err("person_brain_stopping"); }
            if tokio::time::Instant::now() >= deadline { return Err("person_brain_starting"); }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    fn accepts_bridge(&self, account_id: &str, generation: &str) -> bool {
        self.bridge_authority(account_id).is_some_and(|active| active.accepts(generation))
    }
    fn bridge_authority(&self, account_id: &str) -> Option<Arc<PersonBrainAuthority>> {
        if self.stopping.load(Ordering::SeqCst) { None } else { self.active_accounts.read().get(account_id).cloned() }
    }
    fn receipt_scope(&self, account_id: &str) -> Option<PersonReceiptScope> { self.data_scopes.read().get(account_id).cloned() }
    fn person(&self, account_id: &str) -> Option<PersonPartition> {
        self.people.read().get(account_id).cloned()
    }
    fn org_people(&self, org: &str) -> Vec<String> {
        self.people.read().values().filter(|person| person.org_id == org).map(|person| person.user_id.clone()).collect()
    }
    fn statuses(&self) -> Vec<PersonBrainStatus> { self.snapshots.read().clone() }
    async fn list(&self) -> Result<serde_json::Value, String> {
        let entries = self.entries.lock().await;
        self.refresh(&entries);
        let people: Vec<_> = entries.values().map(|entry| entry.person.clone()).collect();
        drop(entries);
        let mut list = Vec::new();
        for person in people {
            let standing = match cognia_companion::workspace_access::standing_actions(&person.org_id, None, &person.user_id).await {
                Ok(_) => "member", Err(cognia_companion::workspace_access::WorkspaceAccessError::Upstream { status: 404 }) => "not-member",
                Err(_) => "unresolved",
            };
            if let Some(status) = self.statuses().into_iter().find(|status| status.account_id == person.account_id) {
                let mut value = serde_json::to_value(status).map_err(|e| e.to_string())?;
                value["standing"] = standing.into(); list.push(value);
            }
        }
        Ok(serde_json::json!({ "persons": list }))
    }
    async fn purge(&self, person: &PersonPartition) -> Result<(), &'static str> {
        let _person_execution = cognia_companion::host_surface_gate::person_execution_lock(&person.account_id).lock_owned().await;
        // The marker, not the fleet lock, keeps this person from starting while
        // their data goes: the rest of the fleet keeps serving meanwhile.
        let (marker, stopped) = {
            let mut entries = self.entries.lock().await;
            if entries.get(&person.account_id).is_some_and(|entry| entry.usage.in_flight.load(Ordering::SeqCst) != 0) {
                return Err("person_brain_busy");
            }
            // Purges of one person are serialized by its execution lock.
            let entry = entries.entry(person.account_id.clone()).or_insert_with(|| Self::entry(person.clone(), 0));
            entry.purging.store(true, Ordering::SeqCst);
            (PurgeMarker { flag: entry.purging.clone(), durable: false }, self.stop_entry(entry))
        };
        let mut marker = marker;
        let recorded = self.record_purge(person);
        marker.durable = recorded.is_ok();
        wait_stopped(stopped).await;
        let result = match recorded { Ok(()) => self.purge_stopped(person).await, Err(code) => Err(code) };
        let mut entries = self.entries.lock().await;
        if result.is_ok() {
            entries.remove(&person.account_id);
            self.people.write().remove(&person.account_id);
            self.data_scopes.write().remove(&person.account_id);
        } else if !marker.durable && entries.get(&person.account_id).is_some_and(|entry| entry.task.is_none() && entry.stopped.is_none()
            && !self.people.read().contains_key(&person.account_id)) {
            // A placeholder for a person the fleet never knew, whose purge
            // was never recorded. A recorded one keeps refusing the person.
            entries.remove(&person.account_id);
        }
        drop(marker);
        self.refresh(&entries);
        drop(entries);
        if result.is_ok() {
            cognia_companion::audit::record_async("person_partition_purge", "local-operator", "service", "allow",
                serde_json::json!({ "accountId": person.account_id })).await;
        }
        result
    }
}

impl Fleet {
    /// The purge's data removal, with the person's brain already stopped and
    /// their purge marker set.
    async fn purge_stopped(&self, person: &PersonPartition) -> Result<(), &'static str> {
        let records = self.execution_records_root();
        let stopped = cognia_companion::host_surface_gate::person_stop_execution(records.as_deref(), person,
            self.person_exec.as_ref(), Duration::from_secs(10)).await.map_err(|code| {
                cognia_companion::audit::record("person_execution_purge", "local-operator", "service", "deny",
                    serde_json::json!({"accountId":person.account_id,"code":code}));
                code
            })?;
        let policy = cognia_external_agent::presets::SpawnPolicy::from_env(&self.template.data_dir);
        cognia_external_agent::person_workspace::person_workspace_remove(&policy, &person.account_id).map_err(|_| "person_storage_failed")?;
        if let Some(records) = &records {
            cognia_companion::host_surface_gate::person_remove_execution_records(records, person)?;
        }
        cognia_companion::audit::record_async("person_execution_purge", "local-operator", "service", "allow",
            serde_json::json!({"accountId":person.account_id,"stoppedRuns":stopped})).await;
        self.ledger.purge_person_receipts(&person.account_id).map_err(|_| "person_storage_failed")?;
        // ADR-0253 §6: what the Host keeps about the person outside the data
        // root goes too. Each step is idempotent, so a resumed purge repeats it.
        cognia_companion::person_chat::PERSON_SESSIONS.forget_person(&person.account_id)?;
        cognia_companion::org_policy::person_forget_usage(&person.org_id, &person.user_id).map_err(|error| {
            log::error!("person usage could not be removed: {error}");
            "person_storage_failed"
        })?;
        let redacted = self.state.event_bus.forget_partition(&person.account_id);
        cognia_companion::audit::record_async("person_partition_forget", "local-operator", "service", "allow",
            serde_json::json!({"accountId":person.account_id,"redactedFrames":redacted})).await;
        // Destroy the DEK before removing any data; a partially failed purge
        // remains inaccessible and may be retried idempotently.
        cognia_secrets::secret_store::delete(CONTENT_KEY_SERVICE, &person.account_id).map_err(|_| "person_storage_failed")?;
        self.state.push_tokens.forget_account(&person.account_id);
        let root = self.template.data_dir.join("persons").join(&person.account_id);
        match std::fs::remove_dir_all(&root) {
            Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(_) => return Err("person_storage_failed"),
        }
        cognia_secrets::secret_store::delete(METADATA_SERVICE, &person.account_id).map_err(|_| "person_storage_failed")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_companion::ws_bridge::test_support::{lock_slot, clear_socket_for_testing, install_person_socket_for_testing};
    fn fixture(root: &std::path::Path, maximum: usize) -> Arc<Fleet> {
        let mut config = crate::brain::tests::test_config(root.join("missing-brain.mjs"), Duration::from_millis(100));
        config.data_dir = root.into();
        Fleet::with_limits(config, crate::brain::tests::test_state(), Duration::from_secs(1), maximum,
            cognia_companion::security_store::SecurityStore::in_memory().unwrap(),
            cognia_companion_rpc::headless::HeadlessServices::stub_for_tests().exec.clone()).unwrap()
    }
    fn person(user: &str) -> PersonPartition { PersonPartition::new("p5-test-org".into(), user.into()) }

    #[tokio::test]
    async fn p6d_fleet_purge_removes_workspace_records_and_preserves_other_partition() {
        let _slot = lock_slot().await;
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(),2);
        let a = person("p6d-purge-a"); let b = person("p6d-purge-b");
        let policy = cognia_external_agent::presets::SpawnPolicy::from_env(temp.path());
        let mut roots = Vec::new(); let mut bindings = serde_json::Map::new(); let mut mounts = serde_json::Map::new();
        for person in [&a,&b] {
            let (root,_) = cognia_external_agent::person_workspace::person_workspace_prepare(&policy,&person.account_id,None,1024).unwrap();
            std::fs::write(root.join("file"),"personal data").unwrap();
            std::fs::create_dir_all(temp.path().join("persons").join(&person.account_id)).unwrap();
            fleet.entries.lock().await.insert(person.account_id.clone(),Fleet::entry(person.clone(),0));
            fleet.people.write().insert(person.account_id.clone(),person.clone());
            cognia_companion_rpc::headless::get_or_create_account_content_key(&person.account_id).unwrap();
            bindings.insert(format!("external-agent:{}",person.account_id),serde_json::json!({"orgId":person.org_id,"workspaceId":format!("person:{}",person.account_id),"actorUserId":person.user_id,"runId":person.account_id}));
            mounts.insert(serde_json::to_string(&(&person.org_id,format!("person:{}",person.account_id))).unwrap(),serde_json::json!(root.to_str().unwrap()));
            roots.push(root);
        }
        // The spawn path writes under the runtime's binding root, which is not
        // the brain template's data dir; a purge reading the latter would
        // leave the records behind.
        *fleet.records_root.lock() = Some(temp.path().join(".cognia"));
        let directory = temp.path().join(".cognia/companion"); std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("execution-bindings.json"),serde_json::to_vec(&bindings).unwrap()).unwrap();
        std::fs::write(directory.join("workspace-mounts.json"),serde_json::to_vec(&mounts).unwrap()).unwrap();
        fleet.purge(&a).await.unwrap();
        assert!(!roots[0].exists()); assert!(roots[1].join("file").exists());
        assert!(!temp.path().join("persons").join(&a.account_id).exists());
        assert!(cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE,&a.account_id).unwrap().is_none());
        assert!(cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE,&b.account_id).unwrap().is_some());
        for file in ["execution-bindings.json","workspace-mounts.json"] {
            let value: serde_json::Value = serde_json::from_slice(&std::fs::read(directory.join(file)).unwrap()).unwrap();
            assert_eq!(value.as_object().unwrap().len(),1);
            assert!(!value.to_string().contains(&a.account_id));
            assert!(value.to_string().contains(&b.account_id));
        }
    }

    #[test]
    fn p6b_usage_people_include_parked_members_only_in_their_org() {
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = PersonPartition::new("org_p6b_one".into(), "usr_p6b_one".into());
        let b = PersonPartition::new("org_p6b_other".into(), "usr_p6b_other".into());
        fleet.people.write().insert(a.account_id.clone(), a);
        fleet.people.write().insert(b.account_id.clone(), b);
        assert!(fleet.statuses().is_empty());
        assert_eq!(fleet.org_people("org_p6b_one"), vec!["usr_p6b_one"]);
        assert!(fleet.org_people("org_p6b_unknown").is_empty());
    }

    #[tokio::test]
    async fn p5_eviction_and_server_restart_revoke_child_tokens_but_keep_data_generation() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("generation-a"); let b = person("generation-b");
        let _socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        let scope = request.receipt_scope();
        let authority = fleet.bridge_authority(&a.account_id).unwrap();
        let _child = authority.begin_child().unwrap();
        let old = authority.current().unwrap();
        assert!(fleet.accepts_bridge(&a.account_id, &old));
        drop(request);
        let _b = install_person_socket_for_testing(&fleet.state, &b.account_id);
        drop(fleet.acquire(&b).await.unwrap()); // capacity eviction
        assert!(!fleet.accepts_bridge(&a.account_id, &old));
        assert!(!authority.accepts(&old));
        let _socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        assert_eq!(request.receipt_scope(), scope);
        let next_authority = fleet.bridge_authority(&a.account_id).unwrap();
        let _child = next_authority.begin_child().unwrap();
        let next = next_authority.current().unwrap();
        assert_ne!(next, old);
        assert!(!fleet.accepts_bridge(&a.account_id, &old));
        drop(request); fleet.shutdown().await;
        assert!(!next_authority.accepts(&next));
        let restarted = fixture(temp.path(), 1);
        assert_eq!(restarted.receipt_scope(&a.account_id), Some(scope));
        assert!(!restarted.accepts_bridge(&a.account_id, &next));
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn p5_fleet_capacity_never_evicts_in_flight_and_uses_idle_lru() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("capacity-a"); let b = person("capacity-b");
        let _a_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let a_request = fleet.acquire(&a).await.unwrap();
        assert!(matches!(fleet.acquire(&b).await, Err("person_brain_capacity")));
        assert!(ws_bridge::account_connected(&a.account_id));
        // Even an artificially old last use cannot stop an in-flight brain.
        fleet.entries.lock().await.get(&a.account_id).unwrap().usage.last_used_ms.store(0, Ordering::SeqCst);
        fleet.reap().await;
        assert!(ws_bridge::account_connected(&a.account_id));
        drop(a_request);
        let _b_socket = install_person_socket_for_testing(&fleet.state, &b.account_id);
        let b_request = fleet.acquire(&b).await.unwrap();
        assert!(!ws_bridge::account_connected(&a.account_id));
        assert!(ws_bridge::account_connected(&b.account_id));
        drop(b_request);
        fleet.entries.lock().await.get(&b.account_id).unwrap().usage.last_used_ms.store(0, Ordering::SeqCst);
        fleet.reap().await;
        assert!(!ws_bridge::account_connected(&b.account_id));
        fleet.shutdown().await;
    }

    #[tokio::test]
    async fn fleet_keeps_a_brain_up_while_it_reports_member_turns() {
        use cognia_companion::ws_bridge::test_support::report_account_activity_for_testing;
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("busy-a"); let b = person("busy-b");
        let _a_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        // The turn's request returned; the turn runs on in the brain.
        drop(fleet.acquire(&a).await.unwrap());
        report_account_activity_for_testing(&a.account_id, 1, now_ms());
        fleet.entries.lock().await.get(&a.account_id).unwrap().usage.last_used_ms.store(0, Ordering::SeqCst);
        fleet.reap().await;
        assert!(ws_bridge::account_connected(&a.account_id), "the reaper stopped a brain mid-turn");
        let _b_socket = install_person_socket_for_testing(&fleet.state, &b.account_id);
        assert!(matches!(fleet.acquire(&b).await, Err("person_brain_capacity")), "eviction stopped a brain mid-turn");
        assert!(ws_bridge::account_connected(&a.account_id));
        // The turn ended: idle time counts from then, not from the last request.
        report_account_activity_for_testing(&a.account_id, 0, now_ms());
        fleet.reap().await;
        assert!(ws_bridge::account_connected(&a.account_id));
        // A report gone stale is not a reason to keep a brain: it may be hung.
        let stale = now_ms() - 4 * ws_bridge::BRAIN_HEARTBEAT.as_millis() as i64;
        report_account_activity_for_testing(&a.account_id, 1, stale);
        let request = fleet.acquire(&b).await.unwrap();
        assert!(!ws_bridge::account_connected(&a.account_id));
        assert!(ws_bridge::account_connected(&b.account_id));
        drop(request); fleet.shutdown().await;
    }

    /// An entry whose brain process exits only when the returned sender fires.
    async fn slow_to_stop(fleet: &Fleet, person: &PersonPartition) -> tokio::sync::oneshot::Sender<()> {
        let (exit, exited) = tokio::sync::oneshot::channel::<()>();
        let mut entry = Fleet::entry(person.clone(), 0);
        entry.task = Some(tokio::spawn(async move { let _ = exited.await; }));
        fleet.people.write().insert(person.account_id.clone(), person.clone());
        fleet.entries.lock().await.insert(person.account_id.clone(), entry);
        exit
    }

    #[tokio::test]
    async fn fleet_stops_brains_without_holding_its_lock() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 2);
        let a = person("slow-stop-a"); let b = person("slow-stop-b");
        let exit = slow_to_stop(&fleet, &a).await;
        // The reaper stops the idle brain and waits for its process...
        let reaping = { let fleet = fleet.clone(); tokio::spawn(async move { fleet.reap().await }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!reaping.is_finished());
        // ...while every other member is still served.
        let _b_socket = install_person_socket_for_testing(&fleet.state, &b.account_id);
        let b_request = tokio::time::timeout(Duration::from_secs(5), fleet.acquire(&b)).await
            .expect("another member waited on a stopping brain").unwrap();
        // The same member waits for their old brain: its data is still in use.
        let _a_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let a_attempt = { let fleet = fleet.clone(); let a = a.clone(); tokio::spawn(async move { fleet.acquire(&a).await.map(drop) }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!a_attempt.is_finished());
        assert!(fleet.entries.lock().await.get(&a.account_id).unwrap().task.is_none(), "a second brain started over the first");
        exit.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), reaping).await.unwrap().unwrap();
        // Joining the old brain disconnected its slot; the restarted one reconnects.
        let _a_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        tokio::time::timeout(Duration::from_secs(5), a_attempt).await.unwrap().unwrap().unwrap();
        drop(b_request); fleet.shutdown().await;
    }

    #[tokio::test]
    async fn a_purge_holds_only_its_own_person_while_their_brain_stops() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 2);
        let a = person("slow-purge-a"); let b = person("slow-purge-b");
        std::fs::create_dir_all(temp.path().join("persons").join(&a.account_id)).unwrap();
        let exit = slow_to_stop(&fleet, &a).await;
        let purging = { let fleet = fleet.clone(); let a = a.clone(); tokio::spawn(async move { fleet.purge(&a).await }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!purging.is_finished());
        // Nothing restarts the member being removed...
        assert_eq!(fleet.acquire(&a).await.err(), Some("person_purging"));
        // ...and nobody else waits for the purge.
        let _b_socket = install_person_socket_for_testing(&fleet.state, &b.account_id);
        drop(tokio::time::timeout(Duration::from_secs(5), fleet.acquire(&b)).await.unwrap().unwrap());
        exit.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(15), purging).await.unwrap().unwrap().unwrap();
        assert!(fleet.entries.lock().await.get(&a.account_id).is_none());
        assert!(fleet.person(&a.account_id).is_none());
        assert!(!temp.path().join("persons").join(&a.account_id).exists());
        // A cancelled purge was already recorded (ADR-0253 §6): the person
        // stays refused until a purge finishes, and the record says so.
        let c = person("slow-purge-c");
        let exit = slow_to_stop(&fleet, &c).await;
        let cancelled = { let fleet = fleet.clone(); let c = c.clone(); tokio::spawn(async move { fleet.purge(&c).await }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancelled.abort(); let _ = cancelled.await;
        assert!(fleet.entries.lock().await.get(&c.account_id).unwrap().purging.load(Ordering::SeqCst));
        assert_eq!(fleet.acquire(&c).await.err(), Some("person_purging"));
        let recorded: Metadata = serde_json::from_str(&cognia_secrets::secret_store::get(METADATA_SERVICE, &c.account_id).unwrap().unwrap()).unwrap();
        assert!(recorded.purging);
        drop(exit);
        tokio::time::timeout(Duration::from_secs(15), fleet.purge(&c)).await.unwrap().unwrap();
        assert!(fleet.entries.lock().await.get(&c.account_id).is_none());
        fleet.shutdown().await;
    }

    #[tokio::test]
    async fn p5_fleet_chooses_oldest_idle_partition_and_coalesces_same_person() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 2);
        let a = person("lru-a"); let b = person("lru-b"); let c = person("lru-c");
        let _a = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let first = fleet.acquire(&a).await.unwrap();
        let original_task = fleet.entries.lock().await.get(&a.account_id).unwrap().task.as_ref().unwrap().id();
        let second = fleet.acquire(&a).await.unwrap();
        assert_eq!(fleet.entries.lock().await.get(&a.account_id).unwrap().task.as_ref().unwrap().id(), original_task);
        drop(first); drop(second);
        let _b = install_person_socket_for_testing(&fleet.state, &b.account_id);
        drop(fleet.acquire(&b).await.unwrap());
        fleet.entries.lock().await.get(&a.account_id).unwrap().usage.last_used_ms.store(now_ms() - 100, Ordering::SeqCst);
        let _c = install_person_socket_for_testing(&fleet.state, &c.account_id);
        let request = fleet.acquire(&c).await.unwrap();
        assert!(!ws_bridge::account_connected(&a.account_id));
        assert!(ws_bridge::account_connected(&b.account_id));
        assert!(ws_bridge::account_connected(&c.account_id));
        let health = serde_json::to_string(&fleet.statuses()).unwrap();
        assert!(!health.contains("p5-test-org") && !health.contains("lru-c"));
        drop(request); fleet.shutdown().await;
    }

    #[tokio::test]
    async fn p5_fleet_readiness_timeout_and_cancel_release_request_leases() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("timeout-a");
        assert!(matches!(fleet.acquire(&a).await, Err("person_brain_starting")));
        assert_eq!(fleet.entries.lock().await.get(&a.account_id).unwrap().usage.in_flight.load(Ordering::SeqCst), 0);
        let attempt = { let fleet = fleet.clone(); let a = a.clone(); tokio::spawn(async move { fleet.acquire(&a).await }) };
        tokio::time::sleep(Duration::from_millis(20)).await;
        attempt.abort(); let _ = attempt.await;
        assert_eq!(fleet.entries.lock().await.get(&a.account_id).unwrap().usage.in_flight.load(Ordering::SeqCst), 0);
        fleet.shutdown().await;
    }

    #[tokio::test]
    async fn adr0253_a_recorded_purge_refuses_the_person_and_finishes_after_a_restart() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        // The session fence writes through the installed store; hold it.
        let _store_guard = cognia_companion::security_store::test_guard();
        struct Restore(Option<Arc<cognia_companion::security_store::SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { cognia_companion::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(cognia_companion::security_store::security_store());
        cognia_companion::security_store::install_security_store(Some(cognia_companion::security_store::SecurityStore::in_memory().unwrap()));
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 2);
        let gone = person("adr0253-purge-gone"); let kept = person("adr0253-purge-kept");
        // A Host that stopped mid-purge: the purge is recorded, the data and
        // the key are still there.
        fleet.record_purge(&gone).unwrap();
        cognia_companion_rpc::headless::get_or_create_account_content_key(&gone.account_id).unwrap();
        let root = temp.path().join("persons").join(&gone.account_id);
        std::fs::write(root.join("encrypted-data"), "ciphertext").unwrap();
        fleet.shutdown().await;
        let restarted = fixture(temp.path(), 2);
        let _socket = install_person_socket_for_testing(&restarted.state, &gone.account_id);
        assert_eq!(restarted.acquire(&gone).await.err(), Some("person_purging"), "nothing starts them meanwhile");
        // What the Host keeps about them outside the data root.
        let bus = &restarted.state.event_bus;
        let frame = bus.publish_person("claude://message".into(), serde_json::json!({"text":"private"}), gone.account_id.clone());
        bus.publish_person("claude://message".into(), serde_json::json!({"text":"kept"}), kept.account_id.clone());
        let sessions = &cognia_companion::person_chat::PERSON_SESSIONS;
        sessions.bind("adr0253-purge-gone-session", Some(&gone)).unwrap();
        sessions.bind("adr0253-purge-kept-session", Some(&kept)).unwrap();
        assert_eq!(restarted.interrupted_purges.lock().len(), 1);
        restarted.resume_interrupted_purges();
        assert!(restarted.interrupted_purges.lock().is_empty(), "taken once");
        tokio::time::timeout(Duration::from_secs(10), async {
            while cognia_secrets::secret_store::get(METADATA_SERVICE, &gone.account_id).unwrap().is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("resumed purge finishes");
        assert!(!root.exists());
        assert!(cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &gone.account_id).unwrap().is_none());
        assert_eq!(sessions.owner_account("adr0253-purge-gone-session"), None);
        assert_eq!(sessions.owner_account("adr0253-purge-kept-session"), Some(kept.account_id.clone()));
        let cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(frame.seq - 1), now_ms()) else {
            panic!("replay");
        };
        assert_eq!(replay[0].seq, frame.seq);
        assert_eq!(replay[0].payload, serde_json::Value::Null);
        assert_eq!(replay[1].payload, serde_json::json!({"text":"kept"}));
        // Afterwards the person may start again, with an empty partition.
        restarted.acquire(&gone).await.map(drop).unwrap();
        assert!(!root.join("encrypted-data").exists());
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn p5_purge_refuses_busy_destroys_key_and_data_and_rejoin_is_empty() {
        let _slot = lock_slot().await; clear_socket_for_testing();
        let temp = tempfile::tempdir().unwrap(); let fleet = fixture(temp.path(), 1);
        let a = person("purge-a");
        let _socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        let old_scope = request.receipt_scope();
        let receipt_key = old_scope.key("purge-receipt");
        let cognia_companion::security_store::IdempotencyDecision::Started { operation_id } =
            fleet.ledger.begin_idempotent_operation("tenant", "device", "host", &receipt_key, "hash", 100).unwrap() else { panic!("new operation"); };
        fleet.ledger.mark_operation_running("tenant", &operation_id, 101).unwrap();
        fleet.ledger.complete_idempotent_operation("tenant", "device", &receipt_key, "{\"result\":\"old\"}", true, 102).unwrap();
        let key = cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &a.account_id).unwrap().unwrap();
        let root = temp.path().join("persons").join(&a.account_id);
        std::fs::write(root.join("encrypted-data"), "old ciphertext").unwrap();
        assert_eq!(fleet.purge(&a).await, Err("person_brain_busy"));
        assert!(root.exists()); drop(request);
        fleet.purge(&a).await.unwrap(); fleet.purge(&a).await.unwrap();
        assert!(!root.exists());
        assert!(cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &a.account_id).unwrap().is_none());
        assert!(fleet.person(&a.account_id).is_none());
        assert!(fleet.receipt_scope(&a.account_id).is_none());
        assert!(fleet.ledger.operation("tenant", "device", &operation_id).unwrap().is_none());
        let _new_socket = install_person_socket_for_testing(&fleet.state, &a.account_id);
        let request = fleet.acquire(&a).await.unwrap();
        let new_key = cognia_secrets::secret_store::get(CONTENT_KEY_SERVICE, &a.account_id).unwrap().unwrap();
        let new_scope = request.receipt_scope();
        assert_ne!(new_scope.data_generation, old_scope.data_generation);
        assert_ne!(new_key, key); assert!(!root.join("encrypted-data").exists());
        drop(request); fleet.shutdown().await;
        // Metadata is encrypted and survives restart, never exposed in health.
        let loaded = fixture(temp.path(), 1);
        assert_eq!(loaded.receipt_scope(&a.account_id), Some(new_scope));
        assert_eq!(loaded.person(&a.account_id), Some(a));
        loaded.shutdown().await;
    }
}
