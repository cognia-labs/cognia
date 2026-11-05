//! The Host's one standing authority — ADR-0253 §1–§3.
//!
//! A member's brain, turns, sandboxed runs and sockets all hang off their
//! standing in the organization, which the collaboration plane owns. Every
//! Host path that needs it asks [`StandingAuthority::actions`]: device
//! admission and event audiences with [`Freshness::Cached`], execution,
//! organization-policy writes and the departure sweep with
//! [`Freshness::Fresh`]. There is no other lookup.
//!
//! # Cache
//!
//! A cached answer lives at most five seconds (`AdmissionCache`). The
//! standing-change stream (`standing_stream`) invalidates entries the moment
//! the plane reports a change. Every invalidation bumps an epoch, and a lookup
//! that started before it never writes its answer back, so a slow response
//! cannot restore what a notice removed.
//!
//! # Revocation
//!
//! A definite refusal of a person's organization standing (`person_not_member`,
//! `org_suspended`) revokes them on this Host: their model tickets are
//! revoked and no new one is minted, their sockets close, the
//! installed [`DepartureEnforcer`] cancels their turns and runs as
//! `revoked_during_run` and stops their brain, and brain start refuses them
//! until a lookup that began after the revocation finds them a member again.
//! A refusal found by any lookup acts at once; a notice from the stream only
//! makes the lookup happen sooner. The 30-second sweep re-checks everyone this
//! Host is doing something for, so a missed notice is bounded.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde_json::json;

use crate::host_surface_gate::{map_authority_error, AdmissionCache, Person, Refusal};

/// How fresh an answer the caller needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    /// Admission of reads and ordinary writes: at most five seconds old.
    Cached,
    /// Execution, organization-policy writes, the sweep: asked now.
    Fresh,
}

/// The run-end reason a member sees for work the Host stopped because their
/// standing ended mid-run (plan §7.5).
pub const REVOKED_DURING_RUN: &str = "revoked_during_run";

/// How often everyone this Host acts for is re-checked.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// Revocations kept at once. An evicted one only loses its race fence: brain
/// start still asks the plane, which still refuses.
const REVOCATION_LIMIT: usize = 4096;

/// A standing change the collaboration plane reported (ADR-0253 §2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StandingChange {
    pub org: String,
    pub user: Option<String>,
    pub workspace: Option<String>,
    pub kind: ChangeKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Offboarded,
    RoleChanged,
    WorkspaceRemoved,
    OrgSuspended,
    OrgResumed,
}

impl ChangeKind {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "offboarded" => Self::Offboarded,
            "role_changed" => Self::RoleChanged,
            "workspace_removed" => Self::WorkspaceRemoved,
            "org_suspended" => Self::OrgSuspended,
            "org_resumed" => Self::OrgResumed,
            _ => return None,
        })
    }
}

/// A socket the authority wants closed now, rather than at its next
/// 25-second audience re-check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SocketClosure {
    Person(Person),
    Org(String),
    Device(String),
}

impl SocketClosure {
    /// Whether this closes the socket of `device`, bound to `person`.
    pub fn closes(&self, device: &str, person: Option<&Person>) -> bool {
        match self {
            Self::Device(target) => target == device,
            Self::Person(target) => person == Some(target),
            Self::Org(org) => person.is_some_and(|person| &person.org == org),
        }
    }
}

