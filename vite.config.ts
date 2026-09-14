import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 渲染进程保持纯 web（T-164 硬条件④的迁移路径）：base "./" 使 dist 可经 file:// 加载
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist" },
  // host 钉死 IPv4：Vite 7 默认 localhost 可能只绑 ::1，导致 127.0.0.1 探活与 Electron URL 失联
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
