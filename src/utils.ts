import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { IResponseDeserializer } from '@spotify/web-api-ts-sdk';
import { loadSpotifyConfig, refreshAccessToken } from './config.js';
import type { SpotifyConfig } from './config.js';

let cachedSpotifyApi: SpotifyApi | null = null;
/** Access token string used to build `cachedSpotifyApi` (invalidates when disk config changes). */
let cachedAccessToken: string | undefined;

export function clearSpotifyApiCache(): void {
  cachedSpotifyApi = null;
  cachedAccessToken = undefined;
}

/** Subset of GET /me/player/devices item fields used for targeting playback. */
type SpotifyDeviceListItem = {
  id: string | null;
  is_active?: boolean;
  is_restricted?: boolean;
  type?: string;
};

function devicePlaybackPriority(device: SpotifyDeviceListItem): number {
  if (device.is_restricted) return -1;
  const t = (device.type ?? '').toLowerCase();
  if (t === 'computer') return 100;
  if (t === 'smartphone' || t === 'phone') return 50;
  if (t === 'speaker') return 40;
  return 10;
}

/**
 * Spotify Web API returns NO_ACTIVE_DEVICE when nothing is the current playback
 * target, even if Desktop is open. If no device is active, transfer playback to
 * the best available device (preferring Desktop / type "computer") so play and
 * queue calls can succeed.
 */
export async function resolveDeviceIdForPlayback(
  spotifyApi: SpotifyApi,
  explicitDeviceId?: string,
): Promise<string> {
  if (explicitDeviceId) {
    return explicitDeviceId;
  }

  const data = await spotifyApi.player.getAvailableDevices();
  const raw = (data as { devices?: SpotifyDeviceListItem[] | null })?.devices;
  const devices = (raw ?? []).filter(
    (d): d is SpotifyDeviceListItem & { id: string } => Boolean(d.id),
  );

  const active = devices.find((d) => d.is_active);
  if (active) {
    return active.id;
  }

  const sorted = [...devices].sort(
    (a, b) => devicePlaybackPriority(b) - devicePlaybackPriority(a),
  );
  const target = sorted[0];
  if (!target || devicePlaybackPriority(target) < 0) {
    return '';
  }

  await spotifyApi.player.transferPlayback([target.id], false);
  return target.id;
}

/**
 * Spotify player PUTs often succeed with 204 (handled in SDK) or occasionally
 * 2xx + non-JSON body; default deserializer then throws. Official API docs:
 * e.g. pause returns "204 — No content returned upon success."
 */
const spotifyLenientDeserializer: IResponseDeserializer = {
  async deserialize<TReturnType>(response: Response): Promise<TReturnType> {
    const text = await response.text();
    if (text.length === 0) {
      return null as TReturnType;
    }
    try {
      return JSON.parse(text) as TReturnType;
    } catch {
      if (response.ok) {
        return null as TReturnType;
      }
      throw new Error(
        `Spotify returned non-JSON body (HTTP ${response.status}): ${text.slice(0, 200)}`,
      );
    }
  },
};

function createSpotifyApi(): SpotifyApi {
  const config = loadSpotifyConfig();

  if (
    cachedSpotifyApi &&
    config.accessToken &&
    config.accessToken === cachedAccessToken
  ) {
    return cachedSpotifyApi;
  }

  clearSpotifyApiCache();

  if (config.accessToken && config.refreshToken) {
    const accessToken = {
      access_token: config.accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: config.refreshToken,
    };
    cachedSpotifyApi = SpotifyApi.withAccessToken(
      config.clientId,
      accessToken,
      { deserializer: spotifyLenientDeserializer },
    );
    cachedAccessToken = config.accessToken;
    return cachedSpotifyApi;
  }

  throw new Error('No access token available. Please authenticate first.');
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds.padStart(2, '0')}`;
}

/** One-line text for tool handlers (shared by write and player). */
export function formatToolActionFailure(action: string, err: unknown): string {
  return `${action} failed: ${
    err instanceof Error ? err.message : String(err)
  }`;
}

/**
 * `@spotify/web-api-ts-sdk` throws plain `Error` for HTTP errors; the JSON body
 * is only in the message (e.g. `"status" : 403`). Use this instead of `error.status`.
 */
export function errorIndicatesHttpStatus(
  error: unknown,
  status: number,
): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: unknown }).status === status
  ) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return new RegExp(`"status"\\s*:\\s*${status}`, 'i').test(msg);
}

export async function handleSpotifyRequest<T>(
  action: (spotifyApi: SpotifyApi) => Promise<T>,
): Promise<T> {
  let config: SpotifyConfig = loadSpotifyConfig();
  let spotifyApi: SpotifyApi;
  try {
    // If token is expired, refresh first
    if (
      config.accessTokenExpiresAt &&
      config.accessTokenExpiresAt - Date.now() < 60 * 1000
    ) {
      config = await refreshAccessToken(config);
    }
    spotifyApi = createSpotifyApi();
    return await action(spotifyApi);
  } catch (error: any) {
    // If 429, surface rate limit clearly (no retry)
    if (error?.status === 429 || /429|rate.?limit/i.test(error?.message)) {
      throw new Error(
        'Spotify rate limit hit (429). Wait a moment and try again.',
      );
    }
    // If 401, try refresh once
    if (error?.status === 401 || /401|unauthorized/i.test(error?.message)) {
      config = await refreshAccessToken(config);
      clearSpotifyApiCache();
      spotifyApi = createSpotifyApi();
      return await action(spotifyApi);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes('Unexpected token') ||
      errorMessage.includes('Unexpected non-whitespace character') ||
      errorMessage.includes('Exponent part is missing a number in JSON')
    ) {
      throw new Error(
        `Spotify response could not be parsed as JSON; the request may or may not have completed in the Spotify app. ${errorMessage}`,
        { cause: error },
      );
    }
    throw error;
  }
}
