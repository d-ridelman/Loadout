//! Единая модель (CONCEPT.md §3), урезанная до того, что нужно сканеру M0.

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

    /// Короткое имя для CLI и JSON (совпадает с `serde`).
    pub fn slug(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude-code",
            Client::ClaudeDesktop => "claude-desktop",
            Client::Codex => "codex",
            Client::Antigravity => "antigravity",
            Client::DeepSeek => "deepseek",
        }
    }

    /// Обратное к [`Client::slug`].
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
    /// `cordis.patch.yml` DeepSeek: правится только вынос и возврат записи по строкам (`yaml_edit`).
    Yaml,
}

/// Куда писать, чтобы переключить запись (R1): булев ключ в известном файле клиента.
/// Настоящий путь и сырые ключи; наружу не уходит (`#[serde(skip)]` у поля), в вывод идут только очищенные `origin`.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub file: std::path::PathBuf,
    pub format: Format,
    /// Ключи от корня файла до булева значения (`Flag`) или до самой записи (`Cut`, `Restore`).
    pub path: Vec<String>,
    /// `true` в файле значит «выключено» (`disableClaudeAiConnectors`).
    pub inverted: bool,
    pub kind: TargetKind,
}

/// Откуда вернуть вырезанную запись.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// Корзина Loadout (`<бэкапы>/trash/<id>.json`).
    Trash(String),
    /// Стэш владельца в том же файле (`_disabledMcpServers`): путь до объекта-стэша.
    Stash(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum TargetKind {
    /// Булев ключ.
    Flag,
    /// Включённая запись без флага: «выключить» вырезает её в корзину.
    Cut,
    /// Выключенная запись вне файла (корзина) или в стэше: «включить» возвращает её на место.
    Restore(Source),
}

/// Где лежит запись целиком (MCP): оттуда читается и копируется, и туда пишется правка.
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
    /// Только уже замаскированные данные: секретные значения сюда не попадают (см. mask.rs).
    pub detail: Value,
    /// Имя и указатель взяты из имени файла или каталога, а не из содержимого файла: слова-токены в них не прячем,
    /// иначе разные записи (`app-69f0dc45…` в каталоге Codex) сольются в одну строку `<masked>`.
    #[serde(skip)]
    pub fs_named: bool,
    /// Как переключить запись; `None` — переключатель не поддержан (см. [`crate::write::why_not`]).
    #[serde(skip)]
    pub target: Option<Target>,
    #[serde(skip)]
    pub src: Option<Src>,
    /// Запись можно править и копировать (есть `src`).
    pub can_edit: bool,
    /// Заполняется в конце скана из `target`: окно по нему решает, давать ли переключатель.
    pub can_toggle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle_why: Option<String>,
    /// Какой уровень записи нужен для переключения: `R1` (флаг) или `R2` (корзина).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle_level: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct ScanResult {
    pub entities: Vec<Entity>,
    pub warnings: Vec<String>,
    /// Счётчики по каталогам клиентов (резервные копии, битые ссылки); выводы делает Доктор.
    pub facts: crate::facts::Facts,
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
        // Суффикс `@маркетплейс` отбрасываем, а ведущую `@` областного пакета (`@deepseek-ai/dsh-x`) оставляем.
        let logical_key = name
            .rfind('@')
            .filter(|i| *i > 0)
            .map_or(name.as_str(), |i| &name[..i])
            .to_lowercase();
        // пустой ключ склеил бы все такие записи в одну строку матрицы
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

    /// Пометка «имя из файловой системы» (см. [`Entity::fs_named`]).
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
