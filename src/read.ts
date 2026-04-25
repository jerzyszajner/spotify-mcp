import type { MaxInt } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import type { SpotifyHandlerExtra, SpotifyTrack, tool } from './types.js';
import {
  errorIndicatesHttpStatus,
  formatDuration,
  getSavedOAuthScopes,
  handleSpotifyRequest,
} from './utils.js';

/** GET /playlists/{id}/items may use `item` instead of `track` per Spotify field renames. */
type PlaylistItemRow = { track?: unknown; item?: unknown };

function playlistRowsForDisplay(data: { items?: PlaylistItemRow[] }) {
  return (data.items ?? []).map((row) => ({
    track: row.track ?? row.item,
  }));
}

/**
 * GET /me/playlists returns simplified playlists. Spotify historically put
 * track count on `tracks.total`; newer responses may use `items.total` (field
 * rename). When both are missing, do not show 0 — that misleads models.
 */
function trackTotalFromPlaylistListItem(playlist: {
  tracks?: { total?: number } | null;
  items?: { total?: number } | null;
}): number | undefined {
  const fromTracks = playlist.tracks?.total;
  if (typeof fromTracks === 'number') return fromTracks;
  const fromItems = playlist.items?.total;
  if (typeof fromItems === 'number') return fromItems;
  return undefined;
}

function playlistTracksForbiddenHelp(): string {
  const scopes = getSavedOAuthScopes();
  const scopeLine = scopes
    ? `Last saved token scopes: ${scopes}`
    : 'No scopes string in spotify-config.json yet — run `npm run auth` once to store them.';
  return [
    'Spotify returned 403 Forbidden when reading playlist tracks.',
    '',
    'Most often this is not a missing OAuth scope. Spotify Web API only allows listing tracks for playlists you own or collaborate on. A playlist can appear in your library because you follow it, but if you are not the owner or a collaborator, third-party apps get 403 for track listing (GET /playlists/{id}/items). Reconnecting Spotify in Claude Settings → Connectors does not change that rule.',
    '',
    'What to try:',
    '• If the playlist is yours or you are a collaborator: run npm run auth in this repo, approve permissions, restart the MCP server, and retry.',
    '• If you only follow someone else’s playlist: open it in the Spotify app, or copy tracks into a playlist you own, then fetch that playlist’s ID.',
    '',
    scopeLine,
  ].join('\n');
}

function isTrack(item: any): item is SpotifyTrack {
  return (
    item &&
    item.type === 'track' &&
    Array.isArray(item.artists) &&
    item.album &&
    typeof item.album.name === 'string'
  );
}

