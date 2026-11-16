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
    /// Fixed env an isolated launch needs.
    #[serde(default)]
    pub set_env: OrderedEnv,
    /// Home-relative writable roots the private root replaces.
    pub shared_roots: Vec<String>,
    /// Home-relative roots hidden so the engine cannot fall back to the shared login.
    pub deny_readable: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlagPick {
    First,
    Last,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelocationArgs {
    pub flags: Vec<String>,
    pub pick: FlagPick,
}

/// Where an engine lets its user move its own state (see the contract,
/// `packages/agent-contracts/src/engine-launch.ts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRelocation {
    pub env: Vec<String>,
    pub args: Option<RelocationArgs>,
    #[serde(default)]
    pub refused_args: Vec<String>,
    #[serde(default)]
    pub skip_empty: bool,
    #[serde(default)]
    pub trim: bool,
    #[serde(default)]
    pub expand_tilde: bool,
    pub default: Option<String>,
    #[serde(default)]
    pub writable: Vec<String>,
    pub temp: Option<String>,
    #[serde(default)]
    pub set_env: OrderedEnv,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IsolatedTemp {
    pub env: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TempDirectory {
    pub home: String,
    pub isolated: Option<IsolatedTemp>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompanionExecutable {
    pub sibling: String,
    pub env: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PlatformArgs {
    #[serde(default)]
    pub linux: Vec<String>,
    #[serde(default)]
    pub darwin: Vec<String>,
    #[serde(default)]
    pub win32: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEnvironment {
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub prefixes: Vec<String>,
    #[serde(default)]
    pub reviewed_prefixes: Vec<String>,
    #[serde(default)]
    pub reviewed_request_only: bool,
    #[serde(default)]
    pub private_blank: Vec<String>,
    #[serde(default)]
    pub secret: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HiddenFiles {
    #[serde(default)]
    pub searched: Vec<String>,
    #[serde(default)]
    pub home: Vec<String>,
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
    pub relocation: Option<StateRelocation>,
    pub temp: Option<TempDirectory>,
    pub companion: Option<CompanionExecutable>,
    pub private_launch_unsupported: Option<String>,
    #[serde(default)]
    pub platform_args: PlatformArgs,
    #[serde(default)]
    pub env: EngineEnvironment,
    #[serde(default)]
    pub hidden_files: HiddenFiles,
    #[serde(default)]
    pub program_roots: Vec<String>,
    #[serde(default)]
    pub login_roots: Vec<String>,
    #[serde(default)]
    pub stderr_noise: Vec<Vec<String>>,
    #[serde(default)]
    pub extra_writable_roots: bool,
    #[serde(default)]
    pub pi_packages: bool,
    pub mcp_config_file: Option<McpConfigFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectConfig {
    pub directory: String,
    pub files: Vec<String>,
}

/// An engine that reads its MCP servers only from its configuration files
/// (`EngineMcpConfigFile`); `crate::mcp_config_file` interprets it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFile {
    pub subcommand: String,
    pub root_env: String,
    pub root_default: String,
    pub directory: String,
    pub servers_file: String,
    pub settings_file: String,
    pub project: ProjectConfig,
    pub private_keep: Vec<String>,
    pub private_set: serde_json::Map<String, serde_json::Value>,
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

/// The first matching descriptor that declares `field`.
fn first_with<T>(
    command: &str,
    args: &[String],
    field: impl Fn(&'static EngineLaunchDescriptor) -> Option<&'static T>,
) -> Option<(&'static EngineLaunchDescriptor, &'static T)> {
    descriptors_for(command, args)
        .into_iter()
        .find_map(|descriptor| field(descriptor).map(|value| (descriptor, value)))
}

/// Refuse a private launch (a Bot run) of an engine that cannot run one.
pub fn check_private_launch(command: &str, args: &[String], private: bool) -> Result<(), String> {
    if !private {
        return Ok(());
    }
    match first_with(command, args, |descriptor| {
        descriptor.private_launch_unsupported.as_ref()
    }) {
        Some((descriptor, reason)) => Err(format!(
            "engine_isolation_unsupported: {} cannot run a private launch: {reason}",
            descriptor.id
        )),
        None => Ok(()),
    }
}

/// Append the arguments the engine needs on `os` (Rust's `std::env::consts::OS`
/// spelling) unless the launch already names the flag.
pub fn apply_platform_args(command: &str, args: &mut Vec<String>, os: &str) {
    let Some((_, platform)) =
        first_with(command, args, |descriptor| Some(&descriptor.platform_args))
    else {
        return;
    };
    let needed = match os {
        "linux" => &platform.linux,
        "macos" => &platform.darwin,
        "windows" => &platform.win32,
        _ => return,
    };
    for arg in needed {
        let flag = arg.split('=').next().unwrap_or(arg);
        let present = args
            .iter()
            .any(|existing| existing == flag || existing.starts_with(&format!("{flag}=")));
        if !present {
            args.push(arg.clone());
        }
    }
}

/// A helper executable an engine loads from beside its own binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Companion {
    pub engine: &'static str,
    /// Env key that receives the helper's path.
    pub env: &'static str,
    pub helper: PathBuf,
}

/// The companion of the resolved `program`. The helper must be a regular
/// executable file in the canonical program's own directory.
pub fn companion_for(program: &Path) -> Result<Option<Companion>, String> {
    let Some((descriptor, companion)) = first_with(&program.to_string_lossy(), &[], |descriptor| {
        descriptor.companion.as_ref()
    }) else {
        return Ok(None);
    };
    let id = &descriptor.id;
    let canonical = program.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve {id} executable {}: {error}",
            program.display()
        )
    })?;
    let directory = canonical
        .parent()
        .ok_or_else(|| format!("{id} executable has no directory"))?;
    let name = if program
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        format!("{}.exe", companion.sibling)
    } else {
        companion.sibling.clone()
    };
    let expected = directory.join(&name);
    let helper = expected
        .canonicalize()
        .map_err(|error| format!("{id} requires its matching sibling {name}: {error}"))?;
    if helper != expected || !helper.is_file() {
        return Err(format!(
            "{id} helper {name} must be a regular file in the engine's own directory"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if helper
            .metadata()
            .map_err(|error| error.to_string())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err(format!("{id} helper {name} is not executable"));
        }
    }
    Ok(Some(Companion {
        engine: descriptor.id.as_str(),
        env: companion.env.as_str(),
        helper,
    }))
}

/// A launch's state root moved where the engine's own settings put it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelocatedState {
    pub engine: &'static str,
    /// The resolved root.
    pub root: PathBuf,
    /// What the launch writes: the root, or its declared sub-paths.
    pub writable: Vec<PathBuf>,
    pub temp: Option<PathBuf>,
    /// Env the launch carries: every relocation key set to the root, then the
    /// relocation's fixed switches.
    pub env: Vec<(String, String)>,
}

/// What a relocation is resolved against.
pub struct RelocationInput<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a std::collections::HashMap<String, String>,
    pub cwd: Option<&'a str>,
    /// The launch's home: the gateway task's own home when it has one.
    pub home: &'a Path,
    /// The private state a Bot launch must stay inside.
    pub private_base: Option<&'a Path>,
    /// A gateway task never inherits the host's selection.
    pub host_env_applies: bool,
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                if normalized.parent().is_some() {
                    normalized.pop();
                }
            }
            std::path::Component::CurDir => {}
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

/// Resolve the launch's relocated state root, or `None` when the engine has
/// no relocation, or has one without a default and nothing selects it.
pub fn relocated_state(
    input: &RelocationInput<'_>,
    host_env: impl Fn(&str) -> Option<String>,
) -> Result<Option<RelocatedState>, String> {
    let Some((descriptor, relocation)) = first_with(input.command, input.args, |descriptor| {
        descriptor.relocation.as_ref()
    }) else {
        return Ok(None);
    };
    let id = descriptor.id.as_str();
    let invalid = || {
        format!(
            "{id} state directory must be nonempty and stay inside the launch's own state              when it runs privately"
        )
    };
    if let Some(flag) = relocation.refused_args.iter().find(|flag| {
        input
            .args
            .iter()
            .any(|arg| arg == *flag || arg.starts_with(&format!("{flag}=")))
    }) {
        return Err(format!(
            "{id} cannot scope {flag}; select its state with {} instead",
            relocation.env.join(" or ")
        ));
    }
    let mut selected: Option<String> = None;
    for key in &relocation.env {
        let value = input
            .env
            .get(key)
            .cloned()
            .or_else(|| input.host_env_applies.then(|| host_env(key)).flatten());
        match value {
            Some(value) if relocation.skip_empty && value.trim().is_empty() => continue,
            Some(value) => {
                selected = Some(value);
                break;
            }
            None => {}
        }
    }
    if let Some(args) = &relocation.args {
        let mut iter = input.args.iter();
        let mut from_flag: Option<String> = None;
        while let Some(arg) = iter.next() {
            let value = if args.flags.iter().any(|flag| flag == arg) {
                Some(iter.next().cloned().unwrap_or_default())
            } else {
                args.flags
                    .iter()
                    .find_map(|flag| arg.strip_prefix(&format!("{flag}=")).map(str::to_string))
            };
            if let Some(value) = value {
                from_flag = Some(value);
                if args.pick == FlagPick::First {
                    break;
                }
            }
        }
        if from_flag.is_some() {
            selected = from_flag;
        }
    }
    let selected = selected.map(|value| {
        if relocation.trim {
            value.trim().to_string()
        } else {
            value
        }
    });
    if selected
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(invalid());
    }
    let selected = selected.map(|value| {
        if !relocation.expand_tilde {
            value
        } else if value == "~" {
            input.home.to_string_lossy().into_owned()
        } else if let Some(rest) = value.strip_prefix("~/") {
            input.home.join(rest).to_string_lossy().into_owned()
        } else {
            value
        }
    });
    let base = input.private_base.unwrap_or(input.home);
    if !base.is_absolute() {
        return Err(invalid());
    }
    let root = match (selected, &relocation.default) {
        (Some(value), _) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                Path::new(input.cwd.ok_or_else(|| {
                    format!("{id} needs a working directory to resolve its state directory")
                })?)
                .join(path)
            }
        }
        (None, Some(default)) => base.join(default),
        (None, None) => return Ok(None),
    };
    let root = lexical_normalize(&root);
    if let Some(private) = input.private_base {
        if !root.starts_with(private) {
            return Err(invalid());
        }
        let physical_base =
            cognia_exec_sandbox::paths::safe_canonicalize(private).map_err(|_| invalid())?;
        let physical_root =
            cognia_exec_sandbox::paths::safe_canonicalize(&root).map_err(|_| invalid())?;
        if !physical_root.starts_with(&physical_base) {
            return Err(invalid());
        }
    }
    let writable = if relocation.writable.is_empty() {
        vec![root.clone()]
    } else {
        relocation
            .writable
            .iter()
            .map(|relative| root.join(relative))
            .collect()
    };
    let mut env: Vec<(String, String)> = relocation
        .env
        .iter()
        .map(|key| (key.clone(), root.to_string_lossy().into_owned()))
        .collect();
    env.extend(relocation.set_env.0.iter().cloned());
    Ok(Some(RelocatedState {
        engine: id,
        temp: relocation.temp.as_ref().map(|relative| root.join(relative)),
        writable,
        root,
        env,
    }))
}

