import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { IResponseDeserializer } from '@spotify/web-api-ts-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '../spotify-config.json');

export interface SpotifyConfig {
  clientId: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number; // unix ms timestamp
  /** Space-separated scopes from the last token exchange or refresh (optional). */
  scope?: string;
}

function loadSpotifyConfig(): SpotifyConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `Spotify configuration file not found at ${CONFIG_FILE}. Please create one with clientId and redirectUri.`,
    );
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!config.clientId || !config.redirectUri) {
      throw new Error(
        'Spotify configuration must include clientId and redirectUri.',
      );
    }
    // If no expiresAt, treat as expired
    if (!config.accessTokenExpiresAt && config.accessToken) {
      config.accessTokenExpiresAt = Date.now() - 1000;
    }
    return config;
  } catch (error) {
    throw new Error(
      `Failed to parse Spotify configuration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function saveSpotifyConfig(config: SpotifyConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

let cachedSpotifyApi: SpotifyApi | null = null;
/** Access token string used to build `cachedSpotifyApi` (invalidates when disk config changes). */
let cachedAccessToken: string | undefined = undefined;

export function clearSpotifyApiCache(): void {
  cachedSpotifyApi = null;
  cachedAccessToken = undefined;
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
    // Check expiry (allow 1 min clock skew)
    if (
      config.accessTokenExpiresAt &&
      config.accessTokenExpiresAt - Date.now() < 60 * 1000
    ) {
      throw new Error(
        'Access token expired. Please refresh before creating API instance.',
      );
    }
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

function generateRandomString(length: number): string {
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], '');
}

/**
 * Generates a PKCE code verifier (43-128 chars, high entropy)
 */
function generateCodeVerifier(length = 128): string {
  // RFC 7636: code verifier must be between 43 and 128 chars
  return generateRandomString(length);
}

/**
 * Generates a PKCE code challenge (base64url-encoded SHA256 hash of verifier)
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  // Convert string to Uint8Array
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  // Use Web Crypto API for SHA256
  const digest = await crypto.subtle.digest('SHA-256', data);
  // Convert ArrayBuffer to base64url
  const base64 = Buffer.from(new Uint8Array(digest)).toString('base64');
  // base64url encode: replace +/ with -_, remove =
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function exchangeCodeForToken(
  code: string,
  config: SpotifyConfig,
  codeVerifier: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}> {
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', config.redirectUri);
  params.append('client_id', config.clientId);
  params.append('code_verifier', codeVerifier);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to exchange code for token: ${errorData}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in:
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : 3600,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  };
}

export async function authorizeSpotify(): Promise<void> {
  const config = loadSpotifyConfig();

  const redirectUri = new URL(config.redirectUri);
  if (
    redirectUri.hostname !== 'localhost' &&
    redirectUri.hostname !== '127.0.0.1'
  ) {
    console.error(
      'Error: Redirect URI must use localhost for automatic token exchange',
    );
    console.error(
      'Please update your spotify-config.json with a localhost redirect URI',
    );
    console.error('Example: http://127.0.0.1:8888/callback');
    process.exit(1);
  }

  const port = redirectUri.port || '80';
  const callbackPath = redirectUri.pathname || '/callback';

  const state = generateRandomString(16);

  // --- PKCE integration ---
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const scopes = [
    'playlist-modify-private',
    'playlist-modify-public',
    'playlist-read-collaborative',
    'playlist-read-private',
    'user-library-read',
    'user-library-modify',
    'user-follow-read',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-read-playback-state',
    'user-read-private',
    'user-read-recently-played',
    'user-top-read',
  ];

  const authParams = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: scopes.join(' '),
    state: state,
    show_dialog: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizationUrl = `https://accounts.spotify.com/authorize?${authParams.toString()}`;

  const authPromise = new Promise<void>((resolve, reject) => {
    // Create HTTP server to handle the callback
    const server = http.createServer(async (req, res) => {
      if (!req.url) {
        return res.end('No URL provided');
      }

      const reqUrl = new URL(req.url, `http://localhost:${port}`);

      if (reqUrl.pathname === callbackPath) {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error) {
          console.error(`Authorization error: ${error}`);
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (returnedState !== state) {
          console.error('State mismatch error');
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>State verification failed. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error('State mismatch'));
          return;
        }

        if (!code || typeof code !== 'string') {
          console.error('No authorization code received');
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>No authorization code received. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          // Exchange code for token (PKCE)
          const tokenData = await exchangeCodeForToken(
            code,
            config,
            codeVerifier,
          );
          config.accessToken = tokenData.access_token;
          config.refreshToken = tokenData.refresh_token;
          config.accessTokenExpiresAt =
            Date.now() + tokenData.expires_in * 1000;
          if (tokenData.scope) {
            config.scope = tokenData.scope;
          }
          saveSpotifyConfig(config);
          res.end(
            '<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the application.</p></body></html>',
          );
          console.log(
            'Authentication successful! Access and refresh tokens have been saved.',
          );
          server.close();
          resolve();
        } catch (tokenErr) {
          console.error(
            'Failed to exchange authorization code for tokens:',
            tokenErr,
          );
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>Failed to exchange authorization code for tokens. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(tokenErr);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(Number.parseInt(port), '127.0.0.1', () => {
      console.log(
        `Listening for Spotify authentication callback on port ${port}`,
      );
      console.log('Opening browser for authorization...');

      open(authorizationUrl).catch((error: Error) => {
        console.log(
          'Failed to open browser automatically. Please visit this URL to authorize:',
        );
        console.log(authorizationUrl);
      });
    });

    server.on('error', (error: any) => {
      console.error(`Server error: ${error.message}`);
      reject(error);
    });
  });

  await authPromise;
}

/**
 * Refresh the access token using the refresh token (PKCE flow)
 */
async function refreshAccessToken(
  config: SpotifyConfig,
): Promise<SpotifyConfig> {
  if (!config.refreshToken) throw new Error('No refresh token available');
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', config.refreshToken);
  params.append('client_id', config.clientId);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to refresh access token: ${errorData}`);
  }

  const data = await response.json();
  config.accessToken = data.access_token;
  // Spotify may or may not return a new refresh token
  if (data.refresh_token) config.refreshToken = data.refresh_token;
  if (typeof data.scope === 'string' && data.scope.length > 0) {
    config.scope = data.scope;
  }
  // Set new expiry (1 hour from now)
  config.accessTokenExpiresAt =
    Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
  saveSpotifyConfig(config);
  return config;
}

/** OAuth scopes last saved with the token (for diagnostics). */
export function getSavedOAuthScopes(): string | undefined {
  try {
    return loadSpotifyConfig().scope;
  } catch {
    return undefined;
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds.padStart(2, '0')}`;
}

/**
 * `@spotify/web-api-ts-sdk` throws plain `Error` for HTTP errors; the JSON body
 * is only in the message (e.g. `"status" : 403`). Use this instead of `error.status`.
 */
/** One-line text for tool handlers (shared by write and player). */
export function formatToolActionFailure(action: string, err: unknown): string {
  return `${action} failed: ${
    err instanceof Error ? err.message : String(err)
  }`;
}

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
  let config = loadSpotifyConfig();
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
