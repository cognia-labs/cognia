//! agent-desktop application-session adapter. Native elements never enter this map.
mod process;
mod protocol;

use crate::automation::{
    execution::Admission,
    session::{ResolvedApplication, UiAction},
    types::{AutomationError, ElementInfo, ElementRef, MouseButton, Result},
};
use process::Client;
pub(crate) use process::ExecutorLease;
pub(crate) use protocol::{Delivery, PROFILE, VERSION};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

struct Binding {
    upstream: String,
    session: String,
    directory: PathBuf,
    window: u64,
    process: u32,
    process_birth: String,
}

struct StateDirectory {
    path: PathBuf,
    admission: Admission,
}

pub(crate) struct AgentDesktop {
    client: Client,
    boot: String,
    bindings: HashMap<String, Binding>,
    directories: HashMap<String, StateDirectory>,
    root: PathBuf,
    probed: bool,
}

impl Drop for AgentDesktop {
    fn drop(&mut self) {
        if !self.is_quarantined() {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

impl AgentDesktop {
    pub fn prune_revoked(&mut self) -> Vec<String> {
        let expired: HashSet<_> = self
            .directories
            .iter()
            .filter(|(_, state)| state.admission.check().is_err())
            .map(|(session, _)| session.clone())
            .collect();
        self.remove_sessions(&expired);
        expired.into_iter().collect()
    }

    fn remove_sessions(&mut self, sessions: &HashSet<String>) {
        if sessions.is_empty() {
            return;
        }
        for session in sessions {
            if let Some(state) = self.directories.remove(session) {
                if !self.is_quarantined() {
                    let _ = std::fs::remove_dir_all(state.path);
                }
            }
        }
        self.bindings
            .retain(|_, binding| !sessions.contains(&binding.session));
    }
    pub fn is_quarantined(&self) -> bool {
        self.client
            .quarantined
            .load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn new(binary: PathBuf, lease: Arc<ExecutorLease>) -> Result<Self> {
        let boot = Uuid::new_v4().to_string();
        let root = crate::automation::persist::dir()
            .ok_or_else(protocol::incompatible)?
            .join("agent-desktop")
            .join(&boot);
        let client = match Client::new(binary, lease, &root.join("executor")) {
            Ok(client) => client,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&root);
                return Err(error);
            }
        };
        Ok(Self {
            client,
            boot,
            bindings: HashMap::new(),
            directories: HashMap::new(),
            root,
            probed: false,
        })
    }

    pub fn probe(&self, admission: &Admission) -> Result<()> {
        let state = self.root.join("probe");
        let version = self
            .client
            .run(&state, "version", &[], None, admission)
            .map_err(|error| error.error)?
            .read()?;
        protocol::verify_version(&version)?;
        let permissions = self
            .client
            .run(&state, "permissions", &[], None, admission)
            .map_err(|error| error.error)?
            .read()?;
        if permissions["accessibility"]["state"] != "granted" {
            return Err(AutomationError::PermissionDenied {
                reason: "agent-desktop requires Accessibility permission".into(),
            });
        }
        Ok(())
    }

    pub fn snapshot(
        &mut self,
        session: &str,
        app: &ResolvedApplication,
        window: u64,
        depth: u32,
        admission: &Admission,
    ) -> Result<(Vec<ElementInfo>, bool)> {
        self.prune_revoked();
        let existed = self.directories.contains_key(session);
        let result = self.snapshot_inner(session, app, window, depth, admission);
        if result.is_err() && !existed {
            self.remove_sessions(&HashSet::from([session.to_owned()]));
        }
        result
    }

    fn snapshot_inner(
        &mut self,
        session: &str,
        app: &ResolvedApplication,
        window: u64,
        depth: u32,
        admission: &Admission,
    ) -> Result<(Vec<ElementInfo>, bool)> {
        admission.check()?;
        if !self.probed {
            self.probe(admission)?;
            self.probed = true;
        }
        if !self.directories.contains_key(session) && self.directories.len() >= 64 {
            return Err(AutomationError::PermissionDenied {
                reason: "agent-desktop session capacity reached".into(),
            });
        }
        let directory = self
            .directories
            .entry(session.to_owned())
            .or_insert_with(|| StateDirectory {
                path: self.root.join(Uuid::new_v4().to_string()),
                admission: admission.clone(),
            });
        directory.admission = admission.clone();
        let directory = directory.path.clone();
        let filter = app
            .bundle_id
            .as_ref()
            .ok_or(AutomationError::UnsupportedPlatform)?;
        let birth = process_birth(app.process_id)?;
        let windows = self
            .client
            .run(
                &directory,
                "list-windows",
                &["--app".into(), filter.clone()],
                None,
                admission,
            )
            .map_err(|error| error.error)?
            .read()?;
        let window_id = format!("w-{window}");
        let owner = windows
            .as_array()
            .and_then(|windows| {
                windows
                    .iter()
                    .find(|candidate| candidate["id"] == window_id)
            })
            .ok_or(AutomationError::StaleElement)?;
        if owner["pid"].as_u64() != Some(u64::from(app.process_id))
            || owner["process_instance"].as_str() != Some(birth.as_str())
        {
            return Err(AutomationError::StaleElement);
        }
        let data = self
            .client
            .run(
                &directory,
                "snapshot",
                &[
                    "--app".into(),
                    filter.clone(),
                    "--window-id".into(),
                    window_id.clone(),
                    "--max-depth".into(),
                    depth.clamp(1, 50).to_string(),
                ],
                None,
                admission,
            )
            .map_err(|error| error.error)?
            .read()?;
        if data["window"]["id"] != window_id || process_birth(app.process_id)? != birth {
            return Err(AutomationError::StaleElement);
        }
        let snapshot = data["snapshot_id"]
            .as_str()
            .filter(|id| safe_snapshot(id))
            .ok_or_else(protocol::incompatible)?;
        let mut bindings = HashMap::new();
        let mut budget = 25_000usize;
        let mut root = project(
            &data["tree"],
            app,
            &self.boot,
            snapshot,
            &mut budget,
            &mut |local, upstream| {
                bindings.insert(
                    local,
                    Binding {
                        upstream,
                        session: session.into(),
                        directory: directory.clone(),
                        window,
                        process: app.process_id,
                        process_birth: birth.clone(),
                    },
                );
            },
        )?;
        root.window_title = data["window"]["title"].as_str().map(str::to_owned);
        self.bindings
            .retain(|_, binding| binding.session != session);
        self.bindings.extend(bindings);
        Ok((vec![root], data["complete"] == true))
    }

    pub fn perform(
        &mut self,
        session: &str,
        element: &ElementRef,
        window: u64,
        action: &UiAction,
        admission: &Admission,
    ) -> (Delivery, Option<&'static str>) {
        if !admission.is_run_bound() {
            return (Delivery::NotDelivered, Some("runScopeRequired"));
        }
        let Some(binding) = self.bindings.get(&element.0) else {
            return (Delivery::NotDelivered, Some("staleEngineBinding"));
        };
        if binding.session != session
            || binding.window != window
            || process_birth(binding.process).ok().as_deref()
                != Some(binding.process_birth.as_str())
        {
            return (Delivery::NotDelivered, Some("targetIdentityChanged"));
        }
        let (command, arguments, input) = match action {
            UiAction::Click { button, count }
                if matches!(button, None | Some(MouseButton::Left)) && count.unwrap_or(1) == 1 =>
            {
                ("click", vec![binding.upstream.clone()], None)
            }
            UiAction::SetValue { value } => (
                "set-value",
                vec![binding.upstream.clone(), "--stdin".into()],
                Some(value.clone()),
            ),
            UiAction::SecondaryAction { name } if name == "toggle" => {
                ("toggle", vec![binding.upstream.clone()], None)
            }
            _ => return (Delivery::NotDelivered, Some("unsupportedSemanticAction")),
        };
        let outcome = self
            .client
            .run(&binding.directory, command, &arguments, input, admission);
        self.bindings
            .retain(|_, binding| binding.session != session);
        let revoked = admission.check().is_err();
        match outcome {
            Ok(envelope) if envelope.reports_physical_input() => {
                self.client
                    .quarantined
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                admission.quarantine();
                (Delivery::Uncertain, Some("forbiddenPhysicalMechanism"))
            }
            _ if revoked => (Delivery::Uncertain, Some("executionScopeRevoked")),
            Ok(envelope) => (
                envelope.delivery(),
                (!envelope.ok).then_some("engineRefused"),
            ),
            Err(error) => (error.delivery, Some("engineExecutionFailed")),
        }
    }
}

fn safe_snapshot(id: &str) -> bool {
    id.starts_with('s') && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn project(
    node: &Value,
    app: &ResolvedApplication,
    boot: &str,
    snapshot: &str,
    budget: &mut usize,
    bind: &mut impl FnMut(String, String),
) -> Result<ElementInfo> {
    if *budget == 0 {
        return Err(protocol::incompatible());
    }
    *budget -= 1;
    let local = format!("agentDesktop:{boot}:{}", Uuid::new_v4());
    if let Some(reference) = node["ref_id"].as_str() {
        let prefix = format!("@{snapshot}:e");
        if !reference.strip_prefix(&prefix).is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            return Err(protocol::incompatible());
        }
        bind(local.clone(), reference.to_owned());
    }
    let children = node["children"]
        .as_array()
        .map(|children| {
            children
                .iter()
                .map(|child| project(child, app, boot, snapshot, budget, bind))
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?;
    let disabled = node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|state| state == "disabled"));
    Ok(ElementInfo {
        element_ref: ElementRef(local),
        name: node["name"].as_str().map(str::to_owned),
        automation_id: node["native_id"]["value"].as_str().map(str::to_owned),
        control_type: node["role"].as_str().map(str::to_owned),
        class_name: None,
        // Vendor geometry cannot become a Native input coordinate.
        bounding_rect: None,
        is_enabled: !disabled,
        is_focused: false,
        process_id: Some(app.process_id),
        process_name: Some(app.display_name.clone()),
        window_title: None,
        children,
    })
}

#[cfg(target_os = "macos")]
fn process_birth(pid: u32) -> Result<String> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let result = unsafe {
        libc::proc_pidinfo(
            i32::try_from(pid).map_err(|_| AutomationError::StaleElement)?,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if result != size {
        return Err(AutomationError::StaleElement);
    }
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "macos-proc-v1:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}
#[cfg(not(target_os = "macos"))]
fn process_birth(_pid: u32) -> Result<String> {
    Err(AutomationError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_names_cannot_inject_a_ref_or_storage_path() {
        assert!(safe_snapshot("sabc123"));
        assert!(!safe_snapshot("s../other:e1"));
        assert!(!safe_snapshot("s:--headed"));
    }
}
