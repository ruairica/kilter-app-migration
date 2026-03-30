import type { ExportData, Gym, Wall, ImportResult } from "./types.js";
import { getToken, getUserUuid } from "./api.js";
import { getGymsAndWalls, searchGyms, findWallsForGym } from "./sync.js";
import { buildClimbLookup } from "./climbs.js";
import { buildGradeMap } from "./grades.js";
import { importAscents, importAttempts } from "./import-logs.js";
import { importCircuits } from "./import-circuits.js";

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
  return new Promise(resolve => { sseWaiter = resolve; });
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
      sendSSE({ phase: "ascents", current: 0, total: exportData!.ascents.length });
      results.ascents = await importAscents(
        token!, userUuid!, gymUuid, wallUuid, layoutId,
        exportData!.ascents, climbLookup, gradeMap,
        (n, total) => sendSSE({ phase: "ascents", current: n, total }),
      );
    }

    if (exportData!.attempts.length > 0) {
      sendSSE({ phase: "attempts", current: 0, total: exportData!.attempts.length });
      results.attempts = await importAttempts(
        token!, userUuid!, gymUuid, wallUuid, layoutId,
        exportData!.attempts, climbLookup,
        (n, total) => sendSSE({ phase: "attempts", current: n, total }),
      );
    }

    if (exportData!.circuits.length > 0) {
      sendSSE({ phase: "circuits", current: 0, total: exportData!.circuits.length });
      const creatorName = exportData!.user?.username ?? "Unknown";
      results.circuits = await importCircuits(
        token!, userUuid!, creatorName, layoutId,
        exportData!.circuits, climbLookup,
        (n, total) => sendSSE({ phase: "circuits", current: n, total }),
      );
    }

    sendSSE({ phase: "done", results });
  } catch (e) {
    sendSSE({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    importRunning = false;
  }
}

export function startServer() {
  const port = 9876;
  Bun.serve({
    port,
    routes: {
      "/": new Response(getHtml(), {
        headers: { "Content-Type": "text/html" },
      }),

      "/api/upload": {
        POST: async (req) => {
          try {
            exportData = (await req.json()) as ExportData;
            return Response.json({
              ascents: exportData.ascents?.length ?? 0,
              attempts: exportData.attempts?.length ?? 0,
              circuits: exportData.circuits?.length ?? 0,
              circuitClimbs: exportData.circuits?.reduce((s, c) => s + c.climbs.length, 0) ?? 0,
            });
          } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400 });
          }
        },
      },

      "/api/login": {
        POST: async (req) => {
          try {
            const { username, password } = (await req.json()) as { username: string; password: string };
            token = await getToken(username, password);
            userUuid = getUserUuid(token);
            const data = getGymsAndWalls();
            gyms = data.gyms;
            walls = data.walls;
            return Response.json({ success: true, gymCount: gyms.length });
          } catch (e) {
            return Response.json(
              { error: e instanceof Error ? e.message : "Authentication failed" },
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
            results.slice(0, 20).map(g => ({
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
            gymWalls.map(w => ({
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
            return Response.json({ error: "Import already in progress" }, { status: 409 });
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
                if (msg && typeof msg === "object" && ("phase" in msg) &&
                    ((msg as any).phase === "done" || (msg as any).phase === "error")) {
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

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kilter Board Migration</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5; color: #333; min-height: 100vh;
    display: flex; justify-content: center; padding: 40px 20px;
  }
  .container { max-width: 520px; width: 100%; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 32px; }
  .step {
    background: #fff; border-radius: 8px; padding: 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;
    display: none;
  }
  .step.active { display: block; }
  .step h2 { font-size: 1.1rem; margin-bottom: 16px; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; color: #555; }
  input[type="text"], input[type="email"], input[type="password"] {
    width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px;
    font-size: 0.95rem; outline: none; transition: border-color 0.2s;
  }
  input:focus { border-color: #4a90d9; }
  .file-drop {
    border: 2px dashed #ccc; border-radius: 8px; padding: 32px;
    text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s;
    color: #888; font-size: 0.95rem;
  }
  .file-drop:hover, .file-drop.dragover { border-color: #4a90d9; background: #f0f6ff; }
  .file-drop input { display: none; }
  .summary-box {
    background: #f0f6ff; border-radius: 6px; padding: 12px 16px;
    margin-top: 12px; font-size: 0.9rem; color: #333;
  }
  .btn {
    display: inline-block; padding: 10px 24px; background: #4a90d9; color: #fff;
    border: none; border-radius: 6px; font-size: 0.95rem; cursor: pointer;
    margin-top: 16px; transition: background 0.2s;
  }
  .btn:hover { background: #3a7bc8; }
  .btn:disabled { background: #aaa; cursor: not-allowed; }
  .error { color: #c0392b; font-size: 0.85rem; margin-top: 8px; }
  .success { color: #27ae60; font-size: 0.85rem; margin-top: 8px; }
  .field + .field { margin-top: 12px; }
  .gym-results {
    max-height: 200px; overflow-y: auto; border: 1px solid #ddd;
    border-radius: 6px; margin-top: 8px;
  }
  .gym-results.hidden { display: none; }
  .gym-item {
    padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #eee;
    font-size: 0.9rem;
  }
  .gym-item:last-child { border-bottom: none; }
  .gym-item:hover { background: #f0f6ff; }
  .wall-select { margin-top: 12px; }
  .wall-select select {
    width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px;
    font-size: 0.95rem; background: #fff;
  }
  .selected-gym {
    background: #e8f5e9; border-radius: 6px; padding: 10px 14px;
    margin-top: 8px; font-size: 0.9rem; display: flex;
    justify-content: space-between; align-items: center;
  }
  .selected-gym .change { color: #4a90d9; cursor: pointer; font-size: 0.85rem; }
  .progress-section { margin-top: 12px; }
  .progress-phase { margin-bottom: 12px; }
  .progress-label { font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; }
  .progress-bar-bg {
    background: #eee; border-radius: 4px; height: 8px; overflow: hidden;
  }
  .progress-bar-fill {
    background: #4a90d9; height: 100%; border-radius: 4px;
    transition: width 0.3s;
  }
  .progress-text { font-size: 0.8rem; color: #666; margin-top: 2px; }
  .results-table { width: 100%; font-size: 0.9rem; margin-top: 12px; }
  .results-table td { padding: 6px 0; }
  .results-table td:last-child { text-align: right; }
  .status-msg { font-size: 0.9rem; color: #666; margin-top: 8px; }
  .done-msg { font-size: 1rem; color: #27ae60; font-weight: 600; margin-top: 16px; }
</style>
</head>
<body>
<div class="container">
  <h1>Kilter Board Migration</h1>
  <p class="subtitle">Import your logbook and playlists from the old app</p>

  <!-- Step 1: File Upload -->
  <div class="step active" id="step-file">
    <h2>1. Select your export file</h2>
    <div class="file-drop" id="file-drop">
      <p>Click to select or drag and drop your JSON file</p>
      <input type="file" id="file-input" accept=".json">
    </div>
    <div id="file-summary"></div>
    <div class="error" id="file-error"></div>
    <button class="btn" id="file-next" disabled>Next</button>
  </div>

  <!-- Step 2: Login -->
  <div class="step" id="step-login">
    <h2>2. Log in to your new Kilter account</h2>
    <p style="font-size:0.85rem;color:#666;margin-bottom:16px">Your credentials are sent directly to Kilter's servers and are not stored.</p>
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" placeholder="you@example.com">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" placeholder="Password">
    </div>
    <div class="error" id="login-error"></div>
    <div class="success" id="login-success"></div>
    <button class="btn" id="login-btn">Sign In</button>
  </div>

  <!-- Step 3: Gym & Wall -->
  <div class="step" id="step-gym">
    <h2>3. Select your gym and wall</h2>
    <div class="field">
      <label for="gym-search">Search for your gym</label>
      <input type="text" id="gym-search" placeholder="Start typing...">
    </div>
    <div class="gym-results hidden" id="gym-results"></div>
    <div id="gym-selected"></div>
    <div class="wall-select" id="wall-section" style="display:none">
      <label for="wall-select">Select your wall</label>
      <select id="wall-select"></select>
    </div>
    <div class="error" id="gym-error"></div>
    <button class="btn" id="gym-next" disabled>Next</button>
  </div>

  <!-- Step 4: Confirm & Import -->
  <div class="step" id="step-import">
    <h2>4. Confirm and import</h2>
    <div class="summary-box" id="import-summary"></div>
    <button class="btn" id="import-btn">Start Import</button>
    <div class="progress-section" id="progress-section" style="display:none">
      <div class="status-msg" id="status-msg"></div>
      <div id="progress-bars"></div>
    </div>
    <div id="results-section" style="display:none">
      <div class="done-msg">Import complete!</div>
      <table class="results-table" id="results-table"></table>
      <p style="font-size:0.85rem;color:#666;margin-top:12px">Check the Kilter app to see your imported data.</p>
    </div>
  </div>
</div>

<script>
  const state = {
    fileSummary: null,
    gym: null,
    wall: null,
    walls: [],
  };

  function show(id) { document.getElementById(id).classList.add("active"); }
  function hide(id) { document.getElementById(id).classList.remove("active"); }
  function $(id) { return document.getElementById(id); }

  // --- Step 1: File Upload ---
  const fileDrop = $("file-drop");
  const fileInput = $("file-input");

  fileDrop.addEventListener("click", () => fileInput.click());
  fileDrop.addEventListener("dragover", e => { e.preventDefault(); fileDrop.classList.add("dragover"); });
  fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("dragover"));
  fileDrop.addEventListener("drop", e => {
    e.preventDefault();
    fileDrop.classList.remove("dragover");
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });

  async function handleFile(file) {
    $("file-error").textContent = "";
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.ascents && !data.attempts && !data.circuits) {
        throw new Error("This doesn't look like a Kilter export file");
      }
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      state.fileSummary = await res.json();
      fileDrop.innerHTML = "<p>" + file.name + "</p>";
      $("file-summary").innerHTML =
        '<div class="summary-box">' +
        state.fileSummary.ascents + " ascents, " +
        state.fileSummary.attempts + " attempts, " +
        state.fileSummary.circuits + " circuits (" +
        state.fileSummary.circuitClimbs + " climbs)</div>";
      $("file-next").disabled = false;
    } catch (e) {
      $("file-error").textContent = e.message || "Could not read file";
    }
  }

  $("file-next").addEventListener("click", () => { hide("step-file"); show("step-login"); });

  // --- Step 2: Login ---
  $("login-btn").addEventListener("click", async () => {
    const email = $("email").value.trim();
    const pwd = $("password").value;
    if (!email || !pwd) return;
    $("login-error").textContent = "";
    $("login-success").textContent = "";
    $("login-btn").disabled = true;
    $("login-btn").textContent = "Signing in...";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: email, password: pwd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      $("login-success").textContent = "Authenticated (" + data.gymCount + " gyms loaded)";
      setTimeout(() => { hide("step-login"); show("step-gym"); loadGyms(""); }, 500);
    } catch (e) {
      $("login-error").textContent = e.message;
    } finally {
      $("login-btn").disabled = false;
      $("login-btn").textContent = "Sign In";
    }
  });

  $("password").addEventListener("keydown", e => { if (e.key === "Enter") $("login-btn").click(); });

  // --- Step 3: Gym & Wall ---
  let searchTimeout;
  $("gym-search").addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadGyms($("gym-search").value.trim()), 200);
  });

  let lastGymResults = [];
  async function loadGyms(query) {
    const res = await fetch("/api/gyms?q=" + encodeURIComponent(query));
    lastGymResults = await res.json();
    const container = $("gym-results");
    if (lastGymResults.length === 0) {
      container.classList.add("hidden");
      return;
    }
    container.innerHTML = lastGymResults.map((g, i) =>
      '<div class="gym-item" data-index="' + i + '">' +
      escHtml(g.name) + ' <span style="color:#999">(' + escHtml(g.city) + ', ' + escHtml(g.country) + ')</span></div>'
    ).join("");
    container.classList.remove("hidden");
    container.querySelectorAll(".gym-item").forEach(el => {
      el.addEventListener("click", () => {
        const g = lastGymResults[parseInt(el.dataset.index)];
        selectGym(g.gym_uuid, g.name);
      });
    });
  }

  async function selectGym(uuid, name) {
    state.gym = { uuid, name };
    $("gym-results").classList.add("hidden");
    $("gym-search").style.display = "none";
    $("gym-selected").innerHTML =
      '<div class="selected-gym"><span>' + escHtml(name) + '</span><span class="change" id="change-gym">Change</span></div>';
    $("change-gym").addEventListener("click", () => {
      state.gym = null;
      state.wall = null;
      $("gym-selected").innerHTML = "";
      $("gym-search").style.display = "";
      $("gym-search").value = "";
      $("wall-section").style.display = "none";
      $("gym-next").disabled = true;
      loadGyms("");
    });

    const res = await fetch("/api/walls?gym=" + encodeURIComponent(uuid));
    state.walls = await res.json();

    if (state.walls.length === 0) {
      $("gym-error").textContent = "This gym has no registered walls.";
      $("gym-next").disabled = true;
      return;
    }

    $("gym-error").textContent = "";
    if (state.walls.length === 1) {
      state.wall = state.walls[0];
      $("wall-section").style.display = "block";
      $("wall-select").innerHTML = '<option>' + escHtml(state.wall.name) + ' (layout ' + state.wall.product_layout_uuid + ')</option>';
      $("gym-next").disabled = false;
    } else {
      $("wall-section").style.display = "block";
      $("wall-select").innerHTML = state.walls.map((w, i) =>
        '<option value="' + i + '">' + escHtml(w.name) + ' (layout ' + w.product_layout_uuid + ')</option>'
      ).join("");
      state.wall = state.walls[0];
      $("gym-next").disabled = false;
    }
  }

  $("wall-select").addEventListener("change", () => {
    state.wall = state.walls[parseInt($("wall-select").value)];
  });

  $("gym-next").addEventListener("click", () => {
    hide("step-gym");
    show("step-import");
    $("import-summary").innerHTML =
      "<strong>Import " + state.fileSummary.ascents + " ascents, " +
      state.fileSummary.attempts + " attempts, " +
      state.fileSummary.circuits + " circuits</strong><br>" +
      "to " + escHtml(state.gym.name) + " &mdash; " + escHtml(state.wall.name) +
      " (layout " + state.wall.product_layout_uuid + ")";
  });

  // --- Step 4: Import ---
  $("import-btn").addEventListener("click", async () => {
    $("import-btn").disabled = true;
    $("import-btn").style.display = "none";
    $("progress-section").style.display = "block";
    $("status-msg").textContent = "Starting import...";

    const evtSource = new EventSource("/api/progress");
    evtSource.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.phase === "loading") {
        $("status-msg").textContent = d.message;
      } else if (d.phase === "ascents" || d.phase === "attempts" || d.phase === "circuits") {
        $("status-msg").textContent = "";
        updateProgress(d.phase, d.current, d.total);
      } else if (d.phase === "done") {
        evtSource.close();
        $("progress-section").style.display = "none";
        $("results-section").style.display = "block";
        showResults(d.results);
      } else if (d.phase === "error") {
        evtSource.close();
        $("status-msg").textContent = "Error: " + d.message;
        $("status-msg").style.color = "#c0392b";
      }
    };

    // Wait for SSE connection to open before triggering import
    await new Promise(resolve => { evtSource.onopen = resolve; });

    await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gymUuid: state.gym.uuid,
        wallUuid: state.wall.wall_uuid,
        layoutId: String(state.wall.product_layout_uuid),
      }),
    });
  });

  function updateProgress(phase, current, total) {
    let bar = document.getElementById("bar-" + phase);
    if (!bar) {
      const html =
        '<div class="progress-phase" id="bar-' + phase + '">' +
        '<div class="progress-label">' + phase.charAt(0).toUpperCase() + phase.slice(1) + '</div>' +
        '<div class="progress-bar-bg"><div class="progress-bar-fill" id="fill-' + phase + '"></div></div>' +
        '<div class="progress-text" id="text-' + phase + '"></div></div>';
      $("progress-bars").insertAdjacentHTML("beforeend", html);
    }
    const pct = total > 0 ? (current / total * 100) : 0;
    document.getElementById("fill-" + phase).style.width = pct + "%";
    document.getElementById("text-" + phase).textContent = current + " / " + total;
  }

  function showResults(results) {
    let rows = "";
    for (const [phase, r] of Object.entries(results)) {
      const name = phase.charAt(0).toUpperCase() + phase.slice(1);
      rows += "<tr><td><strong>" + name + "</strong></td><td>" +
        r.imported + " imported, " + r.skipped + " skipped, " + r.failed + " failed</td></tr>";
    }
    $("results-table").innerHTML = rows;
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
</script>
</body>
</html>`;
}
