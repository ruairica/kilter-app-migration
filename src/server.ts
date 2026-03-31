import { getToken, getUserUuid } from "./api.js";
import { buildClimbLookup } from "./climbs.js";
import { buildGradeMap } from "./grades.js";
import { importCircuits } from "./import-circuits.js";
import { importAscents, importAttempts } from "./import-logs.js";
import homepage from "./index.html";
import { findWallsForGym, getGymsAndWalls, searchGyms } from "./sync.js";
import type { ExportData, Gym, ImportResult, Wall } from "./types.js";

// --- session state (single user) ---
let exportData: ExportData | null = null;
let token: string | null = null;
let userUuid: string | null = null;
let gyms: Gym[] = [];
let walls: Wall[] = [];
let importRunning = false;
let sseWaiter: ((msg: unknown) => void) | null = null;
let ssePending: unknown[] = [];

function sendSSE(data: unknown) {
	if (sseWaiter) {
		const resolve = sseWaiter;
		sseWaiter = null;
		resolve(data);
	} else {
		ssePending.push(data);
	}
}

function nextSSE(): Promise<unknown> {
	if (ssePending.length > 0) {
		return Promise.resolve(ssePending.shift());
	}
	return new Promise((resolve) => {
		sseWaiter = resolve;
	});
}

async function runImport(gymUuid: string, wallUuid: string, layoutId: string) {
	importRunning = true;
	try {
		sendSSE({ phase: "loading", message: "Loading climbs and grades..." });

		const neededNames = new Set<string>();
		for (const a of exportData!.ascents) neededNames.add(a.climb);
		for (const a of exportData!.attempts) neededNames.add(a.climb);
		for (const c of exportData!.circuits) {
			for (const name of c.climbs) neededNames.add(name);
		}

		const [climbLookup, gradeMap] = await Promise.all([
			buildClimbLookup(token!, layoutId, walls, neededNames),
			buildGradeMap(token!),
		]);

		sendSSE({ phase: "loading", message: `${climbLookup.size} climbs loaded` });

		const results: Record<string, ImportResult> = {};

		if (exportData!.ascents.length > 0) {
			sendSSE({
				phase: "ascents",
				current: 0,
				total: exportData!.ascents.length,
			});
			results.ascents = await importAscents(
				token!,
				userUuid!,
				gymUuid,
				wallUuid,
				layoutId,
				exportData!.ascents,
				climbLookup,
				gradeMap,
				(n, total) => sendSSE({ phase: "ascents", current: n, total }),
			);
		}

		if (exportData!.attempts.length > 0) {
			sendSSE({
				phase: "attempts",
				current: 0,
				total: exportData!.attempts.length,
			});
			results.attempts = await importAttempts(
				token!,
				userUuid!,
				gymUuid,
				wallUuid,
				layoutId,
				exportData!.attempts,
				climbLookup,
				(n, total) => sendSSE({ phase: "attempts", current: n, total }),
			);
		}

		if (exportData!.circuits.length > 0) {
			sendSSE({
				phase: "circuits",
				current: 0,
				total: exportData!.circuits.length,
			});
			const creatorName = exportData!.user?.username ?? "Unknown";
			results.circuits = await importCircuits(
				token!,
				userUuid!,
				creatorName,
				layoutId,
				exportData!.circuits,
				climbLookup,
				(n, total) => sendSSE({ phase: "circuits", current: n, total }),
			);
		}

		sendSSE({ phase: "done", results });
	} catch (e) {
		sendSSE({
			phase: "error",
			message: e instanceof Error ? e.message : String(e),
		});
	} finally {
		importRunning = false;
	}
}

export function startServer() {
	const port = 9876;
	Bun.serve({
		port,
		routes: {
			"/": homepage,

			"/api/upload": {
				POST: async (req) => {
					try {
						exportData = (await req.json()) as ExportData;
						return Response.json({
							ascents: exportData.ascents?.length ?? 0,
							attempts: exportData.attempts?.length ?? 0,
							circuits: exportData.circuits?.length ?? 0,
							circuitClimbs:
								exportData.circuits?.reduce((s, c) => s + c.climbs.length, 0) ??
								0,
						});
					} catch {
						return Response.json({ error: "Invalid JSON" }, { status: 400 });
					}
				},
			},

			"/api/login": {
				POST: async (req) => {
					try {
						const { username, password } = (await req.json()) as {
							username: string;
							password: string;
						};
						token = await getToken(username, password);
						userUuid = getUserUuid(token);
						const data = getGymsAndWalls();
						gyms = data.gyms;
						walls = data.walls;
						return Response.json({ success: true, gymCount: gyms.length });
					} catch (e) {
						return Response.json(
							{
								error: e instanceof Error ? e.message : "Authentication failed",
							},
							{ status: 401 },
						);
					}
				},
			},

			"/api/gyms": {
				GET: (req) => {
					const q = new URL(req.url).searchParams.get("q") ?? "";
					const results = q ? searchGyms(gyms, q) : gyms.slice(0, 20);
					return Response.json(
						results.slice(0, 20).map((g) => ({
							gym_uuid: g.gym_uuid,
							name: g.name,
							city: g.city ?? "",
							country: g.country ?? "",
						})),
					);
				},
			},

			"/api/walls": {
				GET: (req) => {
					const gymUuid = new URL(req.url).searchParams.get("gym") ?? "";
					const gymWalls = findWallsForGym(walls, gymUuid);
					return Response.json(
						gymWalls.map((w) => ({
							wall_uuid: w.wall_uuid,
							name: w.name,
							product_layout_uuid: w.product_layout_uuid,
						})),
					);
				},
			},

			"/api/import": {
				POST: async (req) => {
					if (importRunning) {
						return Response.json(
							{ error: "Import already in progress" },
							{ status: 409 },
						);
					}
					const { gymUuid, wallUuid, layoutId } = (await req.json()) as {
						gymUuid: string;
						wallUuid: string;
						layoutId: string;
					};
					runImport(gymUuid, wallUuid, layoutId);
					return Response.json({ started: true });
				},
			},

			"/api/progress": {
				GET: (req, server) => {
					server.timeout(req, 0);
					ssePending = [];
					sseWaiter = null;
					return new Response(
						async function* () {
							yield `data: ${JSON.stringify({ phase: "connected" })}\n\n`;
							while (true) {
								const msg = await nextSSE();
								yield `data: ${JSON.stringify(msg)}\n\n`;
								if (
									msg &&
									typeof msg === "object" &&
									"phase" in msg &&
									((msg as Record<string, unknown>).phase === "done" ||
										(msg as Record<string, unknown>).phase === "error")
								) {
									return;
								}
							}
						},
						{
							headers: {
								"Content-Type": "text/event-stream",
								"Cache-Control": "no-cache",
							},
						},
					);
				},
			},
		},
	});

	const url = `http://localhost:${port}`;
	console.log(`\n  Kilter Board Migration Tool`);
	console.log(`  Open your browser to: ${url}\n`);

	const openers: Record<string, string[]> = {
		win32: ["cmd", "/c", "start"],
		darwin: ["open"],
		linux: ["xdg-open"],
	};
	const cmd = openers[process.platform] ?? openers.linux;
	Bun.spawn([...cmd, url]);
}
