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

export interface MetaResult {
  dataDir: string;
  godotExe: string;
  godotProject: string;
  gateScript: string;
  files: Record<string, string>;
}
