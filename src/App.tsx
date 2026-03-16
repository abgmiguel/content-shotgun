import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { WebviewWindow } from "@tauri-apps/api/window";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  ComputerDesktopIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisHorizontalCircleIcon,
  FolderOpenIcon,
  FunnelIcon,
  MoonIcon,
  PencilIcon,
  PlusCircleIcon,
  SunIcon,
  TrashIcon,
  XMarkIcon
} from "@heroicons/react/24/outline";
import {
  addWorkspaceKnowledgeFiles,
  addTopicFiles,
  bootstrapWorkspace,
  createTopic,
  createWorkspace,
  deleteTopic,
  deleteTopicFile,
  deleteTopicMaster,
  getDerivativeState,
  getTopicDetail,
  getWatcherStatus,
  listTopics,
  listWorkspaces,
  openFileExternally,
  openInFinder,
  readTextFile,
  renameTopicFile,
  replaceTopicFile,
  setDerivativeDeployState,
  setTopicMasterFile,
  setTopicMasterStatus,
  setTopicTags,
  startWatcher,
  updateWorkspace,
} from "./appBridge";
import type {
  DerivativeEntry,
  DerivativeStatus,
  GlobalFilter,
  MasterStatus,
  TopicDetail,
  TopicStatus,
  TopicSummary,
  WatcherStatus,
  WorkspaceEntry
} from "./types";
import {
  buildPreviewDocument,
  isHtmlPath,
  isMarkdownPath
} from "./editorContent";
import { resolveSelectedRelPath, resolveSelectedTopicSlug, topicContainsRelPath } from "./topicSelection";

const APP_CONFIG = {
  workspaceParent: import.meta.env.VITE_WORKSPACE_PARENT ?? "./workspace",
};

