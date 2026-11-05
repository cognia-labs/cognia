//! P6c chat ownership, durable since ADR-0253 §5. Independent of task-local
//! dispatch: sidecar readers and replay consumers run in other tasks. A claim
//! is removed only with its person's partition (purge), never while the
//! shared sidecar or its replay frames can still name the session.
use std::collections::HashMap;
use parking_lot::RwLock;
use once_cell::sync::Lazy;
use serde_json::Value;
use crate::{middleware::DeviceContext, person_partition::PersonPartition};

pub fn person_command_allowed(command: &str) -> bool {
    crate::host_surface_policy::POLICY.as_ref().is_ok_and(|policy| policy.person_brain_admits(command))
}

pub fn person_caller(principal: &DeviceContext, command: &str) -> Result<PersonPartition, cognia_problem::Problem> {
    let denied = || cognia_problem::Problem::with_status(axum::http::StatusCode::FORBIDDEN,
        "host_surface_forbidden", "host_surface_forbidden");
    if principal.scope != "person-brain" || !person_command_allowed(command) {
        log::warn!("person brain command refused: {command:?} is outside the closed partition channel (scope {})", principal.scope);
        return Err(denied());
    }
    crate::person_partition::fleet().and_then(|fleet| fleet.person(&principal.tenant_id)).ok_or_else(|| {
        log::warn!("person brain command refused: {command:?}, no partition for this principal");
        denied()
    })
}

