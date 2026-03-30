# kilter-app-migration

CLI tool to migrate your logbook and playlists from the old Kilter Board app into the new one. It takes a JSON export from the old app and imports your ascents, attempts, and circuits via the Kilter API.

## What it imports

- Ascents (sends/completions with grade and date)
- Attempts (logged but not completed)
- Circuits (playlists of climbs)

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A JSON export file from the old Kilter Board app
- Your Kilter Board account credentials

## Running from source

```
bun install
bun run start <path-to-export.json>
```

The tool will prompt you to log in (your login details are not sent anywhere, they remain on your machine), pick your gym and wall (new app requires a wall for it to be logged at), then import everything it finds in the export file.
