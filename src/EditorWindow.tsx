import { useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { readBinaryFile, writeBinaryFile } from "@tauri-apps/api/fs";
import { appWindow } from "@tauri-apps/api/window";
import grapesjs from "grapesjs";
import type { Editor as GrapesEditor } from "grapesjs";
import { Crepe } from "@milkdown/crepe";
import FilerobotImageEditor from "react-filerobot-image-editor";
import type { getCurrentImgDataFunction } from "react-filerobot-image-editor";
import {
  CodeBracketSquareIcon,
  CheckIcon,
  DocumentTextIcon,
  MoonIcon,
  PhotoIcon,
  Squares2X2Icon,
  SunIcon
} from "@heroicons/react/24/outline";
import "grapesjs/dist/css/grapes.min.css";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/nord.css";
import { readTextFile, writeTextFile } from "./appBridge";
import { composeHtmlDocument, splitHtmlAndCss, type PreservedHtmlDocumentShell } from "./editorContent";
import { bytesToDataUrl, inferImageMimeType } from "./imageEditorSource";

type EditorKind = "grapesjs" | "milkdown" | "filerobot";

const FILEROBOT_DARK_THEME = {
  palette: {
    "txt-primary": "#e5e7eb",
    "txt-secondary": "#94a3b8",
    "txt-placeholder": "#64748b",
    "accent-primary": "#60a5fa",
    "accent-primary-hover": "#3b82f6",
    "accent-primary-active": "#93c5fd",
    "accent-primary-disabled": "#334155",
    "accent-stateless": "#60a5fa",
    accent_1_2_opacity: "rgba(96, 165, 250, 0.18)",
    accent_1_8_opacity: "rgba(96, 165, 250, 0.28)",
    accent_2_8_opacity: "rgba(96, 165, 250, 0.36)",
    accent_4_0_opacity: "rgba(96, 165, 250, 0.52)",
    "bg-grey": "#1f2937",
    "bg-stateless": "#111827",
    "bg-active": "#1e293b",
    "bg-base-light": "#172132",
    "bg-base-medium": "#1b283b",
    "bg-primary": "#0f172a",
    "bg-primary-light": "#162132",
    "bg-primary-hover": "#1b283b",
    "bg-primary-active": "#1e293b",
    "bg-primary-stateless": "#334155",
    "bg-secondary": "#0b1220",
    "bg-hover": "#172131",
    "bg-tooltip": "#111827",
    "icon-primary": "#cbd5e1",
    "icons-secondary": "#94a3b8",
    "icons-placeholder": "#475569",
    "icons-invert": "#f8fafc",
    "icons-muted": "#64748b",
    "icons-primary-hover": "#e2e8f0",
    "icons-secondary-hover": "#cbd5e1",
    "btn-primary-text": "#f8fafc",
    "btn-disabled-text": "#64748b",
    "link-primary": "#cbd5e1",
    "link-stateless": "#cbd5e1",
    "link-hover": "#e2e8f0",
    "link-active": "#f8fafc",
    "borders-primary": "#334155",
    "borders-secondary": "#334155",
    "borders-strong": "#475569",
    "border-primary-stateless": "#334155",
    "border-hover-bottom": "rgba(96, 165, 250, 0.28)",
    "border-active-bottom": "#60a5fa",
    "borders-disabled": "#475569",
    "active-secondary": "#0f172a",
    "active-secondary-hover": "#1e293b",
    "light-shadow": "rgba(2, 6, 23, 0.45)",
    "medium-shadow": "rgba(2, 6, 23, 0.55)",
    "large-shadow": "rgba(2, 6, 23, 0.65)",
    "x-large-shadow": "rgba(2, 6, 23, 0.78)"
  },
  typography: {
    fontFamily: "IBM Plex Sans, sans-serif"
  }
} as const;

interface EditorInit {
  kind: EditorKind;
  path: string;
}

const TRACE_EDITOR_LOAD = import.meta.env.DEV || import.meta.env.VITE_TRACE_EDITOR_LOADING === "1";
const MILKDOWN_INIT_TIMEOUT_MS = 8000;
const ENABLE_MILKDOWN = import.meta.env.VITE_ENABLE_MILKDOWN !== "0";
const RUNTIME_MARKER = "codex-r5-20260312-1215";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function traceEditor(event: string, details: Record<string, unknown>): void {
  if (!TRACE_EDITOR_LOAD) return;
  // eslint-disable-next-line no-console
  console.debug(`[editor-load] ${event}`, details);
}

function edgeSnippet(value: string, edgeLength = 200): { first: string; last: string } {
  const normalize = (input: string): string => input.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  if (value.length <= edgeLength) {
    const snippet = normalize(value);
    return { first: snippet, last: snippet };
  }
  return {
    first: normalize(value.slice(0, edgeLength)),
    last: normalize(value.slice(-edgeLength))
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isEditorKind(value: unknown): value is EditorKind {
  return value === "grapesjs" || value === "milkdown" || value === "filerobot";
}

function dataUrlToBytes(input: string): Uint8Array {
  const commaIdx = input.indexOf(",");
  const base64 = commaIdx >= 0 ? input.slice(commaIdx + 1) : input;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function fileNameFromPath(path: string): string {
  const normalized = path.split("\\").join("/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function readInitPayload(): EditorInit | null {
  const label = appWindow.label;
  const storageKey = `editor:init:${label}`;
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    localStorage.removeItem(storageKey);
    try {
      const parsed = JSON.parse(stored) as { kind?: string; path?: string };
      if (isEditorKind(parsed.kind) && parsed.path) {
        return { kind: parsed.kind, path: parsed.path };
      }
    } catch {
      // ignore and try URL fallback
    }
  }

  const params = new URLSearchParams(window.location.search);
  const kind = params.get("kind");
  const path = params.get("path");
  if (isEditorKind(kind) && path) {
    return { kind, path };
  }
  return null;
}

function EditorWindow() {
  const init = useMemo(readInitPayload, []);
  const [editorTheme, setEditorTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("editor-window-theme");
    return saved === "dark" ? "dark" : "light";
  });

  const [content, setContent] = useState("");
  const [fallbackContent, setFallbackContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [fileLoaded, setFileLoaded] = useState(false);
  const [grapesReady, setGrapesReady] = useState(false);
  const [milkdownReady, setMilkdownReady] = useState(false);
  const [grapesFailed, setGrapesFailed] = useState(false);
  const [milkdownFailed, setMilkdownFailed] = useState(false);
  const [fileContentLength, setFileContentLength] = useState(0);
  const [grapesHtmlLength, setGrapesHtmlLength] = useState(0);
  const [grapesFrameSize, setGrapesFrameSize] = useState("0x0");
  const [milkdownRootChildren, setMilkdownRootChildren] = useState(0);
  const [imageSource, setImageSource] = useState("");
  const filerobotTheme = editorTheme === "dark" ? FILEROBOT_DARK_THEME : undefined;
  const editorModeLabel = init
    ? init.kind === "grapesjs"
      ? "HTML Editor"
      : init.kind === "milkdown"
        ? "Markdown Editor"
        : "Image Editor"
    : "No Editor";
  const editorModeMetric = init
    ? init.kind === "grapesjs"
      ? `html: ${grapesHtmlLength} | canvas: ${grapesFrameSize}`
      : init.kind === "milkdown"
        ? `root: ${milkdownRootChildren}`
        : `image: ${imageSource ? "loaded" : "loading"}`
    : "state: unavailable";

  const grapesRootRef = useRef<HTMLDivElement | null>(null);
  const grapesEditorRef = useRef<GrapesEditor | null>(null);
  const grapesDocModeRef = useRef(false);
  const grapesDocShellRef = useRef<PreservedHtmlDocumentShell | null>(null);

  const milkdownRootRef = useRef<HTMLDivElement | null>(null);
  const milkdownEditorRef = useRef<Crepe | null>(null);
  const filerobotCurrentImgRef = useRef<getCurrentImgDataFunction | undefined>(undefined);

  function applyGrapesFrameSizing(editor: GrapesEditor | null): void {
    if (!editor) return;
    const rootContainer = grapesRootRef.current;
    const panelEl = editor.getContainer()?.querySelector(".gjs-pn-views-container") as HTMLElement | null;
    if (rootContainer && panelEl) {
      const panelWidth = Math.max(0, Math.round(panelEl.getBoundingClientRect().width));
      rootContainer.style.setProperty("--gjs-right-panel-width", `${panelWidth}px`);
    }

    const frameEl = editor.Canvas.getFrameEl() as HTMLIFrameElement | null;
    if (!frameEl) {
      setGrapesFrameSize("0x0");
      return;
    }

    frameEl.style.display = "block";
    frameEl.style.width = "100%";
    frameEl.style.height = "100%";
    frameEl.style.minHeight = "320px";

    const wrapper = frameEl.parentElement as HTMLElement | null;
    if (wrapper) {
      wrapper.style.height = "100%";
      wrapper.style.minHeight = "320px";
      wrapper.style.flex = "1 1 auto";
    }

    const frameRoot = wrapper?.parentElement as HTMLElement | null;
    if (frameRoot) {
      frameRoot.style.height = "100%";
      frameRoot.style.minHeight = "320px";
      frameRoot.style.display = "flex";
      frameRoot.style.flexDirection = "column";
      frameRoot.style.flex = "1 1 auto";
    }

    const rect = frameEl.getBoundingClientRect();
    setGrapesFrameSize(`${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }

  function applyGrapesTheme(editor: GrapesEditor | null, theme: "light" | "dark"): void {
    if (!editor) return;
    const canvasEl = editor.getContainer()?.querySelector(".gjs-cv-canvas") as HTMLElement | null;
    const frameEl = editor.Canvas.getFrameEl() as HTMLIFrameElement | null;
    const doc = editor.Canvas.getDocument() as Document | null;
    const canvasBackground = theme === "dark" ? "#0b0f14" : "#ffffff";
    const overrideStyleId = "codex-grapes-theme-override";

    if (canvasEl) {
      canvasEl.style.backgroundColor = canvasBackground;
    }
    if (frameEl) {
      frameEl.style.backgroundColor = canvasBackground;
    }
    if (doc?.documentElement) {
      doc.documentElement.style.setProperty("color-scheme", theme);
    }
    if (doc?.head) {
      let styleEl = doc.getElementById(overrideStyleId) as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = doc.createElement("style");
        styleEl.id = overrideStyleId;
        doc.head.appendChild(styleEl);
      }
      styleEl.textContent = theme === "dark"
        ? `
html, body, #wrapper {
  background: #0b0f14 !important;
  color: #e5e7eb !important;
}
a { color: #93c5fd !important; }
`
        : `
html, body, #wrapper {
  background: #ffffff !important;
  color: #111827 !important;
}
a { color: #2563eb !important; }
`;
    }
  }

  function applyGrapesHeadAssets(editor: GrapesEditor | null, headHtml: string): void {
    if (!editor || !headHtml.trim()) return;
    const doc = editor.Canvas.getDocument() as Document | null;
    if (!doc?.head) return;

    for (const stale of Array.from(doc.head.querySelectorAll("[data-codex-preserved-head='1']"))) {
      stale.remove();
    }

    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><head>${headHtml}</head><body></body></html>`,
      "text/html"
    );
    const nodes = Array.from(parsed.head.children).filter((node) => node.tagName.toLowerCase() !== "script");
    for (const node of nodes) {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-codex-preserved-head", "1");
      doc.head.appendChild(clone);
    }
  }

  useEffect(() => {
    localStorage.setItem("editor-window-theme", editorTheme);
  }, [editorTheme]);

  useEffect(() => {
    if (!init) {
      setNotice("Missing editor initialization payload.");
      traceEditor("init:missing", { label: appWindow.label, search: window.location.search });
      return;
    }
    let cancelled = false;
    setFileLoaded(false);
    setGrapesReady(false);
    setMilkdownReady(false);
    setGrapesFailed(false);
    setMilkdownFailed(false);
    setFileContentLength(0);
    setGrapesHtmlLength(0);
    setGrapesFrameSize("0x0");
    setMilkdownRootChildren(0);
    setImageSource("");
    setNotice("");
    traceEditor("init:resolved", { kind: init.kind, path: init.path, label: appWindow.label });

    (async () => {
      if (init.kind === "filerobot") {
        try {
          const bytes = await readBinaryFile(init.path);
          if (cancelled) return;
          const mimeType = inferImageMimeType(init.path);
          setImageSource(bytesToDataUrl(bytes, mimeType));
          setFileContentLength(bytes.length);
          setFileLoaded(true);
          traceEditor("file:image:ready", { path: init.path, bytes: bytes.length, mimeType });
        } catch (error) {
          if (cancelled) return;
          const message = toErrorMessage(error);
          setNotice(message);
          traceEditor("file:image:error", { path: init.path, error: message });
        }
        return;
      }
      try {
        const next = await readTextFile(init.path);
        if (cancelled) return;
        setContent(next);
        setFallbackContent(next);
        setFileContentLength(next.length);
        setFileLoaded(true);
        window.scrollTo({ top: 0, behavior: "auto" });
        traceEditor("file:read:ok", { path: init.path, length: next.length });
      } catch (error) {
        if (cancelled) return;
        const message = toErrorMessage(error);
        setNotice(message);
        traceEditor("file:read:error", { path: init.path, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [init]);

  useEffect(() => {
    if (!init || init.kind !== "grapesjs" || !fileLoaded || !grapesRootRef.current) return;
    let cancelled = false;
    let onResize: (() => void) | null = null;

    (async () => {
      try {
        setGrapesFailed(false);
        if (cancelled || !grapesRootRef.current) return;

        if (grapesEditorRef.current) {
          grapesEditorRef.current.destroy();
          grapesEditorRef.current = null;
        }

        const parsed = splitHtmlAndCss(content);
        grapesDocModeRef.current = parsed.isFullDocument;
        grapesDocShellRef.current = parsed.isFullDocument
          ? {
            headHtml: parsed.headHtml,
            htmlAttrs: parsed.htmlAttrs,
            bodyAttrs: parsed.bodyAttrs
          }
          : null;
        const componentsSource = parsed.html.trim() || content.trim();

        grapesEditorRef.current = grapesjs.init({
          container: grapesRootRef.current,
          fromElement: false,
          height: "100%",
          storageManager: false,
          components: componentsSource,
          style: parsed.css
        });
        applyGrapesHeadAssets(grapesEditorRef.current, parsed.headHtml);
        grapesEditorRef.current.refresh({ tools: true });
        applyGrapesFrameSizing(grapesEditorRef.current);
        applyGrapesTheme(grapesEditorRef.current, editorTheme);
        grapesEditorRef.current.on("load", () => {
          applyGrapesHeadAssets(grapesEditorRef.current, parsed.headHtml);
          grapesEditorRef.current?.refresh({ tools: true });
          applyGrapesFrameSizing(grapesEditorRef.current);
          applyGrapesTheme(grapesEditorRef.current, editorTheme);
        });
        onResize = () => applyGrapesFrameSizing(grapesEditorRef.current);
        window.addEventListener("resize", onResize);
        const renderedLength = String(grapesEditorRef.current.getHtml?.() ?? "").length;
        traceEditor("grapes:components-applied", {
          path: init.path,
          sourceLength: componentsSource.length,
          cssLength: parsed.css.length,
          renderedLength
        });
        setGrapesHtmlLength(Number(renderedLength) || 0);
        setGrapesReady(true);
        traceEditor("grapes:ready", { path: init.path, contentLength: content.length });
      } catch (error) {
        if (cancelled) return;
        const message = toErrorMessage(error);
        setGrapesReady(false);
        setGrapesFailed(true);
        setGrapesHtmlLength(0);
        setGrapesFrameSize("0x0");
        setNotice(`GrapesJS failed to load (${message}). Using fallback editor.`);
        traceEditor("grapes:error", { path: init.path, error: message });
      }
    })();

    return () => {
      cancelled = true;
      if (onResize) {
        window.removeEventListener("resize", onResize);
      }
      if (grapesEditorRef.current) {
        grapesEditorRef.current.destroy();
        grapesEditorRef.current = null;
      }
      grapesDocShellRef.current = null;
      setGrapesReady(false);
    };
  }, [init, fileLoaded]);

  useEffect(() => {
    if (init?.kind !== "grapesjs") return;
    applyGrapesTheme(grapesEditorRef.current, editorTheme);
  }, [init, editorTheme, grapesReady]);

  useEffect(() => {
    if (!init || init.kind !== "milkdown" || !fileLoaded || !milkdownRootRef.current) return;
    if (!ENABLE_MILKDOWN) {
      setMilkdownReady(false);
      setMilkdownFailed(true);
      setMilkdownRootChildren(0);
      setNotice((prev) => prev || "Milkdown disabled by VITE_ENABLE_MILKDOWN=0. Using fallback editor.");
      return;
    }
    let cancelled = false;
    let initTimeoutId: number | null = null;

    (async () => {
      try {
        setMilkdownFailed(false);
        if (cancelled || !milkdownRootRef.current) return;

        if (milkdownEditorRef.current && typeof milkdownEditorRef.current.destroy === "function") {
          await milkdownEditorRef.current.destroy();
          milkdownEditorRef.current = null;
        }

        milkdownRootRef.current.innerHTML = "";
        milkdownEditorRef.current = new Crepe({
          root: milkdownRootRef.current,
          defaultValue: content
        });
        const createPromise = milkdownEditorRef.current.create();
        const timeoutPromise = new Promise<never>((_, reject) => {
          initTimeoutId = window.setTimeout(() => {
            reject(new Error(`initialization timed out after ${MILKDOWN_INIT_TIMEOUT_MS}ms`));
          }, MILKDOWN_INIT_TIMEOUT_MS);
        });
        await Promise.race([createPromise, timeoutPromise]);
        if (initTimeoutId !== null) {
          window.clearTimeout(initTimeoutId);
          initTimeoutId = null;
        }
        setMilkdownRootChildren(milkdownRootRef.current.children.length);
        const editable = milkdownRootRef.current.querySelector("[contenteditable='true']") as HTMLElement | null;
        if (!editable) {
          throw new Error("editor mounted without an editable surface");
        }
        // Keep initial caret/viewport at the top instead of browser restoring end-of-content scroll.
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        editable.focus({ preventScroll: true });
        editable.scrollTop = 0;
        milkdownRootRef.current.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        window.scrollTo({ top: 0, behavior: "auto" });
        if (milkdownRootRef.current) {
          milkdownRootRef.current.style.colorScheme = editorTheme;
        }

        if (cancelled) return;
        setMilkdownReady(true);
        traceEditor("milkdown:ready", { path: init.path, contentLength: content.length });
      } catch (error) {
        if (cancelled) return;
        if (initTimeoutId !== null) {
          window.clearTimeout(initTimeoutId);
          initTimeoutId = null;
        }
        const message = toErrorMessage(error);
        setMilkdownReady(false);
        setMilkdownFailed(true);
        setMilkdownRootChildren(0);
        setNotice(`Milkdown failed to load (${message}). Using fallback editor.`);
        traceEditor("milkdown:error", { path: init.path, error: message });
      }
    })();

    return () => {
      cancelled = true;
      if (initTimeoutId !== null) {
        window.clearTimeout(initTimeoutId);
        initTimeoutId = null;
      }
      if (milkdownEditorRef.current && typeof milkdownEditorRef.current.destroy === "function") {
        void milkdownEditorRef.current.destroy();
        milkdownEditorRef.current = null;
      }
      setMilkdownReady(false);
    };
  }, [init, fileLoaded, editorTheme]);

  async function saveImageBase64(imageBase64: string): Promise<void> {
    if (!init?.path) return;
    const bytes = dataUrlToBytes(imageBase64);
    await writeBinaryFile(init.path, bytes);
    setFileContentLength(bytes.length);
    setImageSource(imageBase64);
  }

  async function onImageSave(saved: { imageBase64?: string }): Promise<void> {
    if (init?.kind !== "filerobot") return;
    if (!saved.imageBase64) {
      setNotice("Image editor returned no image payload.");
      return;
    }
    setBusy(true);
    try {
      await saveImageBase64(saved.imageBase64);
      await emit("workspace:event", "editor-save");
      setNotice("Saved");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!init?.path) return;

    let next = fallbackContent;
    if (init.kind === "grapesjs" && grapesEditorRef.current) {
      next = composeHtmlDocument(
        grapesEditorRef.current.getHtml() as string,
        grapesEditorRef.current.getCss() as string,
        grapesDocModeRef.current,
        grapesDocShellRef.current
      );
    } else if (init.kind === "filerobot") {
      if (!filerobotCurrentImgRef.current) {
        setNotice("Image editor is still initializing.");
        return;
      }
      setBusy(true);
      try {
        const transformed = filerobotCurrentImgRef.current({}, false, true);
        try {
          if (!transformed.imageData.imageBase64) {
            throw new Error("Image editor returned no image payload.");
          }
          await saveImageBase64(transformed.imageData.imageBase64);
          await emit("workspace:event", "editor-save");
          setNotice("Saved");
        } finally {
          transformed.hideLoadingSpinner();
        }
      } catch (error) {
        setNotice(String(error));
      } finally {
        setBusy(false);
      }
      return;
    } else if (init.kind === "milkdown" && milkdownEditorRef.current && typeof milkdownEditorRef.current.getMarkdown === "function") {
      next = milkdownEditorRef.current.getMarkdown() as string;
    }

    setBusy(true);
    try {
      let payloadHash: string | null = null;
      if (TRACE_EDITOR_LOAD) {
        const payloadSnippet = edgeSnippet(next);
        try {
          payloadHash = await sha256Hex(next);
        } catch (error) {
          traceEditor("save:payload-hash:error", { path: init.path, error: toErrorMessage(error) });
        }
        traceEditor("save:payload", {
          path: init.path,
          length: next.length,
          first: payloadSnippet.first,
          last: payloadSnippet.last,
          hashBeforeWrite: payloadHash
        });
      }

      await writeTextFile(init.path, next);

      if (TRACE_EDITOR_LOAD) {
        try {
          const disk = await readTextFile(init.path);
          const diskSnippet = edgeSnippet(disk);
          const diskHash = await sha256Hex(disk);
          traceEditor("save:disk", {
            path: init.path,
            length: disk.length,
            first: diskSnippet.first,
            last: diskSnippet.last,
            hashAfterWrite: diskHash,
            hashMatches: payloadHash ? payloadHash === diskHash : null,
            contentMatches: disk === next
          });
        } catch (error) {
          traceEditor("save:disk-verify:error", { path: init.path, error: toErrorMessage(error) });
        }
      }

      setContent(next);
      setFallbackContent(next);
      setFileContentLength(next.length);
      if (init.kind === "grapesjs" && grapesEditorRef.current) {
        const renderedLength = String(grapesEditorRef.current.getHtml?.() ?? "").length;
        setGrapesHtmlLength(Number(renderedLength) || 0);
      }
      if (init.kind === "milkdown" && milkdownRootRef.current) {
        setMilkdownRootChildren(milkdownRootRef.current.children.length);
      }
      await emit("workspace:event", "editor-save");
      setNotice("Saved");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`editor-window-shell theme-${editorTheme}`}>
      <div className="editor-window-bar">
        <small className="editor-file-pill" title={init?.path ?? undefined}>
          <DocumentTextIcon />
          <span className="path-label">{init?.path ? fileNameFromPath(init.path) : "No file"}</span>
        </small>
        <small className="editor-diag">
          {init?.kind === "grapesjs"
            ? <CodeBracketSquareIcon />
            : init?.kind === "milkdown"
              ? <DocumentTextIcon />
              : <PhotoIcon />}
          {editorModeLabel}
        </small>
        <small className="editor-diag">
          <Squares2X2Icon />
          bytes: {fileContentLength}
        </small>
        <small className="editor-diag">
          <Squares2X2Icon />
          {editorModeMetric}
        </small>
        <small className="editor-diag" title="Runtime build marker">
          {RUNTIME_MARKER}
        </small>
        <div className="editor-window-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setEditorTheme((prev) => (prev === "light" ? "dark" : "light"))}
            disabled={busy}
            title={editorTheme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            aria-label={editorTheme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {editorTheme === "light" ? <MoonIcon /> : <SunIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void save()}
            disabled={busy || !init}
            title="Save file"
            aria-label="Save file"
          >
            <CheckIcon />
          </button>
        </div>
      </div>

      {!init ? (
        <div className="editor-window-content">
          <p className="muted">Editor failed to initialize.</p>
        </div>
      ) : init.kind === "grapesjs" ? (
        <div className="editor-window-content">
          <div ref={grapesRootRef} className="editor-window-canvas" style={{ visibility: grapesReady ? "visible" : "hidden" }} />
          {!grapesReady && !grapesFailed && (
            <p className="muted editor-window-loading">Loading GrapesJS editor...</p>
          )}
          {grapesFailed && (
            <textarea
              className="editor-window-fallback"
              value={fallbackContent}
              onChange={(e) => setFallbackContent(e.target.value)}
              placeholder="HTML fallback editor"
            />
          )}
        </div>
      ) : (
        <div className="editor-window-content">
          {init.kind === "milkdown" ? (
            <>
              <div
                ref={milkdownRootRef}
                className="editor-window-markdown"
                style={{ visibility: milkdownReady ? "visible" : "hidden" }}
              />
              {!milkdownReady && !milkdownFailed && (
                <p className="muted editor-window-loading">Loading Milkdown editor...</p>
              )}
              {milkdownFailed && (
                <textarea
                  className="editor-window-fallback"
                  value={fallbackContent}
                  onChange={(e) => setFallbackContent(e.target.value)}
                  placeholder="Markdown fallback editor"
                />
              )}
            </>
          ) : (
            <div className="editor-window-image">
              {imageSource ? (
                <FilerobotImageEditor
                  source={imageSource}
                  theme={filerobotTheme}
                  onSave={(savedImageData) => void onImageSave(savedImageData)}
                  closeAfterSave={false}
                  observePluginContainerSize
                  tabsIds={["Adjust", "Annotate", "Filters", "Finetune", "Resize", "Watermark"]}
                  savingPixelRatio={4}
                  previewPixelRatio={window.devicePixelRatio || 1}
                  getCurrentImgDataFnRef={filerobotCurrentImgRef}
                />
              ) : (
                <p className="muted editor-window-loading">Loading image editor...</p>
              )}
            </div>
          )}
        </div>
      )}

      <p className="notice">{notice}</p>
    </div>
  );
}

export default EditorWindow;
