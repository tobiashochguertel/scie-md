use std::{collections::BTreeSet, ops::Range};

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use toml_edit::{value, Document, DocumentMut, Item, Table, Value};

pub const TOML_NATIVE_DTO_VERSION: &str = "toml-native-dto-v1";
pub const TOML_NATIVE_PLANNER_VERSION: &str = "toml-edit-native-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum TomlPathSegment {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlSourceSpan {
    pub offset: usize,
    pub length: usize,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TomlSourceMapStatus {
    Valid,
    Invalid,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum TomlUnsupportedKind {
    ArrayOfTables,
    Comment,
    DottedKey,
    InlineTable,
    MultilineString,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlSourceMapDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub span: Option<TomlSourceSpan>,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlUnsupportedFeature {
    pub kind: TomlUnsupportedKind,
    pub code: String,
    pub message: String,
    pub path: Vec<TomlPathSegment>,
    pub pointer: String,
    pub display_path: String,
    pub span: Option<TomlSourceSpan>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlSourceMapNode {
    pub path: Vec<TomlPathSegment>,
    pub pointer: String,
    pub display_path: String,
    pub kind: String,
    pub value_type: String,
    pub span: Option<TomlSourceSpan>,
    pub value_span: Option<TomlSourceSpan>,
    pub key_span: Option<TomlSourceSpan>,
    pub editable_candidate: bool,
    pub editable_operations: Vec<String>,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlSourceMapSummary {
    pub node_count: usize,
    pub spanned_node_count: usize,
    pub scalar_node_count: usize,
    pub table_node_count: usize,
    pub array_of_tables_node_count: usize,
    pub unsupported_feature_count: usize,
    pub unsupported_kinds: Vec<TomlUnsupportedKind>,
    pub no_op_round_trip_preserved: bool,
    pub visual_writes_enabled: bool,
    pub boundary_status: String,
    pub command_scope: String,
    pub recommended_boundary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlSourceMapReport {
    pub dto_version: String,
    pub planner_version: String,
    pub status: TomlSourceMapStatus,
    pub value: Option<JsonValue>,
    pub diagnostics: Vec<TomlSourceMapDiagnostic>,
    pub nodes: Vec<TomlSourceMapNode>,
    pub unsupported_features: Vec<TomlUnsupportedFeature>,
    pub summary: TomlSourceMapSummary,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TomlMutationIntent {
    pub kind: String,
    pub path: Vec<TomlPathSegment>,
    pub new_value: Option<JsonValue>,
    pub new_key: Option<String>,
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TomlGuardedPatch {
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub expected_text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TomlMutationPlanReport {
    pub dto_version: String,
    pub planner_version: String,
    pub status: String,
    pub operation_id: String,
    pub path: Vec<TomlPathSegment>,
    pub patches: Vec<TomlGuardedPatch>,
    pub next_source: Option<String>,
    pub next_value: Option<JsonValue>,
    pub diagnostics: Vec<TomlSourceMapDiagnostic>,
    pub untouched_regions_exact: bool,
}

#[tauri::command]
pub fn inspect_toml_source_map(source_text: String) -> TomlSourceMapReport {
    inspect_toml_source_map_text(&source_text)
}

#[tauri::command]
pub fn plan_toml_mutation(source_text: String, intent: TomlMutationIntent) -> TomlMutationPlanReport {
    plan_toml_mutation_text(&source_text, intent)
}

pub fn inspect_toml_source_map_text(source: &str) -> TomlSourceMapReport {
    let document = match source.parse::<Document<String>>() {
        Ok(document) => document,
        Err(error) => {
            let span = error.span().map(|range| source_span(source, range));
            let diagnostic = TomlSourceMapDiagnostic {
                severity: "error".into(),
                code: "toml-source-map-parse-error".into(),
                message: "TOML source could not be parsed by the native engine.".into(),
                line: span.as_ref().map(|span| span.line),
                column: span.as_ref().map(|span| span.column),
                span,
            };
            return TomlSourceMapReport {
                dto_version: TOML_NATIVE_DTO_VERSION.into(),
                planner_version: TOML_NATIVE_PLANNER_VERSION.into(),
                status: TomlSourceMapStatus::Invalid,
                value: None,
                diagnostics: vec![diagnostic],
                nodes: Vec::new(),
                unsupported_features: Vec::new(),
                summary: TomlSourceMapSummary {
                    node_count: 0,
                    spanned_node_count: 0,
                    scalar_node_count: 0,
                    table_node_count: 0,
                    array_of_tables_node_count: 0,
                    unsupported_feature_count: 0,
                    unsupported_kinds: Vec::new(),
                    no_op_round_trip_preserved: false,
                    visual_writes_enabled: false,
                    boundary_status: boundary_status(),
                    command_scope: command_scope(),
                    recommended_boundary: recommended_boundary(),
                },
            };
        }
    };

    let mut nodes = Vec::new();
    let mut unsupported_features = collect_comment_features(source);
    collect_item(
        source,
        document.as_item(),
        Vec::new(),
        &mut nodes,
        &mut unsupported_features,
    );
    let unsupported_kinds = unsupported_features
        .iter()
        .map(|feature| feature.kind.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let no_op_round_trip_preserved = source
        .parse::<DocumentMut>()
        .map(|document| render_document_preserving_line_endings(&document, source) == source)
        .unwrap_or(false);

    TomlSourceMapReport {
        dto_version: TOML_NATIVE_DTO_VERSION.into(),
        planner_version: TOML_NATIVE_PLANNER_VERSION.into(),
        status: TomlSourceMapStatus::Valid,
        value: Some(json_from_item(document.as_item())),
        diagnostics: Vec::new(),
        summary: TomlSourceMapSummary {
            node_count: nodes.len(),
            spanned_node_count: nodes.iter().filter(|node| node.span.is_some()).count(),
            scalar_node_count: nodes.iter().filter(|node| node.kind == "scalar").count(),
            table_node_count: nodes.iter().filter(|node| node.kind == "table").count(),
            array_of_tables_node_count: nodes
                .iter()
                .filter(|node| node.kind == "array-of-tables")
                .count(),
            unsupported_feature_count: unsupported_features.len(),
            unsupported_kinds,
            no_op_round_trip_preserved,
            visual_writes_enabled: true,
            boundary_status: boundary_status(),
            command_scope: command_scope(),
            recommended_boundary: recommended_boundary(),
        },
        nodes,
        unsupported_features,
    }
}

fn collect_item(
    source: &str,
    item: &Item,
    path: Vec<TomlPathSegment>,
    nodes: &mut Vec<TomlSourceMapNode>,
    unsupported_features: &mut Vec<TomlUnsupportedFeature>,
) {
    let kind = item_kind(item);
    push_node(
        source,
        item.span(),
        path.clone(),
        kind,
        item.type_name(),
        nodes,
    );

    match item {
        Item::Table(table) => collect_table(source, table, path, nodes, unsupported_features),
        Item::ArrayOfTables(array_of_tables) => {
            unsupported_features.push(unsupported_feature(
                source,
                TomlUnsupportedKind::ArrayOfTables,
                "toml-array-table-readonly",
                "TOML arrays of tables need table-identity-aware source patches before visual edits are safe.",
                &path,
                array_of_tables.span(),
            ));
            for (index, table) in array_of_tables.iter().enumerate() {
                let mut child_path = path.clone();
                child_path.push(TomlPathSegment::Index(index));
                push_node(
                    source,
                    table.span(),
                    child_path.clone(),
                    "table",
                    "table",
                    nodes,
                );
                collect_table(source, table, child_path, nodes, unsupported_features);
            }
        }
        Item::Value(value) => collect_value(source, value, path, nodes, unsupported_features),
        Item::None => {}
    }
}

fn collect_table(
    source: &str,
    table: &Table,
    path: Vec<TomlPathSegment>,
    nodes: &mut Vec<TomlSourceMapNode>,
    unsupported_features: &mut Vec<TomlUnsupportedFeature>,
) {
    if table.is_dotted() {
        unsupported_features.push(unsupported_feature(
            source,
            TomlUnsupportedKind::DottedKey,
            "toml-dotted-key-readonly",
            "TOML dotted keys can reorder or expand into implicit tables and need a guarded patch planner.",
            &path,
            table.span(),
        ));
    }
    for (key, child) in table.iter() {
        let mut child_path = path.clone();
        child_path.push(TomlPathSegment::Key(key.to_string()));
        collect_item(source, child, child_path, nodes, unsupported_features);
        if let Some(node) = nodes.iter_mut().rev().find(|node| node.path == path_with_key(&path, key)) {
            node.key_span = table.key(key).and_then(|key| key.span()).map(|span| source_span(source, span));
            add_field_operations(node);
        }
    }
}

fn collect_value(
    source: &str,
    value: &Value,
    path: Vec<TomlPathSegment>,
    nodes: &mut Vec<TomlSourceMapNode>,
    unsupported_features: &mut Vec<TomlUnsupportedFeature>,
) {
    match value {
        Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                let mut child_path = path.clone();
                child_path.push(TomlPathSegment::Index(index));
                push_node(
                    source,
                    child.span(),
                    child_path.clone(),
                    value_kind(child),
                    child.type_name(),
                    nodes,
                );
                collect_value(source, child, child_path, nodes, unsupported_features);
            }
        }
        Value::InlineTable(table) => {
            unsupported_features.push(unsupported_feature(
                source,
                TomlUnsupportedKind::InlineTable,
                "toml-inline-table-readonly",
                "TOML inline tables need punctuation-aware source patches before visual edits are safe.",
                &path,
                table.span(),
            ));
            for (key, child) in table.iter() {
                let mut child_path = path.clone();
                child_path.push(TomlPathSegment::Key(key.to_string()));
                push_node(
                    source,
                    child.span(),
                    child_path.clone(),
                    value_kind(child),
                    child.type_name(),
                    nodes,
                );
                collect_value(source, child, child_path, nodes, unsupported_features);
            }
        }
        _ => {
            if is_multiline_string(source, value.span()) {
                unsupported_features.push(unsupported_feature(
                    source,
                    TomlUnsupportedKind::MultilineString,
                    "toml-multiline-string-readonly",
                    "TOML multiline string style and indentation must be preserved before visual edits are safe.",
                    &path,
                    value.span(),
                ));
                if let Some(node) = nodes.iter_mut().rev().find(|node| node.path == path) {
                    node.editable_operations.retain(|operation| operation != "replaceScalar");
                    node.editable_candidate = !node.editable_operations.is_empty();
                    if !node.editable_candidate { node.unsupported_reason = Some("Multiline TOML strings are source-only.".into()); }
                }
            }
        }
    }
}

fn push_node(
    source: &str,
    span: Option<Range<usize>>,
    path: Vec<TomlPathSegment>,
    kind: &str,
    value_type: &str,
    nodes: &mut Vec<TomlSourceMapNode>,
) {
    let span = span.map(|range| source_span(source, range));
    let editable_operations = editable_operations(kind, value_type, &path);
    nodes.push(TomlSourceMapNode {
        pointer: pointer_from_path(&path),
        display_path: display_path_from_path(&path),
        path,
        kind: kind.into(),
        value_type: value_type.into(),
        editable_candidate: !editable_operations.is_empty(),
        editable_operations,
        unsupported_reason: None,
        value_span: span.clone(),
        key_span: None,
        span,
    });
}

fn path_with_key(path: &[TomlPathSegment], key: &str) -> Vec<TomlPathSegment> {
    let mut result = path.to_vec();
    result.push(TomlPathSegment::Key(key.to_string()));
    result
}

fn editable_operations(kind: &str, value_type: &str, path: &[TomlPathSegment]) -> Vec<String> {
    let mut operations = Vec::new();
    if kind == "scalar" && !matches!(value_type, "datetime" | "date" | "time") {
        operations.push("replaceScalar".into());
    }
    if kind == "array" {
        operations.push("addArrayItem".into());
    }
    if kind == "table" {
        operations.push("addObjectField".into());
    }
    if matches!(path.last(), Some(TomlPathSegment::Index(_))) {
        operations.push("deleteArrayItem".into());
    }
    operations
}

fn add_field_operations(node: &mut TomlSourceMapNode) {
    if node.key_span.is_some() {
        node.editable_operations.push("renameObjectKey".into());
        node.editable_operations.push("deleteObjectField".into());
        node.editable_candidate = true;
    }
}

fn unsupported_feature(
    source: &str,
    kind: TomlUnsupportedKind,
    code: &str,
    message: &str,
    path: &[TomlPathSegment],
    span: Option<Range<usize>>,
) -> TomlUnsupportedFeature {
    TomlUnsupportedFeature {
        kind,
        code: code.into(),
        message: message.into(),
        path: path.to_vec(),
        pointer: pointer_from_path(path),
        display_path: display_path_from_path(path),
        span: span.map(|range| source_span(source, range)),
    }
}

fn collect_comment_features(source: &str) -> Vec<TomlUnsupportedFeature> {
    let mut features = Vec::new();
    let mut offset = 0;
    for line in source.split('\n') {
        if let Some(comment_index) = unquoted_comment_index(line) {
            features.push(TomlUnsupportedFeature {
                kind: TomlUnsupportedKind::Comment,
                code: "toml-comments-readonly".into(),
                message: "TOML comments are source-only and need targeted source patches.".into(),
                path: Vec::new(),
                pointer: String::new(),
                display_path: "$".into(),
                span: Some(source_span(
                    source,
                    offset + comment_index..offset + line.len(),
                )),
            });
        }
        offset += line.len() + 1;
    }
    features
}

fn unquoted_comment_index(line: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut previous = '\0';
    for (index, character) in line.char_indices() {
        if (quote == Some('"') && character == '"' && previous != '\\')
            || (quote == Some('\'') && character == '\'')
        {
            quote = None;
        } else if quote.is_none() && (character == '"' || character == '\'') {
            quote = Some(character);
        } else if quote.is_none() && character == '#' {
            return Some(index);
        }
        previous = character;
    }
    None
}

fn source_span(source: &str, range: Range<usize>) -> TomlSourceSpan {
    let start = range.start.min(source.len());
    let end = range.end.min(source.len()).max(start);
    let (line, column) = line_column_from_offset(source, start);
    TomlSourceSpan {
        offset: source[..start].encode_utf16().count(),
        length: source[start..end].encode_utf16().count(),
        line,
        column,
    }
}

fn line_column_from_offset(source: &str, offset: usize) -> (usize, usize) {
    let mut line = 1;
    let mut line_start = 0;
    for (index, character) in source.char_indices() {
        if index >= offset {
            break;
        }
        if character == '\n' {
            line += 1;
            line_start = index + 1;
        }
    }
    (line, source[line_start..offset.min(source.len())].encode_utf16().count() + 1)
}

fn item_kind(item: &Item) -> &'static str {
    match item {
        Item::None => "none",
        Item::Table(_) => "table",
        Item::ArrayOfTables(_) => "array-of-tables",
        Item::Value(value) => value_kind(value),
    }
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "array",
        Value::InlineTable(_) => "inline-table",
        _ => "scalar",
    }
}

fn is_multiline_string(source: &str, span: Option<Range<usize>>) -> bool {
    let Some(span) = span else {
        return false;
    };
    let Some(raw) = source.get(span) else {
        return false;
    };
    raw.trim_start().starts_with("\"\"\"") || raw.trim_start().starts_with("'''")
}

fn pointer_from_path(path: &[TomlPathSegment]) -> String {
    if path.is_empty() {
        return String::new();
    }
    path.iter()
        .map(|segment| format!("/{}", escape_pointer_segment(&segment_string(segment))))
        .collect::<Vec<_>>()
        .join("")
}

fn display_path_from_path(path: &[TomlPathSegment]) -> String {
    let mut display = "$".to_string();
    for segment in path {
        match segment {
            TomlPathSegment::Index(index) => display.push_str(&format!("[{index}]")),
            TomlPathSegment::Key(key) if is_identifier_like(key) => {
                display.push('.');
                display.push_str(key);
            }
            TomlPathSegment::Key(key) => {
                display.push('[');
                display.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"?\"".into()));
                display.push(']');
            }
        }
    }
    display
}

fn segment_string(segment: &TomlPathSegment) -> String {
    match segment {
        TomlPathSegment::Key(key) => key.clone(),
        TomlPathSegment::Index(index) => index.to_string(),
    }
}

fn escape_pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn is_identifier_like(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '$'
        })
}

fn recommended_boundary() -> String {
    "rust-toml-edit-source-map-command".into()
}

fn boundary_status() -> String {
    "production-source-preserving".into()
}

fn command_scope() -> String {
    "inspect-and-plan-guarded-patches".into()
}

fn json_from_item(item: &Item) -> JsonValue {
    match item {
        Item::None => JsonValue::Null,
        Item::Value(value) => json_from_value(value),
        Item::Table(table) => JsonValue::Object(table.iter().map(|(key, item)| (key.to_string(), json_from_item(item))).collect()),
        Item::ArrayOfTables(tables) => JsonValue::Array(tables.iter().map(|table| {
            JsonValue::Object(table.iter().map(|(key, item)| (key.to_string(), json_from_item(item))).collect())
        }).collect()),
    }
}

fn json_from_value(value: &Value) -> JsonValue {
    match value {
        Value::String(value) => JsonValue::String(value.value().clone()),
        Value::Integer(value) => JsonValue::Number((*value.value()).into()),
        Value::Float(value) => serde_json::Number::from_f64(*value.value()).map(JsonValue::Number).unwrap_or(JsonValue::Null),
        Value::Boolean(value) => JsonValue::Bool(*value.value()),
        Value::Datetime(value) => JsonValue::String(value.value().to_string()),
        Value::Array(array) => JsonValue::Array(array.iter().map(json_from_value).collect()),
        Value::InlineTable(table) => {
            let mut object = JsonMap::new();
            for (key, value) in table.iter() { object.insert(key.to_string(), json_from_value(value)); }
            JsonValue::Object(object)
        }
    }
}

pub fn plan_toml_mutation_text(source: &str, intent: TomlMutationIntent) -> TomlMutationPlanReport {
    let inspection = inspect_toml_source_map_text(source);
    if inspection.status != TomlSourceMapStatus::Valid {
        return rejected_plan(&intent, "toml-native-invalid-source", "TOML source is invalid.");
    }
    let pointer = pointer_from_path(&intent.path);
    let allowed = inspection.nodes.iter().find(|node| node.pointer == pointer)
        .is_some_and(|node| node.editable_operations.iter().any(|operation| operation == &intent.kind));
    if !allowed {
        return rejected_plan(&intent, "toml-native-operation-unsupported", "This TOML node is source-only for the requested operation.");
    }
    if intent.kind == "deleteObjectField" {
        if let Some(node) = inspection.nodes.iter().find(|node| node.path == intent.path) {
            if node_has_attached_comment(source, node) {
                return rejected_plan(&intent, "toml-native-comment-ownership", "The TOML field has attached comment decoration; use source mode.");
            }
        }
    }

    let next_source = if intent.kind == "renameObjectKey" {
        match plan_key_rename(source, &inspection, &intent) {
            Ok(source) => source,
            Err((code, message)) => return rejected_plan(&intent, code, message),
        }
    } else if intent.kind == "replaceScalar" {
        match plan_scalar_replace(source, &inspection, &intent) {
            Ok(source) => source,
            Err((code, message)) => return rejected_plan(&intent, code, message),
        }
    } else {
        let mut document = match source.parse::<DocumentMut>() {
            Ok(document) => document,
            Err(_) => return rejected_plan(&intent, "toml-native-invalid-source", "TOML source is invalid."),
        };
        if let Err((code, message)) = apply_document_mutation(document.as_item_mut(), &intent.path, &intent) {
            return rejected_plan(&intent, code, message);
        }
        render_document_preserving_line_endings(&document, source)
    };
    let next_document = match next_source.parse::<Document<String>>() {
        Ok(document) => document,
        Err(_) => return rejected_plan(&intent, "toml-native-postcondition-failed", "The planned TOML result did not parse."),
    };
    let patch = minimal_guarded_patch(source, &next_source);
    if patch.is_none() {
        return rejected_plan(&intent, "toml-native-no-change", "The requested TOML operation made no source change.");
    }
    let patch = patch.unwrap();
    if matches!(intent.kind.as_str(), "deleteObjectField" | "deleteArrayItem") && patch.expected_text.contains('#') {
        return rejected_plan(&intent, "toml-native-comment-ownership", "The deleted TOML node has comment decoration; use source mode.");
    }
    TomlMutationPlanReport {
        dto_version: TOML_NATIVE_DTO_VERSION.into(),
        planner_version: TOML_NATIVE_PLANNER_VERSION.into(),
        status: "planned".into(),
        operation_id: intent.kind,
        path: intent.path,
        patches: vec![patch],
        next_source: Some(next_source),
        next_value: Some(json_from_item(next_document.as_item())),
        diagnostics: Vec::new(),
        untouched_regions_exact: true,
    }
}

fn plan_scalar_replace(source: &str, inspection: &TomlSourceMapReport, intent: &TomlMutationIntent) -> Result<String, (&'static str, &'static str)> {
    let node = inspection.nodes.iter().find(|node| node.path == intent.path).ok_or(("toml-native-stale-path", "The TOML path no longer exists."))?;
    let span = node.value_span.as_ref().ok_or(("toml-native-value-span-unavailable", "The TOML value has no authoritative source span."))?;
    let from = utf16_to_byte_offset(source, span.offset).ok_or(("toml-native-value-span-invalid", "The TOML value span is invalid."))?;
    let to = utf16_to_byte_offset(source, span.offset + span.length).ok_or(("toml-native-value-span-invalid", "The TOML value span is invalid."))?;
    let raw = &source[from..to];
    let replacement = render_scalar_like(raw, intent.new_value.as_ref().ok_or(("toml-native-missing-value", "A replacement value is required."))?)?;
    let mut next = String::with_capacity(source.len() + replacement.len());
    next.push_str(&source[..from]); next.push_str(&replacement); next.push_str(&source[to..]);
    Ok(next)
}

fn render_scalar_like(raw: &str, input: &JsonValue) -> Result<String, (&'static str, &'static str)> {
    match input {
        JsonValue::String(text) if raw.starts_with('\'') && raw.ends_with('\'') && !text.chars().any(|character| matches!(character, '\'' | '\r' | '\n')) => Ok(format!("'{text}'")),
        JsonValue::String(text) => serde_json::to_string(text).map_err(|_| ("toml-native-value-unsupported", "The TOML string could not be represented.")),
        JsonValue::Bool(boolean) => Ok(boolean.to_string()),
        JsonValue::Number(number) => Ok(number.to_string()),
        _ => Err(("toml-native-value-unsupported", "Visual TOML operations accept scalar values only.")),
    }
}

fn rejected_plan(intent: &TomlMutationIntent, code: &str, message: &str) -> TomlMutationPlanReport {
    TomlMutationPlanReport {
        dto_version: TOML_NATIVE_DTO_VERSION.into(), planner_version: TOML_NATIVE_PLANNER_VERSION.into(),
        status: "rejected".into(), operation_id: intent.kind.clone(), path: intent.path.clone(), patches: Vec::new(),
        next_source: None, next_value: None, diagnostics: vec![TomlSourceMapDiagnostic {
            severity: "error".into(), code: code.into(), message: message.into(), span: None, line: None, column: None,
        }], untouched_regions_exact: false,
    }
}

fn plan_key_rename(source: &str, inspection: &TomlSourceMapReport, intent: &TomlMutationIntent) -> Result<String, (&'static str, &'static str)> {
    let new_key = intent.new_key.as_deref().ok_or(("toml-native-missing-key", "A replacement key is required."))?;
    if !is_bare_toml_key(new_key) { return Err(("toml-native-unsafe-key", "Visual key rename accepts bare TOML keys only.")); }
    let node = inspection.nodes.iter().find(|node| node.path == intent.path).ok_or(("toml-native-stale-path", "The TOML path no longer exists."))?;
    let span = node.key_span.as_ref().ok_or(("toml-native-key-span-unavailable", "The TOML key has no authoritative source span."))?;
    let from = utf16_to_byte_offset(source, span.offset).ok_or(("toml-native-key-span-invalid", "The TOML key span is invalid."))?;
    let to = utf16_to_byte_offset(source, span.offset + span.length).ok_or(("toml-native-key-span-invalid", "The TOML key span is invalid."))?;
    if !is_bare_toml_key(&source[from..to]) { return Err(("toml-native-key-decoration", "Quoted or decorated TOML keys are source-only for rename.")); }
    let mut next = String::with_capacity(source.len() + new_key.len());
    next.push_str(&source[..from]); next.push_str(new_key); next.push_str(&source[to..]);
    Ok(next)
}

fn apply_document_mutation(item: &mut Item, path: &[TomlPathSegment], intent: &TomlMutationIntent) -> Result<(), (&'static str, &'static str)> {
    match intent.kind.as_str() {
        "replaceScalar" => {
            let target = value_at_path_mut(item, path).ok_or(("toml-native-stale-path", "The TOML path no longer exists."))?;
            if !target.is_str() && !target.is_integer() && !target.is_float() && !target.is_bool() {
                return Err(("toml-native-scalar-unsupported", "This TOML scalar type is source-only."));
            }
            *target = json_to_toml_value(intent.new_value.as_ref().ok_or(("toml-native-missing-value", "A replacement value is required."))?)?;
        }
        "addObjectField" => {
            let table = table_at_path_mut(item, path).ok_or(("toml-native-table-unsupported", "This TOML table cannot be edited visually."))?;
            let key = intent.key.as_deref().ok_or(("toml-native-missing-key", "A field key is required."))?;
            if !is_bare_toml_key(key) || table.contains_key(key) { return Err(("toml-native-unsafe-key", "The TOML field key is invalid or already exists.")); }
            table.insert(key, Item::Value(json_to_toml_value(intent.new_value.as_ref().ok_or(("toml-native-missing-value", "A field value is required."))?)?));
        }
        "deleteObjectField" => {
            let (parent, key) = split_key_path(path)?;
            let table = table_at_path_mut(item, parent).ok_or(("toml-native-table-unsupported", "This TOML table cannot be edited visually."))?;
            table.remove(key).ok_or(("toml-native-stale-path", "The TOML field no longer exists."))?;
        }
        "addArrayItem" => {
            let array = value_at_path_mut(item, path).and_then(Value::as_array_mut).ok_or(("toml-native-array-unsupported", "This TOML array cannot be edited visually."))?;
            array.push(json_to_toml_value(intent.new_value.as_ref().ok_or(("toml-native-missing-value", "An array value is required."))?)?);
        }
        "deleteArrayItem" => {
            let (parent, index) = split_index_path(path)?;
            let array = value_at_path_mut(item, parent).and_then(Value::as_array_mut).ok_or(("toml-native-array-unsupported", "This TOML array cannot be edited visually."))?;
            if index >= array.len() { return Err(("toml-native-stale-path", "The TOML array item no longer exists.")); }
            array.remove(index);
        }
        _ => return Err(("toml-native-operation-unsupported", "This TOML operation is not supported.")),
    }
    Ok(())
}

fn value_at_path_mut<'a>(item: &'a mut Item, path: &[TomlPathSegment]) -> Option<&'a mut Value> {
    if path.is_empty() { return item.as_value_mut(); }
    match (&path[0], item) {
        (TomlPathSegment::Key(key), Item::Table(table)) => value_at_path_mut(table.get_mut(key)?, &path[1..]),
        (TomlPathSegment::Index(index), Item::ArrayOfTables(tables)) => table_value_at_path_mut(tables.get_mut(*index)?, &path[1..]),
        (_, Item::Value(value)) => value_value_at_path_mut(value, path),
        _ => None,
    }
}

