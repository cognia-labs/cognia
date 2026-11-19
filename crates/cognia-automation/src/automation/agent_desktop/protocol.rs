//! Fixed JSON 2.6 boundary. Vendor grammar stays inside this integration.
use crate::automation::types::{AutomationError, Result};
use serde::Deserialize;
use serde_json::Value;

pub const PROFILE: &str = "cognia-bound-window-v1";
pub const VERSION: &str = "1.2.0";
pub const PIN: &str = include_str!("../../../../../integrations/agent-desktop.json");

pub(crate) use crate::automation::session::DeliveryDisposition as Delivery;

#[derive(Deserialize)]
pub struct Envelope {
    version: String,
    pub ok: bool,
    command: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Value,
}

impl Envelope {
    pub fn reports_physical_input(&self) -> bool {
        [
            &self.data["steps"],
            &self.error["details"]["steps"],
            &self.error["details"]["after_action"]["steps"],
        ]
        .into_iter()
        .filter_map(Value::as_array)
        .flatten()
        .any(|step| step["mechanism"] == "physical_synthetic")
    }
    pub fn parse(bytes: &[u8], command: &str) -> Result<Self> {
        let envelope: Self = serde_json::from_slice(bytes).map_err(|_| incompatible())?;
        if envelope.version != "2.6" || envelope.command != command {
            return Err(incompatible());
        }
        Ok(envelope)
    }

    pub fn read(self) -> Result<Value> {
        if self.ok {
            Ok(self.data)
        } else {
            Err(AutomationError::BackendError {
                message: format!(
                    "agent-desktop refused observation: {}",
                    self.error
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("UNKNOWN")
                ),
            })
        }
    }

    pub fn delivery(&self) -> Delivery {
        let disposition = if self.ok {
            &self.data["disposition"]
        } else {
            &self.error["disposition"]
        };
        match disposition["delivery"].as_str() {
            Some("not_delivered") => Delivery::NotDelivered,
            Some("delivered_verified") => Delivery::Verified,
            Some("delivered_unverified") => Delivery::Unverified,
            _ => Delivery::Uncertain,
        }
    }
}

pub fn verify_version(data: &Value) -> Result<()> {
    if data["version"] != VERSION
        || data["os"] != "macos"
        || data["target"] != "aarch64"
        || data["cognia"]["profile"] != PROFILE
        || data["cognia"]["windowBinding"] != "per-ax-mutation-v1"
        || data["cognia"]["supervisorLease"] != "inherited-flock-v1"
        || data["cognia"]["legacyHostCleanup"] != false
        || data["cognia"]["rendererActivation"] != false
        || data["cognia"]["rendererObservation"] != "partial-without-activation-v1"
    {
        return Err(incompatible());
    }
    Ok(())
}

pub fn incompatible() -> AutomationError {
    AutomationError::BackendError {
        message: "agent-desktop compatibility profile is unavailable or incompatible".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_delivery_is_unknown_even_on_success() {
        let envelope = Envelope::parse(
            br#"{"version":"2.6","command":"click","ok":true,"data":{}}"#,
            "click",
        )
        .unwrap();
        assert_eq!(envelope.delivery(), Delivery::Uncertain);
        assert!(
            Envelope::parse(br#"{"version":"2.5","command":"click","ok":true}"#, "click").is_err()
        );
    }
}
