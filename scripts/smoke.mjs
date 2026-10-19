import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createWorkspaceFixture, launchEditor, runWorkspaceSmoke } from "./workspace-smoke.mjs";
import { runFlagsSmoke } from "./flags-smoke.mjs";
import { runThemeSmoke } from "./theme-smoke.mjs";
import { runFieldDeletionSmoke } from "./field-deletion-smoke.mjs";
import { runSaveSmoke } from "./save-smoke.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceProject = path.resolve(process.env.ME_GAME_DIR || path.join(root, "..", "project-rts"));
const fixture = createWorkspaceFixture({ parent: path.join(os.tmpdir(), "them-pixel-front-map-editor-smoke"), project: sourceProject });
const artifacts = path.join(root, ".smoke-artifacts");
let editor;
try {
  editor = await launchEditor({
    executable: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root, `--user-data-dir=${path.join(fixture.root, "electron-profile")}`,
      "--force-device-scale-factor=1", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], cwd: root, port: 9223,
    env: { ME_MAP_PROJECT: fixture.project, ME_GODOT_PROJECT: sourceProject, ME_DATA_DIR: path.join(fixture.project, "data") },
  });
  const report = await runWorkspaceSmoke({ client: editor.client, fixture, artifacts });
  const flags = await runFlagsSmoke({ client: editor.client, fixture, artifacts });
  const { runHoverSmoke } = await import("./hover-smoke.mjs");
  const hover = await runHoverSmoke({ client: editor.client, fixture, artifacts });
  const { runVisibilitySmoke } = await import("./visibility-smoke.mjs");
  const visibility = await runVisibilitySmoke({ client: editor.client, fixture, artifacts });
  const { runInspectorSmoke } = await import("./inspector-smoke.mjs");
  const inspector = await runInspectorSmoke({ client: editor.client, fixture, artifacts });
  const theme = await runThemeSmoke({ client: editor.client, artifacts });
  const deletion = await runFieldDeletionSmoke({ client: editor.client, fixture, artifacts });
  const saves = await runSaveSmoke({ client: editor.client, fixture, artifacts });
  console.log(`SMOKE_OK checks=${report.checks.length + flags.checks.length + hover.checks.length + visibility.checks.length + inspector.checks.length + theme.length + deletion.checks.length + saves.checks.length} screenshots=${report.layouts.length + hover.layouts.length + visibility.layouts.length + inspector.layouts.length + deletion.layouts.length + 3}`);
} catch (error) {
  console.error("SMOKE_FAIL", error);
  if (editor) {
    const screenshot = await editor.client.Page.captureScreenshot({ format: "png" }).catch(() => null);
    fs.mkdirSync(artifacts, { recursive: true });
    if (screenshot) fs.writeFileSync(path.join(artifacts, "workspace-failure.png"), Buffer.from(screenshot.data, "base64"));
    fs.writeFileSync(path.join(artifacts, "workspace-failure.log"), `${error.stack}\n${editor.output.join("")}`);
  }
  process.exitCode = 1;
} finally {
  if (editor) await editor.close();
}
