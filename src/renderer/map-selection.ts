import type { ConfigFile, Entity, JsonValue } from "./types";

export interface MapSelection {
  kind: "building" | "spawn";
  index: number;
}

function isRow(value: JsonValue | undefined): value is Entity {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Follow immutable placement rows across JSON array deletion/reordering.
 * A replaced row in an otherwise same-length array is a normal field edit,
 * unless its old slot now holds another surviving row from the old array.
 * Without persistent placement ids, cloned-and-reordered arrays cannot be
 * distinguished from edits; their same-length fallback keeps the old index.
 */
export function remapMapSelections(
  beforeDoc: ConfigFile,
  afterDoc: ConfigFile,
  selections: readonly MapSelection[],
): MapSelection[] {
  const maps = new Map<MapSelection["kind"], Map<number, number>>();
  const mappingFor = (kind: MapSelection["kind"]): Map<number, number> => {
    const cached = maps.get(kind);
    if (cached) return cached;
    const result = new Map<number, number>();
    maps.set(kind, result);
    const key = kind === "building" ? "buildings" : "spawns";
    const before = beforeDoc[key];
    const after = afterDoc[key];
    if (!Array.isArray(before) || !Array.isArray(after)) return result;
    if (before === after) {
      for (const selected of selections) {
        if (selected.kind === kind && isRow(before[selected.index])) result.set(selected.index, selected.index);
      }
      return result;
    }

    const afterIndexes = new Map<Entity, number[]>();
    after.forEach((row, index) => {
      if (!isRow(row)) return;
      const indexes = afterIndexes.get(row) ?? [];
      indexes.push(index);
      afterIndexes.set(row, indexes);
    });
    const oldRows = new Set(before.filter(isRow));
    const occurrences = new Map<Entity, number>();
    before.forEach((row, index) => {
      if (!isRow(row)) return;
      // Repeated references are unusual in JSON documents but can occur in
      // programmatic edits. Match each occurrence once, rather than mapping
      // several old slots to the same surviving placement.
      const occurrence = occurrences.get(row) ?? 0;
      occurrences.set(row, occurrence + 1);
      const nextIndex = afterIndexes.get(row)?.[occurrence];
      if (nextIndex !== undefined) {
        result.set(index, nextIndex);
      } else if (before.length === after.length && isRow(after[index]) && !oldRows.has(after[index])) {
        result.set(index, index);
      }
    });
    return result;
  };

  const result: MapSelection[] = [];
  for (const selected of selections) {
    if (!Number.isInteger(selected.index) || selected.index < 0) continue;
    const index = mappingFor(selected.kind).get(selected.index);
    if (index !== undefined) result.push(index === selected.index ? selected : { ...selected, index });
  }
  return result;
}
