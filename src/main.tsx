import React from "react";
import ReactDOM from "react-dom/client";
import { appWindow } from "@tauri-apps/api/window";
import App from "./App";
import EditorWindow from "./EditorWindow";
import "./styles.css";

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || "Unknown runtime error" };
  }

  componentDidCatch(error: Error) {
    // Keep this in console for local debugging while preventing full white-screen lock.
    // eslint-disable-next-line no-console
    console.error("App runtime error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "1rem", fontFamily: "IBM Plex Sans, sans-serif" }}>
          <h2>App error</h2>
          <p>{this.state.message}</p>
          <p>Restart the app and retry the previous action.</p>
          <button onClick={() => window.location.reload()}>Reset App</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function isEditorWindow(): boolean {
  const searchEditor = new URLSearchParams(window.location.search).get("editor") === "1";
  if (searchEditor) return true;
  try {
    return appWindow.label.startsWith("editor-");
  } catch (error) {
    // Keep the shell usable even if the Tauri bridge is not ready yet.
    // eslint-disable-next-line no-console
    console.warn("Tauri window label unavailable during startup:", error);
    return false;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    {isEditorWindow() ? <EditorWindow /> : <App />}
  </AppErrorBoundary>
);
