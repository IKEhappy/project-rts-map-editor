import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../../src/main/store.cjs');
const toolRoot = path.resolve(import.meta.dirname, '../..');
const configured = store.env();
const available = fs.existsSync(configured.godotExe) && fs.existsSync(path.join(configured.godotProject, 'src/data/match_config.gd'));

test('real config gate accepts declared existing-entity features without weakening validation', { skip: !available, timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-feature-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(configured.godotProject, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  const baseline = {};
  for (const kind of ['units', 'buildings', 'rules']) {
    const file = path.join(configured.godotProject, 'data', `${kind}.json`);
    baseline[kind] = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.copyFileSync(file, path.join(root, 'data', `${kind}.json`));
  }
  fs.writeFileSync(path.join(root, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Config feature gate test"\n\n[autoload]\nGameSession="*res://.gate_session.gd"\nDebugConsole="*res://.gate_console.gd"\n');
  fs.copyFileSync(path.join(toolRoot, 'gate/session_stub.gd'), path.join(root, '.gate_session.gd'));
  fs.copyFileSync(path.join(toolRoot, 'gate/console_stub.gd'), path.join(root, '.gate_console.gd'));
  const options = { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, APPDATA: path.join(root, 'user-data'), XDG_DATA_HOME: path.join(root, 'user-data') } };
  const imported = spawnSync(configured.godotExe, ['--headless', '--path', root, '--import'], options);
  assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
  assert.doesNotMatch(`${imported.stdout}\n${imported.stderr}`, /SCRIPT ERROR|^ERROR:/m);
  const check = (kind, edit) => {
    const candidate = structuredClone(baseline[kind]);
    edit(candidate);
    const file = path.join(root, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify(candidate));
    const proc = spawnSync(configured.godotExe, ['--headless', '--path', root, '--script', path.join(toolRoot, 'gate/config_gate.gd'), '--', 'check', '--kind', kind, '--candidate', file], options);
    const output = `${proc.stdout}\n${proc.stderr}`;
    assert.doesNotMatch(output, /SCRIPT ERROR|^ERROR:/m, output);
    const line = proc.stdout.split(/\r?\n/).find((entry) => entry.startsWith('GATE_RESULT '));
    assert.ok(line, output);
    const result = JSON.parse(line.slice('GATE_RESULT '.length));
    assert.equal(proc.status, result.ok ? 0 : 2, output);
    return result;
  };
  const rowWithout = (document, kind, field) => {
    const row = document[kind].find((entry) => !Object.hasOwn(entry, field));
    assert.ok(row, `Fixture needs an existing ${kind} entity without ${field}`);
    return row;
  };
  const accepted = (result) => assert.equal(result.ok, true, result.errors.join('\n'));
  const rejected = (result, pattern) => {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), pattern);
  };

  await t.test('entity field union supplies attackable and respawn_seconds models', () => {
    accepted(check('units', (document) => {
      rowWithout(document, 'units', 'attackable').attackable = true;
      rowWithout(document, 'units', 'respawn_seconds').respawn_seconds = 12;
      document.templates = [];
    }));
  });
  await t.test('source template entity and fields declare features absent from current entities', () => {
    const source = structuredClone(baseline.units);
    const field = 'source_template_feature';
    source.templates = [{ key: 'schema', entity: { source_template_count: 1 }, fields: { [field]: false } }];
    fs.writeFileSync(path.join(root, 'data/units.json'), JSON.stringify(source));
    try {
      accepted(check('units', (document) => {
        document.templates = [];
        document.units[0][field] = true;
        document.units[0].source_template_count = 2;
      }));
    } finally { fs.writeFileSync(path.join(root, 'data/units.json'), JSON.stringify(baseline.units)); }
  });
  await t.test('candidate template entity and fields declare unused features', () => {
    accepted(check('units', (document) => {
      document.templates = [{ key: 'schema', entity: { candidate_feature_count: 1 }, fields: { candidate_feature_toggle: false } }];
      document.units[0].candidate_feature_count = 2;
      document.units[0].candidate_feature_toggle = true;
    }));
  });
  await t.test('undeclared features and declared features with wrong types are rejected', () => {
    rejected(check('units', (document) => { document.units[0].undeclared_feature = true; }), /unknown key.*undeclared_feature/);
    rejected(check('units', (document) => { rowWithout(document, 'units', 'attackable').attackable = 'false'; }), /expected boolean/);
    rejected(check('units', (document) => { rowWithout(document, 'units', 'respawn_seconds').respawn_seconds = '12'; }), /expected nonnegative bounded number/);
    rejected(check('units', (document) => {
      document.templates = [{ key: 'schema', entity: {}, fields: { candidate_feature_toggle: false } }];
      document.units[0].candidate_feature_toggle = 1;
    }), /expected boolean/);
  });
  await t.test('candidate templates cannot change an existing field model type', () => {
    rejected(check('units', (document) => {
      document.templates = [{ key: 'schema', entity: {}, fields: { attackable: 'text' } }];
      rowWithout(document, 'units', 'attackable').attackable = 'text';
    }), /expected boolean/);
  });
  await t.test('identity changes, existing-entity removal and numerical limits remain rejected', () => {
    rejected(check('units', (document) => { document.units[0].id += 1000; }), /identity cannot change/);
    rejected(check('units', (document) => { document.units[0].key = 'changed_identity'; }), /禁止删除实体/);
    rejected(check('units', (document) => { document.units.shift(); }), /禁止删除实体/);
    rejected(check('units', (document) => { document.units[0].hp = 0; }), /invalid unit HP/);
  });
  await t.test('lines and tiers retain MatchConfig semantic validation after feature insertion', () => {
    rejected(check('buildings', (document) => {
      rowWithout(document, 'buildings', 'lines').lines = [{ unit: 'undefined_unit', ticks: 1 }];
    }), /lines unit undefined/);
    rejected(check('units', (document) => {
      rowWithout(document, 'units', 'tiers').tiers = [{ hp: 100 }];
    }), /tiers must be an array of exactly 3 rows/);
  });
  await t.test('template-created new entities retain their existing save path', () => {
    accepted(check('units', (document) => {
      const row = structuredClone(document.units[0]);
      row.key = 'new_gate_unit';
      row.id = Math.max(...document.units.map((entry) => entry.id)) + 1;
      document.units.push(row);
    }));
  });
});