/// ADR-0253 §5 session fence: which person partition owns a session id
/// (`Some(account)`), or the operator (`None`). Claims write through to the
/// installed security store, so a Host restart keeps every fence; without a
/// store (a desktop Host, unit tests) they live in memory only. A claim is
/// synchronous: callers fence before any await, so a member's first send and
/// an operator control cannot both win.
#[derive(Default)]
pub struct PersonSessions(RwLock<Claims>);
#[derive(Default)]
struct Claims {
    /// The store these claims were loaded from; another store reloads them.
    store: Option<std::sync::Weak<crate::security_store::SecurityStore>>,
    owners: HashMap<String, Option<String>>,
}
type Store = std::sync::Arc<crate::security_store::SecurityStore>;
fn same_store(loaded: &Option<std::sync::Weak<crate::security_store::SecurityStore>>, store: Option<&Store>) -> bool {
    match (loaded.as_ref().and_then(std::sync::Weak::upgrade), store) {
        (Some(loaded), Some(store)) => std::sync::Arc::ptr_eq(&loaded, store),
        (None, None) => loaded.is_none(),
        _ => false,
    }
}
pub static PERSON_SESSIONS: Lazy<PersonSessions> = Lazy::new(PersonSessions::default);
impl PersonSessions {
    /// Load the installed store's claims the first time it is seen.
    fn sync(&self, store: Option<&Store>) -> Result<(), &'static str> {
        if same_store(&self.0.read().store, store) { return Ok(()); }
        let mut claims = self.0.write();
        if same_store(&claims.store, store) { return Ok(()); }
        let mut owners = HashMap::new();
        if let Some(store) = store {
            owners.extend(store.session_owners().map_err(|error| {
                log::error!("person session claims could not be loaded: {error}");
                "person_storage_failed"
            })?);
        }
        *claims = Claims { store: store.map(std::sync::Arc::downgrade), owners };
        Ok(())
    }
    /// Claim `session` for `person` (`None`: the operator), or confirm the
    /// claim on record is theirs.
    pub fn bind(&self, session: &str, person: Option<&PersonPartition>) -> Result<(), &'static str> {
        let store = crate::security_store::security_store();
        self.sync(store.as_ref())?;
        let wanted = person.map(|p| p.account_id.clone());
        let mut claims = self.0.write();
        let owner = match claims.owners.get(session) {
            Some(owner) => owner.clone(),
            None => {
                let owner = match &store {
                    Some(store) => store.claim_session_owner(session, wanted.as_deref(), chrono::Utc::now().timestamp())
                        .map_err(|error| {
                            log::error!("person session claim could not be recorded: {error}");
                            "person_storage_failed"
                        })?,
                    None => wanted.clone(),
                };
                claims.owners.insert(session.into(), owner.clone());
                owner
            }
        };
        if owner != wanted { return Err("session_partition_mismatch"); }
        Ok(())
    }
    /// The caller may drive `session`: it is theirs, or it is unclaimed and
    /// the caller is the operator.
    pub fn check(&self, session: &str, person: Option<&PersonPartition>) -> Result<(), &'static str> {
        self.sync(crate::security_store::security_store().as_ref())?;
        let claims = self.0.read();
        let wanted = person.map(|p| &p.account_id);
        match claims.owners.get(session) {
            Some(owner) if owner.as_ref() == wanted => Ok(()),
            None if person.is_none() => Ok(()),
            _ => Err("session_partition_mismatch"),
        }
    }
    fn check_existing(&self, session: &str, person: Option<&PersonPartition>) -> Result<(), &'static str> {
        self.sync(crate::security_store::security_store().as_ref())?;
        let claims = self.0.read();
        if let Some(owner) = claims.owners.get(session) {
            if owner.as_ref() != person.map(|p| &p.account_id) { return Err("session_partition_mismatch"); }
        }
        Ok(())
    }
    /// The person partition that claimed `session`, if one did. Never records
    /// a claim: an unclaimed session's frames are published as the operator's.
    /// A store that cannot be read leaves the claims already loaded in force.
    pub fn owner_account(&self, session: &str) -> Option<String> {
        let _ = self.sync(crate::security_store::security_store().as_ref());
        self.0.read().owners.get(session).cloned().flatten()
    }
    /// The sessions `account_id`'s partition claimed.
    pub fn sessions_of(&self, account_id: &str) -> Vec<String> {
        let _ = self.sync(crate::security_store::security_store().as_ref());
        let mut sessions: Vec<String> = self.0.read().owners.iter()
            .filter(|(_, owner)| owner.as_deref() == Some(account_id))
            .map(|(session, _)| session.clone()).collect();
        sessions.sort();
        sessions
    }
    /// A purged person's claims go with their partition (ADR-0253 §6).
    pub fn forget_person(&self, account_id: &str) -> Result<usize, &'static str> {
        let store = crate::security_store::security_store();
        self.sync(store.as_ref())?;
        let removed = match &store {
            Some(store) => store.forget_person_sessions(account_id).map_err(|error| {
                log::error!("person session claims could not be removed: {error}");
                "person_storage_failed"
            })?,
            None => 0,
        };
        let mut claims = self.0.write();
        let before = claims.owners.len();
        claims.owners.retain(|_, owner| owner.as_deref() != Some(account_id));
        Ok(removed.max(before - claims.owners.len()))
    }
}

/// P6c also guards legacy/service session control aliases and nested params.
fn person_control_session_ids(args: &Value) -> Vec<&str> {
    let mut ids = Vec::new();
    match args {
        Value::Object(map) => for (key, value) in map {
            if matches!(key.as_str(), "sessionId" | "session_id" | "resumeSessionId" | "forkFromSessionId" | "ownerSessionId") {
                if let Some(session) = value.as_str() { ids.push(session); }
            }
            // User prompts/messages may mention ids without driving them.
            if matches!(key.as_str(), "params" | "options" | "sendOptions" | "request" | "input" | "intent" | "payload" | "toolHost") {
                ids.extend(person_control_session_ids(value));
            }
        },
        Value::Array(values) => for value in values { ids.extend(person_control_session_ids(value)); },
        _ => (),
    }
    ids
}
pub fn person_check_session_args(args: &Value, person: Option<&PersonPartition>) -> Result<(), &'static str> {
    for session in person_control_session_ids(args) { PERSON_SESSIONS.check_existing(session, person)?; }
    Ok(())
}
/// Atomically fence operator control before any await/write. A check alone
/// would race a person's first send between validation and sidecar delivery.
pub fn person_claim_operator_control_args(args: &Value) -> Result<(), &'static str> {
    for session in person_control_session_ids(args) { PERSON_SESSIONS.bind(session, None)?; }
    Ok(())
}

