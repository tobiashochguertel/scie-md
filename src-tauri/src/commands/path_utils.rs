use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentLocatorResponse {
    pub display_path: String,
    pub comparison_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable_file_id: Option<String>,
    pub identity_confidence: &'static str,
    pub aliases: Vec<String>,
}

#[tauri::command]
pub fn resolve_document_locator(
    path: String,
    allow_missing: Option<bool>,
) -> Result<DocumentLocatorResponse, String> {
    resolve_document_locator_path(Path::new(path.trim()), allow_missing.unwrap_or(false))
}

pub fn resolve_document_locator_path(
    requested_path: &Path,
    allow_missing: bool,
) -> Result<DocumentLocatorResponse, String> {
    if requested_path.as_os_str().is_empty() {
        return Err("Document path is empty.".to_string());
    }
    let requested_display = external_safe_path_string(requested_path);
    let exists = requested_path.exists();
    let canonical = if exists {
        fs::canonicalize(requested_path)
            .map_err(|error| format!("Could not resolve document path: {error}"))?
    } else if allow_missing {
        canonicalize_missing_target(requested_path)?
    } else {
        return Err(format!("Document path does not exist: {requested_display}"));
    };
    let canonical_display = external_safe_path_string(&canonical);
    let stable_file_id = if exists {
        fs::metadata(&canonical)
            .ok()
            .and_then(|metadata| stable_file_id(&canonical, &metadata))
    } else {
        None
    };
    let aliases = if canonical_comparison_key(&requested_display)
        == canonical_comparison_key(&canonical_display)
    {
        Vec::new()
    } else {
        vec![canonical_display.clone()]
    };
    Ok(DocumentLocatorResponse {
        display_path: requested_display,
        comparison_key: canonical_comparison_key(&canonical_display),
        identity_confidence: if stable_file_id.is_some() {
            "stableFileId"
        } else {
            "pathOnly"
        },
        stable_file_id,
        aliases,
    })
}

pub fn canonical_comparison_key(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    let uppercase_prefix = normalized.to_ascii_uppercase();
    if uppercase_prefix.starts_with("//?/UNC/") {
        normalized = format!("//{}", &normalized[8..]);
    } else if uppercase_prefix.starts_with("//?/") {
        normalized = normalized[4..].to_string();
    }
    let unc = normalized.starts_with("//");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    if unc && !normalized.starts_with("//") {
        normalized.insert(0, '/');
    }
    if normalized.len() > 1 && !is_drive_root(&normalized) {
        normalized = normalized.trim_end_matches('/').to_string();
    }
    #[cfg(windows)]
    {
        normalized.make_ascii_lowercase();
    }
    normalized
}

pub fn external_safe_path(path: &Path) -> PathBuf {
    strip_windows_verbatim_prefix(path)
}

pub fn external_safe_path_string(path: &Path) -> String {
    external_safe_path(path).to_string_lossy().to_string()
}

#[cfg(windows)]
fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

fn canonicalize_missing_target(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "Save As target must include a file name.".to_string())?;
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not resolve Save As parent directory: {error}"))?;
    Ok(normalize_components(&canonical_parent.join(file_name)))
}

fn normalize_components(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn is_drive_root(path: &str) -> bool {
    path.len() == 3 && path.as_bytes()[1] == b':' && path.ends_with('/')
}

#[cfg(windows)]
fn stable_file_id(path: &Path, _metadata: &fs::Metadata) -> Option<String> {
    use std::mem::zeroed;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
        .ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let success = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if success == 0 {
        return None;
    }
    let file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Some(format!(
        "windows:{:08x}:{:016x}",
        info.dwVolumeSerialNumber, file_index
    ))
}

#[cfg(unix)]
fn stable_file_id(_path: &Path, metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!(
        "unix:{:016x}:{:016x}",
        metadata.dev(),
        metadata.ino()
    ))
}

#[cfg(not(any(windows, unix)))]
fn stable_file_id(_path: &Path, _metadata: &fs::Metadata) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::{external_safe_path_string, resolve_document_locator_path};
    use std::fs;
    use std::path::Path;

    #[test]
    fn resolves_existing_aliases_to_one_stable_identity() {
        let root = std::env::temp_dir().join(format!("sciemd-locator-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original.md");
        let hardlink = root.join("hardlink.md");
        fs::write(&original, "identity").unwrap();
        fs::hard_link(&original, &hardlink).unwrap();

        let first = resolve_document_locator_path(&original, false).unwrap();
        let second = resolve_document_locator_path(&hardlink, false).unwrap();
        assert_eq!(first.identity_confidence, "stableFileId");
        assert_eq!(first.stable_file_id, second.stable_file_id);
        assert_ne!(first.comparison_key, second.comparison_key);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolves_missing_save_target_through_canonical_parent_then_refreshes() {
        let root =
            std::env::temp_dir().join(format!("sciemd-locator-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("new.md");
        let reserved = resolve_document_locator_path(&target, true).unwrap();
        assert_eq!(reserved.identity_confidence, "pathOnly");
        assert!(reserved.stable_file_id.is_none());
        fs::write(&target, "created").unwrap();
        let refreshed = resolve_document_locator_path(&target, false).unwrap();
        assert_eq!(refreshed.identity_confidence, "stableFileId");
        assert!(refreshed.stable_file_id.is_some());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn resolves_symlink_alias_to_target_identity() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("sciemd-locator-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original.md");
        let alias = root.join("alias.md");
        fs::write(&original, "identity").unwrap();
        symlink(&original, &alias).unwrap();

        let first = resolve_document_locator_path(&original, false).unwrap();
        let second = resolve_document_locator_path(&alias, false).unwrap();
        assert_eq!(first.stable_file_id, second.stable_file_id);
        assert_eq!(first.comparison_key, second.comparison_key);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn comparison_preserves_posix_case() {
        #[cfg(not(windows))]
        {
            assert_ne!(
                super::canonical_comparison_key("/tmp/Paper.md"),
                super::canonical_comparison_key("/tmp/paper.md")
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn strips_windows_verbatim_disk_prefix() {
        assert_eq!(
            external_safe_path_string(Path::new(r"\\?\C:\Users\amin_\paper.md")),
            r"C:\Users\amin_\paper.md"
        );
    }

    #[test]
    #[cfg(windows)]
    fn strips_windows_verbatim_unc_prefix() {
        assert_eq!(
            external_safe_path_string(Path::new(r"\\?\UNC\server\share\paper.md")),
            r"\\server\share\paper.md"
        );
        assert_eq!(
            super::canonical_comparison_key(r"\\?\UNC\Server\Share\Paper.md"),
            "//server/share/paper.md"
        );
    }
}
