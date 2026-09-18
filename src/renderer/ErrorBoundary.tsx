import { Component, type ErrorInfo, type ReactNode } from "react";

// 渲染层错误边界（R10）：React 树内未捕获异常会把根卸载成白/黑屏——边界把它变成
// 可见错误 + 「重载」按钮（重载丢未保存编辑，仅作逃生口；崩溃原因同时 console.error）。
// 错误边界只能捕渲染期异常；渲染进程整体崩溃（GPU/OOM）由主进程 render-process-gone 自愈。

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[map-editor] 渲染层异常：", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-screen" data-testid="error-boundary">
          <div className="modal-title">界面渲染出错（未保存的修改仍在内存中将随重载丢失）</div>
          <pre className="crash-detail">{String(this.state.error?.stack ?? this.state.error)}</pre>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => window.location.reload()}>
              重载界面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
