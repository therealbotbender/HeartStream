# HeartStream V2 — Build Plan

## Architecture
```
Browser
  └── HeartStream (Express + SQLite)
        ├── TMDB API         — content metadata + IMDb ID lookup
        ├── AniList API      — anime metadata
        ├── Jackettio        — stream resolver (Docker, self-hosted, Node.js)
        │     ├── Jackett    — torrent indexer proxy (thepiratebay, yts, eztv, therarbg)
        │     └── Real-Debrid — converts cached torrents → direct HTTPS URLs (~$3/month)
        └── VidKing iframe   — fallback if Jackettio returns nothing
```

## Playback Flow
```
User clicks Play
  → server calls TMDB /external_ids to get IMDb ID (in-process cached)
  → server calls Jackettio /{base64-config}/stream/{type}/{imdbId}.json
  → Jackettio queries Jackett indexers, checks RD cache, returns direct HTTPS URLs
  → server picks best quality URL, sends to frontend
  → native <video> tag plays it directly (no ads, no iframe)
  → if Jackettio returns nothing → fall back to VidKing iframe
```

## Why Jackettio over AIOStreams
- AIOStreams is an aggregator of other addons — delegates to Torrentio/Comet etc., doesn't talk to RD directly
- AIOStreams stores RD key in encrypted DB tied to a UUID — complex to call programmatically
- Jackettio: RD key + config live entirely in a base64 URL segment — built once at startup, no DB
- Both need IMDb IDs (not TMDB) — solved via TMDB external_ids endpoint (cached)
- MediaFusion supports TMDB IDs natively but requires MongoDB + Redis + Celery — too heavy

## Content Types & IDs
- Jackettio accepts: `movie/{imdbId}` and `series/{imdbId}:{season}:{episode}`
- IMDb IDs fetched from TMDB `/movie/{id}/external_ids` or `/tv/{id}/external_ids`
- IMDb lookup is cached in-process in TMDBService._externalIdsCache

---

## File Status

### Infrastructure
| File | Status | Notes |
|------|--------|-------|
| `docker-compose.yml` | DONE | heartstream + aiostreams services |
| `.env.example` | DONE | All vars documented |
| `server/Dockerfile` | DONE | |
| `server/package.json` | DONE | express, sqlite3, node-fetch, dotenv |

### Backend — Copied from V1 (review before use)
| File | Status | Notes |
|------|--------|-------|
| `server/database.js` | COPIED | SQLite schema — ok to use as-is |
| `server/api/tmdb.js` | COPIED | TMDB wrapper — ok to use as-is |
| `server/api/contentService.js` | COPIED | Content fetching — ok to use as-is |
| `server/api/anilist.js` | COPIED | AniList wrapper — ok to use as-is |

### Backend — New / Rewritten
| File | Status | Notes |
|------|--------|-------|
| `server/services/providers/jackettio.js` | DONE | Builds base64 config, calls Jackettio, ranks by quality |
| `server/services/providers/aiostreams.js` | SUPERSEDED | Replaced by Jackettio |
| `server/services/streamResolver.js` | DONE | TMDB→IMDb lookup + Jackettio provider |
| `server/api/tmdb.js` | UPDATED | Added getExternalIds() with in-process cache |
| `server/server.js` | DONE | Clean Express, async/await, all routes |

### Frontend
| File | Status | Notes |
|------|--------|-------|
| `web-app-public/index.html` | COPIED | Strip iframe player, add `<video>` tag |
| `web-app-public/styles.css` | COPIED | Mostly reusable, add native player styles |
| `web-app-public/manifest.json` | COPIED | Ok as-is |
| `web-app-public/api-client.js` | DONE | Clean fetch wrapper, all routes covered |
| `web-app-public/app.js` | DONE | ES module entry point — init, nav, sections, detail modal |
| `web-app-public/player.js` | DONE | Native video + iframe fallback, progress tracking |
| `web-app-public/content.js` | DONE | Card/carousel/grid rendering helpers |
| `web-app-public/state.js` | DONE | Shared app state |

