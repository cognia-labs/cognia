//! How an external engine process is launched (ADR-0243 3C): the Host derives
//! the profile from the run's acting identity and carries it to the process
//! host as one env value, [`ENGINE_PROFILE_ENV`]. Same contract as
//! `packages/agent-contracts/src/engine-launch-profile.ts`; the CLI host reads
//! it in `cli/src/runtime/external/state-isolation.ts` and `node-backend.ts`.
//!
//! - [`LaunchProfile::Owner`] (also when absent): the local person's own run.
//! - [`LaunchProfile::Isolated`]: a run for someone else, an event, the service
//!   lane or a Bot. It inherits no ambient credential or helper socket
//!   ([`crate::launch_environment::Inheritance::Isolated`]), runs inside this
//!   host's sandbox with an unreadable home and a private state root derived
//!   from its key ([`isolated_state_root`]), and is refused for an engine that
//!   cannot run privately.
//! - [`LaunchProfile::Personal`]: the owner's run once it carries personal
//!   content. Everything [`LaunchProfile::Isolated`] gets, and it must be a
//!   Cognia gateway task whose only network is the Host's own loopback
//!   services (its gateway and its tool host), through this host's
//!   filtering proxy.
//!
//! The value never reaches the engine: the process table drops it before the
//! child starts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Host-minted; never forwarded to the engine.
pub const ENGINE_PROFILE_ENV: &str = "COGNIA_ENGINE_PROFILE";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IsolationReason {
    Bot,
    Requester,
    Event,
    Service,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchProfile {
    Owner,
    Isolated {
        key: String,
        reason: IsolationReason,
    },
    Personal {
        key: String,
        loopback_ports: Vec<u16>,
    },
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Wire {
    Owner,
    Isolated {
        key: String,
        reason: IsolationReason,
    },
    #[serde(rename_all = "camelCase")]
    Personal {
        key: String,
        loopback_ports: Vec<u16>,
    },
}

/// A key is a directory name: `^[A-Za-z0-9_-]{1,128}$`
/// (`ENGINE_PROFILE_KEY_PATTERN` on the TypeScript side).
fn key_valid(key: &str) -> bool {
    crate::state_isolation::state_key_valid(key)
}

impl LaunchProfile {
    /// The profile a launch env carries. Absent is [`LaunchProfile::Owner`];
    /// a malformed value refuses the launch.
    pub fn of(env: &HashMap<String, String>) -> Result<Self, String> {
        let Some(raw) = env.get(ENGINE_PROFILE_ENV) else {
            return Ok(Self::Owner);
        };
        let invalid = || format!("invalid {ENGINE_PROFILE_ENV}");
        match serde_json::from_str::<Wire>(raw).map_err(|_| invalid())? {
            Wire::Owner => Ok(Self::Owner),
            Wire::Isolated { key, reason } if key_valid(&key) => Ok(Self::Isolated { key, reason }),
            Wire::Personal {
                key,
                loopback_ports,
            } if key_valid(&key) && !loopback_ports.is_empty() && !loopback_ports.contains(&0) => {
                Ok(Self::Personal {
                    key,
                    loopback_ports,
                })
            }
            Wire::Isolated { .. } | Wire::Personal { .. } => Err(invalid()),
        }
    }

    /// A private launch: [`Self::Isolated`] or [`Self::Personal`].
    pub fn is_isolated(&self) -> bool {
        !matches!(self, Self::Owner)
    }

    /// The key naming a private launch's state root.
    pub fn private_key(&self) -> Option<&str> {
        match self {
            Self::Owner => None,
            Self::Isolated { key, .. } | Self::Personal { key, .. } => Some(key),
        }
    }

    /// The Host loopback ports a personal launch may reach; `None` for any
    /// other launch.
    pub fn loopback_ports(&self) -> Option<&[u16]> {
        match self {
            Self::Personal { loopback_ports, .. } => Some(loopback_ports),
            _ => None,
        }
    }
}

/// `<data_dir>/cognia/isolated-agents/<key>`. The key must already be valid.
pub fn isolated_state_root(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join("cognia").join("isolated-agents").join(key)
}

/// Whether a launch env asks for a private launch. For a launch the spawn
/// policy already admitted, whose profile is known to parse; a malformed
/// value counts as isolated.
pub fn isolated(env: &HashMap<String, String>) -> bool {
    !matches!(LaunchProfile::of(env), Ok(LaunchProfile::Owner))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(raw: &str) -> HashMap<String, String> {
        HashMap::from([(ENGINE_PROFILE_ENV.to_string(), raw.to_string())])
    }

    #[test]
    fn an_absent_profile_is_the_owners_and_an_isolated_one_names_its_root() {
        assert_eq!(LaunchProfile::of(&HashMap::new()), Ok(LaunchProfile::Owner));
        let profile =
            LaunchProfile::of(&env(r#"{"kind":"isolated","key":"bot-1","reason":"bot"}"#)).unwrap();
        assert_eq!(
            profile,
            LaunchProfile::Isolated {
                key: "bot-1".into(),
                reason: IsolationReason::Bot
            }
        );
        assert_eq!(
            isolated_state_root(Path::new("/data"), "bot-1"),
            PathBuf::from("/data/cognia/isolated-agents/bot-1")
        );
        assert!(isolated(&env(
            r#"{"kind":"isolated","key":"k","reason":"requester"}"#
        )));
        assert!(!isolated(&HashMap::new()));
        let personal = LaunchProfile::of(&env(
            r#"{"kind":"personal","key":"task-1","loopbackPorts":[9900,4100]}"#,
        ))
        .unwrap();
        assert_eq!(
            personal,
            LaunchProfile::Personal {
                key: "task-1".into(),
                loopback_ports: vec![9900, 4100]
            }
        );
        assert!(personal.is_isolated());
        assert_eq!(personal.private_key(), Some("task-1"));
        assert_eq!(personal.loopback_ports(), Some(&[9900, 4100][..]));
        assert_eq!(LaunchProfile::Owner.private_key(), None);
    }

    #[test]
    fn a_malformed_profile_refuses_and_counts_as_isolated() {
        for raw in [
            "not json",
            r#"{"kind":"isolated","key":"../x","reason":"bot"}"#,
            r#"{"kind":"isolated","key":"k","reason":"someone"}"#,
            r#"{"kind":"isolated","reason":"bot"}"#,
            r#"{"kind":"personal","key":"k"}"#,
            r#"{"kind":"personal","key":"k","loopbackPorts":[]}"#,
            r#"{"kind":"personal","key":"k","loopbackPorts":[0]}"#,
            r#"{"kind":"personal","key":"k","loopbackPorts":[70000]}"#,
            r#"{"kind":"personal","key":"../k","loopbackPorts":[9900]}"#,
            r#"{"kind":"visitor","key":"k"}"#,
        ] {
            assert!(LaunchProfile::of(&env(raw)).is_err(), "{raw}");
            assert!(isolated(&env(raw)), "{raw}");
        }
    }
}
