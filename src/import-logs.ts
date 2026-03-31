import { apiGet, apiPost, toISODate } from "./api.js";
import { lookupClimb } from "./climbs.js";
import type { ExportData, ImportResult, V2Climb } from "./types.js";

const RATE_LIMIT_MS = 100;

async function fetchExistingLogKeys(token: string): Promise<Set<string>> {
	const logs = (await apiGet(token, "/logs")) as Array<{
		climbUuid: string;
		angle: number;
		createdAt: string;
	}>;
	return new Set(logs.map((l) => `${l.climbUuid}:${l.angle}:${l.createdAt}`));
}

export async function importAscents(
	token: string,
	userUuid: string,
	gymUuid: string,
	wallUuid: string,
	layoutId: string,
	ascents: ExportData["ascents"],
	climbLookup: Map<string, V2Climb>,
	gradeMap: Map<string, number>,
	onProgress?: (imported: number, total: number) => void,
): Promise<ImportResult> {
	const existingKeys = await fetchExistingLogKeys(token);

	let imported = 0;
	let skipped = 0;
	let failed = 0;

	for (const ascent of ascents) {
		const climb = lookupClimb(climbLookup, ascent.climb);
		if (!climb) {
			skipped++;
			continue;
		}

		const createdAt = toISODate(ascent.created_at);
		const dedupKey = `${climb.climbUuid}:${ascent.angle}:${createdAt}`;
		if (existingKeys.has(dedupKey)) {
			skipped++;
			continue;
		}

		const r = await apiPost(token, "/logs", {
			logUuid: crypto.randomUUID(),
			climbUuid: climb.climbUuid,
			userUuid,
			gymUuid,
			wallUuid,
			productLayoutUuid: layoutId,
			angle: ascent.angle,
			isMirror: false,
			topped: true,
			flashed: false,
			attempts: ascent.count,
			bidCount: 0,
			createdAt,
		});

		if (r.status === 200) {
			const difficultyId = gradeMap.get(ascent.grade.toLowerCase());
			if (difficultyId) {
				await apiPost(token, "/climb-rating", {
					climbUuid: climb.climbUuid,
					difficulty: difficultyId,
					quality: ascent.stars,
					angle: ascent.angle,
				});
			}
			imported++;
			onProgress?.(imported, ascents.length);
		} else {
			failed++;
		}

		await Bun.sleep(RATE_LIMIT_MS);
	}

	return { imported, skipped, failed };
}

export async function importAttempts(
	token: string,
	userUuid: string,
	gymUuid: string,
	wallUuid: string,
	layoutId: string,
	attempts: ExportData["attempts"],
	climbLookup: Map<string, V2Climb>,
	onProgress?: (imported: number, total: number) => void,
): Promise<ImportResult> {
	const existingKeys = await fetchExistingLogKeys(token);

	let imported = 0;
	let skipped = 0;
	let failed = 0;

	for (const attempt of attempts) {
		const climb = lookupClimb(climbLookup, attempt.climb);
		if (!climb) {
			skipped++;
			continue;
		}

		const createdAt = toISODate(attempt.created_at);
		const dedupKey = `${climb.climbUuid}:${attempt.angle}:${createdAt}`;
		if (existingKeys.has(dedupKey)) {
			skipped++;
			continue;
		}

		const r = await apiPost(token, "/logs", {
			logUuid: crypto.randomUUID(),
			climbUuid: climb.climbUuid,
			userUuid,
			gymUuid,
			wallUuid,
			productLayoutUuid: layoutId,
			angle: attempt.angle,
			isMirror: false,
			topped: false,
			flashed: false,
			attempts: attempt.count,
			bidCount: attempt.count,
			createdAt,
		});

		if (r.status === 200) {
			imported++;
			onProgress?.(imported, attempts.length);
		} else {
			failed++;
		}

		await Bun.sleep(RATE_LIMIT_MS);
	}

	return { imported, skipped, failed };
}
