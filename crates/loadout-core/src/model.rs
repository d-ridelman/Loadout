//! Единая модель (CONCEPT.md §3), урезанная до того, что нужно сканеру M0.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Plugin,
    Mcp,
    Skill,
    Hook,
    Agent,
    Command,
    Marketplace,
    Connector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    On,
    Off,
    Broken,
    Stale,
    Cloud,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Origin {
    pub file: String,
    pub pointer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub logical_key: String,
    pub kind: Kind,
    pub client: Client,
    pub scope: String,
    pub name: String,
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub origin: Origin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Только уже замаскированные данные: секретные значения сюда не попадают (см. mask.rs).
    pub detail: Value,
}

#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub entities: Vec<Entity>,
    pub warnings: Vec<String>,
}

/// FNV-1a 64: стабильный между версиями Rust, в отличие от `DefaultHasher`.
fn fnv1a(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.bytes().chain(std::iter::once(0u8)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

impl Entity {
    pub fn new(
        client: Client,
        kind: Kind,
        scope: impl Into<String>,
        name: impl Into<String>,
        state: State,
        file: impl Into<String>,
        pointer: impl Into<String>,
    ) -> Self {
        let (scope, name, file, pointer) = (scope.into(), name.into(), file.into(), pointer.into());
        let id = fnv1a(&[
            &format!("{client:?}"),
            &format!("{kind:?}"),
            &scope,
            &name,
            &file,
            &pointer,
        ]);
        // «glidehand@glidehand» и «glidehand» (MCP) — одна логическая сущность (CONCEPT.md §2).
        let logical_key = name.split('@').next().unwrap_or(&name).to_lowercase();
        Self {
            id,
            logical_key,
            kind,
            client,
            scope,
            name,
            state,
            version: None,
            origin: Origin { file, pointer },
            note: None,
            detail: json!({}),
        }
    }

    pub fn version(mut self, v: Option<&str>) -> Self {
        self.version = v.map(str::to_owned);
        self
    }

    pub fn note(mut self, n: impl Into<String>) -> Self {
        self.note = Some(n.into());
        self
    }

    pub fn detail(mut self, d: Value) -> Self {
        self.detail = d;
        self
    }

    pub fn logical(mut self, key: impl Into<String>) -> Self {
        self.logical_key = key.into().to_lowercase();
        self
    }
}
