#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

static APP_STATE: Lazy<AppState> = Lazy::new(AppState::default);
const DEFAULT_WORKSPACE_SLUG: &str = "content-shotgun";
const LEGACY_DEFAULT_WORKSPACE_SLUG: &str = "dockhub";
const DEFAULT_WORKSPACE_TITLE: &str = "Content Shotgun";
const DEFAULT_WORKSPACE_CHANNELS: [&str; 6] = ["instagram", "facebook", "email", "blog", "ad", "sms"];
const DEFAULT_PARENT_INSTRUCTIONS_MD: &str = include_str!("../../contracts/templates/instructions.md");
const DEFAULT_WORKSPACE_BRIEF_MD: &str = include_str!("../../contracts/templates/workspace.md");
const DEFAULT_MASTER_MD: &str = include_str!("../../contracts/templates/master.md");

struct AppState {
    inner: Mutex<InnerState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(InnerState::default()),
        }
    }
}

#[derive(Default)]
struct InnerState {
    root_path: Option<PathBuf>,
    inbox_path: Option<PathBuf>,
    projects_path: Option<PathBuf>,
    exports_path: Option<PathBuf>,
    db_path: Option<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    watcher_error: Option<String>,
}

#[derive(Serialize)]
struct BootstrapResponse {
    root_path: String,
    inbox_path: String,
    projects_path: String,
    exports_path: String,
}

#[derive(Serialize)]
struct WatcherStatus {
    watching: bool,
    inbox_path: String,
    last_error: Option<String>,
}

