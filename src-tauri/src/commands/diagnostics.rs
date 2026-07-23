use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::io::Read;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

use super::path_utils::canonical_comparison_key;

const DIAGNOSTICS_DIR: &str = "diagnostics";
const HEARTBEAT_FILE: &str = "renderer-heartbeat.json";
const DIAGNOSTICS_LOG_FILE: &str = "diagnostics.jsonl";
const RECOVERY_SNAPSHOT_FILE: &str = "latest-recovery-snapshot.json";
const RECOVERY_SNAPSHOT_DIR: &str = "recovery-snapshots";
const RECOVERY_QUARANTINE_DIR: &str = "recovery-quarantine";
const CURRENT_RECOVERY_SCHEMA_VERSION: u16 = 3;
const DIAGNOSTICS_BUNDLE_PREFIX: &str = "diagnostics-bundle";
const MAX_DIAGNOSTICS_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RECOVERY_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECOVERY_SNAPSHOT_COUNT: usize = 8;
const MAX_RECOVERY_SNAPSHOT_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_BUNDLE_LOG_TAIL_BYTES: usize = 512 * 1024;
const PREVIOUS_SESSION_CRASH_WINDOW_MS: u128 = 15_000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererHeartbeatPayload {
    pub session_id: String,
    pub document_path: Option<String>,
    pub mode: Option<String>,
    pub markdown_bytes: u64,
    pub line_count: u64,
    pub image_count: u64,
    pub math_count: u64,
    pub visual_atom_count: u64,
    pub warning_count: u64,
    pub error_count: u64,
    #[serde(default)]
    pub active_background_job_count: u64,
    #[serde(default)]
    pub stuck_background_job_count: u64,
    #[serde(default)]
    pub oldest_background_job_ms: Option<u64>,
    #[serde(default)]
    pub background_job_labels: Vec<String>,
    #[serde(default)]
    pub stuck_background_job_labels: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererHeartbeatStatus {
    pub previous_session_suspected_crash: bool,
    pub previous_session_last_seen_ms: Option<u128>,
    pub diagnostics_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundleMetadata {
    pub path: String,
    pub diagnostics_dir: String,
    pub created_at_ms: u128,
    pub event_count: u64,
    pub log_bytes: u64,
    pub recovery_snapshot_bytes: Option<usize>,
    pub heartbeat_seen_at_ms: Option<u128>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsEventPayload {
    pub event_type: String,
    pub message: String,
    pub document_path: Option<String>,
    pub mode: Option<String>,
    pub markdown_bytes: Option<u64>,
    pub component_stack: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshotPayload {
    #[serde(default)]
    pub schema_version: Option<u16>,
    #[serde(default)]
    pub generation: Option<u64>,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(default)]
    pub commit_state: Option<String>,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub source_revision: Option<u64>,
    #[serde(default)]
    pub catalog_schema_version: Option<u16>,
    #[serde(default)]
    pub media_type: Option<String>,
    pub markdown: String,
    pub file_path: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    pub updated_at_ms: u128,
    #[serde(default)]
    pub protected_document_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    #[serde(default = "default_recovery_schema_version")]
    pub schema_version: u16,
    #[serde(default = "default_recovery_generation")]
    pub generation: u64,
    #[serde(default)]
    pub checksum: String,
    #[serde(default = "default_recovery_commit_state")]
    pub commit_state: String,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub source_revision: Option<u64>,
    #[serde(default)]
    pub catalog_schema_version: Option<u16>,
    #[serde(default)]
    pub media_type: Option<String>,
    pub markdown: String,
    pub file_path: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    pub updated_at_ms: u128,
    pub markdown_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshotMetadata {
    pub updated_at_ms: u128,
    pub markdown_bytes: usize,
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredHeartbeat {
    session_id: String,
    seen_at_ms: u128,
    clean_shutdown: bool,
    payload: RendererHeartbeatPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDiagnosticsEvent<'a> {
    timestamp_ms: u128,
    event: &'a DiagnosticsEventPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsBundle {
    created_at_ms: u128,
    app_version: &'static str,
    diagnostics_dir: String,
    heartbeat: Option<StoredHeartbeat>,
    diagnostics_log: DiagnosticsLogBundle,
    recovery_snapshot: Option<RecoverySnapshotBundle>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsLogBundle {
    path: String,
    bytes: u64,
    tail: String,
    tail_event_count: u64,
    tail_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverySnapshotBundle {
    path: String,
    schema_version: u16,
    generation: u64,
    file_path: Option<String>,
    format: Option<String>,
    updated_at_ms: u128,
    markdown_bytes: usize,
    markdown_omitted_reason: &'static str,
}

#[tauri::command]
pub fn record_renderer_heartbeat(
    app: AppHandle,
    payload: RendererHeartbeatPayload,
) -> Result<RendererHeartbeatStatus, String> {
    let dir = diagnostics_dir(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create diagnostics dir: {error}"))?;
    let heartbeat_path = dir.join(HEARTBEAT_FILE);
    let previous = read_heartbeat(&heartbeat_path).ok().flatten();
    let now = timestamp_ms();
    let previous_session_suspected_crash = previous.as_ref().is_some_and(|heartbeat| {
        heartbeat.session_id != payload.session_id
            && !heartbeat.clean_shutdown
            && now.saturating_sub(heartbeat.seen_at_ms) >= PREVIOUS_SESSION_CRASH_WINDOW_MS
    });
    let previous_session_last_seen_ms = previous
        .as_ref()
        .filter(|heartbeat| heartbeat.session_id != payload.session_id)
        .map(|heartbeat| heartbeat.seen_at_ms);
    let stored = StoredHeartbeat {
        session_id: payload.session_id.clone(),
        seen_at_ms: now,
        clean_shutdown: false,
        payload,
    };
    write_json_atomically(&heartbeat_path, &stored)?;
    if previous_session_suspected_crash {
        let previous_payload = previous.as_ref().map(|heartbeat| &heartbeat.payload);
        append_diagnostics_event_to_dir(
            &dir,
            &DiagnosticsEventPayload {
                event_type: "previous-renderer-session-suspected-crash".into(),
                message: "Previous renderer session stopped without a clean shutdown marker."
                    .into(),
                document_path: previous_payload.and_then(|payload| payload.document_path.clone()),
                mode: previous_payload.and_then(|payload| payload.mode.clone()),
                markdown_bytes: previous_payload.map(|payload| payload.markdown_bytes),
                component_stack: None,
            },
        )?;
    }
    Ok(RendererHeartbeatStatus {
        previous_session_suspected_crash,
        previous_session_last_seen_ms,
        diagnostics_dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn mark_renderer_clean_shutdown(app: AppHandle, session_id: String) -> Result<(), String> {
    let heartbeat_path = diagnostics_dir(&app)?.join(HEARTBEAT_FILE);
    let Some(mut heartbeat) = read_heartbeat(&heartbeat_path)? else {
        return Ok(());
    };
    if heartbeat.session_id == session_id {
        heartbeat.clean_shutdown = true;
        heartbeat.seen_at_ms = timestamp_ms();
        write_json_atomically(&heartbeat_path, &heartbeat)?;
    }
    Ok(())
}

#[tauri::command]
pub fn mark_current_renderer_clean_shutdown(app: AppHandle) -> Result<(), String> {
    let heartbeat_path = diagnostics_dir(&app)?.join(HEARTBEAT_FILE);
    let Some(mut heartbeat) = read_heartbeat(&heartbeat_path)? else {
        return Ok(());
    };
    heartbeat.clean_shutdown = true;
    heartbeat.seen_at_ms = timestamp_ms();
    write_json_atomically(&heartbeat_path, &heartbeat)
}

#[tauri::command]
pub fn append_diagnostics_event(
    app: AppHandle,
    payload: DiagnosticsEventPayload,
) -> Result<(), String> {
    let dir = diagnostics_dir(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create diagnostics dir: {error}"))?;
    append_diagnostics_event_to_dir(&dir, &payload)
}

#[tauri::command]
pub fn export_diagnostics_bundle(app: AppHandle) -> Result<DiagnosticsBundleMetadata, String> {
    let dir = diagnostics_dir(&app)?;
    export_diagnostics_bundle_to_dir(&dir)
}

#[tauri::command]
pub fn write_recovery_snapshot(
    app: AppHandle,
    payload: RecoverySnapshotPayload,
) -> Result<RecoverySnapshotMetadata, String> {
    let markdown_bytes = payload.markdown.len();
    if markdown_bytes > MAX_RECOVERY_SNAPSHOT_BYTES {
        return Err(format!(
            "Recovery snapshot is too large: {markdown_bytes} bytes exceeds {MAX_RECOVERY_SNAPSHOT_BYTES} bytes."
        ));
    }
    let dir = diagnostics_dir(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create diagnostics dir: {error}"))?;
    let requested_version = payload
        .schema_version
        .unwrap_or(CURRENT_RECOVERY_SCHEMA_VERSION);
    if requested_version > CURRENT_RECOVERY_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported future recovery schema version: {requested_version}."
        ));
    }
    if payload
        .commit_state
        .as_deref()
        .is_some_and(|state| state != "committed")
    {
        return Err("Recovery publication is not committed.".into());
    }
    validate_recovery_catalog_metadata(
        payload.document_id.as_deref(),
        payload.source_revision,
        payload.catalog_schema_version,
        payload.media_type.as_deref(),
    )?;
    let path = recovery_snapshot_path(
        &dir,
        payload.file_path.as_deref(),
        payload.document_id.as_deref(),
    );
    let previous = read_recovery_snapshot_with_fallback(&dir, &path)?;
    let minimum_generation = previous
        .as_ref()
        .map_or(1, |snapshot| snapshot.generation.saturating_add(1));
    let generation = payload.generation.unwrap_or(minimum_generation);
    if generation < minimum_generation {
        return Err(format!(
            "Recovery generation {generation} does not advance the current generation."
        ));
    }
    let mut snapshot = RecoverySnapshot {
        schema_version: CURRENT_RECOVERY_SCHEMA_VERSION,
        generation,
        checksum: String::new(),
        commit_state: "committed".into(),
        document_id: payload.document_id,
        source_revision: payload.source_revision,
        catalog_schema_version: payload.catalog_schema_version,
        media_type: payload.media_type,
        markdown: payload.markdown,
        file_path: payload.file_path,
        format: payload.format,
        updated_at_ms: payload.updated_at_ms,
        markdown_bytes,
    };
    snapshot.checksum = recovery_snapshot_checksum(&snapshot);
    if let Some(requested_checksum) = payload.checksum {
        if requested_checksum != snapshot.checksum {
            return Err("Recovery snapshot checksum does not match its payload.".into());
        }
    }
    if let Some(previous) = previous {
        write_json_atomically(&previous_recovery_snapshot_path(&path), &previous)?;
    }
    write_json_atomically(&path, &snapshot)?;
    let latest_path = dir.join(RECOVERY_SNAPSHOT_FILE);
    if let Some(previous_latest) = read_recovery_snapshot_with_fallback(&dir, &latest_path)? {
        write_json_atomically(
            &previous_recovery_snapshot_path(&latest_path),
            &previous_latest,
        )?;
    }
    write_json_atomically(&latest_path, &snapshot)?;
    let protected_document_ids = payload
        .protected_document_ids
        .into_iter()
        .collect::<HashSet<_>>();
    prune_recovery_snapshots(&dir, &path, &protected_document_ids)?;
    Ok(RecoverySnapshotMetadata {
        updated_at_ms: snapshot.updated_at_ms,
        markdown_bytes,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn maintain_recovery_snapshots(
    app: AppHandle,
    protected_document_ids: Vec<String>,
) -> Result<usize, String> {
    let dir = diagnostics_dir(&app)?;
    fs::create_dir_all(dir.join(RECOVERY_SNAPSHOT_DIR))
        .map_err(|error| format!("Could not create recovery snapshot dir: {error}"))?;
    prune_recovery_snapshots(
        &dir,
        &PathBuf::new(),
        &protected_document_ids.into_iter().collect(),
    )
}

#[tauri::command]
pub fn read_recovery_snapshot(
    app: AppHandle,
    file_path: Option<String>,
    document_id: Option<String>,
    latest: Option<bool>,
) -> Result<Option<RecoverySnapshot>, String> {
    let dir = diagnostics_dir(&app)?;
    if latest.unwrap_or(file_path.is_none() && document_id.is_none()) {
        return read_recovery_snapshot_with_fallback(&dir, &dir.join(RECOVERY_SNAPSHOT_FILE));
    }
    let path = recovery_snapshot_path(&dir, file_path.as_deref(), document_id.as_deref());
    let keyed = read_recovery_snapshot_with_fallback(&dir, &path)?;
    if keyed.is_some() {
        return Ok(keyed);
    }
    if document_id.is_some() {
        return Ok(None);
    }
    let legacy_path = legacy_recovery_snapshot_path(&dir, file_path.as_deref());
    let legacy_keyed = read_recovery_snapshot_with_fallback(&dir, &legacy_path)?;
    if legacy_keyed.is_some() {
        return Ok(legacy_keyed);
    }
    let legacy = read_recovery_snapshot_with_fallback(&dir, &dir.join(RECOVERY_SNAPSHOT_FILE))?;
    Ok(legacy.filter(|snapshot| recovery_snapshot_matches(snapshot, file_path.as_deref())))
}

#[tauri::command]
pub fn clear_recovery_snapshot(
    app: AppHandle,
    file_path: Option<String>,
    document_id: Option<String>,
    up_to_source_revision: Option<u64>,
    latest: Option<bool>,
) -> Result<(), String> {
    let dir = diagnostics_dir(&app)?;
    if latest.unwrap_or(false) {
        let latest_path = dir.join(RECOVERY_SNAPSHOT_FILE);
        remove_recovery_snapshot_file(&latest_path)?;
        return remove_recovery_snapshot_file(&previous_recovery_snapshot_path(&latest_path));
    }
    let path = recovery_snapshot_path(&dir, file_path.as_deref(), document_id.as_deref());
    if let (Some(max_revision), Some(snapshot)) = (
        up_to_source_revision,
        read_recovery_snapshot_with_fallback(&dir, &path)?,
    ) {
        if snapshot
            .source_revision
            .is_some_and(|revision| revision > max_revision)
        {
            return Ok(());
        }
    }
    remove_recovery_snapshot_file(&path)?;
    remove_recovery_snapshot_file(&previous_recovery_snapshot_path(&path))?;
    if document_id.is_none() {
        let legacy_path = legacy_recovery_snapshot_path(&dir, file_path.as_deref());
        if legacy_path != path {
            remove_recovery_snapshot_file(&legacy_path)?;
            remove_recovery_snapshot_file(&previous_recovery_snapshot_path(&legacy_path))?;
        }
    }
    let latest_path = dir.join(RECOVERY_SNAPSHOT_FILE);
    if let Some(snapshot) = read_recovery_snapshot_with_fallback(&dir, &latest_path)? {
        let matches_target = document_id.as_ref().map_or_else(
            || recovery_snapshot_matches(&snapshot, file_path.as_deref()),
            |document_id| snapshot.document_id.as_deref() == Some(document_id.as_str()),
        );
        if matches_target {
            remove_recovery_snapshot_file(&latest_path)?;
            remove_recovery_snapshot_file(&previous_recovery_snapshot_path(&latest_path))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_recovery_snapshots(app: AppHandle) -> Result<Vec<RecoverySnapshot>, String> {
    let dir = diagnostics_dir(&app)?;
    list_recovery_snapshots_in_dir(&dir)
}

fn list_recovery_snapshots_in_dir(diagnostics_dir: &Path) -> Result<Vec<RecoverySnapshot>, String> {
    let directory = diagnostics_dir.join(RECOVERY_SNAPSHOT_DIR);
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let mut snapshots = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || name.ends_with(".previous")
        {
            continue;
        }
        match read_recovery_snapshot_with_fallback(diagnostics_dir, &path) {
            Ok(Some(snapshot)) if snapshot.document_id.is_some() => snapshots.push(snapshot),
            Ok(_) => {}
            Err(error) => return Err(error),
        }
    }
    snapshots.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| left.document_id.cmp(&right.document_id))
    });
    Ok(snapshots)
}

fn remove_recovery_snapshot_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not clear recovery snapshot: {error}")),
    }
}

fn read_recovery_snapshot_file(path: &Path) -> Result<Option<RecoverySnapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read recovery snapshot: {error}"))?;
    let snapshot: RecoverySnapshot = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse recovery snapshot: {error}"))?;
    Ok(Some(normalize_recovery_snapshot(snapshot)?))
}

fn read_recovery_snapshot_with_fallback(
    diagnostics_dir: &Path,
    path: &Path,
) -> Result<Option<RecoverySnapshot>, String> {
    match read_recovery_snapshot_file(path) {
        Ok(Some(snapshot)) => {
            let _ = write_json_atomically(path, &snapshot);
            Ok(Some(snapshot))
        }
        Ok(None) => {
            let previous_path = previous_recovery_snapshot_path(path);
            match read_recovery_snapshot_file(&previous_path) {
                Ok(snapshot) => Ok(snapshot),
                Err(previous_error) => {
                    quarantine_recovery_snapshot(diagnostics_dir, &previous_path, &previous_error)?;
                    Ok(None)
                }
            }
        }
        Err(error) => {
            quarantine_recovery_snapshot(diagnostics_dir, path, &error)?;
            let previous_path = previous_recovery_snapshot_path(path);
            match read_recovery_snapshot_file(&previous_path) {
                Ok(Some(snapshot)) => Ok(Some(snapshot)),
                Ok(None) => Ok(None),
                Err(previous_error) => {
                    quarantine_recovery_snapshot(diagnostics_dir, &previous_path, &previous_error)?;
                    Ok(None)
                }
            }
        }
    }
}

fn normalize_recovery_snapshot(mut snapshot: RecoverySnapshot) -> Result<RecoverySnapshot, String> {
    if snapshot.schema_version == 0 {
        return Err("Recovery schema version must be positive.".into());
    }
    if snapshot.schema_version > CURRENT_RECOVERY_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported future recovery schema version: {}.",
            snapshot.schema_version
        ));
    }
    if snapshot.commit_state != "committed" {
        return Err("Recovery publication is not committed.".into());
    }
    validate_recovery_catalog_metadata(
        snapshot.document_id.as_deref(),
        snapshot.source_revision,
        snapshot.catalog_schema_version,
        snapshot.media_type.as_deref(),
    )?;
    snapshot.markdown_bytes = snapshot.markdown.len();
    if snapshot.schema_version < CURRENT_RECOVERY_SCHEMA_VERSION {
        while snapshot.schema_version < CURRENT_RECOVERY_SCHEMA_VERSION {
            snapshot.schema_version = match snapshot.schema_version {
                1 => 2,
                2 => 3,
                version => {
                    return Err(format!(
                        "Missing recovery migration from schema version {version}."
                    ))
                }
            };
        }
        snapshot.generation = snapshot.generation.max(1);
        snapshot.checksum = recovery_snapshot_checksum(&snapshot);
        return Ok(snapshot);
    }
    let expected = recovery_snapshot_checksum(&snapshot);
    if snapshot.checksum != expected {
        return Err("Recovery snapshot checksum mismatch.".into());
    }
    Ok(snapshot)
}

fn validate_recovery_catalog_metadata(
    document_id: Option<&str>,
    source_revision: Option<u64>,
    catalog_schema_version: Option<u16>,
    media_type: Option<&str>,
) -> Result<(), String> {
    match document_id {
        None if source_revision.is_none()
            && catalog_schema_version.is_none()
            && media_type.is_none() =>
        {
            Ok(())
        }
        Some(document_id)
            if !document_id.is_empty()
                && source_revision.is_some()
                && catalog_schema_version == Some(1)
                && media_type.is_some_and(|value| !value.is_empty()) =>
        {
            Ok(())
        }
        _ => Err("Recovery catalog metadata is incomplete or uses an unsupported version.".into()),
    }
}

fn recovery_snapshot_checksum(snapshot: &RecoverySnapshot) -> String {
    let mut material = serde_json::json!({
        "commitState": snapshot.commit_state,
        "filePath": snapshot.file_path,
        "format": snapshot.format,
        "generation": snapshot.generation,
        "markdown": snapshot.markdown,
        "schemaVersion": snapshot.schema_version,
        "updatedAtMs": snapshot.updated_at_ms,
    });
    let object = material
        .as_object_mut()
        .expect("recovery checksum material should be an object");
    if let Some(document_id) = &snapshot.document_id {
        object.insert("documentId".into(), serde_json::json!(document_id));
    }
    if let Some(source_revision) = snapshot.source_revision {
        object.insert("sourceRevision".into(), serde_json::json!(source_revision));
    }
    if let Some(catalog_schema_version) = snapshot.catalog_schema_version {
        object.insert(
            "catalogSchemaVersion".into(),
            serde_json::json!(catalog_schema_version),
        );
    }
    if let Some(media_type) = &snapshot.media_type {
        object.insert("mediaType".into(), serde_json::json!(media_type));
    }
    let bytes = serde_json::to_vec(&material).expect("recovery checksum material should serialize");
    sha256_hex(&bytes)
}

fn previous_recovery_snapshot_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recovery.json");
    path.with_file_name(format!("{file_name}.previous"))
}

fn quarantine_recovery_snapshot(
    diagnostics_dir: &Path,
    path: &Path,
    reason: &str,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not preserve invalid recovery snapshot: {error}"))?;
    let digest = sha256_hex(raw.as_bytes());
    let source_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recovery.json");
    let quarantine_path = diagnostics_dir
        .join(RECOVERY_QUARANTINE_DIR)
        .join(format!("{source_name}-{}.json", &digest[..16]));
    let record = serde_json::json!({
        "schemaVersion": 1,
        "sourcePath": path.to_string_lossy(),
        "reason": reason,
        "raw": raw,
    });
    write_json_atomically(&quarantine_path, &record)?;
    remove_recovery_snapshot_file(path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn recovery_snapshot_path(
    diagnostics_dir: &Path,
    file_path: Option<&str>,
    document_id: Option<&str>,
) -> PathBuf {
    diagnostics_dir.join(RECOVERY_SNAPSHOT_DIR).join(format!(
        "{}.json",
        recovery_snapshot_key(file_path, document_id)
    ))
}

fn legacy_recovery_snapshot_path(diagnostics_dir: &Path, file_path: Option<&str>) -> PathBuf {
    diagnostics_dir
        .join(RECOVERY_SNAPSHOT_DIR)
        .join(format!("{}.json", legacy_recovery_snapshot_key(file_path)))
}

fn recovery_snapshot_key(file_path: Option<&str>, document_id: Option<&str>) -> String {
    if let Some(document_id) = document_id {
        return format!("document-{}", blake3::hash(document_id.as_bytes()).to_hex());
    }
    let normalized = file_path
        .map(canonical_comparison_key)
        .unwrap_or_else(|| "untitled".to_string());
    let prefix = if file_path.is_some() {
        "file"
    } else {
        "untitled"
    };
    format!("{prefix}-{}", blake3::hash(normalized.as_bytes()).to_hex())
}

fn legacy_recovery_snapshot_key(file_path: Option<&str>) -> String {
    let normalized = file_path
        .map(legacy_normalize_recovery_path)
        .unwrap_or_else(|| "untitled".to_string());
    let prefix = if file_path.is_some() {
        "file"
    } else {
        "untitled"
    };
    format!("{prefix}-{}", blake3::hash(normalized.as_bytes()).to_hex())
}

fn legacy_normalize_recovery_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    if normalized.len() >= 3 && normalized.as_bytes()[1] == b':' && normalized.as_bytes()[2] == b'/'
    {
        return normalized.to_lowercase();
    }
    if normalized.starts_with("//") {
        return normalized.to_lowercase();
    }
    normalized
}

fn recovery_snapshot_matches(snapshot: &RecoverySnapshot, file_path: Option<&str>) -> bool {
    match (snapshot.file_path.as_deref(), file_path) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            canonical_comparison_key(left) == canonical_comparison_key(right)
        }
        _ => false,
    }
}

fn prune_recovery_snapshots(
    diagnostics_dir: &Path,
    keep_path: &Path,
    protected_document_ids: &HashSet<String>,
) -> Result<usize, String> {
    let dir = diagnostics_dir.join(RECOVERY_SNAPSHOT_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut removed = cleanup_abandoned_recovery_temp_files(&dir);
    let mut retained_count = usize::from(keep_path.exists());
    let mut retained_bytes = if keep_path.exists() {
        fs::metadata(keep_path).map(|metadata| metadata.len()).unwrap_or(0)
    } else {
        0
    };
    let mut snapshots = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path == keep_path
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                return None;
            }
            read_recovery_snapshot_file(&path)
                .ok()
                .flatten()
                .map(|snapshot| {
                    let is_protected = snapshot.document_id.as_ref()
                        .is_some_and(|document_id| protected_document_ids.contains(document_id));
                    let bytes = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
                    (path, snapshot.updated_at_ms, is_protected, bytes)
                })
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    for (path, _, is_protected, bytes) in snapshots {
        let within_count = retained_count < MAX_RECOVERY_SNAPSHOT_COUNT;
        let within_bytes = retained_bytes.saturating_add(bytes) <= MAX_RECOVERY_SNAPSHOT_TOTAL_BYTES;
        if is_protected || (within_count && within_bytes) {
            retained_count += 1;
            retained_bytes = retained_bytes.saturating_add(bytes);
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
        if fs::remove_file(previous_recovery_snapshot_path(&path)).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn cleanup_abandoned_recovery_temp_files(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with('.') && name.ends_with(".tmp")
        })
        .filter(|entry| fs::remove_file(entry.path()).is_ok())
        .count()
}

fn diagnostics_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("SCIEMD_APP_DATA_DIR_OVERRIDE") {
        return Ok(PathBuf::from(root).join(DIAGNOSTICS_DIR));
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data dir: {error}"))?;
    Ok(base.join(DIAGNOSTICS_DIR))
}

fn read_heartbeat(path: &Path) -> Result<Option<StoredHeartbeat>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read renderer heartbeat: {error}"))?;
    let heartbeat = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse renderer heartbeat: {error}"))?;
    Ok(Some(heartbeat))
}

fn export_diagnostics_bundle_to_dir(dir: &Path) -> Result<DiagnosticsBundleMetadata, String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create diagnostics dir: {error}"))?;
    let created_at_ms = timestamp_ms();
    let heartbeat_path = dir.join(HEARTBEAT_FILE);
    let log_path = dir.join(DIAGNOSTICS_LOG_FILE);
    let recovery_path = dir.join(RECOVERY_SNAPSHOT_FILE);
    let heartbeat = read_heartbeat(&heartbeat_path).ok().flatten();
    let diagnostics_log = read_diagnostics_log_bundle(&log_path)?;
    let recovery_snapshot = read_recovery_snapshot_bundle(&recovery_path)?;
    let metadata = DiagnosticsBundleMetadata {
        path: dir
            .join(format!("{DIAGNOSTICS_BUNDLE_PREFIX}-{created_at_ms}.json"))
            .to_string_lossy()
            .to_string(),
        diagnostics_dir: dir.to_string_lossy().to_string(),
        created_at_ms,
        event_count: diagnostics_log.tail_event_count,
        log_bytes: diagnostics_log.bytes,
        recovery_snapshot_bytes: recovery_snapshot
            .as_ref()
            .map(|snapshot| snapshot.markdown_bytes),
        heartbeat_seen_at_ms: heartbeat.as_ref().map(|value| value.seen_at_ms),
    };
    let bundle = DiagnosticsBundle {
        created_at_ms,
        app_version: env!("CARGO_PKG_VERSION"),
        diagnostics_dir: metadata.diagnostics_dir.clone(),
        heartbeat,
        diagnostics_log,
        recovery_snapshot,
    };
    write_json_atomically(Path::new(&metadata.path), &bundle)?;
    Ok(metadata)
}

fn read_diagnostics_log_bundle(path: &Path) -> Result<DiagnosticsLogBundle, String> {
    let (tail, bytes, tail_truncated) = read_text_tail(path, MAX_BUNDLE_LOG_TAIL_BYTES)?;
    let tail_event_count = tail
        .lines()
        .filter(|line| line.trim_start().starts_with('{'))
        .count() as u64;
    Ok(DiagnosticsLogBundle {
        path: path.to_string_lossy().to_string(),
        bytes,
        tail,
        tail_event_count,
        tail_truncated,
    })
}

fn read_recovery_snapshot_bundle(path: &Path) -> Result<Option<RecoverySnapshotBundle>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read recovery snapshot metadata: {error}"))?;
    let snapshot: RecoverySnapshot = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse recovery snapshot metadata: {error}"))?;
    Ok(Some(RecoverySnapshotBundle {
        path: path.to_string_lossy().to_string(),
        schema_version: snapshot.schema_version,
        generation: snapshot.generation,
        file_path: snapshot.file_path,
        format: snapshot.format,
        updated_at_ms: snapshot.updated_at_ms,
        markdown_bytes: snapshot.markdown_bytes,
        markdown_omitted_reason: "Raw document text is stored in the recovery snapshot file and omitted from diagnostics bundles to keep bundles small.",
    }))
}

fn default_recovery_schema_version() -> u16 {
    1
}

fn default_recovery_generation() -> u64 {
    1
}

fn default_recovery_commit_state() -> String {
    "committed".into()
}

fn read_text_tail(path: &Path, max_bytes: usize) -> Result<(String, u64, bool), String> {
    if !path.exists() {
        return Ok(("".into(), 0, false));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read diagnostics log: {error}"))?;
    let total_bytes = bytes.len() as u64;
    if bytes.len() <= max_bytes {
        return Ok((
            String::from_utf8_lossy(&bytes).to_string(),
            total_bytes,
            false,
        ));
    }
    let start = bytes.len().saturating_sub(max_bytes);
    let mut tail = String::from_utf8_lossy(&bytes[start..]).to_string();
    if let Some(next_line_index) = tail.find('\n') {
        tail = tail[next_line_index + 1..].to_string();
    }
    Ok((tail, total_bytes, true))
}

fn append_diagnostics_event_to_dir(
    dir: &Path,
    payload: &DiagnosticsEventPayload,
) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create diagnostics dir: {error}"))?;
    let path = dir.join(DIAGNOSTICS_LOG_FILE);
    rotate_if_too_large(&path)?;
    let event = StoredDiagnosticsEvent {
        timestamp_ms: timestamp_ms(),
        event: payload,
    };
    let mut line = serde_json::to_string(&event)
        .map_err(|error| format!("Could not serialize diagnostics event: {error}"))?;
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Could not open diagnostics log: {error}"))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Could not append diagnostics event: {error}"))
}