/// The temp directory of an engine without a relocation: home-relative, or
/// under the private root an isolation mapped into `env`.
pub fn engine_temp(
    command: &str,
    args: &[String],
    env: &std::collections::HashMap<String, String>,
    home: &Path,
    isolated: bool,
) -> Option<PathBuf> {
    let (_, temp) = first_with(command, args, |descriptor| descriptor.temp.as_ref())?;
    match (&temp.isolated, isolated) {
        (Some(spec), true) => env
            .get(&spec.env)
            .map(|root| Path::new(root).join(&spec.path)),
        _ => Some(home.join(&temp.home)),
    }
}

/// The engine a sandbox launcher runs: the command after `--` when `command`
/// is the launcher itself, otherwise the launch as given.
pub fn unwrapped<'a>(command: &'a str, args: &'a [String]) -> (&'a str, &'a [String]) {
    if base_command(command) == base_command(crate::sandbox::launcher_file_name(std::env::consts::OS)) {
        if let Some(index) = args.iter().position(|arg| arg == "--") {
            if let Some(target) = args.get(index + 1) {
                return (target.as_str(), &args[index + 2..]);
            }
        }
    }
    (command, args)
}

/// Whether any engine reads this request env key, so the host admits it.
pub fn admits_request_env(key: &str) -> bool {
    descriptors().iter().any(|descriptor| {
        descriptor.env.keys.iter().any(|known| known == key)
            || descriptor.env.prefixes.iter().any(|prefix| key.starts_with(prefix.as_str()))
    })
}

