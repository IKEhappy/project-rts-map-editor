import type { JsonValue } from "./types";

/**
 * Defaults offered by FieldTree's "+ 新增字段" control.
 * Keep this as data, rather than embedding the values in the component, so
 * templates and configuration edits can share one auditable contract.
 */
export const FIELD_CREATABLE: Readonly<Record<string, JsonValue>> = {
  lines: [],
  unlocked_lines: 1,
  income: 1,
  research: 1,
  speed_up: 1,
  level: 1,
  hp: 500,
  team: 1,
  count: 1,
};

