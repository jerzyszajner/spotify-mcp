# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # tsc + chmod 755 build/index.js
npm run lint       # biome check . --write (formats and lints in place)
npm run auth       # tsc + runs auth flow to obtain/refresh tokens
```

There are no tests. Node ≥ 24 is required (ESM project); use `.nvmrc` with `nvm use` if you use nvm.

## Authentication setup

Before the server can make Spotify API calls, `spotify-config.json` must exist at the repo root with at least `clientId` and `redirectUri` (must be a localhost URI). Running `npm run auth` opens a browser, completes the PKCE OAuth flow, and writes `accessToken`, `refreshToken`, `accessTokenExpiresAt`, and `scope` into that file. The file is gitignored.

## Architecture

This is an MCP (Model Context Protocol) server that exposes Spotify controls as tools over stdio transport. The entry point is `src/index.ts`, which registers all tools and connects the `StdioServerTransport`.

### Tool pattern

Every tool is a typed object conforming to `tool<ZodRawShape>` from `src/types.ts`:

```ts
{
  name: string;
  description: string;
  schema: ZodRawShape;           // becomes inputSchema for MCP
  handler: (args, extra) => { content: [{ type: 'text', text: string, isError?: boolean }] };
}
```

Tools are grouped into three arrays exported from their respective modules and spread into a single registration loop in `index.ts`:
- `readTools` (`src/read.ts`) — search, now playing, playlists, recently played, followed artists, top items
- `playTools` (`src/player.ts`) — playMusic, playbackAction (pause/resume/skip)
- `writeTools` (`src/write.ts`) — addToQueue, createPlaylist, addTracksToPlaylist, removeTracksFromPlaylist, addFavoriteTracks, removeFavoriteTracks

### API call wrapper

All Spotify API calls must go through `handleSpotifyRequest(action)` in `src/utils.ts`. It:
1. Proactively refreshes the token if it expires within 60 s
2. On 401, refreshes once and retries
3. Handles JSON parse errors from Spotify's occasionally non-JSON 2xx responses

`createSpotifyApi()` returns a cached `SpotifyApi` instance (invalidated when the token on disk changes). `clearSpotifyApiCache()` is called at server startup.

### Spotify SDK quirks

- A custom `spotifyLenientDeserializer` is installed on the `SpotifyApi` instance to silently return `null` on 204 or other empty-body success responses, because the SDK's default deserializer throws on non-JSON bodies.
- `spotifyApi.makeRequest()` is used directly for some endpoints (e.g. `playlists/{id}/items`) where the typed SDK methods have mismatched type constraints (e.g. `MaxInt<50>` limit vs the actual API maximum of 100).
- Playlist item operations chunk at 100 URIs per request; Liked Songs (library) operations chunk at 40 URIs.
- `getPlaylistTracks` falls back through two SDK call paths when the first returns 403 or 404, and surfaces a detailed human-readable message for 403 (owned-playlist restriction).

### Error detection

`errorIndicatesHttpStatus(error, status)` checks both `error.status` and the JSON body embedded in the error message, because the SDK throws plain `Error` objects whose message contains the Spotify JSON (e.g. `"status" : 403`).