fn table_value_at_path_mut<'a>(table: &'a mut Table, path: &[TomlPathSegment]) -> Option<&'a mut Value> {
    let TomlPathSegment::Key(key) = path.first()? else { return None; };
    value_at_path_mut(table.get_mut(key)?, &path[1..])
}

fn value_value_at_path_mut<'a>(value: &'a mut Value, path: &[TomlPathSegment]) -> Option<&'a mut Value> {
    if path.is_empty() { return Some(value); }
    match (&path[0], value) {
        (TomlPathSegment::Index(index), Value::Array(array)) => value_value_at_path_mut(array.get_mut(*index)?, &path[1..]),
        (TomlPathSegment::Key(key), Value::InlineTable(table)) => value_value_at_path_mut(table.get_mut(key)?, &path[1..]),
        _ => None,
    }
}

fn table_at_path_mut<'a>(item: &'a mut Item, path: &[TomlPathSegment]) -> Option<&'a mut Table> {
    if path.is_empty() { return item.as_table_mut(); }
    match (&path[0], item) {
        (TomlPathSegment::Key(key), Item::Table(table)) => table_at_path_mut(table.get_mut(key)?, &path[1..]),
        (TomlPathSegment::Index(index), Item::ArrayOfTables(tables)) => {
            let table = tables.get_mut(*index)?;
            if path.len() == 1 { Some(table) } else { table_at_path_in_table_mut(table, &path[1..]) }
        }
        _ => None,
    }
}

