//! One owner-only Ed25519 identity key per gateway, and the public key text its peer pins.
//!
//! The key file is the PKCS#8 v2 document from ring, created exclusively in an owner-only
//! directory and never followed through a symlink. Public key text is the lowercase hex of
//! the raw 32-byte Ed25519 public key; nothing else identifies a gateway to its peer.
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::Deserialize;

use crate::wire::{self, Role};

/// Length of a raw Ed25519 public key.
pub const PUBLIC_KEY_LEN: usize = 32;

/// Creates a new Ed25519 key file at `path` and returns its public key text.
///
/// The file is created exclusively with mode 0600; an existing file is never replaced.
///
/// # Errors
/// Rejects a relative path, an unsafe or non-canonical parent directory, an existing file
/// (including a symlink) and any failure to generate, write or sync the key.
pub fn generate(path: &Path) -> io::Result<String> {
    let parent = private_directory(path)?;
    let document = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| io::Error::other("key generation failed"))?;
    let public = public_key(document.as_ref())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits().cast_signed())
        .open(path)?;
    let written = file
        .write_all(document.as_ref())
        .and_then(|()| file.sync_all());
    if let Err(error) = written {
        // The directory is owner-only, so this removes only the partial file just created.
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    std::fs::File::open(parent)?.sync_all()?;
    Ok(hex(&public))
}

/// Reads an existing key file and returns its public key text.
///
/// # Errors
/// Rejects unsafe files and directories (as for every credential) and anything that is not
/// a consistent PKCS#8 v2 Ed25519 key.
pub fn show(path: &Path) -> io::Result<String> {
    Ok(hex(&public_key(&crate::remote::read_private(path)?)?))
}

/// Returns the raw public key of a PKCS#8 v2 Ed25519 document.
pub(crate) fn public_key(pkcs8: &[u8]) -> io::Result<[u8; PUBLIC_KEY_LEN]> {
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8)
        .map_err(|_| io::Error::other("not a PKCS#8 v2 Ed25519 key"))?;
    pair.public_key()
        .as_ref()
        .try_into()
        .map_err(|_| io::Error::other("unexpected Ed25519 public key length"))
}

/// Decodes public key text: exactly 64 lowercase hex characters.
///
/// Only the encoding is checked. A value that is not a curve point can never verify a
/// handshake signature, so pinning one fails closed at the first connection.
pub fn parse_public(text: &str) -> Option<[u8; PUBLIC_KEY_LEN]> {
    let digits = text.as_bytes();
    if digits.len() != PUBLIC_KEY_LEN * 2 {
        return None;
    }
    let nibble = |digit: u8| match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        _ => None,
    };
    let mut key = [0; PUBLIC_KEY_LEN];
    for (byte, [high, low]) in key.iter_mut().zip(digits.as_chunks::<2>().0) {
        *byte = nibble(*high)? << 4 | nibble(*low)?;
    }
    Some(key)
}

/// Encodes bytes as lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            use std::fmt::Write;
            write!(output, "{byte:02x}").expect("writing to String cannot fail");
            output
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    version: u8,
    private_key: PathBuf,
}

/// Runs one `key` CLI operation (`generate` or `show`) on strict JSON input.
///
/// The output carries only the public key, never private key material or paths.
///
/// # Errors
/// Rejects unknown operations, invalid or ambiguous input and every file failure above.
pub fn execute(operation: &str, input: &[u8]) -> io::Result<serde_json::Value> {
    let rejected = || io::Error::new(io::ErrorKind::InvalidInput, "invalid key input");
    let value = wire::decode_json(input, Role::LocalClient).map_err(|_| rejected())?;
    let input: Input = serde_json::from_value(value).map_err(|_| rejected())?;
    if input.version != 1 || !input.private_key.is_absolute() {
        return Err(rejected());
    }
    let public = match operation {
        "generate" => generate(&input.private_key)?,
        "show" => show(&input.private_key)?,
        _ => return Err(rejected()),
    };
    Ok(serde_json::json!({"version":1,"operation":operation,"publicKey":public}))
}

/// The protected, canonical parent directory of a new private file.
fn private_directory(path: &Path) -> io::Result<&Path> {
    let rejected = || io::Error::new(io::ErrorKind::PermissionDenied, "private key path rejected");
    crate::paths::private_parent(path)?;
    let parent = path.parent().ok_or_else(rejected)?;
    let metadata = std::fs::metadata(parent)?;
    if parent.canonicalize()? != parent
        || !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(rejected());
    }
    Ok(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_text_round_trips_and_rejects_other_encodings() {
        let key: [u8; PUBLIC_KEY_LEN] =
            std::array::from_fn(|index| u8::try_from(index * 7).expect("small index") ^ 0xa5);
        let text = hex(&key);
        assert_eq!(text.len(), 64);
        assert_eq!(parse_public(&text), Some(key));
        for bad in [
            text.to_uppercase(),
            text[..63].to_owned(),
            format!("{text}0"),
            format!("g{}", &text[1..]),
            format!(" {}", &text[1..]),
            String::new(),
        ] {
            assert_eq!(parse_public(&bad), None, "{bad:?}");
        }
    }
}
