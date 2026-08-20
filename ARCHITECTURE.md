# Architecture

## Placement

This repository is a **Suno provider adapter**, not the music intelligence workbench.

| Repo | Role |
|---|---|
| [AvaPrime/n3x7-muse](https://github.com/AvaPrime/n3x7-muse) | MUSE workbench. Canonical understanding, taste, curation, sonic engineering. Provider APIs are adapters. |
| [AvaPrime/codessa-musiclab](https://github.com/AvaPrime/codessa-musiclab) | Local audio pipeline (prompt → MIDI / stems / reflection). |
| **AvaPrime/suno-library-ff** | Firefox-local index of *your* Suno library. Read path only. |

Do not merge this into `n3x7-muse`. That repo is provider-agnostic by invariant. A vendor feed walker would contaminate the workbench boundary.

## Contract

```
suno.com session
    → MAIN-world fetch hook (ephemeral Bearer)
    → isolated bridge
    → event-page background
    → studio-api feed/v3 (unofficial, volatile)
    → IndexedDB (clips | curation | edges | sync_state)
    → sidecar export via browser.downloads
```

Canonical clip identity here is the Suno UUID. That is a *provider* id. A later MUSE import should mint a sovereign id and keep the Suno UUID as provenance, not as the primary key.

## Event-page invariants

Firefox MV3 backgrounds are non-persistent (`background.scripts`, not `service_worker`).

- Bearer: RAM only, ~25 min TTL.
- Sync/export: durable jobs in `sync_state` + 1-minute alarms.
- Sync resume after suspend may be `waiting_auth` until a new Bearer arrives.

## Out of scope

Generation, captcha, Suno Explorer source, cloud sync, File System Access.

Those belong in other adapters or not at all.