/// Whether a key of one of the launch's reviewed env families must not reach
/// the engine: an unreviewed key always, and a host key in a private launch
/// or when the engine takes them from the request only.
pub fn reviewed_env_refused(
    command: &str,
    args: &[String],
    key: &str,
    from_host: bool,
    private: bool,
) -> bool {
    descriptors_for(command, args).iter().any(|descriptor| {
        descriptor
            .env
            .reviewed_prefixes
            .iter()
            .any(|prefix| key.starts_with(prefix.as_str()))
            && (!descriptor.env.keys.iter().any(|known| known == key)
                || (from_host && (private || descriptor.env.reviewed_request_only)))
    })
}

/// In a private launch, set each credential the engine would otherwise find
/// on the host to empty, unless the request sets it.
pub fn blank_private_credentials(
    command: &str,
    args: &[String],
    env: &mut std::collections::HashMap<String, String>,
    private: bool,
) {
    if !private {
        return;
    }
    for descriptor in descriptors_for(command, args) {
        for key in &descriptor.env.private_blank {
            env.entry(key.clone()).or_default();
        }
    }
}

/// Files the engine reads implicitly that the sandbox hides: each searched
/// name in the home directory and every ancestor of `cwd`, then the
/// home-relative ones.
pub fn hidden_files(command: &str, args: &[String], cwd: &Path, home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for descriptor in descriptors_for(command, args) {
        let hidden = &descriptor.hidden_files;
        if !hidden.searched.is_empty() {
            let mut roots = vec![home.to_path_buf()];
            for dir in cwd.ancestors() {
                if !roots.iter().any(|root| root == dir) {
                    roots.push(dir.to_path_buf());
                }
            }
            for root in &roots {
                for name in &hidden.searched {
                    push_unique(&mut files, root.join(name));
                }
            }
        }
        for relative in &hidden.home {
            push_unique(&mut files, home.join(relative));
        }
    }
    files
}

