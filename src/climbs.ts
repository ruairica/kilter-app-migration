import type { V2Climb, Wall } from "./types.js";
import { apiGet } from "./api.js";

export function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u2013\u2014]/g, "-");
}

function addClimbs(byName: Map<string, V2Climb>, climbs: V2Climb[]) {
  for (const c of climbs) {
    if (!byName.has(c.name)) byName.set(c.name, c);
    const normalized = normalizeQuotes(c.name);
    if (normalized !== c.name && !byName.has(normalized)) {
      byName.set(normalized, c);
    }
  }
}

export async function buildClimbLookup(
  token: string,
  primaryLayoutId: string,
  allWalls: Wall[],
  neededNames: Set<string>,
): Promise<Map<string, V2Climb>> {
  const byName = new Map<string, V2Climb>();

  const climbs = (await apiGet(token, `/climbs/all/${primaryLayoutId}`)) as V2Climb[];
  addClimbs(byName, climbs);

  const unresolvedNames = new Set<string>();
  for (const name of neededNames) {
    if (!lookupClimb(byName, name)) unresolvedNames.add(name);
  }

  if (unresolvedNames.size > 0) {
    const layoutCounts = new Map<string, number>();
    for (const w of allWalls) {
      const l = String(w.product_layout_uuid);
      layoutCounts.set(l, (layoutCounts.get(l) ?? 0) + 1);
    }

    const otherLayouts = [...layoutCounts.keys()]
      .filter(l => l !== primaryLayoutId)
      .sort((a, b) => layoutCounts.get(b)! - layoutCounts.get(a)!);

    for (const layoutId of otherLayouts) {
      const more = (await apiGet(token, `/climbs/all/${layoutId}`)) as V2Climb[];
      addClimbs(byName, more);

      for (const name of unresolvedNames) {
        if (lookupClimb(byName, name)) unresolvedNames.delete(name);
      }
      if (unresolvedNames.size === 0) break;
    }
  }

  return byName;
}

export function lookupClimb(climbLookup: Map<string, V2Climb>, name: string): V2Climb | undefined {
  return climbLookup.get(name) ?? climbLookup.get(normalizeQuotes(name));
}
