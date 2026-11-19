//! Whether a Python plugin's environment can load it (ENV01, ADR-0258).
//!
//! Readiness is computed from what the Host recorded when it built the
//! environment (the venv marker: requirements or the lock digest, interpreter
//! version, installer) and from the preparation it is running or last failed,
//! never by guessing import names from requirement strings. A plugin locked
//! with `uv.lock` (ENV02, `super::lock`) is measured against its lock instead
//! of its manifest requirements, and only uv prepares it. Preparing an environment downloads
//! and installs packages, so it is its own operation with its own consent; a
//! plugin whose environment is not ready is refused at enable with this state,
//! and the user prepares it from there.

use std::collections::{BTreeSet, HashMap};

use parking_lot::RwLock;
use serde::Serialize;

use super::interpreter_check::InterpreterWarning;
use super::venv::{RecordedEnvironment, VenvScope};
use crate::PluginError;

/// Why a recorded environment no longer matches the plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StaleReason {
    /// It was built for other requirements than the plugin declares now.
    Dependencies,
    /// It was built on another interpreter than the runtime's.
    Interpreter,
    /// Another installer built it than the one the settings select; the next
    /// preparation rebuilds it.
    Installer,
    /// It was not synced from the plugin's current `uv.lock`: built from
    /// another lock, from manifest requirements, or in the shared environment.
    Lock,
}

/// Why the Host does not manage the plugin's environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserManagedReason {
    /// The settings turned the Host's environment off (`useVenv: false`).
    VenvDisabled,
    /// The plugin runs on the user's own interpreter.
    InterpreterOverride,
    /// A custom installer the Host cannot inspect builds it.
    CustomInstaller,
}

/// Why a preparation failed, when the Host can tell. The app words it in the
/// user's language; the message stays the installer's account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FailureCause {
    /// `uv sync --locked` refused: `uv.lock` does not match `pyproject.toml`,
    /// and only the plugin's author can lock it again.
    LockOutOfDate,
    /// An offline install could not find these packages in the bundled wheels.
    MissingWheels { packages: Vec<String> },
}

/// The readiness states of ADR-0258 §2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Readiness {
    NotRequired,
    NotPrepared,
    /// The plugin is locked and uv cannot be found. There is no fallback to an
    /// unlocked install; installing uv comes first.
    NeedsUv,
    Stale {
        reasons: Vec<StaleReason>,
    },
    Preparing,
    Ready {
        scope: &'static str,
    },
    Failed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<FailureCause>,
    },
    UserManaged {
        reason: UserManagedReason,
    },
}

impl Readiness {
    /// Whether loading the plugin should wait for a preparation.
    pub fn blocks_load(&self) -> bool {
        matches!(
            self,
            Self::NotPrepared
                | Self::NeedsUv
                | Self::Stale { .. }
                | Self::Preparing
                | Self::Failed { .. }
        )
    }

    /// Whether the Host builds this environment: every state but
    /// `not-required` and `user-managed`.
    pub fn host_prepared(&self) -> bool {
        !matches!(self, Self::NotRequired | Self::UserManaged { .. })
    }
}

/// The `plugin_python_readiness` reply: the state, the installer a
/// preparation would run with, and the interpreter warning the load would
/// raise (P2), which never blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessReport {
    #[serde(flatten)]
    pub readiness: Readiness,
    /// `uv` or `pip`, for every state the Host prepares, so the consent to
    /// prepare can name it: on `auto` only the Host knows whether it has uv.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer: Option<&'static str>,
    /// Present when the plugin is locked with `uv.lock` (ENV02).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<LockSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpreter_warning: Option<InterpreterWarning>,
}

/// A locked plugin's lock, for the consent to prepare it and its settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSummary {
    /// What the lock pins (`name==version`), the plugin's project excluded.
    pub packages: Vec<String>,
    /// It installs offline from its bundled `wheels/`.
    pub offline: bool,
    /// The manifest also declares `pythonDependencies`, which the lock
    /// replaces: they are ignored, and the author should drop them.
    pub ignores_manifest_dependencies: bool,
}

/// A preparation the Host is running, or the last one that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preparation {
    Running,
    Failed(PreparationFailure),
}

/// How the last preparation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparationFailure {
    pub message: String,
    pub cause: Option<FailureCause>,
}

/// A failed preparation: the error its caller gets, and why, when the Host
/// can tell, for the readiness that follows.
#[derive(Debug)]
pub struct PrepareError {
    pub error: PluginError,
    pub cause: Option<FailureCause>,
}