#[derive(Serialize)]
struct Project {
    id: i64,
    name: String,
    slug: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct Task {
    id: i64,
    project_id: i64,
    title: String,
    slug: String,
    status: String,
    task_type: Option<String>,
    priority: Option<String>,
    due_at: Option<String>,
    source: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct ContentFile {
    id: i64,
    task_id: i64,
    project_id: i64,
    rel_path: String,
    abs_path: String,
    format: String,
    checksum: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct EventLog {
    id: i64,
    kind: String,
    payload_json: String,
    created_at: String,
}

#[derive(Deserialize, Default)]
struct TaskManifest {
    title: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct DerivativeWorkflowState {
    status: Option<String>,
    notes: Option<String>,
    deployed_channels: Option<Vec<String>>,
    #[serde(default)]
    reviewed: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct MasterWorkflowState {
    status: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct DeploymentEntry {
    destination: String,
    date: String,
    url: Option<String>,
    notes: Option<String>,
    created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TopicMetadata {
    tags: Option<Vec<String>>,
    #[serde(default)]
    master: Option<MasterWorkflowState>,
    files: Option<std::collections::HashMap<String, DerivativeWorkflowState>>,
    #[serde(default)]
    deployments: Option<std::collections::HashMap<String, Vec<DeploymentEntry>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DerivativeEntry {
    rel_path: String,
    title: String,
    kind: String,
    status: String,
    deployed_count: usize,
    deployed_channels: Vec<String>,
    modified_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AssetEntry {
    rel_path: String,
    abs_path: String,
    modified_at: i64,
    is_image: bool,
    is_video: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TopicSummary {
    slug: String,
    title: String,
    folder_path: String,
    last_modified: i64,
    last_agent_write: i64,
    topic_status: String,
    tags: Vec<String>,
    review_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TopicDetail {
    slug: String,
    title: String,
    folder_path: String,
    last_modified: i64,
    last_agent_write: i64,
    topic_status: String,
    tags: Vec<String>,
    master_file: Option<String>,
    master_status: String,
    master_modified_at: Option<i64>,
    derivatives: Vec<DerivativeEntry>,
    assets: Vec<AssetEntry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DerivativeState {
    status: String,
    notes: String,
    deployed_channels: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    slug: String,
    title: String,
    path: String,
    channels: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceConfig {
    title: Option<String>,
    channels: Option<Vec<String>>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn unix_mtime(path: &Path) -> i64 {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn humanize_slug(slug: &str) -> String {
    slug.split('-')
        .filter(|v| !v.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn normalize_workspace_root(input: &Path) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut root = if input.is_absolute() {
        input.to_path_buf()
    } else {
        let candidate = cwd.join(input);
        let in_src_tauri = cwd
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == "src-tauri")
            .unwrap_or(false);
        if in_src_tauri {
            let parent_candidate = cwd.parent().unwrap_or(&cwd).join(input);
            parent_candidate
        } else {
            candidate
        }
    };

    if !root.exists() {
        let trimmed = input.to_string_lossy().trim_start_matches('/').to_string();
        if !trimmed.is_empty() {
            let candidate = cwd.join(&trimmed);
            if candidate.exists() {
                root = candidate;
            } else if cwd
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n == "src-tauri")
                .unwrap_or(false)
            {
                let parent_candidate = cwd.parent().unwrap_or(&cwd).join(&trimmed);
                if parent_candidate.exists() {
                    root = parent_candidate;
                }
            }
        }
    }

    if root.is_file() {
        if let Some(parent) = root.parent() {
            root = parent.to_path_buf();
        }
    }
    if root
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("inbox"))
        .unwrap_or(false)
    {
        return root.parent().unwrap_or(&root).to_path_buf();
    }
    if let Some(parent) = root.parent() {
        if parent
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("inbox"))
            .unwrap_or(false)
        {
            return parent.parent().unwrap_or(parent).to_path_buf();
        }
    }
    root
}

fn unique_name_in_dir(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    for i in 2..10_000 {
        let next_name = if ext.is_empty() {
            format!("{}-{}", stem, i)
        } else {
            format!("{}-{}.{}", stem, i, ext)
        };
        let next = dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{}-copy", stem))
}

fn normalize_topic_rel_path(rel_path: &str) -> Result<String> {
    let trimmed = rel_path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(anyhow!("path is empty"));
    }
    if trimmed.starts_with('/') {
        return Err(anyhow!("absolute paths are not allowed"));
    }
    let candidate = Path::new(&trimmed);
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(anyhow!("parent path segments are not allowed"));
    }
    Ok(trimmed)
}

fn read_topic_metadata(topic_dir: &Path) -> TopicMetadata {
    let raw = fs::read_to_string(topic_dir.join("topic.json"));
    match raw {
        Ok(content) => serde_json::from_str::<TopicMetadata>(&content).unwrap_or_default(),
        Err(_) => TopicMetadata::default(),
    }
}

fn write_topic_metadata(topic_dir: &Path, metadata: &TopicMetadata) -> Result<()> {
    fs::write(
        topic_dir.join("topic.json"),
        serde_json::to_vec_pretty(metadata)?,
    )?;
    Ok(())
}

fn default_topic_metadata() -> TopicMetadata {
    TopicMetadata {
        tags: Some(vec![]),
        master: Some(MasterWorkflowState {
            status: Some("Draft".to_string()),
        }),
        files: Some(std::collections::HashMap::new()),
        deployments: None,
    }
}

fn ensure_text_file_if_missing(path: &Path, content: &str) -> Result<()> {
    if path.exists() {
        if path.is_file() {
            return Ok(());
        }
        return Err(anyhow!(
            "expected file but found directory: {}",
            path.to_string_lossy()
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

fn ensure_topic_contract_files(topic_dir: &Path) -> Result<()> {
    fs::create_dir_all(topic_dir)?;
    fs::create_dir_all(topic_dir.join("assets"))?;
    if !topic_dir.join("topic.json").exists() {
        write_topic_metadata(topic_dir, &default_topic_metadata())?;
    }
    Ok(())
}

fn topic_contract_block_reason(rel_path: &str) -> Option<&'static str> {
    if rel_path.eq_ignore_ascii_case("topic.json") {
        return Some(
            "topic.json is protected contract metadata and cannot be changed with this action",
        );
    }
    if rel_path.eq_ignore_ascii_case("master.md") {
        return Some(
            "master.md is a required contract file and cannot be changed with this action; use the master update flow instead",
        );
    }
    let lower = rel_path.to_ascii_lowercase();
    if lower == "assets" || lower.starts_with("assets/") {
        return Some("assets/ is protected in this flow; add assets via the add-assets operation");
    }
    None
}

fn render_blank_master_template(topic_name: &str, topic_slug: &str) -> String {
    DEFAULT_MASTER_MD
        .replace("{{TOPIC_TITLE}}", topic_name)
        .replace("{{TOPIC_SLUG}}", topic_slug)
}

fn delete_topic_master_and_derivatives(topic_dir: &Path) -> Result<usize> {
    let master_path = topic_dir.join("master.md");
    if !master_path.exists() {
        return Err(anyhow!("master.md not found"));
    }

    let mut derivative_paths: Vec<(String, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(topic_dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        let rel = relative_unix(topic_dir, &path);
        let lower = rel.to_ascii_lowercase();
        if lower == "topic.json" || lower == "master.md" || lower.starts_with("assets/") {
            continue;
        }
        derivative_paths.push((rel, path));
    }

    for (_, derivative) in &derivative_paths {
        fs::remove_file(derivative)?;
    }
    fs::remove_file(&master_path)?;

    let mut metadata = read_topic_metadata(topic_dir);
    if let Some(files) = metadata.files.as_mut() {
        files.retain(|rel, _| topic_dir.join(rel).exists());
    }
    if let Some(deployments) = metadata.deployments.as_mut() {
        deployments.retain(|rel, _| topic_dir.join(rel).exists());
    }
    metadata.master = Some(MasterWorkflowState {
        status: Some("Draft".to_string()),
    });
    write_topic_metadata(topic_dir, &metadata)?;

    let assets_root = topic_dir.join("assets");
    let mut dirs: Vec<PathBuf> = walkdir::WalkDir::new(topic_dir)
        .min_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .map(|entry| entry.path().to_path_buf())
        .collect();
    dirs.sort_by_key(|dir| std::cmp::Reverse(dir.components().count()));
    for dir in dirs {
        if dir == assets_root || dir.starts_with(&assets_root) {
            continue;
        }
        if fs::read_dir(&dir)?.next().is_none() {
            fs::remove_dir(&dir)?;
        }
    }

    Ok(derivative_paths.len())
}

fn topic_has_master_file(topic_dir: &Path) -> bool {
    topic_dir.join("master.md").exists()
        || topic_dir.join("master.html").exists()
        || topic_dir.join("master.htm").exists()
}

fn ensure_master_metadata(topic_dir: &Path, metadata: &mut TopicMetadata) -> Result<()> {
    if !topic_has_master_file(topic_dir) {
        return Ok(());
    }
    let has_master_status = metadata
        .master
        .as_ref()
        .and_then(|master| master.status.as_deref())
        .is_some();
    if has_master_status {
        return Ok(());
    }
    metadata.master = Some(MasterWorkflowState {
        status: Some("Draft".to_string()),
    });
    write_topic_metadata(topic_dir, metadata)?;
    Ok(())
}

fn is_content_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "html" | "md" | "txt" | "htm"
            )
        })
        .unwrap_or(false)
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif"
            )
        })
        .unwrap_or(false)
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "mov" | "qt" | "mp4" | "m4v" | "webm"
            )
        })
        .unwrap_or(false)
}

fn relative_unix(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn derivative_kind(rel_path: &str) -> String {
    let lower = rel_path.to_ascii_lowercase();
    if lower.contains("blog") {
        "Blog".to_string()
    } else if lower.contains("email") {
        "Email".to_string()
    } else if lower.contains("social")
        || lower.contains("linkedin")
        || lower.contains("instagram")
        || lower.contains("facebook")
    {
        "Social".to_string()
    } else {
        "General".to_string()
    }
}

fn display_title_from_filename(path: &str) -> String {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    humanize_slug(&slugify(stem))
}

fn normalize_derivative_status(value: Option<&str>) -> String {
    let raw = value.unwrap_or("Draft").trim();
    if raw.eq_ignore_ascii_case("deployed") {
        "Deployed".to_string()
    } else if raw.eq_ignore_ascii_case("revised") || raw.eq_ignore_ascii_case("ready") {
        "Revised".to_string()
    } else {
        "Draft".to_string()
    }
}

fn normalize_master_status(value: Option<&str>) -> String {
    let raw = value.unwrap_or("Draft").trim();
    if raw.eq_ignore_ascii_case("ready") || raw.eq_ignore_ascii_case("revised") {
        "Ready".to_string()
    } else {
        "Draft".to_string()
    }
}

fn normalize_channels(input: Vec<String>) -> Vec<String> {
    let mut dedup = HashSet::new();
    input
        .into_iter()
        .map(|channel| channel.trim().to_string())
        .filter(|channel| !channel.is_empty())
        .filter(|channel| dedup.insert(channel.to_ascii_lowercase()))
        .collect()
}

fn default_channels_for_workspace_slug(slug: &str) -> Vec<String> {
    if slug.eq_ignore_ascii_case(DEFAULT_WORKSPACE_SLUG)
        || slug.eq_ignore_ascii_case(LEGACY_DEFAULT_WORKSPACE_SLUG)
    {
        DEFAULT_WORKSPACE_CHANNELS
            .iter()
            .map(|channel| (*channel).to_string())
            .collect()
    } else {
        vec![]
    }
}

fn resolve_workspace_channels(slug: &str, channels: Option<Vec<String>>) -> Vec<String> {
    let normalized = normalize_channels(channels.unwrap_or_default());
    if normalized.is_empty() {
        return default_channels_for_workspace_slug(slug);
    }
    normalized
}

fn deployed_channels_for_file(rel_path: &str, metadata: &TopicMetadata) -> Vec<String> {
    let from_state = metadata
        .files
        .as_ref()
        .and_then(|m| m.get(rel_path))
        .and_then(|state| state.deployed_channels.clone())
        .map(normalize_channels)
        .unwrap_or_default();
    if !from_state.is_empty() {
        return from_state;
    }

    metadata
        .deployments
        .as_ref()
        .and_then(|m| m.get(rel_path))
        .map(|entries| {
            normalize_channels(
                entries
                    .iter()
                    .map(|entry| entry.destination.clone())
                    .collect::<Vec<String>>(),
            )
        })
        .unwrap_or_default()
}

fn derive_file_status(
    rel_path: &str,
    metadata: &TopicMetadata,
    modified_at: i64,
    _last_scan_cutoff: i64,
) -> String {
    let deployed_channels = deployed_channels_for_file(rel_path, metadata);
    if !deployed_channels.is_empty() {
        return "Deployed".to_string();
    }
    if let Some(status) = metadata
        .files
        .as_ref()
        .and_then(|m| m.get(rel_path))
        .and_then(|s| s.status.as_deref())
    {
        return normalize_derivative_status(Some(status));
    }
    let _ = modified_at;
    "Draft".to_string()
}

fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = false;
    for ch in input.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn db_conn(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path).context("failed opening sqlite")?;
    conn.busy_timeout(Duration::from_secs(3))
        .context("failed configuring sqlite busy timeout")?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          slug TEXT NOT NULL,
          status TEXT NOT NULL,
          task_type TEXT,
          priority TEXT,
          due_at TEXT,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, slug),
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          rel_path TEXT NOT NULL,
          abs_path TEXT NOT NULL,
          format TEXT NOT NULL,
          checksum TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(task_id, rel_path),
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS exports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          export_path TEXT NOT NULL,
          formats TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        "#,
    )?;
    Ok(())
}

fn ensure_workspace(root: &Path) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf)> {
    let inbox = root.join("inbox");
    let projects = root.join("projects");
    let exports = root.join("exports");
    let data = root.join("data");
    let knowledge = root.join("knowledge");

    fs::create_dir_all(&inbox)?;
    fs::create_dir_all(&projects)?;
    fs::create_dir_all(&exports)?;
    fs::create_dir_all(&data)?;
    fs::create_dir_all(&knowledge)?;
    ensure_text_file_if_missing(&knowledge.join("workspace.md"), DEFAULT_WORKSPACE_BRIEF_MD)?;

    Ok((inbox, projects, exports, data.join("app.db")))
}

fn workspace_parent_root(input: &Path) -> PathBuf {
    normalize_workspace_root(input)
}

fn ensure_workspace_parent_contract(parent_root: &Path) -> Result<()> {
    fs::create_dir_all(parent_root)?;
    ensure_text_file_if_missing(
        &parent_root.join("instructions.md"),
        DEFAULT_PARENT_INSTRUCTIONS_MD,
    )?;
    fs::create_dir_all(parent_root.join("workspaces"))?;
    Ok(())
}

fn workspace_parent_from_workspace_root(workspace_root: &Path) -> Option<PathBuf> {
    let container = workspace_root.parent()?;
    if !container
        .file_name()
        .and_then(|n| n.to_str())
        .map(|name| name.eq_ignore_ascii_case("workspaces"))
        .unwrap_or(false)
    {
        return None;
    }
    container.parent().map(|parent| parent.to_path_buf())
}

fn workspace_roots_container(parent_root: &Path) -> PathBuf {
    parent_root.join("workspaces")
}

fn workspace_root_path(parent_root: &Path, slug: &str) -> PathBuf {
    workspace_roots_container(parent_root).join(slugify(slug))
}

fn workspace_config_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join("workspace.json")
}

fn read_workspace_config(workspace_root: &Path) -> WorkspaceConfig {
    let raw = fs::read_to_string(workspace_config_path(workspace_root));
    match raw {
        Ok(content) => serde_json::from_str::<WorkspaceConfig>(&content).unwrap_or_default(),
        Err(_) => WorkspaceConfig::default(),
    }
}

fn write_workspace_config(workspace_root: &Path, config: &WorkspaceConfig) -> Result<()> {
    fs::write(
        workspace_config_path(workspace_root),
        serde_json::to_vec_pretty(config)?,
    )?;
    Ok(())
}

fn with_state_paths(state: &AppState) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf, PathBuf)> {
    let guard = state.inner.lock().map_err(|_| anyhow!("state poisoned"))?;
    Ok((
        guard
            .root_path
            .clone()
            .ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard
            .inbox_path
            .clone()
            .ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard
            .projects_path
            .clone()
            .ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard
            .exports_path
            .clone()
            .ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard
            .db_path
            .clone()
            .ok_or_else(|| anyhow!("workspace not initialized"))?,
    ))
}

fn status_transition_allowed(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("Draft", "Review") | ("Review", "Draft") | ("Review", "Final") | ("Final", "Review")
    )
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn log_event(conn: &Connection, kind: &str, payload: serde_json::Value) -> Result<()> {
    conn.execute(
        "INSERT INTO events (kind, payload_json, created_at) VALUES (?, ?, ?)",
        params![kind, payload.to_string(), now_iso()],
    )?;
    Ok(())
}