/// The engine's own installed program roots under `home`, read-only.
pub fn program_roots(command: &str, args: &[String], home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for descriptor in descriptors_for(command, args) {
        for relative in &descriptor.program_roots {
            push_unique(&mut roots, home.join(relative));
        }
    }
    roots
}

/// Every engine's logins and provider settings under `home`: the roots a
/// private launch hides plus each engine's other login roots. A launch that
/// is not the owner's own reads none of them.
pub fn login_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for descriptor in descriptors() {
        let isolated = descriptor.isolation.iter().flat_map(|isolation| &isolation.deny_readable);
        for relative in isolated.chain(&descriptor.login_roots) {
            push_unique(&mut roots, home.join(relative));
        }
    }
    roots
}

/// Whether a stderr line is noise some engine is known to print.
pub fn is_stderr_noise(line: &str) -> bool {
    descriptors().iter().any(|descriptor| {
        descriptor
            .stderr_noise
            .iter()
            .any(|parts| parts.iter().all(|part| line.contains(part.as_str())))
    })
}

/// Whether the launched engine honours per-launch writable roots.
pub fn accepts_extra_writable_roots(command: &str, args: &[String]) -> bool {
    descriptors_for(command, args).iter().any(|descriptor| descriptor.extra_writable_roots)
}