impl From<PluginError> for PrepareError {
    fn from(error: PluginError) -> Self {
        Self { error, cause: None }
    }
}

/// Per-plugin preparations, held by the runtime state.
#[derive(Debug, Default)]
pub struct Preparations {
    by_plugin: RwLock<HashMap<String, Preparation>>,
}

impl Preparations {
    pub fn get(&self, plugin_id: &str) -> Option<Preparation> {
        self.by_plugin.read().get(plugin_id).cloned()
    }

    /// Mark a preparation as running. `None` when one already is: two
    /// installers writing one environment at once would corrupt it.
    pub fn begin<'a>(&'a self, plugin_id: &str) -> Option<PreparationGuard<'a>> {
        let mut by_plugin = self.by_plugin.write();
        if matches!(by_plugin.get(plugin_id), Some(Preparation::Running)) {
            return None;
        }
        by_plugin.insert(plugin_id.to_string(), Preparation::Running);
        Some(PreparationGuard {
            preparations: self,
            plugin_id: plugin_id.to_string(),
            finished: false,
        })
    }

    fn finish(&self, plugin_id: &str, failure: Option<PreparationFailure>) {
        let mut by_plugin = self.by_plugin.write();
        match failure {
            Some(failure) => {
                by_plugin.insert(plugin_id.to_string(), Preparation::Failed(failure));
            }
            None => {
                by_plugin.remove(plugin_id);
            }
        }
    }
}

/// Ends a running preparation. Dropped without [`PreparationGuard::finish`]
/// (the request was abandoned mid-install), it records a failure, so the
/// state never stays `preparing` for an install nobody is running.
pub struct PreparationGuard<'a> {
    preparations: &'a Preparations,
    plugin_id: String,
    finished: bool,
}

impl PreparationGuard<'_> {
    /// Record how the preparation ended: success clears it, a failure keeps
    /// its message and cause for the readiness that follows.
    pub fn finish<T>(mut self, result: &std::result::Result<T, PrepareError>) {
        self.finished = true;
        self.preparations.finish(
            &self.plugin_id,
            result.as_ref().err().map(|failure| PreparationFailure {
                message: failure.error.to_string(),
                cause: failure.cause.clone(),
            }),
        );
    }
}

impl Drop for PreparationGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.preparations.finish(
                &self.plugin_id,
                Some(PreparationFailure {
                    message: "the preparation stopped before it finished".to_string(),
                    cause: None,
                }),
            );
        }
    }
}

/// A locked plugin's side of the inputs.
pub struct LockInputs<'a> {
    /// sha256 of the plugin's current `uv.lock`.
    pub digest: &'a str,
    /// Whether uv can be found. Asked only when a preparation is needed: it
    /// probes.
    pub uv_available: &'a dyn Fn() -> bool,
}

/// What readiness is computed from.
pub struct ReadinessInputs<'a> {
    pub plugin_id: &'a str,
    /// The requirements the plugin declares (`pythonDependencies`). A locked
    /// plugin's lock replaces them.
    pub dependencies: &'a [String],
    /// Present when the plugin is locked with `uv.lock`.
    pub lock: Option<LockInputs<'a>>,
    /// `useVenv`; `false` means the user runs without the Host's environment.
    pub use_venv: bool,
    /// Whether the settings name the plugin's own interpreter.
    pub interpreter_override: bool,
    /// The installer the settings select, by recorded name (`uv`, `pip`,
    /// `custom`). Resolved lazily: `auto` probes for uv.
    pub expected_installer: &'a dyn Fn() -> &'static str,
    /// The runtime interpreter's version, which a new environment is built on.
    pub runtime_version: Option<&'a str>,
    pub environment: Option<&'a RecordedEnvironment>,
    pub preparation: Option<&'a Preparation>,
}

fn requirement_set(requirements: &[String]) -> BTreeSet<&str> {
    requirements
        .iter()
        .map(|requirement| requirement.trim())
        .filter(|requirement| !requirement.is_empty())
        .collect()
}

impl ReadinessInputs<'_> {
    /// The installer a preparation runs with: uv for a locked plugin, whatever
    /// the settings select, otherwise the one they select.
    pub fn installer(&self) -> &'static str {
        if self.lock.is_some() {
            "uv"
        } else {
            (self.expected_installer)()
        }
    }
}

