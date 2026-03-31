import { apiPost, toISODate } from "./api.js";
import { lookupClimb } from "./climbs.js";
import type { ExportData, ImportResult, SkipDetail, V2Climb } from "./types.js";

const SYNC = "https://sync1.kiltergrips.com";

async function fetchExistingCircuitNames(
	token: string,
	userUuid: string,
): Promise<Set<string>> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30000);

	const res = await fetch(`${SYNC}/sync/stream`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			buckets: [{ name: `user_buckets["${userUuid}"]`, after: "0" }],
		}),
		signal: controller.signal,
	});

	const reader = res.body?.getReader();
	const names = new Set<string>();
	if (!reader) return names;

	let fullText = "";
	const decoder = new TextDecoder();
	while (fullText.length < 500000) {
		const { done, value } = await reader
			.read()
			.catch(() => ({ done: true as const, value: undefined }));
		if (done || !value) break;
		fullText += decoder.decode(value, { stream: true });
	}
	reader.cancel().catch(() => {});
	clearTimeout(timeout);

	for (const line of fullText.split("\n").filter(Boolean)) {
		try {
			const obj = JSON.parse(line);
			if (obj.data?.data && Array.isArray(obj.data.data)) {
				for (const item of obj.data.data) {
					if (item.object_type === "circuits") {
						const d =
							typeof item.data === "string" ? JSON.parse(item.data) : item.data;
						if (d?.name) names.add(d.name);
					}
				}
			}
		} catch {}
	}

	return names;
}

export async function importCircuits(
	token: string,
	userUuid: string,
	creatorName: string,
	layoutId: string,
	circuits: ExportData["circuits"],
	climbLookup: Map<string, V2Climb>,
	onProgress?: (imported: number, total: number) => void,
): Promise<ImportResult> {
	const existingNames = await fetchExistingCircuitNames(token, userUuid);

	let imported = 0;
	let skipped = 0;
	let failed = 0;
	const skipDetails: SkipDetail[] = [];

	for (const circuit of circuits) {
		if (circuit.climbs.length === 0) {
			skipped++;
			skipDetails.push({ name: circuit.name, reason: "No climbs" });
			continue;
		}

		if (existingNames.has(circuit.name)) {
			skipped++;
			skipDetails.push({ name: circuit.name, reason: "Already exists" });
			continue;
		}

		const circuitUuid = crypto.randomUUID();
		const createdAt = toISODate(circuit.created_at);

		const r = await apiPost(token, "/circuits", {
			circuitUuid,
			name: circuit.name,
			description: "",
			color: circuit.color,
			isPrivate: circuit.is_private ?? false,
			userUuid,
			creatorName,
			productLayoutUuid: layoutId,
			createdAt,
			updatedAt: createdAt,
		});

		if (r.status !== 200) {
			failed++;
			continue;
		}

		let _addedClimbs = 0;
		for (let i = 0; i < circuit.climbs.length; i++) {
			const climbName = circuit.climbs[i];
			const climb = lookupClimb(climbLookup, climbName);
			if (!climb) continue;

			const ccR = await apiPost(token, "/circuit-climbs", {
				circuitUuid,
				climbUuid: climb.climbUuid,
				sortOrder: i,
			});
			if (ccR.status === 200) _addedClimbs++;

			await Bun.sleep(50);
		}

		imported++;
		onProgress?.(imported, circuits.length);
	}

	return { imported, skipped, failed, skipDetails };
}
