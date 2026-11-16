//! The unified model (CONCEPT.md §3), cut down to what the M0 scanner needs.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    ClaudeCode,
    ClaudeDesktop,
    Codex,
    Antigravity,
    #[serde(rename = "deepseek")]
    DeepSeek,
}

impl Client {
    pub const ALL: [Client; 5] = [
        Client::ClaudeCode,
        Client::ClaudeDesktop,
        Client::Codex,
        Client::Antigravity,
        Client::DeepSeek,
    ];

    /// Short name for the CLI and JSON (matches `serde`).
    pub fn slug(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude-code",
            Client::ClaudeDesktop => "claude-desktop",
            Client::Codex => "codex",
            Client::Antigravity => "antigravity",
            Client::DeepSeek => "deepseek",
        }
    }

    /// The inverse of [`Client::slug`].
    pub fn from_slug(s: &str) -> Option<Client> {
        Client::ALL.into_iter().find(|c| c.slug() == s)
    }
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Origin {
    pub file: String,
    pub pointer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Toml,
    /// DeepSeek's `cordis.patch.yml`: only cutting out and returning an entry by lines is edited (`yaml_edit`).
    Yaml,
}

/// Where to write to switch an entry (R1): a boolean key in a known client file.
/// The real path and raw keys; they do not leave the core (`#[serde(skip)]` on the field), only the sanitized `origin` goes to the output.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub file: std::path::PathBuf,
    pub format: Format,
    /// Keys from the file root to the boolean value (`Flag`) or to the entry itself (`Cut`, `Restore`).
    pub path: Vec<String>,
    /// `true` in the file means "disabled" (`disableClaudeAiConnectors`).
    pub inverted: bool,
    pub kind: TargetKind,
}

/// Where to bring a cut-out entry back from.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// The Loadout trash (`<backups>/trash/<id>.json`).
    Trash(String),
    /// The owner's stash in the same file (`_disabledMcpServers`): the path to the stash object.
    Stash(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum TargetKind {
    /// A boolean key.
    Flag,
    /// An enabled entry without a flag: "disable" cuts it into the trash.
    Cut,
    /// A disabled entry outside the file (trash) or in the stash: "enable" returns it to its place.
    Restore(Source),
}

/// Where the whole entry lies (MCP): it is read and copied from there, and edits are written there.
#[derive(Debug, Clone, PartialEq)]
pub struct Src {
    pub file: std::path::PathBuf,
    pub format: Format,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// Already masked data only: secret values do not get here (see mask.rs).
    pub detail: Value,
    /// The name and pointer are taken from a file or directory name, not from file content: token-like words in them are not hidden,
    /// otherwise different entries (`app-69f0dc45…` in the Codex directory) would merge into one `<masked>` string.
    #[serde(skip)]
    pub fs_named: bool,
    /// How to switch the entry; `None` means the switch is not supported (see [`crate::write::why_not`]).
    #[serde(skip)]
    pub target: Option<Target>,
    #[serde(skip)]
    pub src: Option<Src>,
    /// The entry can be edited and copied (has `src`).
    pub can_edit: bool,
    /// Filled in at the end of a scan from `target`: the window uses it to decide whether to offer a switch.
    pub can_toggle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle_why: Option<String>,
    /// Which entry level is needed for switching: `R1` (flag) or `R2` (trash).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle_level: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct ScanResult {
    pub entities: Vec<Entity>,
    pub warnings: Vec<String>,
    /// Counters per client directory (backup copies, broken links); conclusions are drawn by the Doctor.
    pub facts: crate::facts::Facts,
}

/// FNV-1a 64: stable across Rust versions, unlike `DefaultHasher`.
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
        // "glidehand@glidehand" and "glidehand" (MCP) are one logical entity (CONCEPT.md §2).
        // The `@marketplace` suffix is dropped, while the leading `@` of a scoped package (`@deepseek-ai/dsh-x`) is kept.
        let logical_key = name
            .rfind('@')
            .filter(|i| *i > 0)
            .map_or(name.as_str(), |i| &name[..i])
            .to_lowercase();
        // an empty key would glue all such entries into one matrix row
        let logical_key = if logical_key.is_empty() {
            "?".to_owned()
        } else {
            logical_key
        };
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
            fs_named: false,
            target: None,
            src: None,
            can_edit: false,
            can_toggle: false,
            toggle_why: None,
            toggle_level: None,
        }
    }

    pub fn target(mut self, t: Target) -> Self {
        self.target = Some(t);
        self
    }

    pub fn src(mut self, s: Src) -> Self {
        self.src = Some(s);
        self
    }

    /// Mark "name from the file system" (see [`Entity::fs_named`]).
    pub fn fs_named(mut self) -> Self {
        self.fs_named = true;
        self
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