fn table_at_path_in_table_mut<'a>(table: &'a mut Table, path: &[TomlPathSegment]) -> Option<&'a mut Table> {
    if path.is_empty() { return Some(table); }
    let TomlPathSegment::Key(key) = path.first()? else { return None; };
    table_at_path_mut(table.get_mut(key)?, &path[1..])
}

fn split_key_path(path: &[TomlPathSegment]) -> Result<(&[TomlPathSegment], &str), (&'static str, &'static str)> {
    match path.split_last() {
        Some((TomlPathSegment::Key(key), parent)) => Ok((parent, key)),
        _ => Err(("toml-native-path-kind", "The TOML path is not an object field.")),
    }
}

fn split_index_path(path: &[TomlPathSegment]) -> Result<(&[TomlPathSegment], usize), (&'static str, &'static str)> {
    match path.split_last() {
        Some((TomlPathSegment::Index(index), parent)) => Ok((parent, *index)),
        _ => Err(("toml-native-path-kind", "The TOML path is not an array item.")),
    }
}

fn json_to_toml_value(input: &JsonValue) -> Result<Value, (&'static str, &'static str)> {
    match input {
        JsonValue::String(value_text) => Ok(value(value_text.clone()).into_value().unwrap()),
        JsonValue::Bool(boolean) => Ok(value(*boolean).into_value().unwrap()),
        JsonValue::Number(number) if number.is_i64() => Ok(value(number.as_i64().unwrap()).into_value().unwrap()),
        JsonValue::Number(number) => number.as_f64().map(|number| value(number).into_value().unwrap()).ok_or(("toml-native-value-unsupported", "The TOML number is not finite.")),
        _ => Err(("toml-native-value-unsupported", "Visual TOML operations accept scalar values only.")),
    }
}