const searchSpotify: tool<{
  query: z.ZodString;
  type: z.ZodEnum<['track', 'album', 'playlist']>;
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'searchSpotify',
  description:
    'Search Spotify by keyword and field filters (e.g. artist, track, playlist, tag:new, tag:hipster) and return items of the given type',
  schema: {
    query: z
      .string()
      .describe(
        [
          'Full Spotify search string combining:',
          '- free-text keywords (e.g. “remaster”),',
          '- field filters: artist:<name>, track:<name>, album:<name>,',
          '  year:<YYYY> or <YYYY-YYYY>, genre:<name>.',
          'The album, artist and year filters can be used for album and track types.',
          'The genre filter can only be used for track type.',
          'Special filter tag:hipster (bottom 10% popularity) can be used with track and album types.',
          'All separated by spaces. Example: "tag:hipster artist:Queen remaster".',
        ].join(' '),
      ),
    type: z
      .enum(['track', 'album', 'playlist'])
      .describe('Which item type to return: track, album or playlist'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Max number of results to return (1-50)'),
    offset: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe('The index of the first item to return. Defaults to 0'),
  },
  handler: async (args, extra: SpotifyHandlerExtra) => {
    const { query, type, limit = 20, offset = 0 } = args;

    try {
      const results = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.search(
          query,
          [type],
          undefined,
          limit as MaxInt<50>,
          offset,
        );
      });

      let formattedResults = '';

      if (type === 'track' && results.tracks) {
        formattedResults = results.tracks.items
          .map((track, i) => {
            const artists = track.artists.map((a) => a.name).join(', ');
            const duration = formatDuration(track.duration_ms);
            return `${i + 1}. "${
              track.name
            }" by ${artists} (${duration}) - ID: ${track.id}`;
          })
          .join('\n');
      } else if (type === 'album' && results.albums) {
        formattedResults = results.albums.items
          .map((album, i) => {
            const artists = album.artists.map((a) => a.name).join(', ');
            return `${i + 1}. "${album.name}" by ${artists} - ID: ${album.id}`;
          })
          .join('\n');
      } else if (type === 'playlist' && results.playlists) {
        formattedResults = results.playlists.items
          .map((playlist, i) => {
            return `${i + 1}. "${playlist?.name ?? 'Unknown Playlist'} (${
              playlist?.description ?? 'No description'
            } tracks)" by ${playlist?.owner?.display_name} - ID: ${
              playlist?.id
            }`;
          })
          .join('\n');
      }

      return {
        content: [
          {
            type: 'text',
            text:
              formattedResults.length > 0
                ? `# Search results for "${query}" (type: ${type})\n\n${formattedResults}`
                : `No ${type} results found for "${query}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching for ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getNowPlaying: tool<Record<string, never>> = {
  name: 'getNowPlaying',
  description: 'Get information about the currently playing track on Spotify',
  schema: {},
  handler: async (args, extra: SpotifyHandlerExtra) => {
    try {
      const currentTrack = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getCurrentlyPlayingTrack();
      });

      if (!currentTrack || !currentTrack.item) {
        return {
          content: [
            {
              type: 'text',
              text: 'Nothing is currently playing on Spotify',
            },
          ],
        };
      }

      const item = currentTrack.item;

      if (!isTrack(item)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Currently playing item is not a track (might be a podcast episode)',
            },
          ],
        };
      }

      const artists = item.artists.map((a) => a.name).join(', ');
      const album = item.album.name;
      const duration = formatDuration(item.duration_ms);
      const progress = formatDuration(currentTrack.progress_ms || 0);
      const isPlaying = currentTrack.is_playing;

      return {
        content: [
          {
            type: 'text',
            text:
              `# Currently ${isPlaying ? 'Playing' : 'Paused'}\n\n` +
              `**Track**: "${item.name}"\n` +
              `**Artist**: ${artists}\n` +
              `**Album**: ${album}\n` +
              `**Progress**: ${progress} / ${duration}\n` +
              `**ID**: ${item.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting current track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getUserPlaylists: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getUserPlaylists',
  description:
    "List the current user's playlists (names and IDs). Track counts in this summary may be omitted by Spotify; use getPlaylistTracks(playlistId) for the real track list.",
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of playlists to return (1-50)'),
  },
  handler: async (args, extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const playlists = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.playlists.playlists(
        limit as MaxInt<50>,
      );
    });

    if (playlists.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any playlists on Spotify",
          },
        ],
      };
    }

    const formattedPlaylists = playlists.items
      .map((playlist, i) => {
        const n = trackTotalFromPlaylistListItem(playlist);
        const countPart =
          n === undefined
            ? 'track count not provided here — use getPlaylistTracks with this ID'
            : `${n} track${n === 1 ? '' : 's'}`;
        return `${i + 1}. "${playlist.name}" (${countPart}) - ID: ${playlist.id}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Your Spotify Playlists\n\n${formattedPlaylists}\n\nNote: Spotify often omits or zeroes list metadata for this endpoint; non-zero counts are best-effort. To list songs, call getPlaylistTracks for each playlist ID.`,
        },
      ],
    };
  },
};

const getPlaylistTracks: tool<{
  playlistId: z.ZodString;
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getPlaylistTracks',
  description:
    'List tracks in a Spotify playlist. Only works for playlists the current user owns or collaborates on; followed-but-not-owned playlists may return 403 (Spotify Web API restriction, not a scope bug).',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Maximum number of tracks to return per page (1-100, Spotify API max)',
      ),
    offset: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe('The index of the first item to return. Defaults to 0'),
  },
  handler: async (args, extra: SpotifyHandlerExtra) => {
    const { playlistId, limit = 100, offset = 0 } = args;

    let playlistTracks: { items?: PlaylistItemRow[] };
    try {
      playlistTracks = await handleSpotifyRequest(async (spotifyApi) => {
        const qs = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        });
        try {
          return await spotifyApi.makeRequest<{ items?: PlaylistItemRow[] }>(
            'GET',
            `playlists/${playlistId}/items?${qs}`,
          );
        } catch (first: unknown) {
          const status =
            first && typeof first === 'object' && 'status' in first
              ? (first as { status?: number }).status
              : undefined;
          if (status === 404) {
            // `getPlaylistItems` limit is typed as MaxInt<50>; value may be up to 100 at runtime (API max).
            return await spotifyApi.playlists.getPlaylistItems(
              playlistId,
              undefined,
              undefined,
              limit as MaxInt<50>,
              offset,
            );
          }
          if (errorIndicatesHttpStatus(first, 403)) {
            try {
              return await spotifyApi.playlists.getPlaylistItems(
                playlistId,
                undefined,
                undefined,
                limit as MaxInt<50>,
                offset,
              );
            } catch {
              throw first;
            }
          }
          throw first;
        }
      });
    } catch (error: unknown) {
      if (errorIndicatesHttpStatus(error, 403)) {
        return {
          content: [
            {
              type: 'text',
              text: playlistTracksForbiddenHelp(),
            },
          ],
        };
      }
      throw error;
    }

    const rows = playlistRowsForDisplay(playlistTracks);

    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "This playlist doesn't have any tracks",
          },
        ],
      };
    }

    const formattedTracks = rows
      .map((item, i) => {
        const { track } = item;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Tracks in Playlist\n\n${formattedTracks}`,
        },
      ],
    };
  },
};

