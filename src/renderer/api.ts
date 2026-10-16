import type { LabelsReadResult } from "./labels";
import type {
  ConfigFile,
  ConfigSavePayload,
  Kind,
  MapReadResult,
  MapSaveResult,
  MapsListResult,
  MetaResult,
  ReadResult,
  SaveResult,
  WorkspaceResult,
  CompareResult,
  BackgroundInfo,
} from "./types";

declare global {
  interface Window {
    meApi: {
      openWorkspace(payload?: { path?: string; projectRoot?: string }): Promise<WorkspaceResult>;
      getWorkspace(): Promise<WorkspaceResult>;
      closeWorkspace(): Promise<{ ok: boolean; error?: string }>;
      compareWorkspace(): Promise<CompareResult>;
      diffFile(relative: string): Promise<{ ok: boolean; before?: string; after?: string; error?: string }>;
      restoreWorkspace(): Promise<WorkspaceResult>;
      readWorkspaceConfig(kind: Kind): Promise<ReadResult>;
      backgroundInfo(doc: ConfigFile): Promise<BackgroundInfo>;
      importImage(payload: { mapId: string; view: "tilt" | "topdown" | "image"; sourcePath?: string }): Promise<{ ok: boolean; path?: string; width?: number; height?: number; error?: string }>;
      importMap(payload?: { sourcePath?: string }): Promise<{ ok: boolean; name?: string; errors?: string[] }>;
      meta(): Promise<MetaResult>;
      labels(): Promise<LabelsReadResult>;
      editorTemplates?(): Promise<{ ok: boolean; data?: ConfigFile; error?: string }>;
      read(kind: Kind): Promise<ReadResult>;
      save(payload: ConfigSavePayload): Promise<SaveResult>;
      listMaps(): Promise<MapsListResult>;
      readMap(name: string): Promise<MapReadResult>;
      saveMap(payload: {
        name: string;
        data: ConfigFile;
        baseHash: string;
        expectCreate?: boolean;
      }): Promise<MapSaveResult>;
      renameMap(payload: { from: string; to: string; baseHash?: string }): Promise<MapSaveResult>;
      openMapFile(name: string): Promise<{ ok: boolean; error?: string }>;
      openMapFolder(name: string): Promise<{ ok: boolean; error?: string }>;
      readIcon(name: string): Promise<{ ok: boolean; text?: string; error?: string }>;
      pickFolder(): Promise<{ ok: boolean; path?: string }>;
      windowCtl(action: "minimize" | "maximize" | "close" | "close-now"): Promise<{ ok: boolean }>;
      onWindowState(callback: (maximized: boolean) => void): () => void;
      onCloseRequest(callback: () => void): () => void;
    };
  }
}

export const api = window.meApi;

/** 与主进程 store.cjs serialize() 保持同一格式（2 空格缩进 + 尾部换行） */
export function serializeText(data: ConfigFile): string {
  return JSON.stringify(data, null, 2) + "\n";
}
