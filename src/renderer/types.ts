export type Kind = "units" | "buildings" | "rules";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Entity = { [key: string]: JsonValue };
/** 配置文件整体（units/buildings 含 version/_note 包裹键；rules 为扁平键值表） */
export type ConfigFile = { [key: string]: JsonValue };

export interface ReadResult {
  ok: boolean;
  kind?: Kind;
  data?: ConfigFile;
  text?: string;
  hash?: string;
  path?: string;
  mtimeMs?: number;
  error?: string;
}

export interface SaveResult {
  ok: boolean;
  written?: boolean;
  reason?: string;
  hash?: string;
  errors?: string[];
  code?: string;
}

export interface ConfigSavePayload {
  kind: Kind;
  data: ConfigFile;
  baseHash: string;
  workspaceId?: string;
}

// —— 地图编辑（T-164 R7）：dev-2d data/maps/*.json 多文件 ——

export interface MapFileMeta {
  name: string;
  path: string;
  mtimeMs: number;
}

export interface MapsListResult {
  ok: boolean;
  maps?: MapFileMeta[];
  mapsDir?: string;
  error?: string;
}

export interface MapReadResult {
  ok: boolean;
  kind?: "maps";
  name?: string;
  data?: ConfigFile;
  text?: string;
  hash?: string;
  path?: string;
  mtimeMs?: number;
  error?: string;
}

export interface MapSaveResult extends SaveResult {
  name?: string;
  path?: string;
}

export interface MetaResult {
  dataDir: string;
  godotExe: string;
  godotProject: string;
  gateScript: string;
  files: Record<string, string>;
  mapsDir: string;
  mapProject: string;
  mapGateScript: string;
}

export interface WorkspaceSession {
  id: string;
  generation: number;
  root: string;
  projectRoot: string;
  dataDir: string;
  resPrefix: string;
  offline: boolean;
  baseline: { id: string; createdAt: string; zipPath: string; fileCount: number; totalBytes: number };
}

export interface WorkspaceResult { ok: boolean; workspace?: WorkspaceSession; error?: string }
export interface CompareEntry { path: string; status: "added" | "removed" | "changed" | "unchanged"; kind: string }
export interface CompareResult { ok: boolean; entries?: CompareEntry[]; counts?: Record<string, number>; error?: string }
export interface BackgroundImageInfo { path: string; width?: number; height?: number; dataUrl?: string; error?: string }
/** Safe schema fields used to describe the map cell under the pointer. */
export interface RenderConfigSummary {
  weather?: string[];
  materials?: Record<string, {
    textures?: string[];
    cliff?: string;
    water?: string;
    transition?: Record<string, string>;
  }>;
  scatter?: Record<string, {
    kind?: string;
    density?: number;
    materials_on?: string[];
    hash_salt?: number;
    variants?: number;
    hide_when_snow?: boolean;
  }>;
}
export interface BackgroundInfo {
  ok: boolean;
  source: "map" | "renderer" | "none";
  background: Partial<Record<"tilt" | "topdown" | "image", string>>;
  images: Partial<Record<"tilt" | "topdown" | "image", BackgroundImageInfo>>;
  renderConfig?: RenderConfigSummary;
  errors: string[];
}
