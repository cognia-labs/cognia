//! Sealed org agent policy and provider prerequisites. Existing gateway task
//! traits map runtimes to wire ingress, not provider ids (gateway translation
//! deliberately permits many providers). This table maps bundled runtime ids
//! to that existing brokered launch contract; all accept an org provider through
//! gateway translation. Runtimes without a brokered launch remain unavailable.
//! Availability
//! is credential coverage only, never permission to execute (P6d/P6e).
use cognia_secrets::secret_store;
use serde::{Deserialize, Serialize};
use crate::org_credentials::{validate_org, OrgCredentials};

pub(crate) const SERVICE: &str = "com.cognia.host-org-agent-policy/v1";

/// Broker task family from lib/ai/agent/external/config/gateway-task.ts.
/// None means the shipped runtime has no reviewed brokered launch contract.
/// The providers returned to callers are alternatives, not an all-of list.
const AGENT_PROVIDERS: &[(&str, Option<&str>)] = &[
    ("claude-agent-acp", Some("claude")),
    ("codex-acp", Some("codex")),
    ("codex-app-server", Some("codex")),
    ("gemini-cli", None),
    ("copilot-cli", Some("copilot")),
    ("qwen-code", Some("qwen")),
    ("pi", Some("pi")),
    ("opencode", Some("opencode")),
    ("opencode-acp", Some("opencode")),
    ("kiro-cli", None),
    ("droid", None),
];

/// P6d: reuse the runtime catalog's launch identity and the single bundled
/// allowlist table above. Absolute/legacy npx commands cannot select a bundle.
pub fn person_runtime_matches(runtime: &str, command: &str, args: &[String]) -> bool {
    let catalog: serde_json::Value = match serde_json::from_str(include_str!("../../../protocol/external-agent-runtimes.json")) {
        Ok(catalog) => catalog, Err(_) => return false,
    };
    let Some(rows) = catalog["runtimes"].as_array() else { return false; };
    rows.iter().filter(|row| AGENT_PROVIDERS.iter().any(|(id, _)| row["runtimeId"] == *id)
        && row["systemCommand"].as_str() == Some(command))
        .filter_map(|row| {
            let prefix = row["launchArgs"].as_array()?;
            (args.len() >= prefix.len() && prefix.iter().zip(args).all(|(a, b)| a.as_str() == Some(b.as_str())))
                .then_some((prefix.len(), row))
        }).max_by_key(|(length, _)| *length)
        .is_some_and(|(_, row)| row["runtimeId"] == runtime)
}

/// Returns the already reviewed gateway launch family, not a provider slug.
pub fn person_runtime_family(runtime: &str) -> Option<&'static str> {
    AGENT_PROVIDERS.iter().find(|(id, _)| *id == runtime).and_then(|(_, family)| *family)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPolicy {
    pub allowed_agents: Vec<String>,
    pub default_agent: Option<String>,
    pub updated_at: Option<i64>,
    pub updated_by: Option<String>,
    /// Whether a member turn a Host restart interrupted is retried
    /// (ADR-0253 §7). `None` follows the operator's default
    /// ([`resume_after_restart_default`]). Absent in policies stored before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_after_restart: Option<bool>,
}

/// The operator's default for [`AgentPolicy::resume_after_restart`]:
/// `COGNIA_PERSON_RESUME_AFTER_RESTART`, off unless set to `1`, `true` or `on`.
pub fn resume_after_restart_default() -> bool {
    std::env::var("COGNIA_PERSON_RESUME_AFTER_RESTART")
        .is_ok_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on"))
}

/// How `set` changes [`AgentPolicy::resume_after_restart`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResumeChoice {
    /// Leave what the organization chose.
    Keep,
    /// Follow the operator's default again.
    Default,
    /// The organization's own choice.
    Set(bool),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAvailability {
    pub runtime_id: String,
    pub providers: Vec<String>,
    pub available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    pub allowed_agents: Vec<AgentAvailability>,
    pub bundled_agents: Vec<AgentAvailability>,
    pub default_agent: Option<String>,
    pub updated_at: Option<i64>,
    pub updated_by: Option<String>,
    /// What applies: the organization's choice, else the operator's default.
    pub resume_after_restart: bool,
    /// The organization's own choice; `None` follows the operator's default.
    pub resume_after_restart_choice: Option<bool>,
    /// The operator's default, so an administrator sees what `None` means.
    pub resume_after_restart_default: bool,
}