/// What the Host does when a person's standing ends (ADR-0253 §3). Installed
/// by the multi-tenant server, which owns the brains, the chat runtime and the
/// execution backend. A Host without one (a desktop, unit tests) still closes
/// sockets and refuses admission.
#[async_trait::async_trait]
pub trait DepartureEnforcer: Send + Sync {
    /// The people with a running brain or a live run on this Host.
    fn active_people(&self) -> Vec<Person>;
    /// Cancel `person`'s tool-less turns and sandboxed runs as
    /// [`REVOKED_DURING_RUN`], each with an audit entry, then stop their
    /// brain. `code` is the standing refusal that caused it.
    async fn depart(&self, person: &Person, code: &'static str);
    /// Cancel `person`'s runs placed in `workspace`; their other work goes on.
    async fn workspace_removed(&self, person: &Person, workspace: &str);
}

static ENFORCER: RwLock<Option<Arc<dyn DepartureEnforcer>>> = RwLock::new(None);

pub fn install_enforcer(enforcer: Option<Arc<dyn DepartureEnforcer>>) {
    *ENFORCER.write() = enforcer;
}

fn enforcer() -> Option<Arc<dyn DepartureEnforcer>> {
    ENFORCER.read().clone()
}

#[derive(Clone, Copy, Debug)]
struct Revocation {
    code: &'static str,
    /// The epoch the revocation bumped to. A lookup that started at or after
    /// it may clear it; an earlier one may not.
    epoch: u64,
}

#[derive(Default)]
struct Revocations {
    people: HashMap<Person, Revocation>,
    orgs: HashMap<String, Revocation>,
}

impl Revocations {
    fn bound(&mut self) {
        while self.people.len() > REVOCATION_LIMIT {
            let Some(oldest) = self.people.iter().min_by_key(|(_, rev)| rev.epoch).map(|(p, _)| p.clone()) else { break };
            self.people.remove(&oldest);
        }
        while self.orgs.len() > REVOCATION_LIMIT {
            let Some(oldest) = self.orgs.iter().min_by_key(|(_, rev)| rev.epoch).map(|(o, _)| o.clone()) else { break };
            self.orgs.remove(&oldest);
        }
    }
}

/// See the module docs.
pub struct StandingAuthority {
    cache: Mutex<AdmissionCache>,
    epoch: AtomicU64,
    revocations: Mutex<Revocations>,
    /// Bumped on every revocation; sandboxed-run watchdogs wake on it.
    revoked: tokio::sync::watch::Sender<u64>,
    closures: tokio::sync::broadcast::Sender<SocketClosure>,
    /// People with an open device socket, counted.
    present: Arc<Mutex<HashMap<Person, usize>>>,
}

static AUTHORITY: Lazy<StandingAuthority> = Lazy::new(StandingAuthority::new);

/// The process's standing authority.
pub fn authority() -> &'static StandingAuthority {
    &AUTHORITY
}

impl StandingAuthority {
    fn new() -> Self {
        Self {
            cache: Mutex::new(AdmissionCache::default()),
            epoch: AtomicU64::new(0),
            revocations: Mutex::new(Revocations::default()),
            revoked: tokio::sync::watch::channel(0).0,
            closures: tokio::sync::broadcast::channel(256).0,
            present: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The actions `person` holds in their organization (`workspace: None`) or
    /// in one workspace. `Ok` is standing; `person_not_member` and
    /// `org_suspended` are definite and not retryable; `host_authority_unavailable`
    /// means the plane could not say.
    pub async fn actions(&self, person: &Person, workspace: Option<&str>, freshness: Freshness) -> Result<Vec<String>, Refusal> {
        let key = (person.clone(), workspace.map(str::to_string));
        let started = Instant::now();
        let epoch = self.epoch.load(Ordering::SeqCst);
        if freshness == Freshness::Cached {
            if let Some(result) = self.cache.lock().get(&key, started) {
                return result;
            }
        }
        let result = lookup(person, workspace).await;
        {
            // Measured from the request's start, so a slow upstream never
            // extends stale authority by its latency; an invalidation since
            // then keeps it out entirely.
            let mut cache = self.cache.lock();
            if self.epoch.load(Ordering::SeqCst) == epoch {
                cache.insert(key, started, Instant::now(), result.clone());
            }
        }
        if workspace.is_none() {
            self.observe(person, &result, epoch);
        }
        // A member answer from a lookup that began before a revocation does
        // not lift it: the caller is refused like everyone after it.
        match (result, self.revocation(person)) {
            (Ok(_), Some(code)) => Err(revoked_refusal(code)),
            (result, _) => result,
        }
    }

    /// Whether `person` may have a brain started for them now: a member, and
    /// not revoked since the last lookup that found them one.
    pub async fn admit(&self, person: &Person) -> Result<(), &'static str> {
        self.actions(person, None, Freshness::Cached).await.map_err(|refusal| refusal.code)?;
        self.revocation(person).map_or(Ok(()), Err)
    }

    /// [`StandingAuthority::revocation`] for a person's partition. Checked
    /// under `PERSON_CREDENTIAL_FENCE` before any member credential is minted,
    /// so a mint either lands before a revocation (which then revokes it) or
    /// is refused.
    pub fn partition_revocation(&self, partition: &crate::person_partition::PersonPartition) -> Option<&'static str> {
        self.revocation(&Person { org: partition.org_id.clone(), user: partition.user_id.clone() })
    }

