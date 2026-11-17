//! Owner-only files and permanent mutation locks. No public document supplies a path.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(1);
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).mode(0o600).custom_flags(
        (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
            .bits()
            .cast_signed(),
    );
    options
}
fn validate(file: &File) -> io::Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
    {
        return Err(super::reject(
            "pair file must be owned, regular, single-link and mode 0600",
        ));
    }
    Ok(())
}
pub(super) fn read(path: &Path) -> io::Result<Vec<u8>> {
    crate::paths::private_parent(path)?;
    let file = options().open(path)?;
    validate(&file)?;
    let mut bytes = Vec::new();
    file.take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        return Err(super::reject("pair file exceeds bound"));
    }
    Ok(bytes)
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> io::Result<T> {
    if bytes.is_empty() || bytes.len() > 1_048_576 {
        return Err(super::reject("pair JSON size bound"));
    }
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let Unique(value) = Unique::deserialize(&mut parser)
        .map_err(|_| super::reject("invalid bounded pairing JSON"))?;
    parser
        .end()
        .map_err(|_| super::reject("trailing pairing JSON"))?;
    serde_json::from_value(value).map_err(|_| super::reject("invalid pairing document schema"))
}
pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> io::Result<T> {
    decode(&read(path)?)
}
pub(super) fn create_dir(path: &Path) -> io::Result<()> {
    crate::paths::private_parent(path)?;
    std::fs::DirBuilder::new().mode(0o700).create(path)?;
    File::open(
        path.parent()
            .ok_or_else(|| super::reject("missing parent"))?,
    )?
    .sync_all()
}
pub(super) fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    crate::paths::private_parent(path)?;
    let mut file = options().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    File::open(
        path.parent()
            .ok_or_else(|| super::reject("missing parent"))?,
    )?
    .sync_all()
}
// Re-sync an exact existing cache file on retry: a previous write may have
// completed but failed before its durability acknowledgement.
pub(super) fn sync_existing(path: &Path) -> io::Result<()> {
    crate::paths::private_parent(path)?;
    let file = options().open(path)?;
    validate(&file)?;
    file.sync_all()?;
    File::open(
        path.parent()
            .ok_or_else(|| super::reject("missing parent"))?,
    )?
    .sync_all()
}

pub(super) fn atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    crate::paths::private_parent(path)?;
    validate(&options().open(path)?)?;
    let temp = path.with_file_name(format!(
        ".pair-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    write_new(&temp, bytes)?;
    let result = std::fs::rename(&temp, path).and_then(|()| {
        File::open(
            path.parent()
                .ok_or_else(|| super::reject("missing parent"))?,
        )?
        .sync_all()
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
pub(super) fn lock(dir: &Path) -> io::Result<File> {
    let path = dir.join(".mutation.lock");
    crate::paths::private_parent(&path)?;
    let file = options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    validate(&file)?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
    let named = std::fs::symlink_metadata(path)?;
    let opened = file.metadata()?;
    if named.dev() != opened.dev() || named.ino() != opened.ino() {
        return Err(super::reject("pair lock changed"));
    }
    Ok(file)
}

use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use std::fmt;
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = Unique;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a non-null JSON value with unique object keys")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(value)))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Unique, E> {
                if value > 9_007_199_254_740_991 {
                    return Err(E::custom("integer range"));
                }
                Ok(Unique(Value::from(value)))
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Unique, E> {
                Err(E::custom("negative integer"))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Unique, E> {
                Err(E::custom("non-integer lexeme"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(value.to_owned())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Unique, E> {
                Ok(Unique(Value::String(value)))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Unique, A::Error> {
                let mut values = Vec::new();
                while let Some(Unique(value)) = sequence.next_element()? {
                    if values.len() == 65_536 {
                        return Err(de::Error::custom("array limit"));
                    }
                    values.push(value);
                }
                Ok(Unique(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut mapping: A) -> Result<Unique, A::Error> {
                let mut values = Map::new();
                while let Some(key) = mapping.next_key::<String>()? {
                    if !key.is_ascii() || values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate or non-ASCII key"));
                    }
                    let Unique(value) = mapping.next_value()?;
                    values.insert(key, value);
                }
                Ok(Unique(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(StrictVisitor)
    }
}
