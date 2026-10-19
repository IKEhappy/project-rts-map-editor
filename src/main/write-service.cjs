'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const OPERATIONS = new Set(['saveMap', 'saveKind', 'renameMap', 'importImage', 'importMap']);
const SESSION_FIELDS = ['id', 'generation', 'root', 'projectRoot', 'dataDir', 'resPrefix'];

function runWriteWorker(request) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'write-worker.cjs'), { workerData: request });
    let reply;
    let workerError;
    worker.once('message', (message) => { reply = message; });
    worker.once('error', (error) => { workerError = error; });
    // Wait for cleanup and worker exit before releasing the write queue/lock.
    worker.once('exit', (code) => {
      if (workerError) reject(workerError);
      else if (code !== 0) reject(new Error(`后台保存进程异常退出（${code}）`));
      else if (!reply) reject(new Error('后台保存没有返回结果'));
      else if (reply.error) reject(new Error(reply.error));
      else resolve(reply.result);
    });
  });
}

class WriteService {
  constructor(workspaces, runWorker = runWriteWorker) {
    this.workspaces = workspaces;
    this.runWorker = runWorker;
    this.tail = Promise.resolve();
    this.closing = false;
  }

  _enqueue(task) {
    if (this.closing) return Promise.reject(new Error('工具正在关闭，请等待后台保存完成'));
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }

  run(operation, payload) {
    try {
      if (!OPERATIONS.has(operation)) throw new Error('Unknown workspace write operation');
      if (!payload?.workspaceId) throw new Error('请先选择地图文件夹');
      // The renderer can only select an existing session id, never its paths.
      const session = this.workspaces.current(payload.workspaceId);
      const copy = structuredClone(payload);
      return this._enqueue(() => {
        const current = this.workspaces.current(session.id);
        if (SESSION_FIELDS.some((key) => current[key] !== session[key])) throw new Error('地图工作区已切换或恢复，请重新加载后再保存');
        return this.runWorker({ operation, payload: copy, session });
      });
    } catch (error) { return Promise.reject(error); }
  }

  // Folder switches, restore and lock release cannot overlap any write worker.
  exclusive(task) { return this._enqueue(task); }

  close() {
    this.closing = true;
    return this.tail;
  }
}

module.exports = { WriteService, runWriteWorker };
