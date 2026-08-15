import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    outDir: "dist/console",
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/healthz": "http://127.0.0.1:3100",
      "/readyz": "http://127.0.0.1:3100",
      "/v1": "http://127.0.0.1:3100",
    },
  },
});
