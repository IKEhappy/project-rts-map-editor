import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkspaceFixture, launchEditor, runWorkspaceSmoke } from "./workspace-smoke.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceProject = path.resolve(process.env.ME_GAME_DIR || path.join(root, "..", "project-rts"));
const fixture = createWorkspaceFixture({ parent: path.join(root, ".smoke-data"), project: sourceProject });
const artifacts = path.join(root, ".smoke-artifacts");
let editor;
try {
  editor = await launchEditor({
    executable: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root], cwd: root, port: 9223,
    env: { ME_MAP_PROJECT: fixture.project, ME_GODOT_PROJECT: sourceProject, ME_DATA_DIR: path.join(fixture.project, "data") },
  });
  const report = await runWorkspaceSmoke({ client: editor.client, fixture, artifacts });
  console.log(`SMOKE_OK checks=${report.checks.length} screenshots=${report.layouts.length}`);
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
