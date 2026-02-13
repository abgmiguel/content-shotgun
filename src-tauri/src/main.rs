#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

static APP_STATE: Lazy<AppState> = Lazy::new(AppState::default);

#[derive(Default)]
struct AppState {
    inner: Mutex<InnerState>,
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
struct FileReviewState {
    status: Option<String>,
    reviewed: Option<bool>,
    notes: Option<String>,
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
    files: Option<std::collections::HashMap<String, FileReviewState>>,
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
    modified_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AssetEntry {
    rel_path: String,
    abs_path: String,
    modified_at: i64,
    is_image: bool,
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
    derivatives: Vec<DerivativeEntry>,
    assets: Vec<AssetEntry>,
    deployments: std::collections::HashMap<String, Vec<DeploymentEntry>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DerivativeState {
    status: String,
    reviewed: bool,
    notes: String,
    deployments: Vec<DeploymentEntry>,
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
    let mut root = input.to_path_buf();
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
    } else if lower.contains("social") || lower.contains("linkedin") || lower.contains("instagram") || lower.contains("facebook") {
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

fn derive_file_status(
    rel_path: &str,
    metadata: &TopicMetadata,
    modified_at: i64,
    last_scan_cutoff: i64,
) -> String {
    let deployments = metadata
        .deployments
        .as_ref()
        .and_then(|m| m.get(rel_path))
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if deployments {
        return "Deployed".to_string();
    }
    if let Some(state) = metadata
        .files
        .as_ref()
        .and_then(|m| m.get(rel_path))
        .and_then(|s| s.status.clone())
    {
        return state;
    }
    if modified_at >= last_scan_cutoff {
        "New".to_string()
    } else {
        "Review".to_string()
    }
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
    Connection::open(db_path).context("failed opening sqlite")
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

    fs::create_dir_all(&inbox)?;
    fs::create_dir_all(&projects)?;
    fs::create_dir_all(&exports)?;
    fs::create_dir_all(&data)?;

    Ok((inbox, projects, exports, data.join("app.db")))
}

fn with_state_paths(state: &AppState) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf, PathBuf)> {
    let guard = state.inner.lock().map_err(|_| anyhow!("state poisoned"))?;
    Ok((
        guard.root_path.clone().ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard.inbox_path.clone().ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard.projects_path.clone().ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard.exports_path.clone().ok_or_else(|| anyhow!("workspace not initialized"))?,
        guard.db_path.clone().ok_or_else(|| anyhow!("workspace not initialized"))?,
    ))
}

fn status_transition_allowed(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("Draft", "Review")
            | ("Review", "Draft")
            | ("Review", "Final")
            | ("Final", "Review")
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
    let title = manifest.title.clone().unwrap_or_else(|| stem.replace('-', " "));

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

        let stem = html.file_stem().and_then(|s| s.to_str()).unwrap_or("content");

        let mut files_to_copy = vec![html.clone()];
        for ext in ["md", "txt"] {
            let candidate = project_folder.join(format!("{}.{}", stem, ext));
            if candidate.exists() {
                files_to_copy.push(candidate);
            }
        }

        let images_dir = project_folder.join("images");
        if images_dir.exists() {
            for entry in walkdir::WalkDir::new(&images_dir).into_iter().filter_map(Result::ok) {
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
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
    )?;

    let (title, task_slug, project_slug) = row;
    let bundle = exports_path
        .join(&project_slug)
        .join(format!("{}-{}", task_slug, Utc::now().format("%Y%m%d%H%M%S")));
    fs::create_dir_all(bundle.join("assets"))?;

    let mut stmt = conn.prepare(
        "SELECT rel_path, abs_path FROM files WHERE task_id = ? ORDER BY rel_path ASC",
    )?;
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
    fs::write(bundle.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;

    conn.execute(
        "INSERT INTO exports (task_id, export_path, formats, created_at) VALUES (?, ?, ?, ?)",
        params![task_id, bundle.to_string_lossy(), manifest["formats"].to_string(), now_iso()],
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
    let metadata = read_topic_metadata(topic_dir);
    let cutoff = Utc::now().timestamp() - 86_400;

    let mut master_file: Option<String> = None;
    let mut derivatives: Vec<DerivativeEntry> = vec![];
    let mut assets: Vec<AssetEntry> = vec![];
    let mut last_agent_write = 0i64;
    let mut last_modified = unix_mtime(topic_dir);

    for entry in walkdir::WalkDir::new(topic_dir).into_iter().filter_map(Result::ok) {
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
            });
            continue;
        }

        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if file_name.eq_ignore_ascii_case("master.md")
            || file_name.eq_ignore_ascii_case("master.html")
            || file_name.eq_ignore_ascii_case("master.htm")
        {
            master_file = Some(rel.clone());
            continue;
        }

        if is_content_file(&path) {
            let status = derive_file_status(&rel, &metadata, modified_at, cutoff);
            let deployed_count = metadata
                .deployments
                .as_ref()
                .and_then(|d| d.get(&rel))
                .map(|v| v.len())
                .unwrap_or(0);
            derivatives.push(DerivativeEntry {
                rel_path: rel.clone(),
                title: display_title_from_filename(&rel),
                kind: derivative_kind(&rel),
                status,
                deployed_count,
                modified_at,
            });
        }
    }

    derivatives.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    assets.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let all_deployed = !derivatives.is_empty() && derivatives.iter().all(|d| d.status == "Deployed");
    let all_ready_or_deployed =
        !derivatives.is_empty() && derivatives.iter().all(|d| d.status == "Ready" || d.status == "Deployed");

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
        derivatives,
        assets,
        deployments: metadata.deployments.unwrap_or_default(),
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
                .filter(|d| d.status == "New" || d.status == "Review")
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

#[tauri::command]
fn create_topic(
    topic_name: String,
    master_format: Option<String>,
    master_content: Option<String>,
) -> Result<TopicDetail, String> {
    let (_, inbox, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let topic_slug = slugify(&topic_name);
    if topic_slug.is_empty() {
        return Err("topic name is empty".to_string());
    }

    let topic_dir = inbox.join(&topic_slug);
    if topic_dir.exists() {
        return Err(format!("topic '{}' already exists", topic_slug));
    }

    fs::create_dir_all(topic_dir.join("assets")).map_err(|e| e.to_string())?;
    let format = master_format.unwrap_or_else(|| "none".to_string()).to_ascii_lowercase();
    if format == "md" || format == "markdown" {
        let content = master_content.unwrap_or_else(|| format!("# {}\n\n", topic_name));
        fs::write(topic_dir.join("master.md"), content).map_err(|e| e.to_string())?;
    } else if format == "html" || format == "htm" {
        let content = master_content.unwrap_or_else(|| {
            format!(
                "<h1>{}</h1>\n<p>Master brief for this topic.</p>\n",
                topic_name
            )
        });
        fs::write(topic_dir.join("master.html"), content).map_err(|e| e.to_string())?;
    }

    let metadata = TopicMetadata {
        tags: Some(vec![]),
        files: Some(std::collections::HashMap::new()),
        deployments: Some(std::collections::HashMap::new()),
    };
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;

    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.created",
        serde_json::json!({
            "topic_slug": topic_slug,
            "topic_name": topic_name,
            "master_format": format
        }),
    )
    .map_err(|e| e.to_string())?;

    scan_topic(&topic_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn bootstrap_workspace(root_path: String) -> Result<BootstrapResponse, String> {
    let root = normalize_workspace_root(&PathBuf::from(root_path));
    let (inbox, projects, exports, db_path) = ensure_workspace(&root).map_err(|e| e.to_string())?;

    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    migrate(&conn).map_err(|e| e.to_string())?;

    {
        let mut guard = APP_STATE.inner.lock().map_err(|_| "state lock poisoned".to_string())?;
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

    let mut guard = APP_STATE.inner.lock().map_err(|_| "state lock poisoned".to_string())?;
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
    let guard = APP_STATE.inner.lock().map_err(|_| "state lock poisoned".to_string())?;
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
        .prepare("SELECT id, name, slug, created_at, updated_at FROM projects ORDER BY updated_at DESC")
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
fn list_files(project_slug: Option<String>, task_id: Option<i64>) -> Result<Vec<ContentFile>, String> {
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
    let metadata = read_topic_metadata(&topic_dir);
    let file_state = metadata
        .files
        .as_ref()
        .and_then(|m| m.get(&rel_path))
        .cloned()
        .unwrap_or_default();
    let deployments = metadata
        .deployments
        .as_ref()
        .and_then(|m| m.get(&rel_path))
        .cloned()
        .unwrap_or_default();
    let status = if !deployments.is_empty() {
        "Deployed".to_string()
    } else {
        file_state.status.unwrap_or_else(|| "Review".to_string())
    };
    Ok(DerivativeState {
        status,
        reviewed: file_state.reviewed.unwrap_or(false),
        notes: file_state.notes.unwrap_or_default(),
        deployments,
    })
}

#[tauri::command]
fn set_derivative_review_state(
    topic_slug: String,
    rel_path: String,
    status: String,
    reviewed: bool,
    notes: String,
) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let mut metadata = read_topic_metadata(&topic_dir);
    let files = metadata.files.get_or_insert_with(std::collections::HashMap::new);
    files.insert(
        rel_path.clone(),
        FileReviewState {
            status: Some(status.clone()),
            reviewed: Some(reviewed),
            notes: Some(notes.clone()),
        },
    );
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;
    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.review_state_set",
        serde_json::json!({ "topic_slug": topic_slug, "rel_path": rel_path, "status": status, "reviewed": reviewed }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn mark_derivative_deployed(
    topic_slug: String,
    rel_path: String,
    destination: String,
    date: String,
    url: Option<String>,
    notes: Option<String>,
) -> Result<(), String> {
    let topic_dir = topic_dir_from_slug(&APP_STATE, &topic_slug).map_err(|e| e.to_string())?;
    let mut metadata = read_topic_metadata(&topic_dir);
    let deployments = metadata
        .deployments
        .get_or_insert_with(std::collections::HashMap::new);
    let entries = deployments.entry(rel_path.clone()).or_insert_with(Vec::new);
    entries.push(DeploymentEntry {
        destination: destination.clone(),
        date: date.clone(),
        url: url.clone(),
        notes: notes.clone(),
        created_at: now_iso(),
    });
    let files = metadata.files.get_or_insert_with(std::collections::HashMap::new);
    let current = files.get(&rel_path).cloned().unwrap_or_default();
    files.insert(
        rel_path.clone(),
        FileReviewState {
            status: current.status.or(Some("Ready".to_string())),
            reviewed: Some(current.reviewed.unwrap_or(true)),
            notes: Some(current.notes.unwrap_or_default()),
        },
    );
    write_topic_metadata(&topic_dir, &metadata).map_err(|e| e.to_string())?;

    let (_, _, _, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    log_event(
        &conn,
        "topic.deployed",
        serde_json::json!({
            "topic_slug": topic_slug,
            "rel_path": rel_path,
            "destination": destination,
            "date": date,
            "url": url,
            "notes": notes
        }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_file_externally(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_file(file_id: i64, new_rel_path: String) -> Result<(), String> {
    let (_, _, projects_root, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;

    let (_id, task_id, _old_rel, old_abs) = source_file_row(&conn, file_id).map_err(|e| e.to_string())?;
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

    log_event(&conn, "file.renamed", serde_json::json!({ "file_id": file_id }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_file(file_id: i64, target_task_id: i64) -> Result<(), String> {
    let (_, _, projects_root, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    let (_id, _source_task_id, source_rel, source_abs) = source_file_row(&conn, file_id).map_err(|e| e.to_string())?;
    let (target_project_id, target_dir) = task_folder(&conn, &projects_root, target_task_id).map_err(|e| e.to_string())?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let target_rel = unique_rel_path(&conn, target_task_id, &source_rel).map_err(|e| e.to_string())?;
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
    let (_, _, projects_root, _, db_path) = with_state_paths(&APP_STATE).map_err(|e| e.to_string())?;
    let conn = db_conn(&db_path).map_err(|e| e.to_string())?;
    let (_id, source_task_id, source_rel, source_abs) = source_file_row(&conn, file_id).map_err(|e| e.to_string())?;
    let destination_task = target_task_id.unwrap_or(source_task_id);

    let (target_project_id, target_dir) = task_folder(&conn, &projects_root, destination_task).map_err(|e| e.to_string())?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let (parent, stem, ext) = split_path_parts(&source_rel);
    let duplicate_name = if parent.is_empty() {
        format!("{}-copy{}", stem, ext)
    } else {
        format!("{}/{}-copy{}", parent, stem, ext)
    };
    let target_rel = unique_rel_path(&conn, destination_task, &duplicate_name).map_err(|e| e.to_string())?;
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
            set_derivative_review_state,
            mark_derivative_deployed,
            open_in_finder,
            open_file_externally,
            create_topic,
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
        build_export_bundle, db_conn, ensure_workspace, hash_file, import_scan, migrate, read_manifest,
        slugify, status_transition_allowed, AppState,
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
}
