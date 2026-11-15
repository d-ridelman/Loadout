//! Различия между двумя сканами: только id записей (в событиях сторожа сырые пути и значения не передаются).

use crate::model::ScanResult;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    pub warnings_changed: bool,
    pub facts_changed: bool,
}

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.removed.is_empty()
            && self.changed.is_empty()
            && !self.warnings_changed
            && !self.facts_changed
    }
}

/// Что изменилось между `old` и `new`. Запись «изменилась», если при том же id отличается хоть одно поле.
pub fn diff(old: &ScanResult, new: &ScanResult) -> Diff {
    let before: HashMap<&str, _> = old.entities.iter().map(|e| (e.id.as_str(), e)).collect();
    let after: HashMap<&str, _> = new.entities.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut d = Diff {
        warnings_changed: old.warnings != new.warnings,
        facts_changed: old.facts != new.facts,
        ..Diff::default()
    };
    for e in &new.entities {
        match before.get(e.id.as_str()) {
            None => d.added.push(e.id.clone()),
            Some(prev) if *prev != e => d.changed.push(e.id.clone()),
            Some(_) => {}
        }
    }
    d.removed = old
        .entities
        .iter()
        .filter(|e| !after.contains_key(e.id.as_str()))
        .map(|e| e.id.clone())
        .collect();
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Client, Entity, Kind, State};

    fn e(name: &str, state: State) -> Entity {
        Entity::new(
            Client::Codex,
            Kind::Plugin,
            "user",
            name,
            state,
            "~/f",
            format!("/{name}"),
        )
    }

    fn scan(entities: Vec<Entity>) -> ScanResult {
        ScanResult {
            entities,
            ..ScanResult::default()
        }
    }

    #[test]
    fn detects_added_removed_changed() {
        let old = scan(vec![e("a", State::On), e("b", State::On)]);
        let new = scan(vec![e("a", State::Off), e("c", State::On)]);
        let d = diff(&old, &new);
        assert_eq!(
            d.changed,
            [e("a", State::On).id],
            "то же id, другое состояние"
        );
        assert_eq!(d.added, [e("c", State::On).id]);
        assert_eq!(d.removed, [e("b", State::On).id]);
    }

    #[test]
    fn identical_scans_give_an_empty_diff() {
        let a = scan(vec![e("a", State::On)]);
        assert!(diff(&a, &a.clone()).is_empty());
    }

    #[test]
    fn warnings_and_facts_count_as_changes() {
        let a = scan(vec![]);
        let mut b = scan(vec![]);
        b.warnings.push("x".into());
        assert!(diff(&a, &b).warnings_changed);
    }
}
