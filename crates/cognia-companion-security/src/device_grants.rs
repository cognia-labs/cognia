//! The elevated-grant vocabulary.
//!
//! [`GrantKind`] is the shared vocabulary for the four elevated grants a
//! paired device can hold, and [`GrantKind::capabilities`] is the **single**
//! mapping from a grant to the canonical SecurityStore capabilities that the
//! request-path gates actually check. Every writer of a grant goes through it —
//! the desktop toggles (`companion_api::commands::companion_set_remote_terminal`
//! and its siblings) and the `cognia-server devices grant/revoke` CLI — and
//! the workspace access check reads the control grant's set from it, so a
//! capability added to a grant lands on every host type at once.
//!
//! Authorization itself is the SecurityStore's `capability_grants` table,
//! checked on the request path by
//! `companion_api::remote_execution::authorize_capability` and by the two direct
//! `has_capability` gates in `companion_api::rpc` and `companion_api::ws_terminal`.

/// Which elevated capability a grant refers to.
///
/// Deliberately three kinds rather than one flag with sub-bits. Remote control
/// means steering work this host already decided to run; agent control means
/// launching a new process; terminal means an interactive shell. Granting
/// someone the ability to write files must not silently also grant process
/// execution, and a single switch labelled "remote control" would do exactly
/// that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    /// Steer sessions, write files, push commits.
    Control,
    /// Start and drive external agents.
    AgentControl,
    /// Create, attach to, and control interactive terminal sessions.
    Terminal,
    /// Browse and transfer files over an SSH profile the desktop synchronized
    /// (ADR-0162).
    ///
    /// Separate from [`GrantKind::Terminal`] because it is a strictly smaller
    /// thing to grant. A device with a shell on that machine can already `cat`
    /// and `>` every file on it, so `ssh.files` adds nothing to a device that
    /// holds `terminal.open`. The reverse is the case worth having: files
    /// without a shell is read and write without code execution, and folding
    /// the two switches together would make that combination unexpressible.
    SshFiles,
}

impl GrantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantKind::Control => "control",
            GrantKind::AgentControl => "agent-control",
            GrantKind::Terminal => "terminal",
            GrantKind::SshFiles => "ssh-files",
        }
    }

    /// The canonical SecurityStore capabilities this grant maps onto.
    ///
    /// This is the only place the mapping exists. The desktop toggles and the
    /// `cognia-server devices` CLI both route through it, so neither can drift
    /// into granting a capability the other does not — which is how a toggle
    /// ends up writing something no gate reads.
    pub fn capabilities(self) -> &'static [&'static str] {
        match self {
            GrantKind::Control => &[
                "agent.run",
                "workspace.read",
                "workspace.write",
                "git.write",
                "workflow.run",
            ],
            GrantKind::AgentControl => &["process.spawn"],
            GrantKind::Terminal => &["terminal.open"],
            GrantKind::SshFiles => &["ssh.files"],
        }
    }

    /// Every kind, so callers can project a whole capability snapshot without
    /// restating the list (and silently forgetting one when a kind is added).
    pub fn all() -> [GrantKind; 4] {
        [
            GrantKind::Control,
            GrantKind::AgentControl,
            GrantKind::Terminal,
            GrantKind::SshFiles,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_grant_maps_onto_capabilities_the_request_path_actually_checks() {
        // Every capability a toggle can write must be one `has_capability` can
        // be asked for — i.e. one the SecurityStore will accept as an
        // assignable device capability. A typo here is exactly the failure
        // this module exists to prevent: a switch that writes a grant no gate
        // will ever match.
        for kind in GrantKind::all() {
            assert!(
                !kind.capabilities().is_empty(),
                "{} grants nothing",
                kind.as_str()
            );
            for capability in kind.capabilities() {
                assert!(
                    super::super::security_store::is_assignable_device_capability(capability),
                    "{capability} is not an assignable device capability"
                );
            }
        }
    }

    #[test]
    fn the_three_grants_do_not_overlap() {
        // Letting a device write files must not silently also let it start
        // processes or open a shell, so no capability may appear under two
        // kinds — revoking one grant would otherwise leave the other's
        // capability behind.
        // Derived from `all()` rather than listed, so a kind added without a
        // line here is still checked against every other one.
        for a in GrantKind::all() {
            for b in GrantKind::all() {
                if a == b {
                    continue;
                }
                for capability in a.capabilities() {
                    assert!(
                        !b.capabilities().contains(capability),
                        "{capability} is in both {} and {}",
                        a.as_str(),
                        b.as_str()
                    );
                }
            }
        }
    }

    #[test]
    fn terminal_access_is_exactly_the_capability_the_terminal_gates_read() {
        // `rpc::ensure_terminal_rpc_authorized` and `ws_terminal` both ask for
        // "terminal.open" and nothing else. If this drifts, the terminal
        // toggle stops controlling terminal access.
        assert_eq!(GrantKind::Terminal.capabilities(), &["terminal.open"]);
    }

    #[test]
    fn file_transfer_is_its_own_grant_and_a_shell_does_not_carry_it() {
        // ADR-0162. Granting Terminal must not also grant `ssh.files`: the
        // console renders two switches, and one that silently moved the other
        // would report a permission the owner did not give. The reverse is
        // equally deliberate, which is what makes "files without a shell" a
        // grant somebody can actually make.
        assert_eq!(GrantKind::SshFiles.capabilities(), &["ssh.files"]);
        assert!(!GrantKind::Terminal.capabilities().contains(&"ssh.files"));
        assert!(!GrantKind::SshFiles
            .capabilities()
            .contains(&"terminal.open"));
    }

    #[test]
    fn remote_control_can_steer_agent_owned_work_without_granting_process_spawn() {
        // Remote-control commands such as `browser_navigate` and
        // `claude_restore` are classified as `agent.run` in the shared command
        // manifest. The remote-control switch must therefore carry that
        // capability, while process creation remains exclusive to the
        // separately-labelled Agent Control grant.
        assert!(GrantKind::Control.capabilities().contains(&"agent.run"));
        assert!(!GrantKind::Control.capabilities().contains(&"process.spawn"));
        assert_eq!(GrantKind::AgentControl.capabilities(), &["process.spawn"]);
    }
}
