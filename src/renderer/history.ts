// 文档撤销/重做历史（T-164 R9，2026-09-17）：按文档键（kind 名或 map:<文件名>）维护
// 双栈。commit 携带"变更前快照 + 标签"：同标签在合并窗口内（默认 600ms）连续提交只保留
// 最早一份快照——字段树的逐键输入合并为一次撤销步，画布操作标签互异天然离散。
// 纯类非 hook：App（三表）与 MapsPanel（多地图）各持一个实例，键盘路由见 App。

export interface HistorySnapshot<T> {
  doc: T;
}

interface LastCommit {
  tag: string;
  time: number;
}

export class DocHistory<T> {
  private undo = new Map<string, HistorySnapshot<T>[]>();
  private redo = new Map<string, HistorySnapshot<T>[]>();
  private last = new Map<string, LastCommit>();
  private limit = 200;

  /** 变更前调用：提交变更前快照。同标签合并窗口内不重复入栈（保留突发起点）。 */
  commit(key: string, prev: T, tag: string, coalesceMs = 600): void {
    const now = Date.now();
    const lastCommit = this.last.get(key);
    if (lastCommit && lastCommit.tag === tag && now - lastCommit.time <= coalesceMs) {
      this.last.set(key, { tag, time: now });
      this.redo.set(key, []); // 新编辑分叉清空重做栈
      return;
    }
    this.last.set(key, { tag, time: now });
    const stack = this.undo.get(key) ?? [];
    stack.push({ doc: prev });
    while (stack.length > this.limit) stack.shift();
    this.undo.set(key, stack);
    this.redo.set(key, []);
  }

  /** 撤销：返回上一份快照；current 入重做栈；无步返回 null。 */
  undoFor(key: string, current: T): T | null {
    const stack = this.undo.get(key);
    if (!stack || stack.length === 0) return null;
    const redoStack = this.redo.get(key) ?? [];
    redoStack.push({ doc: current });
    this.redo.set(key, redoStack);
    this.last.delete(key); // 撤销后下一次编辑不与撤销前标签合并
    const popped = stack.pop()!;
    return popped.doc;
  }

  /** 重做：返回下一份快照；current 入撤销栈；无步返回 null。 */
  redoFor(key: string, current: T): T | null {
    const redoStack = this.redo.get(key);
    if (!redoStack || redoStack.length === 0) return null;
    const stack = this.undo.get(key) ?? [];
    stack.push({ doc: current });
    this.undo.set(key, stack);
    this.last.delete(key);
    const popped = redoStack.pop()!;
    return popped.doc;
  }

  canUndo(key: string): boolean {
    return (this.undo.get(key)?.length ?? 0) > 0;
  }

  canRedo(key: string): boolean {
    return (this.redo.get(key)?.length ?? 0) > 0;
  }

  /** 文档重载/切换目录/保存后按需清键（保存不清——保存不是撤销边界，用户仍可撤回改动再改）。 */
  clear(key?: string): void {
    if (key === undefined) {
      this.undo.clear();
      this.redo.clear();
      this.last.clear();
      return;
    }
    this.undo.delete(key);
    this.redo.delete(key);
    this.last.delete(key);
  }
}
