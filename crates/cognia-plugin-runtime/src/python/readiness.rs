//! Whether a Python plugin's environment can load it (ENV01, ADR-0258).
//!
//! Readiness is computed from what the Host recorded when it built the
//! environment (the venv marker: requirements, interpreter version, installer)
//! and from the preparation it is running or last failed, never by guessing
//! import names from requirement strings. Preparing an environment downloads
//! and installs packages, so it is its own operation with its own consent; a
//! plugin whose environment is not ready is refused at enable with this state,
//! and the user prepares it from there.

use std::collections::{BTreeSet, HashMap};

use parking_lot::RwLock;
use serde::Serialize;

use super::interpreter_check::InterpreterWarning;
use super::venv::RecordedEnvironment;

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

/// The readiness states of ADR-0258 §2 that apply without a lock file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Readiness {
    NotRequired,
    NotPrepared,
    Stale { reasons: Vec<StaleReason> },
    Preparing,
    Ready { scope: &'static str },
    Failed { message: String },
    UserManaged { reason: UserManagedReason },
}

impl Readiness {
    /// Whether loading the plugin should wait for a preparation.
    pub fn blocks_load(&self) -> bool {
        matches!(
            self,
            Self::NotPrepared | Self::Stale { .. } | Self::Preparing | Self::Failed { .. }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpreter_warning: Option<InterpreterWarning>,
}

/// A preparation the Host is running, or the last one that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preparation {
    Running,
    Failed(String),
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

    fn finish(&self, plugin_id: &str, failure: Option<String>) {
        let mut by_plugin = self.by_plugin.write();
        match failure {
            Some(message) => {
                by_plugin.insert(plugin_id.to_string(), Preparation::Failed(message));
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
    pub fn finish<T, E: std::fmt::Display>(mut self, result: &std::result::Result<T, E>) {
        self.finished = true;
        self.preparations.finish(
            &self.plugin_id,
            result.as_ref().err().map(|error| error.to_string()),
        );
    }
}

impl Drop for PreparationGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.preparations.finish(
                &self.plugin_id,
                Some("the preparation stopped before it finished".to_string()),
            );
        }
    }
}

/// What readiness is computed from.
pub struct ReadinessInputs<'a> {
    pub plugin_id: &'a str,
    /// The requirements the plugin declares (`pythonDependencies`).
    pub dependencies: &'a [String],
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

/// Readiness from its inputs. Checked in order: whether there is anything to
/// prepare, whether the Host manages it, a running preparation, then the
/// recorded environment against the plugin; a failed preparation explains an
/// environment that does not match.
pub fn compute_readiness(inputs: &ReadinessInputs<'_>) -> Readiness {
    let declared = requirement_set(inputs.dependencies);
    if declared.is_empty() {
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
    if (inputs.expected_installer)() == "custom" {
        return Readiness::UserManaged {
            reason: UserManagedReason::CustomInstaller,
        };
    }
    if inputs.preparation == Some(&Preparation::Running) {
        return Readiness::Preparing;
    }

    let stale = inputs.environment.map(|environment| {
        let mut reasons = Vec::new();
        let installed = environment.plugin_requirements(inputs.plugin_id);
        if requirement_set(&installed) != declared {
            reasons.push(StaleReason::Dependencies);
        }
        let built_on = environment.marker.version.as_str();
        if built_on.is_empty() || inputs.runtime_version != Some(built_on) {
            reasons.push(StaleReason::Interpreter);
        }
        if environment.marker.installer != (inputs.expected_installer)() {
            reasons.push(StaleReason::Installer);
        }
        (environment.scope, reasons)
    });
    match (stale, inputs.preparation) {
        (Some((scope, reasons)), _) if reasons.is_empty() => Readiness::Ready {
            scope: scope.as_str(),
        },
        (_, Some(Preparation::Failed(message))) => Readiness::Failed {
            message: message.clone(),
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
        compute_readiness(&ReadinessInputs {
            plugin_id: "demo",
            dependencies: &case.dependencies,
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
        let failed = Some(Preparation::Failed("pip exited 1".into()));
        assert_eq!(
            readiness(Case {
                preparation: failed.clone(),
                ..Default::default()
            }),
            Readiness::Failed {
                message: "pip exited 1".into()
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
            Readiness::Stale { reasons: vec![] },
            Readiness::Preparing,
            Readiness::Ready { scope: "isolated" },
            Readiness::Failed {
                message: String::new(),
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
            Readiness::Stale { reasons: vec![] },
            Readiness::Preparing,
            Readiness::Failed {
                message: String::new(),
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
        guard.finish(&Err::<(), _>("uv exited 2"));
        assert_eq!(
            preparations.get("demo"),
            Some(Preparation::Failed("uv exited 2".into()))
        );

        let guard = preparations
            .begin("demo")
            .expect("a failed one can be retried");
        guard.finish(&Ok::<(), String>(()));
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
}
