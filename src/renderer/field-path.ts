import type { JsonValue } from "./types";

export type FieldPath = ReadonlyArray<string | number>;

/** Replace one leaf while retaining every untouched branch by reference. */
export function setAtPath(root: Record<string, JsonValue>, path: FieldPath, value: JsonValue): Record<string, JsonValue> {
  if (path.length === 0) throw new Error("A field path must contain at least one segment");

  const replace = (node: JsonValue | undefined, depth: number): JsonValue => {
    const segment = path[depth];
    const container = node !== null && typeof node === "object" ? node : undefined;
    const previous = Array.isArray(container)
      ? container[segment as number]
      : container?.[segment as string];
    // Stop at the leaf before looking inside its value. In particular a
    // top-level scalar array is [field, index], with no object below index.
    const next = depth === path.length - 1 ? value : replace(previous, depth + 1);
    if (Array.isArray(container) || (!container && typeof segment === "number")) {
      const result = Array.isArray(container) ? container.slice() : [];
      result[segment as number] = next;
      return result;
    }
    return { ...container, [segment]: next };
  };

  return replace(root, 0) as Record<string, JsonValue>;
}

/** Remove a property rather than writing null/undefined. Array entries are
 * compacted; untouched branches and missing paths retain their references. */
export function removeAtPath(root: Record<string, JsonValue>, path: FieldPath): Record<string, JsonValue> {
  if (path.length === 0) throw new Error("A field path must contain at least one segment");

  const remove = (node: JsonValue, depth: number): JsonValue => {
    if (node === null || typeof node !== "object") return node;
    const segment = path[depth];
    if (Array.isArray(node)) {
      if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0 || segment >= node.length) return node;
      if (depth === path.length - 1) return node.filter((_, index) => index !== segment);
      const next = remove(node[segment], depth + 1);
      if (next === node[segment]) return node;
      const result = node.slice();
      result[segment] = next;
      return result;
    }
    if (typeof segment !== "string" || !Object.hasOwn(node, segment)) return node;
    if (depth === path.length - 1) {
      const result = { ...node };
      delete result[segment];
      return result;
    }
    const next = remove(node[segment], depth + 1);
    return next === node[segment] ? node : { ...node, [segment]: next };
  };

  return remove(root, 0) as Record<string, JsonValue>;
}