pub fn person_event_session(payload: &Value) -> Option<&str> {
    payload.get("sessionId").or_else(|| payload.get("session_id")).and_then(Value::as_str)
        .or_else(|| payload.get("event").and_then(person_event_session))
}

/// Tool-less turns the Host interrupted because their person's standing
/// ended (ADR-0253 §3), by session: the turn's end carries the reason.
static REVOKED_TURNS: Lazy<parking_lot::Mutex<HashMap<String, &'static str>>> = Lazy::new(Default::default);

/// The session's running turn is being stopped for `code`; its
/// `session_ended` frame will say so, whatever the runtime made of the
/// interrupt.
pub fn mark_turn_revoked(session: &str, code: &'static str) {
    REVOKED_TURNS.lock().insert(session.to_string(), code);
}

/// Forget a mark whose turn never reported its end (the runtime was gone).
pub fn forget_turn_revoked(session: &str) {
    REVOKED_TURNS.lock().remove(session);
}

fn stamp_revoked_turn(channel: &str, payload: &Value) -> Option<Value> {
    if channel != "claude://message" || payload.get("type").and_then(Value::as_str) != Some("session_ended") {
        return None;
    }
    let session = payload.get("sessionId").and_then(Value::as_str)?;
    let code = REVOKED_TURNS.lock().remove(session)?;
    let mut stamped = payload.clone();
    stamped["error"] = Value::String(code.into());
    stamped["code"] = Value::String(code.into());
    Some(stamped)
}

/// Stamp the partition at publication, before the replay buffer: one frame
/// per event, which every transport delivers only to the person's own brain
/// and the devices bound to them at delivery (`person_partition::
/// event_visible`), live and on replay alike.
pub fn person_publish(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value) {
    if let Some(account) = person_event_session(payload).and_then(|session| PERSON_SESSIONS.owner_account(session)) {
        let payload = stamp_revoked_turn(channel, payload).unwrap_or_else(|| payload.clone());
        bus.publish_person(channel.into(), payload, account);
    } else { bus.publish(channel.into(), payload.clone()); }
}

/// Also used by the gateway's Host-stamped member-ticket audience, before a
/// first agent_send binds the session. Brain-supplied payloads cannot call it.
///
/// Never one frame per device: every frame crosses the one shared broadcast
/// channel and replay buffer, so a copy per device the person ever paired
/// turned each streamed chunk into dozens of frames, overflowed the channel
/// and closed every subscriber on the Host, whoever's they were.
pub fn person_publish_to(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value, person: &PersonPartition) {
    bus.publish_person(channel.into(), payload.clone(), person.account_id.clone());
}
/// A member brain's live in-flight reply (`transcript://live`): one frame for
/// the person's partition, never replayed. Delivery resolves the audience to
/// the devices bound to the person at that moment (`person_partition::
/// event_visible`); the person's own brain may see it too, and never
/// subscribes to it.
pub fn person_publish_live(bus: &crate::event_bus::EventBus, channel: &str, payload: &Value, person: &PersonPartition) {
    bus.publish_person_ephemeral(channel.into(), payload.clone(), person.account_id.clone());
}

