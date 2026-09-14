import type { LabelsReadResult } from "./labels";
import type { ConfigFile, Kind, MetaResult, ReadResult, SaveResult } from "./types";

declare global {
  interface Window {
    meApi: {
      meta(): Promise<MetaResult>;
      labels(): Promise<LabelsReadResult>;
      read(kind: Kind, dataDir?: string | null): Promise<ReadResult>;
      save(payload: {
        kind: Kind;
        data: ConfigFile;
        baseHash: string;
        dataDir?: string | null;
      }): Promise<SaveResult>;
      pickFolder(): Promise<{ ok: boolean; path?: string }>;
      windowCtl(action: "minimize" | "maximize" | "close" | "close-now"): Promise<{ ok: boolean }>;
      onWindowState(callback: (maximized: boolean) => void): void;
      onCloseRequest(callback: () => void): void;
    };
  }
}

export const api = window.meApi;

/** 与主进程 store.cjs serialize() 保持同一格式（2 空格缩进 + 尾部换行） */
export function serializeText(data: ConfigFile): string {
  return JSON.stringify(data, null, 2) + "\n";
}
