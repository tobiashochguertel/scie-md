use base64::{engine::general_purpose::STANDARD, Engine as _};
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

#[cfg(windows)]
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO, FILE_SHARE_READ,
};

use super::host_error::{HostError, HostErrorCode, HostResult};
use super::path_grants::{
    assert_directory_read_allowed, assert_file_read_allowed, assert_file_write_allowed,
    clear_document_image_grants_for_document, grant_file, grant_file_and_parent,
    sync_document_image_grants_for_markdown,
};

mod text_encoding;

use text_encoding::{
    content_hash, decode_text_bytes, decode_text_bytes_lossy, detect_line_endings,
    metadata_mtime_ms, normalize_to_lf, readable_file_kind, source_text_to_bytes,
    unix_timestamp_for_file_name,
};

static LAST_TEMP_CLEANUP_AT: OnceLock<Mutex<Option<SystemTime>>> = OnceLock::new();
static ACTIVE_TEXT_READS: OnceLock<Mutex<HashMap<String, Arc<ReadCancellation>>>> = OnceLock::new();
const MAX_BINARY_IPC_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TEXT_IPC_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TEXT_HASH_BYTES: u64 = 25 * 1024 * 1024;
const TEXT_READ_CHUNK_BYTES: usize = 256 * 1024;
const TEXT_READ_IPC_CHUNK_BYTES: usize = 2 * 1024 * 1024;
const COHERENT_READ_ATTEMPTS: u8 = 3;
const COHERENT_READ_RETRY_DELAY: Duration = Duration::from_millis(15);
const NATIVE_CANCEL_WAIT_BOUND: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub line_ending: String,
    pub encoding: String,
    pub has_bom: bool,
    pub has_mixed_line_endings: bool,
    pub line_endings: String,
    pub decode_lossy: bool,
    pub lossless_write: String,
    pub loss_reasons: Vec<String>,
    pub original_byte_hash: Option<String>,
    pub last_known_mtime_ms: u64,
    pub last_known_size_bytes: u64,
    pub content_hash: Option<String>,
    pub cloud_state: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileResponse {
    pub contract_version: u16,
    pub source_text: String,
    pub metadata: FileMetadata,
    pub native_timings: NativeDocumentReadTimings,
    pub snapshot: NativeDocumentSnapshotEvidence,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum NativeTextReadEvent {
    #[serde(rename = "sourceChunk")]
    SourceChunk {
        sequence: u32,
        #[serde(rename = "sourceChunk")]
        source_chunk: String,
    },
    #[serde(rename = "complete")]
    Complete {
        #[serde(rename = "contractVersion")]
        contract_version: u16,
        #[serde(rename = "chunkCount")]
        chunk_count: u32,
        metadata: Box<FileMetadata>,
        #[serde(rename = "nativeTimings")]
        native_timings: NativeDocumentReadTimings,
        snapshot: NativeDocumentSnapshotEvidence,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDocumentSnapshotEvidence {
    pub method: &'static str,
    pub attempts: u8,
    pub identity_verified: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReadCancellationResponse {
    pub accepted: bool,
    pub stopped: bool,
    pub stop_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDocumentReadTimings {
    pub clock: &'static str,
    pub permission_cloud_grant_ms: f64,
    pub stat_ms: f64,
    pub read_ms: f64,
    pub decode_fidelity_ms: f64,
    pub hash_ms: f64,
    pub image_grant_discovery_ms: f64,
    pub total_ms: f64,
    pub byte_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSiblingArtifactResponse {
    pub path: String,
    pub metadata: FileMetadata,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFilePreviewResponse {
    pub content: String,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExplorerEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[tauri::command]
pub async fn read_text_file(
    path: String,
    operation_id: String,
    on_event: Channel<NativeTextReadEvent>,
) -> HostResult<()> {
    run_text_read(path, operation_id, false, on_event).await
}

#[tauri::command]
pub async fn read_text_file_for_edit(
    path: String,
    operation_id: String,
    on_event: Channel<NativeTextReadEvent>,
) -> HostResult<()> {
    run_text_read(path, operation_id, true, on_event).await
}

#[tauri::command]
pub async fn cancel_text_file_read(operation_id: String) -> NativeReadCancellationResponse {
    let state = active_text_reads().lock().get(&operation_id).cloned();
    let Some(state) = state else {
        return NativeReadCancellationResponse {
            accepted: false,
            stopped: true,
            stop_ms: 0.0,
        };
    };
    let started = Instant::now();
    state.cancelled.store(true, Ordering::Release);
    let waiter = state.clone();
    let stopped = tauri::async_runtime::spawn_blocking(move || {
        waiter.wait_until_finished(NATIVE_CANCEL_WAIT_BOUND)
    })
    .await
    .unwrap_or(false);
    NativeReadCancellationResponse {
        accepted: true,
        stopped,
        stop_ms: elapsed_ms(started),
    }
}

async fn run_text_read(
    path: String,
    operation_id: String,
    grant_for_edit: bool,
    on_event: Channel<NativeTextReadEvent>,
) -> HostResult<()> {
    let cancellation = Arc::new(ReadCancellation::default());
    {
        let mut active = active_text_reads().lock();
        if active.contains_key(&operation_id) {
            return Err(HostError::from(
                "Document read operation ID is already active.".to_string(),
            ));
        }
        active.insert(operation_id.clone(), cancellation.clone());
    }
    let worker_cancellation = cancellation.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let response =
            read_text_file_blocking(PathBuf::from(path), grant_for_edit, &worker_cancellation)?;
        stream_text_read_response(response, &worker_cancellation, &on_event)
    })
    .await;
    cancellation.mark_finished();
    active_text_reads().lock().remove(&operation_id);
    let result = worker
        .map_err(|error| HostError::from(format!("Native document read worker failed: {error}")))?;
    result.map_err(native_read_host_error)
}

fn stream_text_read_response(
    response: ReadTextFileResponse,
    cancellation: &ReadCancellation,
    on_event: &Channel<NativeTextReadEvent>,
) -> Result<(), String> {
    let ReadTextFileResponse {
        contract_version,
        source_text,
        metadata,
        native_timings,
        snapshot,
    } = response;
    let chunks = text_ipc_chunks(&source_text);
    let chunk_count = u32::try_from(chunks.len())
        .map_err(|_| "Document read transport produced too many chunks.".to_string())?;
    for (sequence, source_chunk) in chunks.into_iter().enumerate() {
        cancellation.checkpoint("transport")?;
        on_event
            .send(NativeTextReadEvent::SourceChunk {
                sequence: sequence as u32,
                source_chunk: source_chunk.to_string(),
            })
            .map_err(|error| format!("Document read transport failed: {error}"))?;
    }
    cancellation.checkpoint("transport")?;
    on_event
        .send(NativeTextReadEvent::Complete {
            contract_version,
            chunk_count,
            metadata: Box::new(metadata),
            native_timings,
            snapshot,
        })
        .map_err(|error| format!("Document read transport failed: {error}"))?;
    Ok(())
}

fn text_ipc_chunks(source_text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < source_text.len() {
        let mut end = (start + TEXT_READ_IPC_CHUNK_BYTES).min(source_text.len());
        while end > start && !source_text.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&source_text[start..end]);
        start = end;
    }
    chunks
}

pub(crate) fn read_text_file_for_edit_blocking(path: String) -> HostResult<ReadTextFileResponse> {
    read_text_file_blocking(PathBuf::from(path), true, &ReadCancellation::default())
        .map_err(native_read_host_error)
}

#[cfg(test)]
fn read_text_file_blocking_for_test(path: String) -> HostResult<ReadTextFileResponse> {
    read_text_file_blocking(PathBuf::from(path), false, &ReadCancellation::default())
        .map_err(native_read_host_error)
}

fn native_read_host_error(message: String) -> HostError {
    let normalized = message.to_ascii_lowercase();
    let phase = if normalized.contains("preflight")
        || normalized.contains("grant")
        || normalized.contains("cloud")
    {
        "preflight"
    } else if normalized.contains("snapshot")
        || normalized.contains("metadata")
        || normalized.contains("identity")
        || normalized.contains("write-excluding")
    {
        "coherent-snapshot"
    } else if normalized.contains("decode") || normalized.contains("encoding") {
        "decode"
    } else if normalized.contains("fidelity") || normalized.contains("line ending") {
        "fidelity"
    } else if normalized.contains("transport") {
        "transport"
    } else if normalized.contains("image") {
        "image-grants"
    } else if normalized.contains("hash") {
        "hash"
    } else {
        "read"
    };
    HostError::from(message).with_phase(phase)
}

fn read_text_file_blocking(
    path: PathBuf,
    grant_for_edit: bool,
    cancellation: &ReadCancellation,
) -> Result<ReadTextFileResponse, String> {
    let total_started = Instant::now();
    let preflight_started = Instant::now();
    cancellation.checkpoint("preflight")?;
    assert_file_read_allowed(&path)
        .map_err(|error| format!("Document read preflight failed: {error}"))?;
    ensure_cloud_file_available(&path)
        .map_err(|error| format!("Document read preflight failed: {}", error.message))?;
    if grant_for_edit {
        grant_file(&path).map_err(|error| format!("Document read grant failed: {error}"))?;
    }
    cancellation.checkpoint("preflight")?;
    read_text_file_checked(
        &path,
        elapsed_ms(preflight_started),
        total_started,
        cancellation,
    )
}

fn read_text_file_checked(
    path: &Path,
    permission_cloud_grant_ms: f64,
    total_started: Instant,
    cancellation: &ReadCancellation,
) -> Result<ReadTextFileResponse, String> {
    cancellation.checkpoint("stat")?;
    let coherent = read_coherent_snapshot(path, cancellation)?;
    let file_metadata = coherent.metadata;
    let stat_ms = coherent.stat_ms;
    let bytes = coherent.bytes;
    let read_ms = coherent.read_ms;
    let decode_started = Instant::now();
    cancellation.scan_checkpoints("decode", bytes.len())?;
    let decoded = decode_text_bytes(&bytes)?;
    cancellation.checkpoint("decode")?;
    let line_endings = detect_line_endings(&decoded.raw);
    cancellation.checkpoint("fidelity")?;
    let content = normalize_to_lf(&decoded.raw);
    cancellation.checkpoint("fidelity")?;
    let decode_fidelity_ms = elapsed_ms(decode_started);
    let image_grant_started = Instant::now();
    sync_markdown_image_grants_if_markdown(path, &content)?;
    cancellation.checkpoint("image-grants")?;
    let image_grant_discovery_ms = elapsed_ms(image_grant_started);
    let hash_started = Instant::now();
    cancellation.scan_checkpoints("hash", bytes.len())?;
    let byte_hash = content_hash(&bytes);
    cancellation.checkpoint("hash")?;
    let hash_ms = elapsed_ms(hash_started);
    let metadata = metadata_from_file_metadata(
        path,
        &file_metadata,
        TextFidelityMetadata {
            line_ending: line_endings.line_ending,
            encoding: decoded.encoding,
            has_bom: decoded.has_bom,
            has_mixed_line_endings: line_endings.has_mixed_line_endings,
            decode_lossy: decoded.decode_lossy,
            fidelity_known: true,
        },
        Some(byte_hash),
    );

    let native_timings = NativeDocumentReadTimings {
        clock: "native-monotonic-duration",
        permission_cloud_grant_ms,
        stat_ms,
        read_ms,
        decode_fidelity_ms,
        hash_ms,
        image_grant_discovery_ms,
        total_ms: elapsed_ms(total_started),
        byte_count: bytes.len() as u64,
    };

    Ok(ReadTextFileResponse {
        contract_version: 2,
        source_text: content,
        metadata,
        native_timings,
        snapshot: NativeDocumentSnapshotEvidence {
            method: coherent.method,
            attempts: coherent.attempts,
            identity_verified: true,
        },
    })
}

#[derive(Default)]
struct ReadCancellation {
    cancelled: AtomicBool,
    finished: Mutex<bool>,
    finished_changed: Condvar,
    #[cfg(test)]
    chunk_delay: Duration,
}

impl ReadCancellation {
    fn checkpoint(&self, phase: &str) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(format!("Document read cancelled during {phase}."));
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_chunk_delay(chunk_delay: Duration) -> Self {
        Self {
            chunk_delay,
            ..Self::default()
        }
    }

    fn scan_checkpoints(&self, phase: &str, byte_count: usize) -> Result<(), String> {
        for _ in (0..byte_count).step_by(TEXT_READ_CHUNK_BYTES) {
            self.checkpoint(phase)?;
            #[cfg(test)]
            if !self.chunk_delay.is_zero() {
                std::thread::sleep(self.chunk_delay);
            }
        }
        Ok(())
    }

    fn mark_finished(&self) {
        *self.finished.lock() = true;
        self.finished_changed.notify_all();
    }

    fn wait_until_finished(&self, timeout: Duration) -> bool {
        let mut finished = self.finished.lock();
        if !*finished {
            self.finished_changed.wait_for(&mut finished, timeout);
        }
        *finished
    }
}

fn active_text_reads() -> &'static Mutex<HashMap<String, Arc<ReadCancellation>>> {
    ACTIVE_TEXT_READS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct CoherentSnapshot {
    bytes: Vec<u8>,
    metadata: fs::Metadata,
    stat_ms: f64,
    read_ms: f64,
    method: &'static str,
    attempts: u8,
}

#[cfg(windows)]
fn read_coherent_snapshot(
    path: &Path,
    cancellation: &ReadCancellation,
) -> Result<CoherentSnapshot, String> {
    let stat_started = Instant::now();
    let mut last_error = None;
    for attempt in 1..=COHERENT_READ_ATTEMPTS {
        cancellation.checkpoint("snapshot-acquisition")?;
        let mut options = OpenOptions::new();
        options.read(true).share_mode(FILE_SHARE_READ);
        match options.open(path) {
            Ok(mut file) => {
                let before_metadata = file
                    .metadata()
                    .map_err(|error| format!("Could not read acquired file metadata: {error}"))?;
                if before_metadata.len() > MAX_TEXT_IPC_BYTES {
                    return Err("Text file is too large to open safely in ScieMD.".to_string());
                }
                let before_identity = windows_file_identity(&file)?;
                let read_started = Instant::now();
                let bytes = read_file_in_chunks(&mut file, before_metadata.len(), cancellation)?;
                let read_ms = elapsed_ms(read_started);
                let after_metadata = file
                    .metadata()
                    .map_err(|error| format!("Could not verify acquired file metadata: {error}"))?;
                let after_identity = windows_file_identity(&file)?;
                let path_file = options.open(path).map_err(|error| {
                    format!("Document changed on disk during coherent read: {error}")
                })?;
                let path_identity = windows_file_identity(&path_file)?;
                if before_identity != after_identity
                    || before_identity != path_identity
                    || !same_relevant_metadata(&before_metadata, &after_metadata)
                    || bytes.len() as u64 != after_metadata.len()
                {
                    last_error = Some("Document changed on disk during coherent read.".to_string());
                } else {
                    return Ok(CoherentSnapshot {
                        bytes,
                        metadata: after_metadata,
                        stat_ms: (elapsed_ms(stat_started) - read_ms).max(0.0),
                        read_ms,
                        method: "windows-write-excluding-handle-v1",
                        attempts: attempt,
                    });
                }
            }
            Err(error) => {
                last_error = Some(format!(
                    "Could not acquire write-excluding document read handle: {error}"
                ))
            }
        }
        if attempt < COHERENT_READ_ATTEMPTS {
            std::thread::sleep(COHERENT_READ_RETRY_DELAY);
        }
    }
    Err(format!(
        "Document changed on disk or remained write-locked after {COHERENT_READ_ATTEMPTS} coherent read attempts: {}",
        last_error.unwrap_or_else(|| "unknown acquisition failure".to_string())
    ))
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> Result<(u64, [u8; 16]), String> {
    let mut info = FILE_ID_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(format!(
            "Could not verify acquired file identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

#[cfg(not(windows))]
fn read_coherent_snapshot(
    path: &Path,
    cancellation: &ReadCancellation,
) -> Result<CoherentSnapshot, String> {
    let stat_started = Instant::now();
    for attempt in 1..=COHERENT_READ_ATTEMPTS {
        let read_started = Instant::now();
        let (first_bytes, first_metadata) = read_snapshot_once(path, cancellation)?;
        cancellation.checkpoint("snapshot-verify")?;
        let (second_bytes, second_metadata) = read_snapshot_once(path, cancellation)?;
        let read_ms = elapsed_ms(read_started);
        if first_bytes == second_bytes
            && same_file_identity(&first_metadata, &second_metadata)
            && same_relevant_metadata(&first_metadata, &second_metadata)
        {
            return Ok(CoherentSnapshot {
                bytes: second_bytes,
                metadata: second_metadata,
                stat_ms: (elapsed_ms(stat_started) - read_ms).max(0.0),
                read_ms,
                method: "verified-double-read-v1",
                attempts: attempt,
            });
        }
        if attempt < COHERENT_READ_ATTEMPTS {
            std::thread::sleep(COHERENT_READ_RETRY_DELAY);
        }
    }
    Err(format!(
        "Document changed on disk during {COHERENT_READ_ATTEMPTS} coherent read attempts."
    ))
}

#[cfg(not(windows))]
fn read_snapshot_once(
    path: &Path,
    cancellation: &ReadCancellation,
) -> Result<(Vec<u8>, fs::Metadata), String> {
    let mut file = fs::File::open(path).map_err(|error| format!("Could not read file: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not read file metadata: {error}"))?;
    if metadata.len() > MAX_TEXT_IPC_BYTES {
        return Err("Text file is too large to open safely in ScieMD.".to_string());
    }
    let bytes = read_file_in_chunks(&mut file, metadata.len(), cancellation)?;
    Ok((bytes, metadata))
}

fn read_file_in_chunks(
    file: &mut fs::File,
    expected_len: u64,
    cancellation: &ReadCancellation,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(expected_len.min(MAX_TEXT_IPC_BYTES) as usize);
    let mut chunk = vec![0_u8; TEXT_READ_CHUNK_BYTES];
    loop {
        cancellation.checkpoint("read")?;
        #[cfg(test)]
        if !cancellation.chunk_delay.is_zero() {
            std::thread::sleep(cancellation.chunk_delay);
        }
        let count = file
            .read(&mut chunk)
            .map_err(|error| format!("Could not read file: {error}"))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() as u64 > MAX_TEXT_IPC_BYTES {
            return Err("Text file is too large to open safely in ScieMD.".to_string());
        }
    }
    cancellation.checkpoint("read")?;
    Ok(bytes)
}

fn same_relevant_metadata(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len() && metadata_mtime_ms(left) == metadata_mtime_ms(right)
}

#[cfg(unix)]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(_left: &fs::Metadata, _right: &fs::Metadata) -> bool {
    true
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

#[tauri::command]
pub fn read_text_file_preview(
    path: String,
    max_bytes: Option<usize>,
) -> Result<ReadTextFilePreviewResponse, String> {
    let path = PathBuf::from(path);
    assert_file_read_allowed(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not read file metadata: {error}"))?;
    let byte_limit = max_bytes.unwrap_or(8192).clamp(512, 65_536);
    let mut file =
        fs::File::open(&path).map_err(|error| format!("Could not read file: {error}"))?;
    let mut bytes = Vec::with_capacity(byte_limit);
    Read::by_ref(&mut file)
        .take(byte_limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read file preview: {error}"))?;
    let decoded = decode_text_bytes_lossy(&bytes);
    let content = normalize_to_lf(&decoded.raw);

    Ok(ReadTextFilePreviewResponse {
        content,
        modified_ms: metadata_mtime_ms(&metadata),
    })
}

#[tauri::command]
pub async fn stat_file(
    path: String,
    include_content_hash: Option<bool>,
) -> HostResult<FileMetadata> {
    tauri::async_runtime::spawn_blocking(move || stat_file_blocking(path, include_content_hash))
        .await
        .map_err(|error| HostError::from(format!("Native file metadata worker failed: {error}")))?
}

fn stat_file_blocking(
    path: String,
    include_content_hash: Option<bool>,
) -> HostResult<FileMetadata> {
    let path = PathBuf::from(path);
    assert_file_read_allowed(&path)?;
    ensure_cloud_file_available(&path)?;
    let include_hash = include_content_hash.unwrap_or(false);
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not read file metadata: {error}"))?;
    if !include_hash {
        return Ok(metadata_from_path(
            &path,
            TextFidelityMetadata::unknown(),
            false,
        )?);
    }
    if metadata.len() > MAX_TEXT_HASH_BYTES {
        return Ok(metadata_from_path(
            &path,
            TextFidelityMetadata::unknown(),
            false,
        )?);
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not stat file: {error}"))?;
    let decoded = decode_text_bytes_lossy(&bytes);
    let line_endings = detect_line_endings(&decoded.raw);
    Ok(metadata_from_path(
        &path,
        TextFidelityMetadata {
            line_ending: line_endings.line_ending,
            encoding: decoded.encoding,
            has_bom: decoded.has_bom,
            has_mixed_line_endings: line_endings.has_mixed_line_endings,
            decode_lossy: decoded.decode_lossy,
            fidelity_known: true,
        },
        true,
    )?)
}

#[tauri::command]
pub fn read_binary_file_base64(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    assert_file_read_allowed(&path)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not read binary file metadata: {error}"))?;
    if metadata.len() > MAX_BINARY_IPC_BYTES {
        return Err("Image is too large to embed in a self-contained HTML export.".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not read binary file: {error}"))?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn list_readable_files(path: String) -> Result<Vec<FileExplorerEntry>, String> {
    let directory = PathBuf::from(path);
    assert_directory_read_allowed(&directory)?;
    let entries =
        fs::read_dir(&directory).map_err(|error| format!("Could not read folder: {error}"))?;
    let mut visible_entries = Vec::new();

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }

        let kind = if metadata.is_dir() {
            "directory"
        } else if let Some(kind) = readable_file_kind(&entry_path) {
            kind
        } else {
            continue;
        };

        visible_entries.push(FileExplorerEntry {
            name: name.to_string(),
            path: entry_path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            size_bytes: metadata.len(),
            modified_ms: metadata_mtime_ms(&metadata),
        });
    }

    visible_entries.sort_by(|left, right| {
        let left_is_dir = left.kind == "directory";
        let right_is_dir = right.kind == "directory";
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(visible_entries)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn write_text_file_atomic(
    path: String,
    source_text: String,
    line_ending: String,
    encoding: String,
    has_bom: bool,
    expected_mtime_ms: Option<u64>,
    expected_size_bytes: Option<u64>,
    expected_content_hash: Option<String>,
) -> HostResult<FileMetadata> {
    let path = PathBuf::from(path);
    assert_file_write_allowed(&path)?;
    if path.exists() {
        ensure_cloud_file_available(&path)?;
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Target file has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create parent directory: {error}"))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.md");
    cleanup_stale_temp_files_throttled(parent, file_name, Duration::from_secs(60 * 60));
    verify_expected_metadata(
        &path,
        expected_mtime_ms,
        expected_size_bytes,
        expected_content_hash.as_deref(),
    )?;

    let temp_path = temp_path_for(&path);
    let bytes = source_text_to_bytes(&source_text, &line_ending, &encoding, has_bom)?;

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| format!("Could not create temporary file: {error}"))?;

    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temp_path);
        return Err(HostError::from(format!(
            "Could not write temporary file: {error}"
        )));
    }

    drop(file);

    if let Err(error) = verify_expected_metadata(
        &path,
        expected_mtime_ms,
        expected_size_bytes,
        expected_content_hash.as_deref(),
    ) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }

    if let Err(error) = atomic_replace(&temp_path, &path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }

    sync_file(&path)?;
    sync_parent_dir(parent)?;
    sync_markdown_image_grants_if_markdown(&path, &source_text)?;
    Ok(metadata_from_path(
        &path,
        TextFidelityMetadata::known(line_ending, encoding, has_bom),
        true,
    )?)
}

#[tauri::command]
pub fn write_text_file_create_new(
    path: String,
    source_text: String,
    line_ending: String,
    encoding: String,
    has_bom: bool,
) -> Result<FileMetadata, String> {
    let path = PathBuf::from(path);
    assert_file_write_allowed(&path)?;
    let metadata = create_new_text_file(&path, &source_text, &line_ending, &encoding, has_bom)?;
    sync_markdown_image_grants_if_markdown(&path, &source_text)?;
    Ok(metadata)
}

#[tauri::command]
pub fn create_generated_sibling_artifact(
    document_path: String,
    artifact_kind: String,
    markdown: String,
    line_ending: String,
    encoding: String,
    has_bom: bool,
) -> Result<GeneratedSiblingArtifactResponse, String> {
    let document_path = PathBuf::from(document_path);
    assert_file_read_allowed(&document_path)?;
    let document = document_path
        .canonicalize()
        .map_err(|error| format!("Could not resolve document path: {error}"))?;
    if !document.is_file() {
        return Err("Expected a saved Markdown document.".to_string());
    }
    let parent = document
        .parent()
        .ok_or_else(|| "Markdown document has no parent directory.".to_string())?;
    let file_name = generated_artifact_file_name(&artifact_kind)?;
    let target = next_available_generated_sibling_path(parent, file_name);
    let metadata = create_new_text_file(&target, &markdown, &line_ending, &encoding, has_bom)?;
    grant_file_and_parent(&target)?;
    Ok(GeneratedSiblingArtifactResponse {
        path: target.to_string_lossy().to_string(),
        metadata,
    })
}

fn create_new_text_file(
    path: &Path,
    source_text: &str,
    line_ending: &str,
    encoding: &str,
    has_bom: bool,
) -> Result<FileMetadata, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Target file has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create parent directory: {error}"))?;

    let bytes = source_text_to_bytes(source_text, line_ending, encoding, has_bom)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create file without overwriting: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write file: {error}"))?;
    drop(file);
    sync_file(path)?;
    sync_parent_dir(parent)?;
    metadata_from_path(
        path,
        TextFidelityMetadata::known(line_ending.to_string(), encoding.to_string(), has_bom),
        true,
    )
}

fn sync_markdown_image_grants_if_markdown(path: &Path, content: &str) -> Result<usize, String> {
    if readable_file_kind(path) == Some("markdown") {
        return sync_document_image_grants_for_markdown(path, content);
    }
    clear_document_image_grants_for_document(path)
}

fn generated_artifact_file_name(artifact_kind: &str) -> Result<&'static str, String> {
    match artifact_kind.trim() {
        "llm-skill" => Ok("ScieMD_LLM_skill.md"),
        "submission-readiness" => Ok("SCIENFY_SUBMISSION_READINESS.md"),
        _ => Err("Unsupported generated artifact type.".to_string()),
    }
}

fn next_available_generated_sibling_path(parent: &Path, file_name: &str) -> PathBuf {
    let base = parent.join(file_name);
    if !base.exists() {
        return base;
    }
    let stem = file_name.strip_suffix(".md").unwrap_or(file_name);
    for index in 2..1000 {
        let candidate = parent.join(format!("{stem}-{index}.md"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-{}.md", unix_timestamp_for_file_name()))
}

fn verify_expected_metadata(
    path: &Path,
    expected_mtime_ms: Option<u64>,
    expected_size_bytes: Option<u64>,
    expected_content_hash: Option<&str>,
) -> Result<(), String> {
    if expected_mtime_ms.is_none()
        && expected_size_bytes.is_none()
        && expected_content_hash.is_none()
    {
        return if path.exists() {
            Err(
                "The target file appeared on disk before ScieMD could save. Choose another name or reload it first."
                    .to_string(),
            )
        } else {
            Ok(())
        };
    }

    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not verify target metadata before saving: {error}"))?;
    let current_mtime_ms = metadata_mtime_ms(&metadata);
    if expected_mtime_ms.is_some_and(|expected| current_mtime_ms != expected)
        || expected_size_bytes.is_some_and(|expected| metadata.len() != expected)
    {
        return Err(
            "The file changed on disk before ScieMD could save. Reload or save as a new file."
                .to_string(),
        );
    }
    if let Some(expected_content_hash) = expected_content_hash {
        let bytes = fs::read(path)
            .map_err(|error| format!("Could not verify target before saving: {error}"))?;
        if content_hash(&bytes) != expected_content_hash {
            return Err(
                "The file changed on disk before ScieMD could save. Reload or save as a new file."
                    .to_string(),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cleanup_stale_temp_files_for_paths(paths: Vec<String>) -> Result<(), String> {
    for path in paths {
        let path = PathBuf::from(path);
        if assert_file_write_allowed(&path).is_err() {
            continue;
        }
        let Some(parent) = path.parent() else {
            continue;
        };
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        cleanup_stale_temp_files(parent, file_name, Duration::from_secs(60 * 60));
    }
    Ok(())
}

struct TextFidelityMetadata {
    line_ending: String,
    encoding: String,
    has_bom: bool,
    has_mixed_line_endings: bool,
    decode_lossy: bool,
    fidelity_known: bool,
}

impl TextFidelityMetadata {
    fn known(line_ending: String, encoding: String, has_bom: bool) -> Self {
        Self {
            line_ending,
            encoding,
            has_bom,
            has_mixed_line_endings: false,
            decode_lossy: false,
            fidelity_known: true,
        }
    }

    fn unknown() -> Self {
        Self {
            line_ending: "lf".to_string(),
            encoding: "utf8".to_string(),
            has_bom: false,
            has_mixed_line_endings: false,
            decode_lossy: false,
            fidelity_known: false,
        }
    }
}

fn metadata_from_path(
    path: &Path,
    fidelity: TextFidelityMetadata,
    include_content_hash: bool,
) -> Result<FileMetadata, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Could not read file metadata: {error}"))?;
    let content_hash = if include_content_hash {
        content_hash_from_path(path, metadata.len())
    } else {
        None
    };

    Ok(metadata_from_file_metadata(
        path,
        &metadata,
        fidelity,
        content_hash,
    ))
}

fn metadata_from_file_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    fidelity: TextFidelityMetadata,
    content_hash: Option<String>,
) -> FileMetadata {
    let TextFidelityMetadata {
        line_ending,
        encoding,
        has_bom,
        has_mixed_line_endings,
        decode_lossy,
        fidelity_known,
    } = fidelity;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let last_known_mtime_ms = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;

    let mut loss_reasons = Vec::new();
    if has_mixed_line_endings {
        loss_reasons.push("mixed-line-endings-without-map".to_string());
    }
    if decode_lossy {
        loss_reasons.push("decode-replacement".to_string());
    }
    let lossless_write = if !fidelity_known {
        "unknown"
    } else if loss_reasons.is_empty() {
        "yes"
    } else {
        "no"
    };
    let line_endings = if has_mixed_line_endings {
        "mixed".to_string()
    } else {
        line_ending.clone()
    };
    let original_byte_hash = content_hash.clone();

    FileMetadata {
        line_ending,
        encoding,
        has_bom,
        has_mixed_line_endings,
        line_endings,
        decode_lossy,
        lossless_write: lossless_write.to_string(),
        loss_reasons,
        original_byte_hash,
        last_known_mtime_ms,
        last_known_size_bytes: metadata.len(),
        content_hash,
        cloud_state: cloud_file_state(path),
        read_only: metadata.permissions().readonly(),
    }
}

fn content_hash_from_path(path: &Path, size_bytes: u64) -> Option<String> {
    if size_bytes > MAX_TEXT_HASH_BYTES {
        return None;
    }
    fs::read(path).ok().map(|bytes| content_hash(&bytes))
}

#[cfg(windows)]
fn cloud_file_state(path: &Path) -> String {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetFileAttributesW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes == u32::MAX {
        return "unknown".to_string();
    }
    classify_cloud_attributes(attributes).to_string()
}

#[cfg(not(windows))]
fn cloud_file_state(_path: &Path) -> String {
    "local".to_string()
}

fn ensure_cloud_file_available(path: &Path) -> HostResult<()> {
    match cloud_file_state(path).as_str() {
        "cloud-placeholder" | "cloud-recall-on-open" => Err(HostError::new(
            HostErrorCode::CloudUnavailable,
            "Cloud document is not available locally. Download or pin it before continuing.",
        )),
        _ => Ok(()),
    }
}

#[cfg(windows)]
fn classify_cloud_attributes(attributes: u32) -> &'static str {
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_PINNED: u32 = 0x0008_0000;
    const FILE_ATTRIBUTE_UNPINNED: u32 = 0x0010_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    if attributes
        & (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_UNPINNED)
        != 0
    {
        "cloud-placeholder"
    } else if attributes & FILE_ATTRIBUTE_RECALL_ON_OPEN != 0 {
        "cloud-recall-on-open"
    } else if attributes & FILE_ATTRIBUTE_PINNED != 0 {
        "cloud-pinned"
    } else {
        "local"
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.md");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(".{file_name}.{timestamp}.tmp"))
}

fn cleanup_stale_temp_files_throttled(parent: &Path, file_name: &str, max_age: Duration) {
    let now = SystemTime::now();
    let mutex = LAST_TEMP_CLEANUP_AT.get_or_init(|| Mutex::new(None));
    let mut last_cleanup_at = mutex.lock();
    if last_cleanup_at
        .and_then(|last| now.duration_since(last).ok())
        .is_some_and(|elapsed| elapsed < Duration::from_secs(60))
    {
        return;
    }
    *last_cleanup_at = Some(now);
    drop(last_cleanup_at);
    cleanup_stale_temp_files(parent, file_name, max_age);
}

fn cleanup_stale_temp_files(parent: &Path, file_name: &str, max_age: Duration) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let now = SystemTime::now();

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(candidate) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_temp_file_for_target(candidate, file_name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() > max_age {
            let _ = fs::remove_file(path);
        }
    }
}

fn is_temp_file_for_target(candidate: &str, file_name: &str) -> bool {
    let prefix = format!(".{file_name}.");
    candidate.starts_with(&prefix) && candidate.ends_with(".tmp")
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
    let result = if target_path.exists() {
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
    if result == 0 {
        let error = std::io::Error::last_os_error();
        // ReplaceFileW can refuse to unlink its implicit backup on some Windows
        // filesystems/providers even though a same-volume replace is supported.
        // Keep the operation atomic by using the existing synced sibling +
        // MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH) path for both cases.
        if should_use_windows_same_volume_replace(error.raw_os_error()) {
            return copy_sync_and_replace_windows(temp_path, target_path);
        }
        Err(format!(
            "Could not replace target file atomically: {}",
            error
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn should_use_windows_same_volume_replace(raw_os_error: Option<i32>) -> bool {
    matches!(raw_os_error, Some(17) | Some(1175))
}

#[cfg(windows)]
fn copy_sync_and_replace_windows(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let copy_path = temp_path_for(target_path);
    let mut source = fs::File::open(temp_path).map_err(|error| {
        format!("Could not reopen temporary file for cross-device replace: {error}")
    })?;
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&copy_path)
        .map_err(|error| format!("Could not create same-volume replacement file: {error}"))?;
    if let Err(error) = std::io::copy(&mut source, &mut copy).and_then(|_| copy.sync_all()) {
        drop(copy);
        let _ = fs::remove_file(&copy_path);
        return Err(format!(
            "Could not copy replacement file onto the target volume: {error}"
        ));
    }
    drop(copy);
    let copy: Vec<u16> = copy_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            copy.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        let _ = fs::remove_file(&copy_path);
        return Err(format!(
            "Could not install same-volume replacement file: {}",
            std::io::Error::last_os_error()
        ));
    }
    let _ = fs::remove_file(temp_path);
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    match fs::rename(temp_path, target_path) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
            copy_sync_and_rename(temp_path, target_path)
        }
        Err(error) => Err(format!("Could not replace target file atomically: {error}")),
    }
}

#[cfg(not(windows))]
fn copy_sync_and_rename(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    let parent = target_path
        .parent()
        .ok_or_else(|| "Target file has no parent directory.".to_string())?;
    let copy_path = temp_path_for(target_path);
    let mut source = fs::File::open(temp_path).map_err(|error| {
        format!("Could not reopen temporary file for cross-device replace: {error}")
    })?;
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&copy_path)
        .map_err(|error| format!("Could not create cross-device replacement file: {error}"))?;
    if let Err(error) = std::io::copy(&mut source, &mut copy).and_then(|_| copy.sync_all()) {
        drop(copy);
        let _ = fs::remove_file(&copy_path);
        return Err(format!(
            "Could not copy replacement file across file systems: {error}"
        ));
    }
    drop(copy);
    fs::rename(&copy_path, target_path).map_err(|error| {
        let _ = fs::remove_file(&copy_path);
        format!("Could not install cross-device replacement file: {error}")
    })?;
    let _ = fs::remove_file(temp_path);
    sync_parent_dir(parent)?;
    Ok(())
}

fn sync_file(path: &Path) -> Result<(), String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("Could not reopen saved file for durability sync: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush saved file to disk: {error}"))
}

#[cfg(windows)]
fn sync_parent_dir(_parent: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent_dir(parent: &Path) -> Result<(), String> {
    let directory = std::fs::File::open(parent)
        .map_err(|error| format!("Could not open parent directory for durability sync: {error}"))?;
    directory
        .sync_all()
        .map_err(|error| format!("Could not flush parent directory to disk: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_atomic_replace_falls_back_for_cross_device_and_provider_unlink_errors() {
        assert!(should_use_windows_same_volume_replace(Some(17)));
        assert!(should_use_windows_same_volume_replace(Some(1175)));
        assert!(!should_use_windows_same_volume_replace(Some(5)));
        assert!(!should_use_windows_same_volume_replace(None));
    }
    use crate::commands::path_grants::{
        assert_file_read_allowed, assert_file_write_allowed, grant_directory,
        grant_document_image_asset, grant_file, grant_file_and_parent, isolate_test_path_grants,
    };
    use filetime::{set_file_mtime, FileTime};
    use std::{env, fs};

    #[cfg(windows)]
    #[test]
    fn cloud_attribute_classification_marks_placeholders() {
        assert_eq!(classify_cloud_attributes(0), "local");
        assert_eq!(classify_cloud_attributes(0x0008_0000), "cloud-pinned");
        assert_eq!(
            classify_cloud_attributes(0x0004_0000),
            "cloud-recall-on-open"
        );
        assert_eq!(classify_cloud_attributes(0x0010_0000), "cloud-placeholder");
        assert_eq!(classify_cloud_attributes(0x0040_0000), "cloud-placeholder");
        assert_eq!(classify_cloud_attributes(0x0000_1000), "cloud-placeholder");
    }

    #[test]
    fn atomic_write_and_read_preserve_line_ending_and_bom_policy() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-file-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        grant_file_and_parent(&path).unwrap();

        let metadata = write_text_file_atomic(
            path.to_string_lossy().to_string(),
            "alpha\nbeta\n".to_string(),
            "crlf".to_string(),
            "utf8".to_string(),
            true,
            None,
            None,
            None,
        )
        .unwrap();

        let raw = fs::read(&path).unwrap();
        assert!(raw.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert!(String::from_utf8_lossy(&raw).contains("alpha\r\nbeta\r\n"));
        assert_eq!(metadata.line_ending, "crlf");
        assert_eq!(metadata.encoding, "utf8");
        assert!(metadata.has_bom);

        let read = read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(read.source_text, "alpha\nbeta\n");
        assert_eq!(read.metadata.line_ending, "crlf");
        assert_eq!(read.metadata.encoding, "utf8");
        assert!(read.metadata.has_bom);
        assert_eq!(read.metadata.content_hash, Some(content_hash(&raw)));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_rejects_stale_expected_metadata() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-stale-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        fs::write(&path, b"old").unwrap();
        grant_file_and_parent(&path).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let hash = content_hash(&fs::read(&path).unwrap());

        let error = write_text_file_atomic(
            path.to_string_lossy().to_string(),
            "new\n".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
            Some(metadata_mtime_ms(&metadata)),
            Some(metadata.len() + 1),
            Some(hash),
        )
        .unwrap_err();

        assert_eq!(error.code, HostErrorCode::FileChanged);
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_rejects_existing_file_when_expected_metadata_is_empty() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-appeared-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        fs::write(&path, b"appeared").unwrap();
        grant_file_and_parent(&path).unwrap();

        let error = write_text_file_atomic(
            path.to_string_lossy().to_string(),
            "new\n".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
            None,
            None,
            None,
        )
        .unwrap_err();

        assert_eq!(error.code, HostErrorCode::FileChanged);
        assert_eq!(fs::read_to_string(&path).unwrap(), "appeared");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_vetoes_lossy_windows_1252_output_before_creating_a_file() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-lossy-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        grant_file_and_parent(&path).unwrap();

        let error = write_text_file_atomic(
            path.to_string_lossy().to_string(),
            "cannot encode: 🧪\n".to_string(),
            "lf".to_string(),
            "windows1252".to_string(),
            false,
            None,
            None,
            None,
        )
        .unwrap_err();

        assert_eq!(error.code, HostErrorCode::LossyWriteRequired);
        assert!(!path.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FidelityCorpusCase {
        id: String,
        bytes_hex: String,
        source_text: String,
        encoding: String,
        bom: bool,
        dominant_line_ending: String,
        line_endings: String,
        lossless_write: String,
    }

    #[test]
    fn fidelity_corpus_reports_and_round_trips_only_declared_lossless_cases() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-fidelity-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let corpus: Vec<FidelityCorpusCase> = serde_json::from_str(include_str!(
            "../../../docs/refactor/file_fidelity_corpus.v1.json"
        ))
        .unwrap();

        for case in corpus {
            let path = dir.join(format!("{}.md", case.id));
            let original_bytes = hex_bytes(&case.bytes_hex);
            fs::write(&path, &original_bytes).unwrap();
            grant_file_and_parent(&path).unwrap();

            let read =
                read_text_file_for_edit_blocking(path.to_string_lossy().to_string()).unwrap();
            assert_eq!(read.source_text, case.source_text, "{} source", case.id);
            assert_eq!(read.contract_version, 2, "{} contract", case.id);
            assert_eq!(
                read.metadata.encoding, case.encoding,
                "{} encoding",
                case.id
            );
            assert_eq!(read.metadata.has_bom, case.bom, "{} BOM", case.id);
            assert_eq!(
                read.metadata.line_ending, case.dominant_line_ending,
                "{} dominant ending",
                case.id
            );
            assert_eq!(
                read.metadata.line_endings, case.line_endings,
                "{} endings",
                case.id
            );
            assert_eq!(
                read.metadata.lossless_write, case.lossless_write,
                "{} lossless policy",
                case.id
            );

            if case.lossless_write == "yes" {
                let metadata = read.metadata;
                write_text_file_atomic(
                    path.to_string_lossy().to_string(),
                    case.source_text,
                    metadata.line_ending.clone(),
                    metadata.encoding.clone(),
                    metadata.has_bom,
                    Some(metadata.last_known_mtime_ms),
                    Some(metadata.last_known_size_bytes),
                    metadata.content_hash,
                )
                .unwrap();
                assert_eq!(
                    fs::read(&path).unwrap(),
                    original_bytes,
                    "{} bytes",
                    case.id
                );
            }
        }

        let _ = fs::remove_dir_all(dir);
    }

    fn hex_bytes(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn create_new_write_refuses_to_overwrite_existing_file() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-create-new-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("generated.md");
        fs::write(&path, b"existing").unwrap();
        grant_file_and_parent(&path).unwrap();

        let error = write_text_file_create_new(
            path.to_string_lossy().to_string(),
            "new".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
        )
        .unwrap_err();

        assert!(error.contains("Could not create file without overwriting"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "existing");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn generated_sibling_artifacts_are_allowlisted_and_create_new() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-generated-sibling-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let document = dir.join("paper.md");
        fs::write(&document, b"# Paper").unwrap();
        fs::write(dir.join("ScieMD_LLM_skill.md"), b"existing").unwrap();
        grant_file(&document).unwrap();

        let created = create_generated_sibling_artifact(
            document.to_string_lossy().to_string(),
            "llm-skill".to_string(),
            "# Skill\n".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
        )
        .unwrap();
        let created_path = PathBuf::from(&created.path);

        assert_eq!(
            created_path.file_name().and_then(|value| value.to_str()),
            Some("ScieMD_LLM_skill-2.md")
        );
        assert_eq!(fs::read_to_string(&created_path).unwrap(), "# Skill\n");
        assert!(assert_file_write_allowed(&created_path).is_ok());
        assert!(assert_file_write_allowed(&dir.join("not-allowlisted.md")).is_err());

        let report = create_generated_sibling_artifact(
            document.to_string_lossy().to_string(),
            "submission-readiness".to_string(),
            "# Readiness\n".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
        )
        .unwrap();

        assert_eq!(
            PathBuf::from(report.path)
                .file_name()
                .and_then(|value| value.to_str()),
            Some("SCIENFY_SUBMISSION_READINESS.md")
        );

        let error = create_generated_sibling_artifact(
            document.to_string_lossy().to_string(),
            "arbitrary".to_string(),
            "no".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
        )
        .unwrap_err();
        assert!(error.contains("Unsupported generated artifact type"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_binary_file_base64_encodes_file_bytes() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-binary-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("image.png");
        fs::write(&path, [1_u8, 2, 3, 4]).unwrap();
        grant_file(&path).unwrap();

        assert_eq!(
            read_binary_file_base64(path.to_string_lossy().to_string()).unwrap(),
            "AQIDBA=="
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn file_reads_require_a_registered_grant() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-denied-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("private.md");
        fs::write(&path, b"# Private").unwrap();

        let error =
            read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap_err();

        assert_eq!(error.code, HostErrorCode::PermissionDenied);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_does_not_upgrade_directory_read_grants_to_file_write_grants() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-read-only-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("paper.md");
        fs::write(&path, b"# Paper").unwrap();
        grant_directory(&dir).unwrap();

        let read = read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap();

        assert_eq!(read.source_text, "# Paper");
        assert!(assert_file_write_allowed(&path).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_for_edit_grants_only_the_opened_file_for_writes() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-edit-open-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("paper.md");
        let sibling = dir.join("sibling.md");
        fs::write(&path, b"# Paper").unwrap();
        fs::write(&sibling, b"# Sibling").unwrap();
        grant_directory(&dir).unwrap();

        let read = read_text_file_for_edit_blocking(path.to_string_lossy().to_string()).unwrap();

        assert_eq!(read.source_text, "# Paper");
        assert!(assert_file_write_allowed(&path).is_ok());
        assert!(assert_file_write_allowed(&sibling).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_for_edit_grants_referenced_images_exactly() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-edit-images-{}", temp_suffix()));
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let path = dir.join("paper.md");
        let referenced = assets.join("figure.png");
        let unreferenced = assets.join("private.png");
        fs::write(&path, b"# Paper\n\n![Figure](assets/figure.png)\n").unwrap();
        fs::write(
            &referenced,
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        fs::write(
            &unreferenced,
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        grant_file(&path).unwrap();

        let read = read_text_file_for_edit_blocking(path.to_string_lossy().to_string()).unwrap();

        assert!(read.source_text.contains("assets/figure.png"));
        assert!(assert_file_read_allowed(&referenced).is_ok());
        assert!(assert_file_read_allowed(&unreferenced).is_err());
        assert!(assert_file_write_allowed(&referenced).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_for_edit_clears_document_image_grants_for_json() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-json-edit-images-{}", temp_suffix()));
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let path = dir.join("results.json");
        let referenced = assets.join("figure.png");
        fs::write(&path, br#"{"preview":"![Figure](assets/figure.png)"}"#).unwrap();
        fs::write(
            &referenced,
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        grant_file(&path).unwrap();
        grant_document_image_asset(&path, &referenced).unwrap();
        assert!(assert_file_read_allowed(&referenced).is_ok());

        let read = read_text_file_for_edit_blocking(path.to_string_lossy().to_string()).unwrap();

        assert!(read.source_text.contains("assets/figure.png"));
        assert!(assert_file_read_allowed(&referenced).is_err());
        assert!(assert_file_write_allowed(&path).is_ok());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_replaces_document_image_grants() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-write-images-{}", temp_suffix()));
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let path = dir.join("paper.md");
        let first = assets.join("first.png");
        let second = assets.join("second.png");
        fs::write(&path, b"# Paper\n\n![First](assets/first.png)\n").unwrap();
        fs::write(&first, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        fs::write(&second, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        grant_file_and_parent(&path).unwrap();
        let opened = read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap();
        assert!(assert_file_read_allowed(&first).is_ok());

        write_text_file_atomic(
            path.to_string_lossy().to_string(),
            "# Paper\n\n![Second](assets/second.png)\n".to_string(),
            opened.metadata.line_ending.clone(),
            opened.metadata.encoding.clone(),
            opened.metadata.has_bom,
            Some(opened.metadata.last_known_mtime_ms),
            Some(opened.metadata.last_known_size_bytes),
            opened.metadata.content_hash.clone(),
        )
        .unwrap();

        assert!(assert_file_read_allowed(&first).is_err());
        assert!(assert_file_read_allowed(&second).is_ok());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_new_write_does_not_grant_document_images_for_json() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-json-write-images-{}", temp_suffix()));
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let path = dir.join("results.json");
        let referenced = assets.join("figure.png");
        fs::write(
            &referenced,
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        grant_file_and_parent(&path).unwrap();

        write_text_file_create_new(
            path.to_string_lossy().to_string(),
            "{\"preview\":\"![Figure](assets/figure.png)\"}\n".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
        )
        .unwrap();

        assert!(assert_file_read_allowed(&referenced).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_reports_mixed_line_endings() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-mixed-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mixed.md");
        fs::write(&path, b"alpha\r\nbeta\ngamma\r\n").unwrap();
        grant_file(&path).unwrap();

        let read = read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(read.source_text, "alpha\nbeta\ngamma\n");
        assert!(read.metadata.has_mixed_line_endings);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stat_file_reports_filesystem_read_only_state() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-readonly-metadata-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("readonly.md");
        fs::write(&path, b"readonly").unwrap();
        grant_file(&path).unwrap();
        let writable_permissions = fs::metadata(&path).unwrap().permissions();
        let mut permissions = writable_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let observed = stat_file_blocking(path.to_string_lossy().to_string(), Some(false)).unwrap();
        assert!(observed.read_only);

        #[cfg(windows)]
        {
            fs::set_permissions(&path, writable_permissions).unwrap();
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_preview_reads_only_a_bounded_prefix() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-preview-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("preview.md");
        let content = format!("# Preview\n\nThis should appear.\n\n{}", "tail".repeat(300));
        fs::write(&path, content.as_bytes()).unwrap();
        grant_file(&path).unwrap();

        let preview = read_text_file_preview(path.to_string_lossy().to_string(), Some(24)).unwrap();

        assert!(preview.content.starts_with("# Preview"));
        assert!(preview.content.len() <= 512);
        assert!(preview.content.len() < content.len());
        assert!(preview.modified_ms > 0);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_text_file_detects_utf16_and_windows_1252() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-encoding-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let utf16_path = dir.join("utf16.md");
        let mut utf16_bytes = vec![0xFF, 0xFE];
        for unit in "alpha\r\nbeta".encode_utf16() {
            utf16_bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&utf16_path, utf16_bytes).unwrap();
        grant_file_and_parent(&utf16_path).unwrap();

        let utf16 =
            read_text_file_blocking_for_test(utf16_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(utf16.source_text, "alpha\nbeta");
        assert_eq!(utf16.metadata.encoding, "utf16le");
        assert!(utf16.metadata.has_bom);

        let cp1252_path = dir.join("cp1252.md");
        fs::write(&cp1252_path, b"caf\xe9 \x97 quote").unwrap();
        grant_file_and_parent(&cp1252_path).unwrap();

        let cp1252 =
            read_text_file_blocking_for_test(cp1252_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(cp1252.source_text, "café — quote");
        assert_eq!(cp1252.metadata.encoding, "windows1252");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn coherent_reader_preserves_a_24_mib_fidelity_envelope() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-coherent-24mib-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.md");
        let mut bytes = Vec::with_capacity(24 * 1024 * 1024);
        while bytes.len() < 24 * 1024 * 1024 {
            bytes.extend_from_slice(b"alpha\r\nbeta\r\n");
        }
        bytes.truncate(24 * 1024 * 1024);
        fs::write(&path, &bytes).unwrap();
        grant_file(&path).unwrap();

        let read = read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap();

        assert_eq!(read.contract_version, 2);
        assert_eq!(read.native_timings.byte_count, 24 * 1024 * 1024);
        assert!(read.snapshot.identity_verified);
        assert_eq!(read.snapshot.attempts, 1);
        assert_eq!(read.metadata.original_byte_hash, Some(content_hash(&bytes)));
        assert_eq!(read.metadata.line_ending, "crlf");
        assert!(!read.source_text.contains('\r'));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cancellation_stops_before_read_and_during_staged_decode() {
        let before = ReadCancellation::default();
        before.cancelled.store(true, Ordering::Release);
        assert!(before
            .checkpoint("preflight")
            .unwrap_err()
            .contains("preflight"));

        let during = Arc::new(ReadCancellation::with_chunk_delay(Duration::from_millis(2)));
        let worker_state = during.clone();
        let worker =
            std::thread::spawn(move || worker_state.scan_checkpoints("decode", 24 * 1024 * 1024));
        std::thread::sleep(Duration::from_millis(15));
        let started = Instant::now();
        during.cancelled.store(true, Ordering::Release);
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.contains("decode"));
        assert!(started.elapsed() < NATIVE_CANCEL_WAIT_BOUND);
    }

    #[test]
    fn text_ipc_chunks_are_bounded_and_preserve_unicode_source() {
        let source = format!(
            "{}🧪{}",
            "a".repeat(TEXT_READ_IPC_CHUNK_BYTES - 1),
            "z".repeat(TEXT_READ_IPC_CHUNK_BYTES)
        );
        let chunks = text_ipc_chunks(&source);

        assert!(chunks.len() >= 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= TEXT_READ_IPC_CHUNK_BYTES));
        assert_eq!(chunks.concat(), source);
    }

    #[test]
    fn cancellation_stops_a_staged_native_file_read_within_budget() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-cancel-read-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.md");
        fs::write(&path, vec![b'a'; 24 * 1024 * 1024]).unwrap();
        grant_file(&path).unwrap();
        let cancellation = Arc::new(ReadCancellation::with_chunk_delay(Duration::from_millis(2)));
        let worker_state = cancellation.clone();
        let worker_path = path.clone();
        let worker =
            std::thread::spawn(move || read_text_file_blocking(worker_path, false, &worker_state));
        std::thread::sleep(Duration::from_millis(15));
        let started = Instant::now();
        cancellation.cancelled.store(true, Ordering::Release);
        let error = worker.join().unwrap().unwrap_err();
        let stop_ms = elapsed_ms(started);

        assert!(error.contains("cancelled"));
        assert!(
            stop_ms <= NATIVE_CANCEL_WAIT_BOUND.as_secs_f64() * 1000.0,
            "stop_ms={stop_ms}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_coherent_handle_excludes_writers_and_replacement() {
        let dir = env::temp_dir().join(format!("scie-md-share-read-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        fs::write(&path, b"same-size").unwrap();
        let mut reader_options = OpenOptions::new();
        reader_options.read(true).share_mode(FILE_SHARE_READ);
        let reader = reader_options.open(&path).unwrap();

        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
        drop(reader);
        fs::write(&path, b"new-bytes").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new-bytes");

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_coherent_reader_exhausts_bounded_retries_while_writer_is_active() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-share-retry-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        fs::write(&path, b"same-size").unwrap();
        grant_file(&path).unwrap();
        let writer = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let started = Instant::now();

        let error =
            read_text_file_blocking_for_test(path.to_string_lossy().to_string()).unwrap_err();

        assert_eq!(error.code, HostErrorCode::FileChanged);
        assert_eq!(error.phase.as_deref(), Some("coherent-snapshot"));
        assert!(
            started.elapsed() >= COHERENT_READ_RETRY_DELAY * u32::from(COHERENT_READ_ATTEMPTS - 1)
        );
        drop(writer);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_stale_temp_files_removes_only_matching_target_temps() {
        let dir = env::temp_dir().join(format!("scie-md-temp-cleanup-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let matching = dir.join(".document.md.123.tmp");
        let other = dir.join(".other.md.123.tmp");
        fs::write(&matching, b"temp").unwrap();
        fs::write(&other, b"temp").unwrap();
        std::thread::sleep(Duration::from_millis(5));

        cleanup_stale_temp_files(&dir, "document.md", Duration::ZERO);

        assert!(!matching.exists());
        assert!(other.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_stale_temp_files_respects_age_threshold() {
        let dir = env::temp_dir().join(format!("scie-md-temp-age-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let stale = dir.join(".document.md.stale.tmp");
        let fresh = dir.join(".document.md.fresh.tmp");
        let sibling = dir.join(".other.md.stale.tmp");
        fs::write(&stale, b"stale").unwrap();
        fs::write(&fresh, b"fresh").unwrap();
        fs::write(&sibling, b"sibling").unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        set_file_mtime(&stale, FileTime::from_system_time(old_time)).unwrap();
        set_file_mtime(&sibling, FileTime::from_system_time(old_time)).unwrap();

        cleanup_stale_temp_files(&dir, "document.md", Duration::from_secs(60 * 60));

        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(sibling.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_reports_locked_target_without_replacing_original() {
        use std::os::windows::fs::OpenOptionsExt;

        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-locked-{}", temp_suffix()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        fs::write(&path, b"original").unwrap();
        grant_file_and_parent(&path).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let _lock = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let error = write_text_file_atomic(
            path.to_string_lossy().to_string(),
            "new\n".to_string(),
            "lf".to_string(),
            "utf8".to_string(),
            false,
            Some(metadata_mtime_ms(&metadata)),
            Some(metadata.len()),
            None,
        )
        .unwrap_err();

        assert_eq!(error.code, HostErrorCode::UnknownHostError);
        drop(_lock);
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(
            fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|entry| entry
                    .path()
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| is_temp_file_for_target(name, "document.md")))
                .count(),
            0
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn temp_path_for_uses_hidden_sibling_file_name() {
        let dir = env::temp_dir().join(format!("scie-md-temp-path-{}", temp_suffix()));
        let target = dir.join("document.md");

        let temp_path = temp_path_for(&target);
        let temp_name = temp_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap();

        assert_eq!(temp_path.parent(), Some(dir.as_path()));
        assert!(temp_name.starts_with(".document.md."));
        assert!(temp_name.ends_with(".tmp"));
    }

    #[test]
    fn list_readable_files_returns_supported_text_documents() {
        let _grants = isolate_test_path_grants();
        let dir = env::temp_dir().join(format!("scie-md-explorer-{}", temp_suffix()));
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("a.md"), b"# A").unwrap();
        fs::write(dir.join("a.markdown"), b"# A2").unwrap();
        fs::write(dir.join("b.txt"), b"B").unwrap();
        fs::write(dir.join("c.json"), b"{}").unwrap();
        fs::write(dir.join("d.jsonl"), br#"{"a":1}"#).unwrap();
        fs::write(dir.join("e.ndjson"), br#"{"a":2}"#).unwrap();
        fs::write(dir.join("f.yaml"), b"title: A").unwrap();
        fs::write(dir.join("g.yml"), b"title: B").unwrap();
        fs::write(dir.join("h.toml"), b"title = \"A\"").unwrap();
        fs::write(dir.join("i.xml"), b"<root/>").unwrap();
        fs::write(dir.join("j.csv"), b"id,count\n1,2").unwrap();
        fs::write(dir.join("k.tsv"), b"id\tcount\n1\t2").unwrap();
        fs::write(dir.join("c.png"), [1_u8, 2, 3]).unwrap();
        fs::write(dir.join("l.pdf"), b"PDF").unwrap();
        grant_directory(&dir).unwrap();

        let entries = list_readable_files(dir.to_string_lossy().to_string()).unwrap();
        let names_and_kinds: Vec<(String, String)> = entries
            .into_iter()
            .map(|entry| (entry.name, entry.kind))
            .collect();

        assert_eq!(
            names_and_kinds,
            vec![
                ("notes".to_string(), "directory".to_string()),
                ("a.markdown".to_string(), "markdown".to_string()),
                ("a.md".to_string(), "markdown".to_string()),
                ("b.txt".to_string(), "plainText".to_string()),
                ("c.json".to_string(), "json".to_string()),
                ("d.jsonl".to_string(), "jsonl".to_string()),
                ("e.ndjson".to_string(), "jsonl".to_string()),
                ("f.yaml".to_string(), "yaml".to_string()),
                ("g.yml".to_string(), "yaml".to_string()),
                ("h.toml".to_string(), "toml".to_string()),
                ("i.xml".to_string(), "xml".to_string()),
                ("j.csv".to_string(), "csv".to_string()),
                ("k.tsv".to_string(), "tsv".to_string()),
            ]
        );

        let _ = fs::remove_dir_all(dir);
    }

    fn temp_suffix() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    }
}