    /// The refusal standing `person` under a revocation on this Host, if any.
    pub fn revocation(&self, person: &Person) -> Option<&'static str> {
        let revocations = self.revocations.lock();
        revocations.people.get(person).or_else(|| revocations.orgs.get(&person.org)).map(|rev| rev.code)
    }

    fn observe(&self, person: &Person, result: &Result<Vec<String>, Refusal>, epoch: u64) {
        match result {
            Ok(_) => {
                let mut revocations = self.revocations.lock();
                if revocations.people.get(person).is_some_and(|rev| rev.epoch <= epoch) {
                    revocations.people.remove(person);
                }
                // A member of the organization proves it is not suspended.
                if revocations.orgs.get(&person.org).is_some_and(|rev| rev.epoch <= epoch) {
                    revocations.orgs.remove(&person.org);
                }
            }
            Err(refusal) if refusal.code == "person_not_member" => self.revoke(person, "person_not_member"),
            Err(refusal) if refusal.code == "org_suspended" => self.revoke_org(&person.org, "org_suspended"),
            Err(_) => {}
        }
    }

    /// Increment the epoch and change the cache under one lock, so a lookup
    /// either sees the new epoch or wrote before the change.
    fn bump(&self, change: impl FnOnce(&mut AdmissionCache)) -> u64 {
        let mut cache = self.cache.lock();
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        change(&mut cache);
        epoch
    }

    pub fn invalidate_person(&self, person: &Person) {
        self.bump(|cache| cache.forget_person(person));
    }

    pub fn invalidate_org(&self, org: &str) {
        self.bump(|cache| cache.forget_org(org));
    }

    pub fn invalidate_all(&self) {
        self.bump(AdmissionCache::clear);
    }

    /// Revoke `person` on this Host (see the module docs). A person already
    /// revoked for the same reason is left as is: their refusal stays cached
    /// and nothing is departed twice.
    pub fn revoke(&self, person: &Person, code: &'static str) {
        {
            // Lock order: revocations, then the cache (inside `bump`).
            let mut revocations = self.revocations.lock();
            if revocations.people.get(person).is_some_and(|rev| rev.code == code)
                || revocations.orgs.get(&person.org).is_some_and(|rev| rev.code == code)
            {
                return;
            }
            let epoch = self.bump(|cache| cache.forget_person(person));
            revocations.people.insert(person.clone(), Revocation { code, epoch });
            revocations.bound();
        }
        // Model access ends now, whatever is still running.
        crate::org_policy::person_revoke_member(&person.org, Some(&person.user));
        self.revoked.send_modify(|generation| *generation = generation.wrapping_add(1));
        let _ = self.closures.send(SocketClosure::Person(person.clone()));
        crate::audit::record("person_standing_revoked", "standing-authority", "service", "deny",
            json!({ "orgId": person.org, "userId": person.user, "code": code }));
        if let Some(enforcer) = enforcer() {
            let person = person.clone();
            spawn(async move { enforcer.depart(&person, code).await });
        }
    }

    /// Revoke every member of `org` on this Host.
    pub fn revoke_org(&self, org: &str, code: &'static str) {
        {
            let mut revocations = self.revocations.lock();
            if revocations.orgs.get(org).is_some_and(|rev| rev.code == code) {
                return;
            }
            let epoch = self.bump(|cache| cache.forget_org(org));
            revocations.orgs.insert(org.to_string(), Revocation { code, epoch });
            revocations.bound();
        }
        crate::org_policy::person_revoke_member(org, None);
        self.revoked.send_modify(|generation| *generation = generation.wrapping_add(1));
        let _ = self.closures.send(SocketClosure::Org(org.to_string()));
        crate::audit::record("org_standing_revoked", "standing-authority", "service", "deny",
            json!({ "orgId": org, "code": code }));
        if let Some(enforcer) = enforcer() {
            let people: Vec<Person> = enforcer.active_people().into_iter().filter(|person| person.org == org).collect();
            for person in people {
                let enforcer = enforcer.clone();
                spawn(async move { enforcer.depart(&person, code).await });
            }
        }
    }

    /// A paired device lost its authority (suspended, revoked): close its
    /// sockets on every transport now.
    pub fn close_device(&self, device: &str) {
        let _ = self.closures.send(SocketClosure::Device(device.to_string()));
    }

    /// Sockets subscribe here and close when a closure names them.
    pub fn closures(&self) -> tokio::sync::broadcast::Receiver<SocketClosure> {
        self.closures.subscribe()
    }

    /// Changes on every revocation. A watchdog re-checks its run then.
    pub fn revocations(&self) -> tokio::sync::watch::Receiver<u64> {
        self.revoked.subscribe()
    }

    /// Count `person` as present (an open device socket) while the guard lives.
    pub fn presence(&self, person: Person) -> Presence {
        *self.present.lock().entry(person.clone()).or_default() += 1;
        Presence { person, present: self.present.clone() }
    }

    /// Everyone this Host is doing something for: a brain, a run, a socket.
    pub fn active_people(&self) -> Vec<Person> {
        let mut people: Vec<Person> = self.present.lock().keys().cloned().collect();
        if let Some(enforcer) = enforcer() {
            people.extend(enforcer.active_people());
        }
        people.sort_by(|a, b| (&a.org, &a.user).cmp(&(&b.org, &b.user)));
        people.dedup();
        people
    }

    /// Apply one reported change (ADR-0253 §3). A notice only invalidates and
    /// asks again: a change replayed after the person was re-added acts on
    /// what the plane says now, not on the old row.
    pub async fn notice(&self, change: &StandingChange) {
        let person = change.user.as_ref().map(|user| Person { org: change.org.clone(), user: user.clone() });
        match (change.kind, person) {
            (ChangeKind::Offboarded, Some(person)) => {
                self.invalidate_person(&person);
                let _ = self.actions(&person, None, Freshness::Fresh).await;
            }
            (ChangeKind::RoleChanged, Some(person)) => self.invalidate_person(&person),
            (ChangeKind::WorkspaceRemoved, Some(person)) => {
                self.invalidate_person(&person);
                let Some(workspace) = change.workspace.as_deref() else { return };
                let standing = self.actions(&person, Some(workspace), Freshness::Fresh).await;
                let lost = match &standing {
                    Ok(actions) => !actions.iter().any(|action| action == "execution.request"),
                    Err(refusal) => matches!(refusal.code, "person_not_member" | "org_suspended" | "host_surface_forbidden"),
                };
                if lost {
                    if let Some(enforcer) = enforcer() {
                        enforcer.workspace_removed(&person, workspace).await;
                    }
                }
            }
            (ChangeKind::OrgSuspended, _) => {
                self.invalidate_org(&change.org);
                let people: Vec<Person> = self.active_people().into_iter().filter(|person| person.org == change.org).collect();
                self.recheck(people).await;
            }
            (ChangeKind::OrgResumed, _) => self.invalidate_org(&change.org),
            // A person-scoped kind without a person cannot be applied to
            // anyone; drop what is cached for the organization instead.
            (_, None) => self.invalidate_org(&change.org),
        }
    }

    /// The stream lost its place (resync, gap, reconnect): forget everything
    /// and re-check everyone active.
    pub async fn flush(&self) {
        self.invalidate_all();
        self.recheck(self.active_people()).await;
    }

    /// One sweep: re-check everyone active, asking the plane now.
    pub async fn sweep(&self) {
        self.recheck(self.active_people()).await;
    }

    async fn recheck(&self, people: Vec<Person>) {
        use futures_util::StreamExt;
        futures_util::stream::iter(people)
            .for_each_concurrent(8, |person| async move {
                let _ = self.actions(&person, None, Freshness::Fresh).await;
            })
            .await;
    }

    /// Run the sweep every [`SWEEP_INTERVAL`] for the life of the process.
    pub fn spawn_sweep(&'static self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                self.sweep().await;
            }
        })
    }
}