/// The engine a launch runs when it reads its MCP servers from its own
/// configuration files and the launch is that engine's server-taking
/// subcommand.
pub fn mcp_config_file(command: &str, args: &[String]) -> Option<(&'static str, &'static McpConfigFile)> {
    descriptors_for(command, args).into_iter().find_map(|descriptor| {
        descriptor
            .mcp_config_file
            .as_ref()
            .filter(|file| args.first() == Some(&file.subcommand))
            .map(|file| (descriptor.id.as_str(), file))
    })
}

/// Whether `key` selects an engine's state root: one of its relocation or
/// isolation env keys. The XDG Base Directory keys are the platform's, not an
/// engine's.
pub fn is_state_env(key: &str) -> bool {
    !key.starts_with("XDG_")
        && descriptors().iter().any(|descriptor| {
            descriptor
                .relocation
                .iter()
                .any(|relocation| relocation.env.iter().any(|known| known == key))
                || descriptor
                    .isolation
                    .iter()
                    .any(|isolation| isolation.env.0.iter().any(|(known, _)| known == key))
        })
}

/// Whether `key` carries an engine's credentials without a name that says so.
pub fn is_secret_env(key: &str) -> bool {
    descriptors()
        .iter()
        .any(|descriptor| descriptor.env.secret.iter().any(|known| known == key))
}

