# Suno Library FF — v0.4.0

Firefox MV3 WebExtension that indexes **your** Suno library into IndexedDB.

Not affiliated with Suno or Suno Explorer. Does not contain their source.
Does not generate songs, solve captchas, or persist Bearer tokens.

MUSE companion: this is a **Suno adapter**, not the workbench. See [ARCHITECTURE.md](ARCHITECTURE.md).

| Related | Role |
|---|---|
| [n3x7-muse](https://github.com/AvaPrime/n3x7-muse) | Provider-agnostic music intelligence workbench |
| [codessa-musiclab](https://github.com/AvaPrime/codessa-musiclab) | Local audio engine / pipeline |
| [grid](https://github.com/AvaPrime/grid) | DJ crate OS — sidecar batches are ingest input, not GRID crates |

## Scope

Implemented:

- MAIN-world fetch/XHR hook → isolated bridge → background
- In-memory Bearer + cookie fallback
- `POST /api/feed/v3` page walker with rate-limit backoff
- IndexedDB schema v1 (`clips`, `curation`, `edges`, `playlists`, `sync_state`)
- Popup: auth status, start/stop sync, recent clips
- Sidecar export via `browser.downloads` (`<stem>.json` + audio, optional art)
- Durable export cursor in IDB + `alarms` watchdog (event-page resume)
- Durable sync job + `waiting_auth` resume when a Bearer is recaptured

Not implemented (intentionally):

- File System Access offline folder scan
- Widgets on suno.com
- Cloud sync
- Search / lineage UI
- Stem / WAV download

## Install (temporary)

1. Firefox → `about:debugging#/runtime/this-firefox`
2. Load Temporary Add-on
3. Select `manifest.json` in this directory
4. Open https://suno.com while logged in
5. Click the toolbar icon → Index library

Minimum Firefox: 128 (MAIN-world content scripts).

## Design constraints

| Decision | Reason |
|---|---|
| Token in worker RAM only | TTL-bound; a reload drops it |
| Curation store separate from clips | Re-index must not wipe annotations |
| Dual API hosts | Hostname has drifted in the wild |
| Cursor + page in one client | Feed contract is not stable |
| No generation endpoints | Different risk class than library read |
| Downloads folder + sidecar | Firefox has no durable directory handle |
| Sidecar without `raw` by default | `raw` is large and unstable |

## Export layout

Each run writes a new batch directory under Downloads:

```
suno-library-ff/<iso-stamp>/
  catalog.json
  Title-abcd1234.json
  Title-abcd1234.mp3
```

Sidecar schema: `suno-library-ff.sidecar.v1`  
Catalog schema: `suno-library-ff.catalog.v1`

`catalog.json` is written last so a partial run is still recoverable from per-clip sidecars.

Entire-index export will open one download per file. Use Slow on large libraries.

## Next increments

1. Confirm live `feed/v3` request body against a captured HAR.
2. Derive lineage edges from `parent_id` on insert.
3. Add FTS (SQLite WASM) once clip volume exceeds IDB scan comfort.
4. Lineage edges on insert; confirm `feed/v3` body against a live HAR.

## Schema

`clips.id` is the Suno clip UUID.

`sync_state.library` holds `{ next_cursor, page, accumulated, completed }`.
`sync_state.sync_job` holds `{ status, speed, lastError }`.
`sync_state.export` holds a job:
`{ status, dir, clipIds, nextIndex, done, failed, total, entries, options, speed }`.

Watchdogs: `export-watchdog` and `sync-watchdog` (1 min). RAM flags are mutexes only.

Sync resume needs auth. If the Bearer is gone after suspend, status becomes `waiting_auth` until the content hook delivers a new token.
