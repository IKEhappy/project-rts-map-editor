import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiCall, click, createWorkspaceFixture, evaluate, launchEditor, reload, waitFor } from "./workspace-smoke.mjs";

// CDP tests renderer behavior and checks explicit no-drag regions. Windows native
// hit testing must also be exercised with a real mouse (CDP bypasses WM_NCHITTEST).
export async function runThemeSmoke({ client, artifacts, check = (label, value, detail) => assert(value, `${label}: ${JSON.stringify(detail)}`) }) {
  const checks = [];
  const verify = (label, value, detail) => { check(label, value, detail); checks.push(label); };
  for (const choice of ["light", "dark", "system"]) {
    await click(client, "theme-trigger");
    await waitFor(client, "!!document.querySelector('[data-testid=theme-menu]')", "theme menu");
    const regions = await evaluate(client, `(() => {
      const menu = document.querySelector('[data-testid=theme-menu]');
      const rect = menu.getBoundingClientRect();
      return [menu, ...document.querySelectorAll('.workspace-bar')].filter(element => {
        const r = element.getBoundingClientRect();
        return r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
      }).map(element => ({ element: element.className, region: getComputedStyle(element).getPropertyValue('-webkit-app-region') }));
    })()`);
    verify(`theme ${choice} menu has no overlapping native drag rectangles`, regions.every(entry => entry.region === "no-drag"), regions);
    await click(client, `theme-${choice}`);
    verify(`theme ${choice} closes menu and persists selection`, await evaluate(client, `!document.querySelector('[data-testid=theme-menu]') && ${choice === "system" ? "localStorage.getItem('me.theme') === null" : `document.documentElement.dataset.theme === '${choice}' && localStorage.getItem('me.theme') === '${choice}'`}`));
    verify(`theme ${choice} keeps tab strip outside native dragging after closing`, await evaluate(client, "[...document.querySelectorAll('.workspace-bar')].every(element => getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'no-drag')"));
  }
  await click(client, "theme-trigger");
  const rect = await evaluate(client, "(() => {const r=document.querySelector('[data-testid=theme-menu]').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()");
  verify("theme menu stays inside viewport", rect.left >= 0 && rect.top >= 0 && rect.right <= rect.width && rect.bottom <= rect.height, rect);
  if (artifacts) fs.writeFileSync(path.join(artifacts, "theme-menu.png"), Buffer.from((await client.Page.captureScreenshot({ format: "png" })).data, "base64"));
  await click(client, "theme-trigger");
  return checks;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const project = path.resolve(process.env.ME_GAME_DIR || path.join(root, "../project-rts"));
  const artifacts = path.join(root, ".smoke-artifacts"); fs.mkdirSync(artifacts, { recursive: true });
  const fixture = createWorkspaceFixture({ parent: path.join(os.tmpdir(), "theme-smoke"), project });
  const editor = await launchEditor({
    executable: path.join(root, "node_modules/electron/dist/electron.exe"),
    args: [root, `--user-data-dir=${path.join(fixture.root, "profile")}`, "--force-device-scale-factor=1", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
    cwd: root, port: 9237,
    env: { ME_MAP_PROJECT: fixture.project, ME_GODOT_PROJECT: project, ME_DATA_DIR: path.join(fixture.project, "data") },
  });
  const exceptions = []; editor.client.Runtime.exceptionThrown(event => exceptions.push(event.exceptionDetails));
  try {
    await waitFor(editor.client, "!!window.meApi", "API");
    if (process.argv.includes("--manual")) {
      await evaluate(editor.client, "document.title='Map Editor Theme Native Smoke'");
      const control = { fixture, done: path.join(fixture.root, "done") };
      fs.writeFileSync(path.join(artifacts, "theme-native-session.json"), JSON.stringify(control, null, 2));
      console.log(`THEME_NATIVE_READY ${JSON.stringify(control)}`);
      while (!fs.existsSync(control.done)) await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      const startChecks = await runThemeSmoke({ client: editor.client, artifacts });
      const opened = await apiCall(editor.client, "openWorkspace", { path: fixture.maps, projectRoot: fixture.project });
      assert(opened.ok, opened.error); await reload(editor.client);
      const workspaceChecks = [];
      for (const section of ["maps", "units", "buildings", "rules"]) {
        await click(editor.client, `tab-${section}`);
        workspaceChecks.push(...await runThemeSmoke({ client: editor.client }));
      }
      assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
      fs.writeFileSync(path.join(artifacts, "theme-report.json"), JSON.stringify({ startChecks, workspaceChecks, exceptions }, null, 2));
      console.log(`THEME_OK checks=${startChecks.length + workspaceChecks.length}`);
    }
  } finally { await editor.close(); }
}