fn rotate_if_too_large(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < MAX_DIAGNOSTICS_LOG_BYTES {
        return Ok(());
    }
    let rotated = path.with_extension("jsonl.old");
    let _ = fs::remove_file(&rotated);
    fs::rename(path, rotated).map_err(|error| format!("Could not rotate diagnostics log: {error}"))
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Diagnostics path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create diagnostics dir: {error}"))?;
    let temp_path = temp_path_for(path);
    let mut temp = fs::File::create(&temp_path)
        .map_err(|error| format!("Could not create temporary diagnostics file: {error}"))?;
    serde_json::to_writer(&mut temp, value)
        .map_err(|error| format!("Could not serialize diagnostics file: {error}"))?;
    temp.write_all(b"\n")
        .and_then(|_| temp.sync_all())
        .map_err(|error| format!("Could not flush diagnostics file: {error}"))?;
    drop(temp);
    match atomic_replace(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("diagnostics");
    path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        timestamp_ms()
    ))
}

#[cfg(windows)]
fn atomic_replace(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };

    let temp: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut result = if target_path.exists() {
        unsafe {
            ReplaceFileW(
                target.as_ptr(),
                temp.as_ptr(),
                null(),
                REPLACEFILE_WRITE_THROUGH,
                null(),
                null(),
            )
        }
    } else {
        unsafe {
            MoveFileExW(
                temp.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 && target_path.exists() {
        // Some Windows filesystem providers reject ReplaceFileW with
        // ERROR_UNABLE_TO_REMOVE_REPLACED (1175) even after all handles are
        // closed. MoveFileExW still provides same-volume atomic replacement
        // and write-through durability for this case.
        result = unsafe {
            MoveFileExW(
                temp.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
    }
    if result == 0 {
        Err(format!(
            "Could not replace diagnostics file atomically: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    match fs::rename(temp_path, target_path) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
            copy_sync_and_rename(temp_path, target_path)
        }
        Err(error) => Err(format!(
            "Could not replace diagnostics file atomically: {error}"
        )),
    }
}

#[cfg(not(windows))]
fn copy_sync_and_rename(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    let copy_path = temp_path_for(target_path);
    let mut source = fs::File::open(temp_path)
        .map_err(|error| format!("Could not reopen temporary diagnostics file: {error}"))?;
    let mut copy = fs::File::create(&copy_path)
        .map_err(|error| format!("Could not create same-volume diagnostics file: {error}"))?;
    let mut buffer = Vec::new();
    source
        .read_to_end(&mut buffer)
        .and_then(|_| copy.write_all(&buffer))
        .and_then(|_| copy.sync_all())
        .map_err(|error| format!("Could not copy diagnostics file onto target volume: {error}"))?;
    drop(copy);
    fs::rename(&copy_path, target_path)
        .map_err(|error| format!("Could not install same-volume diagnostics file: {error}"))?;
    let _ = fs::remove_file(temp_path);
    Ok(())
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::{
        append_diagnostics_event_to_dir, export_diagnostics_bundle_to_dir,
        legacy_recovery_snapshot_key, list_recovery_snapshots_in_dir, normalize_recovery_snapshot,
        previous_recovery_snapshot_path, prune_recovery_snapshots, read_heartbeat,
        read_recovery_snapshot_with_fallback, recovery_snapshot_checksum, recovery_snapshot_key,
        recovery_snapshot_matches, recovery_snapshot_path, remove_recovery_snapshot_file,
        write_json_atomically, DiagnosticsEventPayload, RecoverySnapshot, RendererHeartbeatPayload,
        StoredHeartbeat, MAX_RECOVERY_SNAPSHOT_COUNT,
    };
    use serde::Deserialize;
    use std::{
        collections::HashSet,
        fs,
        path::{Path, PathBuf},
    };

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistenceFixture {
        fixture_version: u8,
        catalog_cases: Vec<CatalogFixture>,
        native_invalid_cases: Vec<NativeInvalidFixture>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CatalogFixture {
        document_id: String,
        source_revision: u64,
        source_text: String,
        file_path: Option<String>,
        format: String,
        media_type: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeInvalidFixture {
        name: String,
        expected_reason: String,
        snapshot: RecoverySnapshot,
    }

    #[test]
    fn diagnostics_atomic_json_round_trips() {
        let dir = test_dir("atomic-json");
        let path = dir.join("heartbeat.json");
        let mut payload = StoredHeartbeat {
            session_id: "session-a".into(),
            seen_at_ms: 1234,
            clean_shutdown: false,
            payload: heartbeat_payload("session-a"),
        };

        write_json_atomically(&path, &payload).unwrap();
        payload.clean_shutdown = true;
        payload.seen_at_ms = 5678;
        write_json_atomically(&path, &payload).unwrap();
        let restored = read_heartbeat(&path).unwrap().unwrap();

        assert_eq!(restored.session_id, "session-a");
        assert_eq!(restored.payload.markdown_bytes, 42);
        assert!(restored.clean_shutdown);
        assert_eq!(restored.seen_at_ms, 5678);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_recovery_migration_is_sequential_and_idempotent() {
        for schema_version in [1, 2] {
            let legacy = RecoverySnapshot {
                schema_version,
                generation: 1,
                checksum: String::new(),
                commit_state: "committed".into(),
                document_id: None,
                source_revision: None,
                catalog_schema_version: None,
                media_type: None,
                markdown: "".into(),
                file_path: None,
                format: Some("plainText".into()),
                updated_at_ms: 1000,
                markdown_bytes: 0,
            };

            let migrated = normalize_recovery_snapshot(legacy).unwrap();
            let repeated = normalize_recovery_snapshot(migrated.clone()).unwrap();

            assert_eq!(
                migrated.schema_version,
                super::CURRENT_RECOVERY_SCHEMA_VERSION
            );
            assert_eq!(migrated.checksum, repeated.checksum);
            assert_eq!(migrated.markdown, "");
        }
    }

    #[test]
    fn future_and_interrupted_native_fixtures_fail_closed() {
        let fixture: PersistenceFixture = serde_json::from_str(include_str!(
            "../../../src/services/persistence/fixtures/recoveryPersistence.v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.fixture_version, 1);
        for case in fixture.native_invalid_cases {
            let error = normalize_recovery_snapshot(case.snapshot).unwrap_err();
            assert!(
                error.to_lowercase().contains(&case.expected_reason),
                "fixture {} produced unexpected error: {}",
                case.name,
                error
            );
        }
    }

    #[test]
    fn future_and_interrupted_native_files_are_preserved_in_quarantine() {
        let fixture: PersistenceFixture = serde_json::from_str(include_str!(
            "../../../src/services/persistence/fixtures/recoveryPersistence.v1.json"
        ))
        .unwrap();
        let dir = test_dir("recovery-invalid-quarantine");
        for case in fixture.native_invalid_cases {
            let path = dir
                .join(super::RECOVERY_SNAPSHOT_DIR)
                .join(format!("{}.json", case.name));
            write_json_atomically(&path, &case.snapshot).unwrap();
            assert!(read_recovery_snapshot_with_fallback(&dir, &path)
                .unwrap()
                .is_none());
            assert!(!path.exists());
        }
        let quarantine = fs::read_dir(dir.join(super::RECOVERY_QUARANTINE_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert_eq!(quarantine.len(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_current_generation_is_quarantined_and_previous_generation_restores() {
        let dir = test_dir("recovery-fallback");
        let path = dir
            .join(super::RECOVERY_SNAPSHOT_DIR)
            .join("untitled-test.json");
        let previous_path = previous_recovery_snapshot_path(&path);
        let previous = current_snapshot("last valid", 1);
        write_json_atomically(&previous_path, &previous).unwrap();
        write_json_atomically(
            &path,
            &serde_json::json!({ "schemaVersion": 3, "checksum": "bad" }),
        )
        .unwrap();

        let restored = read_recovery_snapshot_with_fallback(&dir, &path)
            .unwrap()
            .unwrap();

        assert_eq!(restored.markdown, "last valid");
        assert!(!path.exists());
        let quarantine = fs::read_dir(dir.join(super::RECOVERY_QUARANTINE_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert_eq!(quarantine.len(), 1);
        let preserved = fs::read_to_string(quarantine[0].path()).unwrap();
        assert!(preserved.contains("checksum"));
        assert!(preserved.contains("bad"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_tombstone_removal_is_idempotent() {
        let dir = test_dir("recovery-tombstone");
        let path = dir.join("entry.json");
        let previous_path = previous_recovery_snapshot_path(&path);
        fs::write(&path, "payload").unwrap();
        fs::write(&previous_path, "previous").unwrap();

        remove_recovery_snapshot_file(&path).unwrap();
        remove_recovery_snapshot_file(&path).unwrap();
        remove_recovery_snapshot_file(&previous_path).unwrap();
        remove_recovery_snapshot_file(&previous_path).unwrap();

        assert!(!path.exists());
        assert!(!previous_path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(windows)]
    fn recovery_identity_converges_windows_verbatim_aliases_and_retains_legacy_key() {
        let ordinary = Some(r"C:\Lab\Paper.md");
        let verbatim = Some(r"\\?\c:\lab\PAPER.md");
        assert_eq!(
            recovery_snapshot_key(ordinary, None),
            recovery_snapshot_key(verbatim, None)
        );
        assert_ne!(
            recovery_snapshot_key(verbatim, None),
            legacy_recovery_snapshot_key(verbatim)
        );
        assert!(recovery_snapshot_matches(
            &RecoverySnapshot {
                schema_version: 2,
                generation: 1,
                checksum: String::new(),
                commit_state: "committed".into(),
                document_id: None,
                source_revision: None,
                catalog_schema_version: None,
                media_type: None,
                markdown: "draft".into(),
                file_path: ordinary.map(str::to_string),
                format: Some("markdown".into()),
                updated_at_ms: 1,
                markdown_bytes: 5,
            },
            verbatim,
        ));
    }

    #[test]
    fn diagnostics_log_rotates_when_large() {
        let dir = test_dir("log-rotate");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diagnostics.jsonl");
        fs::write(
            &path,
            "x".repeat(super::MAX_DIAGNOSTICS_LOG_BYTES as usize + 1),
        )
        .unwrap();

        append_diagnostics_event_to_dir(
            &dir,
            &DiagnosticsEventPayload {
                event_type: "test".into(),
                message: "message".into(),
                document_path: None,
                mode: None,
                markdown_bytes: None,
                component_stack: None,
            },
        )
        .unwrap();

        assert!(path.exists());
        assert!(dir.join("diagnostics.jsonl.old").exists());
        assert!(fs::metadata(path).unwrap().len() < 1024);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn diagnostics_bundle_contains_events_and_recovery_metadata_without_raw_markdown() {
        let dir = test_dir("bundle");
        let heartbeat = StoredHeartbeat {
            session_id: "session-bundle".into(),
            seen_at_ms: 2345,
            clean_shutdown: false,
            payload: heartbeat_payload("session-bundle"),
        };
        write_json_atomically(&dir.join(super::HEARTBEAT_FILE), &heartbeat).unwrap();
        append_diagnostics_event_to_dir(
            &dir,
            &DiagnosticsEventPayload {
                event_type: "save-failed".into(),
                message: "Disk write failed.".into(),
                document_path: Some("C:/lab/paper.md".into()),
                mode: Some("visual".into()),
                markdown_bytes: Some(4096),
                component_stack: None,
            },
        )
        .unwrap();
        write_json_atomically(
            &dir.join(super::RECOVERY_SNAPSHOT_FILE),
            &RecoverySnapshot {
                schema_version: 2,
                generation: 1,
                checksum: String::new(),
                commit_state: "committed".into(),
                document_id: None,
                source_revision: None,
                catalog_schema_version: None,
                media_type: None,
                markdown: "# private draft".into(),
                file_path: Some("C:/lab/paper.md".into()),
                format: Some("markdown".into()),
                updated_at_ms: 3456,
                markdown_bytes: 15,
            },
        )
        .unwrap();

        let metadata = export_diagnostics_bundle_to_dir(&dir).unwrap();
        let bundle = fs::read_to_string(&metadata.path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&bundle).unwrap();

        assert_eq!(metadata.event_count, 1);
        assert_eq!(metadata.recovery_snapshot_bytes, Some(15));
        assert_eq!(parsed["heartbeat"]["sessionId"], "session-bundle");
        assert!(parsed["diagnosticsLog"]["tail"]
            .as_str()
            .unwrap()
            .contains("save-failed"));
        assert_eq!(parsed["recoverySnapshot"]["markdownBytes"], 15);
        assert_eq!(parsed["recoverySnapshot"]["schemaVersion"], 2);
        assert_eq!(parsed["recoverySnapshot"]["format"], "markdown");
        assert!(!bundle.contains("# private draft"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_catalog_keeps_multiple_untitled_documents_and_format_metadata() {
        let dir = test_dir("multi-document-catalog");
        fs::create_dir_all(dir.join(super::RECOVERY_SNAPSHOT_DIR)).unwrap();
        let fixture: PersistenceFixture = serde_json::from_str(include_str!(
            "../../../src/services/persistence/fixtures/recoveryPersistence.v1.json"
        ))
        .unwrap();
        for case in &fixture.catalog_cases {
            let mut snapshot = current_snapshot(&case.source_text, 1);
            snapshot.document_id = Some(case.document_id.clone());
            snapshot.source_revision = Some(case.source_revision);
            snapshot.catalog_schema_version = Some(1);
            snapshot.file_path = case.file_path.clone();
            snapshot.format = Some(case.format.clone());
            snapshot.media_type = Some(case.media_type.clone());
            snapshot.checksum = recovery_snapshot_checksum(&snapshot);
            let path = recovery_snapshot_path(&dir, None, Some(&case.document_id));
            write_json_atomically(&path, &snapshot).unwrap();
        }

        let snapshots = list_recovery_snapshots_in_dir(&dir).unwrap();
        assert_eq!(snapshots.len(), fixture.catalog_cases.len());
        assert!(snapshots
            .iter()
            .any(
                |snapshot| snapshot.document_id.as_deref() == Some("fixture-empty")
                    && snapshot.markdown.is_empty()
                    && snapshot.format.as_deref() == Some("plainText")
                    && snapshot.media_type.as_deref() == Some("text/plain")
            ));
        assert_ne!(
            recovery_snapshot_key(None, Some("fixture-json")),
            recovery_snapshot_key(None, Some("fixture-empty"))
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn quota_pruning_bounds_catalog_and_legacy_snapshots_without_removing_protected_documents() {
        let dir = test_dir("catalog-pruning-fence");
        let recovery_dir = dir.join(super::RECOVERY_SNAPSHOT_DIR);
        fs::create_dir_all(&recovery_dir).unwrap();
        let mut catalog_snapshot = current_snapshot("only dirty representation", 1);
        catalog_snapshot.document_id = Some("current-dirty-document".into());
        catalog_snapshot.source_revision = Some(3);
        catalog_snapshot.catalog_schema_version = Some(1);
        catalog_snapshot.media_type = Some("text/plain".into());
        catalog_snapshot.checksum = recovery_snapshot_checksum(&catalog_snapshot);
        let catalog_path = recovery_snapshot_path(&dir, None, Some("current-dirty-document"));
        write_json_atomically(&catalog_path, &catalog_snapshot).unwrap();

        let mut keep_path = PathBuf::new();
        for index in 0..(MAX_RECOVERY_SNAPSHOT_COUNT + 5) {
            let mut legacy = current_snapshot(&format!("legacy-{index}"), index as u64 + 2);
            legacy.updated_at_ms = index as u128;
            legacy.checksum = recovery_snapshot_checksum(&legacy);
            let path = recovery_dir.join(format!("legacy-{index}.json"));
            write_json_atomically(&path, &legacy).unwrap();
            if index == MAX_RECOVERY_SNAPSHOT_COUNT + 4 {
                keep_path = path;
            }
        }

        let protected = HashSet::from(["current-dirty-document".to_string()]);
        let abandoned_temp = recovery_dir.join(".document-orphan.json.123.tmp");
        fs::write(&abandoned_temp, "interrupted").unwrap();
        prune_recovery_snapshots(&dir, &keep_path, &protected).unwrap();

        assert!(catalog_path.exists());
        assert!(!abandoned_temp.exists());
        assert!(fs::read_dir(&recovery_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
            .count() <= MAX_RECOVERY_SNAPSHOT_COUNT);
        assert_eq!(
            list_recovery_snapshots_in_dir(&dir).unwrap()[0]
                .document_id
                .as_deref(),
            Some("current-dirty-document")
        );
        let _ = fs::remove_dir_all(dir);
    }

    fn heartbeat_payload(session_id: &str) -> RendererHeartbeatPayload {
        RendererHeartbeatPayload {
            session_id: session_id.into(),
            document_path: Some("C:/lab/paper.md".into()),
            mode: Some("visual".into()),
            markdown_bytes: 42,
            line_count: 3,
            image_count: 1,
            math_count: 2,
            visual_atom_count: 0,
            warning_count: 0,
            error_count: 0,
            active_background_job_count: 1,
            stuck_background_job_count: 0,
            oldest_background_job_ms: Some(250),
            background_job_labels: vec!["Document parser".into()],
            stuck_background_job_labels: vec![],
        }
    }

    fn current_snapshot(markdown: &str, generation: u64) -> RecoverySnapshot {
        let mut snapshot = RecoverySnapshot {
            schema_version: super::CURRENT_RECOVERY_SCHEMA_VERSION,
            generation,
            checksum: String::new(),
            commit_state: "committed".into(),
            document_id: None,
            source_revision: None,
            catalog_schema_version: None,
            media_type: None,
            markdown: markdown.into(),
            file_path: None,
            format: Some("markdown".into()),
            updated_at_ms: 1000,
            markdown_bytes: markdown.len(),
        };
        snapshot.checksum = recovery_snapshot_checksum(&snapshot);
        snapshot
    }

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("scie-md-diagnostics-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[allow(dead_code)]
    fn assert_path_exists(path: &Path) {
        assert!(path.exists(), "expected path to exist: {}", path.display());
    }
}
