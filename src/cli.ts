import { password, search, select, confirm } from "@inquirer/prompts";
import type { ExportData, Gym, Wall } from "./types.js";
import { getToken, getUserUuid } from "./api.js";
import { getGymsAndWalls, searchGyms, findWallsForGym } from "./sync.js";
import { buildClimbLookup } from "./climbs.js";
import { buildGradeMap } from "./grades.js";
import { importAscents, importAttempts } from "./import-logs.js";
import { importCircuits } from "./import-circuits.js";

function progressBar(current: number, total: number, width = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar = "=".repeat(filled) + " ".repeat(width - filled);
  return `[${bar}] ${current}/${total}`;
}

async function main() {
  console.log("\n  Kilter Board Migration Tool");
  console.log("  Import your logbook and playlists from the old app\n");

  const exportPath = process.argv[2];
  if (!exportPath) {
    console.error("  Usage: kilter-migrate <export-file.json>");
    console.error("  Tip: drag your JSON file onto the exe, or onto the terminal after the command\n");
    process.exitCode = 1;
    return;
  }

  const file = Bun.file(exportPath);
  if (!await file.exists()) {
    console.error(`  File not found: ${exportPath}`);
    process.exitCode = 1;
    return;
  }

  let exportData: ExportData;
  try {
    exportData = await file.json();
  } catch {
    console.error(`  Could not parse ${exportPath}. Check the file is valid JSON.`);
    process.exitCode = 1;
    return;
  }

  const ascentCount = exportData.ascents?.length ?? 0;
  const attemptCount = exportData.attempts?.length ?? 0;
  const circuitCount = exportData.circuits?.length ?? 0;
  const circuitClimbCount = exportData.circuits?.reduce((s, c) => s + c.climbs.length, 0) ?? 0;

  console.log(`  Found: ${ascentCount} ascents, ${attemptCount} attempts, ${circuitCount} circuits (${circuitClimbCount} climbs)\n`);

  if (ascentCount === 0 && attemptCount === 0 && circuitCount === 0) {
    console.log("  Nothing to import.");
    return;
  }

  const username = await new Promise<string>((resolve) => {
    process.stdout.write("  New app username (email): ");
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.once("line", (line: string) => { rl.close(); resolve(line.trim()); });
  });
  const pwd = await password({ message: "New app password:" });

  let token: string;
  let userUuid: string;
  try {
    token = await getToken(username, pwd);
    userUuid = getUserUuid(token);
    console.log("  Authenticated\n");
  } catch (e) {
    console.error(`  Authentication failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  const { gyms, walls } = getGymsAndWalls();
  console.log(`  ${gyms.length} gyms loaded\n`);

  const selectedGym = await search<Gym>({
    message: "Search for your gym:",
    source: async (term) => {
      const results = term ? searchGyms(gyms, term) : gyms.slice(0, 20);
      return results.map(g => ({
        name: `${g.name} (${g.city ?? ""}, ${g.country ?? ""})`,
        value: g,
      }));
    },
  });

  const gymUuid = String(selectedGym.gym_uuid);
  console.log(`  Selected: ${selectedGym.name}\n`);

  const gymWalls = findWallsForGym(walls, gymUuid);

  let selectedWall: Wall;
  if (gymWalls.length === 0) {
    console.error("  This gym has no registered walls. Cannot proceed.");
    process.exitCode = 1;
    return;
  } else if (gymWalls.length === 1) {
    selectedWall = gymWalls[0];
    console.log(`  Wall: ${selectedWall.name} (layout ${selectedWall.product_layout_uuid})\n`);
  } else {
    selectedWall = await select<Wall>({
      message: "Select your wall:",
      choices: gymWalls.map(w => ({
        name: `${w.name} (layout ${w.product_layout_uuid})`,
        value: w,
      })),
    });
    console.log();
  }

  const wallUuid = selectedWall.wall_uuid;
  const layoutId = String(selectedWall.product_layout_uuid);

  const neededNames = new Set<string>();
  for (const a of exportData.ascents) neededNames.add(a.climb);
  for (const a of exportData.attempts) neededNames.add(a.climb);
  for (const c of exportData.circuits) {
    for (const name of c.climbs) neededNames.add(name);
  }

  console.log("  Loading climbs...");
  const [climbLookup, gradeMap] = await Promise.all([
    buildClimbLookup(token, layoutId, walls, neededNames),
    buildGradeMap(token),
  ]);
  console.log(`  ${climbLookup.size} climbs loaded\n`);

  console.log(`  Ready to import:`);
  console.log(`    ${ascentCount} ascents, ${attemptCount} attempts, ${circuitCount} circuits`);
  console.log(`    to ${selectedGym.name} — ${selectedWall.name} (layout ${layoutId})\n`);

  const proceed = await confirm({ message: "Proceed with import?" });
  if (!proceed) {
    console.log("  Cancelled.");
    return;
  }
  console.log();

  if (ascentCount > 0) {
    console.log("  Importing ascents...");
    const ascentResult = await importAscents(
      token, userUuid, gymUuid, wallUuid, layoutId,
      exportData.ascents, climbLookup, gradeMap,
      (n, total) => {
        process.stdout.write(`\r\x1b[K  Ascents ${progressBar(n, total)}`);
      },
    );
    process.stdout.write(`\r\x1b[K  Ascents: ${ascentResult.imported} imported, ${ascentResult.skipped} skipped, ${ascentResult.failed} failed\n`);
  }

  if (attemptCount > 0) {
    console.log("  Importing attempts...");
    const attemptResult = await importAttempts(
      token, userUuid, gymUuid, wallUuid, layoutId,
      exportData.attempts, climbLookup,
      (n, total) => {
        process.stdout.write(`\r  Attempts ${progressBar(n, total)}`);
      },
    );
    console.log(`\r  Attempts: ${attemptResult.imported} imported, ${attemptResult.skipped} skipped, ${attemptResult.failed} failed`);
  }

  if (circuitCount > 0) {
    console.log("  Importing circuits...");
    const creatorName = exportData.user?.username ?? username;
    const circuitResult = await importCircuits(
      token, userUuid, creatorName, layoutId,
      exportData.circuits, climbLookup,
      (n, total) => {
        process.stdout.write(`\r  Circuits ${progressBar(n, total)}`);
      },
    );
    console.log(`\r  Circuits: ${circuitResult.imported} imported, ${circuitResult.skipped} skipped, ${circuitResult.failed} failed`);
  }

  console.log("\n  Done! Check the Kilter app to see your imported data.\n");
}

main().catch((e) => {
  console.error(`\n  Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
