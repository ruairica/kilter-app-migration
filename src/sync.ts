import gymData from "./gym-data.json";
import type { Gym, Wall } from "./types.js";

export function getGymsAndWalls(): { gyms: Gym[]; walls: Wall[] } {
	return { gyms: gymData.gyms as Gym[], walls: gymData.walls as Wall[] };
}

export function searchGyms(gyms: Gym[], query: string): Gym[] {
	const q = query.toLowerCase();
	return gyms.filter(
		(g) =>
			String(g.name ?? "")
				.toLowerCase()
				.includes(q) ||
			String(g.city ?? "")
				.toLowerCase()
				.includes(q) ||
			String(g.country ?? "")
				.toLowerCase()
				.includes(q),
	);
}

export function findWallsForGym(walls: Wall[], gymUuid: string): Wall[] {
	return walls.filter((w) => String(w.gym_uuid) === gymUuid);
}
