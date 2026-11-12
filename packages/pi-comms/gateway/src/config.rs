//! Explicit operator policy; no discovered files or permissive defaults.
use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::wire::{self, Role};

/// Validated standalone daemon configuration, loaded only from an explicit path.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    // Set only by read, from the successfully parsed buffer; never refreshed at admission.
    #[serde(skip)]
    pub(crate) loaded_config_sha256: Option<String>,
    pub(crate) machine_id: String,
    pub(crate) socket_path: PathBuf,
    pub(crate) scope_ids: Vec<String>,
    pub(crate) policies: Vec<Policy>,
    pub(crate) remote: Option<crate::remote::Settings>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Policy {
    machine_id: String,
    scope_id: String,
    permissions: Vec<Permission>,
    #[serde(default)]
    direction: Direction,
}

/// Operator grant direction, independently enforced from adapter counterpart policy.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Direction {
    /// Local callers acting on the named machine; preserves the local configuration API.
    #[default]
    Outgoing,
    /// Authenticated named remote callers acting on this gateway's local runtimes.
    Incoming,
}

/// Directional capability granted for a configured machine/scope pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Permission {
    /// Reveal eligible roster entries.
    Discover,
    /// Read adapter-owned state.
    Read,
    /// Admit collaboration pushes at the destination adapter.
    Push,
    /// Mutate volatile publisher interest.
    Interest,
}

/// Configuration failure is a startup error, never an implicit policy fallback.
#[derive(Debug)]
pub struct ReadConfigError;
impl fmt::Display for ReadConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid gateway configuration")
    }
}
impl std::error::Error for ReadConfigError {}

fn machine(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn scope(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
impl Config {
    /// Reads one explicitly named configuration without inspecting any credential directory.
    /// Retains SHA256 of the exact successfully parsed bytes for guarded managed admission.
    ///
    /// # Errors
    /// Rejects nonabsolute paths, excessive bytes, ambiguous JSON, unknown fields,
    /// invalid identifiers, duplicate scopes/policy tuples/permissions and empty policy grants.
    pub fn read(path: &Path) -> Result<Self, ReadConfigError> {
        use std::io::Read;
        if !path.is_absolute() {
            return Err(ReadConfigError);
        }
        let file = std::fs::File::open(path).map_err(|_| ReadConfigError)?;
        let mut bytes = Vec::new();
        file.take(32_765)
            .read_to_end(&mut bytes)
            .map_err(|_| ReadConfigError)?;
        let mut config = Self::parse(&bytes)?;
        let digest = ring::digest::digest(&ring::digest::SHA256, &bytes);
        config.loaded_config_sha256 = Some(digest.as_ref().iter().fold(
            String::with_capacity(64),
            |mut output, byte| {
                use std::fmt::Write;
                write!(output, "{byte:02x}").expect("writing to String cannot fail");
                output
            },
        ));
        Ok(config)
    }

    /// Validates bounded configuration bytes without performing I/O.
    /// Does not establish a loaded-file fingerprint for guarded managed admission.
    ///
    /// # Errors
    /// Rejects the same schema and semantic failures as [`Self::read`].
    pub fn parse(bytes: &[u8]) -> Result<Self, ReadConfigError> {
        let value = wire::decode_json(bytes, Role::LocalClient).map_err(|_| ReadConfigError)?;
        let config: Self = serde_json::from_value(value).map_err(|_| ReadConfigError)?;
        let unique: HashSet<_> = config.scope_ids.iter().collect();
        if !machine(&config.machine_id)
            || !config.socket_path.is_absolute()
            || config.scope_ids.is_empty()
            || config.scope_ids.len() > 64
            || unique.len() != config.scope_ids.len()
            || !config.scope_ids.iter().all(|s| scope(s))
            || config.policies.len() > 64
        {
            return Err(ReadConfigError);
        }
        let mut tuples = HashSet::new();
        for policy in &config.policies {
            if !machine(&policy.machine_id)
                || !config.scope_ids.contains(&policy.scope_id)
                || !tuples.insert((&policy.machine_id, &policy.scope_id, policy.direction))
                || policy.permissions.is_empty()
                || policy.permissions.len() > 4
                || policy.permissions.iter().collect::<HashSet<_>>().len()
                    != policy.permissions.len()
            {
                return Err(ReadConfigError);
            }
        }
        if let Some(remote) = &config.remote {
            remote.validate().map_err(|_| ReadConfigError)?;
            if remote.machine_id() == config.machine_id || config.remote_scopes().is_empty() {
                return Err(ReadConfigError);
            }
        }
        Ok(config)
    }

    pub(crate) fn permits(&self, machine: &str, scope: &str, permission: Permission) -> bool {
        self.permits_direction(machine, scope, permission, Direction::Outgoing)
    }

    pub(crate) fn permits_direction(
        &self,
        machine: &str,
        scope: &str,
        permission: Permission,
        direction: Direction,
    ) -> bool {
        self.policies.iter().any(|policy| {
            policy.direction == direction
                && policy.machine_id == machine
                && policy.scope_id == scope
                && policy.permissions.contains(&permission)
        })
    }
    // Internal authenticated roster exchange enables routing/source binding, not discovery.
    pub(crate) fn remote_scopes(&self) -> Vec<String> {
        let Some(remote) = &self.remote else {
            return Vec::new();
        };
        self.scope_ids
            .iter()
            .filter(|scope| {
                self.policies.iter().any(|policy| {
                    policy.machine_id == remote.machine_id() && policy.scope_id == **scope
                })
            })
            .cloned()
            .collect()
    }
}

impl Config {
    /// Reports a read-only credential snapshot, never proof of a running gateway or link.
    ///
    /// # Errors
    /// Propagates unexpected noncredential failures rather than hiding them as degradation.
    pub fn diagnose(&self) -> std::io::Result<serde_json::Value> {
        let remote = match &self.remote {
            None => serde_json::json!({"state":"disabled"}),
            Some(settings) => match settings.clone().diagnose(&self.machine_id) {
                Ok(prepared) => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(std::io::Error::other)?
                        .as_secs();
                    serde_json::json!({"state":"configured","credentialExpiresAt":prepared.expires_at(),"expiryWarning":prepared.expires_at().saturating_sub(now) <= 7*86400})
                }
                Err(error) => match crate::remote::degradation(&error) {
                    Some(reason) => serde_json::json!({"state":"degraded", "reason":reason}),
                    None => return Err(error),
                },
            },
        };
        Ok(serde_json::json!({"version":1,"machineId":self.machine_id,"remote":remote}))
    }
}