fn validate(allowed: &[String], default: Option<&str>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for id in allowed {
        if !AGENT_PROVIDERS.iter().any(|(runtime, _)| runtime == id) || !seen.insert(id) {
            return Err("allowedAgents must contain unique bundled runtime ids".into());
        }
    }
    if default.is_some_and(|id| !allowed.iter().any(|allowed| allowed == id)) {
        return Err("defaultAgent must belong to allowedAgents".into());
    }
    Ok(())
}

pub fn set(org: &str, allowed: Vec<String>, default: Option<String>, resume: ResumeChoice, user: &str, now: i64) -> Result<PolicyView, String> {
    validate_org(org)?;
    validate(&allowed, default.as_deref())?;
    let resume_after_restart = match resume {
        ResumeChoice::Keep => stored(org)?.resume_after_restart,
        ResumeChoice::Default => None,
        ResumeChoice::Set(value) => Some(value),
    };
    let policy = AgentPolicy { allowed_agents: allowed, default_agent: default, updated_at: Some(now), updated_by: Some(user.into()), resume_after_restart };
    let output = view(org, policy.clone())?;
    let raw = serde_json::to_string(&policy).map_err(|_| "cannot encode organization agent policy")?;
    secret_store::set(SERVICE, org, &raw).map_err(|_| "organization agent policy store unavailable")?;
    Ok(output)
}

pub fn get(org: &str) -> Result<PolicyView, String> {
    validate_org(org)?;
    view(org, stored(org)?)
}

fn stored(org: &str) -> Result<AgentPolicy, String> {
    Ok(match secret_store::get(SERVICE, org)? {
        Some(raw) => serde_json::from_str(&raw).map_err(|_| "invalid organization agent policy")?,
        None => AgentPolicy::default(),
    })
}

