//! Explicit operator policy; no discovered files or permissive defaults.
//!
//! Local `policies` govern only sessions on this machine. What a remote may do here comes from
//! the tailnet policy file through Tailscale, never from this file.
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
    /// 0.3.0 onboarding wrote `"outgoing"` on every local grant: accepted and ignored.
    /// `"incoming"` granted remotes and is refused.
    #[serde(default, rename = "direction")]
    _direction: Option<Outgoing>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Outgoing {
    Outgoing,
}

/// Capability granted to local sessions for a scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Permission {
    /// Reveal eligible roster entries.
    Discover,
    /// Retired with publications; still parsed so older configurations start, grants nothing.
    Read,
    /// Admit collaboration pushes at the destination adapter.
    Push,
    /// Retired with interests; still parsed so older configurations start, grants nothing.
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

pub(crate) fn machine(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub(crate) fn scope(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn read_bounded(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    if !path.is_absolute() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(32_765)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

impl Config {
    /// Reads one explicitly named configuration without inspecting any credential directory.
    /// Retains SHA256 of the exact successfully parsed bytes for guarded managed admission.
    ///
    /// # Errors
    /// Rejects nonabsolute paths, excessive bytes, ambiguous JSON, unknown fields,
    /// invalid identifiers, duplicate scopes/policy tuples/permissions, empty policy grants
    /// and policies naming any machine but this one.
    pub fn read(path: &Path) -> Result<Self, ReadConfigError> {
        let bytes = read_bounded(path).ok_or(ReadConfigError)?;
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
        let mut scopes = HashSet::new();
        for policy in &config.policies {
            if policy.machine_id != config.machine_id
                || !config.scope_ids.contains(&policy.scope_id)
                || !scopes.insert(&policy.scope_id)
                || policy.permissions.is_empty()
                || policy.permissions.len() > 4
                || policy.permissions.iter().collect::<HashSet<_>>().len()
                    != policy.permissions.len()
            {
                return Err(ReadConfigError);
            }
        }
        if config.remote.as_ref().is_some_and(|remote| !remote.valid()) {
            return Err(ReadConfigError);
        }
        Ok(config)
    }

    /// Whether local sessions on `machine` hold `permission` on `scope`. Only this machine can
    /// be granted anything; the retired `read` and `interest` permissions are never asked for.
    #[must_use]
    pub fn permits(&self, machine: &str, scope: &str, permission: Permission) -> bool {
        machine == self.machine_id
            && self
                .policies
                .iter()
                .any(|policy| policy.scope_id == scope && policy.permissions.contains(&permission))
    }

    /// The `--diagnose` report: configuration and Tailscale identity, never live link state.
    pub async fn diagnose(&self) -> serde_json::Value {
        let remote = match &self.remote {
            None => serde_json::json!({"state":"disabled"}),
            Some(settings) => settings.diagnose(&self.machine_id).await,
        };
        serde_json::json!({"version":1,"machineId":self.machine_id,"remote":remote})
    }
}

/// Remote fields of the retired private-CA (0.3.0) and pinned-key shapes.
const RETIRED_REMOTE_FIELDS: [&str; 8] = [
    "rootCertificates",
    "certificateChain",
    "issuerCertificates",
    "crls",
    "revocationState",
    "machineId",
    "privateKey",
    "peerPublicKey",
];

/// The `--diagnose` report for a configuration that [`Config::read`] refused only because it
/// still describes a pre-0.4.0 remote: certificate or key fields in `remote`, a policy naming
/// another machine, or an `incoming` grant. `None` for any other refusal.
///
/// Such a configuration never starts. The report lets setup guide re-linking with Tailscale.
pub fn retired_certificates(path: &Path) -> Option<serde_json::Value> {
    let bytes = read_bounded(path)?;
    let mut value = wire::decode_json(&bytes, Role::LocalClient).ok()?;
    let own = value.get("machineId")?.as_str()?.to_owned();
    let mut retired = false;
    if let Some(remote) = value
        .get_mut("remote")
        .and_then(|remote| remote.as_object_mut())
    {
        for field in RETIRED_REMOTE_FIELDS {
            retired |= remote.remove(field).is_some();
        }
    }
    if let Some(policies) = value
        .get_mut("policies")
        .and_then(|policies| policies.as_array_mut())
    {
        let before = policies.len();
        policies.retain(|policy| {
            policy["machineId"] == own.as_str() && policy["direction"] != "incoming"
        });
        retired |= policies.len() != before;
    }
    if !retired {
        return None;
    }
    // Only the retired parts may be wrong: the rest must parse once they are removed.
    let config = Config::parse(&serde_json::to_vec(&value).ok()?).ok()?;
    Some(
        serde_json::json!({"version":1,"machineId":config.machine_id,"remote":{"state":"retired-certificates"}}),
    )
}
