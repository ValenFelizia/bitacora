import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { DICTATION_PATH } from "../server/src/dictation";
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.BITACORA_WEB_PORT || 5173),
    strictPort: true,
    proxy: {
      "/files": { target: `http://127.0.0.1:${process.env.BITACORA_PORT || 4317}`, changeOrigin: true },
      [DICTATION_PATH]: { target: `http://127.0.0.1:${process.env.BITACORA_PORT || 4317}`, changeOrigin: true },
      "/ws": { target: `ws://127.0.0.1:${process.env.BITACORA_PORT || 4317}`, ws: true, changeOrigin: true },
    },
  },
});
