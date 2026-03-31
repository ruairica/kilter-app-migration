import { apiGet } from "./api.js";
import type { GradeEntry } from "./types.js";

export async function buildGradeMap(
	token: string,
): Promise<Map<string, number>> {
	const grades = (await apiGet(token, "/grades")) as GradeEntry[];
	const map = new Map<string, number>();
	for (const g of grades) {
		map.set(g.fontScale.toLowerCase(), g.difficultyGradeId);
	}
	return map;
}