function toDateLabel(unixSeconds: number): string {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function fileNameFromRelPath(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}

function commonRelDirectory(relPaths: string[]): string {
  if (relPaths.length === 0) return "";
  const parts = relPaths.map((relPath) => relPath.split("/").slice(0, -1));
  let common = parts[0] ?? [];
  for (let i = 1; i < parts.length; i += 1) {
    const next = parts[i] ?? [];
    let j = 0;
    while (j < common.length && j < next.length && common[j] === next[j]) j += 1;
    common = common.slice(0, j);
    if (common.length === 0) break;
  }
  return common.join("/");
}

function joinTopicPath(basePath: string, relPath: string): string {
  if (!relPath) return basePath;
  const normalizedBase = basePath.replace(/\/+$/, "");
  return `${normalizedBase}/${relPath}`;
}

function normalizeChannelList(channels: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const channel of channels) {
    const trimmed = channel.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  return next;
}

const KIND_ORDER = ["Blog", "Email", "Social", "General"];
const STATUS_RANK: Record<DerivativeStatus, number> = {
  Draft: 0,
  Revised: 1,
  Deployed: 3
};
const TRACE_TOPIC_LOADING = import.meta.env.DEV || import.meta.env.VITE_TRACE_TOPIC_LOADING === "1";
const PANE_MIN_LEFT = 220;
const PANE_MIN_RIGHT = 280;
const PANE_MIN_CENTER = 360;
const PANE_MIN_CENTER_FALLBACK = 240;
const PANE_RESIZER_WIDTH = 6;

function App() {
  const [appTheme, setAppTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("content-shotgun-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [rootPath, setRootPath] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeWorkspaceSlug, setActiveWorkspaceSlug] = useState<string>("");

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
  const [activeTab, setActiveTab] = useState<"edit" | "deploy">("edit");
  const [deployStatus, setDeployStatus] = useState<DerivativeStatus>("Draft");
  const [deployNotes, setDeployNotes] = useState("");
  const [deployedChannels, setDeployedChannels] = useState<string[]>([]);
  const [deployChannelInput, setDeployChannelInput] = useState("");

  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTopicLog, setShowTopicLog] = useState(false);
  const [showTopbarOptions, setShowTopbarOptions] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showTopicActions, setShowTopicActions] = useState(false);
  const [showFileActions, setShowFileActions] = useState(false);
  const [showMasterSection, setShowMasterSection] = useState(false);
  const [showAssetsSection, setShowAssetsSection] = useState(false);
  const [showDerivativesSection, setShowDerivativesSection] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() => {
    const raw = localStorage.getItem("content-shotgun-left-pane-width");
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 220 ? parsed : 300;
  });
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() => {
    const raw = localStorage.getItem("content-shotgun-right-pane-width");
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 280 ? parsed : 450;
  });
  const [resizingPane, setResizingPane] = useState<"left" | "right" | null>(null);

  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicMasterSourcePath, setNewTopicMasterSourcePath] = useState<string | null>(null);
  const [newTopicAssetPaths, setNewTopicAssetPaths] = useState<string[]>([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceChannels, setNewWorkspaceChannels] = useState<string[]>([]);
  const [newWorkspaceChannelInput, setNewWorkspaceChannelInput] = useState("");
  const [newWorkspaceKnowledgePaths, setNewWorkspaceKnowledgePaths] = useState<string[]>([]);
  const [showCreateTopicModal, setShowCreateTopicModal] = useState(false);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [showEditWorkspaceModal, setShowEditWorkspaceModal] = useState(false);
  const [workspaceTitleInput, setWorkspaceTitleInput] = useState("");
  const [workspaceChannelsEdit, setWorkspaceChannelsEdit] = useState<string[]>([]);
  const [workspaceChannelEditInput, setWorkspaceChannelEditInput] = useState("");
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const [renameHelp, setRenameHelp] = useState("");
  const [newTagInput, setNewTagInput] = useState("");
  const [pendingDeleteTopic, setPendingDeleteTopic] = useState<{ slug: string; title: string } | null>(null);
  const [pendingDeleteFile, setPendingDeleteFile] = useState<{
    topicSlug: string;
    topicTitle: string;
    relPath: string;
    isMaster: boolean;
  } | null>(null);
  const [selectedAbsolutePath, setSelectedAbsolutePath] = useState<string | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const fileLoadSeqRef = useRef(0);
  const topbarOptionsRef = useRef<HTMLDivElement | null>(null);
  const paneLayoutRef = useRef<HTMLElement | null>(null);
  const leftPaneWidthRef = useRef(leftPaneWidth);
  const rightPaneWidthRef = useRef(rightPaneWidth);
  const resizingPaneRef = useRef<"left" | "right" | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);
  const activeResizerRef = useRef<HTMLDivElement | null>(null);

  const selectedTopic = selectedTopicSlug ? topicDetails[selectedTopicSlug] : null;
  const selectedDerivative = useMemo(() => {
    if (!selectedTopic || !selectedRelPath) return null;
    return selectedTopic.derivatives.find((entry) => entry.relPath === selectedRelPath) ?? null;
  }, [selectedTopic, selectedRelPath]);
  const selectedIsDerivative = Boolean(selectedDerivative);
  const firstDerivativeRelPath = selectedTopic?.derivatives[0]?.relPath ?? null;
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.slug === activeWorkspaceSlug) ?? null,
    [workspaces, activeWorkspaceSlug]
  );
  const workspaceAvailableChannels = activeWorkspace?.channels ?? [];
  const deploymentChannelOptions = useMemo(
    () => {
      const deployedLower = new Set(deployedChannels.map((channel) => channel.toLowerCase()));
      return workspaceAvailableChannels.filter((channel) => !deployedLower.has(channel.toLowerCase()));
    },
    [workspaceAvailableChannels, deployedChannels]
  );

  const selectedIsAsset = useMemo(() => {
    if (!selectedTopic || !selectedRelPath) return false;
    return selectedTopic.assets.some((a) => a.relPath === selectedRelPath);
  }, [selectedTopic, selectedRelPath]);

  const selectedAsset = useMemo(() => {
    if (!selectedTopic || !selectedRelPath) return null;
    return selectedTopic.assets.find((a) => a.relPath === selectedRelPath) ?? null;
  }, [selectedTopic, selectedRelPath]);

  const selectedEditorKind = useMemo<"grapesjs" | "milkdown" | "filerobot" | null>(() => {
    if (!selectedRelPath) return null;
    if (selectedAsset?.isImage) return "filerobot";
    if (selectedIsAsset) return null;
    if (isHtmlPath(selectedRelPath)) return "grapesjs";
    if (isMarkdownPath(selectedRelPath)) return "milkdown";
    return null;
  }, [selectedRelPath, selectedAsset, selectedIsAsset]);

  const selectedFileKindLabel = useMemo(() => {
    if (!selectedTopic || !selectedRelPath) return "None";
    if (selectedTopic.masterFile === selectedRelPath) return "Master";
    if (selectedTopic.assets.some((asset) => asset.relPath === selectedRelPath)) return "Asset";
    const derivative = selectedTopic.derivatives.find((entry) => entry.relPath === selectedRelPath);
    if (derivative) return `Derivative (${derivative.kind})`;
    return "File";
  }, [selectedTopic, selectedRelPath]);
  const selectedFileName = selectedRelPath ? fileNameFromRelPath(selectedRelPath) : "None";
  const canReplaceSelectedFile = Boolean(
    selectedTopic &&
    selectedRelPath &&
    selectedTopic.masterFile !== selectedRelPath &&
    !selectedIsAsset
  );
  const selectedIsRenameProtectedContractFile = Boolean(
    selectedTopic &&
    selectedRelPath &&
    (
      selectedTopic.masterFile === selectedRelPath ||
      selectedRelPath === "topic.json" ||
      selectedRelPath.startsWith("assets/")
    )
  );
  const selectedIsDeleteProtectedContractFile = Boolean(
    selectedTopic &&
    selectedRelPath &&
    (
      selectedRelPath === "topic.json" ||
      selectedRelPath.startsWith("assets/")
    )
  );

  const canOpenEditor = Boolean(selectedAbsolutePath && selectedEditorKind);
  const previewDoc = useMemo(
    () => buildPreviewDocument(editorValue, selectedRelPath, appTheme),
    [editorValue, selectedRelPath, appTheme]
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const topic of topics) {
      for (const tag of topic.tags) set.add(tag);
    }
    return ["All", ...Array.from(set).sort()];
  }, [topics]);

  const canCreateTopic = Boolean(newTopicName.trim());

  const topicFileLogEntries = useMemo(() => {
    if (!selectedTopic) return [] as Array<{ relPath: string; kind: string; modifiedAt: number; absPath?: string; isImage?: boolean; isVideo?: boolean }>;
    const entries: Array<{ relPath: string; kind: string; modifiedAt: number; absPath?: string; isImage?: boolean; isVideo?: boolean }> = [];
    if (selectedTopic.masterFile) {
      entries.push({
        relPath: selectedTopic.masterFile,
        kind: "Master",
        modifiedAt: selectedTopic.masterModifiedAt ?? selectedTopic.lastModified
      });
    }
    for (const asset of selectedTopic.assets) {
      entries.push({
        relPath: asset.relPath,
        kind: asset.isVideo ? "Video Asset" : "Asset",
        modifiedAt: asset.modifiedAt,
        absPath: asset.absPath,
        isImage: asset.isImage,
        isVideo: asset.isVideo
      });
    }
    for (const derivative of selectedTopic.derivatives) {
      entries.push({ relPath: derivative.relPath, kind: derivative.kind, modifiedAt: derivative.modifiedAt });
    }
    entries.sort((a, b) => b.modifiedAt - a.modifiedAt || a.relPath.localeCompare(b.relPath));
    return entries;
  }, [selectedTopic]);

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

  async function initializeForWorkspace(path: string) {
    setBusy(true);
    try {
      await bootstrapWorkspace(path);
      await startWatcher();
      await refreshAll();
      setRootPath(path);
      setNotice("Workspace ready");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadWorkspaceList(preferredSlug?: string) {
    const ws = await listWorkspaces(APP_CONFIG.workspaceParent);
    setWorkspaces(ws);
    const preferred = preferredSlug ? ws.find((w) => w.slug === preferredSlug) : null;
    const current = ws.find((w) => w.slug === activeWorkspaceSlug);
    const selected = preferred ?? current ?? ws[0] ?? null;
    if (selected) {
      setActiveWorkspaceSlug(selected.slug);
      await initializeForWorkspace(selected.path);
    }
  }

  function logTopicLoad(event: string, details: Record<string, unknown>): void {
    if (!TRACE_TOPIC_LOADING) return;
    // eslint-disable-next-line no-console
    console.debug(`[topic-load] ${event}`, details);
  }

  function resetSelectedFileState(): void {
    setSelectedRelPath(null);
    setEditorValue("");
    setDeployStatus("Draft");
    setDeployNotes("");
    setDeployedChannels([]);
    setDeployChannelInput("");
    setSelectedAbsolutePath(null);
    setPreviewEpoch((prev) => prev + 1);
  }

  function selectTopic(topicSlug: string, reason: string): void {
    fileLoadSeqRef.current += 1;
    setSelectedTopicSlug(topicSlug);
    resetSelectedFileState();
    setNotice("");
    logTopicLoad("topic:selected", { topicSlug, reason, seq: fileLoadSeqRef.current });
  }

  async function selectTopicAndLoad(topicSlug: string, reason: string): Promise<void> {
    selectTopic(topicSlug, reason);
    try {
      const detail = topicDetails[topicSlug] ?? await getTopicDetail(topicSlug);
      const nextRelPath = resolveSelectedRelPath(detail, null);
      if (!nextRelPath) {
        logTopicLoad("file:selection:empty-topic", { topicSlug, reason });
        return;
      }
      await loadSelectedFile(detail, nextRelPath, `${reason}-default`);
    } catch (error) {
      setNotice(String(error));
      logTopicLoad("topic:selected:error", { topicSlug, reason, error: String(error) });
    }
  }

  async function loadSelectedFile(topic: TopicDetail, relPath: string, reason = "manual") {
    const seq = ++fileLoadSeqRef.current;
    logTopicLoad("file:load:start", { seq, topicSlug: topic.slug, relPath, reason });
    setNotice("");
    setSelectedRelPath(relPath);
    setEditorValue("");

    const absPath = `${topic.folderPath}/${relPath}`;
    setSelectedAbsolutePath(absPath);
    setPreviewEpoch((prev) => prev + 1);
    const isMediaAsset = topic.assets.some((a) => a.relPath === relPath && (a.isImage || a.isVideo));
    if (isMediaAsset) {
      logTopicLoad("file:load:asset-media", { seq, topicSlug: topic.slug, relPath });
    } else {
      try {
        const text = await readTextFile(absPath);
        if (seq !== fileLoadSeqRef.current) {
          logTopicLoad("file:load:text:cancelled", { seq, topicSlug: topic.slug, relPath });
          return;
        }
        setEditorValue(text);
        setPreviewEpoch((prev) => prev + 1);
        logTopicLoad("file:load:text:ok", { seq, topicSlug: topic.slug, relPath, length: text.length });
      } catch (error) {
        if (seq !== fileLoadSeqRef.current) {
          logTopicLoad("file:load:text:error-cancelled", { seq, topicSlug: topic.slug, relPath });
          return;
        }
        setEditorValue("");
        setPreviewEpoch((prev) => prev + 1);
        logTopicLoad("file:load:text:error", { seq, topicSlug: topic.slug, relPath, error: String(error) });
      }
    }

    if (!topic.derivatives.some((d) => d.relPath === relPath)) {
      if (seq !== fileLoadSeqRef.current) {
        logTopicLoad("file:load:deploy:reset-cancelled", { seq, topicSlug: topic.slug, relPath });
        return;
      }
      setDeployStatus("Draft");
      setDeployNotes("");
      setDeployedChannels([]);
      setDeployChannelInput("");
      logTopicLoad("file:load:deploy:reset", { seq, topicSlug: topic.slug, relPath });
      return;
    }

    try {
      const state = await getDerivativeState(topic.slug, relPath);
      if (seq !== fileLoadSeqRef.current) {
        logTopicLoad("file:load:deploy:cancelled", { seq, topicSlug: topic.slug, relPath });
        return;
      }
      setDeployStatus(state.status);
      setDeployNotes(state.notes);
      setDeployedChannels(state.deployedChannels);
      setDeployChannelInput("");
      logTopicLoad("file:load:deploy:ok", {
        seq,
        topicSlug: topic.slug,
        relPath,
        status: state.status,
        deployedChannels: state.deployedChannels
      });
    } catch (error) {
      if (seq !== fileLoadSeqRef.current) {
        logTopicLoad("file:load:deploy:error-cancelled", { seq, topicSlug: topic.slug, relPath });
        return;
      }
      setDeployStatus("Draft");
      setDeployNotes("");
      setDeployedChannels([]);
      setDeployChannelInput("");
      setNotice(String(error));
      logTopicLoad("file:load:deploy:error", { seq, topicSlug: topic.slug, relPath, error: String(error) });
    }
  }

  function openEditor() {
    if (!selectedAbsolutePath || !selectedEditorKind) {
      setNotice("Editor is available for .html/.htm, .md, and image assets.");
      return;
    }
    const label = `editor-${Date.now()}`;
    const payload = {
      kind: selectedEditorKind,
      path: selectedAbsolutePath
    };
    localStorage.setItem(`editor:init:${label}`, JSON.stringify(payload));
    const url = `/?editor=1&label=${encodeURIComponent(label)}&kind=${encodeURIComponent(selectedEditorKind)}&path=${encodeURIComponent(selectedAbsolutePath)}`;
    const editorWindow = new WebviewWindow(label, {
      title: "Editor",
      url,
      width: 1280,
      height: 900,
      resizable: true
    });
    setNotice("");
    editorWindow.once("tauri://error", (error) => {
      setNotice(`Failed to open editor window: ${String(error)}`);
    });
  }

  function normalizeDeployPayload(
    statusInput: DerivativeStatus,
    channelsInput: string[]
  ): { status: DerivativeStatus; channels: string[] } {
    return {
      status: statusInput,
      channels: normalizeChannelList(channelsInput)
    };
  }

  async function persistDeployState(
    statusInput: DerivativeStatus,
    channelsInput: string[],
    notesInput: string,
    successNotice?: string
  ) {
    if (!selectedTopicSlug || !selectedRelPath || !selectedIsDerivative) return;
    const { status: normalizedStatus, channels: normalizedChannels } = normalizeDeployPayload(statusInput, channelsInput);
    setBusy(true);
    try {
      await setDerivativeDeployState(
        selectedTopicSlug,
        selectedRelPath,
        normalizedStatus,
        notesInput,
        normalizedChannels
      );
      const state = await getDerivativeState(selectedTopicSlug, selectedRelPath);
      setDeployStatus(state.status);
      setDeployNotes(state.notes);
      setDeployedChannels(state.deployedChannels);
      await refreshTopics();
      if (successNotice) {
        setNotice(successNotice);
      }
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveDeployState() {
    await persistDeployState(deployStatus, deployedChannels, deployNotes, "Deploy state saved");
  }

  async function applyDeployStep(step: DerivativeStatus) {
    setDeployStatus(step);
    await persistDeployState(step, deployedChannels, deployNotes);
  }

  async function createNewTopic() {
    if (!canCreateTopic) {
      setNotice("Enter a topic name before creating a topic.");
      return;
    }
    setBusy(true);
    try {
      const detail = await createTopic(newTopicName.trim(), newTopicMasterSourcePath, newTopicAssetPaths);
      await refreshAll();
      await selectTopicAndLoad(detail.slug, "topic-created");
      setNewTopicName("");
      setNewTopicMasterSourcePath(null);
      setNewTopicAssetPaths([]);
      setShowCreateTopicModal(false);
      setNotice(
        newTopicMasterSourcePath
          ? `Created topic: ${detail.title}`
          : `Created topic: ${detail.title} (blank master template generated)`
      );
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  function requestTopicDelete(topic: { slug: string; title: string }) {
    setPendingDeleteTopic({ slug: topic.slug, title: topic.title });
  }

  function removeSelectedTopic() {
    if (!selectedTopic) return;
    requestTopicDelete(selectedTopic);
  }

  async function confirmTopicDelete() {
    if (!pendingDeleteTopic) return;
    setBusy(true);
    try {
      await deleteTopic(pendingDeleteTopic.slug);
      fileLoadSeqRef.current += 1;
      setSelectedTopicSlug(null);
      resetSelectedFileState();
      await refreshAll();
      setNotice(`Deleted topic: ${pendingDeleteTopic.title}`);
      setPendingDeleteTopic(null);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pickMasterFile() {
    const picked = await open({ multiple: false, title: "Select Master File" });
    if (!picked || Array.isArray(picked)) return;
    if (!isMarkdownPath(picked)) {
      setNotice("Master file must be a .md file.");
      return;
    }
    setNewTopicMasterSourcePath(picked);
    setNotice(`Master source selected: ${picked}`);
  }

  async function pickAssets() {
    const picked = await open({ multiple: true, title: "Select Topic Assets" });
    if (!picked) return;
    const next = Array.isArray(picked) ? picked : [picked];
    setNewTopicAssetPaths((prev) => Array.from(new Set([...prev, ...next])));
    setNotice(`Added ${next.length} asset file(s)`);
  }

  function removeQueuedAsset(path: string) {
    setNewTopicAssetPaths((prev) => prev.filter((item) => item !== path));
  }

  async function addMasterToSelectedTopic() {
    if (!selectedTopic) return;
    const picked = await open({ multiple: false, title: "Select master.md source" });
    if (!picked || Array.isArray(picked)) return;
    if (!isMarkdownPath(picked)) {
      setNotice("Master file must be markdown (.md)");
      return;
    }
    setBusy(true);
    try {
      await setTopicMasterFile(selectedTopic.slug, picked);
      await refreshAll();
      const detail = await getTopicDetail(selectedTopic.slug);
      if (detail.masterFile) {
        await loadSelectedFile(detail, detail.masterFile, "master-updated");
      }
      setNotice("master.md updated");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleMasterStatus() {
    if (!selectedTopic?.masterFile) return;
    const nextStatus: MasterStatus = selectedTopic.masterStatus === "Draft" ? "Ready" : "Draft";
    setBusy(true);
    try {
      await setTopicMasterStatus(selectedTopic.slug, nextStatus);
      await refreshTopics();
      setNotice(`Master status set to ${nextStatus}`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addAssetsToSelectedTopic() {
    if (!selectedTopic) return;
    const picked = await open({ multiple: true, title: "Add Asset Files" });
    if (!picked) return;
    const sourcePaths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    try {
      const added = await addTopicFiles(selectedTopic.slug, sourcePaths, "assets");
      await refreshAll();
      setNotice(`Added ${added.length} asset file(s)`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function replaceSelectedFileInTopic() {
    if (!selectedTopic || !selectedRelPath) return;
    const picked = await open({ multiple: false, title: "Replace Selected File" });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    try {
      await replaceTopicFile(selectedTopic.slug, selectedRelPath, picked);
      await refreshAll();
      const detail = await getTopicDetail(selectedTopic.slug);
      await loadSelectedFile(detail, selectedRelPath, "file-replaced");
      setNotice("File replaced");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  function startRenameSelectedFileInTopic() {
    if (!selectedTopic || !selectedRelPath) return;
    if (selectedTopic.masterFile === selectedRelPath) {
      setRenameInput(selectedRelPath);
      setRenameHelp("Master filename is fixed. Use Replace or Add master.md to change content.");
      setShowRenameModal(true);
      return;
    }
    if (selectedRelPath.startsWith("assets/") || selectedRelPath === "topic.json") {
      setNotice("This contract-protected file cannot be renamed from this flow.");
      return;
    }
    setRenameInput(fileNameFromRelPath(selectedRelPath));
    setRenameHelp("Renaming keeps the file in its current folder.");
    setShowRenameModal(true);
  }

  async function confirmRenameSelectedFileInTopic() {
    if (!selectedTopic || !selectedRelPath) return;
    if (selectedTopic.masterFile === selectedRelPath) {
      setShowRenameModal(false);
      setNotice("master.md filename is fixed. Use Replace or Add master.md to change content.");
      return;
    }
    const currentParent = selectedRelPath.includes("/")
      ? selectedRelPath.slice(0, selectedRelPath.lastIndexOf("/"))
      : "";
    const proposed = renameInput.trim();
    if (!proposed || proposed === selectedRelPath) return;
    if (proposed.includes("/") || proposed.includes("\\")) {
      setNotice("Rename only supports file names. Folder changes are not allowed here.");
      return;
    }
    const nextRelPath = currentParent ? `${currentParent}/${proposed}` : proposed;

    setBusy(true);
    try {
      const finalRelPath = await renameTopicFile(selectedTopic.slug, selectedRelPath, nextRelPath);
      await refreshAll();
      const detail = await getTopicDetail(selectedTopic.slug);
      await loadSelectedFile(detail, finalRelPath, "file-renamed");
      setShowRenameModal(false);
      setNotice(`Renamed to ${finalRelPath}`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedFileInTopic() {
    if (!selectedTopic || !selectedRelPath) return;
    if (
      selectedRelPath === "topic.json" ||
      selectedRelPath.startsWith("assets/")
    ) {
      setNotice("This contract-protected file cannot be deleted from this flow.");
      return;
    }
    setPendingDeleteFile({
      topicSlug: selectedTopic.slug,
      topicTitle: selectedTopic.title,
      relPath: selectedRelPath,
      isMaster: selectedTopic.masterFile === selectedRelPath
    });
  }

  async function confirmSelectedFileDelete() {
    if (!pendingDeleteFile) return;
    setBusy(true);
    try {
      if (pendingDeleteFile.isMaster) {
        const deletedCount = await deleteTopicMaster(pendingDeleteFile.topicSlug);
        setNotice(`Deleted master.md and ${deletedCount} derivative file(s).`);
      } else {
        await deleteTopicFile(pendingDeleteFile.topicSlug, pendingDeleteFile.relPath);
        setNotice(`Deleted file: ${pendingDeleteFile.relPath}`);
      }
      fileLoadSeqRef.current += 1;
      resetSelectedFileState();
      await refreshAll();
      setPendingDeleteFile(null);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addTagToSelectedTopic() {
    if (!selectedTopic) return;
    const tag = newTagInput.trim();
    if (!tag) return;
    const next = Array.from(new Set([...selectedTopic.tags, tag]));
    setBusy(true);
    try {
      await setTopicTags(selectedTopic.slug, next);
      setNewTagInput("");
      await refreshAll();
      setNotice("Tag added");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeTagFromSelectedTopic(tagToRemove: string) {
    if (!selectedTopic) return;
    const next = selectedTopic.tags.filter((tag) => tag !== tagToRemove);
    setBusy(true);
    try {
      await setTopicTags(selectedTopic.slug, next);
      await refreshAll();
      setNotice("Tag removed");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pickWorkspaceKnowledgeFiles() {
    const picked = await open({ multiple: true, title: "Pick Workspace Knowledge Files" });
    if (!picked) return;
    const next = Array.isArray(picked) ? picked : [picked];
    setNewWorkspaceKnowledgePaths((prev) => Array.from(new Set([...prev, ...next])));
    setNotice(`Queued ${next.length} knowledge file(s)`);
  }

  function addNewWorkspaceChannel() {
    const channel = newWorkspaceChannelInput.trim();
    if (!channel) return;
    setNewWorkspaceChannels((prev) => normalizeChannelList([...prev, channel]));
    setNewWorkspaceChannelInput("");
  }

  function removeNewWorkspaceChannel(channel: string) {
    setNewWorkspaceChannels((prev) => prev.filter((item) => item !== channel));
  }

  function openEditWorkspaceModal() {
    if (!activeWorkspace) return;
    setWorkspaceTitleInput(activeWorkspace.title);
    setWorkspaceChannelsEdit(activeWorkspace.channels);
    setWorkspaceChannelEditInput("");
    setShowEditWorkspaceModal(true);
  }

  function addWorkspaceEditChannel() {
    const channel = workspaceChannelEditInput.trim();
    if (!channel) return;
    setWorkspaceChannelsEdit((prev) => normalizeChannelList([...prev, channel]));
    setWorkspaceChannelEditInput("");
  }

  function removeWorkspaceEditChannel(channel: string) {
    setWorkspaceChannelsEdit((prev) => prev.filter((item) => item !== channel));
  }

  async function addWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name) {
      setNotice("Enter a workspace name.");
      return;
    }
    setBusy(true);
    try {
      const created = await createWorkspace(APP_CONFIG.workspaceParent, name);
      const nextChannels = normalizeChannelList(newWorkspaceChannels);
      if (nextChannels.length > 0) {
        await updateWorkspace(created.slug, created.path, created.title, nextChannels);
      }
      if (newWorkspaceKnowledgePaths.length > 0) {
        await addWorkspaceKnowledgeFiles(created.path, newWorkspaceKnowledgePaths);
      }
      await loadWorkspaceList(created.slug);
      setNewWorkspaceName("");
      setNewWorkspaceChannels([]);
      setNewWorkspaceChannelInput("");
      setNewWorkspaceKnowledgePaths([]);
      setShowWorkspaceModal(false);
      setNotice(`Workspace ready: ${created.title}`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspaceSettings() {
    if (!activeWorkspace) return;
    const title = workspaceTitleInput.trim() || activeWorkspace.title;
    const channels = normalizeChannelList(workspaceChannelsEdit);
    setBusy(true);
    try {
      await updateWorkspace(activeWorkspace.slug, activeWorkspace.path, title, channels);
      await loadWorkspaceList(activeWorkspace.slug);
      setShowEditWorkspaceModal(false);
      setWorkspaceChannelEditInput("");
      setNotice("Workspace settings saved");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addDeploymentChannel(channel: string) {
    const normalizedChannel = channel.trim();
    if (!normalizedChannel) return;
    setDeployedChannels((prev) => normalizeChannelList([...prev, normalizedChannel]));
    setDeployChannelInput("");

    if (!activeWorkspace) return;
    const existsInWorkspace = workspaceAvailableChannels.some(
      (item) => item.toLowerCase() === normalizedChannel.toLowerCase()
    );
    if (existsInWorkspace) return;

    const nextWorkspaceChannels = normalizeChannelList([...workspaceAvailableChannels, normalizedChannel]);
    try {
      const updatedWorkspace = await updateWorkspace(
        activeWorkspace.slug,
        activeWorkspace.path,
        activeWorkspace.title,
        nextWorkspaceChannels
      );
      setWorkspaces((prev) =>
        prev.map((workspace) => (workspace.slug === updatedWorkspace.slug ? updatedWorkspace : workspace))
      );
      setWorkspaceChannelsEdit((prev) => {
        if (!showEditWorkspaceModal) return prev;
        return normalizeChannelList([...prev, normalizedChannel]);
      });
    } catch (error) {
      setNotice(String(error));
    }
  }

  function removeDeploymentChannel(channel: string) {
    setDeployedChannels((prev) => prev.filter((item) => item !== channel));
  }

  function toggleAppTheme() {
    setAppTheme((prev) => (prev === "light" ? "dark" : "light"));
  }

  function clampPaneWidths(nextLeft: number, nextRight: number): { left: number; right: number } {
    const layout = paneLayoutRef.current;
    if (!layout) {
      return { left: Math.round(nextLeft), right: Math.round(nextRight) };
    }

    const rect = layout.getBoundingClientRect();
    const styles = window.getComputedStyle(layout);
    const rawGap = Number.parseFloat(styles.columnGap || styles.gap || "0");
    const columnGap = Number.isFinite(rawGap) ? rawGap : 0;
    const fixedWidth = PANE_RESIZER_WIDTH * 2 + columnGap * 4;
    const available = Math.max(0, rect.width - fixedWidth);
    const minCenter = Math.min(
      PANE_MIN_CENTER,
      Math.max(PANE_MIN_CENTER_FALLBACK, available - PANE_MIN_LEFT - PANE_MIN_RIGHT)
    );

    let left = Math.max(PANE_MIN_LEFT, nextLeft);
    let right = Math.max(PANE_MIN_RIGHT, nextRight);

    const leftMax = Math.max(PANE_MIN_LEFT, available - minCenter - right);
    left = Math.min(left, leftMax);

    const rightMax = Math.max(PANE_MIN_RIGHT, available - minCenter - left);
    right = Math.min(right, rightMax);

    const overflow = left + right + minCenter - available;
    if (overflow > 0) {
      const rightSlack = Math.max(0, right - PANE_MIN_RIGHT);
      const rightReduction = Math.min(rightSlack, overflow);
      right -= rightReduction;
      const leftReduction = overflow - rightReduction;
      if (leftReduction > 0) {
        left = Math.max(PANE_MIN_LEFT, left - leftReduction);
      }
    }

    return { left: Math.round(left), right: Math.round(right) };
  }

  function applyPaneResizeForClientX(clientX: number): void {
    const layout = paneLayoutRef.current;
    const side = resizingPaneRef.current;
    if (!layout || !side) return;
    const rect = layout.getBoundingClientRect();

    if (side === "left") {
      const desired = clientX - rect.left;
      const clamped = clampPaneWidths(desired, rightPaneWidthRef.current);
      leftPaneWidthRef.current = clamped.left;
      rightPaneWidthRef.current = clamped.right;
      setLeftPaneWidth(clamped.left);
      setRightPaneWidth(clamped.right);
      return;
    }

    const desired = rect.right - clientX;
    const clamped = clampPaneWidths(leftPaneWidthRef.current, desired);
    leftPaneWidthRef.current = clamped.left;
    rightPaneWidthRef.current = clamped.right;
    setLeftPaneWidth(clamped.left);
    setRightPaneWidth(clamped.right);
  }

  function stopPaneResize(): void {
    const pointerId = resizePointerIdRef.current;
    const resizer = activeResizerRef.current;
    if (resizer && pointerId !== null && resizer.hasPointerCapture(pointerId)) {
      try {
        resizer.releasePointerCapture(pointerId);
      } catch {
        // Ignore if capture was already released.
      }
    }
    resizePointerIdRef.current = null;
    activeResizerRef.current = null;
    resizingPaneRef.current = null;
    setResizingPane(null);
  }

  function beginPaneResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    resizingPaneRef.current = side;
    resizePointerIdRef.current = event.pointerId;
    activeResizerRef.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingPane(side);
    applyPaneResizeForClientX(event.clientX);
  }

  useEffect(() => {
    void loadWorkspaceList();
    const unlistenPromise = listen<string>("workspace:event", () => {
      void refreshAll();
    });
    return () => {
      void unlistenPromise.then((f) => f());
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("content-shotgun-theme", appTheme);
  }, [appTheme]);

  useEffect(() => {
    localStorage.setItem("content-shotgun-left-pane-width", String(Math.round(leftPaneWidth)));
  }, [leftPaneWidth]);

  useEffect(() => {
    localStorage.setItem("content-shotgun-right-pane-width", String(Math.round(rightPaneWidth)));
  }, [rightPaneWidth]);

  useEffect(() => {
    if (!showTopbarOptions) return;
    function handleWindowMouseDown(event: MouseEvent) {
      const root = topbarOptionsRef.current;
      if (!root) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!root.contains(target)) {
        setShowTopbarOptions(false);
      }
    }
    window.addEventListener("mousedown", handleWindowMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleWindowMouseDown);
    };
  }, [showTopbarOptions]);

  useEffect(() => {
    leftPaneWidthRef.current = leftPaneWidth;
    rightPaneWidthRef.current = rightPaneWidth;
    const clamped = clampPaneWidths(leftPaneWidth, rightPaneWidth);
    if (clamped.left !== leftPaneWidth) {
      setLeftPaneWidth(clamped.left);
    }
    if (clamped.right !== rightPaneWidth) {
      setRightPaneWidth(clamped.right);
    }
  }, [leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    function handleWindowResize(): void {
      const clamped = clampPaneWidths(leftPaneWidthRef.current, rightPaneWidthRef.current);
      if (clamped.left !== leftPaneWidthRef.current) {
        setLeftPaneWidth(clamped.left);
      }
      if (clamped.right !== rightPaneWidthRef.current) {
        setRightPaneWidth(clamped.right);
      }
    }
    window.addEventListener("resize", handleWindowResize);
    handleWindowResize();
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useEffect(() => {
    if (!resizingPane) return;

    function handlePointerMove(event: PointerEvent): void {
      const pointerId = resizePointerIdRef.current;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      if (event.buttons === 0) {
        stopPaneResize();
        return;
      }
      applyPaneResizeForClientX(event.clientX);
    }

    function handlePointerUp(event: PointerEvent): void {
      const pointerId = resizePointerIdRef.current;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      stopPaneResize();
    }

    function handlePointerCancel(event: PointerEvent): void {
      const pointerId = resizePointerIdRef.current;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      stopPaneResize();
    }

    function handleWindowBlur(): void {
      stopPaneResize();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleWindowBlur);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleWindowBlur);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingPane]);

  useEffect(() => {
    const nextTopicSlug = resolveSelectedTopicSlug(topics, selectedTopicSlug);
    if (nextTopicSlug === selectedTopicSlug) return;

    if (!nextTopicSlug) {
      fileLoadSeqRef.current += 1;
      setSelectedTopicSlug(null);
      resetSelectedFileState();
      logTopicLoad("topic:cleared", { reason: "no-topics", seq: fileLoadSeqRef.current });
      return;
    }

    void selectTopicAndLoad(nextTopicSlug, selectedTopicSlug ? "topic-missing" : "topic-initial");
  }, [topics, selectedTopicSlug]);

  useEffect(() => {
    if (!selectedTopic || !selectedRelPath) return;
    if (topicContainsRelPath(selectedTopic, selectedRelPath)) return;
    const nextRelPath = resolveSelectedRelPath(selectedTopic, null);
    if (!nextRelPath) {
      fileLoadSeqRef.current += 1;
      resetSelectedFileState();
      logTopicLoad("file:selection:cleared", {
        topicSlug: selectedTopic.slug,
        reason: "selected-file-missing-and-no-default",
        seq: fileLoadSeqRef.current
      });
      return;
    }
    void loadSelectedFile(selectedTopic, nextRelPath, "selected-file-repair");
  }, [selectedTopic, selectedRelPath]);

  useEffect(() => {
    if (activeTab !== "deploy") return;
    if (!selectedTopic) return;
    if (selectedIsDerivative) return;
    const firstDerivative = selectedTopic.derivatives[0];
    if (!firstDerivative) return;
    void loadSelectedFile(selectedTopic, firstDerivative.relPath, "deploy-tab-autoselect-derivative");
  }, [activeTab, selectedTopic, selectedIsDerivative]);

  useEffect(() => {
    if (activeTab !== "deploy") return;
    if (!selectedIsDerivative) {
      setActiveTab("edit");
    }
  }, [activeTab, selectedIsDerivative]);

  const filteredTopics = useMemo(() => {
    return topics.filter((topic) => {
      const detail = topicDetails[topic.slug];
      const matchesSearch =
        !search ||
        topic.title.toLowerCase().includes(search.toLowerCase()) ||
        topic.slug.toLowerCase().includes(search.toLowerCase()) ||
        topic.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()));
      if (!matchesSearch) return false;

      if (statusFilter !== "All" && topic.topicStatus !== statusFilter) return false;
      if (tagFilter !== "All" && !topic.tags.includes(tagFilter)) return false;

      if (!detail) return true;
      if (globalFilter === "needs_review") {
        return detail.derivatives.some((d) => d.status === "Draft");
      }
      if (globalFilter === "ready_not_deployed") {
        return detail.derivatives.some((d) => d.status === "Revised");
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
        if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
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
      if (a.isImage !== b.isImage) return a.isImage ? -1 : 1;
      if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
      return a.relPath.localeCompare(b.relPath);
    });
  }, [selectedTopic]);
  const hasMaster = Boolean(selectedTopic?.masterFile);
  const hasAssets = sortedAssets.length > 0;
  const hasDerivatives = Boolean(selectedTopic?.derivatives.length);
  const masterFolderPath = useMemo(() => {
    if (!selectedTopic) return null;
    if (!selectedTopic.masterFile) return selectedTopic.folderPath;
    const relDirectory = commonRelDirectory([selectedTopic.masterFile]);
    return joinTopicPath(selectedTopic.folderPath, relDirectory);
  }, [selectedTopic]);
  const assetsFolderPath = useMemo(() => {
    if (!selectedTopic) return null;
    if (sortedAssets.length === 0) return joinTopicPath(selectedTopic.folderPath, "assets");
    const relDirectory = commonRelDirectory(sortedAssets.map((asset) => asset.relPath));
    return joinTopicPath(selectedTopic.folderPath, relDirectory);
  }, [selectedTopic, sortedAssets]);
  const derivativesFolderPath = useMemo(() => {
    if (!selectedTopic) return null;
    if (selectedTopic.derivatives.length === 0) return selectedTopic.folderPath;
    const relDirectory = commonRelDirectory(selectedTopic.derivatives.map((entry) => entry.relPath));
    return joinTopicPath(selectedTopic.folderPath, relDirectory);
  }, [selectedTopic]);
  const deployProgressStep = deployStatus === "Draft" ? 0 : deployStatus === "Revised" ? 1 : 2;

  return (
    <div className={`app-shell theme-${appTheme}`}>
      <header className="topbar">
        <h1 className="app-title">
          <span className="app-title-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 2 4.6 6.2v11.6L12 22l7.4-4.2V6.2L12 2Z" />
              <path d="M12 2v20" />
              <path d="m4.6 6.2 7.4 4.2 7.4-4.2" />
            </svg>
          </span>
          Content Shotgun
        </h1>
        <div className="controls">
          {!showTopbarOptions && (
            <div className="workspace-picker">
              <select
                value={activeWorkspaceSlug}
                onChange={(e) => {
                  const slug = e.target.value;
                  setActiveWorkspaceSlug(slug);
                  const ws = workspaces.find((item) => item.slug === slug);
                  if (ws) {
                    void initializeForWorkspace(ws.path);
                  }
                }}
                disabled={busy || workspaces.length === 0}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.slug} value={workspace.slug}>{workspace.title}</option>
                ))}
              </select>
              <ChevronDownIcon className="workspace-picker-icon" />
            </div>
          )}
          <div ref={topbarOptionsRef} className="topbar-options-wrap">
            <button
              type="button"
              className={`icon-button ${showTopbarOptions ? "active" : ""}`}
              onClick={() => setShowTopbarOptions((prev) => !prev)}
              disabled={busy}
              title={showTopbarOptions ? "Hide options" : "Show options"}
              aria-label={showTopbarOptions ? "Hide options" : "Show options"}
            >
              <EllipsisHorizontalCircleIcon />
            </button>
            <div className={`topbar-options-panel ${showTopbarOptions ? "open" : ""}`}>
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowWorkspaceModal(true)}
                disabled={busy}
                title="New workspace"
                aria-label="New workspace"
              >
                <PlusCircleIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={openEditWorkspaceModal}
                disabled={busy || !activeWorkspace}
                title="Edit workspace"
                aria-label="Edit workspace"
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => rootPath && void initializeForWorkspace(rootPath)}
                disabled={busy || !rootPath}
                title="Re-initialize workspace"
                aria-label="Re-initialize workspace"
              >
                <ArrowPathIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => window.location.reload()}
                disabled={busy}
                title="Reset UI"
                aria-label="Reset UI"
              >
                <ArrowUturnLeftIcon />
              </button>
              <button
                type="button"
                className={`icon-button ${showTopicLog ? "active" : ""}`}
                onClick={() => setShowTopicLog((prev) => !prev)}
                disabled={!selectedTopic}
                title={showTopicLog ? "Hide topic log" : "Show topic log"}
                aria-label={showTopicLog ? "Hide topic log" : "Show topic log"}
              >
                <DocumentMagnifyingGlassIcon />
              </button>
            </div>
          </div>
          <div role="group" aria-label="Theme">
            <button
              type="button"
              className="icon-button"
              onClick={toggleAppTheme}
              disabled={busy}
              title={appTheme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              aria-label={appTheme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            >
              {appTheme === "light" ? <MoonIcon /> : <SunIcon />}
            </button>
          </div>
          <span className={`watcher ${watcher?.watching ? "ok" : "bad"}`}>
            {watcher?.watching ? "Watcher Active" : "Watcher Inactive"}
          </span>
        </div>
      </header>

      <main
        ref={paneLayoutRef}
        className={`layout minimal-3pane ${resizingPane ? "resizing" : ""}`}
        style={{
          "--left-pane-width": `${leftPaneWidth}px`,
          "--right-pane-width": `${rightPaneWidth}px`
        } as Record<string, string>}
      >
        <aside className="panel sidebar">
          <h2>Topics</h2>
          <div className="topic-toolbar">
            <input
              className="search topic-search"
              placeholder="Search topics"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowCreateTopicModal(true)}
              disabled={busy}
              title="Create a topic"
              aria-label="Create a topic"
            >
              <PlusCircleIcon />
            </button>
            <button
              type="button"
              className={`icon-button ${showFilters ? "active" : ""}`}
              onClick={() => setShowFilters((prev) => !prev)}
              title={showFilters ? "Hide filters" : "Show filters"}
              aria-expanded={showFilters}
              aria-label={showFilters ? "Hide filters" : "Show filters"}
            >
              <FunnelIcon />
            </button>
          </div>
          <div className={`collapsible-content ${showFilters ? "open" : ""}`}>
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
                <option value="ready_not_deployed">Revised not deployed</option>
              </select>
            </div>
          </div>

          <div className="topic-list">
            {filteredTopics.map((topic) => (
              <button
                key={topic.slug}
                className={`topic-row ${selectedTopicSlug === topic.slug ? "active" : ""}`}
                onClick={() => {
                  void selectTopicAndLoad(topic.slug, "user-click");
                }}
              >
                <strong>{topic.title}</strong>
                <small>{topic.reviewCount} derivatives in draft</small>
                <small>Last modified: {toDateLabel(topic.lastModified)}</small>
              </button>
            ))}
          </div>
        </aside>
        <div
          className="pane-resizer"
          role="separator"
          aria-label="Resize topics panel"
          aria-orientation="vertical"
          onPointerDown={(event) => beginPaneResize("left", event)}
        />

        <section className="panel center-panel">
          {!selectedTopic ? (
            <div className="empty">Select a topic</div>
          ) : (
            <>
              <div className="topic-header">
                <div>
                  <h2>{selectedTopic.title}</h2>
                  <div className="tag-editor">
                    <input
                      value={newTagInput}
                      placeholder="Add tag"
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void addTagToSelectedTopic();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void addTagToSelectedTopic()}
                      disabled={busy}
                      title="Add tag"
                      aria-label="Add tag"
                    >
                      <PlusCircleIcon />
                    </button>
                    <div className="tag-list">
                      {selectedTopic.tags.map((tag) => (
                        <span key={tag} className="tag-chip">
                          {tag}
                          <button
                            type="button"
                            onClick={() => void removeTagFromSelectedTopic(tag)}
                            title={`Remove tag ${tag}`}
                            aria-label={`Remove tag ${tag}`}
                          >
                            <XMarkIcon />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="topic-header-actions inline-options-wrap">
                  <button
                    type="button"
                    className={`icon-button ${showTopicActions ? "active" : ""}`}
                    onClick={() => setShowTopicActions((prev) => !prev)}
                    title={showTopicActions ? "Collapse topic actions" : "Expand topic actions"}
                    aria-expanded={showTopicActions}
                    aria-label={showTopicActions ? "Collapse topic actions" : "Expand topic actions"}
                  >
                    <ChevronLeftIcon className={showTopicActions ? "arrow-open" : ""} />
                  </button>
                  <div className={`inline-options-panel ${showTopicActions ? "open" : ""}`}>
                    <button type="button" className="icon-button" onClick={() => void addMasterToSelectedTopic()} disabled={busy} title="Add master.md" aria-label="Add master file">
                      <PlusCircleIcon />
                    </button>
                    <button type="button" className="icon-button" onClick={() => void addAssetsToSelectedTopic()} disabled={busy} title="Add assets" aria-label="Add assets">
                      <FolderOpenIcon />
                    </button>
                    <button type="button" className="icon-button" onClick={() => void openInFinder(selectedTopic.folderPath)} title="Open in Finder" aria-label="Open in Finder">
                      <ArrowTopRightOnSquareIcon />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => void removeSelectedTopic()} disabled={busy} title="Delete topic" aria-label="Delete topic">
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </div>

              <div className="relationship-tree">
                <div className="collapsible-block">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className={`section-toggle ${showMasterSection ? "open" : ""} ${hasMaster ? "section-status-ok" : "section-status-empty"}`}
                      onClick={() => setShowMasterSection((prev) => !prev)}
                      title={showMasterSection ? "Collapse master section" : "Expand master section"}
                      aria-expanded={showMasterSection}
                    >
                      <span>Master</span>
                      <ChevronDownIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => masterFolderPath && void openInFinder(masterFolderPath)}
                      title="Open master folder"
                      aria-label="Open master folder"
                    >
                      <FolderOpenIcon />
                    </button>
                  </div>
                  <div className={`collapsible-content ${showMasterSection ? "open" : ""}`}>
                    {selectedTopic.masterFile ? (
                      <button
                        className={`tree-row ${selectedRelPath === selectedTopic.masterFile ? "active" : ""}`}
                        onClick={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest(".master-status-toggle")) {
                            if (!busy) void toggleMasterStatus();
                            return;
                          }
                          void loadSelectedFile(selectedTopic, selectedTopic.masterFile!, "user-master-click");
                        }}
                      >
                        <span title={selectedTopic.masterFile}>{fileNameFromRelPath(selectedTopic.masterFile)}</span>
                        <span
                          className={`pill master-status-toggle master-status-${selectedTopic.masterStatus.toLowerCase()} ${busy ? "disabled" : ""}`}
                          title={busy ? "Saving master status..." : `Toggle master status (${selectedTopic.masterStatus})`}
                        >
                          {selectedTopic.masterStatus}
                        </span>
                      </button>
                    ) : (
                      <p className="muted">No master.md found</p>
                    )}
                  </div>
                </div>

                <div className="collapsible-block">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className={`section-toggle ${showAssetsSection ? "open" : ""} ${hasAssets ? "section-status-ok" : "section-status-empty"}`}
                      onClick={() => setShowAssetsSection((prev) => !prev)}
                      title={showAssetsSection ? "Collapse assets section" : "Expand assets section"}
                      aria-expanded={showAssetsSection}
                    >
                      <span>{hasAssets ? `Assets (${sortedAssets.length})` : "Assets"}</span>
                      <ChevronDownIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => assetsFolderPath && void openInFinder(assetsFolderPath)}
                      title="Open assets folder"
                      aria-label="Open assets folder"
                    >
                      <FolderOpenIcon />
                    </button>
                  </div>
                  <div className={`collapsible-content ${showAssetsSection ? "open" : ""}`}>
                    {sortedAssets.map((asset) => (
                      <button
                        key={asset.relPath}
                        className={`tree-row asset-row ${selectedRelPath === asset.relPath ? "active" : ""}`}
                        onClick={() => {
                          void loadSelectedFile(selectedTopic, asset.relPath, "user-asset-click");
                        }}
                      >
                        <span className="asset-row-left">
                          {asset.isImage ? (
                            <img className="asset-thumb" src={convertFileSrc(asset.absPath)} alt={asset.relPath} />
                          ) : asset.isVideo ? (
                            <video className="asset-thumb" src={convertFileSrc(asset.absPath)} muted playsInline preload="metadata" />
                          ) : (
                            <span className="asset-thumb asset-thumb-file">FILE</span>
                          )}
                          <span className="asset-file-name">{fileNameFromRelPath(asset.relPath)}</span>
                        </span>
                        {asset.isImage ? <span className="pill">Image</span> : asset.isVideo ? <span className="pill">Video</span> : <span className="pill">Asset</span>}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="collapsible-block">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className={`section-toggle ${showDerivativesSection ? "open" : ""} ${hasDerivatives ? "section-status-ok" : "section-status-empty"}`}
                      onClick={() => setShowDerivativesSection((prev) => !prev)}
                      title={showDerivativesSection ? "Collapse derivatives section" : "Expand derivatives section"}
                      aria-expanded={showDerivativesSection}
                    >
                      <span>{hasDerivatives ? `Derivatives (${selectedTopic.derivatives.length})` : "Derivatives"}</span>
                      <ChevronDownIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => derivativesFolderPath && void openInFinder(derivativesFolderPath)}
                      title="Open derivatives folder"
                      aria-label="Open derivatives folder"
                    >
                      <FolderOpenIcon />
                    </button>
                  </div>
                  <div className={`collapsible-content ${showDerivativesSection ? "open" : ""}`}>
                    {groupedDerivativeEntries.map(([kind, entries]) => (
                      <div key={kind} className="derivative-group">
                        <h4>{kind} ({entries.length})</h4>
                        {entries.map((entry) => (
                          <button
                            key={entry.relPath}
                            className={`tree-row ${selectedRelPath === entry.relPath ? "active" : ""}`}
                            onClick={() => void loadSelectedFile(selectedTopic, entry.relPath, "user-derivative-click")}
                          >
                            <span>{entry.title}</span>
                            <span className={`pill status-${entry.status.toLowerCase()}`}>{entry.status}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
        <div
          className="pane-resizer"
          role="separator"
          aria-label="Resize editor panel"
          aria-orientation="vertical"
          onPointerDown={(event) => beginPaneResize("right", event)}
        />

        <aside className="panel right-panel">
          {selectedTopic && (
            <div className="panel-toggle">
              <button className={activeTab === "edit" ? "active" : ""} onClick={() => setActiveTab("edit")}>Edit</button>
              <button
                className={activeTab === "deploy" ? "active" : ""}
                onClick={() => setActiveTab("deploy")}
                disabled={!selectedIsDerivative}
              >
                Deploy
              </button>
            </div>
          )}

          {activeTab === "edit" && (
            <div className="tab-body">
              <div className="row">
                <small className="path-label" title={selectedAbsolutePath ?? undefined}>File: {selectedFileName}</small>
                <small>
                  {selectedEditorKind
                    ? selectedEditorKind === "grapesjs"
                      ? "HTML editor (GrapesJS)"
                      : selectedEditorKind === "milkdown"
                        ? "Markdown editor"
                        : "Image editor"
                    : "Preview only"}
                </small>
              </div>
              <div className="row">
                <small className="path-label">Type: {selectedFileKindLabel}</small>
                <small>{selectedAbsolutePath ? "Local file linked" : "No file selected"}</small>
              </div>
              <div className="inline-options-wrap file-actions-wrap">
                <button
                  type="button"
                  className={`icon-button ${showFileActions ? "active" : ""}`}
                  onClick={() => setShowFileActions((prev) => !prev)}
                  title={showFileActions ? "Collapse file actions" : "Expand file actions"}
                  aria-expanded={showFileActions}
                  aria-label={showFileActions ? "Collapse file actions" : "Expand file actions"}
                >
                  <ChevronLeftIcon className={showFileActions ? "arrow-open" : ""} />
                </button>
                <div className={`inline-options-panel ${showFileActions ? "open" : ""}`}>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={!selectedAbsolutePath}
                    onClick={() => selectedAbsolutePath && void openFileExternally(selectedAbsolutePath)}
                    title="Open file externally"
                    aria-label="Open file externally"
                  >
                    <ArrowTopRightOnSquareIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={!canOpenEditor || busy}
                    onClick={openEditor}
                    title="Open editor window"
                    aria-label="Open editor window"
                  >
                    <ComputerDesktopIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={!selectedRelPath || busy || selectedIsRenameProtectedContractFile}
                    onClick={startRenameSelectedFileInTopic}
                    title="Rename file"
                    aria-label="Rename file"
                  >
                    <PencilIcon />
                  </button>
                  {canReplaceSelectedFile && (
                    <button
                      type="button"
                      className="icon-button"
                      disabled={!selectedRelPath || busy}
                      onClick={() => void replaceSelectedFileInTopic()}
                      title="Replace file"
                      aria-label="Replace file"
                    >
                      <ArrowPathIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button danger"
                    disabled={!selectedRelPath || busy || selectedIsDeleteProtectedContractFile}
                    onClick={() => void deleteSelectedFileInTopic()}
                    title="Delete file"
                    aria-label="Delete file"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
              {selectedIsAsset && selectedAbsolutePath ? (
                selectedAsset?.isImage ? (
                  <div className="asset-preview">
                    <img src={convertFileSrc(selectedAbsolutePath)} alt={selectedRelPath ?? "asset"} />
                  </div>
                ) : selectedAsset?.isVideo ? (
                  <div className="asset-preview">
                    <video src={convertFileSrc(selectedAbsolutePath)} controls playsInline preload="metadata" />
                  </div>
                ) : (
                  <p className="muted">Preview unavailable for this asset type. Use Open file externally.</p>
                )
              ) : (
                <iframe
                  key={`${selectedTopicSlug ?? "none"}:${selectedRelPath ?? "none"}:${previewEpoch}`}
                  title="preview"
                  srcDoc={previewDoc}
                  className={`preview preview-large ${isHtmlPath(selectedRelPath) ? "preview-html" : ""}`}
                />
              )}
            </div>
          )}

          {activeTab === "deploy" && (
            <div className="tab-body">
              {!selectedRelPath ? (
                <p className="muted">Select a file to configure deployment.</p>
              ) : !selectedIsDerivative ? (
                <>
                  <p className="muted">Deploy workflow applies only to derivative files.</p>
                  {firstDerivativeRelPath && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => selectedTopic && void loadSelectedFile(selectedTopic, firstDerivativeRelPath, "deploy-manual-select")}
                    >
                      Select first derivative
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="row">
                    <small className="path-label" title={selectedRelPath}>File: {selectedFileName}</small>
                    <small>{selectedDerivative?.kind ?? "Derivative"}</small>
                  </div>

                  <div className="deploy-progress">
                    <div className="deploy-progress-track">
                      <div
                        className="deploy-progress-fill"
                        style={{ width: `${(deployProgressStep / 2) * 100}%` }}
                      />
                    </div>
                    <div className="deploy-progress-steps">
                      {(["Draft", "Revised", "Deployed"] as DerivativeStatus[]).map((step, index) => (
                        <button
                          key={step}
                          type="button"
                          className={`deploy-step ${deployStatus === step ? "active" : ""} ${index <= deployProgressStep ? "complete" : ""}`}
                          onClick={() => void applyDeployStep(step)}
                          disabled={busy}
                        >
                          {step}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="deployments-section">
                    <label>Deployments</label>
                    <div className="deployment-input-row">
                      <input
                        value={deployChannelInput}
                        onChange={(e) => setDeployChannelInput(e.target.value)}
                        disabled={busy}
                        placeholder="Select or type channel"
                        list="workspace-deployment-channels"
                      />
                      <datalist id="workspace-deployment-channels">
                        {deploymentChannelOptions.map((channel) => (
                          <option key={channel} value={channel} />
                        ))}
                      </datalist>
                      <button
                        type="button"
                        onClick={() => deployChannelInput && void addDeploymentChannel(deployChannelInput)}
                        disabled={busy || !deployChannelInput}
                      >
                        Add
                      </button>
                    </div>
                    {workspaceAvailableChannels.length === 0 && (
                      <small className="muted">
                        Add workspace channels from the header workspace edit button first.
                      </small>
                    )}
                    {deployedChannels.length > 0 && (
                      <div className="tag-list">
                        {deployedChannels.map((channel) => (
                          <span key={channel} className="tag-chip">
                            {channel}
                            <button
                              type="button"
                              onClick={() => removeDeploymentChannel(channel)}
                              title={`Remove deployment ${channel}`}
                              aria-label={`Remove deployment ${channel}`}
                            >
                              <XMarkIcon />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <label>Notes</label>
                  <textarea value={deployNotes} onChange={(e) => setDeployNotes(e.target.value)} />
                  <button disabled={!selectedRelPath || busy} onClick={() => void saveDeployState()}>
                    Save deploy state
                  </button>
                </>
              )}
            </div>
          )}

          <p className="notice">{notice}</p>
        </aside>
      </main>

      {showTopicLog && selectedTopic && (
        <div className="topic-log-panel">
          <div className="topic-log-header">
            <h3>Topic File Log</h3>
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowTopicLog(false)}
              title="Close topic log"
              aria-label="Close topic log"
            >
              <XMarkIcon />
            </button>
          </div>
          <small>{selectedTopic.title}</small>
          <div className="topic-log-table-wrap">
            <table className="topic-log-table">
              <thead>
                <tr>
                  <th scope="col">Topic</th>
                  <th scope="col">File Type</th>
                  <th scope="col">Date Time</th>
                </tr>
              </thead>
              <tbody>
                {topicFileLogEntries.map((entry, idx) => (
                  <tr
                    key={`${entry.relPath}-${idx}`}
                    className="topic-log-row-link"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setShowTopicLog(false);
                      void loadSelectedFile(selectedTopic, entry.relPath, "topic-log-row-click");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setShowTopicLog(false);
                        void loadSelectedFile(selectedTopic, entry.relPath, "topic-log-row-key");
                      }
                    }}
                    aria-label={`Open ${entry.relPath}`}
                  >
                    <td title={selectedTopic.title}>{selectedTopic.title}</td>
                    <td>{entry.kind}</td>
                    <td>{toDateLabel(entry.modifiedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pendingDeleteTopic && (
        <div className="confirm-backdrop">
          <div className="confirm-card">
            <h3>Delete Topic?</h3>
            <p>
              Delete topic <strong>{pendingDeleteTopic.title}</strong> and all files?
            </p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setPendingDeleteTopic(null)} disabled={busy}>Cancel</button>
              <button type="button" onClick={() => void confirmTopicDelete()} disabled={busy}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteFile && (
        <div className="confirm-backdrop">
          <div className="confirm-card">
            <h3>{pendingDeleteFile.isMaster ? "Delete Master?" : "Delete File?"}</h3>
            {pendingDeleteFile.isMaster ? (
              <p>
                Delete <strong>master.md</strong> for topic <strong>{pendingDeleteFile.topicTitle}</strong>?
                This also deletes all derivative files and keeps <code>assets/</code> and <code>topic.json</code>.
              </p>
            ) : (
              <p>
                Delete file <strong>{pendingDeleteFile.relPath}</strong> from topic{" "}
                <strong>{pendingDeleteFile.topicTitle}</strong>?
              </p>
            )}
            <div className="confirm-actions">
              <button type="button" onClick={() => setPendingDeleteFile(null)} disabled={busy}>Cancel</button>
              <button type="button" onClick={() => void confirmSelectedFileDelete()} disabled={busy}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {showWorkspaceModal && (
        <div className="confirm-backdrop">
          <div className="confirm-card modal-card">
            <h3>New Workspace</h3>
            <div className="modal-form">
              <input
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder="Workspace name"
              />
              <label>Channels</label>
              <div className="deployment-input-row">
                <input
                  value={newWorkspaceChannelInput}
                  onChange={(e) => setNewWorkspaceChannelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addNewWorkspaceChannel();
                    }
                  }}
                  placeholder="Add channel (e.g. Email)"
                />
                <button type="button" onClick={addNewWorkspaceChannel} disabled={!newWorkspaceChannelInput.trim()}>
                  Add
                </button>
              </div>
              {newWorkspaceChannels.length > 0 && (
                <div className="tag-list">
                  {newWorkspaceChannels.map((channel) => (
                    <span key={channel} className="tag-chip">
                      {channel}
                      <button
                        type="button"
                        onClick={() => removeNewWorkspaceChannel(channel)}
                        title={`Remove channel ${channel}`}
                        aria-label={`Remove channel ${channel}`}
                      >
                        <XMarkIcon />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="inline-icon-button"
                onClick={() => void pickWorkspaceKnowledgeFiles()}
                disabled={busy}
                title="Add knowledge files"
              >
                <FolderOpenIcon />
                Add knowledge files
              </button>
              {newWorkspaceKnowledgePaths.length > 0 && (
                <div className="queued-files">
                  <small>{newWorkspaceKnowledgePaths.length} knowledge file(s) queued</small>
                  {newWorkspaceKnowledgePaths.map((path) => (
                    <div key={path} className="queued-row">
                      <small>{path}</small>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setNewWorkspaceKnowledgePaths((prev) => prev.filter((item) => item !== path))}
                        title={`Remove ${path}`}
                        aria-label={`Remove ${path}`}
                      >
                        <XMarkIcon />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                onClick={() => {
                  setShowWorkspaceModal(false);
                  setNewWorkspaceName("");
                  setNewWorkspaceChannels([]);
                  setNewWorkspaceChannelInput("");
                  setNewWorkspaceKnowledgePaths([]);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void addWorkspace()} disabled={busy || !newWorkspaceName.trim()}>
                Create Workspace
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditWorkspaceModal && (
        <div className="confirm-backdrop">
          <div className="confirm-card modal-card">
            <h3>Edit Workspace</h3>
            <div className="modal-form">
              <input
                value={workspaceTitleInput}
                onChange={(e) => setWorkspaceTitleInput(e.target.value)}
                placeholder="Workspace title"
              />
              <label>Channels</label>
              <div className="deployment-input-row">
                <input
                  value={workspaceChannelEditInput}
                  onChange={(e) => setWorkspaceChannelEditInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addWorkspaceEditChannel();
                    }
                  }}
                  placeholder="Add channel (e.g. LinkedIn)"
                />
                <button type="button" onClick={addWorkspaceEditChannel} disabled={!workspaceChannelEditInput.trim()}>
                  Add
                </button>
              </div>
              {workspaceChannelsEdit.length > 0 ? (
                <div className="tag-list">
                  {workspaceChannelsEdit.map((channel) => (
                    <span key={channel} className="tag-chip">
                      {channel}
                      <button
                        type="button"
                        onClick={() => removeWorkspaceEditChannel(channel)}
                        title={`Remove channel ${channel}`}
                        aria-label={`Remove channel ${channel}`}
                      >
                        <XMarkIcon />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <small className="muted">No channels yet.</small>
              )}
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                onClick={() => {
                  setShowEditWorkspaceModal(false);
                  setWorkspaceChannelEditInput("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void saveWorkspaceSettings()} disabled={busy || !activeWorkspace}>
                Save Workspace
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateTopicModal && (
        <div className="confirm-backdrop">
          <div className="confirm-card modal-card">
            <h3>Make Topic</h3>
            <div className="modal-form">
              <input
                placeholder="New topic name"
                value={newTopicName}
                onChange={(e) => setNewTopicName(e.target.value)}
              />
              <button
                onClick={() => void pickMasterFile()}
                type="button"
                className="inline-icon-button"
                title="Pick starter master article (optional)"
              >
                <FolderOpenIcon />
                Optional: Pick starter master (.md)
              </button>
              {newTopicMasterSourcePath && (
                <small>
                  Master: {newTopicMasterSourcePath}{" "}
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setNewTopicMasterSourcePath(null)}
                    title="Remove master selection"
                    aria-label="Remove master selection"
                  >
                    <XMarkIcon />
                  </button>
                </small>
              )}
              {!newTopicMasterSourcePath && (
                <small className="muted">
                  No master selected: app will generate a blank contract-ready `master.md` template.
                </small>
              )}
              <button
                onClick={() => void pickAssets()}
                type="button"
                className="inline-icon-button"
                title="Add asset files"
              >
                <FolderOpenIcon />
                Add asset files
              </button>
              {newTopicAssetPaths.length > 0 && (
                <div className="queued-files">
                  <small>{newTopicAssetPaths.length} asset file(s) queued</small>
                  {newTopicAssetPaths.map((path) => (
                    <div key={path} className="queued-row">
                      <small>{path}</small>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => removeQueuedAsset(path)}
                        title={`Remove ${path}`}
                        aria-label={`Remove ${path}`}
                      >
                        <XMarkIcon />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                onClick={() => {
                  setShowCreateTopicModal(false);
                  setNewTopicName("");
                  setNewTopicMasterSourcePath(null);
                  setNewTopicAssetPaths([]);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void createNewTopic()} disabled={busy || !canCreateTopic}>
                Make Topic
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameModal && (
        <div className="confirm-backdrop">
          <div className="confirm-card modal-card">
            <h3>Rename File</h3>
            <div className="modal-form">
              <input
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                placeholder="New file name"
              />
              <small className="muted">{renameHelp}</small>
            </div>
            <div className="confirm-actions">
              <button type="button" onClick={() => setShowRenameModal(false)} disabled={busy}>Cancel</button>
              <button type="button" onClick={() => void confirmRenameSelectedFileInTopic()} disabled={busy || !renameInput.trim()}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
