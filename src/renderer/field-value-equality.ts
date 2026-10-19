import type { JsonValue } from "./types";

// Documents are immutable. Cache object pairs so changing one field does not
// serialize or traverse every unchanged array/object again. Weak keys release
// old undo states when their document references are no longer retained.
const comparisons = new WeakMap<object, WeakMap<object, boolean>>();

/** JSON value equality: object key order is immaterial, array order is not. */
export function equalFieldValue(value: JsonValue | undefined, original: JsonValue | undefined): boolean {
  if (value === original) return true;
  if (value === null || original === null || typeof value !== "object" || typeof original !== "object") return false;
  if (Array.isArray(value) !== Array.isArray(original)) return false;
  const previous = comparisons.get(value)?.get(original);
  if (previous !== undefined) return previous;

  let equal: boolean;
  if (Array.isArray(value) && Array.isArray(original)) {
    equal = value.length === original.length && value.every((child, index) => equalFieldValue(child, original[index]));
  } else {
    const keys = Object.keys(value);
    const other = original as Record<string, JsonValue>;
    equal = keys.length === Object.keys(original).length
      && keys.every((key) => Object.hasOwn(other, key) && equalFieldValue((value as Record<string, JsonValue>)[key], other[key]));
  }
  let originals = comparisons.get(value);
  if (!originals) {
    originals = new WeakMap();
    comparisons.set(value, originals);
  }
  originals.set(original, equal);
  return equal;
}