/// Readiness from its inputs. Checked in order: whether there is anything to
/// prepare, whether the Host manages it, a running preparation, then the
/// recorded environment against the plugin (or its lock); a locked plugin
/// that needs preparing without uv needs uv first, and a failed preparation
/// explains an environment that does not match.
pub fn compute_readiness(inputs: &ReadinessInputs<'_>) -> Readiness {
    let declared = requirement_set(inputs.dependencies);
    if inputs.lock.is_none() && declared.is_empty() {
        return Readiness::NotRequired;
    }
    if !inputs.use_venv {
        return Readiness::UserManaged {
            reason: UserManagedReason::VenvDisabled,
        };
    }
    if inputs.interpreter_override {
        return Readiness::UserManaged {
            reason: UserManagedReason::InterpreterOverride,
        };
    }
    // The custom installer applies to unlocked plugins only; a locked one is
    // always synced by uv.
    if inputs.lock.is_none() && (inputs.expected_installer)() == "custom" {
        return Readiness::UserManaged {
            reason: UserManagedReason::CustomInstaller,
        };
    }
    if inputs.preparation == Some(&Preparation::Running) {
        return Readiness::Preparing;
    }

    let installer = inputs.installer();
    let stale = inputs.environment.map(|environment| {
        let mut reasons = Vec::new();
        match &inputs.lock {
            Some(lock) => {
                if environment.scope != VenvScope::Isolated
                    || environment.marker.lock_digest != lock.digest
                {
                    reasons.push(StaleReason::Lock);
                }
            }
            None => {
                let installed = environment.plugin_requirements(inputs.plugin_id);
                if requirement_set(&installed) != declared {
                    reasons.push(StaleReason::Dependencies);
                }
            }
        }
        let built_on = environment.marker.version.as_str();
        if built_on.is_empty() || inputs.runtime_version != Some(built_on) {
            reasons.push(StaleReason::Interpreter);
        }
        if environment.marker.installer != installer {
            reasons.push(StaleReason::Installer);
        }
        (environment.scope, reasons)
    });
    if let Some((scope, reasons)) = &stale {
        if reasons.is_empty() {
            return Readiness::Ready {
                scope: scope.as_str(),
            };
        }
    }
    // A preparation is needed. A locked plugin cannot have one without uv,
    // whatever the last attempt said.
    if let Some(lock) = &inputs.lock {
        if !(lock.uv_available)() {
            return Readiness::NeedsUv;
        }
    }
    match (stale, inputs.preparation) {
        (_, Some(Preparation::Failed(failure))) => Readiness::Failed {
            message: failure.message.clone(),
            cause: failure.cause.clone(),
        },
        (Some((_, reasons)), _) => Readiness::Stale { reasons },
        (None, _) => Readiness::NotPrepared,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::python::discover::Interpreter;
    use crate::python::venv::{VenvMarker, VenvScope};
    use std::collections::BTreeMap;

    fn deps(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn isolated(requirements: &[&str], version: &str, installer: &str) -> RecordedEnvironment {
        RecordedEnvironment {
            scope: VenvScope::Isolated,
            interpreter: Interpreter {
                argv_prefix: vec!["/v/bin/python".into()],
                version: Some(version.into()),
            },
            marker: VenvMarker {
                version: version.into(),
                installer: installer.into(),
                scope: "isolated".into(),
                deps: deps(requirements),
                ..Default::default()
            },
        }
    }

    struct Case<'a> {
        dependencies: Vec<String>,
        /// The lock digest, and whether uv can be found.
        lock: Option<(&'a str, bool)>,
        use_venv: bool,
        interpreter_override: bool,
        installer: &'static str,
        runtime_version: Option<&'a str>,
        environment: Option<RecordedEnvironment>,
        preparation: Option<Preparation>,
    }

    impl Default for Case<'_> {
        fn default() -> Self {
            Self {
                dependencies: deps(&["requests>=2", "pillow"]),
                lock: None,
                use_venv: true,
                interpreter_override: false,
                installer: "uv",
                runtime_version: Some("3.12.4"),
                environment: None,
                preparation: None,
            }
        }
    }

    fn readiness(case: Case<'_>) -> Readiness {
        let installer = case.installer;
        let uv_available = case.lock.map(|(_, available)| available).unwrap_or(true);
        let uv_available = move || uv_available;
        compute_readiness(&ReadinessInputs {
            plugin_id: "demo",
            dependencies: &case.dependencies,
            lock: case.lock.map(|(digest, _)| LockInputs {
                digest,
                uv_available: &uv_available,
            }),
            use_venv: case.use_venv,
            interpreter_override: case.interpreter_override,
            expected_installer: &move || installer,
            runtime_version: case.runtime_version,
            environment: case.environment.as_ref(),
            preparation: case.preparation.as_ref(),
        })
    }

    #[test]
    fn a_plugin_without_requirements_needs_nothing() {
        assert_eq!(
            readiness(Case {
                dependencies: deps(&[" ", ""]),
                ..Default::default()
            }),
            Readiness::NotRequired
        );
    }

    #[test]
    fn the_user_manages_what_the_host_does_not_build() {
        assert_eq!(
            readiness(Case {
                use_venv: false,
                ..Default::default()
            }),
            Readiness::UserManaged {
                reason: UserManagedReason::VenvDisabled
            }
        );
        assert_eq!(
            readiness(Case {
                interpreter_override: true,
                ..Default::default()
            }),
            Readiness::UserManaged {
                reason: UserManagedReason::InterpreterOverride
            }
        );
        assert_eq!(
            readiness(Case {
                installer: "custom",
                ..Default::default()
            }),
            Readiness::UserManaged {
                reason: UserManagedReason::CustomInstaller
            }
        );
    }

    #[test]
    fn no_environment_is_not_prepared() {
        assert_eq!(readiness(Case::default()), Readiness::NotPrepared);
    }

    #[test]
    fn a_matching_environment_is_ready() {
        let environment = isolated(&["pillow", " requests>=2 "], "3.12.4", "uv");
        assert_eq!(
            readiness(Case {
                environment: Some(environment),
                ..Default::default()
            }),
            Readiness::Ready { scope: "isolated" }
        );
    }

    #[test]
    fn a_shared_environment_counts_only_this_plugins_contribution() {
        let mut contributors = BTreeMap::new();
        contributors.insert("demo".to_string(), deps(&["requests>=2", "pillow"]));
        contributors.insert("other".to_string(), deps(&["numpy"]));
        let environment = RecordedEnvironment {
            scope: VenvScope::Shared,
            interpreter: Interpreter {
                argv_prefix: vec!["/s/bin/python".into()],
                version: Some("3.12.4".into()),
            },
            marker: VenvMarker {
                version: "3.12.4".into(),
                installer: "uv".into(),
                scope: "shared".into(),
                contributors,
                ..Default::default()
            },
        };
        assert_eq!(
            readiness(Case {
                environment: Some(environment),
                ..Default::default()
            }),
            Readiness::Ready { scope: "shared" }
        );
    }

    #[test]
    fn a_mismatched_environment_is_stale_with_every_reason() {
        assert_eq!(
            readiness(Case {
                environment: Some(isolated(&["requests>=2"], "3.11.9", "pip")),
                ..Default::default()
            }),
            Readiness::Stale {
                reasons: vec![
                    StaleReason::Dependencies,
                    StaleReason::Interpreter,
                    StaleReason::Installer
                ]
            }
        );
        // A marker that recorded no version cannot be confirmed.
        assert_eq!(
            readiness(Case {
                environment: Some(isolated(&["requests>=2", "pillow"], "", "uv")),
                ..Default::default()
            }),
            Readiness::Stale {
                reasons: vec![StaleReason::Interpreter]
            }
        );
    }

    #[test]
    fn a_running_preparation_is_preparing() {
        assert_eq!(
            readiness(Case {
                environment: Some(isolated(&["requests>=2", "pillow"], "3.12.4", "uv")),
                preparation: Some(Preparation::Running),
                ..Default::default()
            }),
            Readiness::Preparing
        );
    }

    #[test]
    fn a_failed_preparation_explains_an_environment_that_does_not_match() {
        let failed = Some(Preparation::Failed(PreparationFailure {
            message: "pip exited 1".into(),
            cause: None,
        }));
        assert_eq!(
            readiness(Case {
                preparation: failed.clone(),
                ..Default::default()
            }),
            Readiness::Failed {
                message: "pip exited 1".into(),
                cause: None,
            }
        );
        // An environment that still matches is ready despite a later failure.
        assert_eq!(
            readiness(Case {
                environment: Some(isolated(&["requests>=2", "pillow"], "3.12.4", "uv")),
                preparation: failed,
                ..Default::default()
            }),
            Readiness::Ready { scope: "isolated" }
        );
    }

    #[test]
    fn the_host_prepares_every_state_it_manages() {
        for state in [
            Readiness::NotPrepared,
            Readiness::NeedsUv,
            Readiness::Stale { reasons: vec![] },
            Readiness::Preparing,
            Readiness::Ready { scope: "isolated" },
            Readiness::Failed {
                message: String::new(),
                cause: None,
            },
        ] {
            assert!(state.host_prepared(), "{state:?}");
        }
        for state in [
            Readiness::NotRequired,
            Readiness::UserManaged {
                reason: UserManagedReason::CustomInstaller,
            },
        ] {
            assert!(!state.host_prepared(), "{state:?}");
        }
    }

    #[test]
    fn only_unready_states_block_a_load() {
        for state in [
            Readiness::NotPrepared,
            Readiness::NeedsUv,
            Readiness::Stale { reasons: vec![] },
            Readiness::Preparing,
            Readiness::Failed {
                message: String::new(),
                cause: None,
            },
        ] {
            assert!(state.blocks_load(), "{state:?}");
        }
        for state in [
            Readiness::NotRequired,
            Readiness::Ready { scope: "shared" },
            Readiness::UserManaged {
                reason: UserManagedReason::VenvDisabled,
            },
        ] {
            assert!(!state.blocks_load(), "{state:?}");
        }
    }

    #[test]
    fn preparations_allow_one_at_a_time_and_record_how_they_ended() {
        let preparations = Preparations::default();
        let guard = preparations
            .begin("demo")
            .expect("first preparation starts");
        assert!(preparations.begin("demo").is_none());
        assert_eq!(preparations.get("demo"), Some(Preparation::Running));
        guard.finish(&Err::<(), _>(PrepareError {
            error: PluginError::PythonHost("uv exited 2".into()),
            cause: Some(FailureCause::LockOutOfDate),
        }));
        assert_eq!(
            preparations.get("demo"),
            Some(Preparation::Failed(PreparationFailure {
                message: "python host: uv exited 2".into(),
                cause: Some(FailureCause::LockOutOfDate),
            }))
        );

        let guard = preparations
            .begin("demo")
            .expect("a failed one can be retried");
        guard.finish(&Ok::<(), PrepareError>(()));
        assert_eq!(preparations.get("demo"), None);

        drop(preparations.begin("demo"));
        assert!(matches!(
            preparations.get("demo"),
            Some(Preparation::Failed(_))
        ));
    }

    #[test]
    fn reports_serialize_in_the_wire_shape() {
        let report = ReadinessReport {
            readiness: Readiness::Stale {
                reasons: vec![StaleReason::Dependencies],
            },
            installer: Some("uv"),
            lock: None,
            interpreter_warning: None,
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({ "state": "stale", "reasons": ["dependencies"], "installer": "uv" })
        );
        let report = ReadinessReport {
            readiness: Readiness::UserManaged {
                reason: UserManagedReason::InterpreterOverride,
            },
            installer: None,
            lock: None,
            interpreter_warning: Some(InterpreterWarning::VersionUnknown),
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({
                "state": "user-managed",
                "reason": "interpreter-override",
                "interpreterWarning": { "kind": "version-unknown" },
            })
        );
    }

    fn locked(digest: &str, scope: VenvScope) -> RecordedEnvironment {
        let mut environment = isolated(&[], "3.12.4", "uv");
        environment.scope = scope;
        environment.marker.lock_digest = digest.into();
        environment
    }

    #[test]
    fn a_locked_plugin_needs_preparing_even_without_manifest_requirements() {
        assert_eq!(
            readiness(Case {
                dependencies: vec![],
                lock: Some(("abc", true)),
                ..Default::default()
            }),
            Readiness::NotPrepared
        );
    }

    #[test]
    fn a_locked_environment_is_ready_only_for_its_own_lock() {
        let case = |environment: RecordedEnvironment| Case {
            lock: Some(("abc", true)),
            environment: Some(environment),
            ..Default::default()
        };
        // The manifest's requirements do not count once the plugin is locked.
        assert_eq!(
            readiness(case(locked("abc", VenvScope::Isolated))),
            Readiness::Ready { scope: "isolated" }
        );
        assert_eq!(
            readiness(case(locked("old", VenvScope::Isolated))),
            Readiness::Stale {
                reasons: vec![StaleReason::Lock]
            }
        );
        // Built from manifest requirements before the plugin was locked.
        assert_eq!(
            readiness(case(isolated(&["requests>=2", "pillow"], "3.12.4", "uv"))),
            Readiness::Stale {
                reasons: vec![StaleReason::Lock]
            }
        );
        // A shared environment cannot hold one plugin's lock.
        assert_eq!(
            readiness(case(locked("abc", VenvScope::Shared))),
            Readiness::Stale {
                reasons: vec![StaleReason::Lock]
            }
        );
        let mut by_pip = locked("abc", VenvScope::Isolated);
        by_pip.marker.installer = "pip".into();
        by_pip.marker.version = "3.11.2".into();
        assert_eq!(
            readiness(case(by_pip)),
            Readiness::Stale {
                reasons: vec![StaleReason::Interpreter, StaleReason::Installer]
            }
        );
    }

    #[test]
    fn a_locked_plugin_is_prepared_by_uv_whatever_the_settings_select() {
        for installer in ["pip", "custom"] {
            assert_eq!(
                readiness(Case {
                    lock: Some(("abc", true)),
                    installer,
                    environment: Some(locked("abc", VenvScope::Isolated)),
                    ..Default::default()
                }),
                Readiness::Ready { scope: "isolated" },
                "{installer}"
            );
        }
        let uv = || "pip";
        let inputs = ReadinessInputs {
            plugin_id: "demo",
            dependencies: &[],
            lock: Some(LockInputs {
                digest: "abc",
                uv_available: &|| true,
            }),
            use_venv: true,
            interpreter_override: false,
            expected_installer: &uv,
            runtime_version: None,
            environment: None,
            preparation: None,
        };
        assert_eq!(inputs.installer(), "uv");
    }

    #[test]
    fn a_locked_plugin_without_uv_needs_uv_only_when_it_needs_preparing() {
        assert_eq!(
            readiness(Case {
                lock: Some(("abc", false)),
                ..Default::default()
            }),
            Readiness::NeedsUv
        );
        // Needing uv outranks the failure it caused.
        assert_eq!(
            readiness(Case {
                lock: Some(("abc", false)),
                preparation: Some(Preparation::Failed(PreparationFailure {
                    message: "uv not found".into(),
                    cause: None,
                })),
                ..Default::default()
            }),
            Readiness::NeedsUv
        );
        // A synced environment keeps running after uv is gone.
        assert_eq!(
            readiness(Case {
                lock: Some(("abc", false)),
                environment: Some(locked("abc", VenvScope::Isolated)),
                ..Default::default()
            }),
            Readiness::Ready { scope: "isolated" }
        );
        // The user's own environment is still theirs.
        assert_eq!(
            readiness(Case {
                lock: Some(("abc", false)),
                use_venv: false,
                ..Default::default()
            }),
            Readiness::UserManaged {
                reason: UserManagedReason::VenvDisabled
            }
        );
    }

    #[test]
    fn a_failed_locked_preparation_keeps_its_cause() {
        let cause = FailureCause::MissingWheels {
            packages: vec!["six==1.16.0".into()],
        };
        let state = readiness(Case {
            lock: Some(("abc", true)),
            preparation: Some(Preparation::Failed(PreparationFailure {
                message: "offline".into(),
                cause: Some(cause.clone()),
            })),
            ..Default::default()
        });
        assert_eq!(
            state,
            Readiness::Failed {
                message: "offline".into(),
                cause: Some(cause),
            }
        );
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            serde_json::json!({
                "state": "failed",
                "message": "offline",
                "cause": { "kind": "missing-wheels", "packages": ["six==1.16.0"] },
            })
        );
    }

    #[test]
    fn a_locked_report_carries_its_lock() {
        let report = ReadinessReport {
            readiness: Readiness::NeedsUv,
            installer: Some("uv"),
            lock: Some(LockSummary {
                packages: vec!["six==1.16.0".into()],
                offline: true,
                ignores_manifest_dependencies: false,
            }),
            interpreter_warning: None,
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({
                "state": "needs-uv",
                "installer": "uv",
                "lock": {
                    "packages": ["six==1.16.0"],
                    "offline": true,
                    "ignoresManifestDependencies": false,
                },
            })
        );
        assert_eq!(
            serde_json::to_value(Readiness::Stale {
                reasons: vec![StaleReason::Lock]
            })
            .unwrap(),
            serde_json::json!({ "state": "stale", "reasons": ["lock"] })
        );
    }
}
