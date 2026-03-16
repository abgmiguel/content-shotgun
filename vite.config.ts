import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: {
      host: "127.0.0.1",
      protocol: "ws"
    },
    watch: {
      ignored: [
        "**/workspace/**",
        "**/src-tauri/target/**"
      ]
    }
  }
});
