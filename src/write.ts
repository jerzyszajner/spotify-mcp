import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import {
  errorIndicatesHttpStatus,
  formatToolActionFailure,
  handleSpotifyRequest,
  resolveDeviceIdForPlayback,
} from './utils.js';
import { z } from 'zod';
import type { SpotifyHandlerExtra, tool } from './types.js';

const PLAYLIST_ITEMS_CHUNK = 100;
/** Spotify Web API: max 40 track URIs per `PUT`/`DELETE` `me/library` (comma-separated `uris`). */
const LIBRARY_TRACK_URIS_CHUNK = 40;

function libraryUrisQueryParam(trackIds: string[]): string {
  const uris = trackIds
    .map((id) => encodeURIComponent(`spotify:track:${id}`))
    .join(',');
  return `uris=${uris}`;
}

const NO_TRACK_IDS = 'No track IDs in request.';

function readPlaylistIdFromCreateResult(result: unknown): string | undefined {
  if (
    result &&
    typeof result === 'object' &&
    'id' in result &&
    typeof (result as { id: unknown }).id === 'string' &&
    (result as { id: string }).id.length > 0
  ) {
    return (result as { id: string }).id;
  }
  return undefined;
}

/** Spotify Web API: `POST /v1/me/playlists` (current user). */
async function createPlaylistForCurrentUser(
  spotifyApi: SpotifyApi,
  name: string,
  description: string | undefined,
  isPublic: boolean,
): Promise<unknown> {
  const body: { name: string; public: boolean; description?: string } = {
    name,
    public: isPublic,
  };
  if (description !== undefined) {
    body.description = description;
  }
  return await spotifyApi.makeRequest<unknown>('POST', 'me/playlists', body);
}

/** Chunks add requests; `makeRequest` first, then SDK on 403 (workaround for edge cases). */
async function addTrackUrisToPlaylistInChunks(
  spotifyApi: SpotifyApi,
  playlistId: string,
  trackUris: string[],
  position: number | undefined,
): Promise<void> {
  for (let i = 0; i < trackUris.length; i += PLAYLIST_ITEMS_CHUNK) {
    const chunk = trackUris.slice(i, i + PLAYLIST_ITEMS_CHUNK);
    const body: { uris: string[]; position?: number } = { uris: chunk };
    if (position !== undefined && i === 0) {
      body.position = position;
    }
    try {
      await spotifyApi.makeRequest(
        'POST',
        `playlists/${playlistId}/items`,
        body,
      );
    } catch (e: unknown) {
      if (!errorIndicatesHttpStatus(e, 403)) throw e;
      await spotifyApi.playlists.addItemsToPlaylist(
        playlistId,
        chunk,
        position !== undefined && i === 0 ? position : undefined,
      );
    }
  }
}

/** Chunks remove requests; same pattern as add. */
async function removeTrackItemsFromPlaylistInChunks(
  spotifyApi: SpotifyApi,
  playlistId: string,
  items: { uri: string }[],
): Promise<void> {
  for (let i = 0; i < items.length; i += PLAYLIST_ITEMS_CHUNK) {
    const chunk = items.slice(i, i + PLAYLIST_ITEMS_CHUNK);
    try {
      await spotifyApi.makeRequest('DELETE', `playlists/${playlistId}/items`, {
        items: chunk,
      });
    } catch (e: unknown) {
      if (!errorIndicatesHttpStatus(e, 403)) throw e;
      await spotifyApi.playlists.removeItemsFromPlaylist(playlistId, {
        tracks: chunk,
      });
    }
  }
}

/** Spotify Web API: `PUT /v1/me/library?uris=` — Liked Songs (`user-library-modify`); replaces deprecated `PUT me/tracks`. */
async function saveTracksToLibraryInChunks(
  spotifyApi: SpotifyApi,
  trackIds: string[],
): Promise<void> {
  for (let i = 0; i < trackIds.length; i += LIBRARY_TRACK_URIS_CHUNK) {
    const chunk = trackIds.slice(i, i + LIBRARY_TRACK_URIS_CHUNK);
    const q = libraryUrisQueryParam(chunk);
    await spotifyApi.makeRequest('PUT', `me/library?${q}`, undefined);
  }
}

/** Spotify Web API: `DELETE /v1/me/library?uris=` (replaces deprecated `DELETE me/tracks`). */
async function removeSavedTracksFromLibraryInChunks(
  spotifyApi: SpotifyApi,
  trackIds: string[],
): Promise<void> {
  for (let i = 0; i < trackIds.length; i += LIBRARY_TRACK_URIS_CHUNK) {
    const chunk = trackIds.slice(i, i + LIBRARY_TRACK_URIS_CHUNK);
    const q = libraryUrisQueryParam(chunk);
    await spotifyApi.makeRequest('DELETE', `me/library?${q}`, undefined);
  }
}