/// Whether plugin Pi packages (ADR-0210) may be mounted into the launched engine.
pub fn takes_pi_packages(command: &str, args: &[String]) -> bool {
    descriptors_for(command, args).iter().any(|descriptor| descriptor.pi_packages)
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

    fn executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn a_companion_is_bound_to_the_engine_release_and_must_be_executable() {
        let temp = tempfile::tempdir().unwrap();
        let server = executable(temp.path(), "agy_acp_server.par");
        assert!(companion_for(&server)
            .unwrap_err()
            .contains("matching sibling"));
        let helper = executable(temp.path(), "localharness_external");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(companion_for(&server)
                .unwrap_err()
                .contains("not executable"));
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            companion_for(&server).unwrap(),
            Some(Companion {
                engine: "antigravity-acp",
                env: "ANTIGRAVITY_HARNESS_PATH",
                helper: helper.canonicalize().unwrap()
            })
        );
        assert_eq!(companion_for(&temp.path().join("agy")).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_companion_follows_a_symlinked_engine_and_refuses_an_escaping_helper() {
        use std::os::unix::fs::symlink;
        let release = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        let server = executable(release.path(), "agy_acp_server.par");
        let helper = executable(release.path(), "localharness_external");
        let alias = install.path().join("agy_acp_server.par");
        symlink(&server, &alias).unwrap();
        assert_eq!(
            companion_for(&alias).unwrap().unwrap().helper,
            helper.canonicalize().unwrap()
        );
        std::fs::remove_file(&helper).unwrap();
        let outside = executable(install.path(), "outside-helper");
        symlink(&outside, &helper).unwrap();
        assert!(companion_for(&server)
            .unwrap_err()
            .contains("engine's own directory"));
    }

    #[test]
    fn a_windows_engine_selects_the_exe_companion() {
        let temp = tempfile::tempdir().unwrap();
        let server = executable(temp.path(), "agy_acp_server.exe");
        let helper = executable(temp.path(), "localharness_external.exe");
        assert_eq!(
            companion_for(&server).unwrap().unwrap().helper,
            helper.canonicalize().unwrap()
        );
    }

    #[test]
    fn platform_args_are_appended_once_and_only_on_their_platform() {
        let mut launch = vec![];
        apply_platform_args("agy_acp_server.par", &mut launch, "linux");
        assert_eq!(launch, ["--uid="]);
        apply_platform_args("agy_acp_server.par", &mut launch, "linux");
        assert_eq!(launch, ["--uid="]);
        let mut explicit = args(&["--uid", "1000"]);
        apply_platform_args("agy_acp_server.par", &mut explicit, "linux");
        assert_eq!(explicit, ["--uid", "1000"]);
        for os in ["macos", "windows"] {
            let mut launch = vec![];
            apply_platform_args("agy_acp_server.par", &mut launch, os);
            assert!(launch.is_empty());
        }
    }

    #[test]
    fn a_private_launch_is_refused_for_an_engine_that_cannot_run_one() {
        assert!(check_private_launch("agy_acp_server", &[], false).is_ok());
        assert!(check_private_launch("agy_acp_server", &[], true)
            .unwrap_err()
            .contains("keychain"));
        assert!(check_private_launch("codex", &[], true).is_ok());
    }

    fn relocate(
        command: &str,
        launch: &[&str],
        env: &[(&str, &str)],
        host: &[(&str, &str)],
        private_base: Option<&Path>,
        host_env_applies: bool,
    ) -> Result<Option<RelocatedState>, String> {
        let launch = args(launch);
        let env: std::collections::HashMap<String, String> = env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        let host: std::collections::HashMap<String, String> = host
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        relocated_state(
            &RelocationInput {
                command,
                args: &launch,
                env: &env,
                cwd: Some("/work"),
                home: Path::new("/home/dev"),
                private_base,
                host_env_applies,
            },
            |key| host.get(key).cloned(),
        )
    }

    #[test]
    fn a_relocation_defaults_under_home_and_sets_every_key_and_switch() {
        let state = relocate("grok", &[], &[], &[], None, true)
            .unwrap()
            .unwrap();
        assert_eq!(state.root, PathBuf::from("/home/dev/.grok"));
        assert_eq!(state.writable, [PathBuf::from("/home/dev/.grok")]);
        assert_eq!(state.temp, Some(PathBuf::from("/home/dev/.grok/tmp")));
        assert_eq!(
            state.env,
            [
                ("GROK_HOME".to_string(), "/home/dev/.grok".to_string()),
                ("GROK_DISABLE_AUTOUPDATER".into(), "1".into()),
                ("GROK_CHANGELOG_OFFLINE".into(), "1".into()),
            ]
        );
        let minimax = relocate(
            "mcode",
            &[],
            &[("MINIMAX_DATA_DIR", ""), ("MAVIS_DATA_DIR", "state")],
            &[],
            None,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(minimax.root, PathBuf::from("/work/state"));
        assert_eq!(minimax.env.len(), 2);
    }

    #[test]
    fn flags_beat_env_in_the_engine_s_own_order() {
        let qoder = relocate(
            "qoder",
            &["--config-dir", "a", "--config-dir=b"],
            &[("QODER_CONFIG_DIR", "/env")],
            &[],
            None,
            true,
        );
        assert_eq!(qoder.unwrap().unwrap().root, PathBuf::from("/work/b"));
        let cline = relocate(
            "cline",
            &["--config", " a ", "--config=b"],
            &[],
            &[],
            None,
            true,
        );
        assert_eq!(cline.unwrap().unwrap().root, PathBuf::from("/work/a"));
        assert!(
            relocate("cline", &["--data-dir", "x"], &[], &[], None, true)
                .unwrap_err()
                .contains("--data-dir")
        );
        assert!(relocate("qoder", &["--config-dir="], &[], &[], None, true).is_err());
    }

    #[test]
    fn the_host_selection_applies_only_outside_a_gateway_task() {
        let host = [("KIMI_CODE_HOME", "/host/kimi")];
        assert_eq!(
            relocate("kimi", &[], &[], &host, None, true)
                .unwrap()
                .unwrap()
                .root,
            PathBuf::from("/host/kimi")
        );
        assert_eq!(
            relocate("kimi", &[], &[], &host, None, false)
                .unwrap()
                .unwrap()
                .root,
            PathBuf::from("/home/dev/.kimi-code")
        );
        assert_eq!(
            relocate(
                "kimi",
                &[],
                &[("KIMI_CODE_HOME", "/request/kimi")],
                &host,
                None,
                true
            )
            .unwrap()
            .unwrap()
            .root,
            PathBuf::from("/request/kimi")
        );
    }

    #[test]
    fn a_relocation_without_a_default_applies_only_when_selected() {
        assert_eq!(
            relocate("openclaude", &[], &[], &[], None, true).unwrap(),
            None
        );
        let state = relocate(
            "hermes",
            &[],
            &[("HERMES_HOME", "/owned/hermes")],
            &[],
            None,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            state.env,
            [("HERMES_HOME".to_string(), "/owned/hermes".to_string())]
        );
        assert!(relocate("vibe-acp", &[], &[("VIBE_HOME", " ")], &[], None, true).is_err());
    }

    #[test]
    fn a_relocated_root_expands_tilde_and_grants_only_its_declared_sub_paths() {
        let state = relocate(
            "agy_acp_server",
            &[],
            &[("GEMINI_HOME", "~/g")],
            &[],
            None,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(state.root, PathBuf::from("/home/dev/g"));
        assert_eq!(
            state.writable,
            [
                PathBuf::from("/home/dev/g/antigravity-acp"),
                PathBuf::from("/home/dev/g/artifacts")
            ]
        );
        assert_eq!(
            state.temp,
            Some(PathBuf::from("/home/dev/g/antigravity-acp/tmp"))
        );
        // An empty GEMINI_HOME is unset to Antigravity.
        assert_eq!(
            relocate(
                "agy_acp_server",
                &[],
                &[("GEMINI_HOME", "")],
                &[],
                None,
                true
            )
            .unwrap()
            .unwrap()
            .root,
            PathBuf::from("/home/dev/.gemini")
        );
    }

    #[test]
    fn a_private_launch_keeps_its_relocation_inside_its_own_state() {
        let private = tempfile::tempdir().unwrap();
        let base = private.path().canonicalize().unwrap();
        let inside = relocate("kimi", &[], &[], &[], Some(&base), true)
            .unwrap()
            .unwrap();
        assert_eq!(inside.root, base.join(".kimi-code"));
        let escape = base.join("../elsewhere").to_string_lossy().into_owned();
        assert!(relocate(
            "kimi",
            &[],
            &[("KIMI_CODE_HOME", escape.as_str())],
            &[],
            Some(&base),
            true
        )
        .is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), base.join("link")).unwrap();
            let link = base.join("link").to_string_lossy().into_owned();
            assert!(relocate(
                "kimi",
                &[],
                &[("KIMI_CODE_HOME", link.as_str())],
                &[],
                Some(&base),
                true
            )
            .is_err());
        }
    }

    #[test]
    fn an_engine_temp_moves_under_its_private_root() {
        let env: std::collections::HashMap<String, String> =
            [("GOOSE_PATH_ROOT".to_string(), "/state/goose".to_string())].into();
        let home = Path::new("/home/dev");
        assert_eq!(
            engine_temp("goose", &[], &env, home, false),
            Some(home.join(".local/state/goose/tmp"))
        );
        assert_eq!(
            engine_temp("goose", &[], &env, home, true),
            Some(PathBuf::from("/state/goose/state/tmp"))
        );
        assert_eq!(engine_temp("codex", &[], &env, home, false), None);
    }

    #[test]
    fn a_sandbox_launcher_is_unwrapped_to_the_engine_it_runs() {
        let launcher = crate::sandbox::launcher_file_name(std::env::consts::OS);
        let wrapped = args(&["--policy", "p", "--", "kimi", "acp"]);
        assert_eq!(unwrapped(launcher, &wrapped), ("kimi", &wrapped[4..]));
        let plain = args(&["--", "kimi"]);
        assert_eq!(unwrapped("qoder", &plain), ("qoder", &plain[..]));
    }

    #[test]
    fn engine_env_is_admitted_and_reviewed_families_keep_to_their_keys() {
        assert!(admits_request_env("GOOSE_MODEL"));
        assert!(admits_request_env("XAI_API_KEY"));
        assert!(!admits_request_env("AWS_SECRET_ACCESS_KEY"));
        assert!(reviewed_env_refused("kimi", &[], "KIMI_OAUTH_HOST", false, false));
        assert!(!reviewed_env_refused("kimi", &[], "KIMI_MODEL_NAME", true, false));
        assert!(reviewed_env_refused("kimi", &[], "KIMI_MODEL_NAME", true, true));
        assert!(!reviewed_env_refused("kimi", &[], "KIMI_MODEL_NAME", false, true));
        assert!(reviewed_env_refused("aider", &[], "AIDER_MODEL", true, false));
        assert!(!reviewed_env_refused("aider", &[], "AIDER_MODEL", false, false));
        assert!(reviewed_env_refused("aider", &[], "AIDER_LOAD", false, false));
        assert!(!reviewed_env_refused("codex", &[], "KIMI_OAUTH_HOST", false, false));
    }

    #[test]
    fn a_private_launch_blanks_the_engine_s_host_credentials_unless_set() {
        let mut env = std::collections::HashMap::new();
        blank_private_credentials("grok", &[], &mut env, false);
        assert!(env.is_empty());
        blank_private_credentials("grok", &[], &mut env, true);
        assert_eq!(env["XAI_API_KEY"], "");
        env.insert("XAI_API_KEY".into(), "explicit".into());
        blank_private_credentials("grok", &[], &mut env, true);
        assert_eq!(env["XAI_API_KEY"], "explicit");
    }

    #[test]
    fn engine_files_resolve_under_home_and_the_working_directory() {
        let home = Path::new("/home/dev");
        let files = hidden_files("aider", &[], Path::new("/work/repo"), home);
        for file in ["/home/dev/.aider.conf.yml", "/work/repo/.env", "/work/.aider.conf.yml", "/.env", "/home/dev/.aider/oauth-keys.env"] {
            assert!(files.contains(&PathBuf::from(file)), "{file}");
        }
        assert!(hidden_files("codex", &[], Path::new("/work"), home).is_empty());
        assert_eq!(
            program_roots("qoder", &[], home),
            [home.join(".qoder/entry"), home.join(".qoder/bin")]
        );
        let logins = login_roots(home);
        assert!(logins.contains(&home.join(".aider")));
        assert!(logins.contains(&home.join(".codex")));
    }

    #[test]
    fn known_engine_stderr_noise_is_recognised_and_real_errors_are_not() {
        assert!(is_stderr_noise(
            "2026-07-17T07:54:38Z ERROR codex_models_manager::cache: failed to load models cache: \
             missing field `supports_reasoning_summaries` at line 88 column 5"
        ));
        assert!(is_stderr_noise(
            "ERROR codex_models_manager::manager: failed to renew cache TTL. EOF while parsing"
        ));
        assert!(!is_stderr_noise("ERROR codex_core::client: 401 Unauthorized: invalid API key"));
        assert!(!is_stderr_noise("ERROR codex_models_manager::foo: something else entirely"));
        assert!(!is_stderr_noise(""));
    }

    #[test]
    fn engine_feature_flags_follow_the_descriptor() {
        assert!(accepts_extra_writable_roots("codex", &[]));
        assert!(!accepts_extra_writable_roots("goose", &[]));
        assert!(takes_pi_packages("pi", &[]));
        assert!(!takes_pi_packages("codex", &[]));
    }

    #[test]
    fn state_and_secret_env_come_from_the_descriptors() {
        for key in ["CODEX_HOME", "GROK_HOME", "GEMINI_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR"] {
            assert!(is_state_env(key), "{key}");
        }
        assert!(!is_state_env("XDG_DATA_HOME"));
        assert!(!is_state_env("OPENAI_API_KEY"));
        assert!(is_secret_env("OPENCODE_CONFIG_CONTENT"));
        assert!(!is_secret_env("OPENCODE_MODEL"));
    }
}
