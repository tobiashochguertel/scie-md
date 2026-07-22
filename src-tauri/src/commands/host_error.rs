use serde::{Deserialize, Serialize};
use std::fmt;

pub const HOST_ERROR_CONTRACT_VERSION: u16 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HostErrorCode {
    FileChanged,
    NotFound,
    PermissionDenied,
    CloudUnavailable,
    BackupFailed,
    LossyWriteRequired,
    Cancelled,
    UnknownHostError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub contract_version: u16,
    pub code: HostErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

pub type HostResult<T> = Result<T, HostError>;

impl HostError {
    pub fn new(code: HostErrorCode, message: impl Into<String>) -> Self {
        Self {
            contract_version: HOST_ERROR_CONTRACT_VERSION,
            code,
            message: message.into(),
            phase: None,
        }
    }

    pub fn backup(message: impl Into<String>) -> Self {
        Self::new(HostErrorCode::BackupFailed, message)
    }

    pub fn with_phase(mut self, phase: impl Into<String>) -> Self {
        self.phase = Some(phase.into());
        self
    }
}

impl From<String> for HostError {
    fn from(message: String) -> Self {
        let normalized = message.to_ascii_lowercase();
        let code = if normalized.contains("changed on disk")
            || normalized.contains("target file appeared")
        {
            HostErrorCode::FileChanged
        } else if normalized.contains("file access denied")
            || normalized.contains("permission denied")
            || normalized.contains("access is denied")
        {
            HostErrorCode::PermissionDenied
        } else if normalized.contains("not found")
            || normalized.contains("cannot find")
            || normalized.contains("no such file")
            || normalized.contains("os error 2")
        {
            HostErrorCode::NotFound
        } else if normalized.contains("document read cancelled") {
            HostErrorCode::Cancelled
        } else if normalized.contains("unsupported text encoding")
            || normalized.contains("cannot be represented")
            || (normalized.contains("cannot be saved using") && normalized.contains("encoding"))
        {
            HostErrorCode::LossyWriteRequired
        } else if normalized.contains("cloud")
            && (normalized.contains("unavailable") || normalized.contains("offline"))
        {
            HostErrorCode::CloudUnavailable
        } else {
            HostErrorCode::UnknownHostError
        };
        Self::new(code, message)
    }
}

// Internal smoke-test helpers still return their historical string diagnostic.
// Tauri lifecycle commands serialize HostError before this compatibility edge.
impl From<HostError> for String {
    fn from(error: HostError) -> Self {
        error.message
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HostError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_and_typescript_share_the_versioned_error_fixture() {
        let fixture = include_str!("../../../src/app/host/fixtures/documentHostErrors.v2.json");
        let errors: Vec<HostError> = serde_json::from_str(fixture).unwrap();
        assert_eq!(errors.len(), 8);
        assert!(errors
            .iter()
            .all(|error| error.contract_version == HOST_ERROR_CONTRACT_VERSION));
        assert_eq!(errors[0].code, HostErrorCode::FileChanged);
        assert_eq!(errors[6].code, HostErrorCode::Cancelled);
        assert_eq!(errors[7].code, HostErrorCode::UnknownHostError);
    }
}
