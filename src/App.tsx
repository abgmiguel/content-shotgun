import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import {
  bootstrapWorkspace,
  createTopic,
  getDerivativeState,
  getTopicDetail,
  getWatcherStatus,
  listTopics,
  markDerivativeDeployed,
  openFileExternally,
  openInFinder,
  readTextFile,
  runImportScan,
  setDerivativeReviewState,
  startWatcher,
  writeTextFile
} from "./appBridge";
import type {
  DerivativeEntry,
  DerivativeState,
  DerivativeStatus,
  GlobalFilter,
  TopicDetail,
  TopicStatus,
  TopicSummary,
  WatcherStatus
} from "./types";

const DEFAULT_ROOT = "./workspace";

function toDateLabel(unixSeconds: number): string {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

const KIND_ORDER = ["Blog", "Email", "Social", "General"];
const STATUS_RANK: Record<DerivativeStatus, number> = {
  New: 0,
  Review: 1,
  Ready: 2,
  Deployed: 3
};

function App() {
  const [rootPath, setRootPath] = useState(DEFAULT_ROOT);
  const [watcher, setWatcher] = useState<WatcherStatus | null>(null);
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [topicDetails, setTopicDetails] = useState<Record<string, TopicDetail>>({});
  const [selectedTopicSlug, setSelectedTopicSlug] = useState<string | null>(null);
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TopicStatus | "All">("All");
  const [tagFilter, setTagFilter] = useState<string>("All");
  const [globalFilter, setGlobalFilter] = useState<GlobalFilter>("all");

  const [editorValue, setEditorValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<"edit" | "review" | "deploy">("edit");
  const [derivativeState, setDerivativeState] = useState<DerivativeState | null>(null);
  const [reviewStatus, setReviewStatus] = useState<DerivativeStatus>("Review");
  const [reviewed, setReviewed] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");

  const [deployDestination, setDeployDestination] = useState("Shopify Blog");
  const [deployDate, setDeployDate] = useState(todayDateString());
  const [deployUrl, setDeployUrl] = useState("");
  const [deployNotes, setDeployNotes] = useState("");

  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicMasterFormat, setNewTopicMasterFormat] = useState<"none" | "html" | "md">("none");
  const [newTopicMasterContent, setNewTopicMasterContent] = useState("");

  const selectedTopic = selectedTopicSlug ? topicDetails[selectedTopicSlug] : null;
  const selectedAbsolutePath =
    selectedTopic && selectedRelPath ? `${selectedTopic.folder_path}/${selectedRelPath}` : null;

  const selectedDerivative: DerivativeEntry | null = useMemo(() => {
    if (!selectedTopic || !selectedRelPath) return null;
    return selectedTopic.derivatives.find((d) => d.rel_path === selectedRelPath) ?? null;
  }, [selectedTopic, selectedRelPath]);

  const selectedIsAsset = useMemo(() => {
    if (!selectedTopic || !selectedRelPath) return false;
    return selectedTopic.assets.some((a) => a.rel_path === selectedRelPath);
  }, [selectedTopic, selectedRelPath]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const topic of topics) {
      for (const tag of topic.tags) set.add(tag);
    }
    return ["All", ...Array.from(set).sort()];
  }, [topics]);

  async function refreshTopics() {
    const summaries = await listTopics();
    setTopics(summaries);
    const detailsList = await Promise.all(summaries.map((topic) => getTopicDetail(topic.slug)));
    const nextMap: Record<string, TopicDetail> = {};
    for (const detail of detailsList) nextMap[detail.slug] = detail;
    setTopicDetails(nextMap);
  }

  async function refreshAll() {
    const watcherState = await getWatcherStatus();
    setWatcher(watcherState);
    await refreshTopics();
  }

  async function initialize() {
    setBusy(true);
    try {
      await bootstrapWorkspace(rootPath);
      await startWatcher();
      await refreshAll();
      setNotice("Workspace ready");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function importInbox() {
    setBusy(true);
    try {
      await runImportScan();
      await refreshAll();
      setNotice("Inbox scanned");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadSelectedFile(topic: TopicDetail, relPath: string) {
    setSelectedTopicSlug(topic.slug);
    setSelectedRelPath(relPath);
    setDirty(false);

    const absPath = `${topic.folder_path}/${relPath}`;
    if (relPath.endsWith(".png") || relPath.endsWith(".jpg") || relPath.endsWith(".jpeg") || relPath.endsWith(".gif") || relPath.endsWith(".webp") || relPath.endsWith(".svg") || relPath.endsWith(".avif")) {
      setEditorValue("");
    } else {
      try {
        const text = await readTextFile(absPath);
        setEditorValue(text);
      } catch {
        setEditorValue("");
      }
    }

    if (topic.derivatives.some((d) => d.rel_path === relPath) || topic.master_file === relPath) {
      const state = await getDerivativeState(topic.slug, relPath);
      setDerivativeState(state);
      setReviewStatus(state.status === "Deployed" ? "Ready" : state.status);
      setReviewed(state.reviewed);
      setReviewNotes(state.notes);
    } else {
      setDerivativeState(null);
      setReviewStatus("Review");
      setReviewed(false);
      setReviewNotes("");
    }
  }

  async function saveFile() {
    if (!selectedAbsolutePath) return;
    setBusy(true);
    try {
      await writeTextFile(selectedAbsolutePath, editorValue);
      setDirty(false);
      await refreshTopics();
      setNotice("Saved");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveReviewChecklist() {
    if (!selectedTopicSlug || !selectedRelPath) return;
    setBusy(true);
    try {
      await setDerivativeReviewState(selectedTopicSlug, selectedRelPath, reviewStatus, reviewed, reviewNotes);
      const state = await getDerivativeState(selectedTopicSlug, selectedRelPath);
      setDerivativeState(state);
      await refreshTopics();
      setNotice("Review state saved");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deploySelected() {
    if (!selectedTopicSlug || !selectedRelPath) return;
    setBusy(true);
    try {
      await markDerivativeDeployed(
        selectedTopicSlug,
        selectedRelPath,
        deployDestination,
        deployDate,
        deployUrl,
        deployNotes
      );
      const state = await getDerivativeState(selectedTopicSlug, selectedRelPath);
      setDerivativeState(state);
      await refreshTopics();
      setNotice("Deployment logged");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createNewTopic() {
    if (!newTopicName.trim()) return;
    setBusy(true);
    try {
      const detail = await createTopic(newTopicName.trim(), newTopicMasterFormat, newTopicMasterContent);
      await refreshAll();
      setSelectedTopicSlug(detail.slug);
      if (detail.master_file) {
        await loadSelectedFile(detail, detail.master_file);
      }
      setNewTopicName("");
      setNewTopicMasterFormat("none");
      setNewTopicMasterContent("");
      setNotice(`Created topic: ${detail.title}`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void initialize();
    const unlistenPromise = listen<string>("workspace:event", () => {
      void refreshAll();
    });
    return () => {
      void unlistenPromise.then((f) => f());
    };
  }, []);

  const filteredTopics = useMemo(() => {
    const now = Date.now();
    return topics.filter((topic) => {
      const detail = topicDetails[topic.slug];
      const matchesSearch =
        !search ||
        topic.title.toLowerCase().includes(search.toLowerCase()) ||
        topic.slug.toLowerCase().includes(search.toLowerCase()) ||
        topic.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()));
      if (!matchesSearch) return false;

      if (statusFilter !== "All" && topic.topic_status !== statusFilter) return false;
      if (tagFilter !== "All" && !topic.tags.includes(tagFilter)) return false;

      if (!detail) return true;
      if (globalFilter === "needs_review") {
        return detail.derivatives.some((d) => d.status === "New" || d.status === "Review");
      }
      if (globalFilter === "ready_not_deployed") {
        return detail.derivatives.some((d) => d.status === "Ready");
      }
      if (globalFilter === "klaviyo_30d") {
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        const allDeployments = Object.values(detail.deployments).flatMap((v) => v);
        return allDeployments.some((entry) => {
          const at = new Date(entry.date).getTime();
          return entry.destination === "Klaviyo" && now - at <= thirtyDaysMs;
        });
      }
      return true;
    });
  }, [topics, topicDetails, search, statusFilter, tagFilter, globalFilter]);

  const groupedDerivatives = useMemo(() => {
    if (!selectedTopic) return {} as Record<string, DerivativeEntry[]>;
    const groups: Record<string, DerivativeEntry[]> = {};
    for (const derivative of selectedTopic.derivatives) {
      const key = derivative.kind;
      if (!groups[key]) groups[key] = [];
      groups[key].push(derivative);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (rankDiff !== 0) return rankDiff;
        if (a.modified_at !== b.modified_at) return b.modified_at - a.modified_at;
        return a.title.localeCompare(b.title);
      });
    }
    return groups;
  }, [selectedTopic]);

  const groupedDerivativeEntries = useMemo(() => {
    const entries = Object.entries(groupedDerivatives);
    entries.sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a[0]);
      const bi = KIND_ORDER.indexOf(b[0]);
      const aRank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bRank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (aRank !== bRank) return aRank - bRank;
      return a[0].localeCompare(b[0]);
    });
    return entries;
  }, [groupedDerivatives]);

  const sortedAssets = useMemo(() => {
    if (!selectedTopic) return [];
    return [...selectedTopic.assets].sort((a, b) => {
      if (a.is_image !== b.is_image) return a.is_image ? -1 : 1;
      if (a.modified_at !== b.modified_at) return b.modified_at - a.modified_at;
      return a.rel_path.localeCompare(b.rel_path);
    });
  }, [selectedTopic]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Topic Workspace</h1>
        <div className="controls">
          <input value={rootPath} onChange={(e) => setRootPath(e.target.value)} />
          <button onClick={initialize} disabled={busy}>Init</button>
          <button onClick={importInbox} disabled={busy}>Import Inbox</button>
          <span className={`watcher ${watcher?.watching ? "ok" : "bad"}`}>
            {watcher?.watching ? "Watcher Active" : "Watcher Inactive"}
          </span>
        </div>
      </header>

      <main className="layout minimal-3pane">
        <aside className="panel sidebar">
          <h2>Topics</h2>
          <div className="create-topic">
            <input
              placeholder="New topic name"
              value={newTopicName}
              onChange={(e) => setNewTopicName(e.target.value)}
            />
            <select
              value={newTopicMasterFormat}
              onChange={(e) => setNewTopicMasterFormat(e.target.value as "none" | "html" | "md")}
            >
              <option value="none">No master file</option>
              <option value="html">Create master.html</option>
              <option value="md">Create master.md</option>
            </select>
            {newTopicMasterFormat !== "none" && (
              <textarea
                placeholder="Optional starter master content"
                value={newTopicMasterContent}
                onChange={(e) => setNewTopicMasterContent(e.target.value)}
              />
            )}
            <button onClick={() => void createNewTopic()} disabled={busy || !newTopicName.trim()}>
              Make Topic
            </button>
          </div>
          <input
            className="search"
            placeholder="Search topics"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="filters">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TopicStatus | "All")}> 
              <option value="All">Status: All</option>
              <option value="Needs Review">Needs Review</option>
              <option value="Ready">Ready</option>
              <option value="Deployed">Deployed</option>
            </select>
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag === "All" ? "Tag: All" : tag}</option>
              ))}
            </select>
            <select value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value as GlobalFilter)}>
              <option value="all">Global: All</option>
              <option value="needs_review">Needing Review</option>
              <option value="ready_not_deployed">Ready not deployed</option>
              <option value="klaviyo_30d">Deployed to Klaviyo (30d)</option>
            </select>
          </div>

          <div className="topic-list">
            {filteredTopics.map((topic) => (
              <button
                key={topic.slug}
                className={`topic-row ${selectedTopicSlug === topic.slug ? "active" : ""}`}
                onClick={() => {
                  setSelectedTopicSlug(topic.slug);
                  const detail = topicDetails[topic.slug];
                  if (detail?.master_file) {
                    void loadSelectedFile(detail, detail.master_file);
                  } else if (detail?.derivatives[0]) {
                    void loadSelectedFile(detail, detail.derivatives[0].rel_path);
                  }
                }}
              >
                <strong>{topic.title}</strong>
                <small>{topic.review_count} items need review</small>
                <small>Last modified: {toDateLabel(topic.last_modified)}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel center-panel">
          {!selectedTopic ? (
            <div className="empty">Select a topic</div>
          ) : (
            <>
              <div className="topic-header">
                <div>
                  <h2>{selectedTopic.title}</h2>
                  <p className="topic-meta">
                    Tags: {selectedTopic.tags.length ? selectedTopic.tags.join(", ") : "none"}
                  </p>
                  <p className="topic-meta">Last agent write: {toDateLabel(selectedTopic.last_agent_write)}</p>
                </div>
                <button onClick={() => void openInFinder(selectedTopic.folder_path)}>Open in Finder</button>
              </div>

              <div className="relationship-tree">
                <h3>Master</h3>
                {selectedTopic.master_file ? (
                  <button
                    className={`tree-row ${selectedRelPath === selectedTopic.master_file ? "active" : ""}`}
                    onClick={() => void loadSelectedFile(selectedTopic, selectedTopic.master_file!)}
                  >
                    <span>{selectedTopic.master_file}</span>
                    <span className="pill">Draft</span>
                  </button>
                ) : (
                  <p className="muted">No master.md/master.html found</p>
                )}

                <h3>Assets</h3>
                {sortedAssets.map((asset) => (
                  <button
                    key={asset.rel_path}
                    className={`tree-row asset-row ${selectedRelPath === asset.rel_path ? "active" : ""}`}
                    onClick={() => {
                      void navigator.clipboard.writeText(asset.rel_path);
                      void loadSelectedFile(selectedTopic, asset.rel_path);
                      setNotice(`Copied path: ${asset.rel_path}`);
                    }}
                  >
                    <span className="asset-row-left">
                      {asset.is_image ? (
                        <img className="asset-thumb" src={convertFileSrc(asset.abs_path)} alt={asset.rel_path} />
                      ) : (
                        <span className="asset-thumb asset-thumb-file">FILE</span>
                      )}
                      <span className="asset-text">
                        <span>{asset.rel_path}</span>
                        <small>{toDateLabel(asset.modified_at)}</small>
                      </span>
                    </span>
                    {asset.is_image ? <span className="pill">Image</span> : <span className="pill">Asset</span>}
                  </button>
                ))}

                <h3>Derivatives</h3>
                {groupedDerivativeEntries.map(([kind, entries]) => (
                  <div key={kind} className="derivative-group">
                    <h4>{kind} ({entries.length})</h4>
                    {entries.map((entry) => (
                      <button
                        key={entry.rel_path}
                        className={`tree-row ${selectedRelPath === entry.rel_path ? "active" : ""}`}
                        onClick={() => void loadSelectedFile(selectedTopic, entry.rel_path)}
                      >
                        <span>{entry.title}</span>
                        <span className={`pill status-${entry.status.toLowerCase()}`}>{entry.status}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="panel right-panel">
          <div className="tabs">
            <button className={activeTab === "edit" ? "active" : ""} onClick={() => setActiveTab("edit")}>Edit</button>
            <button className={activeTab === "review" ? "active" : ""} onClick={() => setActiveTab("review")}>Review checklist</button>
            <button className={activeTab === "deploy" ? "active" : ""} onClick={() => setActiveTab("deploy")}>Deploy log</button>
          </div>

          {activeTab === "edit" && (
            <div className="tab-body">
              <div className="row">
                <small>Path: {selectedAbsolutePath ?? "No file selected"}</small>
                <small>{dirty ? "Unsaved changes" : "Saved"}</small>
              </div>
              <div className="row">
                <button disabled={!selectedAbsolutePath} onClick={() => selectedAbsolutePath && void openFileExternally(selectedAbsolutePath)}>
                  Open file externally
                </button>
                <button disabled={!selectedAbsolutePath || selectedIsAsset || !dirty || busy} onClick={() => void saveFile()}>
                  Save
                </button>
              </div>
              {selectedIsAsset && selectedAbsolutePath ? (
                <div className="asset-preview">
                  <img src={convertFileSrc(selectedAbsolutePath)} alt={selectedRelPath ?? "asset"} />
                </div>
              ) : (
                <div className="editor-grid">
                  <textarea
                    value={editorValue}
                    onChange={(e) => {
                      setEditorValue(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Choose master or derivative file"
                  />
                  <iframe title="preview" srcDoc={editorValue} className="preview" />
                </div>
              )}
            </div>
          )}

          {activeTab === "review" && (
            <div className="tab-body">
              <label>Status</label>
              <select value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value as DerivativeStatus)}>
                <option value="New">New</option>
                <option value="Review">Review</option>
                <option value="Ready">Ready</option>
              </select>
              <label>
                <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Reviewed
              </label>
              <label>
                <input type="checkbox" checked={Boolean(derivativeState?.deployments?.length)} readOnly /> Deployed
              </label>
              <label>Notes</label>
              <textarea value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
              <button disabled={!selectedRelPath || busy} onClick={() => void saveReviewChecklist()}>Save checklist</button>
            </div>
          )}

          {activeTab === "deploy" && (
            <div className="tab-body">
              {!selectedDerivative ? (
                <p className="muted">Select a derivative file to log deployment.</p>
              ) : (
                <>
                  <button disabled={busy} onClick={() => void deploySelected()}>Mark as Deployed</button>
                  <label>Destination</label>
                  <select value={deployDestination} onChange={(e) => setDeployDestination(e.target.value)}>
                    <option>Shopify Blog</option>
                    <option>Klaviyo</option>
                    <option>Facebook</option>
                    <option>Instagram</option>
                    <option>LinkedIn</option>
                    <option>Other</option>
                  </select>
                  <label>Date</label>
                  <input type="date" value={deployDate} onChange={(e) => setDeployDate(e.target.value)} />
                  <label>URL</label>
                  <input value={deployUrl} onChange={(e) => setDeployUrl(e.target.value)} />
                  <label>Notes</label>
                  <textarea value={deployNotes} onChange={(e) => setDeployNotes(e.target.value)} />

                  <h4>Deployment history</h4>
                  <div className="deploy-list">
                    {(derivativeState?.deployments ?? []).map((item, idx) => (
                      <div key={`${item.created_at}-${idx}`} className="deploy-item">
                        <strong>{item.destination}</strong>
                        <small>{item.date}</small>
                        <small>{item.url || "No URL"}</small>
                        <small>{item.notes || ""}</small>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <p className="notice">{notice}</p>
        </aside>
      </main>
    </div>
  );
}

export default App;