fn get_or_create_project(conn: &Connection, project_slug: &str) -> Result<(i64, String)> {
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, name FROM projects WHERE slug = ?",
            params![project_slug],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    if let Some(project) = existing {
        return Ok(project);
    }

    let name = project_slug.replace('-', " ");
    let ts = now_iso();
    conn.execute(
        "INSERT INTO projects (name, slug, created_at, updated_at) VALUES (?, ?, ?, ?)",
        params![name, project_slug, ts, ts],
    )?;
    Ok((conn.last_insert_rowid(), project_slug.replace('-', " ")))
}

fn get_or_create_task(
    conn: &Connection,
    project_id: i64,
    html_path: &Path,
    manifest: &TaskManifest,
) -> Result<(i64, String)> {
    let stem = html_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("invalid filename"))?;
    let slug = slugify(stem);
    let title = manifest
        .title
        .clone()
        .unwrap_or_else(|| stem.replace('-', " "));

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM tasks WHERE project_id = ? AND slug = ?",
            params![project_id, &slug],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        conn.execute(
            "UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?",
            params![title, now_iso(), id],
        )?;
        return Ok((id, slug));
    }

    let ts = now_iso();
    conn.execute(
        "INSERT INTO tasks (project_id, title, slug, status, task_type, priority, due_at, source, created_at, updated_at)
         VALUES (?, ?, ?, 'Draft', ?, ?, ?, 'agent_inbox', ?, ?)",
        params![
            project_id,
            title,
            &slug,
            manifest.task_type.clone(),
            manifest.priority.clone(),
            manifest.due_date.clone(),
            ts,
            ts
        ],
    )?;

    Ok((conn.last_insert_rowid(), slug))
}

fn read_manifest(project_inbox: &Path) -> TaskManifest {
    let path = project_inbox.join("task.json");
    if !path.exists() {
        return TaskManifest::default();
    }
    let raw = fs::read_to_string(path);
    match raw {
        Ok(text) => serde_json::from_str::<TaskManifest>(&text).unwrap_or_default(),
        Err(_) => TaskManifest::default(),
    }
}

fn infer_format(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string())
}