/// Apply before serializing replay/live frames. The service sidecar exception
/// in EventFrame::visible_to_connection must never bypass person ownership.
pub fn person_connection_visible(frame: &crate::event_bus::EventFrame, device: &str, tenant: Option<&str>) -> bool {
    if let Some(account) = tenant.filter(|account| device == format!("brain-{account}")) {
        return frame.partition_account_id.as_deref() == Some(account) && frame.visible_to(device);
    }
    // Defence for another Host publisher that retained a session id but did
    // not stamp routing. Never apply the service sidecar visibility exception.
    if frame.partition_account_id.is_none()
        && person_event_session(&frame.payload).and_then(|session| PERSON_SESSIONS.owner_account(session)).is_some() {
        return false;
    }
    if frame.partition_account_id.is_some() {
        return frame.visible_to(device) && crate::person_partition::event_visible(frame, device, tenant);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adr0253_session_claims_survive_a_restart_and_publishing_never_claims() {
        use crate::security_store::SecurityStore;
        let _guard = crate::security_store::test_guard();
        let previous = crate::security_store::security_store();
        struct Restore(Option<std::sync::Arc<SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { crate::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(previous);
        crate::security_store::install_security_store(Some(SecurityStore::in_memory().unwrap()));
        let bob = PersonPartition::new("org_adr0253".into(), "usr_adr0253_bob".into());
        let before = PersonSessions::default();
        before.bind("adr0253-bob", Some(&bob)).unwrap();
        before.bind("adr0253-operator", None).unwrap();
        // A restart: a new fence over the same store keeps every claim.
        let after = PersonSessions::default();
        assert_eq!(after.bind("adr0253-bob", None), Err("session_partition_mismatch"));
        assert_eq!(after.check("adr0253-bob", None), Err("session_partition_mismatch"));
        after.check("adr0253-bob", Some(&bob)).unwrap();
        assert_eq!(after.bind("adr0253-operator", Some(&bob)), Err("session_partition_mismatch"));
        assert_eq!(after.owner_account("adr0253-bob"), Some(bob.account_id.clone()));
        // Seeing a session id while publishing records no owner, so a member
        // may still claim it afterwards.
        assert_eq!(after.owner_account("adr0253-published"), None);
        after.bind("adr0253-published", Some(&bob)).unwrap();
        assert_eq!(after.sessions_of(&bob.account_id), vec!["adr0253-bob", "adr0253-published"]);
        // A purge removes the person's claims and only theirs.
        assert_eq!(after.forget_person(&bob.account_id), Ok(2));
        let rejoined = PersonSessions::default();
        rejoined.bind("adr0253-bob", None).unwrap();
        assert_eq!(rejoined.bind("adr0253-operator", Some(&bob)), Err("session_partition_mismatch"));
    }

    #[test]
    fn adr0253_a_revoked_turn_ends_with_its_reason_once() {
        let ended = serde_json::json!({"type":"session_ended","sessionId":"adr0253-revoked","result":{"subtype":"interrupted"}});
        assert!(stamp_revoked_turn("claude://message", &ended).is_none());
        mark_turn_revoked("adr0253-revoked", "revoked_during_run");
        // Only the session's end carries it, on the sidecar channel only.
        assert!(stamp_revoked_turn("claude://message", &serde_json::json!({"type":"text","sessionId":"adr0253-revoked"})).is_none());
        assert!(stamp_revoked_turn("agent://event", &ended).is_none());
        let stamped = stamp_revoked_turn("claude://message", &ended).unwrap();
        assert_eq!((stamped["error"].as_str(), stamped["code"].as_str()), (Some("revoked_during_run"), Some("revoked_during_run")));
        assert_eq!(stamped["result"], ended["result"]);
        assert!(stamp_revoked_turn("claude://message", &ended).is_none());
        mark_turn_revoked("adr0253-revoked", "revoked_during_run");
        forget_turn_revoked("adr0253-revoked");
        assert!(stamp_revoked_turn("claude://message", &ended).is_none());
    }

    #[test]
    fn person_events_publish_once_however_many_devices_the_person_has() {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let _guard = crate::security_store::test_guard();
        let previous = crate::security_store::security_store();
        struct Restore(Option<std::sync::Arc<SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { crate::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(previous);
        let store = SecurityStore::in_memory().unwrap();
        let owner = VerifiedDevicePerson { org_id: OrgId::parse("org_many_devices").unwrap(), user_id: UserId::parse("usr_many_devices").unwrap() };
        for index in 0..60 {
            let device = format!("many-device-{index}");
            let challenge = store.issue_challenge("many-tenant", 100, 60).unwrap();
            store.register_oidc_device("many-tenant", &device, &owner, &challenge.id, &challenge.nonce,
                &device, "Web", "pem", &device, "member", 101).unwrap();
        }
        crate::security_store::install_security_store(Some(store));
        let person = PersonPartition::new(owner.org_id.to_string(), owner.user_id.to_string());
        let bus = crate::event_bus::EventBus::new();
        let channels = ["claude://message", "host-state://action", "sync://invalidate", "transcript://revision"];
        for channel in channels {
            person_publish_to(&bus, channel, &serde_json::json!({"sessionId":"many-devices"}), &person);
        }
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else {
            panic!("replay");
        };
        assert_eq!(replay.len(), channels.len(), "one frame per event, not one per device");
        for frame in &replay {
            assert_eq!(frame.partition_account_id.as_deref(), Some(person.account_id.as_str()));
            assert!(frame.target_device_id.is_none());
            assert!(person_connection_visible(frame, "many-device-0", Some("many-tenant")));
            assert!(person_connection_visible(frame, "many-device-59", Some("many-tenant")));
        }
        // A request one device started is still the person's: their brain and
        // every device hear it, not only the device it came from.
        let request = person_publish_to_frame(&bus, &person, serde_json::json!({
            "sessionId": "many-devices",
            "remoteExecutionContext": {"originDeviceId": "many-device-0"},
        }));
        assert!(request.target_device_id.is_none());
        let brain = format!("brain-{}", person.account_id);
        assert!(person_connection_visible(&request, &brain, Some(&person.account_id)));
        assert!(person_connection_visible(&request, "many-device-59", Some("many-tenant")));
    }

    fn person_publish_to_frame(bus: &crate::event_bus::EventBus, person: &PersonPartition, payload: Value) -> crate::event_bus::EventFrame {
        let crate::event_bus::SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else { panic!("live"); };
        person_publish_to(bus, "claude://message", &payload, person);
        receiver.try_recv().expect("one frame")
    }

    #[tokio::test]
    async fn p6c_live_and_replay_audiences_are_owner_brain_and_current_owner_devices_only() {
        person_test_audiences(&["claude://message", "agent://event", "a2ui://dispatch", "gateway://request-outcome"]).await;
    }
    #[tokio::test]
    async fn p6d_external_agent_live_and_replay_audiences_include_only_owner_brain_and_devices() {
        person_test_audiences(&["external-agent://spawn", "external-agent://stdout", "external-agent://stdout-raw", "external-agent://stderr",
            "external-agent://state-change", "external-agent://exit", "external-agent://placement", "external-agent://session-event", "external-agent://workspace-publish"]).await;
    }
    async fn person_test_audiences(channels: &[&str]) {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let _guard = crate::security_store::test_guard();
        let previous = crate::security_store::security_store();
        struct Restore(Option<std::sync::Arc<SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { crate::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(previous);
        let store = SecurityStore::in_memory().unwrap();
        let owner = VerifiedDevicePerson { org_id:OrgId::parse("org_p6c_audience").unwrap(), user_id:UserId::parse("usr_p6c_owner").unwrap() };
        let other = VerifiedDevicePerson { org_id:owner.org_id.clone(), user_id:UserId::parse("usr_p6c_other").unwrap() };
        for (device, person) in [("p6c-owner-phone", &owner), ("p6c-owner-web", &owner), ("p6c-other-phone", &other)] {
            let challenge = store.issue_challenge("p6c-tenant", 100, 60).unwrap();
            store.register_oidc_device("p6c-tenant", device, person, &challenge.id, &challenge.nonce,
                device, "Web", "pem", device, "member", 101).unwrap();
        }
        crate::security_store::install_security_store(Some(store.clone()));
        let person = PersonPartition::new(owner.org_id.to_string(), owner.user_id.to_string());
        let brain = format!("brain-{}", person.account_id);
        PERSON_SESSIONS.bind("p6c-audience-session", Some(&person)).unwrap();
        let bus = crate::event_bus::EventBus::new();
        let crate::event_bus::SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else { panic!("live"); };
        for channel in channels {
            person_publish(&bus, channel, &serde_json::json!({"sessionId":"p6c-audience-session","type":"text"}));
        }
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert_eq!(replay.len(), channels.len(), "one frame per event for the whole partition");
        let audience = |frame: &crate::event_bus::EventFrame| -> Vec<&str> {
            [(brain.as_str(), Some(person.account_id.as_str())),
                ("p6c-owner-phone", Some("p6c-tenant")), ("p6c-owner-web", None),
                ("p6c-other-phone", Some("p6c-tenant")), ("__service__", Some("operator")),
                ("brain-other", Some("other"))].into_iter()
                .filter(|(device, tenant)| person_connection_visible(frame, device, *tenant)).map(|(device, _)| device).collect()
        };
        for frame in &replay {
            assert_eq!(receiver.try_recv().unwrap().seq, frame.seq);
            assert!(frame.target_device_id.is_none());
            assert_eq!(audience(frame), vec![brain.as_str(), "p6c-owner-phone", "p6c-owner-web"], "{}", frame.event_type);
        }
        // A retained frame cannot follow a device reassigned to another person.
        store.assign_device_user("p6c-tenant", "p6c-owner-web", Some(other.user_id.as_str()), 102).unwrap();
        for frame in &replay {
            assert_eq!(audience(frame), vec![brain.as_str(), "p6c-owner-phone"], "{}", frame.event_type);
        }
        let unmarked = bus.publish("claude://message".into(), serde_json::json!({"sessionId":"p6c-audience-session"}));
        assert!(!person_connection_visible(&unmarked, "__service__", Some("operator")));
        let legacy = bus.publish("claude://message".into(), serde_json::json!({"sessionId":"p6c-operator-event"}));
        assert!(person_connection_visible(&legacy, "__service__", Some("operator")));
        assert!(!person_connection_visible(&legacy, &brain, Some(&person.account_id)));
    }

    #[tokio::test]
    async fn p6e_live_reply_frames_reach_only_the_owners_devices_and_never_replay() {
        use crate::security_store::{SecurityStore, VerifiedDevicePerson};
        use cognia_tenant_auth::{OrgId, UserId};
        let _guard = crate::security_store::test_guard();
        let previous = crate::security_store::security_store();
        struct Restore(Option<std::sync::Arc<SecurityStore>>);
        impl Drop for Restore { fn drop(&mut self) { crate::security_store::install_security_store(self.0.take()); } }
        let _restore = Restore(previous);
        let store = SecurityStore::in_memory().unwrap();
        let owner = VerifiedDevicePerson { org_id:OrgId::parse("org_p6e_live").unwrap(), user_id:UserId::parse("usr_p6e_owner").unwrap() };
        let other = VerifiedDevicePerson { org_id:owner.org_id.clone(), user_id:UserId::parse("usr_p6e_other").unwrap() };
        for (device, person) in [("p6e-owner-phone", &owner), ("p6e-owner-web", &owner), ("p6e-other-phone", &other)] {
            let challenge = store.issue_challenge("p6e-tenant", 100, 60).unwrap();
            store.register_oidc_device("p6e-tenant", device, person, &challenge.id, &challenge.nonce,
                device, "Web", "pem", device, "member", 101).unwrap();
        }
        crate::security_store::install_security_store(Some(store.clone()));
        let person = PersonPartition::new(owner.org_id.to_string(), owner.user_id.to_string());
        let bus = crate::event_bus::EventBus::new();
        let crate::event_bus::SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else { panic!("live"); };
        person_publish_live(&bus, "transcript://live", &serde_json::json!({"sessionId":"p6e-live","parts":[]}), &person);
        let frame = receiver.try_recv().expect("one frame");
        assert!(receiver.try_recv().is_err(), "one frame for the person, not one per device");
        let brain = format!("brain-{}", person.account_id);
        let audience = |frame: &crate::event_bus::EventFrame| -> Vec<String> {
            [(brain.clone(), Some(person.account_id.clone())),
                ("p6e-owner-phone".to_string(), Some("p6e-tenant".to_string())), ("p6e-owner-web".to_string(), None),
                ("p6e-other-phone".to_string(), Some("p6e-tenant".to_string())), ("__service__".to_string(), Some("operator".to_string())),
                ("brain-other".to_string(), Some("other".to_string()))]
                .into_iter().filter(|(device, tenant)| person_connection_visible(frame, device, tenant.as_deref())
                    && crate::person_partition::event_visible(frame, device, tenant.as_deref()))
                .map(|(device, _)| device).collect()
        };
        assert_eq!(audience(&frame), vec![brain.clone(), "p6e-owner-phone".to_string(), "p6e-owner-web".to_string()]);
        // Delivery re-reads standing: a device moved to someone else stops receiving.
        store.assign_device_user("p6e-tenant", "p6e-owner-web", Some(other.user_id.as_str()), 102).unwrap();
        assert_eq!(audience(&frame), vec![brain.clone(), "p6e-owner-phone".to_string()]);
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert!(replay.is_empty());

        person_publish_to(&bus, "sync://invalidate", &serde_json::json!({"table":"messages"}), &person);
        let invalidation = receiver.try_recv().expect("partition invalidation");
        assert!(receiver.try_recv().is_err());
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, invalidation.seq);
        assert_eq!(audience(&replay[0]), vec![format!("brain-{}", person.account_id), "p6e-owner-phone".to_string()]);
    }

    #[test]
    fn p6c_partition_data_ids_need_no_turn_but_existing_turns_keep_their_owner() {
        let a = PersonPartition::new("org".into(), "p6c-data-a".into());
        let b = PersonPartition::new("org".into(), "p6c-data-b".into());
        assert!(person_check_session_args(&serde_json::json!({"sessionId":"p6c-new-data-id"}), Some(&a)).is_ok());
        PERSON_SESSIONS.bind("p6c-data-owned", Some(&a)).unwrap();
        assert!(person_check_session_args(&serde_json::json!({"sessionId":"p6c-data-owned"}), Some(&a)).is_ok());
        assert!(person_check_session_args(&serde_json::json!({"sessionId":"p6c-data-owned"}), Some(&b)).is_err());
        assert!(person_check_session_args(&serde_json::json!({"params":{"sessionId":"p6c-data-owned"}}), None).is_err());
        assert!(person_check_session_args(&serde_json::json!({"prompt":[{"sessionId":"p6c-data-owned"}]}), None).is_ok());
    }

    #[test]
    fn p6c_session_owner_fences_other_member_operator_and_service() {
        let sessions = PersonSessions::default();
        let a = PersonPartition::new("org".into(), "a".into());
        let b = PersonPartition::new("org".into(), "b".into());
        sessions.bind("a", Some(&a)).unwrap();
        assert!(sessions.bind("a", Some(&b)).is_err());
        assert!(sessions.bind("a", None).is_err());
        assert!(sessions.check("a", None).is_err());
        assert!(sessions.check("a", Some(&a)).is_ok());
        sessions.bind("operator", None).unwrap();
        assert!(sessions.bind("operator", Some(&a)).is_err());
    }
    #[test]
    fn p6c_policy_is_the_dispatch_allowlist() {
        for command in ["person_model_ticket_mint", "agent_send", "agent_interrupt", "agent_close_session"] { assert!(person_command_allowed(command)); }
        for command in ["org_model_credential_set", "secret_store_get", "sync_pull", "session_list", "agent_start", "claude_send", "claude_close_session"] { assert!(!person_command_allowed(command)); }
    }
    #[test]
    fn p6c_partition_event_publication_and_replay_exclude_operator_and_other_brains() {
        let person = PersonPartition::new("org".into(), "event-owner".into());
        PERSON_SESSIONS.bind("p6c-event-session", Some(&person)).unwrap();
        let bus = crate::event_bus::EventBus::new();
        person_publish(&bus, "claude://message", &serde_json::json!({"sessionId":"p6c-event-session","type":"text"}));
        let crate::event_bus::SubscribeResult::Ok { replay, .. } = bus.subscribe(Some(0), 0) else { panic!("replay"); };
        assert_eq!(replay.len(), 1);
        let frame = &replay[0];
        assert!(person_connection_visible(frame, &format!("brain-{}", person.account_id), Some(&person.account_id)));
        assert!(!person_connection_visible(frame, "__service__", Some("operator")));
        assert!(!person_connection_visible(frame, "brain-other", Some("other")));
    }
}
