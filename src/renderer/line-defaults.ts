import type { Entity, JsonValue } from "./types";
import type { UnitSuggestion } from "./suggest";

/**
 * A map/building production line is accepted by SimCore when it names a unit
 * or carries at least one functional effect.  Keep this tiny predicate in the
 * editor so the "+ add line" path never manufactures the empty `unit: ""`
 * rows that the Godot gate must reject.
 */
export function isUsableProductionLine(value: unknown): value is Entity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.unit === "string" && row.unit.trim().length > 0) return true;
  return ["income", "research", "speed_up"].some((field) => {
    const effect = row[field];
    return typeof effect === "number" && Number.isFinite(effect) && effect >= 1;
  });
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Pick the line to copy when appending to a lines array.  Prefer an existing
 * valid row (last row first), then the selected building's definition/schema
 * defaults.  Invalid rows are deliberately skipped only for the new row;
 * existing user data remains untouched and is still shown for correction.
 */
export function productionLineForAppend(
  existing: JsonValue[],
  defaults: unknown,
  unitSuggestions: UnitSuggestion[] = [],
): Entity {
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const row = existing[index];
    if (isUsableProductionLine(row)) return clone(row);
  }
  if (Array.isArray(defaults)) {
    for (const row of defaults) {
      if (isUsableProductionLine(row)) return clone(row as Entity);
    }
  }
  const key = unitSuggestions.find((entry) => entry.key.trim().length > 0)?.key || "cougar";
  return { unit: key, tier: 1, ticks: 60 };
}