fn minimal_guarded_patch(source: &str, next: &str) -> Option<TomlGuardedPatch> {
    if source == next { return None; }
    let mut prefix = 0;
    for ((left_index, left), (_, right)) in source.char_indices().zip(next.char_indices()) {
        if left != right { break; }
        prefix = left_index + left.len_utf8();
    }
    let source_tail = &source[prefix..]; let next_tail = &next[prefix..];
    let mut suffix = 0;
    for (left, right) in source_tail.chars().rev().zip(next_tail.chars().rev()) {
        if left != right { break; }
        suffix += left.len_utf8();
    }
    let source_to = source.len() - suffix; let next_to = next.len() - suffix;
    Some(TomlGuardedPatch {
        from: source[..prefix].encode_utf16().count(), to: source[..source_to].encode_utf16().count(),
        insert: next[prefix..next_to].to_string(), expected_text: source[prefix..source_to].to_string(),
    })
}

fn utf16_to_byte_offset(source: &str, offset: usize) -> Option<usize> {
    if offset == 0 { return Some(0); }
    let mut units = 0;
    for (index, character) in source.char_indices() {
        units += character.len_utf16();
        if units == offset { return Some(index + character.len_utf8()); }
        if units > offset { return None; }
    }
    (units == offset).then_some(source.len())
}