const createPlaylist: tool<{
  name: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  public: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'createPlaylist',
  description: 'Create a new playlist on Spotify',
  schema: {
    name: z.string().describe('The name of the playlist'),
    description: z
      .string()
      .optional()
      .describe('The description of the playlist'),
    public: z
      .boolean()
      .optional()
      .describe('Whether the playlist should be public'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { name, description, public: isPublic = false } = args;

    try {
      const result = await handleSpotifyRequest(async (spotifyApi) => {
        return await createPlaylistForCurrentUser(
          spotifyApi,
          name,
          description,
          isPublic,
        );
      });

      const id = readPlaylistIdFromCreateResult(result);
      if (!id) {
        return {
          content: [
            {
              type: 'text',
              text: 'create failed: missing playlist id in API response',
              isError: true,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Created "${name}" · id ${id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatToolActionFailure('create', error),
            isError: true,
          },
        ],
      };
    }
  },
};

const addTracksToPlaylist: tool<{
  playlistId: z.ZodString;
  trackIds: z.ZodArray<z.ZodString>;
  position: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'addTracksToPlaylist',
  description: 'Add tracks to a Spotify playlist',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    trackIds: z.array(z.string()).describe('Array of Spotify track IDs to add'),
    position: z
      .number()
      .nonnegative()
      .optional()
      .describe('Position to insert the tracks (0-based index)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, trackIds, position } = args;

    if (trackIds.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: NO_TRACK_IDS,
            isError: true,
          },
        ],
      };
    }

    try {
      const trackUris = trackIds.map((id) => `spotify:track:${id}`);

      await handleSpotifyRequest(async (spotifyApi) => {
        await addTrackUrisToPlaylistInChunks(
          spotifyApi,
          playlistId,
          trackUris,
          position,
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `+${trackIds.length} to playlist ${playlistId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatToolActionFailure('add', error),
            isError: true,
          },
        ],
      };
    }
  },
};

const addToQueue: tool<{
  uri: z.ZodOptional<z.ZodString>;
  type: z.ZodOptional<z.ZodLiteral<'track'>>;
  id: z.ZodOptional<z.ZodString>;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'addToQueue',
  description: 'Adds a track to the playback queue',
  schema: {
    uri: z
      .string()
      .optional()
      .describe('The Spotify track URI to queue (overrides type and id)'),
    type: z.literal('track').optional().describe('The type of item to queue'),
    id: z.string().optional().describe('The Spotify track ID to queue'),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to add the track to'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { uri, type, id, deviceId } = args;

    let spotifyUri = uri;
    if (!spotifyUri && type && id) {
      spotifyUri = `spotify:${type}:${id}`;
    }

    if (!spotifyUri) {
      return {
        content: [
          {
            type: 'text',
            text: 'queue needs uri or (type and id).',
            isError: true,
          },
        ],
      };
    }

    if (!/^spotify:track:[^:]+$/.test(spotifyUri)) {
      return {
        content: [
          {
            type: 'text',
            text: 'queue only supports Spotify track URIs.',
            isError: true,
          },
        ],
      };
    }

    try {
      await handleSpotifyRequest(async (spotifyApi) => {
        const device = await resolveDeviceIdForPlayback(
          spotifyApi,
          deviceId || undefined,
        );
        await spotifyApi.player.addItemToPlaybackQueue(
          spotifyUri,
          device || undefined,
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `queued ${spotifyUri}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatToolActionFailure('queue', error),
            isError: true,
          },
        ],
      };
    }
  },
};

const removeTracksFromPlaylist: tool<{
  playlistId: z.ZodString;
  trackIds: z.ZodArray<z.ZodString>;
}> = {
  name: 'removeTracksFromPlaylist',
  description: 'Remove tracks from a Spotify playlist',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    trackIds: z
      .array(z.string())
      .describe('Array of Spotify track IDs to remove'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, trackIds } = args;

    if (trackIds.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: NO_TRACK_IDS,
            isError: true,
          },
        ],
      };
    }

    try {
      const items = trackIds.map((id) => ({
        uri: `spotify:track:${id}`,
      }));

      await handleSpotifyRequest(async (spotifyApi) => {
        await removeTrackItemsFromPlaylistInChunks(
          spotifyApi,
          playlistId,
          items,
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `removed ${trackIds.length} from ${playlistId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatToolActionFailure('remove', error),
            isError: true,
          },
        ],
      };
    }
  },
};

const addFavoriteTracks: tool<{
  trackIds: z.ZodArray<z.ZodString>;
}> = {
  name: 'addFavoriteTracks',
  description:
    'Save tracks to your Spotify library (Liked Songs). Requires OAuth scope user-library-modify; re-authenticate after upgrading.',
  schema: {
    trackIds: z
      .array(z.string())
      .min(1)
      .max(500)
      .describe(
        'Spotify track IDs (max 40 per API request; larger lists are chunked automatically)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { trackIds } = args;

    try {
      await handleSpotifyRequest(async (spotifyApi) => {
        await saveTracksToLibraryInChunks(spotifyApi, trackIds);
      });
      return {
        content: [
          {
            type: 'text',
            text: `Saved ${trackIds.length} track(s) to your library (Liked Songs).`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatToolActionFailure('save library tracks', error),
            isError: true,
          },
        ],
      };
    }
  },
};

const removeFavoriteTracks: tool<{
  trackIds: z.ZodArray<z.ZodString>;
}> = {
  name: 'removeFavoriteTracks',
  description:
    'Remove tracks from your Spotify library (Liked Songs). Requires OAuth scope user-library-modify.',
  schema: {
    trackIds: z
      .array(z.string())
      .min(1)
      .max(500)
      .describe(
        'Spotify track IDs to remove from saved tracks (max 40 per API request; chunked automatically)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { trackIds } = args;

    try {
      await handleSpotifyRequest(async (spotifyApi) => {
        await removeSavedTracksFromLibraryInChunks(spotifyApi, trackIds);
      });
      return {
        content: [
          {
            type: 'text',
            text: `Removed ${trackIds.length} track(s) from your library (Liked Songs).`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatToolActionFailure('remove library tracks', error),
            isError: true,
          },
        ],
      };
    }
  },
};

export const writeTools = [
  addToQueue,
  addTracksToPlaylist,
  addFavoriteTracks,
  createPlaylist,
  removeFavoriteTracks,
  removeTracksFromPlaylist,
];
