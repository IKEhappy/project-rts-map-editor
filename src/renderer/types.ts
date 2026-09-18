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
