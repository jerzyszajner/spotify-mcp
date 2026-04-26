<div align="center">
  <div style="display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 10px;">
    <img src="https://upload.wikimedia.org/wikipedia/commons/8/84/Spotify_icon.svg" width="30" height="30" style="vertical-align:middle; margin-right:8px;">
    <picture style="vertical-align:middle;">
      <source srcset="https://mintlify.s3.us-west-1.amazonaws.com/mcp/logo/dark.svg" media="(prefers-color-scheme: dark)">
      <img src="https://mintlify.s3.us-west-1.amazonaws.com/mcp/logo/light.svg" width="auto" height="30" alt="MCP Logo">
    </picture>
</div>
<h1>Spotify MCP Node Server</h1>
</div>

<p align="center"><em>Maintained fork of <a href="https://github.com/igorgarbuz/spotify-mcp">igorgarbuz/spotify-mcp</a> (Igor Garbuz).</em></p>

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) Node server that enables AI assistants like [Claude Desktop](https://claude.ai/download), or IDEs like [Cursor](https://cursor.sh) and [Windsurf](https://windsurf.io) to control Spotify playback and manage playlists. Great for music discovery and creative playlist curation. Try asking Claude for some less-known tracks in a genre or similar to an artist. You can start by asking to create a new playlist or update an existing playlist.

For an easiest quickstart, as of May 2025 the [Claude Desktop](https://claude.ai/download) is the recommended way to use this software. Install Claude Desktop for your platform and follow the [integration guide](#integrating-with-ai-assistants) below.

To comply with Spotify’s Developer Terms, you must have a Spotify Premium account to use this server. Additionally, if you’re using MCP-enabled AI assistants (such as Claude) with this server, you must opt out of data sharing for model training.

<details>
<summary>Contents</summary>

- [Example Interactions](#example-interactions)
- [Tools](#tools)
  - [Read Operations](#read-operations)
  - [Play / Create Operations](#play--create-operations)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [MCP Server Installation](#mcp-server-installation)
  - [Creating a Spotify Developer Application](#creating-a-spotify-developer-application)
  - [Spotify API Configuration](#spotify-api-configuration)
  - [Authentication Process](#authentication-process)
- [Integrating with AI assistants](#integrating-with-ai-assistants)
- [Credits](#credits)
</details>

## Example Interactions

- _"Play The Beatles less known bootlegs"_
- _"Make a fusion playlist of The Beatles and Metallica"_
- _"List my top tracks for the last month and add three of them to a new playlist"_
- _"Create my marathon playlist and add tracks from my workout playlists"_
- _"Add the song that’s playing to my Liked Songs"_

## Tools

<details>
<summary>Read Operations</summary>

1. **searchSpotify**
   - **Description**: Search for tracks, albums, or playlists on Spotify (search query can still include artist/field filters in `query` per Spotify’s search syntax).
   - **Parameters**:
     - `query` (string): The search string (see tool description in code for field filters, e.g. `artist:`, `year:`, `tag:hipster`).
     - `type` (string): `track` | `album` | `playlist` (required).
     - `limit` (number, optional): Maximum number of results (1–50).
     - `offset` (number, optional): Pagination index (0–1000).
   - **Returns**: A formatted list of results with IDs.
   - **Example**: `searchSpotify({ query: "bohemian rhapsody", type: "track", limit: 20 })`

2. **getNowPlaying**
   - **Description**: Get information about the currently playing track on Spotify
   - **Parameters**: None
   - **Returns**: Plain text (and lightweight Markdown) with track, artist, album, progress, duration, and id — not a JSON object.
   - **Example**: `getNowPlaying()`

3. **getUserPlaylists**
   - **Description**: List the current user’s playlists (names, IDs, best-effort track counts).
   - **Parameters**:
     - `limit` (number, optional): Maximum number of playlists to return (1–50, default 50).
   - **Returns**: Formatted text; use `getPlaylistTracks(playlistId)` to list songs in a specific playlist.
   - **Example**: `getUserPlaylists({ limit: 20 })`

4. **getPlaylistTracks**
   - **Description**: List tracks in a playlist (for playlists you own or collaborate on; other playlists may return 403 from Spotify’s API).
   - **Parameters**:
     - `playlistId` (string): The Spotify ID of the playlist
     - `limit` (number, optional): Page size 1–100 (default 100; repeat with `offset` for long lists; Spotify’s API max is 100 per request).
     - `offset` (number, optional): First track index to return.
   - **Returns**: A formatted list of track titles, artists, and IDs
   - **Example**: `getPlaylistTracks({ playlistId: "37i9dQZEVXcJZyENOWUFo7", limit: 100, offset: 0 })`

5. **getRecentlyPlayed**
   - **Description**: Retrieves a list of recently played tracks from Spotify.
   - **Parameters**:
     - `limit` (number, optional): Maximum number of tracks to return (1–50).
   - **Returns**: If tracks are found it returns a formatted list of recently played tracks else a message stating: "You don't have any recently played tracks on Spotify".
   - **Example**: `getRecentlyPlayed({ limit: 10 })`

6. **getFollowedArtists**
   - **Description**: Retrieves a list of artists the user is following on Spotify.
   - **Parameters**:
     - `after` (string, optional): The last artist ID from the previous request. Cursor for pagination.
     - `limit` (number, optional): Maximum number of artists to return (1-50).
   - **Returns**: If artists are found it returns a formatted list of followed artists else a message stating: "You don't follow any artists on Spotify".
   - **Example**: `getFollowedArtists({ limit: 10 })`

7. **getUserTopItems**
   - **Description**: Retrieves a list of the user's top artists or tracks.
   - **Parameters**:
     - `type` (string): `artists` or `tracks` (validated).
     - `time_range` (string): `short_term`, `medium_term`, or `long_term` (validated).
     - `limit` (number, optional): Maximum number of items to return (1-50).
     - `offset` (number, optional): Index of the first item to return. Defaults to 0.
   - **Returns**: If items are found it returns a formatted list of top items else a message stating: "You don't have any top items on Spotify".
   - **Example**: `getUserTopItems({ type: "artists", time_range: "short_term", limit: 10 })`

8. **getLikedSongs**
   - **Description**: Get tracks saved in the current user's Liked Songs library.
   - **Parameters**:
     - `limit` (number, optional): Maximum number of tracks to return (1–50, default 50).
     - `offset` (number, optional): Index of the first item to return. Defaults to 0.
   - **Returns**: A formatted list of saved tracks with artists, duration, date added, and IDs.
   - **Example**: `getLikedSongs({ limit: 20, offset: 0 })`

</details>

<details>
<summary>Play / Create Operations</summary>

1. **playMusic**
   - **Description**: Start or resume playing a track, album, artist, or playlist.
   - **Parameters**:
     - `uri` (string, optional): Full Spotify URI. The server infers the item type from `spotify:track:...`, `spotify:album:...`, `spotify:artist:...`, or `spotify:playlist:...`.
     - `type` (string, optional): `track` | `album` | `artist` | `playlist` (use with `id`, unless you pass `uri`)
     - `id` (string, optional): Spotify item ID
     - `deviceId` (string, optional): Target device
   - **Example**: `playMusic({ uri: "spotify:track:6rqhFgbbKwnb9MLmUQDhG6" })` or `playMusic({ type: "track", id: "6rqhFgbbKwnb9MLmUQDhG6" })`

2. **playbackAction**
   - **Description**: All basic transport controls in one tool (replaces separate pause / skip tools).
   - **Parameters**:
     - `action` (string): `pause` | `resume` | `skipToNext` | `skipToPrevious`
     - `deviceId` (string, optional): ID of the device
   - **Example**: `playbackAction({ action: "pause" })` · `playbackAction({ action: "skipToNext" })`

3. **addToQueue**
   - **Description**: Add a track to the current playback queue.
   - **Parameters**:
     - `uri` (string, optional): Full Spotify track URI (overrides `type` and `id` when present)
     - `type` (string, optional): `track`
     - `id` (string, optional): Spotify track ID
     - `deviceId` (string, optional): ID of the device
   - **Example**: `addToQueue({ uri: "spotify:track:6rqhFgbbKwnb9MLmUQDhG6" })` or `addToQueue({ type: "track", id: "6rqhFgbbKwnb9MLmUQDhG6" })`

4. **createPlaylist**
   - **Description**: Create a new playlist in your library.
   - **Parameters**:
     - `name` (string): Name for the new playlist
     - `description` (string, optional): Description
     - `public` (boolean, optional): Public visibility (default: false)
   - **Example**: `createPlaylist({ name: "Workout Mix", description: "Songs to get pumped up", public: false })`

5. **addTracksToPlaylist**
   - **Description**: Add one or more tracks to an existing playlist. IDs are **bare Spotify track IDs** (the tool prepends `spotify:track:` for the API). Requests are sent to Spotify in chunks of up to 100 tracks.
   - **Parameters**:
     - `playlistId` (string): The playlist’s Spotify ID
     - `trackIds` (array of strings): Track IDs (not full URIs)
     - `position` (number, optional): 0-based insert index for the first added chunk
   - **Example**: `addTracksToPlaylist({ playlistId: "3cEYpjA9oz9GiPac4AsH4n", trackIds: ["4iV5W9uYEdYUVa79Axb7Rh", "2igwFfvr1OAlXZMnPIcxHR"] })`

6. **removeTracksFromPlaylist**
   - **Description**: Remove one or more tracks from a playlist you can edit (by track ID).
   - **Parameters**:
     - `playlistId` (string)
     - `trackIds` (array of strings)
   - **Example**: `removeTracksFromPlaylist({ playlistId: "3cEYpjA9oz9GiPac4AsH4n", trackIds: ["4iV5W9uYEdYUVa79Axb7Rh"] })`

7. **addFavoriteTracks**
   - **Description**: Save tracks to your **Liked Songs** (library). The server calls Spotify’s current [`PUT /v1/me/library`](https://developer.spotify.com/documentation/web-api/reference/save-library-items) endpoint (the legacy `PUT /v1/me/tracks` API is deprecated and often returns 403).
   - **OAuth**: `user-library-modify`. The server also requests `user-library-read` for library-related compatibility. If you upgraded from an older fork, run `npm run auth` again so the token includes the full scope set.
   - **Parameters**:
     - `trackIds` (array of strings): bare Spotify track IDs (up to **40** per HTTP request; longer lists are chunked automatically).
   - **Example**: `addFavoriteTracks({ trackIds: ["6rqhFgbbKwnb9MLmUQDhG6"] })`

8. **removeFavoriteTracks**
   - **Description**: Remove tracks from **Liked Songs**. Uses [`DELETE /v1/me/library`](https://developer.spotify.com/documentation/web-api/reference/remove-library-items) with `spotify:track:{id}` URIs (same 40-ID chunking as add).
   - **OAuth**: same as `addFavoriteTracks`.
   - **Parameters**:
     - `trackIds` (array of strings)
   - **Example**: `removeFavoriteTracks({ trackIds: ["6rqhFgbbKwnb9MLmUQDhG6"] })`

</details>

## Setup

### Prerequisites

- Installed [Node.js](https://nodejs.org/) 24 or newer (see `engines` in `package.json`). If you use [nvm](https://github.com/nvm-sh/nvm), run `nvm use` in the repo root to match [`.nvmrc`](.nvmrc).
- A Spotify Premium account
- A registered [Spotify Developer application](https://developer.spotify.com/dashboard/)

### MCP Server Installation

```bash
git clone https://github.com/jerzyszajner/spotify-mcp.git
cd spotify-mcp
nvm use   # optional, if you use nvm: align with .nvmrc
npm install
npm run build
```

### Node.js Installation

1. Go to [Node.js download page](https://nodejs.org/en/download)
2. Download and install Node.js 24 or newer for your platform (LTS is fine)

### Creating a Spotify Developer Application

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
2. Log in with your Spotify account
3. Click the "Create an App" button
4. Fill in the app name and description
5. Accept the Terms of Service and click "Create"
6. In your new app's dashboard, you'll see your **Client ID**
7. Click "Edit Settings" and add a Redirect URI (e.g., `http://127.0.0.1:8888/callback`)
8. Save your changes

### Spotify API Configuration

Create a `spotify-config.json` file in the project root:

```bash
# Copy the example config file
cp spotify-config.example.json spotify-config.json
```

Then edit the file by adding your client id only. The `accessToken`, `refreshToken`, `accessTokenExpiresAt`, and `scope` fields will be managed automatically. The `redirectUri` should be the same as the one you added in the Spotify Developer Dashboard. `127.0.0.1` is the simplest option for the local MCP server.

```json
{
  "clientId": "you-must-add-your-client-id-here",
  "redirectUri": "http://127.0.0.1:8888/callback"
}
```

### Authentication Process

The Spotify API uses OAuth 2.0 with the [PKCE extension](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) for secure authentication. You do NOT need a client secret for this app.

1. Run the authentication script in the directory of the cloned repository:

```bash
npm run auth
```

2. The script will open your browser to the Spotify authorization page.

3. Log in to Spotify and authorize your application.

4. After authorization, Spotify will redirect you to your specified redirect URI. The app will automatically handle the code exchange and save your tokens.

5. The authentication script will automatically exchange this code for the access and refresh tokens.

6. These tokens will be saved to your `spotify-config.json` file.

```json
{
  "clientId": "your-client-id",
  "redirectUri": "http://127.0.0.1:8888/callback",
  "accessToken": "your-access-token-filled-automatically",
  "refreshToken": "your-refresh-token-filled-automatically",
  "accessTokenExpiresAt": 1760000000000,
  "scope": "approved OAuth scopes"
}
```

7. The server will automatically refresh the access token when needed, so you don't need to re-authenticate (unless the app’s [OAuth scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes) in the code change — in that case run `npm run auth` again to approve the new set).

## Integrating with AI assistants

### Claude Desktop

The easiest way to use the Spotify MCP server is with Claude Desktop. Start [Claude Desktop installation](https://claude.ai/download) and then locate the Claude configuration file, go to `Claude Settings`,click on `Developer` and then `Edit Config`. Add the following to the configuration with an absolute path to the server:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["/absolute/path/to/spotify-mcp/build/index.js"]
    }
  }
}
```

If Claude Desktop does not find `node` on `PATH`, use the full path to your Node binary (for example from `which node` or your nvm install), same as in `args` for the server script.

Optional `autoApprove` lists tool names that may run without confirmation; read-only examples use the real tool ids from this server, e.g. `getRecentlyPlayed` and `getNowPlaying` (not `getListeningHistory`).

### Cursor

For Cursor, go to the MCP tab in `Cursor Settings` (command + shift + J). Add a server with this command:

```bash
node absolute/path/to/spotify-mcp/build/index.js
```

### VsCode (via Cline)

To set up your MCP correctly with Cline ensure you have the following file configuration set `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["/absolute/path/to/spotify-mcp/build/index.js"],
      "autoApprove": ["getRecentlyPlayed", "getNowPlaying"]
    }
  }
}
```

You can add additional tools to the auto approval array to run the tools without intervention.

### Windsurf

In `Settings` then `Windsurf Settings` type `MCP` in the search bar. In the results MCP section click `add server` and then `add custom server`. Add the following configuration:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["absolute/path/to/spotify-mcp/build/index.js"]
    }
  }
}
```

You can add additional tools to the auto approval array to run the tools without intervention.

## Credits

This maintained fork is based on [igorgarbuz/spotify-mcp](https://github.com/igorgarbuz/spotify-mcp) by Igor Garbuz. That project was inspired by [spotify-mcp-server](https://github.com/marcelmarais/spotify-mcp-server) by Marcel Marais.

Main modifications in this fork:

1. Added Liked Songs tools (`addFavoriteTracks`, `removeFavoriteTracks`, `getLikedSongs`) using Spotify’s current library endpoints.
2. Improved OAuth handling, token refresh, and scope diagnostics for newer Spotify API behavior.
3. Fixed playback and queue handling for Spotify track URIs and supported queue item types.
4. Improved playlist support with 100-item pages, chunked edits, and clearer 403 guidance.