fn revoked_refusal(code: &'static str) -> Refusal {
    Refusal { status: axum::http::StatusCode::FORBIDDEN, code }
}

fn spawn(future: impl std::future::Future<Output = ()> + Send + 'static) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(future);
        }
        Err(_) => log::warn!("standing: no runtime to apply a revocation on"),
    }
}

/// Counts one open socket of a person; see [`StandingAuthority::presence`].
pub struct Presence {
    person: Person,
    present: Arc<Mutex<HashMap<Person, usize>>>,
}

impl Drop for Presence {
    fn drop(&mut self) {
        let mut present = self.present.lock();
        if let Some(count) = present.get_mut(&self.person) {
            *count -= 1;
            if *count == 0 {
                present.remove(&self.person);
            }
        }
    }
}

async fn lookup(person: &Person, workspace: Option<&str>) -> Result<Vec<String>, Refusal> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(result) = test_support::get(&person.org) {
        return result;
    }
    crate::workspace_access::standing_actions(&person.org, workspace, &person.user)
        .await
        .map_err(map_authority_error)
}

/// Stand-in standing for an organization in tests: every lookup for it
/// answers here instead of asking a collaboration plane.
#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    use super::*;
    use axum::http::StatusCode;

    /// Per organization: how many guards are alive, and the refusal if any.
    type StandIn = (usize, Option<&'static str>);
    static RESULTS: Lazy<Mutex<HashMap<String, StandIn>>> = Lazy::new(Default::default);

    /// While alive, `org`'s people are members with no actions, or refused
    /// with the code given to [`Installed::refuse`]. Guards for one
    /// organization nest: the stand-in lasts until the last one drops.
    pub struct Installed(String);
    impl Installed {
        pub fn new(org: &str) -> Self {
            RESULTS.lock().entry(org.into()).or_insert((0, None)).0 += 1;
            Self(org.into())
        }
        pub fn refuse(&self, code: &'static str) {
            if let Some(entry) = RESULTS.lock().get_mut(&self.0) {
                entry.1 = Some(code);
            }
        }
        pub fn admit(&self) {
            if let Some(entry) = RESULTS.lock().get_mut(&self.0) {
                entry.1 = None;
            }
        }
    }
    impl Drop for Installed {
        fn drop(&mut self) {
            let mut results = RESULTS.lock();
            if let Some(entry) = results.get_mut(&self.0) {
                entry.0 -= 1;
                if entry.0 == 0 {
                    results.remove(&self.0);
                }
            }
        }
    }
    pub(super) fn get(org: &str) -> Option<Result<Vec<String>, Refusal>> {
        RESULTS.lock().get(org).map(|(_, code)| match code {
            Some(code) => Err(Refusal {
                status: if *code == "host_authority_unavailable" { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::FORBIDDEN },
                code,
            }),
            None => Ok(vec![]),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(org: &str, user: &str) -> Person {
        Person { org: org.into(), user: user.into() }
    }

    /// Records only its own organization's departures: the enforcer slot is
    /// global, and another test's revocation may reach it.
    struct Recorder {
        org: &'static str,
        active: Vec<Person>,
        departed: Mutex<Vec<(Person, &'static str)>>,
        workspaces: Mutex<Vec<(Person, String)>>,
    }

    #[async_trait::async_trait]
    impl DepartureEnforcer for Recorder {
        fn active_people(&self) -> Vec<Person> {
            self.active.clone()
        }
        async fn depart(&self, person: &Person, code: &'static str) {
            if person.org == self.org { self.departed.lock().push((person.clone(), code)); }
        }
        async fn workspace_removed(&self, person: &Person, workspace: &str) {
            if person.org == self.org { self.workspaces.lock().push((person.clone(), workspace.into())); }
        }
    }

    /// The enforcer is process-global; tests that install one take turns.
    static ENFORCER_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct Installed;
    impl Drop for Installed {
        fn drop(&mut self) {
            install_enforcer(None);
        }
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn a_lookup_that_started_before_an_invalidation_never_writes_back() {
        let org = "org_standing_epoch";
        let standing = test_support::Installed::new(org);
        let authority = StandingAuthority::new();
        let ada = person(org, "usr_ada");
        assert!(authority.actions(&ada, None, Freshness::Cached).await.is_ok());
        // Cached: the refusal is not seen until the entry goes.
        standing.refuse("host_authority_unavailable");
        assert!(authority.actions(&ada, None, Freshness::Cached).await.is_ok());
        assert_eq!(authority.actions(&ada, None, Freshness::Fresh).await.unwrap_err().code, "host_authority_unavailable");
        standing.admit();
        authority.invalidate_person(&ada);
        assert!(authority.actions(&ada, None, Freshness::Cached).await.is_ok());
        // An answer measured against an older epoch is dropped.
        let started = authority.epoch.load(Ordering::SeqCst);
        authority.invalidate_org(org);
        {
            let mut cache = authority.cache.lock();
            if authority.epoch.load(Ordering::SeqCst) == started {
                cache.insert((ada.clone(), None), Instant::now(), Instant::now(), Ok(vec!["stale".into()]));
            }
        }
        assert!(authority.cache.lock().get(&(ada.clone(), None), Instant::now()).is_none());
    }

    #[tokio::test]
    async fn a_definite_refusal_revokes_closes_sockets_and_departs_once() {
        let _turn = ENFORCER_TURN.lock().await;
        let org = "org_standing_depart";
        let standing = test_support::Installed::new(org);
        let ada = person(org, "usr_ada");
        let recorder = Arc::new(Recorder { org, active: vec![ada.clone()], departed: Mutex::new(vec![]), workspaces: Mutex::new(vec![]) });
        install_enforcer(Some(recorder.clone()));
        let _installed = Installed;
        let authority = StandingAuthority::new();
        let mut closures = authority.closures();
        let mut revocations = authority.revocations();
        standing.refuse("person_not_member");
        assert_eq!(authority.actions(&ada, None, Freshness::Fresh).await.unwrap_err().code, "person_not_member");
        assert_eq!(authority.revocation(&ada), Some("person_not_member"));
        assert_eq!(closures.try_recv().unwrap(), SocketClosure::Person(ada.clone()));
        assert!(revocations.has_changed().unwrap());
        revocations.mark_unchanged();
        // Asking again does not depart twice, and the refusal stays cached
        // instead of every request asking the plane.
        let _ = authority.actions(&ada, None, Freshness::Fresh).await;
        settle().await;
        assert!(authority.cache.lock().get(&(ada.clone(), None), Instant::now()).is_some_and(|cached| cached.is_err()));
        assert_eq!(recorder.departed.lock().clone(), vec![(ada.clone(), "person_not_member")]);
        assert_eq!(authority.admit(&ada).await, Err("person_not_member"));
        // A workspace refusal is not a departure.
        let bob = person(org, "usr_bob");
        let _ = authority.actions(&bob, Some("ws_a"), Freshness::Fresh).await;
        assert_eq!(authority.revocation(&bob), None);
        // Rejoined: once the cached refusal is gone (five seconds at most), a
        // lookup that began after the revocation clears it.
        standing.admit();
        assert_eq!(authority.admit(&ada).await, Err("person_not_member"));
        authority.invalidate_person(&ada);
        assert!(authority.admit(&ada).await.is_ok());
        assert_eq!(authority.revocation(&ada), None);
    }

    #[tokio::test]
    async fn a_lookup_that_began_before_a_revocation_cannot_clear_it() {
        let org = "org_standing_race";
        let _standing = test_support::Installed::new(org);
        let authority = StandingAuthority::new();
        let ada = person(org, "usr_ada");
        let before = authority.epoch.load(Ordering::SeqCst);
        authority.revoke(&ada, "person_not_member");
        authority.observe(&ada, &Ok(vec![]), before);
        assert_eq!(authority.revocation(&ada), Some("person_not_member"));
        // Whoever asked is refused too, not handed the stale member answer.
        assert_eq!(authority.partition_revocation(&ada.partition()), Some("person_not_member"));
        authority.observe(&ada, &Ok(vec![]), authority.epoch.load(Ordering::SeqCst));
        assert_eq!(authority.revocation(&ada), None);
    }

    #[tokio::test]
    async fn suspension_revokes_the_whole_organization_and_resumption_only_invalidates() {
        let _turn = ENFORCER_TURN.lock().await;
        let org = "org_standing_suspend";
        let standing = test_support::Installed::new(org);
        // Every organization the enforcer reports has a stand-in: no test
        // asks a real plane.
        let _other = test_support::Installed::new("org_standing_other");
        let (ada, bob, other) = (person(org, "usr_ada"), person(org, "usr_bob"), person("org_standing_other", "usr_cy"));
        let recorder = Arc::new(Recorder { org, active: vec![ada.clone(), bob.clone(), other.clone()], departed: Mutex::new(vec![]), workspaces: Mutex::new(vec![]) });
        install_enforcer(Some(recorder.clone()));
        let _installed = Installed;
        let authority = StandingAuthority::new();
        let mut closures = authority.closures();
        standing.refuse("org_suspended");
        authority.notice(&StandingChange { org: org.into(), user: None, workspace: None, kind: ChangeKind::OrgSuspended }).await;
        settle().await;
        let mut departed = recorder.departed.lock().clone();
        departed.sort_by(|a, b| a.0.user.cmp(&b.0.user));
        assert_eq!(departed, vec![(ada.clone(), "org_suspended"), (bob.clone(), "org_suspended")]);
        assert_eq!(closures.try_recv().unwrap(), SocketClosure::Org(org.into()));
        assert!(SocketClosure::Org(org.into()).closes("any", Some(&bob)));
        assert!(!SocketClosure::Org(org.into()).closes("any", Some(&other)));
        assert_eq!(authority.revocation(&person(org, "usr_new")), Some("org_suspended"));
        // Resuming starts nothing; the next lookup that finds a member clears it.
        standing.admit();
        authority.notice(&StandingChange { org: org.into(), user: None, workspace: None, kind: ChangeKind::OrgResumed }).await;
        assert_eq!(recorder.departed.lock().len(), 2);
        assert!(authority.admit(&ada).await.is_ok());
        assert_eq!(authority.revocation(&bob), None);
    }

    #[tokio::test]
    async fn a_workspace_removal_cancels_only_when_the_plane_confirms_it() {
        let _turn = ENFORCER_TURN.lock().await;
        let org = "org_standing_workspace";
        let standing = test_support::Installed::new(org);
        let ada = person(org, "usr_ada");
        let recorder = Arc::new(Recorder { org, active: vec![], departed: Mutex::new(vec![]), workspaces: Mutex::new(vec![]) });
        install_enforcer(Some(recorder.clone()));
        let _installed = Installed;
        let authority = StandingAuthority::new();
        let change = StandingChange { org: org.into(), user: Some("usr_ada".into()), workspace: Some("ws_a".into()), kind: ChangeKind::WorkspaceRemoved };
        // The stand-in answers a member with no actions: execution is gone.
        authority.notice(&change).await;
        assert_eq!(recorder.workspaces.lock().clone(), vec![(ada.clone(), "ws_a".to_string())]);
        // The plane cannot say: nothing is cancelled on a guess.
        standing.refuse("host_authority_unavailable");
        authority.notice(&change).await;
        assert_eq!(recorder.workspaces.lock().len(), 1);
        assert!(recorder.departed.lock().is_empty());
        assert_eq!(authority.revocation(&ada), None);
    }

    #[tokio::test]
    async fn a_role_change_only_drops_the_cached_answer() {
        let org = "org_standing_role";
        let standing = test_support::Installed::new(org);
        let authority = StandingAuthority::new();
        let ada = person(org, "usr_ada");
        assert!(authority.actions(&ada, None, Freshness::Cached).await.is_ok());
        standing.refuse("host_authority_unavailable");
        assert!(authority.actions(&ada, None, Freshness::Cached).await.is_ok());
        authority.notice(&StandingChange { org: org.into(), user: Some("usr_ada".into()), workspace: None, kind: ChangeKind::RoleChanged }).await;
        assert_eq!(authority.actions(&ada, None, Freshness::Cached).await.unwrap_err().code, "host_authority_unavailable");
        assert_eq!(authority.revocation(&ada), None);
    }

    #[tokio::test]
    async fn presence_counts_sockets_and_the_sweep_rechecks_them() {
        // The sweep also re-checks the people an installed enforcer reports.
        let _turn = ENFORCER_TURN.lock().await;
        let org = "org_standing_presence";
        let standing = test_support::Installed::new(org);
        let authority = StandingAuthority::new();
        let ada = person(org, "usr_ada");
        let first = authority.presence(ada.clone());
        let second = authority.presence(ada.clone());
        assert!(authority.active_people().contains(&ada));
        drop(first);
        assert!(authority.active_people().contains(&ada));
        standing.refuse("person_not_member");
        authority.sweep().await;
        assert_eq!(authority.revocation(&ada), Some("person_not_member"));
        drop(second);
        assert!(!authority.active_people().contains(&ada));
    }

    #[test]
    fn change_kinds_parse_the_planes_names_only() {
        for (name, kind) in [("offboarded", ChangeKind::Offboarded), ("role_changed", ChangeKind::RoleChanged),
            ("workspace_removed", ChangeKind::WorkspaceRemoved), ("org_suspended", ChangeKind::OrgSuspended),
            ("org_resumed", ChangeKind::OrgResumed)] {
            assert_eq!(ChangeKind::parse(name), Some(kind));
        }
        assert_eq!(ChangeKind::parse("Offboarded"), None);
        assert!(SocketClosure::Device("d".into()).closes("d", None));
        assert!(!SocketClosure::Person(person("o", "u")).closes("d", None));
    }
}
