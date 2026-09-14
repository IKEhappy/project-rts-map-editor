// 开发入口：起 Vite → 等端口 → 起 Electron（注入 ME_RENDERER_URL 与 CDP 端口）。
// ME_CDP 默认开（AI 调试回路），ME_NO_CDP=1 关闭。
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

const VITE_PORT = 5173;

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* best effort */
  }
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`vite 未在 ${timeoutMs}ms 内监听 ${port}`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true });
try {
  await waitForPort(VITE_PORT, 60000);
} catch (err) {
  console.error(String(err.message || err));
  killTree(vite);
  process.exit(1);
}

// 9222 被占时 Electron 的 CDP 会静默失败，AI 调试回路断链——提前暴露
try {
  const response = await fetch("http://127.0.0.1:9222/json/list");
  if (Array.isArray(await response.json())) {
    console.error("端口 9222 已被占用（残留窗口？）——请先关闭，或用 ME_NO_CDP=1 显式关闭调试端口");
  }
} catch {
  /* 连接失败 = 端口空闲 */
}

const appEnv = {
  ...process.env,
  ME_RENDERER_URL: `http://127.0.0.1:${VITE_PORT}`,
  ME_CDP: process.env.ME_NO_CDP ? "" : "1",
};
const electronApp = spawn('npx', ['electron', '.'], { stdio: 'inherit', shell: true, env: appEnv });
electronApp.on('exit', (code) => {
  killTree(vite);
  process.exit(code ?? 0);
});
