# Clanton Gantt Board

## Architecture
- **Single-file app**: `index.html` contains all HTML, CSS, and JavaScript
- **Data file**: `data.json` is the shared project/task data (stored in GitHub repo)
- **No build tools, no dependencies** — pure vanilla JS

## GitHub Backend
- Settings stored in `localStorage` under `clanton_gantt_settings` (owner, repo, branch, token)
- Data read/written via GitHub Contents API (`GET`/`PUT /repos/{owner}/{repo}/contents/data.json`)
- SHA-based optimistic concurrency — 409 conflict triggers reload prompt
- Auto-polls every 30 seconds for remote changes (compares SHA)
- localStorage kept as fast cache and offline fallback
- Sync indicator in toolbar: green=synced, yellow=saving, red=error

## Key Storage Keys
- `clanton_gantt_data` — project/task data (localStorage cache)
- `clanton_gantt_settings` — GitHub connection settings

## Data Schema
- `state.projects[]`: `{id, name, teamMembers[], order}`
- `state.tasks[]`: `{id, projectId, title, type, startDate, endDate, status, notes}`
- `state.nextId`: auto-increment counter

## Development
Just open `index.html` in a browser. No server or build step required.
