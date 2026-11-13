import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/files": { target: "http://127.0.0.1:4317", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4317", ws: true, changeOrigin: true },
    },
  },
});