fn is_bare_toml_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
}

fn node_has_attached_comment(source: &str, node: &TomlSourceMapNode) -> bool {
    let Some(span) = node.key_span.as_ref().or(node.value_span.as_ref()) else { return true; };
    let Some(offset) = utf16_to_byte_offset(source, span.offset) else { return true; };
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = source[offset..].find('\n').map_or(source.len(), |index| offset + index);
    if unquoted_comment_index(&source[line_start..line_end]).is_some() { return true; }
    let before = source[..line_start].trim_end_matches(['\r', '\n']);
    let previous_start = before.rfind('\n').map_or(0, |index| index + 1);
    before[previous_start..].trim_start().starts_with('#')
}

fn render_document_preserving_line_endings(document: &DocumentMut, source: &str) -> String {
    let rendered = document.to_string();
    if source.contains("\r\n") && !source.replace("\r\n", "").contains('\n') {
        rendered.replace('\n', "\r\n")
    } else {
        rendered
    }
}

#[cfg(test)]
mod tests {
    use super::{inspect_toml_source_map_text, plan_toml_mutation_text, TomlMutationIntent, TomlPathSegment, TomlSourceMapStatus, TomlUnsupportedKind};
    use serde_json::json;

    #[test]
    fn returns_spanned_nodes_with_guarded_visual_operations() {
        let source = [
            "# catalog",
            "title = \"Dataset\"",
            "[server]",
            "port = 8080",
            "",
        ]
        .join("\n");
        let report = inspect_toml_source_map_text(&source);

        assert_eq!(report.status, TomlSourceMapStatus::Valid);
        assert!(report.summary.no_op_round_trip_preserved);
        assert!(report.summary.visual_writes_enabled);
        assert_eq!(
            report.summary.boundary_status,
            "production-source-preserving"
        );
        assert_eq!(report.summary.command_scope, "inspect-and-plan-guarded-patches");
        assert_eq!(
            report.summary.recommended_boundary,
            "rust-toml-edit-source-map-command"
        );
        assert!(report.summary.node_count >= 4);
        assert!(report.summary.spanned_node_count >= 3);
        assert!(report.nodes.iter().any(|node| {
            node.pointer == "/server/port"
                && node.kind == "scalar"
                && node.span.as_ref().is_some_and(|span| span.line == 4)
        }));
        assert!(report.unsupported_features.iter().any(|feature| {
            feature.kind == TomlUnsupportedKind::Comment
                && feature.span.as_ref().is_some_and(|span| span.line == 1)
        }));
    }

