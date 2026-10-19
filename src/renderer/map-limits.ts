// UX mirror of project-rts SimCore.MAX_BUILDINGS. The Godot save gate reads
// the runtime constant directly, so game validation remains authoritative.
export const MAX_MAP_BUILDINGS = 1024;

/** Turrets share the buildings array/capacity; unit spawns do not consume it. */
export function buildingCapacityError(count: number): string | null {
  return count > MAX_MAP_BUILDINGS
    ? `建筑/炮台总数 ${count} 超出上限 ${MAX_MAP_BUILDINGS}，请删除多余对象后保存（单位出生点不计入）`
    : null;
}
