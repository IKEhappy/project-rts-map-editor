import type { Entity } from "./types";

/** Session-only display controls. They never change map data or object indices. */
export interface MapVisibility {
  teams: { own: boolean; enemy: boolean; neutral: boolean };
  kinds: { buildings: boolean; turrets: boolean; units: boolean };
  hideBackground: boolean;
  hideRender: boolean;
  hideObjects: boolean;
  hideGrid: boolean;
  hideBoxes: boolean;
}

export const DEFAULT_MAP_VISIBILITY: MapVisibility = {
  teams: { own: true, enemy: true, neutral: true },
  kinds: { buildings: true, turrets: true, units: true },
  hideBackground: false,
  hideRender: false,
  hideObjects: false,
  hideGrid: false,
  hideBoxes: false,
};

/** Use the same predicate for drawing, pointer hits and selection. */
export function mapObjectVisible(
  value: MapVisibility,
  kind: "building" | "spawn",
  entity: Entity,
): boolean {
  if (value.hideObjects) return false;
  const kindVisible = kind === "spawn"
    ? value.kinds.units
    : typeof entity.key === "string" && entity.key.startsWith("turret_")
      ? value.kinds.turrets
      : value.kinds.buildings;
  if (!kindVisible) return false;

  // These defaults match map building loading and both spawn entry points.
  const team = entity.team === undefined ? (kind === "building" ? 0 : 1) : entity.team;
  if (typeof team === "number" && Number.isInteger(team) && team >= 0) {
    if (team === 0) return value.teams.neutral;
    return team === 1 ? value.teams.own : value.teams.enemy;
  }

  // Keep malformed data visible in the unfiltered view, without assigning it
  // to a valid team category when a developer applies a team filter.
  return value.teams.own && value.teams.enemy && value.teams.neutral;
}
