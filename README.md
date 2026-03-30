# kilter-app-migration

CLI tool to migrate your logbook and playlists from the old Kilter Board app into the new one. It takes a JSON export from the old app and imports your ascents, attempts, and circuits via the Kilter API.

## What it imports

- Ascents (sends/completions with grade and date)
- Attempts (logged but not completed)
- Circuits (playlists of climbs)

## Usage

Download the correct binary for your OS from the [releases page](https://github.com/ruairica/kilter-app-migration/releases), then run it with your export file:

On Windows (if your terminal is in the same directory as the exe):
```
.\kilter-migrate-windows.exe "path\to\export.json"
```

**Tip:** Open a terminal, drag the exe into it, then drag the JSON file in after it — this fills in both paths for you. It will look something like:
```
C:\Users\You\Downloads\kilter-migrate-windows.exe C:\Users\You\Documents\export.json
```

The tool will prompt you to log in (your login details are not sent anywhere, they remain on your machine), pick your gym and wall (new app requires a wall for it to be logged at), then import everything it finds in the export file.

## Running from source

Requires [Bun](https://bun.sh/).

```
bun install
bun run start <path-to-export.json>
```
