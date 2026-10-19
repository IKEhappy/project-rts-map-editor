'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createBoundWorkspace } = require('./workspace.cjs');
const store = require('./store.cjs');
const assets = require('./assets.cjs');
const decoder = require('./image-decoder.cjs');
const { importMap } = require('./map-import.cjs');

try {
  const { session, operation, payload } = workerData;
  const workspaces = createBoundWorkspace(session);
  store.configureWorkspace(workspaces, decoder);
  let result;
  switch (operation) {
    case 'saveMap': result = store.saveMap(payload); break;
    case 'saveKind': result = store.saveKind(payload); break;
    case 'renameMap': result = store.renameMap(payload); break;
    case 'importImage': result = assets.importImage(workspaces, session.id, payload, decoder); break;
    // importMap keeps its synchronous save callback and rollback transaction.
    case 'importMap': result = importMap({ workspaces, id: session.id, sourcePath: payload.sourcePath, nativeImage: decoder, saveMap: store.saveMap }); break;
    default: throw new Error('Unknown workspace write operation');
  }
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
} finally {
  parentPort.close();
}
