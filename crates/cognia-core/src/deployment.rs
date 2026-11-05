//! Explicit deployment-mode boundary for the remote API surface.
//!
//! Lives in the foundation so every crate that must refuse something in
//! multi-tenant mode reads the mode the same way (ADR-0253 §1): aliases,
//! case, and the fail-closed default for an invalid value.
//!
//! Single-user deployments use the host OS user as their recovery trust root.
//! Multi-tenant deployments use OIDC and must not expose local pairing routes.

/// Environment variable selecting the companion deployment trust model.
pub const DEPLOYMENT_MODE_ENV: &str = "COGNIA_DEPLOYMENT_MODE";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeploymentMode {
    SingleUser,
    MultiTenant,
}

impl DeploymentMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "single-user" | "single_user" | "singleuser" => Some(Self::SingleUser),
            "multi-tenant" | "multi_tenant" | "multitenant" | "cloud" => Some(Self::MultiTenant),
            _ => None,
        }
    }
}

/// Resolve the process deployment mode.
///
/// Missing configuration preserves the existing desktop/headless single-user
/// behavior. An invalid explicit value fails toward the stricter multi-tenant
/// surface: pairing stays unmounted and HS256 device auth is disabled.
pub fn deployment_mode() -> DeploymentMode {
    mode_from(std::env::var(DEPLOYMENT_MODE_ENV).ok().as_deref())
}

/// [`deployment_mode`] for an explicit value: `None` is unset.
pub fn mode_from(value: Option<&str>) -> DeploymentMode {
    match value {
        Some(value) => DeploymentMode::parse(value).unwrap_or_else(|| {
            log::error!("invalid {DEPLOYMENT_MODE_ENV} value; using fail-closed multi-tenant mode");
            DeploymentMode::MultiTenant
        }),
        None => DeploymentMode::SingleUser,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_documented_modes_and_cloud_alias() {
        assert_eq!(
            DeploymentMode::parse("single-user"),
            Some(DeploymentMode::SingleUser)
        );
        assert_eq!(
            DeploymentMode::parse("multi-tenant"),
            Some(DeploymentMode::MultiTenant)
        );
        assert_eq!(
            DeploymentMode::parse("cloud"),
            Some(DeploymentMode::MultiTenant)
        );
    }

    #[test]
    fn unset_is_single_user_and_anything_unknown_fails_closed() {
        assert_eq!(mode_from(None), DeploymentMode::SingleUser);
        assert_eq!(mode_from(Some("Multi-Tenant")), DeploymentMode::MultiTenant);
        assert_eq!(mode_from(Some(" cloud ")), DeploymentMode::MultiTenant);
        assert_eq!(mode_from(Some("auto")), DeploymentMode::MultiTenant);
        assert_eq!(mode_from(Some("single_user")), DeploymentMode::SingleUser);
    }

    #[test]
    fn rejects_ambiguous_values() {
        assert_eq!(DeploymentMode::parse("auto"), None);
        assert_eq!(DeploymentMode::parse(""), None);
    }
}
