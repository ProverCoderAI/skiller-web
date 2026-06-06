import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const serverPort = Number.parseInt(process.env.SKILLER_PORT ?? "17888", 10);
const apiTarget = `http://127.0.0.1:${Number.isFinite(serverPort) ? serverPort : 17888}`;

export default defineConfig({
  root: resolve(__dirname, "src/mainview"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    proxy: {
      "/events": apiTarget,
      "/health": apiTarget,
      "/trpc": apiTarget,
    },
  },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/mainview/index.html"),
    },
  },
});