const getRecentlyPlayed: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getRecentlyPlayed',
  description: 'Get a list of recently played tracks on Spotify',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
  },
  handler: async (args, extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const history = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.player.getRecentlyPlayedTracks(
        limit as MaxInt<50>,
      );
    });

    if (history.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any recently played tracks on Spotify",
          },
        ],
      };
    }

    const formattedHistory = history.items
      .map((item, i) => {
        const track = item.track;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Recently Played Tracks\n\n${formattedHistory}`,
        },
      ],
    };
  },
};

const getFollowedArtists: tool<{
  after: z.ZodOptional<z.ZodString>;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getFollowedArtists',
  description: 'Get a list of artists the user is following on Spotify',
  schema: {
    after: z
      .string()
      .optional()
      .describe(
        'The last artist ID from the previous request. Cursor for pagination.',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of artists to return (1-50)'),
  },
  handler: async (args, extra: SpotifyHandlerExtra) => {
    const { limit = 50, after } = args;

    const artists = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.followedArtists(
        after,
        limit as MaxInt<50>,
      );
    });

    if (artists.artists.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "User doesn't follow any artists on Spotify",
          },
        ],
      };
    }

    const formattedArtists = artists.artists.items
      .map((artist, i) => {
        return `${i + 1}. "${artist.name}" - ID: ${artist.id}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Artists You Follow\n\n${formattedArtists}`,
        },
      ],
    };
  },
};

const getUserTopItems: tool<{
  type: z.ZodEnum<['artists', 'tracks']>;
  time_range: z.ZodEnum<['short_term', 'medium_term', 'long_term']>;
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getUserTopItems',
  description: "Get a list of the user's top artists or tracks",
  schema: {
    type: z
      .enum(['artists', 'tracks'])
      .describe('Whether to return top artists or top tracks'),
    time_range: z
      .enum(['short_term', 'medium_term', 'long_term'])
      .describe('Time window: last ~4 weeks, ~6 months, or several years'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of items to return (1-50)'),
    offset: z
      .number()
      .optional()
      .describe('The index of the first item to return. Defaults to 0'),
  },
  handler: async (args, extra: SpotifyHandlerExtra) => {
    const { type, time_range, limit = 50, offset = 0 } = args;

    const topItems = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.topItems(
        type,
        time_range,
        limit as MaxInt<50>,
        offset,
      );
    });

    if (topItems.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `User doesn't have any top ${type} on Spotify`,
          },
        ],
      };
    }

    const formattedItems = topItems.items
      .map((item, i) => {
        if (type === 'artists') {
          return `${i + 1}. "${item.name}" - ID: ${item.id}`;
        } else if (
          type === 'tracks' &&
          'artists' in item &&
          Array.isArray(item.artists)
        ) {
          const artists = item.artists.map((a) => a.name).join(', ');
          return `${i + 1}. "${item.name}" by ${artists} - ID: ${item.id}`;
        } else {
          // fallback for type safety
          return `${i + 1}. "${item.name}" - ID: ${item.id}`;
        }
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Top ${type}\n\n${formattedItems}`,
        },
      ],
    };
  },
};

/* ---------- export list ---------- */
export const readTools = [
  searchSpotify,
  getNowPlaying,
  getUserPlaylists,
  getPlaylistTracks,
  getRecentlyPlayed,
  getFollowedArtists,
  getUserTopItems,
];
