//! Files that hold a secret: one place that creates one owner-only, and one
//! that tightens a file already on disk.
//!
//! Three stores keep a secret in a file — the agent store's API key, the LAN
//! token store, and a `--log-file` trace — and each grew its own copy of the
//! `chmod` with its own idea of when to run it. Trusting the umask leaves the
//! secret group-readable; running `chmod` after the write leaves it readable
//! for as long as the write takes. Asking for the mode at creation is the
//! whole of the fix, and now it is one fix.

use std::io::Write;
use std::path::Path;

/// Open `path` for appending, created owner-only where the platform has
/// permissions and it does not exist yet.
///
/// The trace log appends on purpose — a log that lost yesterday's session when
/// today's started is a log nobody can compare against — so this is the door
/// for a file that must keep what it already has.
pub fn open_private_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Write `bytes` to `path`, replacing what is there, with the file created
/// owner-only.
///
/// The mode is asked for at creation rather than set afterwards: a file that
/// was born readable and tightened a line later was readable for that line —
/// and the line is one crash away from being forever.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.flush()
}

/// Tighten `path` to owner-only, where the platform has permissions.
///
/// For a file that already exists: one written before the mode was asked for
/// at creation, or carried in from somewhere whose umask was generous.
#[cfg(unix)]
pub fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Nothing to do where the file's ACL is the user's own business.
#[cfg(not(unix))]
pub fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Replace `path` with `bytes` in one atomic rename, both files owner-only.
///
/// The temp file is written beside the real one and renamed over it, so a
/// reader never sees a half-written store: a partial JSON object read back as
/// an empty map is a bridge that will not authenticate, or a task list that
/// has lost its history. The parent directory is created first, because the
/// stores that use this are the first thing a fresh machine writes.
///
/// Create a uniquely named temp exclusively so concurrent writers cannot
/// truncate each other's data. Only name collisions are retried, within a
/// fixed bound; permanent filesystem errors are returned immediately.
pub fn write_private_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    for _ in 0..16 {
        let tmp = path.with_extension(format!("tmp{}", uuid::Uuid::new_v4().simple()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&tmp) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let result = (|| {
            file.write_all(bytes)?;
            file.flush()?;
            // Windows must release the temporary file before renaming it.
            drop(file);
            std::fs::rename(&tmp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        return result;
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a temporary file after 16 attempts",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_save_reports_permanent_errors_and_removes_its_temporary_file() {
        let dir = std::env::temp_dir().join(format!("linkr-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        let blocker = dir.join("not-a-directory");
        std::fs::write(&blocker, b"keep").expect("blocker");
        assert!(write_private_atomically(&blocker.join("store.json"), b"{}").is_err());
        let destination = dir.join("existing-directory");
        std::fs::create_dir(&destination).expect("destination directory");
        assert!(write_private_atomically(&destination, b"{}").is_err());
        assert_eq!(std::fs::read_dir(&dir).expect("list").count(), 2);
        assert_eq!(std::fs::read(&blocker).expect("read blocker"), b"keep");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn atomic_save_replaces_the_store_and_leaves_no_temporary_files() {
        let dir = std::env::temp_dir().join(format!("linkr-save-{}", uuid::Uuid::new_v4()));
        let path = dir.join("store.json");
        write_private_atomically(&path, b"old").expect("initial save");
        write_private_atomically(&path, b"new").expect("replacement");
        assert_eq!(std::fs::read(&path).expect("read store"), b"new");
        assert_eq!(std::fs::read_dir(&dir).expect("list").count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// The mode is the mechanism: a file made for a secret is made
    /// owner-only, an appended-to one is made the same way, and a file that
    /// predates the rule is tightened when the program notices it.
    #[cfg(unix)]
    #[test]
    fn a_secret_file_is_owner_only_from_the_first_byte() {
        use std::os::unix::fs::PermissionsExt;
        let mode_of =
            |path: &Path| std::fs::metadata(path).expect("stat").permissions().mode() & 0o777;
        let dir = std::env::temp_dir().join(format!("linkr-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch directory");

        let written = dir.join("secret");
        write_private(&written, b"hunter2").expect("written");
        assert_eq!(mode_of(&written), 0o600, "the umask must not open it");
        assert_eq!(
            std::fs::read(&written).expect("read"),
            b"hunter2",
            "and the bytes are the bytes"
        );

        let appended = dir.join("trace");
        {
            let mut file = open_private_append(&appended).expect("opened");
            file.write_all(b"line\n").expect("appended");
        }
        assert_eq!(mode_of(&appended), 0o600, "an append log is the same kind");

        let loose = dir.join("loose");
        std::fs::write(&loose, b"old").expect("written");
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644))
            .expect("chmod to the umask's habit");
        restrict(&loose).expect("tightened");
        assert_eq!(mode_of(&loose), 0o600, "an old file is repaired");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
