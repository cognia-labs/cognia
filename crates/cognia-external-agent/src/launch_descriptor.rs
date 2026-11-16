//! Engine launch descriptors (ADR-0217): what each external engine needs from
//! this process host, declared by the engine's own package and read from
//! `protocol/external-agent-launch.json`, which
//! `scripts/build/gen-external-agent-launch.mjs` generates and validates.
//!
//! The table is compiled in (`include_str!`), so a launch never depends on a
//! file it reads at run time, and a spawn request never names a descriptor:
//! the host looks one up by the launch target. The host's own invariants
//! (admission allowlist, writable scope, loader-env denial) bound every
//! descriptor regardless of what it says.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    /// The launch target equals one of the values.
    Target,
    /// The base command equals one of the values.
    Base,
    /// The launch target contains one of the values.
    Contains,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LaunchMatch {
    pub kind: MatchKind,
    pub values: Vec<String>,
}

/// Env key → path, in declaration order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrderedEnv(pub Vec<(String, String)>);

impl<'de> Deserialize<'de> for OrderedEnv {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EnvVisitor;
        impl<'de> Visitor<'de> for EnvVisitor {
            type Value = OrderedEnv;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object of env key to relative path")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OrderedEnv, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, String>()? {
                    entries.push(entry);
                }
                Ok(OrderedEnv(entries))
            }
        }
        deserializer.deserialize_map(EnvVisitor)
    }
}

/// How an engine's state moves into a configuration's private root (ADR-0216).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateIsolation {
    /// Env key → path relative to the private root.
    pub env: OrderedEnv,
    /// Home-relative writable roots the private root replaces.
    pub shared_roots: Vec<String>,
    /// Home-relative roots hidden so the engine cannot fall back to the shared login.
    pub deny_readable: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLaunchDescriptor {
    pub id: String,
    #[serde(rename = "match")]
    pub launch_match: LaunchMatch,
    #[serde(default)]
    pub state_roots: Vec<String>,
    #[serde(default)]
    pub file_roots: Vec<String>,
    pub isolation: Option<StateIsolation>,
}

#[derive(Deserialize)]
struct LaunchTable {
    engines: Vec<EngineLaunchDescriptor>,
}

static DESCRIPTORS: LazyLock<Vec<EngineLaunchDescriptor>> = LazyLock::new(|| {
    serde_json::from_str::<LaunchTable>(include_str!(
        "../../../protocol/external-agent-launch.json"
    ))
    .expect("protocol/external-agent-launch.json is generated and parses")
    .engines
});

/// Every descriptor, in table order.
pub fn descriptors() -> &'static [EngineLaunchDescriptor] {
    &DESCRIPTORS
}

/// The executable file name without a Windows suffix, lower-cased.
pub fn base_command(command: &str) -> String {
    let name = command
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    name
}

/// The base command and, for `npx`, the package it runs.
pub fn launch_target(command: &str, args: &[String]) -> (String, String) {
    let base = base_command(command);
    let target = if base == "npx" {
        args.iter()
            .find(|arg| !arg.starts_with('-'))
            .cloned()
            .unwrap_or_else(|| base.clone())
    } else {
        base.clone()
    };
    (base, target)
}

fn matches(launch_match: &LaunchMatch, base: &str, target: &str) -> bool {
    match launch_match.kind {
        MatchKind::Contains => launch_match
            .values
            .iter()
            .any(|value| target.contains(value.as_str())),
        MatchKind::Target => launch_match.values.iter().any(|value| value == target),
        MatchKind::Base => launch_match.values.iter().any(|value| value == base),
    }
}

/// Every descriptor matching a launch, in table order.
pub fn descriptors_for(command: &str, args: &[String]) -> Vec<&'static EngineLaunchDescriptor> {
    let (base, target) = launch_target(command, args);
    descriptors()
        .iter()
        .filter(|descriptor| matches(&descriptor.launch_match, &base, &target))
        .collect()
}

fn push_unique(into: &mut Vec<PathBuf>, path: PathBuf) {
    if !into.contains(&path) {
        into.push(path);
    }
}

/// The state roots a launch must be able to write, under `home`.
pub fn state_writable_roots(command: &str, args: &[String], home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for descriptor in descriptors_for(command, args) {
        for root in &descriptor.state_roots {
            push_unique(&mut roots, home.join(root));
        }
    }
    roots
}

/// The subset of [`state_writable_roots`] that are files, under `home`.
pub fn state_file_roots(command: &str, args: &[String], home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for descriptor in descriptors_for(command, args) {
        for root in &descriptor.file_roots {
            push_unique(&mut roots, home.join(root));
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_generated_table_parses_with_isolation_in_declaration_order() {
        assert!(descriptors().len() > 30);
        let opencode = descriptors_for("opencode", &[]);
        let env: Vec<&str> = opencode[0]
            .isolation
            .as_ref()
            .unwrap()
            .env
            .0
            .iter()
            .map(|(key, _)| key.as_str())
            .collect();
        assert_eq!(
            env,
            [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
                "XDG_STATE_HOME",
                "XDG_CACHE_HOME"
            ]
        );
    }

    #[test]
    fn a_launch_matches_by_executable_file_name() {
        assert_eq!(base_command("/opt/bin/Goose.EXE"), "goose");
        assert_eq!(base_command("C:\\Tools\\codex.cmd"), "codex");
        let home = Path::new("/home/dev");
        assert!(state_writable_roots("/usr/local/bin/claude", &[], home)
            .contains(&home.join(".claude")));
        assert!(state_writable_roots("/home/dev/codex-tools/bin/agent", &[], home).is_empty());
    }

    #[test]
    fn npx_runs_the_package_and_keeps_its_own_cache() {
        let home = Path::new("/home/dev");
        assert_eq!(
            state_writable_roots("npx", &args(&["-y", "@zed-industries/codex-acp"]), home),
            vec![home.join(".codex"), home.join(".npm")]
        );
        assert_eq!(
            state_writable_roots("npx", &args(&["-y", "pi-acp"]), home),
            vec![home.join(".npm")]
        );
    }

    #[test]
    fn file_roots_are_listed_per_engine() {
        let home = Path::new("/home/dev");
        assert_eq!(
            state_file_roots("claude-agent-acp", &[], home),
            vec![home.join(".claude.json"), home.join(".claude.json.backup")]
        );
        assert_eq!(
            state_file_roots("openclaude", &[], home),
            vec![home.join(".openclaude.json")]
        );
        assert!(state_file_roots("opencode", &[], home).is_empty());
    }
}
