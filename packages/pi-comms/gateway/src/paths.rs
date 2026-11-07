//! Protected path ancestry for private sockets, credentials and durable rollback state.
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

/// Protects path discovery across restarts, not only the final leaf open.
///
/// Root/current-UID owners are trusted. Writable ancestors require the sticky bit;
/// each child is independently required to have a trusted owner, so another UID
/// cannot rename or substitute that child. Same-UID/root mutation is outside C1.
pub(crate) fn private_parent(path: &Path) -> io::Result<()> {
    let rejected = || {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path ancestry rejected",
        )
    };
    let parent = path.parent().ok_or_else(rejected)?;
    if !path.is_absolute() {
        return Err(rejected());
    }
    let uid = rustix::process::geteuid().as_raw();
    let mut current = PathBuf::new();
    for component in parent.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(rejected());
        }
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !matches!(metadata.uid(), owner if owner == 0 || owner == uid)
            || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
        {
            return Err(rejected());
        }
    }
    let metadata = std::fs::symlink_metadata(parent)?;
    if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(rejected());
    }
    Ok(())
}
