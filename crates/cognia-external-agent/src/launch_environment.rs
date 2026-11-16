//! What a launch inherits from the Host's own environment (ADR-0243 3C), the
//! twin of `cli/src/runtime/external/launch-environment.ts`. The table is
//! `launchEnvironment` in `protocol/external-agent-security-policy.json`
//! (compiled in by `crate::presets`); the engine keys come from the launch
//! descriptors. Every spawn's child starts from this and nothing else.

use std::ffi::OsString;

/// How much of the Host's environment a launch inherits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inheritance {
    /// The local person's own run: the session layout and toolchain roots,
    /// the person's SSH agent and model-provider credentials, the host's
    /// configuration keys and the keys an engine's descriptor admits.
    Owner,
    /// A brokered launch (a gateway task, SIWC), which gets its home and
    /// credentials from the Host: runtime essentials only.
    Essential,
    /// A runtime that builds its whole environment itself (DSH).
    None,
}

/// Windows env keys are case-insensitive (`SystemRoot`, `Path`).
fn same_key(known: &str, key: &str) -> bool {
    if cfg!(windows) {
        known.eq_ignore_ascii_case(key)
    } else {
        known == key
    }
}

/// The part of `ambient` a launch inherits under `inheritance`; the request
/// env goes on top. A `COGNIA_*` key or a loader key is never inherited:
/// Cognia's own keys reach a launch only through its request.
pub fn inherited(
    inheritance: Inheritance,
    ambient: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(String, OsString)> {
    if inheritance == Inheritance::None {
        return Vec::new();
    }
    let table = crate::presets::launch_environment_table();
    let listed = |keys: &[String], key: &str| keys.iter().any(|known| same_key(known, key));
    ambient
        .into_iter()
        .filter_map(|(key, value)| key.into_string().ok().map(|key| (key, value)))
        .filter(|(key, _)| {
            if key.starts_with("COGNIA_") || cognia_exec_sandbox::env::is_dangerous_env_key(key) {
                return false;
            }
            if listed(&table.essential_keys, key) {
                return true;
            }
            inheritance == Inheritance::Owner
                && (listed(&table.session_keys, key)
                    || listed(&table.owner_keys, key)
                    || table.owner_prefixes.iter().any(|prefix| key.starts_with(prefix.as_str()))
                    || crate::presets::host_config_env(key)
                    || crate::launch_descriptor::admits_request_env(key))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ambient() -> Vec<(OsString, OsString)> {
        [
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/owner"),
            ("CARGO_HOME", "/Users/owner/.cargo"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
            ("OPENROUTER_API_KEY", "owner-provider"),
            ("CODEX_HOME", "/Users/owner/.codex"),
            ("HTTPS_PROXY", "http://proxy"),
            ("AWS_SECRET_ACCESS_KEY", "unrelated"),
            ("NODE_OPTIONS", "--require /tmp/x.js"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"),
            ("COGNIA_AGENT_STATE_KEY", "host-only"),
            ("COGNIA_AGENT_COMMAND_ALLOWLIST", "host-only"),
            ("SYSTEMROOT", "C:\\Windows"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
    }

    fn keys(inheritance: Inheritance) -> Vec<String> {
        let mut keys: Vec<String> =
            inherited(inheritance, ambient()).into_iter().map(|(key, _)| key).collect();
        keys.sort();
        keys
    }

    #[test]
    fn the_owner_keeps_session_agent_provider_and_engine_env_but_nothing_unrelated() {
        assert_eq!(
            keys(Inheritance::Owner),
            [
                "CARGO_HOME",
                "CODEX_HOME",
                "HOME",
                "HTTPS_PROXY",
                "OPENROUTER_API_KEY",
                "PATH",
                "SSH_AUTH_SOCK",
                "SYSTEMROOT"
            ]
        );
    }

    #[test]
    fn a_brokered_launch_keeps_essentials_and_a_self_built_one_nothing() {
        assert_eq!(keys(Inheritance::Essential), ["PATH", "SYSTEMROOT"]);
        assert!(keys(Inheritance::None).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_key_that_is_not_utf8_is_never_inherited() {
        use std::os::unix::ffi::OsStringExt;
        let ambient = [(OsString::from_vec(vec![0xff, b'P']), OsString::from("x"))];
        assert!(inherited(Inheritance::Owner, ambient).is_empty());
    }

    #[test]
    fn windows_keys_match_in_any_case() {
        assert_eq!(same_key("SYSTEMROOT", "SystemRoot"), cfg!(windows));
        assert!(same_key("PATH", "PATH"));
    }
}