fn view(org: &str, policy: AgentPolicy) -> Result<PolicyView, String> {
    validate(&policy.allowed_agents, policy.default_agent.as_deref())?;
    let credentials = OrgCredentials::list(org)?;
    let present: Vec<String> = credentials.into_iter().map(|entry| entry.provider).collect();
    let availability = |runtime_id: String| {
        let requirement = AGENT_PROVIDERS.iter().find(|(id, _)| *id == runtime_id).expect("validated runtime").1;
        // Coverage only: P6c still validates the provider profile/model and
        // mints a ticket. Holding an arbitrary slug never authorizes execution.
        let providers = if requirement.is_some() { present.clone() } else { vec![] };
        let available = !providers.is_empty();
        AgentAvailability { runtime_id, providers, available }
    };
    let bundled_agents = AGENT_PROVIDERS.iter().map(|(runtime, _)| availability((*runtime).into())).collect();
    let allowed_agents = policy.allowed_agents.into_iter().map(availability).collect();
    let resume_after_restart_default = resume_after_restart_default();
    Ok(PolicyView { allowed_agents, bundled_agents, default_agent: policy.default_agent, updated_at: policy.updated_at, updated_by: policy.updated_by,
        resume_after_restart: policy.resume_after_restart.unwrap_or(resume_after_restart_default),
        resume_after_restart_choice: policy.resume_after_restart, resume_after_restart_default })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p6d_runtime_launch_mapping_is_pinned_to_catalog_and_bundle() {
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../../protocol/external-agent-runtimes.json")).unwrap();
        let bundle: serde_json::Value = serde_json::from_str(include_str!("../../../deploy/bundle/agent-versions.json")).unwrap();
        for (runtime, _) in AGENT_PROVIDERS {
            let row = catalog["runtimes"].as_array().unwrap().iter().find(|row| row["runtimeId"] == *runtime).unwrap();
            let command = row["systemCommand"].as_str().unwrap();
            let args: Vec<String> = serde_json::from_value(row["launchArgs"].clone()).unwrap();
            assert!(person_runtime_matches(runtime, command, &args), "{runtime}");
            assert!(!person_runtime_matches(runtime, &format!("/tmp/{command}"), &args));
            let shipped = bundle["runtimes"].as_array().unwrap().iter().find(|row| row["id"] == *runtime).unwrap();
            assert!(shipped.get("unavailable").is_none());
            assert!(shipped["commands"].as_array().is_some_and(|commands| commands.iter().any(|entry| entry["name"] == command))
                || shipped.pointer("/binary/command").and_then(serde_json::Value::as_str) == Some(command)
                || shipped.pointer("/archive/command").and_then(serde_json::Value::as_str) == Some(command), "{runtime}: {command}");
        }
        assert!(!person_runtime_matches("opencode", "opencode", &["acp".into()]));
        p6a_provider_table_covers_exactly_the_shipped_bundle();
    }
    #[test]
    fn p6b_bundled_agents_include_disallowed_runtimes_in_table_order() {
        let org = "org_p6b_bundled_agents";
        let empty = serde_json::to_value(get(org).unwrap()).unwrap();
        assert_eq!(empty["bundledAgents"].as_array().unwrap().len(), AGENT_PROVIDERS.len());
        assert!(empty["allowedAgents"].as_array().unwrap().is_empty());
        OrgCredentials::set(org, "openai", "p6b-bundle-secret", "operator", 1).unwrap();
        let policy = set(org, vec!["pi".into()], Some("pi".into()), ResumeChoice::Keep, "operator", 2).unwrap();
        let output = serde_json::to_value(policy).unwrap();
        for (agent, (id, family)) in output["bundledAgents"].as_array().unwrap().iter().zip(AGENT_PROVIDERS) {
            assert_eq!(agent["runtimeId"], *id);
            assert_eq!(agent["available"], family.is_some());
            assert_eq!(agent["providers"], if family.is_some() { serde_json::json!(["openai"]) } else { serde_json::json!([]) });
            if *id == "pi" { assert_eq!(*agent, output["allowedAgents"][0]); }
        }
        OrgCredentials::delete(org, "openai").unwrap();
        assert!(serde_json::to_value(get(org).unwrap()).unwrap()["bundledAgents"].as_array().unwrap().iter().all(|agent| agent["available"] == false));
    }

    #[test]
    fn p6a_provider_table_covers_exactly_the_shipped_bundle() {
        let bundle: serde_json::Value = serde_json::from_str(include_str!("../../../deploy/bundle/agent-versions.json")).unwrap();
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../../protocol/external-agent-runtimes.json")).unwrap();
        let shipped: std::collections::BTreeSet<_> = bundle["runtimes"].as_array().unwrap().iter()
            .filter(|row| row.get("unavailable").is_none()).map(|row| row["id"].as_str().unwrap()).collect();
        assert_eq!(shipped, AGENT_PROVIDERS.iter().map(|(id, _)| *id).collect());
        for (id, _) in AGENT_PROVIDERS {
            assert!(catalog["runtimes"].as_array().unwrap().iter().any(|row| row["runtimeId"] == *id));
        }
        let gateway = include_str!("../../cognia-sandboxd/src/gateway_task.rs");
        for (_, family) in AGENT_PROVIDERS {
            if let Some(family) = family { assert!(gateway.contains(&format!("\"{family}\""))); }
        }
    }

    #[test]
    fn p6a_policy_validation_coverage_and_org_isolation() {
        let org = "org_p6a_policy";
        assert!(set(org, vec!["not-bundled".into()], None, ResumeChoice::Keep, "operator", 1).is_err());
        assert!(set(org, vec!["pi".into()], Some("codex-acp".into()), ResumeChoice::Keep, "operator", 1).is_err());
        assert!(set(org, vec!["pi".into(), "pi".into()], None, ResumeChoice::Keep, "operator", 1).is_err());
        let policy = set(org, vec!["codex-acp".into(), "pi".into(), "claude-agent-acp".into(), "gemini-cli".into(), "kiro-cli".into(), "droid".into()], Some("pi".into()), ResumeChoice::Keep, "operator", 2).unwrap();
        assert!(policy.allowed_agents.iter().all(|agent| !agent.available));
        OrgCredentials::set(org, "openai", "p6a-policy-secret", "operator", 3).unwrap();
        let covered = get(org).unwrap();
        for agent in covered.allowed_agents {
            assert_eq!(agent.available, matches!(agent.runtime_id.as_str(), "codex-acp" | "pi" | "claude-agent-acp"));
            if agent.available { assert_eq!(agent.providers, ["openai"]); }
        }
        assert!(get("org_p6a_other_policy").unwrap().allowed_agents.is_empty());
        OrgCredentials::delete(org, "openai").unwrap();
        assert!(get(org).unwrap().allowed_agents.iter().all(|agent| !agent.available));
    }

    #[test]
    fn adr0253_resume_after_restart_follows_the_operator_until_the_org_chooses() {
        // The only test that touches this variable.
        let previous = std::env::var_os("COGNIA_PERSON_RESUME_AFTER_RESTART");
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore { fn drop(&mut self) { match self.0.take() {
            Some(value) => std::env::set_var("COGNIA_PERSON_RESUME_AFTER_RESTART", value),
            None => std::env::remove_var("COGNIA_PERSON_RESUME_AFTER_RESTART"),
        } } }
        let _restore = Restore(previous);
        std::env::remove_var("COGNIA_PERSON_RESUME_AFTER_RESTART");
        assert!(!resume_after_restart_default());
        for (value, on) in [("1", true), ("true", true), (" ON ", true), ("0", false), ("yes", false), ("", false)] {
            std::env::set_var("COGNIA_PERSON_RESUME_AFTER_RESTART", value);
            assert_eq!(resume_after_restart_default(), on, "{value:?}");
        }
        let org = "org_adr0253_resume";
        std::env::set_var("COGNIA_PERSON_RESUME_AFTER_RESTART", "1");
        let view = get(org).unwrap();
        assert!(view.resume_after_restart && view.resume_after_restart_default);
        assert_eq!(view.resume_after_restart_choice, None);
        let chosen = set(org, vec!["pi".into()], None, ResumeChoice::Set(false), "admin", 1).unwrap();
        assert!(!chosen.resume_after_restart);
        assert_eq!(chosen.resume_after_restart_choice, Some(false));
        // Changing the agents keeps the organization's choice.
        let kept = set(org, vec![], None, ResumeChoice::Keep, "admin", 2).unwrap();
        assert_eq!(kept.resume_after_restart_choice, Some(false));
        assert!(!get(org).unwrap().resume_after_restart);
        let wire = serde_json::to_value(get(org).unwrap()).unwrap();
        assert_eq!((wire["resumeAfterRestart"].clone(), wire["resumeAfterRestartChoice"].clone(), wire["resumeAfterRestartDefault"].clone()),
            (serde_json::json!(false), serde_json::json!(false), serde_json::json!(true)));
        let followed = set(org, vec![], None, ResumeChoice::Default, "admin", 3).unwrap();
        assert!(followed.resume_after_restart);
        assert_eq!(followed.resume_after_restart_choice, None);
        std::env::remove_var("COGNIA_PERSON_RESUME_AFTER_RESTART");
        assert!(!get(org).unwrap().resume_after_restart);
    }

    #[test]
    fn adr0253_a_policy_stored_before_resume_existed_still_reads() {
        let old: AgentPolicy = serde_json::from_str(r#"{"allowedAgents":["pi"],"defaultAgent":null,"updatedAt":1,"updatedBy":"admin"}"#).unwrap();
        assert_eq!(old.resume_after_restart, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("resumeAfterRestart"));
        let chosen = AgentPolicy { resume_after_restart: Some(true), ..old };
        let round: AgentPolicy = serde_json::from_str(&serde_json::to_string(&chosen).unwrap()).unwrap();
        assert_eq!(round.resume_after_restart, Some(true));
    }
}
