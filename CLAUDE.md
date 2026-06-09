# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Single-file HTML application (`index.html`) — a personal Steam game library showcase. No build tools, no dependencies, no server. Open the file directly in a browser to use.

## How to preview

```bash
start index.html          # Windows: open in default browser
# or
python3 -m http.server 8080  # serve on localhost:8080
```

## Architecture

Everything lives in `index.html`: CSS variables for theming (dark Steam-like palette), vanilla JS for logic, no frameworks.

### Data layer

- **Storage**: `localStorage` key `steam_game_library_v2`
- **Game object shape**:
  ```js
  { id: string, name: string, appId: string, genre: string,
    rating: number (0-5), review: string, addedAt: timestamp }
  ```
- `id` for manually-added games: `Date.now().toString(36) + random`
- `id` for Steam-imported games: `"steam_" + appId`
- Deduplication at import time checks both `id` and `appId`

### Key JS modules (all in `<script>` at bottom of index.html)

| Section | Functions | Purpose |
|---------|-----------|---------|
| DATA | `loadGames()`, `saveGames()` | localStorage read/write |
| COVER URL | `getCoverUrl()`, `getCoverFallback()`, `extractAppId()` | Steam CDN cover images, App ID extraction from store URLs |
| VDF PARSER | `parseVDF()`, `handleVdfFile()`, `startVdfNameResolver()`, `resolveGameName()` | Parse Valve KeyValues format to extract App IDs, background name resolution via CORS proxies |
| RENDER | `render()` | Full re-render: stats bar, genre filter, game grid cards, empty states |
| GAME MODAL | `openGameModal()`, `saveGame()`, `deleteGame()` | Add/edit/delete single game |
| STEAM SEARCH | `onCoverInput()`, `searchSteam()`, `selectSearchResult()` | Auto-extract App ID from pasted URL, debounced search via `steamcommunity.com/actions/SearchApps` |
| API SYNC | `syncFromAPI()`, `apiManualImport()` | Steam Web API `GetOwnedGames` with CORS proxy fallback chain |
| EXPORT/IMPORT | `exportData()`, `importData()` | JSON file export/download and import with dedup |

### External endpoints used

| Endpoint | CORS? | Usage |
|----------|-------|-------|
| `cdn.cloudflare.steamstatic.com/steam/apps/{id}/header.jpg` | N/A (image) | Primary cover image |
| `shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{id}/header.jpg` | N/A (image) | Fallback cover |
| `steamcommunity.com/actions/SearchApps/{query}` | Yes | Game name search in cover input |
| `store.steampowered.com/api/appdetails?appids={id}` | No | Name resolution (via CORS proxies) |
| `api.steampowered.com/IPlayerService/GetOwnedGames/v1/` | No | Steam library sync (via CORS proxies) |

CORS proxies tried in order: `corsproxy.io`, `api.allorigins.win`, `cors-anywhere-rose.vercel.app`. All may fail in China without VPN.

## VDF import (Steam local files)

The recommended import path. User selects `localconfig.vdf` or `sharedconfig.vdf` from their Steam install (`Steam/userdata/<id>/config/`). The parser uses regex patterns (`/"(\d{3,7})"\s*\{/g`) to find Steam App IDs, then imports them as placeholder entries. Cover images load immediately from CDN. Names are resolved asynchronously in the background via the store API with rate limiting (5 at a time, 500ms delay between batches).

## Git

- **Remote**: `git@github.com:Fried-Piggy/Steam-.git` (SSH)
- **Branch**: `master` → `origin/main`
- **User**: Fried-Piggy (piggy809192079@gmail.com)
- Push: `git add -A && git commit -m "..." && git push`
- HTTPS to GitHub is blocked; SSH on port 22 works
