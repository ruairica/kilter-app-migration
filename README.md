# kilter-app-migration

Migrate your logbook and playlists from the old Kilter Board app into the new one. It takes a JSON export from the old app and imports your ascents, attempts, and circuits via the Kilter API.

## What it imports

- Ascents (sends/completions with grade and date)
- Attempts (logged but not completed)
- Circuits (playlists of climbs)

## Usage

### Web UI (recommended)

Run the binary/program (on Windows, just double-click it) — it will open a browser window with a step-by-step wizard that guides you through selecting your export file, logging in, picking your gym, and importing your data. No terminal required.

Download the correct binary program for your OS from the [releases page](https://github.com/ruairica/kilter-app-migration/releases).

### Command line (alternative)

If you prefer using the terminal, run the exe with your export file as an argument:

On Windows (if your terminal is in the same directory as the exe):
```
.\kilter-migrate-windows.exe "path\to\export.json"
```

**Tip:** Open a terminal, drag the exe into it, then drag the JSON file in after it — this fills in both paths for you. It will look something like:
```
C:\Users\You\Downloads\kilter-migrate-windows.exe C:\Users\You\Documents\export.json
```

The tool will prompt you to log in, pick your gym and wall, then import everything it finds in the export file.

Your login details are sent directly to Kilter's servers and are not stored.

## Running from source

Requires [Bun](https://bun.sh/).

```
bun install
bun run start <path-to-export.json>
```

## Building from source

Builds standalone executables for Windows, Linux, and macOS:

```
bun run build
```

Outputs are written to `dist/`.