    #[test]
    fn classifies_toml_preservation_blockers() {
        let source = [
            "owner.name = \"Ada\"",
            "inline = { ok = true }",
            "notes = \"\"\"",
            "Line one",
            "\"\"\"",
            "[[products]]",
            "sku = \"A-001\"",
            "",
        ]
        .join("\n");
        let report = inspect_toml_source_map_text(&source);

        assert_eq!(report.status, TomlSourceMapStatus::Valid);
        assert!(report
            .summary
            .unsupported_kinds
            .contains(&TomlUnsupportedKind::DottedKey));
        assert!(report
            .summary
            .unsupported_kinds
            .contains(&TomlUnsupportedKind::InlineTable));
        assert!(report
            .summary
            .unsupported_kinds
            .contains(&TomlUnsupportedKind::MultilineString));
        assert!(report
            .summary
            .unsupported_kinds
            .contains(&TomlUnsupportedKind::ArrayOfTables));
        assert!(report.nodes.iter().any(|node| node.pointer == "/products/0/sku" && node.editable_operations.contains(&"replaceScalar".into())));
        assert!(report.nodes.iter().find(|node| node.pointer == "/notes").is_some_and(|node| !node.editable_operations.contains(&"replaceScalar".into())));
    }

    #[test]
    fn reports_invalid_toml_without_source_nodes() {
        let report = inspect_toml_source_map_text("name = \"A\"\nname = \"B\"\n");

        assert_eq!(report.status, TomlSourceMapStatus::Invalid);
        assert_eq!(report.nodes.len(), 0);
        assert_eq!(report.summary.node_count, 0);
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].severity, "error");
    }

    #[test]
    fn plans_guarded_scalar_key_table_and_array_operations_without_writing_files() {
        let source = "# Ω\r\ntitle = \"Old\"\r\nitems = [1, 2]\r\n[server]\r\nport = 8080\r\n";
        let scalar = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "replaceScalar".into(), path: vec![TomlPathSegment::Key("title".into())],
            new_value: Some(json!("New")), new_key: None, key: None,
        });
        assert_eq!(scalar.status, "planned");
        assert_eq!(scalar.patches.len(), 1);
        assert!(scalar.next_source.as_deref().is_some_and(|next| next.contains("title = \"New\"\r\n") && next.starts_with("# Ω\r\n")));

        let renamed = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "renameObjectKey".into(), path: vec![TomlPathSegment::Key("title".into())],
            new_value: None, new_key: Some("heading".into()), key: None,
        });
        assert!(renamed.next_source.as_deref().is_some_and(|next| next.contains("heading = \"Old\"")));

        let added = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "addObjectField".into(), path: vec![TomlPathSegment::Key("server".into())],
            new_value: Some(json!(true)), new_key: None, key: Some("enabled".into()),
        });
        assert!(added.next_source.as_deref().is_some_and(|next| next.contains("enabled = true")));

        let appended = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "addArrayItem".into(), path: vec![TomlPathSegment::Key("items".into())],
            new_value: Some(json!(3)), new_key: None, key: None,
        });
        assert!(appended.next_source.as_deref().is_some_and(|next| next.contains("items = [1, 2, 3]")));

        let deleted_item = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "deleteArrayItem".into(), path: vec![TomlPathSegment::Key("items".into()), TomlPathSegment::Index(0)],
            new_value: None, new_key: None, key: None,
        });
        assert_eq!(deleted_item.next_value.as_ref().and_then(|value| value.get("items")), Some(&json!([2])));
        assert!(deleted_item.next_source.as_deref().is_some_and(|next| {
            next.starts_with(source.split("items =").next().unwrap())
                && next.ends_with("[server]\r\nport = 8080\r\n")
        }));

        let deleted_field = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "deleteObjectField".into(), path: vec![TomlPathSegment::Key("server".into()), TomlPathSegment::Key("port".into())],
            new_value: None, new_key: None, key: None,
        });
        assert!(deleted_field.next_source.as_deref().is_some_and(|next| !next.contains("port =")));
    }

    #[test]
    fn native_errors_are_typed_and_content_free() {
        let secret = "api_token = [\"SECRET-CONTENT\"";
        let report = inspect_toml_source_map_text(secret);
        assert_eq!(report.status, TomlSourceMapStatus::Invalid);
        assert!(report.diagnostics.iter().all(|diagnostic| !diagnostic.message.contains("SECRET-CONTENT")));
    }

    #[test]
    fn dates_times_and_quoted_keys_have_explicit_source_only_operation_status() {
        let source = "\"quoted key\" = 1\nmeasured_at = 2026-07-22T08:30:45-04:00\n";
        let report = inspect_toml_source_map_text(source);
        let datetime = report.nodes.iter().find(|node| node.pointer == "/measured_at").unwrap();
        assert!(!datetime.editable_operations.contains(&"replaceScalar".into()));
        let rename = plan_toml_mutation_text(source, TomlMutationIntent {
            kind: "renameObjectKey".into(), path: vec![TomlPathSegment::Key("quoted key".into())],
            new_value: None, new_key: Some("renamed".into()), key: None,
        });
        assert_eq!(rename.status, "rejected");
        assert_eq!(rename.diagnostics[0].code, "toml-native-key-decoration");
    }
}