---

## Build Order

### Phase 1 — Backend foundation ✓
- [x] `server/server.js` — all routes, async/await, matches actual db API
- [x] `server/database.js` — added getUserById, updateUser, getContinueWatching
- [x] `server/api/contentService.js` — removed OMDb dependency, all imports valid
- [ ] Test: `GET /api/stream/movie/:tmdbId` returns a URL from AIOStreams (needs Real-Debrid)

### Phase 2 — Frontend shell ✓
- [x] `index.html` — stripped V1 scripts, ES module entry point
- [x] `api-client.js` — clean fetch wrapper, all routes
- [x] `app.js` — init, nav, sections, detail modal, user management
- [x] `player.js` — native video + iframe fallback, 10s progress autosave, resume
- [x] `content.js` — card/carousel/grid rendering
- [x] `state.js` — shared app state

### Phase 3 — Playback ✓
- [x] Native player controls (native `<video controls>`)
- [x] Progress tracking — 10s autosave + on pause/close
- [x] Resume — `videoEl.currentTime = savedProgress`
- [x] Fallback — iframe loaded if Jackettio returns nothing
- [x] Quality picker — dropdown populated from `allStreams[]`, switches without losing position
- [x] Sub/dub toggle — switches stream, preserves playback position
- [x] Continue Watching enriched server-side with TMDB title + poster
- [x] HLS.js support + cleanup on close

### Phase 4 — Polish
- [x] Anime page — AniList via backend routes, category pills, 3-row default view, TMDB lookup for playback
- [x] Next episode auto-play panel
- [x] Continue Watching: refresh after playback closes

---

## Portainer Deploy (stack pull from git)

### Environment variables to set in Portainer UI
```
TMDB_API_KEY=<from V1 .env>
TMDB_ACCESS_TOKEN=<v4 JWT token>
REALDEBRID_API_KEY=<from real-debrid.com/apitoken>
```
Jackett API key is pre-seeded via `config/jackett/ServerConfig.json` — hardcoded in compose, no manual step.

### Deploy order (automatic via depends_on + healthchecks)
1. Jackett starts → healthcheck passes when API key endpoint responds
2. Jackettio starts → waits for Jackett healthy
3. HeartStream starts → waits for Jackettio healthy

### After first deploy
- Visit `http://your-server:9117` — add indexers: The Pirate Bay, YTS, EZTV, TheRARBG
- No stack restart needed — Jackett picks up new indexers live

### HeartStream image
- Built by GitHub Actions on every push to `main` that touches `heartstreamV2/`
- Pushed to `ghcr.io/therealbotbender/heartstream:latest` (and `sha-{commit}` for rollback)
- Portainer pulls the pre-built image — no build on the server
- Make GHCR package public: github.com → Packages → heartstream → Package settings → Make public
- Workflow: `.github/workflows/docker-publish.yml`

### When pushing to original HeartStream repo (pre-push checklist)
- [ ] Update `ghcr.io/therealbotbender/heartstream` → `ghcr.io/{actual-owner}/{actual-repo}` in docker-compose.yml and docker-publish.yml
- [ ] Move `.github/` folder to repo root (not inside heartstreamV2/)
- [ ] Update workflow `paths:` filter to match new repo structure
- [ ] Make GHCR package public after first Actions run
- [ ] Set Portainer stack to pull from the correct git repo URL

---

## Key Decisions / Constraints
- No ad blocker needed for primary path (native player, direct URL)
- Keep VidKing iframe as fallback — don't remove it
    Vidking will need the addblocks- will most likely need removed to prevent popups
- AIOStreams URL format: `http://aiostreams:3001` inside Docker, `http://localhost:3001` for dev
- TMDB IDs are the canonical content identifier throughout
- SQLite DB path: `/data/heartstream.db` (Docker volume)
- Real-Debrid API key goes in `.env` as `REAL_DEBRID_API_KEY` — passed to AIOStreams via env