fn import_project_folder(
    conn: &Connection,
    project_folder: &Path,
    projects_root: &Path,
) -> Result<usize> {
    let project_slug = project_folder
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("invalid project folder"))?;

    let manifest = read_manifest(project_folder);
    let (project_id, _) = get_or_create_project(conn, project_slug)?;
    let mut imported = 0usize;

    let html_files: Vec<PathBuf> = fs::read_dir(project_folder)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("html"))
                .unwrap_or(false)
        })
        .collect();

    for html in html_files {
        let (task_id, task_slug) = get_or_create_task(conn, project_id, &html, &manifest)?;
        let task_dir = projects_root.join(project_slug).join(&task_slug);
        fs::create_dir_all(&task_dir)?;

        let stem = html
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("content");

        let mut files_to_copy = vec![html.clone()];
        for ext in ["md", "txt"] {
            let candidate = project_folder.join(format!("{}.{}", stem, ext));
            if candidate.exists() {
                files_to_copy.push(candidate);
            }
        }

        let images_dir = project_folder.join("images");
        if images_dir.exists() {
            for entry in walkdir::WalkDir::new(&images_dir)
                .into_iter()
                .filter_map(Result::ok)
            {
                if entry.file_type().is_file() {
                    files_to_copy.push(entry.path().to_path_buf());
                }
            }
        }

        let mut seen: HashSet<String> = HashSet::new();
        for source in files_to_copy {
            let rel = if source.starts_with(&images_dir) {
                format!(
                    "assets/{}",
                    source
                        .strip_prefix(&images_dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                )
            } else if source == html {
                "index.html".to_string()
            } else {
                source
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("content.bin")
                    .to_string()
            };

            let dest = task_dir.join(&rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }

            let checksum = hash_file(&source)?;
            let dedup_key = format!("{}::{}", rel, checksum);
            if seen.contains(&dedup_key) {
                continue;
            }
            seen.insert(dedup_key);

            fs::copy(&source, &dest)?;
            let ts = now_iso();
            let format = infer_format(&dest);

            let existing_id: Option<i64> = conn
                .query_row(
                    "SELECT id FROM files WHERE task_id = ? AND rel_path = ?",
                    params![task_id, rel],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(id) = existing_id {
                conn.execute(
                    "UPDATE files SET abs_path = ?, format = ?, checksum = ?, updated_at = ? WHERE id = ?",
                    params![dest.to_string_lossy(), format, checksum, ts, id],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO files (task_id, project_id, rel_path, abs_path, format, checksum, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        task_id,
                        project_id,
                        rel,
                        dest.to_string_lossy(),
                        format,
                        checksum,
                        ts,
                        ts
                    ],
                )?;
            }

            imported += 1;
        }

        let payload = serde_json::json!({
            "project_slug": project_slug,
            "task_slug": task_slug,
            "task_id": task_id,
            "tags": manifest.tags.clone(),
            "notes": manifest.notes.clone()
        });
        log_event(conn, "ingest.task", payload)?;
    }

    Ok(imported)
}

fn import_scan(state: &AppState) -> Result<usize> {
    let (_, inbox_path, projects_path, _, db_path) = with_state_paths(state)?;
    let conn = db_conn(&db_path)?;

    let mut total = 0usize;
    for entry in fs::read_dir(&inbox_path)? {
        let entry = entry?;
        if entry.path().is_dir() {
            total += import_project_folder(&conn, &entry.path(), &projects_path)?;
        }
    }
    log_event(&conn, "ingest.scan", serde_json::json!({ "count": total }))?;
    Ok(total)
}

fn build_export_bundle(state: &AppState, task_id: i64) -> Result<String> {
    let (_, _, _, exports_path, db_path) = with_state_paths(state)?;
    let conn = db_conn(&db_path)?;

    let row = conn.query_row(
        r#"
        SELECT t.title, t.slug, p.slug
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        WHERE t.id = ?
        "#,
        params![task_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )?;

    let (title, task_slug, project_slug) = row;
    let bundle = exports_path.join(&project_slug).join(format!(
        "{}-{}",
        task_slug,
        Utc::now().format("%Y%m%d%H%M%S")
    ));
    fs::create_dir_all(bundle.join("assets"))?;

    let mut stmt = conn
        .prepare("SELECT rel_path, abs_path FROM files WHERE task_id = ? ORDER BY rel_path ASC")?;
    let mut rows = stmt.query(params![task_id])?;
    let mut formats = vec![];

    while let Some(row) = rows.next()? {
        let rel: String = row.get(0)?;
        let abs: String = row.get(1)?;
        let source = PathBuf::from(abs);

        let dest_rel = match rel.as_str() {
            "index.html" => "index.html".to_string(),
            other if other.ends_with(".md") => "content.md".to_string(),
            other if other.ends_with(".txt") => "content.txt".to_string(),
            other => other.to_string(),
        };

        let dest = bundle.join(dest_rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, &dest)?;
        if let Some(ext) = dest.extension().and_then(|e| e.to_str()) {
            formats.push(ext.to_string());
        }
    }

    let manifest = serde_json::json!({
        "task_id": task_id,
        "title": title,
        "project": project_slug,
        "exported_at": now_iso(),
        "formats": formats
    });
    fs::write(
        bundle.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;

    conn.execute(
        "INSERT INTO exports (task_id, export_path, formats, created_at) VALUES (?, ?, ?, ?)",
        params![
            task_id,
            bundle.to_string_lossy(),
            manifest["formats"].to_string(),
            now_iso()
        ],
    )?;

    log_event(
        &conn,
        "export.created",
        serde_json::json!({
            "task_id": task_id,
            "bundle": bundle.to_string_lossy()
        }),
    )?;

    Ok(bundle.to_string_lossy().to_string())
}

fn split_path_parts(path: &str) -> (String, String, String) {
    let p = Path::new(path);
    let parent = p
        .parent()
        .map(|v| v.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|v| format!(".{}", v))
        .unwrap_or_default();
    (parent, stem, ext)
}

fn unique_rel_path(conn: &Connection, task_id: i64, desired_rel_path: &str) -> Result<String> {
    let (parent, stem, ext) = split_path_parts(desired_rel_path);
    let build = |name: &str| -> String {
        if parent.is_empty() {
            format!("{}{}", name, ext)
        } else {
            format!("{}/{}{}", parent, name, ext)
        }
    };

    let mut candidate = build(&stem);
    let mut suffix = 2;
    loop {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM files WHERE task_id = ? AND rel_path = ?",
                params![task_id, &candidate],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(candidate);
        }
        candidate = build(&format!("{}-{}", stem, suffix));
        suffix += 1;
    }
}

fn task_folder(conn: &Connection, projects_root: &Path, task_id: i64) -> Result<(i64, PathBuf)> {
    let (project_id, task_slug, project_slug): (i64, String, String) = conn.query_row(
        r#"
        SELECT t.project_id, t.slug, p.slug
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.id = ?
        "#,
        params![task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok((project_id, projects_root.join(project_slug).join(task_slug)))
}

fn source_file_row(conn: &Connection, file_id: i64) -> Result<(i64, i64, String, String)> {
    conn.query_row(
        "SELECT id, task_id, rel_path, abs_path FROM files WHERE id = ?",
        params![file_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .context("file not found")
}

fn scan_topic(topic_dir: &Path) -> Result<TopicDetail> {
    let slug = topic_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("invalid topic path"))?
        .to_string();
    ensure_topic_contract_files(topic_dir)?;
    let mut metadata = read_topic_metadata(topic_dir);
    ensure_master_metadata(topic_dir, &mut metadata)?;
    let master_status = normalize_master_status(
        metadata
            .master
            .as_ref()
            .and_then(|master| master.status.as_deref()),
    );
    let cutoff = Utc::now().timestamp() - 86_400;

    let mut master_file: Option<String> = None;
    let mut master_modified_at: Option<i64> = None;
    let mut derivatives: Vec<DerivativeEntry> = vec![];
    let mut assets: Vec<AssetEntry> = vec![];
    let mut last_agent_write = 0i64;
    let mut last_modified = unix_mtime(topic_dir);

    for entry in walkdir::WalkDir::new(topic_dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        let rel = relative_unix(topic_dir, &path);
        if rel == "topic.json" {
            continue;
        }
        let modified_at = unix_mtime(&path);
        last_modified = last_modified.max(modified_at);
        last_agent_write = last_agent_write.max(modified_at);
        let lower = rel.to_ascii_lowercase();

        if lower.starts_with("assets/") || lower.starts_with("images/") {
            assets.push(AssetEntry {
                rel_path: rel.clone(),
                abs_path: path.to_string_lossy().to_string(),
                modified_at,
                is_image: is_image_file(&path),
                is_video: is_video_file(&path),
            });
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if file_name.eq_ignore_ascii_case("master.md")
            || file_name.eq_ignore_ascii_case("master.html")
            || file_name.eq_ignore_ascii_case("master.htm")
        {
            master_file = Some(rel.clone());
            master_modified_at = Some(modified_at);
            continue;
        }

        if is_content_file(&path) {
            let deployed_channels = deployed_channels_for_file(&rel, &metadata);
            let status = derive_file_status(&rel, &metadata, modified_at, cutoff);
            let deployed_count = deployed_channels.len();
            derivatives.push(DerivativeEntry {
                rel_path: rel.clone(),
                title: display_title_from_filename(&rel),
                kind: derivative_kind(&rel),
                status,
                deployed_count,
                deployed_channels,
                modified_at,
            });
        }
    }

    derivatives.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    assets.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let all_deployed =
        !derivatives.is_empty() && derivatives.iter().all(|d| d.status == "Deployed");
    let all_ready_or_deployed = !derivatives.is_empty()
        && derivatives
            .iter()
            .all(|d| d.status == "Revised" || d.status == "Deployed");

    let topic_status = if all_deployed {
        "Deployed".to_string()
    } else if all_ready_or_deployed {
        "Ready".to_string()
    } else {
        "Needs Review".to_string()
    };

    Ok(TopicDetail {
        slug: slug.clone(),
        title: humanize_slug(&slug),
        folder_path: topic_dir.to_string_lossy().to_string(),
        last_modified,
        last_agent_write,
        topic_status,
        tags: metadata.tags.unwrap_or_default(),
        master_file,
        master_status,
        master_modified_at,
        derivatives,
        assets,
    })
}

fn list_topics_from_inbox(inbox: &Path) -> Result<Vec<TopicSummary>> {
    let mut topics = vec![];
    if !inbox.exists() {
        return Ok(topics);
    }
    for entry in fs::read_dir(inbox)? {
        let path = entry?.path();
        if !path.is_dir() {
            continue;
        }
        let detail = scan_topic(&path)?;
        topics.push(TopicSummary {
            slug: detail.slug,
            title: detail.title,
            folder_path: detail.folder_path,
            last_modified: detail.last_modified,
            last_agent_write: detail.last_agent_write,
            topic_status: detail.topic_status,
            tags: detail.tags,
            review_count: detail
                .derivatives
                .iter()
                .filter(|d| d.status == "Draft")
                .count(),
        });
    }
    topics.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(topics)
}

fn topic_dir_from_slug(state: &AppState, slug: &str) -> Result<PathBuf> {
    let (_, inbox, _, _, _) = with_state_paths(state)?;
    Ok(inbox.join(slug))
}

fn create_topic_in_inbox(
    inbox: &Path,
    topic_name: &str,
    master_source_path: Option<String>,
    asset_source_paths: Option<Vec<String>>,
) -> Result<(String, PathBuf, String, usize)> {
    let topic_slug = slugify(topic_name);
    if topic_slug.is_empty() {
        return Err(anyhow!("topic name is empty"));
    }

    let normalized_master_source = master_source_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let validated_master_source = if let Some(source) = normalized_master_source {
        let source_path = PathBuf::from(&source);
        if !source_path.exists() || !source_path.is_file() {
            return Err(anyhow!(
                "master source not found: {}",
                source_path.to_string_lossy()
            ));
        }
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext != "md" && ext != "markdown" {
            return Err(anyhow!("master article must be a markdown file (.md)"));
        }
        Some((source_path, source))
    } else {
        None
    };

    let topic_dir = inbox.join(&topic_slug);
    if topic_dir.exists() {
        return Err(anyhow!("topic '{}' already exists", topic_slug));
    }

    let creation_result: Result<(String, usize)> = (|| {
        ensure_topic_contract_files(&topic_dir)?;

        let source = if let Some((source_path, source_label)) = validated_master_source {
            fs::copy(&source_path, topic_dir.join("master.md"))?;
            source_label
        } else {
            let blank_master = render_blank_master_template(topic_name, &topic_slug);
            fs::write(topic_dir.join("master.md"), blank_master)?;
            "__generated_template__".to_string()
        };
        if !topic_dir.join("master.md").exists() {
            return Err(anyhow!("failed to create master.md for new topic"));
        }

        let mut assets_added = 0usize;
        if let Some(paths) = asset_source_paths {
            let assets_dir = topic_dir.join("assets");
            for source in paths {
                let source_path = PathBuf::from(source);
                if !source_path.exists() || !source_path.is_file() {
                    continue;
                }
                let name = source_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("asset.bin");
                let target = unique_name_in_dir(&assets_dir, name);
                fs::copy(&source_path, &target)?;
                assets_added += 1;
            }
        }
        write_topic_metadata(&topic_dir, &default_topic_metadata())?;
        Ok((source, assets_added))
    })();

    match creation_result {
        Ok((source, assets_added)) => Ok((topic_slug, topic_dir, source, assets_added)),
        Err(error) => {
            let _ = fs::remove_dir_all(&topic_dir);
            Err(error)
        }
    }
}

#[tauri::command]
fn create_topic(
    topic_name: String,
    master_source_path: Option<String>,
    asset_source_paths: Option<Vec<String>>,
) -> Result<TopicDetail, String> {
    let (_, inbox, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let (topic_slug, topic_dir, source, assets_added) = create_topic_in_inbox(
        &inbox,
        &topic_name,
        master_source_path,
        asset_source_paths,
    )
    .map_err(|e| e.to_string())?;

    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.created",
        serde_json::json!({
            "topic_slug": topic_slug,
            "topic_name": topic_name,
            "master_source_path": source,
            "assets_added": assets_added
        }),
    )
    .map_err(|e| e.to_string())?;

    scan_topic(&topic_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_topic(topic_slug: String) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    if !topic_dir.exists() {
        return Err(format!("topic '{}' not found", topic_slug));
    }
    fs::remove_dir_all(&topic_dir).map_err(|e| e.to_string())?;

    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.deleted",
        serde_json::json!({
            "topic_slug": topic_slug
        }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_workspaces(parent_root_path: String) -> Result<Vec<WorkspaceEntry>, String> {
    let parent_root = workspace_parent_root(&PathBuf::from(parent_root_path));
    let container = workspace_roots_container(&parent_root);
    ensure_workspace_parent_contract(&parent_root).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    let default_child_root = workspace_root_path(&parent_root, DEFAULT_WORKSPACE_SLUG);
    let legacy_inbox = parent_root.join("inbox");
    if legacy_inbox.exists() && !default_child_root.exists() {
        let config = read_workspace_config(&parent_root);
        entries.push(WorkspaceEntry {
            slug: DEFAULT_WORKSPACE_SLUG.to_string(),
            title: config
                .title
                .unwrap_or_else(|| DEFAULT_WORKSPACE_TITLE.to_string()),
            path: parent_root.to_string_lossy().to_string(),
            channels: resolve_workspace_channels(DEFAULT_WORKSPACE_SLUG, config.channels),
        });
    }

    for entry in fs::read_dir(&container).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.is_dir() {
            continue;
        }
        ensure_workspace(&path).map_err(|e| e.to_string())?;
        let slug = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if slug.is_empty() {
            continue;
        }
        if !workspace_config_path(&path).exists() {
            write_workspace_config(
                &path,
                &WorkspaceConfig {
                    title: Some(humanize_slug(&slug)),
                    channels: Some(default_channels_for_workspace_slug(&slug)),
                },
            )
            .map_err(|e| e.to_string())?;
        }
        let config = read_workspace_config(&path);
        entries.push(WorkspaceEntry {
            title: config.title.unwrap_or_else(|| humanize_slug(&slug)),
            slug: slug.clone(),
            path: path.to_string_lossy().to_string(),
            channels: resolve_workspace_channels(&slug, config.channels),
        });
    }

    if entries.is_empty() {
        ensure_workspace(&default_child_root).map_err(|e| e.to_string())?;
        write_workspace_config(
            &default_child_root,
            &WorkspaceConfig {
                title: Some(DEFAULT_WORKSPACE_TITLE.to_string()),
                channels: Some(default_channels_for_workspace_slug(DEFAULT_WORKSPACE_SLUG)),
            },
        )
        .map_err(|e| e.to_string())?;
        let default_channels = default_channels_for_workspace_slug(DEFAULT_WORKSPACE_SLUG);
        entries.push(WorkspaceEntry {
            slug: DEFAULT_WORKSPACE_SLUG.to_string(),
            title: DEFAULT_WORKSPACE_TITLE.to_string(),
            path: default_child_root.to_string_lossy().to_string(),
            channels: default_channels,
        });
    }

    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
fn create_workspace(
    parent_root_path: String,
    workspace_name: String,
) -> Result<WorkspaceEntry, String> {
    let parent_root = workspace_parent_root(&PathBuf::from(parent_root_path));
    ensure_workspace_parent_contract(&parent_root).map_err(|e| e.to_string())?;
    let slug = slugify(&workspace_name);
    if slug.is_empty() {
        return Err("workspace name is empty".to_string());
    }
    let root = workspace_root_path(&parent_root, &slug);
    ensure_workspace(&root).map_err(|e| e.to_string())?;
    let title = humanize_slug(&slug);
    write_workspace_config(
        &root,
        &WorkspaceConfig {
            title: Some(title.clone()),
            channels: Some(default_channels_for_workspace_slug(&slug)),
        },
    )
    .map_err(|e| e.to_string())?;
    let default_channels = default_channels_for_workspace_slug(&slug);
    Ok(WorkspaceEntry {
        slug: slug.clone(),
        title,
        path: root.to_string_lossy().to_string(),
        channels: default_channels,
    })
}

#[tauri::command]
fn update_workspace(
    workspace_slug: String,
    workspace_path: String,
    title: String,
    channels: Vec<String>,
) -> Result<WorkspaceEntry, String> {
    let workspace_root = PathBuf::from(&workspace_path);
    if !workspace_root.exists() || !workspace_root.is_dir() {
        return Err("workspace path not found".to_string());
    }

    let normalized_title = title.trim().to_string();
    let final_title = if normalized_title.is_empty() {
        humanize_slug(&workspace_slug)
    } else {
        normalized_title
    };
    let normalized_channels = normalize_channels(channels);
    write_workspace_config(
        &workspace_root,
        &WorkspaceConfig {
            title: Some(final_title.clone()),
            channels: Some(normalized_channels.clone()),
        },
    )
    .map_err(|e| e.to_string())?;

    Ok(WorkspaceEntry {
        slug: workspace_slug,
        title: final_title,
        path: workspace_path,
        channels: normalized_channels,
    })
}

#[tauri::command]
fn add_workspace_knowledge_files(
    workspace_path: String,
    source_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let workspace_root = PathBuf::from(workspace_path);
    let knowledge_dir = workspace_root.join("knowledge");
    fs::create_dir_all(&knowledge_dir).map_err(|e| e.to_string())?;

    let mut added = Vec::new();
    for source in source_paths {
        let source_path = PathBuf::from(source);
        if !source_path.exists() || !source_path.is_file() {
            continue;
        }
        let file_name = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("knowledge.bin");
        let target = unique_name_in_dir(&knowledge_dir, file_name);
        fs::copy(&source_path, &target).map_err(|e| e.to_string())?;
        let rel = target
            .strip_prefix(&workspace_root)
            .unwrap_or(&target)
            .to_string_lossy()
            .replace('\\', "/");
        added.push(rel);
    }
    Ok(added)
}

#[tauri::command]
fn set_topic_tags(topic_slug: String, tags: Vec<String>) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    ensure_topic_contract_files(&topic_dir).map_err(|e| e.to_string())?;
    let mut metadata = read_topic_metadata(&topic_dir);
    let mut dedup = HashSet::new();
    let normalized = tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .filter(|t| dedup.insert(t.to_ascii_lowercase()))
        .collect::<Vec<String>>();
    metadata.tags = Some(normalized.clone());
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.tags_set",
        serde_json::json!({ "topic_slug": topic_slug, "tags": normalized }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_topic_master_file(topic_slug: String, source_path: String) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    ensure_topic_contract_files(&topic_dir).map_err(|e| e.to_string())?;
    let source = PathBuf::from(source_path);
    if !source.exists() || !source.is_file() {
        return Err("source file not found".to_string());
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ext != "md" && ext != "markdown" {
        return Err("master file must be markdown (.md)".to_string());
    }
    fs::copy(source, topic_dir.join("master.md")).map_err(|e| e.to_string())?;
    let mut metadata = read_topic_metadata(&topic_dir);
    metadata.master = Some(MasterWorkflowState {
        status: Some(
            normalize_master_status(
                metadata
                    .master
                    .as_ref()
                    .and_then(|master| master.status.as_deref()),
            ),
        ),
    });
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_topic_master_status(topic_slug: String, status: String) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    ensure_topic_contract_files(&topic_dir).map_err(|e| e.to_string())?;
    if !topic_has_master_file(&topic_dir) {
        return Err("master file not found for topic".to_string());
    }

    let normalized_status = if status.eq_ignore_ascii_case("draft") {
        "Draft".to_string()
    } else if status.eq_ignore_ascii_case("ready") {
        "Ready".to_string()
    } else {
        return Err("master status must be Draft or Ready".to_string());
    };

    let mut metadata = read_topic_metadata(&topic_dir);
    metadata.master = Some(MasterWorkflowState {
        status: Some(normalized_status.clone()),
    });
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;

    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.master_status_set",
        serde_json::json!({ "topic_slug": topic_slug, "status": normalized_status }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_topic_files(
    topic_slug: String,
    source_paths: Option<Vec<String>>,
    target_dir: Option<String>,
) -> Result<Vec<String>, String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let target_rel = target_dir.unwrap_or_default();
    let target_rel = if target_rel.trim().is_empty() {
        String::new()
    } else {
        normalize_topic_rel_path(&target_rel).map_err(|e| e.to_string())?
    };
    let target_abs = if target_rel.is_empty() {
        topic_dir.clone()
    } else {
        topic_dir.join(&target_rel)
    };
    fs::create_dir_all(&target_abs).map_err(|e| e.to_string())?;
    let mut added = Vec::new();
    for source in source_paths.unwrap_or_default() {
        let source_path = PathBuf::from(source);
        if !source_path.exists() || !source_path.is_file() {
            continue;
        }
        let name = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file.bin");
        let target = unique_name_in_dir(&target_abs, name);
        fs::copy(&source_path, &target).map_err(|e| e.to_string())?;
        added.push(relative_unix(&topic_dir, &target));
    }
    Ok(added)
}

#[tauri::command]
fn replace_topic_file(
    topic_slug: String,
    rel_path: String,
    source_path: String,
) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let source_abs = PathBuf::from(source_path);
    if !source_abs.exists() || !source_abs.is_file() {
        return Err("source file not found".to_string());
    }
    let rel = normalize_topic_rel_path(&rel_path).map_err(|e| e.to_string())?;
    if let Some(reason) = topic_contract_block_reason(&rel) {
        return Err(format!("{}: {}", reason, rel));
    }
    let target_abs = topic_dir.join(&rel);
    if !target_abs.exists() || !target_abs.is_file() {
        return Err(format!("target file not found: {}", rel));
    }
    fs::copy(source_abs, target_abs).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_topic_file(
    topic_slug: String,
    rel_path: String,
    new_rel_path: String,
) -> Result<String, String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let old_rel = normalize_topic_rel_path(&rel_path).map_err(|e| e.to_string())?;
    let new_rel = normalize_topic_rel_path(&new_rel_path).map_err(|e| e.to_string())?;
    if let Some(reason) = topic_contract_block_reason(&old_rel) {
        return Err(format!("{}: {}", reason, old_rel));
    }
    if let Some(reason) = topic_contract_block_reason(&new_rel) {
        return Err(format!("{}: {}", reason, new_rel));
    }
    let old_abs = topic_dir.join(&old_rel);
    if !old_abs.exists() {
        return Err(format!("file not found: {}", old_rel));
    }
    let mut target_abs = topic_dir.join(&new_rel);
    if target_abs.exists() {
        let file_name = target_abs
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "invalid target file name".to_string())?;
        let parent = target_abs
            .parent()
            .ok_or_else(|| "invalid target path".to_string())?;
        target_abs = unique_name_in_dir(parent, file_name);
    }
    if let Some(parent) = target_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&old_abs, &target_abs).map_err(|e| e.to_string())?;
    let final_rel = relative_unix(&topic_dir, &target_abs);

    let mut metadata = read_topic_metadata(&topic_dir);
    if let Some(files) = metadata.files.as_mut() {
        if let Some(entry) = files.remove(&old_rel) {
            files.insert(final_rel.clone(), entry);
        }
    }
    if let Some(deployments) = metadata.deployments.as_mut() {
        if let Some(entry) = deployments.remove(&old_rel) {
            deployments.insert(final_rel.clone(), entry);
        }
    }
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;
    Ok(final_rel)
}

#[tauri::command]
fn delete_topic_file(topic_slug: String, rel_path: String) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let rel = normalize_topic_rel_path(&rel_path).map_err(|e| e.to_string())?;
    if let Some(reason) = topic_contract_block_reason(&rel) {
        return Err(format!("{}: {}", reason, rel));
    }
    let target = topic_dir.join(&rel);
    if !target.exists() || !target.is_file() {
        return Err(format!("file not found: {}", rel));
    }
    fs::remove_file(&target).map_err(|e| e.to_string())?;

    let mut metadata = read_topic_metadata(&topic_dir);
    if let Some(files) = metadata.files.as_mut() {
        files.remove(&rel);
    }
    if let Some(deployments) = metadata.deployments.as_mut() {
        deployments.remove(&rel);
    }
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_topic_master(topic_slug: String, confirm_token: String) -> Result<usize, String> {
    if confirm_token != "delete-master-and-derivatives" {
        return Err(
            "master deletion requires explicit confirmation token; update the app and retry"
                .to_string(),
        );
    }
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let deleted = delete_topic_master_and_derivatives(&topic_dir).map_err(|e| e.to_string())?;
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.master_deleted",
        serde_json::json!({ "topic_slug": topic_slug, "derivatives_deleted": deleted }),
    )
    .map_err(|e| e.to_string())?;
    Ok(deleted)
}

#[tauri::command]
fn bootstrap_workspace(root_path: String) -> Result<BootstrapResponse, String> {
    let root = normalize_workspace_root(&PathBuf::from(root_path));
    if let Some(parent_root) = workspace_parent_from_workspace_root(&root) {
        ensure_workspace_parent_contract(&parent_root).map_err(|e| {
            format!(
                "workspace contract invalid at {}: {}",
                parent_root.to_string_lossy(),
                e
            )
        })?;
    }
    let (inbox, projects, exports, db_path) = ensure_workspace(&root).map_err(|e| e.to_string())?;

    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    migrate(&conn).map_err(|e| e.to_string())?;

    {
        let mut guard = APP_STATE
            .inner
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        guard.root_path = Some(root.clone());
        guard.inbox_path = Some(inbox.clone());
        guard.projects_path = Some(projects.clone());
        guard.exports_path = Some(exports.clone());
        guard.db_path = Some(db_path);
    }

    Ok(BootstrapResponse {
        root_path: root.to_string_lossy().to_string(),
        inbox_path: inbox.to_string_lossy().to_string(),
        projects_path: projects.to_string_lossy().to_string(),
        exports_path: exports.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn start_watcher(app: AppHandle) -> Result<WatcherStatus, String> {
    let (_, inbox, _, _, _) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;

    let app_clone = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    let _ = import_scan(&APP_STATE);
                    let _ = app_clone.emit_all("workspace:event", "changed");
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&inbox, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut guard = APP_STATE
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    guard.watcher = Some(watcher);
    guard.watcher_error = None;

    Ok(WatcherStatus {
        watching: true,
        inbox_path: inbox.to_string_lossy().to_string(),
        last_error: None,
    })
}

#[tauri::command]
fn get_watcher_status() -> Result<WatcherStatus, String> {
    let guard = APP_STATE
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    Ok(WatcherStatus {
        watching: guard.watcher.is_some(),
        inbox_path: guard
            .inbox_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        last_error: guard.watcher_error.clone(),
    })
}

#[tauri::command]
fn run_import_scan(app: AppHandle) -> Result<usize, String> {
    let count = import_scan(&APP_STATE).map_err(|e| e.to_string())?;
    app.emit_all("workspace:event", "changed")
        .map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, slug, created_at, updated_at FROM projects ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut projects = vec![];
    for row in rows {
        projects.push(row.map_err(|e| e.to_string())?);
    }
    Ok(projects)
}

#[tauri::command]
fn list_tasks(project_slug: Option<String>) -> Result<Vec<Task>, String> {
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let query = if project_slug.is_some() {
        r#"
        SELECT t.id, t.project_id, t.title, t.slug, t.status, t.task_type, t.priority, t.due_at, t.source, t.created_at, t.updated_at
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE p.slug = ?
        ORDER BY t.updated_at DESC
        "#
    } else {
        r#"
        SELECT id, project_id, title, slug, status, task_type, priority, due_at, source, created_at, updated_at
        FROM tasks
        ORDER BY updated_at DESC
        "#
    };

    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            slug: row.get(3)?,
            status: row.get(4)?,
            task_type: row.get(5)?,
            priority: row.get(6)?,
            due_at: row.get(7)?,
            source: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    };

    let mut tasks = vec![];
    if let Some(slug) = project_slug {
        let rows = stmt
            .query_map(params![slug], mapper)
            .map_err(|e| e.to_string())?;
        for row in rows {
            tasks.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let rows = stmt.query_map([], mapper).map_err(|e| e.to_string())?;
        for row in rows {
            tasks.push(row.map_err(|e| e.to_string())?);
        }
    }

    Ok(tasks)
}

#[tauri::command]
fn list_files(
    project_slug: Option<String>,
    task_id: Option<i64>,
) -> Result<Vec<ContentFile>, String> {
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let mut files = vec![];

    if let Some(task_id) = task_id {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, project_id, rel_path, abs_path, format, checksum, created_at, updated_at FROM files WHERE task_id = ? ORDER BY rel_path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![task_id], |row| {
                Ok(ContentFile {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    project_id: row.get(2)?,
                    rel_path: row.get(3)?,
                    abs_path: row.get(4)?,
                    format: row.get(5)?,
                    checksum: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            files.push(row.map_err(|e| e.to_string())?);
        }
        return Ok(files);
    }

    if let Some(project_slug) = project_slug {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT f.id, f.task_id, f.project_id, f.rel_path, f.abs_path, f.format, f.checksum, f.created_at, f.updated_at
                FROM files f
                JOIN projects p ON p.id = f.project_id
                WHERE p.slug = ?
                ORDER BY f.updated_at DESC
                "#,
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![project_slug], |row| {
                Ok(ContentFile {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    project_id: row.get(2)?,
                    rel_path: row.get(3)?,
                    abs_path: row.get(4)?,
                    format: row.get(5)?,
                    checksum: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            files.push(row.map_err(|e| e.to_string())?);
        }
        return Ok(files);
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, project_id, rel_path, abs_path, format, checksum, created_at, updated_at FROM files ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ContentFile {
                id: row.get(0)?,
                task_id: row.get(1)?,
                project_id: row.get(2)?,
                rel_path: row.get(3)?,
                abs_path: row.get(4)?,
                format: row.get(5)?,
                checksum: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        files.push(row.map_err(|e| e.to_string())?);
    }

    Ok(files)
}

#[tauri::command]
fn list_events(limit: i64) -> Result<Vec<EventLog>, String> {
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, kind, payload_json, created_at FROM events ORDER BY id DESC LIMIT ?")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(EventLog {
                id: row.get(0)?,
                kind: row.get(1)?,
                payload_json: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut events = vec![];
    for row in rows {
        events.push(row.map_err(|e| e.to_string())?);
    }
    Ok(events)
}

#[tauri::command]
fn update_task_status(task_id: i64, status: String) -> Result<(), String> {
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let current: String = conn
        .query_row(
            "SELECT status FROM tasks WHERE id = ?",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if !status_transition_allowed(&current, &status) {
        return Err(format!("invalid transition from {} to {}", current, status));
    }

    conn.execute(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        params![status, now_iso(), task_id],
    )
    .map_err(|e| e.to_string())?;

    log_event(
        &conn,
        "task.status_changed",
        serde_json::json!({ "task_id": task_id, "from": current, "to": status }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn export_task(task_id: i64) -> Result<String, String> {
    build_export_bundle(&APP_STATE, task_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if target
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("topic.json"))
        .unwrap_or(false)
    {
        return Err(
            "topic.json is protected contract metadata; use dedicated topic metadata commands"
                .to_string(),
        );
    }
    if target
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("workspace.json"))
        .unwrap_or(false)
    {
        return Err(
            "workspace.json is protected contract metadata; use workspace update commands"
                .to_string(),
        );
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_topics() -> Result<Vec<TopicSummary>, String> {
    let (_, inbox, _, _, _) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    list_topics_from_inbox(&inbox).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_topic_detail(topic_slug: String) -> Result<TopicDetail, String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    scan_topic(&topic_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_derivative_state(topic_slug: String, rel_path: String) -> Result<DerivativeState, String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    ensure_topic_contract_files(&topic_dir).map_err(|e| e.to_string())?;
    let metadata = read_topic_metadata(&topic_dir);
    let file_state = metadata
        .files
        .as_ref()
        .and_then(|m| m.get(&rel_path))
        .cloned()
        .unwrap_or_default();
    let deployed_channels = deployed_channels_for_file(&rel_path, &metadata);
    let status = if !deployed_channels.is_empty() {
        "Deployed".to_string()
    } else {
        normalize_derivative_status(file_state.status.as_deref())
    };
    Ok(DerivativeState {
        status,
        notes: file_state.notes.unwrap_or_default(),
        deployed_channels,
    })
}

#[tauri::command]
fn set_derivative_deploy_state(
    topic_slug: String,
    rel_path: String,
    status: String,
    notes: String,
    deployed_channels: Vec<String>,
) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    ensure_topic_contract_files(&topic_dir).map_err(|e| e.to_string())?;
    let mut metadata = read_topic_metadata(&topic_dir);
    let normalized_channels = normalize_channels(deployed_channels);
    let normalized_status = if normalized_channels.is_empty() {
        normalize_derivative_status(Some(&status))
    } else {
        "Deployed".to_string()
    };
    let files = metadata
        .files
        .get_or_insert_with(std::collections::HashMap::new);
    files.insert(
        rel_path.clone(),
        DerivativeWorkflowState {
            status: Some(normalized_status.clone()),
            notes: Some(notes.clone()),
            deployed_channels: Some(normalized_channels.clone()),
            reviewed: None,
        },
    );
    if let Some(legacy_deployments) = metadata.deployments.as_mut() {
        legacy_deployments.remove(&rel_path);
    }
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.deploy_state_set",
        serde_json::json!({
            "topic_slug": topic_slug,
            "rel_path": rel_path,
            "status": normalized_status,
            "deployed_channels": normalized_channels
        }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("path not found: {}", target.to_string_lossy()));
    }
    let status = std::process::Command::new("open")
        .arg(&target)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("failed to open in Finder".to_string());
    }
    Ok(())
}

#[tauri::command]
fn open_file_externally(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("path not found: {}", target.to_string_lossy()));
    }
    let status = std::process::Command::new("open")
        .arg(&target)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("failed to open file externally".to_string());
    }
    Ok(())
}

#[tauri::command]
fn rename_file(file_id: i64, new_rel_path: String) -> Result<(), String> {
    let (_, _, projects_root, _, db_path) =
        with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let (_id, task_id, _old_rel, old_abs) =
        source_file_row(&conn, file_id).map_err(|e| e.to_string())?;
    let unique_rel = unique_rel_path(&conn, task_id, &new_rel_path).map_err(|e| e.to_string())?;
    let (_, task_dir) = task_folder(&conn, &projects_root, task_id).map_err(|e| e.to_string())?;
    fs::create_dir_all(&task_dir).map_err(|e| e.to_string())?;
    let new_abs = task_dir.join(&unique_rel);
    if let Some(parent) = new_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::rename(PathBuf::from(old_abs), &new_abs).map_err(|e| e.to_string())?;
    let checksum = hash_file(&new_abs).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE files SET rel_path = ?, abs_path = ?, format = ?, checksum = ?, updated_at = ? WHERE id = ?",
        params![
            unique_rel,
            new_abs.to_string_lossy(),
            infer_format(&new_abs),
            checksum,
            now_iso(),
            file_id
        ],
    )
    .map_err(|e| e.to_string())?;

    log_event(
        &conn,
        "file.renamed",
        serde_json::json!({ "file_id": file_id }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_file(file_id: i64, target_task_id: i64) -> Result<(), String> {
    let (_, _, projects_root, _, db_path) =
        with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    let (_id, _source_task_id, source_rel, source_abs) =
        source_file_row(&conn, file_id).map_err(|e| e.to_string())?;
    let (target_project_id, target_dir) =
        task_folder(&conn, &projects_root, target_task_id).map_err(|e| e.to_string())?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let target_rel =
        unique_rel_path(&conn, target_task_id, &source_rel).map_err(|e| e.to_string())?;
    let target_abs = target_dir.join(&target_rel);
    if let Some(parent) = target_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(PathBuf::from(source_abs), &target_abs).map_err(|e| e.to_string())?;
    let checksum = hash_file(&target_abs).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE files SET task_id = ?, project_id = ?, rel_path = ?, abs_path = ?, format = ?, checksum = ?, updated_at = ? WHERE id = ?",
        params![
            target_task_id,
            target_project_id,
            target_rel,
            target_abs.to_string_lossy(),
            infer_format(&target_abs),
            checksum,
            now_iso(),
            file_id
        ],
    )
    .map_err(|e| e.to_string())?;

    log_event(
        &conn,
        "file.moved",
        serde_json::json!({ "file_id": file_id, "target_task_id": target_task_id }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn duplicate_file(file_id: i64, target_task_id: Option<i64>) -> Result<i64, String> {
    let (_, _, projects_root, _, db_path) =
        with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    let (_id, source_task_id, source_rel, source_abs) =
        source_file_row(&conn, file_id).map_err(|e| e.to_string())?;
    let destination_task = target_task_id.unwrap_or(source_task_id);

    let (target_project_id, target_dir) =
        task_folder(&conn, &projects_root, destination_task).map_err(|e| e.to_string())?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let (parent, stem, ext) = split_path_parts(&source_rel);
    let duplicate_name = if parent.is_empty() {
        format!("{}-copy{}", stem, ext)
    } else {
        format!("{}/{}-copy{}", parent, stem, ext)
    };
    let target_rel =
        unique_rel_path(&conn, destination_task, &duplicate_name).map_err(|e| e.to_string())?;
    let target_abs = target_dir.join(&target_rel);
    if let Some(parent) = target_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::copy(PathBuf::from(source_abs), &target_abs).map_err(|e| e.to_string())?;
    let checksum = hash_file(&target_abs).map_err(|e| e.to_string())?;
    let ts = now_iso();
    conn.execute(
        "INSERT INTO files (task_id, project_id, rel_path, abs_path, format, checksum, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            destination_task,
            target_project_id,
            target_rel,
            target_abs.to_string_lossy(),
            infer_format(&target_abs),
            checksum,
            ts,
            ts
        ],
    )
    .map_err(|e| e.to_string())?;
    let inserted = conn.last_insert_rowid();
    log_event(
        &conn,
        "file.duplicated",
        serde_json::json!({ "source_file_id": file_id, "new_file_id": inserted }),
    )
    .map_err(|e| e.to_string())?;
    Ok(inserted)
}

#[tauri::command]
fn attach_file_to_task(file_id: i64, target_task_id: i64) -> Result<i64, String> {
    duplicate_file(file_id, Some(target_task_id))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            bootstrap_workspace,
            start_watcher,
            get_watcher_status,
            run_import_scan,
            list_projects,
            list_tasks,
            list_files,
            list_events,
            update_task_status,
            export_task,
            read_text_file,
            write_text_file,
            list_topics,
            get_topic_detail,
            get_derivative_state,
            set_derivative_deploy_state,
            open_in_finder,
            open_file_externally,
            create_topic,
            delete_topic,
            list_workspaces,
            create_workspace,
            update_workspace,
            add_workspace_knowledge_files,
            set_topic_tags,
            set_topic_master_file,
            set_topic_master_status,
            add_topic_files,
            replace_topic_file,
            rename_topic_file,
            delete_topic_file,
            delete_topic_master,
            rename_file,
            move_file,
            duplicate_file,
            attach_file_to_task
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}

#[cfg(test)]
mod tests {
    use super::{
        build_export_bundle, create_topic_in_inbox, db_conn, delete_topic_master_and_derivatives,
        ensure_workspace, ensure_workspace_parent_contract, hash_file, import_scan, migrate,
        read_manifest, slugify, status_transition_allowed, topic_contract_block_reason,
        write_text_file, AppState,
    };
    use rusqlite::Connection;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn transition_rules() {
        assert!(status_transition_allowed("Draft", "Review"));
        assert!(status_transition_allowed("Review", "Draft"));
        assert!(status_transition_allowed("Review", "Final"));
        assert!(status_transition_allowed("Final", "Review"));

        assert!(!status_transition_allowed("Draft", "Final"));
        assert!(!status_transition_allowed("Final", "Draft"));
    }

    #[test]
    fn slugify_rules() {
        assert_eq!(slugify("Launch Email V1"), "launch-email-v1");
        assert_eq!(slugify("  Weird___Name###"), "weird-name");
    }

    #[test]
    fn manifest_defaults_on_invalid_json() {
        let tmp = TempDir::new().expect("temp dir");
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).expect("create project");
        fs::write(project.join("task.json"), "{bad json").expect("write manifest");
        let manifest = read_manifest(&project);
        assert!(manifest.title.is_none());
        assert!(manifest.task_type.is_none());
    }

    #[test]
    fn hash_file_changes_with_content() {
        let tmp = TempDir::new().expect("temp dir");
        let file = tmp.path().join("sample.txt");
        fs::write(&file, "hello").expect("write file");
        let one = hash_file(&file).expect("hash one");
        fs::write(&file, "hello world").expect("write changed file");
        let two = hash_file(&file).expect("hash two");
        assert_ne!(one, two);
    }

    fn setup_state() -> (TempDir, AppState, Connection) {
        let tmp = TempDir::new().expect("temp dir");
        let root = tmp.path().join("workspace");
        let (inbox, projects, exports, db_path) = ensure_workspace(&root).expect("workspace");
        let conn = db_conn(&db_path).expect("db");
        migrate(&conn).expect("migrate");

        let state = AppState::default();
        {
            let mut guard = state.inner.lock().expect("state lock");
            guard.root_path = Some(root);
            guard.inbox_path = Some(inbox);
            guard.projects_path = Some(projects);
            guard.exports_path = Some(exports);
            guard.db_path = Some(db_path);
        }

        (tmp, state, conn)
    }

    #[test]
    fn import_scan_creates_project_task_and_files() {
        let (_tmp, state, conn) = setup_state();
        let inbox = {
            let guard = state.inner.lock().expect("state lock");
            guard.inbox_path.clone().expect("inbox path")
        };
        let project_inbox = inbox.join("my-campaign");
        fs::create_dir_all(project_inbox.join("images")).expect("create inbox structure");
        fs::write(project_inbox.join("launch-email.html"), "<h1>Hello</h1>").expect("html");
        fs::write(project_inbox.join("launch-email.md"), "# Hello").expect("md");
        fs::write(project_inbox.join("images").join("hero.png"), "fake-bytes").expect("image");

        let imported = import_scan(&state).expect("import");
        assert!(imported >= 3);

        let projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .expect("project count");
        let tasks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .expect("task count");
        let files: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .expect("file count");

        assert_eq!(projects, 1);
        assert_eq!(tasks, 1);
        assert!(files >= 3);
    }

    #[test]
    fn repeated_import_updates_files_without_dup_rows() {
        let (_tmp, state, conn) = setup_state();
        let inbox = {
            let guard = state.inner.lock().expect("state lock");
            guard.inbox_path.clone().expect("inbox path")
        };
        let project_inbox = inbox.join("my-campaign");
        fs::create_dir_all(&project_inbox).expect("create inbox");
        fs::write(project_inbox.join("blog-post.html"), "<p>v1</p>").expect("write html");
        fs::write(project_inbox.join("blog-post.md"), "# v1").expect("write md");

        import_scan(&state).expect("first import");
        import_scan(&state).expect("second import");

        let file_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .expect("file row count");
        assert_eq!(file_rows, 2);
    }

    #[test]
    fn export_bundle_writes_manifest_and_html() {
        let (_tmp, state, conn) = setup_state();
        let inbox = {
            let guard = state.inner.lock().expect("state lock");
            guard.inbox_path.clone().expect("inbox path")
        };
        let project_inbox = inbox.join("launch");
        fs::create_dir_all(&project_inbox).expect("create inbox");
        fs::write(project_inbox.join("welcome.html"), "<html>ok</html>").expect("html");
        fs::write(project_inbox.join("welcome.txt"), "plain").expect("txt");
        import_scan(&state).expect("import");

        let task_id: i64 = conn
            .query_row("SELECT id FROM tasks LIMIT 1", [], |r| r.get(0))
            .expect("task id");
        let bundle = build_export_bundle(&state, task_id).expect("export bundle");
        let bundle_path = std::path::PathBuf::from(bundle);
        assert!(bundle_path.join("index.html").exists());
        assert!(bundle_path.join("content.txt").exists());
        assert!(bundle_path.join("manifest.json").exists());
    }

    #[test]
    fn workspace_parent_contract_scaffold_creates_required_files() {
        let tmp = TempDir::new().expect("temp dir");
        let parent = tmp.path().join("workspace-parent");
        ensure_workspace_parent_contract(&parent).expect("parent scaffold");
        assert!(parent.join("instructions.md").exists());
        assert!(parent.join("workspaces").exists());
    }

    #[test]
    fn ensure_workspace_creates_layer2_contract_paths() {
        let tmp = TempDir::new().expect("temp dir");
        let workspace_root = tmp.path().join("workspaces").join("alpha-workspace");
        let (inbox, projects, exports, db_path) =
            ensure_workspace(&workspace_root).expect("workspace scaffold");
        assert!(inbox.exists());
        assert!(projects.exists());
        assert!(exports.exists());
        assert!(workspace_root.join("data").exists());
        assert_eq!(db_path, workspace_root.join("data").join("app.db"));
        assert!(workspace_root.join("knowledge").join("workspace.md").exists());
    }

    #[test]
    fn create_topic_scaffold_creates_master_metadata_and_assets() {
        let tmp = TempDir::new().expect("temp dir");
        let inbox = tmp.path().join("inbox");
        fs::create_dir_all(&inbox).expect("create inbox");
        let master_source = tmp.path().join("master-source.md");
        fs::write(&master_source, "# Provided source\n\nThis should be copied verbatim.\n")
            .expect("write master source");

        let (_slug, topic_dir, _source, _assets_added) = create_topic_in_inbox(
            &inbox,
            "Launch Wave",
            Some(master_source.to_string_lossy().to_string()),
            None,
        )
        .expect("create topic");

        assert!(topic_dir.join("master.md").exists());
        assert!(topic_dir.join("topic.json").exists());
        assert!(topic_dir.join("assets").exists());
        let copied_master = fs::read_to_string(topic_dir.join("master.md")).expect("read copied master");
        assert!(copied_master.contains("This should be copied verbatim."));
    }

    #[test]
    fn create_topic_without_master_source_builds_blank_template() {
        let tmp = TempDir::new().expect("temp dir");
        let inbox = tmp.path().join("inbox");
        fs::create_dir_all(&inbox).expect("create inbox");

        let (_slug, topic_dir, source, _assets_added) =
            create_topic_in_inbox(&inbox, "No Source Topic", None, None).expect("create topic");
        assert_eq!(source, "__generated_template__");

        let master = fs::read_to_string(topic_dir.join("master.md")).expect("read generated master");
        assert!(master.contains("[No Source Topic]"));
        assert!(master.contains("[no-source-topic]"));
        assert!(master.contains("[goal]"));
    }

    #[test]
    fn create_topic_with_blank_master_source_string_uses_template() {
        let tmp = TempDir::new().expect("temp dir");
        let inbox = tmp.path().join("inbox");
        fs::create_dir_all(&inbox).expect("create inbox");

        let (_slug, topic_dir, source, _assets_added) = create_topic_in_inbox(
            &inbox,
            "Blank Source Topic",
            Some("   ".to_string()),
            None,
        )
        .expect("create topic with blank source");

        assert_eq!(source, "__generated_template__");
        assert!(topic_dir.join("master.md").exists());
    }

    #[test]
    fn create_topic_with_invalid_master_source_does_not_leave_partial_topic() {
        let tmp = TempDir::new().expect("temp dir");
        let inbox = tmp.path().join("inbox");
        fs::create_dir_all(&inbox).expect("create inbox");

        let invalid_source = tmp.path().join("does-not-exist.md");
        let err = create_topic_in_inbox(
            &inbox,
            "Broken Source Topic",
            Some(invalid_source.to_string_lossy().to_string()),
            None,
        )
        .expect_err("invalid source must fail");
        assert!(err.to_string().contains("master source not found"));
        assert!(!inbox.join("broken-source-topic").exists());
    }

    #[test]
    fn delete_topic_master_removes_derivatives_and_keeps_assets() {
        let tmp = TempDir::new().expect("temp dir");
        let topic_dir = tmp.path().join("topic");
        fs::create_dir_all(topic_dir.join("assets")).expect("create assets");
        fs::write(topic_dir.join("master.md"), "# master").expect("master");
        fs::write(topic_dir.join("topic.json"), "{}").expect("metadata");
        fs::write(topic_dir.join("email-topic.html"), "<p>x</p>").expect("derivative");
        fs::write(topic_dir.join("assets").join("hero.png"), "bytes").expect("asset");

        let deleted = delete_topic_master_and_derivatives(&topic_dir).expect("delete master");
        assert_eq!(deleted, 1);
        assert!(!topic_dir.join("master.md").exists());
        assert!(!topic_dir.join("email-topic.html").exists());
        assert!(topic_dir.join("assets").join("hero.png").exists());
        assert!(topic_dir.join("topic.json").exists());
    }

    #[test]
    fn protected_topic_contract_paths_are_flagged() {
        assert!(topic_contract_block_reason("topic.json").is_some());
        assert!(topic_contract_block_reason("master.md").is_some());
        assert!(topic_contract_block_reason("assets/hero.png").is_some());
        assert!(topic_contract_block_reason("derivatives/email.html").is_none());
    }

    #[test]
    fn write_text_file_blocks_protected_metadata_files() {
        let tmp = TempDir::new().expect("temp dir");
        let topic_meta = tmp.path().join("topic.json");
        let workspace_meta = tmp.path().join("workspace.json");
        let regular = tmp.path().join("notes.md");
        fs::write(&topic_meta, "{}").expect("seed topic metadata");
        fs::write(&workspace_meta, "{}").expect("seed workspace metadata");
        fs::write(&regular, "before").expect("seed regular file");

        let topic_err = write_text_file(topic_meta.to_string_lossy().to_string(), "{}".to_string())
            .expect_err("topic.json should be blocked");
        assert!(topic_err.contains("protected contract metadata"));

        let workspace_err = write_text_file(
            workspace_meta.to_string_lossy().to_string(),
            "{}".to_string(),
        )
        .expect_err("workspace.json should be blocked");
        assert!(workspace_err.contains("protected contract metadata"));

        write_text_file(
            regular.to_string_lossy().to_string(),
            "after".to_string(),
        )
        .expect("regular markdown file should remain writable");
        let value = fs::read_to_string(regular).expect("read regular file");
        assert_eq!(value, "after");
    }

    #[test]
    fn migration_is_idempotent_and_does_not_create_openclaw_tables() {
        let tmp = TempDir::new().expect("temp dir");
        let db_path = tmp.path().join("app.db");
        let conn = db_conn(&db_path).expect("db");
        migrate(&conn).expect("first migrate");
        migrate(&conn).expect("second migrate");

        for table in ["openclaw_settings", "openclaw_runs", "openclaw_run_logs"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [table],
                    |row| row.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 0, "unexpected table {}", table);
        }
    }
}
